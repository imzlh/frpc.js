// src/webui/dashboard.ts — Built-in WebUI dashboard (node:* modules only)

import { Buffer } from 'node:buffer';
import { createServer, type Server, type Socket } from 'node:net';
import { memoryUsage } from 'node:process';
import type { WorkConnPoolStats } from '../control/pool.ts';
import type { ForwardTarget, IConfig, ProxyBase, VisitorBase } from '../types.ts';
import { connectionOptions, domainNames, HTTP, proxyOptions, RawHTTP, serverEndpoint, STCP, STCPVisitor, TCP, TCPMux, UDP, webuiOptions } from '../types.ts';
import { getRuntimeInfo } from '../runtime.ts';
import { defaultLogger, formatError, type Logger } from '../log.ts';
import { ALPINE_SOURCE } from './alpine.ts';
import { DASHBOARD_HTML, LOGIN_HTML } from './page.ts';

type ConnectionState =
    | 'starting'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
    | 'stopped';

interface ProxyStatus {
    name: string;
    type: string;
    remoteAddr: string;
    localTarget?: string;
    route?: string;
    status: 'active' | 'error' | 'pending';
    error?: string;
    features: string[];
    details: Array<{ label: string; value: string }>;
    updatedAt: string;
}

interface VisitorStatus {
    name: string;
    type: string;
    bindAddr: string;
    serverProxy: string;
    status: 'active' | 'error' | 'pending';
    error?: string;
    updatedAt: string;
}

interface DashboardEvent {
    id: number;
    at: string;
    level: 'info' | 'success' | 'warning' | 'error';
    message: string;
}

interface DashboardData {
    runId: string;
    server: string;
    os: string;
    arch: string;
    uptime: number;
    startedAt: string;
    connectionState: ConnectionState;
    stateChangedAt: string;
    connectedAt?: string;
    reconnectAttempt: number;
    lastError?: string;
    updatedAt: string;
    webuiAuthRequired: boolean;
    client: {
        user: string;
        clientId: string;
        authMethod: string;
        authScopes: string[];
        logLevel: string;
    };
    transport: {
        protocol: string;
        tls: boolean;
        tlsServerName: string;
        tlsVerification: string;
        tcpMux: boolean;
        tcpKeepalive: number;
        muxKeepalive: number;
        heartbeat: number;
        heartbeatTimeout: number;
        poolMin: number;
        poolMax: number;
        retries: number;
    };
    pool?: WorkConnPoolStats;
    proxies: ProxyStatus[];
    visitors: VisitorStatus[];
    events: DashboardEvent[];
    memory: Record<string, number>;
}

export class WebUI {
    private server: Server | null = null;
    private runId = '';
    private startTime = Date.now();
    private stateChangedAt = new Date().toISOString();
    private connectedAt = '';
    private reconnectAttempt = 0;
    private proxyStatuses = new Map<string, ProxyStatus>();
    private visitorStatuses = new Map<string, VisitorStatus>();
    private events: DashboardEvent[] = [];
    private eventId = 0;
    private poolStatsProvider: (() => WorkConnPoolStats | undefined) | null = null;
    private running = false;
    private connectionState: ConnectionState = 'starting';
    private lastError = '';

    constructor(private cfg: IConfig, private log: Logger = defaultLogger) {}

    start(): void {
        const webuiCfg = webuiOptions(this.cfg);
        if (!webuiCfg.enabled || this.server) return;

        const host = webuiCfg.host;
        const port = webuiCfg.port;

        const server = createServer((socket) => this.#handleClient(socket));
        this.server = server;
        server.on('error', (error) => {
            if (this.server !== server) return;
            this.running = false;
            this.server = null;
            try {
                server.close();
            } catch { /* not listening */ }
            this.log.error(
                `Listen failed at http://${host}:${port}/: ${formatError(error)}`,
            );
        });
        server.listen(port, host, () => {
            if (this.server !== server) {
                server.close();
                return;
            }
            this.running = true;
            this.#addEvent('info', `Dashboard listening at ${host}:${port}`);
            this.log.info(`Dashboard at http://${host}:${port}/`);
        });
    }

    stop(): void {
        this.running = false;
        this.connectionState = 'stopped';
        try {
            this.server?.close();
        } catch { /* ignore */ }
        this.server = null;
    }

    setRunId(id: string): void {
        this.runId = id;
    }

    setConnectionState(state: ConnectionState, error = '', reconnectAttempt = 0): void {
        const changed = state !== this.connectionState || error !== this.lastError;
        this.connectionState = state;
        this.lastError = error;
        this.reconnectAttempt = reconnectAttempt;
        if (changed) {
            this.stateChangedAt = new Date().toISOString();
            if (state === 'connected') this.connectedAt = this.stateChangedAt;
            this.#addEvent(
                state === 'connected'
                    ? 'success'
                    : state === 'reconnecting'
                    ? 'warning'
                    : state === 'disconnected'
                    ? 'error'
                    : 'info',
                `Control channel ${state}${error ? `: ${error}` : ''}`,
            );
        }
        if (state !== 'connected') {
            const updatedAt = new Date().toISOString();
            for (const proxy of this.proxyStatuses.values()) {
                if (proxy.status === 'active') {
                    proxy.status = 'pending';
                    proxy.updatedAt = updatedAt;
                }
            }
            for (const visitor of this.visitorStatuses.values()) {
                if (visitor.status === 'active') {
                    visitor.status = 'pending';
                    visitor.updatedAt = updatedAt;
                }
            }
        }
    }

    setPoolStatsProvider(provider: () => WorkConnPoolStats | undefined): void {
        this.poolStatsProvider = provider;
    }

    setProxyMap(map: Map<string, ProxyBase>): void {
        this.proxyStatuses.clear();
        const updatedAt = new Date().toISOString();
        for (const [name, proxy] of map) {
            let localTarget: string | undefined;
            if (proxy instanceof TCP && typeof proxy.handler !== 'function') {
                localTarget = formatForwardTarget(proxy.handler);
            } else if (
                proxy instanceof TCPMux && typeof proxy.handler !== 'function'
            ) {
                localTarget = formatForwardTarget(proxy.handler);
            } else if (proxy instanceof STCP && typeof proxy.handler !== 'function') {
                localTarget = formatForwardTarget(proxy.handler);
            } else if (proxy instanceof HTTP) {
                localTarget = proxyLocalTarget(proxy);
            } else if (proxy instanceof RawHTTP) {
                localTarget = formatForwardTarget(proxy.handler);
            }
            this.proxyStatuses.set(name, {
                name,
                type: proxy.proxyType,
                remoteAddr: '',
                localTarget: localTarget ?? proxyLocalTarget(proxy),
                route: proxyRoute(proxy),
                status: 'pending',
                features: proxyFeatures(proxy),
                details: proxyDetails(proxy),
                updatedAt,
            });
        }
        this.#addEvent(
            'info',
            `${map.size} proxy configuration${map.size === 1 ? '' : 's'} loaded`,
        );
    }

    setProxyRemoteAddr(name: string, remoteAddr: string): void {
        const s = this.proxyStatuses.get(name);
        if (s) {
            s.remoteAddr = remoteAddr;
            s.status = 'active';
            s.error = undefined;
            s.updatedAt = new Date().toISOString();
            this.#addEvent(
                'success',
                `Proxy "${name}" registered${remoteAddr ? ` at ${remoteAddr}` : ''}`,
            );
        }
    }

    setProxyError(name: string, error = ''): void {
        const s = this.proxyStatuses.get(name);
        if (s) {
            s.status = 'error';
            s.error = error || undefined;
            s.updatedAt = new Date().toISOString();
            this.#addEvent(
                'error',
                `Proxy "${name}" failed${error ? `: ${error}` : ''}`,
            );
        }
    }

    setVisitorMap(visitors: Record<string, VisitorBase>): void {
        this.visitorStatuses.clear();
        const updatedAt = new Date().toISOString();
        for (const [name, visitor] of Object.entries(visitors)) {
            if (!(visitor instanceof STCPVisitor)) continue;
            this.visitorStatuses.set(name, {
                name,
                type: visitor.visitorType,
                bindAddr: `${visitor.opts.bindAddr ?? '127.0.0.1'}:${visitor.opts.bindPort}`,
                serverProxy: visitor.opts.serverName,
                status: 'pending',
                updatedAt,
            });
        }
    }

    setVisitorActive(name: string): void {
        const visitor = this.visitorStatuses.get(name);
        if (!visitor) return;
        visitor.status = 'active';
        visitor.error = undefined;
        visitor.updatedAt = new Date().toISOString();
        this.#addEvent('success', `Visitor "${name}" started at ${visitor.bindAddr}`);
    }

    setVisitorError(name: string, error: string): void {
        const visitor = this.visitorStatuses.get(name);
        if (!visitor) return;
        visitor.status = 'error';
        visitor.error = error;
        visitor.updatedAt = new Date().toISOString();
        this.#addEvent('error', `Visitor "${name}" failed: ${error}`);
    }

    #handleClient(socket: Socket): void {
        let buf = Buffer.alloc(0);
        let handled = false;
        socket.on('data', (chunk: Buffer) => {
            if (handled) return;
            buf = Buffer.concat([buf, chunk]);
            if (buf.length > 64 * 1024) {
                handled = true;
                this.#writeResp(socket, 431, 'text/plain', 'Request Header Fields Too Large');
                return;
            }
            const text = buf.toString('utf-8');
            const headerEnd = text.indexOf('\r\n\r\n');
            if (headerEnd === -1) return; // wait for complete headers
            handled = true;

            // Parse request line
            const lines = text.substring(0, headerEnd).split('\r\n');
            const [method, target] = (lines[0] ?? '').split(' ');
            const url = (target ?? '/').split('?', 1)[0]!;
            if (method !== 'GET') {
                this.#writeResp(socket, 405, 'text/plain', 'Method Not Allowed', {
                    Allow: 'GET',
                });
                return;
            }

            // Dashboard shell and login page are public; API data stays protected.
            const webuiCfg = webuiOptions(this.cfg);
            const publicRoute = url === '/' || url === '/index.html' ||
                url === '/login' || url === '/assets/alpine.js';
            if (!publicRoute && webuiCfg.user && webuiCfg.password) {
                const authHeader = this.#getHeader(text, 'authorization');
                if (
                    !authHeader ||
                    !this.#checkBasicAuth(authHeader, webuiCfg.user, webuiCfg.password)
                ) {
                    this.#writeResp(socket, 401, 'text/plain', '401 Unauthorized');
                    return;
                }
            }

            // Route
            if (url === '/' || url === '/index.html') {
                this.#serveDashboard(socket);
            } else if (url === '/login') {
                this.#serveLogin(socket);
            } else if (url === '/assets/alpine.js') {
                this.#serveAlpine(socket);
            } else if (url === '/api/status') {
                this.#serveApi(socket, this.#collectStatus());
            } else if (url === '/api/proxies') {
                this.#serveApi(socket, [...this.proxyStatuses.values()]);
            } else {
                this.#writeResp(socket, 404, 'text/plain', 'Not Found');
            }

        });

        socket.on(
            'error',
            (error) => this.log.debug(`Client connection error: ${formatError(error)}`),
        );
    }

    #serveDashboard(socket: Socket): void {
        this.#writeResp(socket, 200, 'text/html; charset=utf-8', DASHBOARD_HTML, {
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
        });
    }

    #serveLogin(socket: Socket): void {
        this.#writeResp(socket, 200, 'text/html; charset=utf-8', LOGIN_HTML, {
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
        });
    }

    #serveAlpine(socket: Socket): void {
        this.#writeResp(
            socket,
            200,
            'text/javascript; charset=utf-8',
            ALPINE_SOURCE,
            {
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff',
            },
        );
    }

    #serveApi(socket: Socket, data: unknown): void {
        const json = JSON.stringify(data, null, 2);
        this.#writeResp(socket, 200, 'application/json', json, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
    }

    #writeResp(
        socket: Socket,
        status: number,
        contentType: string,
        body: string,
        extraHeaders?: Record<string, string>,
    ): void {
        const statusText = status === 200
            ? 'OK'
            : status === 401
            ? 'Unauthorized'
            : status === 404
            ? 'Not Found'
            : status === 405
            ? 'Method Not Allowed'
            : status === 431
            ? 'Request Header Fields Too Large'
            : status === 500
            ? 'Internal Server Error'
            : 'Error';
        let hdr = `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
        if (extraHeaders) {
            for (const [k, v] of Object.entries(extraHeaders)) {
                hdr += `${k}: ${v}\r\n`;
            }
        }
        hdr += 'Connection: close\r\n\r\n';
        const resp = new Uint8Array(
            Buffer.byteLength(hdr) + Buffer.byteLength(body),
        );
        resp.set(new TextEncoder().encode(hdr));
        resp.set(new TextEncoder().encode(body), Buffer.byteLength(hdr));
        socket.end(resp);
    }

    #collectStatus(): DashboardData {
        let mem: Record<string, number> = {};
        try {
            const m = memoryUsage();
            mem = { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal };
        } catch { /* not available */ }

        const info = getRuntimeInfo();
        const transport = connectionOptions(this.cfg);
        return {
            runId: this.runId,
            server: serverEndpoint(this.cfg),
            os: info.os,
            arch: info.arch,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            startedAt: new Date(this.startTime).toISOString(),
            connectionState: this.connectionState,
            stateChangedAt: this.stateChangedAt,
            connectedAt: this.connectedAt || undefined,
            reconnectAttempt: this.reconnectAttempt,
            lastError: this.lastError || undefined,
            updatedAt: new Date().toISOString(),
            webuiAuthRequired: Boolean(
                webuiOptions(this.cfg).user && webuiOptions(this.cfg).password,
            ),
            client: {
                user: this.cfg.user ?? '',
                clientId: this.cfg.clientID ?? '',
                authMethod: this.cfg.auth?.method ?? 'token',
                authScopes: this.cfg.auth?.additionalScopes ?? [],
                logLevel: this.cfg.logLevel ?? 'info',
            },
            transport: {
                protocol: transport.wireProtocol,
                tls: transport.tls,
                tlsServerName: transport.tlsServerName ?? '',
                tlsVerification: !transport.tls
                    ? 'off'
                    : transport.tlsInsecureSkipVerify
                    ? 'insecure'
                    : transport.tlsTrustedCaFile
                    ? 'custom CA'
                    : 'system/default',
                tcpMux: transport.tcpMux,
                tcpKeepalive: transport.dialServerKeepalive,
                muxKeepalive: transport.tcpMuxKeepaliveInterval,
                heartbeat: transport.heartbeat,
                heartbeatTimeout: transport.heartbeatTimeout,
                poolMin: transport.pool.min,
                poolMax: transport.pool.max,
                retries: transport.retries,
            },
            pool: this.poolStatsProvider?.(),
            proxies: [...this.proxyStatuses.values()],
            visitors: [...this.visitorStatuses.values()],
            events: this.events,
            memory: mem,
        };
    }

    #addEvent(level: DashboardEvent['level'], message: string): void {
        this.events = [{
            id: ++this.eventId,
            at: new Date().toISOString(),
            level,
            message,
        }, ...this.events].slice(0, 40);
    }

    #getHeader(req: string, name: string): string | null {
        const line = req.split('\r\n').find((l) => l.toLowerCase().startsWith(name + ':'));
        return line ? line.slice(line.indexOf(':') + 1).trim() : null;
    }

    #checkBasicAuth(header: string, user: string, password: string): boolean {
        if (!header.startsWith('Basic ')) return false;
        try {
            const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
            const separator = decoded.indexOf(':');
            if (separator < 0) return false;
            return decoded.slice(0, separator) === user &&
                decoded.slice(separator + 1) === password;
        } catch {
            return false;
        }
    }
}

function formatForwardTarget(target: ForwardTarget): string {
    return target.type === 'unix' ? `unix:${target.path}` : `${target.host}:${target.port}`;
}

function proxyLocalTarget(proxy: ProxyBase): string | undefined {
    if (!('opts' in proxy)) return undefined;
    const opts = proxy.opts as {
        localUnixSocket?: string;
        localIP?: string;
        localPort?: number;
    };
    if (opts.localUnixSocket) return `unix:${opts.localUnixSocket}`;
    if (opts.localPort) return `${opts.localIP ?? '127.0.0.1'}:${opts.localPort}`;
    if ('handler' in proxy && typeof proxy.handler === 'function') return 'Custom handler';
    return undefined;
}

function proxyRoute(proxy: ProxyBase): string | undefined {
    if (proxy instanceof TCP || proxy instanceof UDP) return `:${proxy.opts.remotePort}`;
    if (proxy instanceof HTTP || proxy instanceof RawHTTP || proxy instanceof TCPMux) {
        const domains = domainNames(proxy.opts);
        if (domains?.length) {
            const protocol = proxy.proxyType === 'https'
                ? 'https://'
                : proxy.proxyType === 'http'
                ? 'http://'
                : '';
            return domains.map((domain) => `${protocol}${domain}`).join(', ');
        }
        if (proxy.opts.subdomain) return `${proxy.opts.subdomain}.*`;
    }
    if (proxy instanceof STCP) return 'Private service';
    return undefined;
}

function proxyFeatures(proxy: ProxyBase): string[] {
    if (!('opts' in proxy)) return [];
    const opts = proxy.opts as Parameters<typeof proxyOptions>[0];
    const wire = proxyOptions(opts);
    const features: string[] = [];
    if (wire.useEncryption) features.push('encrypted');
    if (wire.useCompression) features.push('compressed');
    if (wire.bandwidthLimit) features.push(wire.bandwidthLimit);
    if (wire.proxyProtocolVersion) features.push(`proxy-${wire.proxyProtocolVersion}`);
    if (opts.healthCheck) features.push(`health:${opts.healthCheck.type}`);
    if (wire.group) features.push(`group:${wire.group}`);
    return features;
}

function proxyDetails(proxy: ProxyBase): Array<{ label: string; value: string }> {
    if (!('opts' in proxy)) return [];
    const opts = proxy.opts as Parameters<typeof proxyOptions>[0] & {
        healthCheck?: {
            type: string;
            intervalSeconds?: number;
            timeoutSeconds?: number;
            maxFailed?: number;
            path?: string;
        };
        locations?: string[];
        hostHeaderRewrite?: string;
        allowUsers?: string[];
        multiplexer?: string;
    };
    const wire = proxyOptions(opts);
    const details: Array<{ label: string; value: string }> = [
        { label: 'Encryption', value: wire.useEncryption ? 'enabled' : 'disabled' },
        { label: 'Compression', value: wire.useCompression ? 'enabled' : 'disabled' },
    ];
    if (wire.bandwidthLimit) {
        details.push({
            label: 'Bandwidth',
            value: `${wire.bandwidthLimit} (${wire.bandwidthLimitMode ?? 'client'} mode)`,
        });
    }
    if (wire.proxyProtocolVersion) {
        details.push({ label: 'Proxy Protocol', value: wire.proxyProtocolVersion });
    }
    if (wire.group) details.push({ label: 'Load balance group', value: wire.group });
    if (opts.healthCheck) {
        const timing = [
            opts.healthCheck.intervalSeconds && `${opts.healthCheck.intervalSeconds}s interval`,
            opts.healthCheck.timeoutSeconds && `${opts.healthCheck.timeoutSeconds}s timeout`,
            opts.healthCheck.maxFailed && `${opts.healthCheck.maxFailed} failures`,
        ].filter(Boolean).join(', ');
        details.push({
            label: 'Health check',
            value: `${opts.healthCheck.type}${timing ? ` (${timing})` : ''}${opts.healthCheck.path ? ` ${opts.healthCheck.path}` : ''}`,
        });
    }
    if (opts.locations?.length) {
        details.push({ label: 'Locations', value: opts.locations.join(', ') });
    }
    if (opts.hostHeaderRewrite) {
        details.push({ label: 'Host rewrite', value: opts.hostHeaderRewrite });
    }
    if (opts.multiplexer) {
        details.push({ label: 'Multiplexer', value: opts.multiplexer });
    }
    if (opts.allowUsers?.length) {
        details.push({ label: 'Allowed users', value: opts.allowUsers.join(', ') });
    }
    return details;
}
