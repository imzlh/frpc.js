// src/protocol/compression.ts — Snappy framed stream for frp work connections

import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';
import type { MessageSocket } from './codec.ts';

const MAGIC = Buffer.from([0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59]);
const MAX_BLOCK = 64 * 1024;
const MAX_FRAME_PAYLOAD = MAX_BLOCK + 4;
const crcTable = makeCrc32cTable();
type AnyBuffer = Buffer<ArrayBufferLike>;

export function createCompressedConn(socket: MessageSocket, initialData?: Uint8Array): CompressedConn {
    return new CompressedConn(socket, initialData);
}

export class CompressedConn extends Duplex {
    private decoder = new SnappyFrameDecoder();
    private wroteHeader = false;

    constructor(private socket: MessageSocket, initialData?: Uint8Array) {
        super();
        socket.on('data', (data) => this.#handleData(data));
        socket.on('end', () => this.push(null));
        socket.on('close', () => this.destroy());
        socket.on('error', (err) => this.destroy(err));
        socket.resume?.();

        if (initialData && initialData.length > 0) {
            this.#handleData(Buffer.from(initialData));
        }
    }

    override _read(): void {}

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const frames = encodeSnappyFrames(Buffer.from(chunk), !this.wroteHeader);
        this.wroteHeader = true;
        this.socket.write(frames, callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (this.socket.end) {
            this.socket.end(() => callback());
        } else {
            callback();
        }
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        try { this.socket.destroy(error ?? undefined); } catch { /* ignore */ }
        callback(error);
    }

    #handleData(data: Buffer): void {
        try {
            for (const chunk of this.decoder.feed(data)) {
                if (chunk.length > 0) this.push(chunk);
            }
        } catch (err) {
            this.destroy(err as Error);
        }
    }
}

class SnappyFrameDecoder {
    private buf: AnyBuffer = Buffer.alloc(0);
    private sawHeader = false;

    feed(data: Buffer): AnyBuffer[] {
        this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
        const out: AnyBuffer[] = [];

        while (this.buf.length >= 4) {
            const chunkType = this.buf[0]!;
            if (!this.sawHeader && chunkType !== 0xff) {
                throw new Error('snappy stream header missing');
            }

            const len = this.buf[1]! | (this.buf[2]! << 8) | (this.buf[3]! << 16);
            if (len > MAX_FRAME_PAYLOAD) throw new Error(`snappy chunk too large: ${len}`);
            if (this.buf.length < 4 + len) break;

            const payload = this.buf.subarray(4, 4 + len);
            this.buf = this.buf.subarray(4 + len);

            if (chunkType === 0xff) {
                if (!payload.equals(MAGIC.subarray(4))) throw new Error('invalid snappy stream header');
                this.sawHeader = true;
                continue;
            }

            if (chunkType === 0x00 || chunkType === 0x01) {
                if (len < 4) throw new Error('invalid snappy data chunk');
                const checksum = payload.readUInt32LE(0);
                const body = payload.subarray(4);
                const decoded = chunkType === 0x00 ? decodeRawSnappy(body) : Buffer.from(body);
                if (maskedCrc32c(decoded) !== checksum) throw new Error('snappy checksum mismatch');
                out.push(decoded);
                continue;
            }

            if (chunkType <= 0x7f) throw new Error(`unsupported snappy chunk: ${chunkType}`);
            // Skippable chunks.
        }

        return out;
    }
}

function encodeSnappyFrames(input: Buffer, includeHeader: boolean): Buffer {
    const parts: AnyBuffer[] = [];
    if (includeHeader) parts.push(MAGIC);
    for (let offset = 0; offset < input.length || (input.length === 0 && offset === 0); offset += MAX_BLOCK) {
        const chunk = input.subarray(offset, Math.min(offset + MAX_BLOCK, input.length));
        if (chunk.length === 0 && input.length !== 0) break;
        const frame = Buffer.alloc(8);
        frame[0] = 0x01;
        const len = chunk.length + 4;
        frame[1] = len & 0xff;
        frame[2] = (len >>> 8) & 0xff;
        frame[3] = (len >>> 16) & 0xff;
        frame.writeUInt32LE(maskedCrc32c(chunk), 4);
        parts.push(frame, chunk);
        if (input.length === 0) break;
    }
    return Buffer.concat(parts);
}

function decodeRawSnappy(input: Buffer): Buffer {
    let pos = 0;
    let len = 0;
    let shift = 0;
    for (;;) {
        if (pos >= input.length || shift > 28) throw new Error('invalid snappy length');
        const b = input[pos++]!;
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }

    const out = Buffer.alloc(len);
    let dst = 0;
    while (pos < input.length) {
        const tag = input[pos++]!;
        const kind = tag & 0x03;

        if (kind === 0) {
            let literalLen = tag >>> 2;
            if (literalLen < 60) {
                literalLen++;
            } else {
                const bytes = literalLen - 59;
                if (bytes < 1 || bytes > 4 || pos + bytes > input.length) {
                    throw new Error('invalid snappy literal length');
                }
                literalLen = 1;
                let extra = 0;
                for (let i = 0; i < bytes; i++) extra |= input[pos++]! << (8 * i);
                literalLen += extra;
            }
            if (pos + literalLen > input.length || dst + literalLen > out.length) {
                throw new Error('snappy literal overrun');
            }
            input.copy(out, dst, pos, pos + literalLen);
            pos += literalLen;
            dst += literalLen;
            continue;
        }

        let copyLen: number;
        let offset: number;
        if (kind === 1) {
            if (pos >= input.length) throw new Error('invalid snappy copy1');
            copyLen = 4 + ((tag >>> 2) & 0x07);
            offset = ((tag & 0xe0) << 3) | input[pos++]!;
        } else if (kind === 2) {
            if (pos + 2 > input.length) throw new Error('invalid snappy copy2');
            copyLen = 1 + (tag >>> 2);
            offset = input[pos]! | (input[pos + 1]! << 8);
            pos += 2;
        } else {
            if (pos + 4 > input.length) throw new Error('invalid snappy copy4');
            copyLen = 1 + (tag >>> 2);
            offset = input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16) | (input[pos + 3]! << 24);
            pos += 4;
        }

        if (offset <= 0 || offset > dst || dst + copyLen > out.length) {
            throw new Error('invalid snappy copy offset');
        }
        for (let i = 0; i < copyLen; i++) {
            out[dst] = out[dst - offset]!;
            dst++;
        }
    }

    if (dst !== out.length) throw new Error('snappy length mismatch');
    return out;
}

function maskedCrc32c(data: Buffer): number {
    const crc = crc32c(data);
    return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

function crc32c(data: Buffer): number {
    let crc = 0xffffffff;
    for (const b of data) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff]!;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32cTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? (0x82f63b78 ^ (crc >>> 1)) : (crc >>> 1);
        }
        table[i] = crc >>> 0;
    }
    return table;
}
