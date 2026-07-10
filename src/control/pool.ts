// src/control/pool.ts — Work connection pool

import { MsgType, readMsgWithTail, writeMsg, writeV2Magic, createEncryptedConn, createCompressedConn, createRateLimitedConn } from '../protocol/index.ts';
import { connectTo } from '../net/index.ts';
import { TCP, HTTP, RawHTTP, STCP, TCPMux, UDP, bandwidthLimitBytes, proxyOptions, type Hooks, type NetAddr, type NormalizedProxyOptions, type ProxyBase, type NetSocket, type ProxyCommonOptions, type WireProtocol } from '../types.ts';
import { handleTcp, handleHttp, handleRawHttp, handleUdp } from '../handler/index.ts';
import type { ClientAuth } from '../auth.ts';
import type { StartWorkConnMsg } from '../protocol/index.ts';

export interface PoolConfig {
    serverAddr: { hostname: string; port: number };
    useTls: boolean;
    tlsOpts?: { ca?: string; servername?: string; rejectUnauthorized?: boolean };
    runId: string;
    auth: ClientAuth;
    proxies: Map<string, ProxyBase>;
    min: number;
    max: number;
    wireProtocol?: WireProtocol;
    hooks?: Hooks;
}

export class WorkConnPool {
    private idle = 0;
    private total = 0;
    private live = true;
    private conns = new Set<NetSocket>();

    constructor(private cfg: PoolConfig) {}

    start(): void {
        for (let i = 0; i < this.cfg.min; i++) this.#spawn();
    }

    expand(): void { this.#spawn(); }

    stop(): void {
        this.live = false;
        for (const conn of this.conns) {
            try { conn.destroy(); } catch { /* ignore */ }
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
        if (!this.live || this.total >= this.cfg.max) return;
        this.total++;
        this.#worker().catch((e: Error) => {
            if (this.live) console.error('[pool] worker error:', e?.message ?? e);
        }).finally(() => {
            this.total--;
            this.#refill();
        });
    }

    #refill(): void {
        if (!this.live) return;
        const deficit = this.cfg.min - (this.idle + this.total);
        for (let i = 0; i < deficit; i++) this.#spawn();
    }

    async #connect(): Promise<NetSocket> {
        const conn = await connectTo(this.cfg.serverAddr, this.cfg.useTls, this.cfg.tlsOpts);
        if ((this.cfg.wireProtocol ?? 'v1') === 'v2') await writeV2Magic(conn);
        return conn;
    }

    async #worker(): Promise<void> {
        const conn = await this.#connect();
        const wireProtocol = this.cfg.wireProtocol ?? 'v1';
        this.conns.add(conn);
        let isIdle = false;
        try {
            await writeMsg(conn, MsgType.NewWorkConn, await this.cfg.auth.newWorkConn(this.cfg.runId), wireProtocol);

            this.idle++;
            isIdle = true;
            let swc: StartWorkConnMsg;
            let initialData = new Uint8Array();
            try {
                const { type, msg, tail } = await readMsgWithTail(conn, wireProtocol);
                this.idle--;
                isIdle = false;
                if (type !== MsgType.StartWorkConn) return;
                swc = msg as StartWorkConnMsg;
                initialData = new Uint8Array(tail);
            } catch {
                if (isIdle) {
                    this.idle--;
                    isIdle = false;
                }
                return;
            }

            this.#refill();

            if (swc.error) {
                console.error(`[pool] StartWorkConn error for "${swc.proxy_name}": ${swc.error}`);
                return;
            }

            await this.#dispatch(conn, swc, initialData);
        } finally {
            if (isIdle) this.idle--;
            this.conns.delete(conn);
            try { conn.destroy(); } catch { /* ignore */ }
        }
    }

    async #dispatch(conn: NetSocket, swc: StartWorkConnMsg, initialData: Uint8Array): Promise<void> {
        const proxy = this.cfg.proxies.get(swc.proxy_name);
        if (!proxy) {
            console.warn(`[pool] Unknown proxy: "${swc.proxy_name}"`);
            return;
        }
        const { conn: workConn, initialData: workInitialData } = await this.#wrapWorkConn(conn, proxy, initialData);
        const srcAddr = sourceAddr(swc);

        if (this.cfg.hooks?.onConnect) {
            await Promise.resolve(this.cfg.hooks.onConnect(swc.proxy_name, srcAddr));
        }
        const wire = proxyWireOptions(proxy);
        try {
            if (proxy instanceof TCP) {
                await handleTcp(workConn, swc, proxy.handler, workInitialData, wire?.proxyProtocolVersion);
            } else if (proxy instanceof TCPMux) {
                await handleTcp(workConn, swc, proxy.handler, workInitialData, wire?.proxyProtocolVersion);
            } else if (proxy instanceof STCP) {
                await handleTcp(workConn, swc, proxy.handler, workInitialData, wire?.proxyProtocolVersion);
            } else if (proxy instanceof HTTP) {
                await handleHttp(workConn, swc, proxy.opts, proxy.handler, workInitialData);
            } else if (proxy instanceof RawHTTP) {
                await handleRawHttp(workConn, swc, proxy.handler, workInitialData, wire?.proxyProtocolVersion);
            } else if (proxy instanceof UDP) {
                await handleUdp(workConn, swc, proxy.handler, wire?.proxyProtocolVersion, this.cfg.wireProtocol ?? 'v1');
            }
        } finally {
            if (this.cfg.hooks?.onDisconnect) {
                await Promise.resolve(this.cfg.hooks.onDisconnect(swc.proxy_name, srcAddr));
            }
        }
    }

    async #wrapWorkConn(conn: NetSocket, proxy: ProxyBase, initialData: Uint8Array): Promise<{ conn: NetSocket; initialData: Uint8Array }> {
        const opts = 'opts' in proxy
            ? proxy.opts as ProxyCommonOptions
            : undefined;
        let workConn = conn as NetSocket;
        let pendingInitialData = initialData;
        const wire = opts ? proxyOptions(opts) : undefined;
        const clientLimit = clientBandwidthLimit(wire);
        if (clientLimit) {
            workConn = createRateLimitedConn(workConn, clientLimit) as unknown as NetSocket;
        }
        if (wire?.useEncryption) {
            workConn = await createEncryptedConn(workConn, this.cfg.auth.encryptionKey, pendingInitialData) as unknown as NetSocket;
            pendingInitialData = new Uint8Array();
        }
        if (wire?.useCompression) {
            workConn = createCompressedConn(workConn, pendingInitialData) as unknown as NetSocket;
            pendingInitialData = new Uint8Array();
        }
        return { conn: workConn, initialData: pendingInitialData };
    }
}

function proxyWireOptions(proxy: ProxyBase): NormalizedProxyOptions | undefined {
    const opts = 'opts' in proxy
        ? proxy.opts as ProxyCommonOptions
        : undefined;
    return opts ? proxyOptions(opts) : undefined;
}

function sourceAddr(swc: StartWorkConnMsg): NetAddr {
    return { hostname: swc.src_addr, port: swc.src_port };
}

function clientBandwidthLimit(opts: NormalizedProxyOptions | undefined): number | undefined {
    if (!opts?.bandwidthLimit || opts.bandwidthLimitMode === 'server') return undefined;
    const bytes = bandwidthLimitBytes(opts.bandwidthLimit);
    return bytes && bytes > 0 ? bytes : undefined;
}
