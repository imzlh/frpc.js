// src/visitor/stcp.ts — STCP visitor runtime

import { createServer, type Server, type Socket } from 'node:net';
import { createCompressedConn, createEncryptedConn, genPrivKey, MessageReader, MsgType, pipeConn, writeMsg, writeV2Magic } from '../protocol/index.ts';
import { connectTo } from '../net/index.ts';
import { type NetSocket, type STCPVisitor, targetServerProxyName, type VisitorCommonOptions, type WireProtocol } from '../types.ts';
import type { NewVisitorConnRespMsg } from '../protocol/index.ts';
import { defaultLogger, formatError, type Logger } from '../log.ts';

export interface VisitorRuntimeConfig {
    openConnection?: () => Promise<NetSocket>;
    serverAddr: { hostname: string; port: number };
    useTls: boolean;
    tlsOpts?: {
        ca?: string;
        servername?: string;
        rejectUnauthorized?: boolean;
        customFirstByte?: boolean;
    };
    runId: string;
    user?: string;
    wireProtocol?: WireProtocol;
    logger?: Logger;
    keepaliveSeconds?: number;
}

export class STCPVisitorRuntime {
    private server: Server | undefined;
    private sockets = new Set<Socket>();
    private visitorSockets = new Set<NetSocket>();
    private stopped = false;
    private log: Logger;

    constructor(
        private name: string,
        private visitor: STCPVisitor,
        private cfg: VisitorRuntimeConfig,
    ) {
        this.log = cfg.logger ?? defaultLogger;
    }

    start(): Promise<void> {
        const opts = this.visitor.opts;
        if (opts.bindPort <= 0 || this.stopped) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const server = createServer((socket) => {
                if (this.stopped) {
                    socket.destroy();
                    return;
                }
                this.#handleUserConn(socket);
            });
            this.server = server;
            const onError = (error: Error) => {
                if (this.server === server) this.server = undefined;
                try {
                    server.close();
                } catch { /* not listening */ }
                reject(error);
            };
            server.once('error', onError);
            server.listen(opts.bindPort, opts.bindAddr ?? '127.0.0.1', () => {
                server.off('error', onError);
                if (this.stopped) {
                    server.close();
                    if (this.server === server) this.server = undefined;
                }
                resolve();
            });
        });
    }

    stop(): void {
        this.stopped = true;
        for (const socket of this.sockets) {
            try {
                socket.destroy();
            } catch { /* ignore */ }
        }
        this.sockets.clear();
        for (const socket of this.visitorSockets) {
            try {
                socket.destroy();
            } catch { /* ignore */ }
        }
        this.visitorSockets.clear();
        try {
            this.server?.close();
        } catch { /* ignore */ }
        this.server = undefined;
    }

    #handleUserConn(userConn: Socket): void {
        this.sockets.add(userConn);
        const source = `${userConn.remoteAddress ?? 'unknown'}:${userConn.remotePort ?? 0}`;
        this.log.debug(`Accepted local connection from ${source}`);
        this.#proxyUserConn(userConn)
            .catch((err: Error) => {
                if (!this.stopped) {
                    this.log.warn(
                        `Connection failed from ${source}: ${formatError(err)}`,
                    );
                }
                try {
                    userConn.destroy(err);
                } catch { /* ignore */ }
            })
            .finally(() => {
                this.sockets.delete(userConn);
                this.log.debug(`Local connection closed from ${source}`);
            });
    }

    async #proxyUserConn(userConn: Socket): Promise<void> {
        const { conn: visitorConn, raw } = await this.#dialVisitorConn(
            this.visitor.opts,
        );
        if (this.stopped || userConn.destroyed) {
            try {
                visitorConn.destroy();
            } catch { /* ignore */ }
            this.visitorSockets.delete(raw);
            return;
        }
        try {
            await pipeConn(userConn as NetSocket, visitorConn as NetSocket);
        } finally {
            this.visitorSockets.delete(raw);
            try {
                visitorConn.destroy();
            } catch { /* ignore */ }
            try {
                userConn.destroy();
            } catch { /* ignore */ }
        }
    }

    async #dialVisitorConn(
        opts: VisitorCommonOptions,
    ): Promise<{ conn: NetSocket; raw: NetSocket }> {
        const raw = await (this.cfg.openConnection ? this.cfg.openConnection() : connectTo(this.cfg.serverAddr, this.cfg.useTls, this.cfg.tlsOpts, this.cfg.keepaliveSeconds));
        this.visitorSockets.add(raw);
        try {
            if (this.stopped) throw new Error('visitor stopped');
            const wireProtocol = this.cfg.wireProtocol ?? 'v1';
            if (wireProtocol === 'v2') await writeV2Magic(raw);
            const timestamp = Math.floor(Date.now() / 1000);
            await writeMsg(raw, MsgType.NewVisitorConn, {
                run_id: this.cfg.runId,
                proxy_name: targetServerProxyName(
                    this.cfg.user,
                    opts.serverUser,
                    opts.serverName,
                ),
                sign_key: await genPrivKey(opts.secretKey, timestamp),
                timestamp,
                use_encryption: opts.transport?.useEncryption ?? false,
                use_compression: opts.transport?.useCompression ?? false,
            }, wireProtocol);

            const reader = new MessageReader(raw, wireProtocol);
            const { type, msg } = await reader.readMsg().finally(() => reader.close());
            if (type !== MsgType.NewVisitorConnResp) {
                throw new Error(
                    `Expected NewVisitorConnResp, got 0x${type.toString(16)}`,
                );
            }
            const resp = msg as NewVisitorConnRespMsg;
            if (resp.error) {
                throw new Error(`NewVisitorConn rejected: ${resp.error}`);
            }
        } catch (err) {
            this.visitorSockets.delete(raw);
            try {
                raw.destroy(err as Error);
            } catch { /* ignore */ }
            throw err;
        }

        let conn = raw as NetSocket;
        if (opts.transport?.useEncryption) {
            conn = await createEncryptedConn(
                conn,
                opts.secretKey,
            ) as unknown as NetSocket;
        }
        if (opts.transport?.useCompression) {
            conn = createCompressedConn(conn) as unknown as NetSocket;
        }
        return { conn, raw };
    }
}
