// src/net/mux.ts - frp TCP multiplexing over Hashicorp yamux

import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';
import { yamux } from '@chainsafe/libp2p-yamux';
import { AbstractMessageStream } from '@libp2p/utils';
import type { Uint8ArrayList } from 'uint8arraylist';
import type { NetSocket } from '../types.ts';

type MuxStream = {
    send(data: Uint8Array): boolean;
    close(): Promise<void>;
    abort(error: Error): void;
    pause(): void;
    resume(): void;
    addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
};

type Muxer = {
    createStream(): Promise<MuxStream>;
    close(): Promise<void>;
    abort(error: Error): void;
};

type SilentLog = ((...args: unknown[]) => void) & {
    trace(...args: unknown[]): void;
    error(...args: unknown[]): void;
    newScope(name: string): SilentLog;
};

function silentLog(): SilentLog {
    const log = (() => {}) as SilentLog;
    log.trace = () => {};
    log.error = () => {};
    log.newScope = () => log;
    return log;
}

class SocketMessageStream extends AbstractMessageStream {
    private transportClosed = false;

    constructor(private socket: NetSocket) {
        super({ log: silentLog() as never, direction: 'outbound' });
        socket.on('data', (data: Buffer) => this.onData(data));
        socket.on('drain', () => this.safeDispatchEvent('drain'));
        socket.once('end', () => this.#onTransportClosed());
        socket.once('close', () => this.#onTransportClosed());
        socket.once('error', (error) => this.#onTransportClosed(error));
        socket.resume?.();
    }

    override sendData(data: Uint8ArrayList): { sentBytes: number; canSendMore: boolean } {
        const payload = data.subarray();
        return {
            sentBytes: payload.byteLength,
            canSendMore: this.socket.write(payload),
        };
    }

    override sendReset(error: Error): void {
        this.socket.destroy(error);
    }

    override sendPause(): void {
        this.socket.pause();
    }

    override sendResume(): void {
        this.socket.resume();
    }

    override async close(): Promise<void> {
        if (this.transportClosed) return;
        await new Promise<void>((resolve) => this.socket.end(resolve));
        this.#onTransportClosed();
    }

    #onTransportClosed(error?: Error): void {
        if (this.transportClosed) return;
        this.transportClosed = true;
        this.onTransportClosed(error);
    }
}

class MuxedSocket extends Duplex {
    private remoteEnded = false;

    constructor(private stream: MuxStream) {
        super();
        stream.addEventListener('message', (event) => {
            const data = (event as MessageEvent<Uint8Array | Uint8ArrayList>).data;
            this.push(Buffer.from(data instanceof Uint8Array ? data : data.subarray()));
        });
        stream.addEventListener('remoteCloseWrite', () => this.#endReadable(), { once: true });
        stream.addEventListener('close', () => this.#endReadable(), { once: true });
        stream.addEventListener('drain', () => this.emit('drain'));
    }

    override _read(): void {
        try { this.stream.resume(); } catch { /* already closed */ }
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            if (this.stream.send(chunk)) callback();
            else this.stream.addEventListener('drain', () => callback(), { once: true });
        } catch (error) {
            callback(error as Error);
        }
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.stream.close().then(() => callback(), (error) => callback(error as Error));
    }

    override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (error) {
            this.stream.abort(error);
            callback(error);
            return;
        }
        this.stream.close().then(() => callback(null), () => callback(null));
    }

    #endReadable(): void {
        if (this.remoteEnded) return;
        this.remoteEnded = true;
        this.push(null);
    }
}

/** A client-side yamux session carried by one frp TCP/TLS connection. */
export class FrpMuxSession {
    private readonly transport: SocketMessageStream;
    private readonly muxer: Muxer;
    private closed = false;

    constructor(socket: NetSocket) {
        this.transport = new SocketMessageStream(socket);
        this.muxer = yamux({ enableKeepAlive: true, keepAliveInterval: 30_000 })()
            .createStreamMuxer(this.transport) as unknown as Muxer;
    }

    async open(): Promise<NetSocket> {
        if (this.closed) throw new Error('frp mux session is closed');
        return new MuxedSocket(await this.muxer.createStream()) as unknown as NetSocket;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.muxer.abort(new Error('frp mux session closed'));
        void this.transport.close().catch(() => {});
    }
}
