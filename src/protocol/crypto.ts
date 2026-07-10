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
