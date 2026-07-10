// src/types.ts — Core business type definitions

import { Socket, connect as connectNet } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Buffer } from 'node:buffer';

// ── Network ────────────────────────────────────────────────────────────────

export type NetSocket = Socket | TLSSocket;

export interface NetAddr {
    hostname: string;
    port: number;
    transport?: 'tcp' | 'udp';
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export interface HttpRequest {
    method: string;
    url: string;
    headers: Map<string, string>;
    body: Uint8Array | null;
}

export type HttpHandler = (
    req: HttpRequest,
    remoteAddr: NetAddr,
) => Promise<HttpResponseData> | HttpResponseData;

export interface HttpResponseData {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string | null;
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface ConnectionConfig {
    tls?: boolean;
    tlsTrustedCaFile?: string;
    tlsServerName?: string;
    tlsInsecureSkipVerify?: boolean;
    retries?: number;
    pool?: { min?: number; max?: number };
    heartbeat?: number;
    heartbeatTimeout?: number;
}

export interface TransportConfig {
    poolCount?: number;
    heartbeatInterval?: number;
    heartbeatTimeout?: number;
    tls?: TransportTLSConfig;
}

export interface TransportTLSConfig {
    enable?: boolean;
    trustedCaFile?: string;
    serverName?: string;
    insecureSkipVerify?: boolean;
}

export interface NormalizedConnectionConfig {
    tls: boolean;
    tlsTrustedCaFile?: string;
    tlsServerName?: string;
    tlsInsecureSkipVerify?: boolean;
    retries: number;
    pool: { min: number; max: number };
    heartbeat: number;
    heartbeatTimeout: number;
}

export type AuthMethod = 'token' | 'oidc';
export type AuthScope = 'HeartBeats' | 'NewWorkConns';

export interface OIDCAuthConfig {
    clientID?: string;
    clientSecret?: string;
    audience?: string;
    scope?: string;
    tokenEndpointURL?: string;
    additionalEndpointParams?: Record<string, string>;
    tokenSource?: () => string | Promise<string>;
}

export interface AuthConfig {
    method?: AuthMethod;
    token?: string;
    additionalScopes?: AuthScope[];
    oidc?: OIDCAuthConfig;
}

export interface WebuiConfig {
    enabled?: boolean;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
}

export interface WebServerConfig {
    addr?: string;
    port?: number;
    user?: string;
    password?: string;
}

export interface Hooks {
    onLogin?: (runId: string) => void | Promise<void>;
    onProxyRegister?: (name: string, remoteAddr: string) => void | Promise<void>;
    onProxyError?: (name: string, error: string) => void | Promise<void>;
    onConnect?: (proxyName: string, srcAddr: NetAddr) => void | Promise<void>;
    onDisconnect?: (proxyName: string, srcAddr: NetAddr) => void | Promise<void>;
    onError?: (error: Error) => void | Promise<void>;
    onReconnect?: (attempt: number, delay: number) => void | Promise<void>;
}

export interface IConfig {
    server?: string;
    serverAddr?: string;
    serverPort?: number;
    token?: string;
    auth?: AuthConfig;
    user?: string;
    clientID?: string;
    start?: string[];
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    connection?: ConnectionConfig;
    transport?: TransportConfig;
    metadatas?: Record<string, string>;
    proxies: Record<string, ProxyBase>;
    visitors?: Record<string, VisitorBase>;
    webui?: WebuiConfig;
    webServer?: WebServerConfig;
    hooks?: Hooks;
}

// ── Proxy types ────────────────────────────────────────────────────────────

export interface ForwardTarget {
    readonly type: 'forward';
    host: string;
    port: number;
    proxyProtocol?: boolean | ProxyProtocolVersion;
}

export type TcpHandler =
    | ForwardTarget
    | ((socket: NetSocket, addr: NetAddr) => void | Promise<void>);

export interface ProxyCommonOptions {
    enabled?: boolean;
    group?: string;
    groupKey?: string;
    loadBalancer?: LoadBalancerOptions;
    transport?: ProxyTransportOptions;
    metadatas?: Record<string, string>;
    annotations?: Record<string, string>;
    bandwidthLimit?: string;
    bandwidthLimitMode?: 'server' | 'client';
    useEncryption?: boolean;
    useCompression?: boolean;
    healthCheck?: HealthCheckOptions;
}

export interface ProxyBackendOptions {
    localIP?: string;
    localPort?: number;
}

export interface LoadBalancerOptions {
    group?: string;
    groupKey?: string;
}

export interface ProxyTransportOptions {
    useEncryption?: boolean;
    useCompression?: boolean;
    bandwidthLimit?: string;
    bandwidthLimitMode?: 'server' | 'client';
    proxyProtocolVersion?: ProxyProtocolVersion;
}

export type ProxyProtocolVersion = 'v1' | 'v2';

export interface NormalizedProxyOptions {
    group?: string;
    groupKey?: string;
    bandwidthLimit?: string;
    bandwidthLimitMode?: 'server' | 'client';
    useEncryption: boolean;
    useCompression: boolean;
    proxyProtocolVersion?: ProxyProtocolVersion;
}

export interface HealthCheckOptions {
    type: 'tcp' | 'http';
    intervalSeconds?: number;
    timeoutSeconds?: number;
    maxFailed?: number;
    path?: string;
    headers?: Record<string, string>;
    httpHeaders?: HTTPHeaderOption[];
}

export interface HTTPHeaderOption {
    name: string;
    value: string;
}

export interface HeaderOperations {
    set?: Record<string, string>;
}

export interface TcpOptions extends ProxyCommonOptions, ProxyBackendOptions {
    remotePort: number;
}

export interface HttpOptions extends ProxyCommonOptions, ProxyBackendOptions {
    domains?: string[];
    customDomains?: string[];
    subdomain?: string;
    secure?: boolean;
    certFile?: string;
    keyFile?: string;
    locations?: string[];
    hostHeaderRewrite?: string;
    headers?: Record<string, string>;
    requestHeaders?: HeaderOperations;
    responseHeaders?: Record<string, string> | HeaderOperations;
    routeByHTTPUser?: string;
    httpUser?: string;
    httpPassword?: string;
    httpAuth?: { user: string; password: string };
}

export interface RawHttpOptions extends ProxyCommonOptions, ProxyBackendOptions {
    domains?: string[];
    customDomains?: string[];
    subdomain?: string;
    secure?: boolean;
}

export interface TCPMuxOptions extends ProxyCommonOptions, ProxyBackendOptions {
    domains?: string[];
    customDomains?: string[];
    subdomain?: string;
    httpUser?: string;
    httpPassword?: string;
    httpAuth?: { user: string; password: string };
    routeByHTTPUser?: string;
    multiplexer?: 'httpconnect' | string;
}

export interface SecretProxyOptions extends ProxyCommonOptions, ProxyBackendOptions {
    secretKey: string;
    allowUsers?: string[];
}

export interface VisitorTransportOptions {
    useEncryption?: boolean;
    useCompression?: boolean;
}

export interface VisitorCommonOptions {
    enabled?: boolean;
    transport?: VisitorTransportOptions;
    secretKey: string;
    serverUser?: string;
    serverName: string;
    bindAddr?: string;
    bindPort: number;
}

export interface STCPVisitorOptions extends VisitorCommonOptions {}

// ── Proxy classes ──────────────────────────────────────────────────────────

export abstract class ProxyBase {
    abstract readonly proxyType: string;
    abstract toNewProxy(fullName: string): Record<string, unknown>;
}

export class TCP extends ProxyBase {
    readonly proxyType = 'tcp';
    readonly handler: TcpHandler;
    constructor(readonly opts: TcpOptions, handler?: TcpHandler) {
        super();
        this.handler = handler ?? backendForwardTarget(opts, 'TCP');
    }

    static forward(t: { host: string; port: number; proxyProtocol?: boolean | ProxyProtocolVersion }): ForwardTarget {
        return { type: 'forward', ...t };
    }

    toNewProxy(name: string): Record<string, unknown> {
        const wire = proxyOptions(this.opts);
        return {
            proxy_name: name, proxy_type: 'tcp',
            remote_port: this.opts.remotePort,
            group: wire.group,
            group_key: wire.groupKey,
            metas: this.opts.metadatas,
            annotations: this.opts.annotations,
            bandwidth_limit: normBw(wire.bandwidthLimit),
            bandwidth_limit_mode: wireBwMode(wire.bandwidthLimitMode),
            use_encryption: wire.useEncryption,
            use_compression: wire.useCompression,
        };
    }
}

export class HTTP extends ProxyBase {
    readonly proxyType: string;
    readonly handler: HttpHandler;
    constructor(readonly opts: HttpOptions, handler?: HttpHandler) {
        super();
        this.proxyType = opts.secure ? 'https' : 'http';
        this.handler = handler ?? httpBackendHandler(opts, 'HTTP');
    }

    toNewProxy(name: string): Record<string, unknown> {
        const wire = proxyOptions(this.opts);
        const auth = httpAuthFields(this.opts);
        return {
            proxy_name: name, proxy_type: this.proxyType,
            custom_domains: domainNames(this.opts),
            subdomain: this.opts.subdomain,
            group: wire.group,
            group_key: wire.groupKey,
            metas: this.opts.metadatas,
            annotations: this.opts.annotations,
            locations: this.opts.locations,
            host_header_rewrite: this.opts.hostHeaderRewrite,
            headers: headerOperations(this.opts.headers, this.opts.requestHeaders),
            response_headers: responseHeaderOperations(this.opts.responseHeaders),
            route_by_http_user: this.opts.routeByHTTPUser,
            http_user: auth?.user,
            http_pwd: auth?.password,
            bandwidth_limit: normBw(wire.bandwidthLimit),
            bandwidth_limit_mode: wireBwMode(wire.bandwidthLimitMode),
            use_encryption: wire.useEncryption,
            use_compression: wire.useCompression,
        };
    }
}

export class RawHTTP extends ProxyBase {
    readonly proxyType: string;
    readonly handler: ForwardTarget;
    constructor(readonly opts: RawHttpOptions, handler?: ForwardTarget) {
        super();
        this.proxyType = opts.secure ? 'https' : 'http';
        this.handler = handler ?? backendForwardTarget(opts, 'RawHTTP');
    }

    toNewProxy(name: string): Record<string, unknown> {
        const wire = proxyOptions(this.opts);
        return {
            proxy_name: name, proxy_type: this.proxyType,
            custom_domains: domainNames(this.opts),
            subdomain: this.opts.subdomain,
            group: wire.group,
            group_key: wire.groupKey,
            metas: this.opts.metadatas,
            annotations: this.opts.annotations,
            bandwidth_limit: normBw(wire.bandwidthLimit),
            bandwidth_limit_mode: wireBwMode(wire.bandwidthLimitMode),
            use_encryption: wire.useEncryption,
            use_compression: wire.useCompression,
        };
    }
}

export class TCPMux extends ProxyBase {
    readonly proxyType = 'tcpmux';
    readonly handler: TcpHandler;
    constructor(readonly opts: TCPMuxOptions, handler?: TcpHandler) {
        super();
        this.handler = handler ?? backendForwardTarget(opts, 'TCPMux');
    }

    static forward(t: { host: string; port: number; proxyProtocol?: boolean | ProxyProtocolVersion }): ForwardTarget {
        return { type: 'forward', ...t };
    }

    toNewProxy(name: string): Record<string, unknown> {
        const wire = proxyOptions(this.opts);
        const auth = httpAuthFields(this.opts);
        return {
            proxy_name: name, proxy_type: 'tcpmux',
            custom_domains: domainNames(this.opts),
            subdomain: this.opts.subdomain,
            group: wire.group,
            group_key: wire.groupKey,
            metas: this.opts.metadatas,
            annotations: this.opts.annotations,
            http_user: auth?.user,
            http_pwd: auth?.password,
            route_by_http_user: this.opts.routeByHTTPUser,
            multiplexer: this.opts.multiplexer ?? 'httpconnect',
            bandwidth_limit: normBw(wire.bandwidthLimit),
            bandwidth_limit_mode: wireBwMode(wire.bandwidthLimitMode),
            use_encryption: wire.useEncryption,
            use_compression: wire.useCompression,
        };
    }
}

export class STCP extends ProxyBase {
    readonly proxyType = 'stcp';
    readonly handler: TcpHandler;
    constructor(readonly opts: SecretProxyOptions, handler?: TcpHandler) {
        super();
        this.handler = handler ?? backendForwardTarget(opts, 'STCP');
    }

    static forward(t: { host: string; port: number; proxyProtocol?: boolean | ProxyProtocolVersion }): ForwardTarget {
        return { type: 'forward', ...t };
    }

    toNewProxy(name: string): Record<string, unknown> {
        const wire = proxyOptions(this.opts);
        return {
            proxy_name: name, proxy_type: 'stcp',
            group: wire.group,
            group_key: wire.groupKey,
            metas: this.opts.metadatas,
            annotations: this.opts.annotations,
            sk: this.opts.secretKey,
            allow_users: this.opts.allowUsers,
            bandwidth_limit: normBw(wire.bandwidthLimit),
            bandwidth_limit_mode: wireBwMode(wire.bandwidthLimitMode),
            use_encryption: wire.useEncryption,
            use_compression: wire.useCompression,
        };
    }
}

export abstract class VisitorBase {
    abstract readonly visitorType: string;
}

export class STCPVisitor extends VisitorBase {
    readonly visitorType = 'stcp';
    constructor(readonly opts: STCPVisitorOptions) {
        super();
    }
}

// ── UDP proxy types ─────────────────────────────────────────────────────────

export class UDP extends ProxyBase {
    readonly proxyType = 'udp';
    readonly handler: UdpHandler;
    constructor(readonly opts: UdpOptions, handler?: UdpHandler) {
        super();
        this.handler = handler ?? backendForwardTarget(opts, 'UDP');
    }

    static forward(t: { host: string; port: number; proxyProtocol?: boolean | ProxyProtocolVersion }): ForwardTarget {
        return { type: 'forward', ...t };
    }

    toNewProxy(name: string): Record<string, unknown> {
        const wire = proxyOptions(this.opts);
        return {
            proxy_name: name, proxy_type: 'udp',
            remote_port: this.opts.remotePort,
            group: wire.group,
            group_key: wire.groupKey,
            metas: this.opts.metadatas,
            annotations: this.opts.annotations,
            bandwidth_limit: normBw(wire.bandwidthLimit),
            bandwidth_limit_mode: wireBwMode(wire.bandwidthLimitMode),
            use_encryption: wire.useEncryption,
            use_compression: wire.useCompression,
        };
    }
}

export interface UdpOptions extends ProxyCommonOptions, ProxyBackendOptions {
    remotePort: number;
}

export interface UDPPacketMsg {
    content: Uint8Array;
    local_addr?: { hostname: string; port: number };
    remote_addr?: { hostname: string; port: number };
}

export interface UdpWireAddr {
    IP: string;
    Port: number;
    Zone?: string;
}

export interface UdpWirePacketMsg {
    c?: string;
    l?: UdpWireAddr | null;
    r?: UdpWireAddr | null;
}

export type UdpHandler =
    | ForwardTarget
    | ((pkt: UDPPacketMsg, addr: NetAddr) => Uint8Array | Promise<Uint8Array>);

// ── Re-export protocol types ────────────────────────────────────────────────

export type { StartWorkConnMsg, NewWorkConnMsg } from './protocol/message.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

const BW_UNITS: Record<string, string> = { k: 'KB', m: 'MB', g: 'GB', '': 'B' };

export function normBw(s?: string): string | undefined {
    if (!s) return undefined;
    return s.replace(/\/s$/i, '').trim()
            .replace(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i, (_, n, u) =>
                `${n}${BW_UNITS[u.toLowerCase()] ?? 'MB'}`
            );
}

export function bandwidthLimitBytes(s?: string): number | undefined {
    const value = normBw(s);
    if (!value) return undefined;

    const match = /^(\d+(?:\.\d+)?)(B|KB|MB|GB)$/i.exec(value);
    if (!match) throw new Error(`Invalid bandwidth limit: ${s}`);

    const amount = Number(match[1]);
    const unit = match[2]!.toUpperCase();
    const scale = unit === 'GB' ? 1024 * 1024 * 1024
        : unit === 'MB' ? 1024 * 1024
        : unit === 'KB' ? 1024
        : 1;
    return Math.floor(amount * scale);
}

export function wireBwMode(mode?: 'server' | 'client'): 'server' | undefined {
    return mode === 'server' ? 'server' : undefined;
}

export function proxyOptions(opts: ProxyCommonOptions): NormalizedProxyOptions {
    const out: NormalizedProxyOptions = {
        group: opts.group ?? opts.loadBalancer?.group,
        groupKey: opts.groupKey ?? opts.loadBalancer?.groupKey,
        bandwidthLimit: opts.bandwidthLimit ?? opts.transport?.bandwidthLimit,
        bandwidthLimitMode: opts.bandwidthLimitMode ?? opts.transport?.bandwidthLimitMode,
        useEncryption: opts.useEncryption ?? opts.transport?.useEncryption ?? false,
        useCompression: opts.useCompression ?? opts.transport?.useCompression ?? false,
    };
    if (opts.transport?.proxyProtocolVersion) out.proxyProtocolVersion = opts.transport.proxyProtocolVersion;
    return out;
}

export function domainNames(opts: { domains?: string[]; customDomains?: string[] }): string[] | undefined {
    return opts.domains ?? opts.customDomains;
}

export function targetProxyProtocolVersion(
    target: ForwardTarget,
    fallback?: ProxyProtocolVersion,
): ProxyProtocolVersion | undefined {
    if (!target.proxyProtocol) return fallback;
    return target.proxyProtocol === true ? 'v2' : target.proxyProtocol;
}

export function backendForwardTarget(opts: ProxyBackendOptions, proxyType: string): ForwardTarget {
    if (opts.localPort === undefined) {
        throw new Error(`${proxyType} proxy requires a handler or localPort`);
    }
    return {
        type: 'forward',
        host: opts.localIP ?? '127.0.0.1',
        port: opts.localPort,
    };
}

export function httpBackendHandler(opts: ProxyBackendOptions, proxyType: string): HttpHandler {
    const target = backendForwardTarget(opts, proxyType);
    return async (req) => {
        const incoming = new URL(req.url);
        const hasBody = req.body && req.body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
        const body = hasBody ? req.body! : new Uint8Array();
        const socket = await connectHttpBackend(target);
        try {
            await writeHttpBackendRequest(socket, {
                method: req.method,
                path: `${incoming.pathname}${incoming.search}`,
                headers: req.headers,
                target,
                body,
            });
            return await readHttpBackendResponse(socket, req.method === 'HEAD');
        } finally {
            try { socket.destroy(); } catch { /* ignore */ }
        }
    };
}

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function connectHttpBackend(target: ForwardTarget): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connectNet({ host: target.host, port: target.port });
        const done = (err?: Error) => {
            socket.off('connect', onConnect);
            socket.off('error', onError);
            if (err) reject(err);
            else resolve(socket);
        };
        const onConnect = () => done();
        const onError = (err: Error) => done(err);
        socket.once('connect', onConnect);
        socket.once('error', onError);
    });
}

function writeHttpBackendRequest(socket: Socket, req: {
    method: string;
    path: string;
    headers: Map<string, string>;
    target: ForwardTarget;
    body: Uint8Array;
}): Promise<void> {
    const head = [
        `${req.method} ${req.path || '/'} HTTP/1.1`,
        ...httpBackendRequestHeaders(req.headers, req.target, req.body),
        '',
        '',
    ].join('\r\n');
    const payload = req.body.length > 0
        ? Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(req.body)])
        : Buffer.from(head, 'utf8');
    return new Promise((resolve, reject) => {
        socket.write(payload, (err) => err ? reject(err) : resolve());
    });
}

function httpBackendRequestHeaders(input: Map<string, string>, target: ForwardTarget, body: Uint8Array): string[] {
    const headers: string[] = [];
    let hasHost = false;
    for (const [key, value] of input) {
        const lower = key.toLowerCase();
        if (lower === 'host') hasHost = true;
        if (lower === 'content-length' || HOP_BY_HOP_HEADERS.has(lower)) continue;
        headers.push(`${key}: ${value}`);
    }
    if (!hasHost) headers.unshift(`host: ${target.host}:${target.port}`);
    headers.push(`content-length: ${body.byteLength}`);
    headers.push('connection: close');
    return headers;
}

async function readHttpBackendResponse(socket: Socket, headOnly: boolean): Promise<HttpResponseData> {
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    while (headerEnd === -1) {
        const chunk = await readSocketChunk(socket);
        if (!chunk) throw new Error('HTTP backend closed before response headers');
        chunks.push(chunk);
        headerEnd = Buffer.concat(chunks).indexOf('\r\n\r\n');
    }

    const all = Buffer.concat(chunks);
    const head = all.subarray(0, headerEnd).toString('utf8');
    const lines = head.split('\r\n');
    const statusLine = lines.shift() ?? 'HTTP/1.1 502 Bad Gateway';
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine);
    const headers: Record<string, string> = {};
    let contentLength: number | undefined;
    let transferEncoding = '';
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const lower = key.toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (lower === 'content-length') contentLength = Number(value);
        if (lower === 'transfer-encoding') transferEncoding = value.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(lower)) headers[key] = value;
    }

    if (headOnly) {
        return { status: Number(statusMatch?.[1] ?? 502), statusText: statusMatch?.[2], headers, body: null };
    }

    const bodyStart = headerEnd + 4;
    let body: Buffer<ArrayBufferLike> = Buffer.from(all.subarray(bodyStart));
    if (contentLength !== undefined) {
        while (body.byteLength < contentLength) {
            const chunk = await readSocketChunk(socket);
            if (!chunk) break;
            body = Buffer.concat([body, chunk]);
        }
        body = body.subarray(0, contentLength);
    } else if (transferEncoding.split(',').map((v) => v.trim()).includes('chunked')) {
        let decoded = tryDecodeChunkedBody(body);
        while (!decoded) {
            const chunk = await readSocketChunk(socket);
            if (!chunk) break;
            body = Buffer.concat([body, chunk]);
            decoded = tryDecodeChunkedBody(body);
        }
        body = decoded ?? Buffer.alloc(0);
    } else {
        for (;;) {
            const chunk = await readSocketChunk(socket);
            if (!chunk) break;
            body = Buffer.concat([body, chunk]);
        }
    }

    return {
        status: Number(statusMatch?.[1] ?? 502),
        statusText: statusMatch?.[2],
        headers,
        body: new Uint8Array(body),
    };
}

function tryDecodeChunkedBody(body: Buffer): Buffer | null {
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
        const lineEnd = body.indexOf('\r\n', offset);
        if (lineEnd === -1) return null;
        const sizeText = body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0]!.trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size)) throw new Error(`Invalid chunk size: ${sizeText}`);
        offset = lineEnd + 2;
        if (size === 0) {
            const trailerEnd = body.indexOf('\r\n\r\n', offset);
            if (trailerEnd === -1 && body.byteLength < offset + 2) return null;
            return Buffer.concat(chunks);
        }
        if (body.byteLength < offset + size + 2) return null;
        chunks.push(body.subarray(offset, offset + size));
        offset += size;
        if (body[offset] !== 0x0d || body[offset + 1] !== 0x0a) {
            throw new Error('Invalid chunk terminator');
        }
        offset += 2;
    }
}

function readSocketChunk(socket: Socket): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        const onData = (chunk: Buffer) => {
            cleanup();
            resolve(chunk);
        };
        const onEnd = () => {
            cleanup();
            resolve(null);
        };
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('close', onEnd);
            socket.off('error', onError);
        };
        socket.once('data', onData);
        socket.once('end', onEnd);
        socket.once('close', onEnd);
        socket.once('error', onError);
        socket.resume();
    });
}

export function healthCheckHeaders(opts: HealthCheckOptions): Record<string, string> | undefined {
    if (opts.headers) return opts.headers;
    if (!opts.httpHeaders?.length) return undefined;

    const headers: Record<string, string> = {};
    for (const header of opts.httpHeaders) {
        if (header.name) headers[header.name] = header.value;
    }
    return Object.keys(headers).length ? headers : undefined;
}

export function headerOperations(headers?: Record<string, string>, ops?: HeaderOperations): Record<string, string> | undefined {
    return headers ?? ops?.set;
}

export function responseHeaderOperations(value?: Record<string, string> | HeaderOperations): Record<string, string> | undefined {
    if (!value) return undefined;
    const set = (value as HeaderOperations).set;
    if (set && typeof set === 'object' && !Array.isArray(set)) return set;
    return value as Record<string, string>;
}

export function httpAuthFields(opts: Pick<HttpOptions, 'httpAuth' | 'httpUser' | 'httpPassword'>): { user?: string; password?: string } | undefined {
    if (opts.httpAuth) return { user: opts.httpAuth.user, password: opts.httpAuth.password };
    if (opts.httpUser === undefined && opts.httpPassword === undefined) return undefined;
    return { user: opts.httpUser, password: opts.httpPassword };
}

export function targetServerProxyName(localUser: string | undefined, serverUser: string | undefined, serverName: string): string {
    const user = serverUser || localUser || '';
    return user ? `${user}.${serverName}` : serverName;
}

export function hasServerConfig(cfg: Pick<IConfig, 'server' | 'serverAddr' | 'serverPort'>): boolean {
    return Boolean(cfg.server || cfg.serverAddr || cfg.serverPort !== undefined);
}

export function serverEndpoint(cfg: Pick<IConfig, 'server' | 'serverAddr' | 'serverPort'>): string {
    if (cfg.server) return cfg.server;
    const host = cfg.serverAddr ?? '0.0.0.0';
    const port = cfg.serverPort ?? 7000;
    if (host.includes(':') && !host.startsWith('[')) return `[${host}]:${port}`;
    return `${host}:${port}`;
}

export function connectionOptions(cfg: Pick<IConfig, 'connection' | 'transport'>): NormalizedConnectionConfig {
    const poolMin = cfg.connection?.pool?.min ?? cfg.transport?.poolCount ?? 1;
    return {
        tls: cfg.connection?.tls ?? cfg.transport?.tls?.enable ?? false,
        tlsTrustedCaFile: cfg.connection?.tlsTrustedCaFile ?? cfg.transport?.tls?.trustedCaFile,
        tlsServerName: cfg.connection?.tlsServerName ?? cfg.transport?.tls?.serverName,
        tlsInsecureSkipVerify: cfg.connection?.tlsInsecureSkipVerify ?? cfg.transport?.tls?.insecureSkipVerify,
        retries: cfg.connection?.retries ?? 3,
        pool: {
            min: poolMin,
            max: cfg.connection?.pool?.max ?? Math.max(5, poolMin),
        },
        heartbeat: cfg.connection?.heartbeat ?? cfg.transport?.heartbeatInterval ?? 30,
        heartbeatTimeout: cfg.connection?.heartbeatTimeout ?? cfg.transport?.heartbeatTimeout ?? 90,
    };
}

export function webuiOptions(cfg: Pick<IConfig, 'webui' | 'webServer'>): Required<Pick<WebuiConfig, 'enabled' | 'host' | 'port'>> & Pick<WebuiConfig, 'user' | 'password'> {
    if (cfg.webui) {
        return {
            enabled: cfg.webui.enabled !== false,
            host: cfg.webui.host ?? '127.0.0.1',
            port: cfg.webui.port ?? 7400,
            user: cfg.webui.user,
            password: cfg.webui.password,
        };
    }

    if (cfg.webServer) {
        const port = cfg.webServer.port ?? 0;
        return {
            enabled: port > 0,
            host: cfg.webServer.addr ?? '127.0.0.1',
            port,
            user: cfg.webServer.user,
            password: cfg.webServer.password,
        };
    }

    return {
        enabled: true,
        host: '127.0.0.1',
        port: 7400,
    };
}

export function parseServer(s: string): { hostname: string; port: number } {
    const value = s.trim();
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        if (end !== -1) {
            const hostname = value.slice(1, end);
            const portText = value.slice(end + 1).startsWith(':') ? value.slice(end + 2) : '';
            return { hostname, port: Number(portText) || 7000 };
        }
    }

    const firstColon = value.indexOf(':');
    const lastColon = value.lastIndexOf(':');
    if (firstColon === -1) return { hostname: value, port: 7000 };
    if (firstColon !== lastColon) return { hostname: value, port: 7000 };

    return { hostname: value.slice(0, lastColon), port: Number(value.slice(lastColon + 1)) || 7000 };
}
