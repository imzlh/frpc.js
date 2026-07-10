// src/protocol/codec.ts — V1/V2 message framing: readMsg / writeMsg

import { Buffer } from 'node:buffer';
import type { NetSocket } from '../types.ts';
import type { WireProtocol } from '../types.ts';
import { decodeV2Message, encodeV2Message, WireFrameBuffer } from './wire.ts';

export interface MessageSocket {
    write(data: Uint8Array | Buffer, cb?: (err?: Error | null) => void): unknown;
    end?(cb?: () => void): this;
    destroy(error?: Error): void;
    pause?(): this;
    resume?(): this;
    unshift?(data: Buffer): void;
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    off(event: 'data', listener: (data: Buffer) => void): this;
    off(event: 'end' | 'close', listener: () => void): this;
    off(event: 'error', listener: (err: Error) => void): this;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const V1_HEADER_LEN = 9;
const MAX_V1_MSG_LENGTH = 10_240;

export class MessageBuffer {
    private buf = Buffer.alloc(0);
    private readonly v2Frames?: WireFrameBuffer;

    constructor(private wireProtocol: WireProtocol = 'v1') {
        if (wireProtocol === 'v2') this.v2Frames = new WireFrameBuffer();
    }

    feed(data: Buffer): void {
        if (this.v2Frames) {
            this.v2Frames.feed(data);
            return;
        }
        this.buf = Buffer.concat([this.buf, data]);
    }

    tryReadMsg(): { type: number; msg: unknown } | null {
        if (this.v2Frames) {
            const frame = this.v2Frames.tryReadFrame();
            return frame ? decodeV2Message(frame) : null;
        }
        if (this.buf.length < V1_HEADER_LEN) return null;

        const type = this.buf[0]!;
        const length = readInt64BE(this.buf, 1);
        if (length < 0) throw new Error(`Invalid message length: ${length}`);
        if (length > MAX_V1_MSG_LENGTH) throw new Error(`Message length exceeds limit: ${length}`);
        if (this.buf.length < V1_HEADER_LEN + length) return null;

        const json = this.buf.subarray(V1_HEADER_LEN, V1_HEADER_LEN + length);
        this.buf = this.buf.subarray(V1_HEADER_LEN + length);
        return { type, msg: json.length === 0 ? {} : JSON.parse(dec.decode(json)) };
    }

    get length(): number { return this.v2Frames?.length ?? this.buf.length; }

    drain(): Buffer {
        if (this.v2Frames) return this.v2Frames.drain();
        const out = this.buf;
        this.buf = Buffer.alloc(0);
        return out;
    }
}

export class MessageReader {
    private mb = new MessageBuffer();
    private pending: Array<{ resolve: (v: { type: number; msg: unknown }) => void; reject: (e: Error) => void }> = [];
    private installed = false;

    constructor(private socket: MessageSocket, wireProtocol: WireProtocol = 'v1') {
        this.mb = new MessageBuffer(wireProtocol);
    }

    readMsg(): Promise<{ type: number; msg: unknown }> {
        return new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject });
            this.#pump();
        });
    }

    #pump(): void {
        while (this.pending.length > 0) {
            let frame: { type: number; msg: unknown } | null;
            try {
                frame = this.mb.tryReadMsg();
            } catch (e) {
                const p = this.pending.shift()!;
                p.reject(e as Error);
                continue;
            }
            if (frame === null) {
                break;
            }

            const p = this.pending.shift()!;
            p.resolve(frame);
        }

        if (this.pending.length > 0 && !this.installed) {
            this.#install();
        }
    }

    #install(): void {
        this.installed = true;
        const onData = (data: Buffer) => {
            this.mb.feed(data);
            this.#pump();
        };
        const rejectPending = (err: Error) => {
            this.#cleanup(false);
            while (this.pending.length > 0) {
                this.pending.shift()!.reject(err);
            }
        };
        const onEnd = () => rejectPending(new Error('Connection closed'));
        const onClose = () => rejectPending(new Error('Connection closed'));
        const onError = (err: Error) => {
            rejectPending(err);
        };
        this._cleanup = () => {
            this.socket.off('data', onData);
            this.socket.off('end', onEnd);
            this.socket.off('close', onClose);
            this.socket.off('error', onError);
            this.installed = false;
        };
        this.socket.on('data', onData);
        this.socket.on('end', onEnd);
        this.socket.on('close', onClose);
        this.socket.on('error', onError);
        this.socket.resume?.();
    }

    private _cleanup: (() => void) | null = null;

    #cleanup(preserveBuffered = true): void {
        if (this._cleanup) { this._cleanup(); this._cleanup = null; }
        if (preserveBuffered) {
            this.socket.pause?.();
            if (this.socket.unshift && this.mb.length > 0) {
                this.socket.unshift(this.mb.drain());
            }
        }
    }

    close(): void {
        this.#cleanup(true);
        while (this.pending.length > 0) {
            this.pending.shift()!.reject(new Error('Reader closed'));
        }
    }
}

export function readMsg(socket: MessageSocket, wireProtocol: WireProtocol = 'v1'): Promise<{ type: number; msg: unknown }> {
    const reader = new MessageReader(socket, wireProtocol);
    return reader.readMsg().finally(() => reader.close());
}

export function readMsgWithTail(socket: MessageSocket, wireProtocol: WireProtocol = 'v1'): Promise<{ type: number; msg: unknown; tail: Buffer }> {
    return new Promise((resolve, reject) => {
        const mb = new MessageBuffer(wireProtocol);
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('close', onClose);
            socket.off('error', onError);
        };
        const done = (frame: { type: number; msg: unknown }) => {
            cleanup();
            socket.pause?.();
            resolve({ ...frame, tail: mb.drain() });
        };
        const onData = (data: Buffer) => {
            try {
                mb.feed(data);
                const frame = mb.tryReadMsg();
                if (frame) done(frame);
            } catch (e) {
                cleanup();
                reject(e as Error);
            }
        };
        const onEnd = () => { cleanup(); reject(new Error('Connection closed')); };
        const onClose = () => { cleanup(); reject(new Error('Connection closed')); };
        const onError = (err: Error) => { cleanup(); reject(err); };

        socket.on('data', onData);
        socket.on('end', onEnd);
        socket.on('close', onClose);
        socket.on('error', onError);
        socket.resume?.();
    });
}

export function writeMsg(socket: MessageSocket, type: number, msg: unknown, wireProtocol: WireProtocol = 'v1'): Promise<void> {
    return new Promise((resolve, reject) => {
        if (wireProtocol === 'v2') {
            const frame = encodeV2Message(type, msg);
            socket.write(frame, (err) => err ? reject(err) : resolve());
            return;
        }
        const json = enc.encode(JSON.stringify(msg));
        const frame = Buffer.alloc(V1_HEADER_LEN + json.length);
        frame[0] = type;
        writeInt64BE(frame, json.length, 1);
        frame.set(json, V1_HEADER_LEN);
        socket.write(frame, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function readInt64BE(buf: Buffer, offset: number): number {
    const high = buf.readInt32BE(offset);
    const low = buf.readUInt32BE(offset + 4);
    return high * 0x1_0000_0000 + low;
}

function writeInt64BE(buf: Buffer, value: number, offset: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid message length: ${value}`);
    }
    buf.writeInt32BE(Math.floor(value / 0x1_0000_0000), offset);
    buf.writeUInt32BE(value >>> 0, offset + 4);
}

export function pipeConn(a: NetSocket, b: NetSocket): Promise<void> {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (destroy = false) => {
            if (resolved) return;
            resolved = true;
            if (destroy) {
                try { a.destroy(); } catch { /* ignore */ }
                try { b.destroy(); } catch { /* ignore */ }
            }
            resolve();
        };
        const finishAfterEnd = (socket: NetSocket) => {
            try {
                socket.end(() => finish());
            } catch {
                finish();
            }
        };

        a.pipe(b);
        b.pipe(a);

        a.on('close', () => {
            finishAfterEnd(b);
        });
        b.on('close', () => {
            finishAfterEnd(a);
        });
        a.on('error', () => finish(true));
        b.on('error', () => finish(true));
    });
}
