// src/control/pool.ts — Work connection pool

import { createCompressedConn, createEncryptedConn, createRateLimitedConn, MsgType, readMsgWithTail, writeMsg, writeV2Magic } from '../protocol/index.ts';
import { connectTo } from '../net/index.ts';
import { bandwidthLimitBytes, type Hooks, HTTP, type NetAddr, type NetSocket, type NormalizedProxyOptions, type ProxyBase, type ProxyCommonOptions, proxyOptions, RawHTTP, STCP, TCP, TCPMux, UDP, type WireProtocol } from '../types.ts';
import { handleHttp, handleRawHttp, handleTcp, handleUdp } from '../handler/index.ts';
import type { ClientAuth } from '../auth.ts';
import type { StartWorkConnMsg } from '../protocol/index.ts';
import { defaultLogger, formatError, type Logger } from '../log.ts';

export interface PoolConfig {
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
    auth: ClientAuth;
    proxies: Map<string, ProxyBase>;
    max: number;
    wireProtocol?: WireProtocol;
    hooks?: Hooks;
    logger?: Logger;
}

export interface WorkConnPoolStats {
    active: number;
    opening: number;
    limit: number;
    requested: number;
    accepted: number;
    rejected: number;
    failed: number;
    completed: number;
    limited: number;
    lastActivity?: string;
}

export class WorkConnPool {
    private total = 0;
    private active = 0;
    private live = true;
    private conns = new Set<NetSocket>();
    private log: Logger;
    private requested = 0;
    private accepted = 0;
    private rejected = 0;
    private failed = 0;
    private completed = 0;
    private limited = 0;
    private lastActivity = '';

    constructor(private cfg: PoolConfig) {
        this.log = cfg.logger ?? defaultLogger;
    }

    expand(): void {
        this.requested++;
        this.#touch();
        this.#spawn();
    }

    stats(): WorkConnPoolStats {
        return {
            active: this.active,
            opening: Math.max(0, this.total - this.active),
            limit: this.cfg.max,
            requested: this.requested,
            accepted: this.accepted,
            rejected: this.rejected,
            failed: this.failed,
            completed: this.completed,
            limited: this.limited,
            lastActivity: this.lastActivity || undefined,
        };
    }

    stop(): void {
        this.live = false;
        for (const conn of this.conns) {
            try {
                conn.destroy();
            } catch { /* ignore */ }
        }
        this.conns.clear();
    }

    removeProxy(name: string): void {
        this.cfg.proxies.delete(name);
    }

    addProxy(name: string, proxy: ProxyBase): void {
        this.cfg.proxies.set(name, proxy);
    }

    #spawn(): void {
        if (!this.live) return;
        if (this.total >= this.cfg.max) {
            this.limited++;
            this.#touch();
            this.log.debug(
                `Work connection request ignored: pool limit reached (${this.total}/${this.cfg.max})`,
            );
            return;
        }
        this.total++;
        this.log.debug(`Opening work connection (${this.total}/${this.cfg.max})`);
        this.#worker().catch((e: Error) => {
            if (this.live) {
                this.failed++;
                this.#touch();
                this.log.warn(`Work connection failed: ${formatError(e)}`);
            }
        }).finally(() => {
            this.total--;
        });
    }

    async #connect(): Promise<NetSocket> {
        const conn = await (this.cfg.openConnection ? this.cfg.openConnection() : connectTo(this.cfg.serverAddr, this.cfg.useTls, this.cfg.tlsOpts));
        try {
            if ((this.cfg.wireProtocol ?? 'v1') === 'v2') await writeV2Magic(conn);
            return conn;
        } catch (error) {
            try {
                conn.destroy();
            } catch { /* ignore */ }
            throw error;
        }
    }

    async #worker(): Promise<void> {
        const conn = await this.#connect();
        if (!this.live) {
            try {
                conn.destroy();
            } catch { /* ignore */ }
            return;
        }
        const wireProtocol = this.cfg.wireProtocol ?? 'v1';
        this.conns.add(conn);
        let assigned = false;
        try {
            await writeMsg(
                conn,
                MsgType.NewWorkConn,
                await this.cfg.auth.newWorkConn(this.cfg.runId),
                wireProtocol,
            );

            let swc: StartWorkConnMsg;
            let initialData = new Uint8Array();
            try {
                const { type, msg, tail } = await readMsgWithTail(conn, wireProtocol);
                if (type !== MsgType.StartWorkConn) {
                    this.failed++;
                    this.#touch();
                    this.log.warn(
                        `Expected StartWorkConn, got message type 0x${type.toString(16)}`,
                    );
                    return;
                }
                swc = msg as StartWorkConnMsg;
                initialData = new Uint8Array(tail);
            } catch (error) {
                if (this.live) {
                    this.failed++;
                    this.#touch();
                    this.log.debug(
                        `Work connection closed before StartWorkConn: ${formatError(error)}`,
                    );
                }
                return;
            }

            if (swc.error) {
                this.rejected++;
                this.#touch();
                this.log.error(
                    `Work connection rejected by server: ${swc.error}`,
                );
                return;
            }

            assigned = true;
            this.active++;
            this.accepted++;
            this.#touch();
            this.log.debug(
                `Work connection assigned: proxy="${swc.proxy_name}", source=${swc.src_addr}:${swc.src_port}`,
            );
            await this.#dispatch(conn, swc, initialData);
        } finally {
            if (assigned) {
                this.active--;
                this.completed++;
                this.#touch();
            }
            this.conns.delete(conn);
            try {
                conn.destroy();
            } catch { /* ignore */ }
        }
    }

    #touch(): void {
        this.lastActivity = new Date().toISOString();
    }

    async #dispatch(
        conn: NetSocket,
        swc: StartWorkConnMsg,
        initialData: Uint8Array,
    ): Promise<void> {
        const proxy = this.cfg.proxies.get(swc.proxy_name);
        if (!proxy) {
            this.failed++;
            this.#touch();
            this.log.warn(
                `Work connection references unknown proxy "${swc.proxy_name}"`,
            );
            return;
        }
        const { conn: workConn, initialData: workInitialData } = await this
            .#wrapWorkConn(conn, proxy, initialData);
        const srcAddr = sourceAddr(swc);

        if (this.cfg.hooks?.onConnect) {
            await Promise.resolve(this.cfg.hooks.onConnect(swc.proxy_name, srcAddr));
        }
        const wire = proxyWireOptions(proxy);
        try {
            if (proxy instanceof TCP) {
                await handleTcp(
                    workConn,
                    swc,
                    proxy.handler,
                    workInitialData,
                    wire?.proxyProtocolVersion,
                );
            } else if (proxy instanceof TCPMux) {
                await handleTcp(
                    workConn,
                    swc,
                    proxy.handler,
                    workInitialData,
                    wire?.proxyProtocolVersion,
                );
            } else if (proxy instanceof STCP) {
                await handleTcp(
                    workConn,
                    swc,
                    proxy.handler,
                    workInitialData,
                    wire?.proxyProtocolVersion,
                );
            } else if (proxy instanceof HTTP) {
                await handleHttp(
                    workConn,
                    swc,
                    proxy.opts,
                    proxy.handler,
                    workInitialData,
                    this.log,
                );
            } else if (proxy instanceof RawHTTP) {
                await handleRawHttp(
                    workConn,
                    swc,
                    proxy.handler,
                    workInitialData,
                    wire?.proxyProtocolVersion,
                );
            } else if (proxy instanceof UDP) {
                await handleUdp(
                    workConn,
                    swc,
                    proxy.handler,
                    wire?.proxyProtocolVersion,
                    this.cfg.wireProtocol ?? 'v1',
                );
            }
        } catch (error) {
            throw new Error(
                `Proxy "${swc.proxy_name}" work connection failed for ${srcAddr.hostname}:${srcAddr.port}`,
                { cause: error },
            );
        } finally {
            if (this.cfg.hooks?.onDisconnect) {
                await Promise.resolve(
                    this.cfg.hooks.onDisconnect(swc.proxy_name, srcAddr),
                );
            }
            this.log.debug(
                `Work connection closed: proxy="${swc.proxy_name}", source=${srcAddr.hostname}:${srcAddr.port}`,
            );
        }
    }

    async #wrapWorkConn(
        conn: NetSocket,
        proxy: ProxyBase,
        initialData: Uint8Array,
    ): Promise<{ conn: NetSocket; initialData: Uint8Array }> {
        const opts = 'opts' in proxy ? proxy.opts as ProxyCommonOptions : undefined;
        let workConn = conn as NetSocket;
        let pendingInitialData = initialData;
        const wire = opts ? proxyOptions(opts) : undefined;
        const clientLimit = clientBandwidthLimit(wire);
        if (clientLimit) {
            workConn = createRateLimitedConn(
                workConn,
                clientLimit,
            ) as unknown as NetSocket;
        }
        if (wire?.useEncryption) {
            workConn = await createEncryptedConn(
                workConn,
                this.cfg.auth.encryptionKey,
                pendingInitialData,
            ) as unknown as NetSocket;
            pendingInitialData = new Uint8Array();
        }
        if (wire?.useCompression) {
            workConn = createCompressedConn(
                workConn,
                pendingInitialData,
            ) as unknown as NetSocket;
            pendingInitialData = new Uint8Array();
        }
        return { conn: workConn, initialData: pendingInitialData };
    }
}

function proxyWireOptions(
    proxy: ProxyBase,
): NormalizedProxyOptions | undefined {
    const opts = 'opts' in proxy ? proxy.opts as ProxyCommonOptions : undefined;
    return opts ? proxyOptions(opts) : undefined;
}

function sourceAddr(swc: StartWorkConnMsg): NetAddr {
    return { hostname: swc.src_addr, port: swc.src_port };
}

function clientBandwidthLimit(
    opts: NormalizedProxyOptions | undefined,
): number | undefined {
    if (!opts?.bandwidthLimit || opts.bandwidthLimitMode === 'server') {
        return undefined;
    }
    const bytes = bandwidthLimitBytes(opts.bandwidthLimit);
    return bytes && bytes > 0 ? bytes : undefined;
}
