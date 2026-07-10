// src/visitor/stcp.ts — STCP visitor runtime

import { createServer, type Server, type Socket } from 'node:net';
import { MsgType, MessageReader, createCompressedConn, createEncryptedConn, genPrivKey, pipeConn, writeMsg } from '../protocol/index.ts';
import { connectTo } from '../net/index.ts';
import { targetServerProxyName, type NetSocket, type STCPVisitor, type VisitorCommonOptions } from '../types.ts';
import type { NewVisitorConnRespMsg } from '../protocol/index.ts';

export interface VisitorRuntimeConfig {
    serverAddr: { hostname: string; port: number };
    useTls: boolean;
    tlsOpts?: { ca?: string; servername?: string; rejectUnauthorized?: boolean };
    runId: string;
    user?: string;
}

export class STCPVisitorRuntime {
    private server: Server | undefined;
    private sockets = new Set<Socket>();
    private stopped = false;

    constructor(
        private name: string,
        private visitor: STCPVisitor,
        private cfg: VisitorRuntimeConfig,
    ) {}

    start(): Promise<void> {
        const opts = this.visitor.opts;
        if (opts.bindPort <= 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const server = createServer((socket) => this.#handleUserConn(socket));
            this.server = server;
            server.once('error', reject);
            server.listen(opts.bindPort, opts.bindAddr ?? '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
    }

    stop(): void {
        this.stopped = true;
        for (const socket of this.sockets) {
            try { socket.destroy(); } catch { /* ignore */ }
        }
        this.sockets.clear();
        try { this.server?.close(); } catch { /* ignore */ }
        this.server = undefined;
    }

    #handleUserConn(userConn: Socket): void {
        this.sockets.add(userConn);
        this.#proxyUserConn(userConn)
            .catch((err: Error) => {
                if (!this.stopped) console.error(`[visitor:${this.name}]`, err.message);
                try { userConn.destroy(err); } catch { /* ignore */ }
            })
            .finally(() => this.sockets.delete(userConn));
    }

    async #proxyUserConn(userConn: Socket): Promise<void> {
        const visitorConn = await this.#dialVisitorConn(this.visitor.opts);
        try {
            await pipeConn(userConn as NetSocket, visitorConn as NetSocket);
        } finally {
            try { visitorConn.destroy(); } catch { /* ignore */ }
            try { userConn.destroy(); } catch { /* ignore */ }
        }
    }

    async #dialVisitorConn(opts: VisitorCommonOptions): Promise<NetSocket> {
        const raw = await connectTo(this.cfg.serverAddr, this.cfg.useTls, this.cfg.tlsOpts);
        try {
            const timestamp = Math.floor(Date.now() / 1000);
            await writeMsg(raw, MsgType.NewVisitorConn, {
                run_id: this.cfg.runId,
                proxy_name: targetServerProxyName(this.cfg.user, opts.serverUser, opts.serverName),
                sign_key: await genPrivKey(opts.secretKey, timestamp),
                timestamp,
                use_encryption: opts.transport?.useEncryption ?? false,
                use_compression: opts.transport?.useCompression ?? false,
            });

            const reader = new MessageReader(raw);
            const { type, msg } = await reader.readMsg().finally(() => reader.close());
            if (type !== MsgType.NewVisitorConnResp) {
                throw new Error(`Expected NewVisitorConnResp, got 0x${type.toString(16)}`);
            }
            const resp = msg as NewVisitorConnRespMsg;
            if (resp.error) {
                throw new Error(`NewVisitorConn rejected: ${resp.error}`);
            }
        } catch (err) {
            try { raw.destroy(err as Error); } catch { /* ignore */ }
            throw err;
        }

        let conn = raw as NetSocket;
        if (opts.transport?.useEncryption) {
            conn = await createEncryptedConn(conn, opts.secretKey) as unknown as NetSocket;
        }
        if (opts.transport?.useCompression) {
            conn = createCompressedConn(conn) as unknown as NetSocket;
        }
        return conn;
    }
}
