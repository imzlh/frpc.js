// example.config.ts — Example frpc configuration
// Usage:
//   deno run -A main.ts ./example.config.ts
//   npx --yes tsx main.ts ./example.config.ts
//   ../cno-cli/build/stage/cno main.ts ./example.config.ts

import { TCP, HTTP, RawHTTP } from './src/types.ts';
import type { IConfig, HttpResponseData } from './src/types.ts';

export default {
    server: 'frps.example.com:7000',
    token: 'my-secret-token',
    user: 'alice',

    connection: {
        tls: false,
        retries: 3,
        pool: { min: 1, max: 5 },
        heartbeat: 30,
        heartbeatTimeout: 90,
    },

    metadatas: { env: 'prod' },

    webui: {
        enabled: true,
        host: '127.0.0.1',
        port: 7400,
        user: 'admin',
        password: 'admin',
    },

    hooks: {
        onLogin: (runId: string) => console.log('[hook] Logged in, runId:', runId),
        onProxyRegister: (name: string, addr: string) => console.log(`[hook] Proxy "${name}" → ${addr}`),
        onReconnect: (attempt: number, delay: number) => console.log(`[hook] Reconnect #${attempt} in ${delay}ms`),
    },

    proxies: {
        'ssh': new TCP(
            { remotePort: 6000 },
            TCP.forward({ host: '127.0.0.1', port: 22 }),
        ),
        'custom': new TCP(
            { remotePort: 7001 },
            async (conn, addr) => { console.log('TCP from', addr.hostname); conn.destroy(); },
        ),
        'web': new HTTP(
            { domains: ['app.example.com'] },
            async (req, info): Promise<HttpResponseData> => ({ status: 200, body: `Hello from ${req.url}` }),
        ),
        'secure-web': new HTTP(
            { domains: ['secure.example.com'], secure: true, certFile: '/certs/server.crt', keyFile: '/certs/server.key' },
            async (): Promise<HttpResponseData> => ({ status: 200, body: 'TLS ok' }),
        ),
        'proxy': new RawHTTP(
            { domains: ['proxy.example.com'] },
            TCP.forward({ host: '127.0.0.1', port: 8080 }),
        ),
    },
} satisfies IConfig;
