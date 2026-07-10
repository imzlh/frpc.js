// src/control/channel.ts — Control channel: login, proxy registration, heartbeat

import { MsgType, MessageReader, writeMsg, createCryptoConn, type MessageSocket } from '../protocol/index.ts';
import { STCPVisitor, connectionOptions, parseServer, serverEndpoint, type IConfig, type NormalizedConnectionConfig, type ProxyBase, type ProxyCommonOptions, type VisitorBase, type VisitorCommonOptions } from '../types.ts';
import { connectTo } from '../net/index.ts';
import { WorkConnPool } from './pool.ts';
import { WebUI } from '../webui/index.ts';
import type { LoginMsg, LoginRespMsg, NewProxyRespMsg } from '../protocol/index.ts';
import { ConsoleLogger, type Logger } from '../log.ts';
import { getRuntimeInfo, runtimeHostname, runtimeRandomUUID } from '../runtime.ts';
import { createClientAuth, type ClientAuth } from '../auth.ts';
import { HealthMonitor, getHealthTarget } from './health.ts';
import { readFileSync } from 'node:fs';
import { STCPVisitorRuntime } from '../visitor/stcp.ts';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const t = setTimeout(done, ms);
        const onAbort = () => done();
        function done() {
            clearTimeout(t);
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function activeProxyEntries(cfg: IConfig): Array<[string, ProxyBase]> {
    const entries = Object.entries(cfg.proxies).filter(([, proxy]) => proxyEnabled(proxy));
    if (!cfg.start?.length) return entries;
    const selected = new Set(cfg.start);
    return entries.filter(([name]) => selected.has(name));
}

export function activeVisitorEntries(cfg: IConfig): Array<[string, VisitorBase]> {
    const entries = Object.entries(cfg.visitors ?? {}).filter(([, visitor]) => visitorEnabled(visitor));
    if (!cfg.start?.length) return entries;
    const selected = new Set(cfg.start);
    return entries.filter(([name]) => selected.has(name));
}

function proxyEnabled(proxy: ProxyBase): boolean {
    const opts = 'opts' in proxy
        ? proxy.opts as ProxyCommonOptions
        : undefined;
    return opts?.enabled !== false;
}

function visitorEnabled(visitor: VisitorBase): boolean {
    const opts = 'opts' in visitor
        ? visitor.opts as VisitorCommonOptions
        : undefined;
    return opts?.enabled !== false;
}

export async function buildLoginMsg(
    cfg: IConfig,
    auth: ClientAuth,
    runId: string,
    timestamp: number,
): Promise<LoginMsg> {
    const info = getRuntimeInfo();
    const loginAuth = await auth.login(timestamp);
    return {
        version:       '0.1.0',
        hostname:      runtimeHostname(),
        os:            info.os,
        arch:          info.arch,
        user:          cfg.user ?? '',
        privilege_key: loginAuth.privilege_key,
        timestamp:     loginAuth.timestamp,
        run_id:        runId,
        client_id:     cfg.clientID,
        pool_count:    connectionOptions(cfg).pool.min,
        metas:         cfg.metadatas ?? {},
        client_spec:   { version: 'frpc-ts/0.1.0' },
    };
}

export class ControlChannel {
    private conn: MessageSocket | null = null;
    private reader: MessageReader | null = null;
    private pool: WorkConnPool | null = null;
    private proxyMap = new Map<string, ProxyBase>();
    private runId = '';
    private lastPong = 0;
    private stopped = false;
    private abort = new AbortController();
    private webui: WebUI | null = null;
    private log: Logger;
    private auth: ClientAuth;
    private healthMonitors = new Map<string, HealthMonitor>();
    private visitors: STCPVisitorRuntime[] = [];
    private pendingProxyResp = new Map<string, {
        resolve: (resp: NewProxyRespMsg) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    constructor(private cfg: IConfig) {
        this.log = new ConsoleLogger(cfg.logLevel ?? 'info');
        this.auth = createClientAuth(cfg);
    }

    async run(): Promise<void> {
        this.webui = new WebUI(this.cfg);
        this.webui.start();

        const maxRetries = connectionOptions(this.cfg).retries;
        let attempt = 0;

        while (!this.stopped) {
            try {
                await this.#connect();
                attempt = 0;
            } catch (e) {
                if (this.stopped) break;
                attempt++;
                if (maxRetries > 0 && attempt > maxRetries) {
                    throw new Error(`[frpc] Max retries (${maxRetries}) exceeded: ${e}`);
                }
                const delay = Math.min(1_000 * 2 ** attempt, 30_000);
                this.log.error(`Disconnected (attempt ${attempt}), retry in ${delay}ms:`, (e as Error).message);
                if (this.cfg.hooks?.onReconnect) {
                    await Promise.resolve(this.cfg.hooks.onReconnect(attempt, delay));
                }
                await sleep(delay, this.abort.signal);
            }
        }

        this.webui?.stop();
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.abort.abort();
        this.webui?.stop();
        this.pool?.stop();
        this.pool = null;
        this.#stopVisitors();
        this.#stopHealthMonitors();
        this.#rejectPendingProxyResponses(new Error('control channel stopped'));
        this.reader?.close();
        this.reader = null;
        try { this.conn?.destroy(); } catch { /* ignore */ }
        this.conn = null;
    }

    async #connect(): Promise<void> {
        const endpoint = serverEndpoint(this.cfg);
        const server = parseServer(endpoint);
        const connOpts = connectionOptions(this.cfg);
        const useTls = connOpts.tls;
        const tlsOpts = this.#tlsOptions(connOpts);
        this.abort = new AbortController();

        this.log.info(`Connecting → ${endpoint} (tls=${useTls})`);
        this.conn = await connectTo(server, useTls, tlsOpts);
        this.reader = new MessageReader(this.conn);
        this.runId = runtimeRandomUUID();
        this.lastPong = Date.now();

        this.webui?.setRunId(this.runId);

        const ts = Math.floor(Date.now() / 1000);
        await writeMsg(this.conn, MsgType.Login, await buildLoginMsg(this.cfg, this.auth, this.runId, ts));

        const lr = await this.reader.readMsg();
        if (lr.type !== MsgType.LoginResp) throw new Error('Expected LoginResp');
        const lrBody = lr.msg as LoginRespMsg;
        if (lrBody.error) throw new Error(`Login failed: ${lrBody.error}`);
        this.runId = lrBody.run_id;
        this.log.info(`Logged in  run_id=${this.runId}`);
        this.webui?.setRunId(this.runId);
        this.reader.close();
        this.conn = await createCryptoConn(this.conn, this.auth.encryptionKey);
        this.reader = new MessageReader(this.conn);

        if (this.cfg.hooks?.onLogin) {
            await Promise.resolve(this.cfg.hooks.onLogin(this.runId));
        }

        this.proxyMap = await this.#registerProxies();
        this.webui?.setProxyMap(this.#allProxyMap());

            this.pool = new WorkConnPool({
                serverAddr: server, useTls, tlsOpts,
                runId: this.runId, auth: this.auth,
                proxies: this.proxyMap, min: connOpts.pool.min, max: connOpts.pool.max,
                hooks: this.cfg.hooks,
            });
        this.pool.start();
        await this.#startVisitors(server, useTls, tlsOpts);
        this.#startHealthMonitors();

        try {
            await Promise.race([this.#heartbeat(), this.#readLoop()]);
        } finally {
            this.#stopHealthMonitors();
            this.#stopVisitors();
            this.#rejectPendingProxyResponses(new Error('control channel disconnected'));
            this.pool.stop();
            this.pool = null;
            this.reader?.close();
            this.reader = null;
            try { this.conn?.destroy(); } catch { /* ignore */ }
            this.conn = null;
        }
    }

    #tlsOptions(connOpts: NormalizedConnectionConfig): { ca?: string; servername?: string; rejectUnauthorized?: boolean } | undefined {
        if (!connOpts.tls) return undefined;
        const caFile = connOpts.tlsTrustedCaFile;
        return {
            ca: caFile ? readFileSync(caFile, 'utf8') : undefined,
            servername: connOpts.tlsServerName,
            rejectUnauthorized: caFile ? connOpts.tlsInsecureSkipVerify === false : false,
        };
    }

    async #registerProxies(): Promise<Map<string, ProxyBase>> {
        const map = new Map<string, ProxyBase>();
        for (const [name, proxy] of activeProxyEntries(this.cfg)) {
            if (getHealthTarget(proxy)) continue;
            const fullName = this.#fullProxyName(name);
            await writeMsg(this.conn!, MsgType.NewProxy, proxy.toNewProxy(fullName));

            const { type, msg } = await this.reader!.readMsg();
            if (type !== MsgType.NewProxyResp) throw new Error('Expected NewProxyResp');
            const r = msg as NewProxyRespMsg;
            if (r.error) {
                this.log.error(`Proxy "${fullName}" rejected: ${r.error}`);
                this.webui?.setProxyError(fullName);
                if (this.cfg.hooks?.onProxyError) {
                    await Promise.resolve(this.cfg.hooks.onProxyError(fullName, r.error));
                }
                continue;
            }
            this.log.info(`Proxy "${fullName}" → ${r.remote_addr || '(http)'}`);
            this.webui?.setProxyRemoteAddr(fullName, r.remote_addr);
            if (this.cfg.hooks?.onProxyRegister) {
                await Promise.resolve(this.cfg.hooks.onProxyRegister(fullName, r.remote_addr));
            }
            map.set(fullName, proxy);
        }
        return map;
    }

    #fullProxyName(name: string): string {
        return this.cfg.user ? `${this.cfg.user}.${name}` : name;
    }

    #allProxyMap(): Map<string, ProxyBase> {
        return new Map(
            activeProxyEntries(this.cfg).map(([name, proxy]) => [this.#fullProxyName(name), proxy]),
        );
    }

    async #startVisitors(
        serverAddr: { hostname: string; port: number },
        useTls: boolean,
        tlsOpts?: { ca?: string; servername?: string; rejectUnauthorized?: boolean },
    ): Promise<void> {
        this.#stopVisitors();
        for (const [name, visitor] of activeVisitorEntries(this.cfg)) {
            if (visitor instanceof STCPVisitor) {
                const runtime = new STCPVisitorRuntime(name, visitor, {
                    serverAddr,
                    useTls,
                    tlsOpts,
                    runId: this.runId,
                    user: this.cfg.user,
                });
                await runtime.start();
                this.visitors.push(runtime);
                this.log.info(`Visitor "${name}" listening on ${visitor.opts.bindAddr ?? '127.0.0.1'}:${visitor.opts.bindPort}`);
            }
        }
    }

    #stopVisitors(): void {
        for (const visitor of this.visitors) visitor.stop();
        this.visitors = [];
    }

    #startHealthMonitors(): void {
        for (const [name, proxy] of activeProxyEntries(this.cfg)) {
            const healthTarget = getHealthTarget(proxy);
            if (!healthTarget) continue;
            const fullName = this.#fullProxyName(name);
            const monitor = new HealthMonitor(
                healthTarget.target,
                healthTarget.healthCheck,
                () => this.#activateProxy(fullName, proxy),
                () => this.#deactivateProxy(fullName),
            );
            this.healthMonitors.set(fullName, monitor);
            monitor.start();
        }
    }

    #stopHealthMonitors(): void {
        for (const monitor of this.healthMonitors.values()) monitor.stop();
        this.healthMonitors.clear();
    }

    async #activateProxy(fullName: string, proxy: ProxyBase): Promise<void> {
        if (this.stopped || !this.conn || this.proxyMap.has(fullName)) return;
        const remoteAddr = await this.#registerProxyDuringReadLoop(fullName, proxy);
        if (remoteAddr === undefined) return;
        this.proxyMap.set(fullName, proxy);
        this.pool?.addProxy(fullName, proxy);
        this.webui?.setProxyRemoteAddr(fullName, remoteAddr);
        this.log.info(`Proxy "${fullName}" health check success`);
    }

    async #deactivateProxy(fullName: string): Promise<void> {
        if (this.stopped || !this.conn || !this.proxyMap.has(fullName)) return;
        await writeMsg(this.conn, MsgType.CloseProxy, { proxy_name: fullName });
        this.proxyMap.delete(fullName);
        this.pool?.removeProxy(fullName);
        this.webui?.setProxyError(fullName);
        this.log.warn(`Proxy "${fullName}" health check failed`);
    }

    async #registerProxyDuringReadLoop(fullName: string, proxy: ProxyBase): Promise<string | undefined> {
        if (!this.conn) return undefined;
        const resp = new Promise<NewProxyRespMsg>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingProxyResp.delete(fullName);
                reject(new Error(`NewProxyResp timeout for "${fullName}"`));
            }, 20_000);
            this.pendingProxyResp.set(fullName, { resolve, reject, timer });
        });

        try {
            await writeMsg(this.conn, MsgType.NewProxy, proxy.toNewProxy(fullName));
            const r = await resp;
            if (r.error) {
                this.log.error(`Proxy "${fullName}" rejected: ${r.error}`);
                this.webui?.setProxyError(fullName);
                if (this.cfg.hooks?.onProxyError) {
                    await Promise.resolve(this.cfg.hooks.onProxyError(fullName, r.error));
                }
                return undefined;
            }
            if (this.cfg.hooks?.onProxyRegister) {
                await Promise.resolve(this.cfg.hooks.onProxyRegister(fullName, r.remote_addr));
            }
            return r.remote_addr;
        } catch (e) {
            this.log.error(`Proxy "${fullName}" register failed:`, (e as Error).message);
            return undefined;
        }
    }

    #resolvePendingProxyResponse(resp: NewProxyRespMsg): boolean {
        const pending = this.pendingProxyResp.get(resp.proxy_name);
        if (!pending) return false;
        clearTimeout(pending.timer);
        this.pendingProxyResp.delete(resp.proxy_name);
        pending.resolve(resp);
        return true;
    }

    #rejectPendingProxyResponses(err: Error): void {
        for (const [name, pending] of this.pendingProxyResp) {
            clearTimeout(pending.timer);
            pending.reject(err);
            this.pendingProxyResp.delete(name);
        }
    }

    async #heartbeat(): Promise<void> {
        const connOpts = connectionOptions(this.cfg);
        const interval = connOpts.heartbeat * 1_000;
        const timeout = connOpts.heartbeatTimeout * 1_000;
        if (interval < 0 || timeout < 0) {
            await new Promise<void>(() => {});
        }

        while (!this.stopped) {
            await sleep(interval, this.abort.signal);
            if (this.stopped || !this.conn) break;

            if (Date.now() - this.lastPong > timeout) {
                throw new Error('Heartbeat timeout — server unresponsive');
            }

            await writeMsg(this.conn, MsgType.Ping, await this.auth.ping());
        }
    }

    async #readLoop(): Promise<void> {
        while (!this.stopped && this.conn) {
            const { type, msg } = await this.reader!.readMsg();
            if (type === MsgType.Pong) {
                this.lastPong = Date.now();
            } else if (type === MsgType.NewProxyResp) {
                const handled = this.#resolvePendingProxyResponse(msg as NewProxyRespMsg);
                if (!handled) this.log.warn('Unexpected NewProxyResp');
            } else if (type === MsgType.ReqWorkConn) {
                this.pool?.expand();
            } else if (type === MsgType.CloseProxy) {
                const body = msg as { proxy_name?: string };
                if (body.proxy_name) {
                    this.log.info(`Server closed proxy: ${body.proxy_name}`);
                    this.proxyMap.delete(body.proxy_name);
                    this.pool?.removeProxy(body.proxy_name);
                    this.webui?.setProxyError(body.proxy_name);
                }
            } else {
                this.log.warn(`Unexpected message type: 0x${type.toString(16)}`);
            }
        }
    }
}
