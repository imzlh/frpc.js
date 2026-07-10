// src/protocol/limit.ts - Client-side work connection bandwidth limiting

import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';
import type { MessageSocket } from './codec.ts';

function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenBucket {
    private tokens: number;
    private updatedAt: number;

    constructor(readonly bytesPerSecond: number, now = Date.now()) {
        if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
            throw new Error(`Invalid bandwidth limit: ${bytesPerSecond}`);
        }
        this.tokens = bytesPerSecond;
        this.updatedAt = now;
    }

    reserve(bytes: number, now = Date.now()): number {
        if (bytes <= 0) return 0;

        const current = Math.max(now, this.updatedAt);
        const elapsed = Math.max(0, current - this.updatedAt) / 1000;
        this.tokens = Math.min(this.bytesPerSecond, this.tokens + elapsed * this.bytesPerSecond);
        this.updatedAt = current;

        if (this.tokens >= bytes) {
            this.tokens -= bytes;
            return Math.max(0, this.updatedAt - now);
        }

        const needed = bytes - this.tokens;
        const waitMs = Math.ceil((needed / this.bytesPerSecond) * 1000);
        this.tokens = 0;
        this.updatedAt = current + waitMs;
        return Math.max(0, this.updatedAt - now);
    }
}

export class RateLimitedConn extends Duplex {
    private bucket: TokenBucket;
    private chain = Promise.resolve();
    private readChain = Promise.resolve();
    private limiterClosed = false;

    constructor(private socket: MessageSocket, bytesPerSecond: number) {
        super();
        this.bucket = new TokenBucket(bytesPerSecond);

        socket.on('data', (data) => {
            this.readChain = this.readChain
                .then(async () => {
                    await this.#pushLimited(Buffer.from(data));
                })
                .catch((err) => {
                    this.destroy(err instanceof Error ? err : new Error(String(err)));
                });
        });
        socket.on('end', () => {
            this.readChain = this.readChain.then(() => {
                this.push(null);
            });
        });
        socket.on('close', () => this.destroy());
        socket.on('error', (err) => this.destroy(err));
        socket.resume?.();
    }

    override _read(): void {}

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.#writeLimited(Buffer.from(chunk)).then(() => callback(), callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.chain.then(() => {
            if (this.socket.end) this.socket.end(() => callback());
            else callback();
        }).catch(callback);
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.limiterClosed = true;
        try { this.socket.destroy(error ?? undefined); } catch { /* ignore */ }
        callback(error);
    }

    async #take(bytes: number): Promise<void> {
        this.chain = this.chain.then(() => sleep(this.bucket.reserve(bytes)));
        return this.chain;
    }

    async #pushLimited(data: Buffer): Promise<void> {
        for (let offset = 0; offset < data.length; offset += this.bucket.bytesPerSecond) {
            const chunk = data.subarray(offset, Math.min(offset + this.bucket.bytesPerSecond, data.length));
            await this.#take(chunk.length);
            if (this.limiterClosed) return;
            this.push(chunk);
        }
    }

    async #writeLimited(data: Buffer): Promise<void> {
        for (let offset = 0; offset < data.length; offset += this.bucket.bytesPerSecond) {
            const chunk = data.subarray(offset, Math.min(offset + this.bucket.bytesPerSecond, data.length));
            await this.#take(chunk.length);
            if (this.limiterClosed) return;
            await new Promise<void>((resolve, reject) => {
                this.socket.write(chunk, (err?: Error | null) => err ? reject(err) : resolve());
            });
        }
    }
}

export function createRateLimitedConn(socket: MessageSocket, bytesPerSecond: number): RateLimitedConn {
    return new RateLimitedConn(socket, bytesPerSecond);
}
