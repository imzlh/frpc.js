// src/webui/dashboard.ts — Built-in WebUI dashboard (node:* modules only)

import { Buffer } from 'node:buffer';
import { createServer, Server, Socket } from 'node:net';
import { memoryUsage } from 'node:process';
import type { IConfig, ProxyBase } from '../types.ts';
import { TCP, HTTP, RawHTTP, STCP, TCPMux, domainNames, serverEndpoint, webuiOptions } from '../types.ts';
import { getRuntimeInfo } from '../runtime.ts';

interface ProxyStatus {
    name: string;
    type: string;
    remoteAddr: string;
    localTarget?: string;
    status: 'active' | 'error' | 'pending';
}

interface DashboardData {
    runId: string;
    server: string;
    os: string;
    arch: string;
    uptime: number;
    proxies: ProxyStatus[];
    memory: Record<string, number>;
}

export class WebUI {
    private server: Server | null = null;
    private runId = '';
    private startTime = Date.now();
    private proxyStatuses = new Map<string, ProxyStatus>();
    private running = false;

    constructor(private cfg: IConfig) {}

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
            try { server.close(); } catch { /* not listening */ }
            console.error('[webui] Failed:', error.message);
        });
        server.listen(port, host, () => {
            if (this.server !== server) {
                server.close();
                return;
            }
            this.running = true;
            console.log(`[webui] Dashboard at http://${host}:${port}/`);
        });
    }

    stop(): void {
        this.running = false;
        try { this.server?.close(); } catch { /* ignore */ }
        this.server = null;
    }

    setRunId(id: string): void { this.runId = id; }

    setProxyMap(map: Map<string, ProxyBase>): void {
        this.proxyStatuses.clear();
        for (const [name, proxy] of map) {
            let localTarget: string | undefined;
            if (proxy instanceof TCP && typeof proxy.handler !== 'function') {
                localTarget = `${proxy.handler.host}:${proxy.handler.port}`;
            } else if (proxy instanceof TCPMux && typeof proxy.handler !== 'function') {
                localTarget = `${proxy.handler.host}:${proxy.handler.port}`;
            } else if (proxy instanceof STCP && typeof proxy.handler !== 'function') {
                localTarget = `${proxy.handler.host}:${proxy.handler.port}`;
            } else if (proxy instanceof HTTP) {
                localTarget = formatHttpTarget(domainNames(proxy.opts), proxy.opts.subdomain);
            } else if (proxy instanceof RawHTTP) {
                localTarget = `${proxy.handler.host}:${proxy.handler.port}`;
            }
            this.proxyStatuses.set(name, {
                name, type: proxy.proxyType,
                remoteAddr: '', localTarget, status: 'pending',
            });
        }
    }

    setProxyRemoteAddr(name: string, remoteAddr: string): void {
        const s = this.proxyStatuses.get(name);
        if (s) { s.remoteAddr = remoteAddr; s.status = 'active'; }
    }

    setProxyError(name: string): void {
        const s = this.proxyStatuses.get(name);
        if (s) s.status = 'error';
    }

    #handleClient(socket: Socket): void {
        let buf = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            const text = buf.toString('utf-8');
            const headerEnd = text.indexOf('\r\n\r\n');
            if (headerEnd === -1) return; // wait for complete headers

            // Parse request line
            const lines = text.substring(0, headerEnd).split('\r\n');
            const [, path] = (lines[0] ?? '').split(' ');
            const url = path ?? '/';

            // Auth check
            const webuiCfg = webuiOptions(this.cfg);
            if (webuiCfg?.user && webuiCfg?.password) {
                const authHeader = this.#getHeader(text, 'authorization');
                if (!authHeader || !this.#checkBasicAuth(authHeader, webuiCfg.user, webuiCfg.password)) {
                    this.#writeResp(socket, 401, 'text/plain', '401 Unauthorized',
                        { 'WWW-Authenticate': 'Basic realm="frpc"' });
                    socket.end();
                    return;
                }
            }

            // Route
            if (url === '/' || url === '/index.html') {
                this.#serveDashboard(socket);
            } else if (url === '/api/status') {
                this.#serveApi(socket, this.#collectStatus());
            } else if (url === '/api/proxies') {
                this.#serveApi(socket, [...this.proxyStatuses.values()]);
            } else {
                this.#writeResp(socket, 404, 'text/plain', 'Not Found');
            }

            socket.destroy(); // one request per connection for simplicity
        });

        socket.on('error', () => {});
    }

    #serveDashboard(socket: Socket): void {
        const html = this.#renderDashboard();
        this.#writeResp(socket, 200, 'text/html; charset=utf-8', html);
    }

    #serveApi(socket: Socket, data: unknown): void {
        const json = JSON.stringify(data, null, 2);
        this.#writeResp(socket, 200, 'application/json', json,
            { 'Access-Control-Allow-Origin': '*' });
    }

    #writeResp(
        socket: Socket, status: number, contentType: string, body: string,
        extraHeaders?: Record<string, string>,
    ): void {
        const statusText = status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Error';
        let hdr = `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
        if (extraHeaders) {
            for (const [k, v] of Object.entries(extraHeaders)) hdr += `${k}: ${v}\r\n`;
        }
        hdr += 'Connection: close\r\n\r\n';
        const resp = new Uint8Array(Buffer.byteLength(hdr) + Buffer.byteLength(body));
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
        return {
            runId: this.runId, server: serverEndpoint(this.cfg),
            os: info.os, arch: info.arch,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            proxies: [...this.proxyStatuses.values()],
            memory: mem,
        };
    }

    #renderDashboard(): string {
        const d = this.#collectStatus();
        const memStr = Object.entries(d.memory).map(([k, v]) => `${k}: ${this.#fmtBytes(v)}`).join(' | ');
        const rows = d.proxies.map(p => {
            const c = p.status === 'active' ? '#4caf50' : p.status === 'error' ? '#f44336' : '#ff9800';
            return `<tr><td>${this.#esc(p.name)}</td><td>${p.type}</td><td>${this.#esc(p.localTarget ?? '—')}</td><td>${this.#esc(p.remoteAddr || '—')}</td><td><span style="color:${c}">● ${p.status}</span></td></tr>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>frpc Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#c9d1d9;padding:20px}
h1{font-size:1.4em;margin-bottom:16px;color:#58a6ff}
h2{font-size:1.1em;margin:20px 0 10px;color:#8b949e}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card .label{font-size:.75em;color:#8b949e;text-transform:uppercase;letter-spacing:.05em}
.card .value{font-size:1.3em;font-weight:600;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #21262d}
th{background:#1c2128;color:#8b949e;font-size:.8em;text-transform:uppercase}
tr:last-child td{border-bottom:none}tr:hover td{background:#1c2128}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:.85em;color:#79c0ff}
.fr{float:right;font-size:.8em;color:#58a6ff;cursor:pointer;text-decoration:underline}
</style></head>
<body>
<h1>🌐 frpc Dashboard <span class="fr" onclick="location.reload()">↻ Refresh</span></h1>
<div class="grid">
<div class="card"><div class="label">Run ID</div><div class="value mono" style="font-size:.75em">${this.#esc(d.runId)}</div></div>
<div class="card"><div class="label">Server</div><div class="value">${this.#esc(d.server)}</div></div>
<div class="card"><div class="label">OS</div><div class="value">${this.#esc(d.os)} / ${this.#esc(d.arch)}</div></div>
<div class="card"><div class="label">Uptime</div><div class="value">${this.#fmtDuration(d.uptime)}</div></div>
</div>
<h2>Memory</h2>
<div class="grid">
<div class="card"><div class="label">Memory</div><div class="value" style="font-size:.85em">${memStr || 'N/A'}</div></div>
</div>
<h2>Proxies (${d.proxies.length})</h2>
<table><thead><tr><th>Name</th><th>Type</th><th>Target</th><th>Remote</th><th>Status</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#8b949e">No proxies</td></tr>'}</tbody></table>
</body></html>`;
    }

    #fmtBytes(n: number): string {
        if (!n || n <= 0) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
    }

    #fmtDuration(s: number): string {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    }

    #esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    #getHeader(req: string, name: string): string | null {
        const line = req.split('\r\n').find(l => l.toLowerCase().startsWith(name + ':'));
        return line ? line.slice(line.indexOf(':') + 1).trim() : null;
    }

    #checkBasicAuth(header: string, user: string, password: string): boolean {
        if (!header.startsWith('Basic ')) return false;
        try {
            const decoded = this.#b64dec(header.slice(6));
            const [u, p] = decoded.split(':');
            return u === user && p === password;
        } catch { return false; }
    }

    #b64dec(s: string): string {
        const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let r = '';
        const clean = s.replace(/=+$/, '');
        for (let i = 0; i < clean.length; i += 4) {
            const a = c.indexOf(clean[i]!), b = c.indexOf(clean[i + 1]!);
            const cc = c.indexOf(clean[i + 2]!), d = c.indexOf(clean[i + 3]!);
            r += String.fromCharCode((a << 2) | (b >> 4));
            if (cc >= 0 && cc !== 64) r += String.fromCharCode((b << 4) | (cc >> 2));
            if (d >= 0 && d !== 64) r += String.fromCharCode((cc << 6) | d);
        }
        return r;
    }
}

function formatHttpTarget(domains?: string[], subdomain?: string): string | undefined {
    if (domains && domains.length > 0) return domains.join(', ');
    if (subdomain) return `${subdomain}.*`;
    return undefined;
}
