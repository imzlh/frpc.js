// src/protocol/crypto.ts — frp v1 control-channel crypto

import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import type { MessageSocket } from './codec.ts';

const BLOCK_SIZE = 16;
const zeroIv = new Uint8Array(BLOCK_SIZE);
const textEncoder = new TextEncoder();

export async function createCryptoConn(socket: MessageSocket, token: string): Promise<CryptoConn> {
    const key = await deriveFrpCryptoKey(token);
    return new CryptoConn(socket, key);
}

/** V2 control-channel AEAD stream. The framing matches golib/crypto.AEADStream*. */
export async function createAeadCryptoConn(
    socket: MessageSocket,
    token: string,
    transcriptHash: Uint8Array,
    role: 'client' | 'server' = 'client',
): Promise<AeadCryptoConn> {
    const [readKey, writeKey] = await Promise.all([
        deriveV2ControlKey(token, transcriptHash, role === 'client' ? 'server-to-client' : 'client-to-server'),
        deriveV2ControlKey(token, transcriptHash, role === 'client' ? 'client-to-server' : 'server-to-client'),
    ]);
    return new AeadCryptoConn(socket, readKey, writeKey);
}

export async function createEncryptedConn(
    socket: MessageSocket,
    token: string,
    initialData?: Uint8Array,
): Promise<EncryptedConn> {
    const key = await deriveFrpCryptoKey(token);
    return new EncryptedConn(socket, key, initialData);
}

export async function deriveFrpCryptoKey(token: string): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        'raw',
        textEncoder.encode(token),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: textEncoder.encode('frp'),
            iterations: 64,
            hash: 'SHA-1',
        },
        material,
        { name: 'AES-CBC', length: 128 },
        false,
        ['encrypt'],
    );
}

async function deriveV2ControlKey(
    token: string,
    transcriptHash: Uint8Array,
    direction: 'client-to-server' | 'server-to-client',
): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        'raw', textEncoder.encode(token), 'HKDF', false, ['deriveBits'],
    );
    const info = textEncoder.encode(`frp wire v2 control aead aes-256-gcm ${direction}`);
    const bits = await crypto.subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: cryptoBytes(transcriptHash),
        info,
    }, material, 256);
    return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export class AeadCryptoConn extends EventEmitter implements MessageSocket {
    private readBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    private readStreamNonce: Uint8Array<ArrayBuffer> | undefined;
    private readNonce: Uint8Array<ArrayBuffer> | undefined;
    private writeStreamNonce: Uint8Array<ArrayBuffer> | undefined;
    private writeNonce: Uint8Array<ArrayBuffer> | undefined;
    private writeHeaderSent = false;
    private writeChain = Promise.resolve();
    private readChain = Promise.resolve();

    constructor(
        private socket: MessageSocket,
        private readKey: CryptoKey,
        private writeKey: CryptoKey,
    ) {
        super();
        socket.on('data', (data) => this.#queueData(data));
        socket.on('end', () => this.emit('end'));
        socket.on('close', () => this.emit('close'));
        socket.on('error', (err) => this.emit('error', err));
        socket.resume?.();
    }

    write(data: Uint8Array | Buffer, cb?: (err?: Error | null) => void): boolean {
        const bytes = Buffer.from(data);
        this.writeChain = this.writeChain.then(() => this.#write(bytes));
        this.writeChain.then(() => cb?.()).catch((err) => cb?.(err as Error));
        return true;
    }

    destroy(error?: Error): void {
        this.socket.destroy(error);
    }

    #queueData(data: Buffer): void {
        this.readChain = this.readChain.then(() => this.#handleData(data)).catch((err) => {
            this.emit('error', err);
            this.destroy(err as Error);
        });
    }

    async #write(data: Buffer): Promise<void> {
        for (let offset = 0; offset < data.length; offset += 64 * 1024) {
            await this.#writeFrame(data.subarray(offset, offset + 64 * 1024));
        }
    }

    async #writeFrame(plain: Buffer): Promise<void> {
        if (!this.writeNonce) {
            this.writeNonce = new Uint8Array(12);
            crypto.getRandomValues(this.writeNonce);
            this.writeStreamNonce = cryptoBytes(this.writeNonce);
        }
        const header = Buffer.alloc(4);
        header.writeUInt32BE(plain.length + 16, 0);
        const aad = concatCryptoBytes(this.writeStreamNonce!, header);
        const encrypted = Buffer.from(await crypto.subtle.encrypt({
            name: 'AES-GCM',
            iv: this.writeNonce,
            additionalData: aad,
            tagLength: 128,
        }, this.writeKey, cryptoBytes(plain)));
        const firstFrame = !this.writeHeaderSent;
        const prefix = firstFrame ? Buffer.from(this.writeStreamNonce!) : Buffer.alloc(0);
        incrementNonce(this.writeNonce);
        this.writeHeaderSent = true;
        await writeToSocket(this.socket, firstFrame ? Buffer.concat([prefix, header, encrypted]) : Buffer.concat([header, encrypted]));
    }

    async #handleData(data: Buffer): Promise<void> {
        this.readBuffer = this.readBuffer.length === 0 ? data : Buffer.concat([this.readBuffer, data]);
        for (;;) {
            if (!this.readNonce) {
                if (this.readBuffer.length < 12) return;
                this.readNonce = cryptoBytes(this.readBuffer.subarray(0, 12));
                this.readStreamNonce = cryptoBytes(this.readNonce);
                this.readBuffer = this.readBuffer.subarray(12);
            }
            if (this.readBuffer.length < 4) return;
            const length = this.readBuffer.readUInt32BE(0);
            if (length < 16 || length > 64 * 1024 + 16) {
                throw new Error(`Invalid V2 AEAD ciphertext length: ${length}`);
            }
            if (this.readBuffer.length < 4 + length) return;
            const header = this.readBuffer.subarray(0, 4);
            const ciphertext = this.readBuffer.subarray(4, 4 + length);
            this.readBuffer = this.readBuffer.subarray(4 + length);
            const aad = concatCryptoBytes(this.readStreamNonce!, header);
            const plain = Buffer.from(await crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: this.readNonce,
                additionalData: aad,
                tagLength: 128,
            }, this.readKey, cryptoBytes(ciphertext)));
            incrementNonce(this.readNonce);
            if (plain.length > 0) this.emit('data', plain);
        }
    }
}

function incrementNonce(nonce: Uint8Array): void {
    for (let i = nonce.length - 1; i >= 0; i--) {
        nonce[i] = (nonce[i]! + 1) & 0xff;
        if (nonce[i] !== 0) return;
    }
    throw new Error('V2 AEAD nonce exhausted');
}

function cryptoBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(data.length);
    out.set(data);
    return out;
}

function concatCryptoBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function writeToSocket(socket: MessageSocket, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(data, (err) => err ? reject(err) : resolve());
    });
}

export class CryptoConn extends EventEmitter implements MessageSocket {
    private decryptor: CfbStream | null = null;
    private encryptor: CfbStream;
    private readIv = Buffer.alloc(0);
    private writeStarted = false;
    private readChain = Promise.resolve();
    private writeChain = Promise.resolve();

    constructor(private socket: MessageSocket, key: CryptoKey) {
        super();
        const writeIv = new Uint8Array(BLOCK_SIZE);
        crypto.getRandomValues(writeIv);
        this.encryptor = new CfbStream(key, writeIv, 'encrypt');

        socket.on('data', (data) => {
            this.readChain = this.readChain.then(() => this.#handleData(data)).catch((err) => {
                this.emit('error', err);
                this.destroy(err);
            });
        });
        socket.on('end', () => this.emit('end'));
        socket.on('close', () => this.emit('close'));
        socket.on('error', (err) => this.emit('error', err));
        socket.resume?.();
    }

    write(data: Uint8Array | Buffer, cb?: (err?: Error | null) => void): boolean {
        const buf = Buffer.from(data);
        this.writeChain = this.writeChain.then(async () => {
            const encrypted = Buffer.from(await this.encryptor.process(buf));
            const out = this.writeStarted
                ? encrypted
                : Buffer.concat([Buffer.from(this.encryptor.iv), encrypted]);
            this.writeStarted = true;
            await new Promise<void>((resolve, reject) => {
                this.socket.write(out, (err?: Error | null) => err ? reject(err) : resolve());
            });
        });
        this.writeChain.then(() => cb?.()).catch((err) => cb?.(err));
        return true;
    }

    destroy(error?: Error): void {
        this.socket.destroy(error);
    }

    async #handleData(data: Buffer): Promise<void> {
        let chunk = data;
        if (!this.decryptor) {
            const need = BLOCK_SIZE - this.readIv.length;
            this.readIv = Buffer.concat([this.readIv, chunk.subarray(0, need)]);
            chunk = chunk.subarray(need);
            if (this.readIv.length < BLOCK_SIZE) return;
            this.decryptor = new CfbStream(this.encryptor.key, this.readIv, 'decrypt');
        }
        if (chunk.length === 0) return;
        const plain = Buffer.from(await this.decryptor.process(chunk));
        if (plain.length > 0) this.emit('data', plain);
    }
}

export class EncryptedConn extends Duplex {
    private decryptor: CfbStream | null = null;
    private encryptor: CfbStream;
    private readIv = Buffer.alloc(0);
    private writeStarted = false;
    private readChain = Promise.resolve();
    private writeChain = Promise.resolve();

    constructor(private socket: MessageSocket, key: CryptoKey, initialData?: Uint8Array) {
        super();
        const writeIv = new Uint8Array(BLOCK_SIZE);
        crypto.getRandomValues(writeIv);
        this.encryptor = new CfbStream(key, writeIv, 'encrypt');

        socket.on('data', (data) => this.#queueData(data));
        socket.on('end', () => this.push(null));
        socket.on('close', () => this.destroy());
        socket.on('error', (err) => this.destroy(err));
        socket.resume?.();

        if (initialData && initialData.length > 0) {
            this.#queueData(Buffer.from(initialData));
        }
    }

    override _read(): void {}

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const buf = Buffer.from(chunk);
        this.writeChain = this.writeChain.then(async () => {
            const encrypted = Buffer.from(await this.encryptor.process(buf));
            const out = this.writeStarted
                ? encrypted
                : Buffer.concat([Buffer.from(this.encryptor.iv), encrypted]);
            this.writeStarted = true;
            await new Promise<void>((resolve, reject) => {
                this.socket.write(out, (err?: Error | null) => err ? reject(err) : resolve());
            });
        });
        this.writeChain.then(() => callback()).catch((err) => callback(err));
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.writeChain.then(() => {
            if (this.socket.end) {
                this.socket.end(() => callback());
            } else {
                callback();
            }
        }).catch((err) => callback(err));
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        try { this.socket.destroy(error ?? undefined); } catch { /* ignore */ }
        callback(error);
    }

    #queueData(data: Buffer): void {
        this.readChain = this.readChain.then(() => this.#handleData(data)).catch((err) => {
            this.destroy(err);
        });
    }

    async #handleData(data: Buffer): Promise<void> {
        let chunk = data;
        if (!this.decryptor) {
            const need = BLOCK_SIZE - this.readIv.length;
            this.readIv = Buffer.concat([this.readIv, chunk.subarray(0, need)]);
            chunk = chunk.subarray(need);
            if (this.readIv.length < BLOCK_SIZE) return;
            this.decryptor = new CfbStream(this.encryptor.key, this.readIv, 'decrypt');
        }
        if (chunk.length === 0) return;
        const plain = Buffer.from(await this.decryptor.process(chunk));
        if (plain.length > 0) this.push(plain);
    }
}

export class CfbStream {
    private register: Uint8Array<ArrayBuffer>;
    private stream: Uint8Array<ArrayBuffer> = new Uint8Array(BLOCK_SIZE);
    private used = BLOCK_SIZE;

    constructor(readonly key: CryptoKey, readonly iv: Uint8Array, private mode: 'encrypt' | 'decrypt') {
        this.register = new Uint8Array(BLOCK_SIZE);
        this.register.set(iv);
    }

    async process(input: Uint8Array): Promise<Uint8Array> {
        const out = new Uint8Array(input.length);
        for (let i = 0; i < input.length; i++) {
            if (this.used === BLOCK_SIZE) {
                this.stream = await aesBlock(this.key, this.register);
                this.used = 0;
            }
            const b = input[i]!;
            const v = b ^ this.stream[this.used]!;
            out[i] = v;
            this.register[this.used] = this.mode === 'encrypt' ? v : b;
            this.used++;
        }
        return out;
    }
}

async function aesBlock(key: CryptoKey, block: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const input = new Uint8Array(BLOCK_SIZE);
    input.set(block.subarray(0, BLOCK_SIZE));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, key, input);
    const out = new Uint8Array(BLOCK_SIZE);
    out.set(new Uint8Array(encrypted).subarray(0, BLOCK_SIZE));
    return out;
}
