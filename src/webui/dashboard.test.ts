import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type AddressInfo, createServer } from 'node:net';
import { WebUI } from './dashboard.ts';
import type { Logger } from '../log.ts';
import { type ProxyBase, STCP, TCP } from '../types.ts';

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function waitForServer(url: string): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i < 30; i++) {
        try {
            return await fetch(url);
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw lastError;
}

Deno.test({
    name: 'WebUI — handles an asynchronous listen error',
    sanitizeResources: false,
    sanitizeOps: false,
}, async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (occupied.address() as AddressInfo).port;
    const errors: string[] = [];
    const logger: Logger = {
        debug() {},
        info() {},
        warn() {},
        error(message) {
            errors.push(message);
        },
    };
    const webui = new WebUI({
        server: '127.0.0.1:7000',
        proxies: {},
        webui: { enabled: true, host: '127.0.0.1', port },
    }, logger);

    try {
        webui.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assertEquals(errors.length, 1);
    } finally {
        webui.stop();
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
});

Deno.test({
    name: 'WebUI — serves the Alpine dashboard and status lifecycle',
    sanitizeResources: false,
    sanitizeOps: false,
}, async () => {
    const port = await freePort();
    const webui = new WebUI({
        server: 'frps.example.test:7000',
        proxies: {},
        connection: {
            tls: true,
            tcpMux: true,
            heartbeat: 30,
            heartbeatTimeout: 90,
        },
        webui: { enabled: true, host: '127.0.0.1', port },
    });
    webui.setProxyMap(new Map<string, ProxyBase>([
        ['demo.tcp', new TCP({ localIP: '127.0.0.1', localPort: 8080, remotePort: 9000 })],
        ['demo.private', new STCP({ localPort: 5432, secretKey: 'super-secret' })],
    ]));
    webui.setConnectionState('connected');
    webui.setRunId('run-123');
    webui.setProxyRemoteAddr('demo.tcp', ':9000');
    webui.setPoolStatsProvider(() => ({
        active: 2,
        opening: 1,
        limit: 5,
        requested: 8,
        accepted: 6,
        rejected: 1,
        failed: 1,
        completed: 4,
        limited: 0,
    }));

    try {
        webui.start();
        const page = await waitForServer(`http://127.0.0.1:${port}/`);
        assertEquals(page.status, 200);
        assertStringIncludes(page.headers.get('content-type') ?? '', 'text/html');
        const html = await page.text();
        assertStringIncludes(html, 'x-data="dashboard"');
        assertStringIncludes(html, 'src="/assets/alpine.js"');
        assertStringIncludes(html, 'No matching proxies');

        const alpine = await fetch(`http://127.0.0.1:${port}/assets/alpine.js`);
        assertEquals(alpine.status, 200);
        assertStringIncludes(alpine.headers.get('content-type') ?? '', 'text/javascript');
        assert((await alpine.text()).length > 20_000);

        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        assertEquals(response.status, 200);
        assertEquals(response.headers.get('cache-control'), 'no-store');
        const status = await response.json();
        assertEquals(status.connectionState, 'connected');
        assertEquals(status.runId, 'run-123');
        assertEquals(status.server, 'frps.example.test:7000');
        assertEquals(status.proxies[0].status, 'active');
        assertEquals(status.proxies[0].localTarget, '127.0.0.1:8080');
        assertEquals(status.proxies[0].remoteAddr, ':9000');
        assertEquals(status.proxies[0].route, ':9000');
        assertEquals(status.proxies[0].features, []);
        assert(!JSON.stringify(status).includes('super-secret'));
        assertEquals(status.transport.protocol, 'v1');
        assertEquals(status.transport.tls, true);
        assertEquals(status.transport.tcpMux, true);
        assertEquals(status.transport.heartbeat, 30);
        assertEquals(status.pool.accepted, 6);
        assertEquals(status.pool.completed, 4);
        assert(status.events.some((event: { message: string }) =>
            event.message.includes('demo.tcp')
        ));

        webui.setConnectionState('reconnecting', 'control channel closed');
        const retry = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
        assertEquals(retry.connectionState, 'reconnecting');
        assertEquals(retry.lastError, 'control channel closed');
        assertEquals(retry.proxies[0].status, 'pending');
    } finally {
        webui.stop();
    }
});

Deno.test({
    name: 'WebUI — protects every route with Basic Auth',
    sanitizeResources: false,
    sanitizeOps: false,
}, async () => {
    const port = await freePort();
    const webui = new WebUI({
        server: '127.0.0.1:7000',
        proxies: {},
        webui: {
            enabled: true,
            host: '127.0.0.1',
            port,
            user: 'admin',
            password: 'secret:with-colon',
        },
    });

    try {
        webui.start();
        const login = await waitForServer(`http://127.0.0.1:${port}/login`);
        assertEquals(login.status, 200);
        assertStringIncludes(await login.text(), '<h1>Sign in</h1>');

        const dashboard = await fetch(`http://127.0.0.1:${port}/`);
        assertEquals(dashboard.status, 200);
        assertStringIncludes(await dashboard.text(), "location.replace('/login')");

        const asset = await fetch(`http://127.0.0.1:${port}/assets/alpine.js`);
        assertEquals(asset.status, 200);

        const unauthorized = await waitForServer(`http://127.0.0.1:${port}/api/status`);
        assertEquals(unauthorized.status, 401);
        assertEquals(unauthorized.headers.get('www-authenticate'), null);

        const rejected = await fetch(`http://127.0.0.1:${port}/api/status`, {
            headers: { Authorization: `Basic ${btoa('admin:wrong')}` },
        });
        assertEquals(rejected.status, 401);

        const authorized = await fetch(`http://127.0.0.1:${port}/api/status`, {
            headers: {
                Authorization: `Basic ${btoa('admin:secret:with-colon')}`,
            },
        });
        assertEquals(authorized.status, 200);
        assertEquals((await authorized.json()).webuiAuthRequired, true);
    } finally {
        webui.stop();
    }
});
