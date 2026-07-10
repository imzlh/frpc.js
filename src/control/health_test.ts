// src/control/health_test.ts — Local health check tests

import { assertEquals } from '@std/assert';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { getHealthTarget, HealthMonitor } from './health.ts';
import { STCP, TCPMux, type ForwardTarget } from '../types.ts';

function listen(): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => socket.end());
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as { port: number }).port });
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function closeHttp(server: HttpServer): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function waitFor(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (check()) return resolve();
            if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
            setTimeout(tick, 20);
        };
        tick();
    });
}

Deno.test('getHealthTarget — supports TCPMux local backend health checks', () => {
    const proxy = new TCPMux({
        customDomains: ['mux.example.com'],
        localIP: '127.0.0.2',
        localPort: 8443,
        healthCheck: { type: 'tcp' },
    });

    assertEquals(getHealthTarget(proxy), {
        target: { type: 'forward', host: '127.0.0.2', port: 8443 },
        healthCheck: { type: 'tcp' },
    });
});

Deno.test('getHealthTarget — supports STCP local backend health checks', () => {
    const proxy = new STCP({
        secretKey: 'secret',
        localIP: '127.0.0.2',
        localPort: 8443,
        healthCheck: { type: 'tcp' },
    });

    assertEquals(getHealthTarget(proxy), {
        target: { type: 'forward', host: '127.0.0.2', port: 8443 },
        healthCheck: { type: 'tcp' },
    });
});

Deno.test({ name: 'HealthMonitor — reports TCP up and down', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { server, port } = await listen();
    const target: ForwardTarget = { type: 'forward', host: '127.0.0.1', port };
    let healthy = 0;
    let unhealthy = 0;
    const monitor = new HealthMonitor(
        target,
        { type: 'tcp', intervalSeconds: 0.05, timeoutSeconds: 0.1, maxFailed: 1 },
        () => {
            healthy++;
        },
        () => {
            unhealthy++;
        },
    );

    try {
        monitor.start();
        await waitFor(() => healthy === 1, 'healthy callback');
        await close(server);
        await waitFor(() => unhealthy === 1, 'unhealthy callback');
        assertEquals(healthy, 1);
        assertEquals(unhealthy, 1);
    } finally {
        monitor.stop();
        if (server.listening) await close(server);
    }
});

Deno.test({ name: 'HealthMonitor — reports HTTP non-2xx as down', sanitizeResources: false, sanitizeOps: false }, async () => {
    let ok = true;
    const server = createHttpServer((_, res) => {
        res.statusCode = ok ? 204 : 500;
        res.end();
    });
    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });
    const target: ForwardTarget = { type: 'forward', host: '127.0.0.1', port };
    let healthy = 0;
    let unhealthy = 0;
    const monitor = new HealthMonitor(
        target,
        { type: 'http', path: '/healthz', intervalSeconds: 0.05, timeoutSeconds: 0.1, maxFailed: 1 },
        () => {
            healthy++;
        },
        () => {
            unhealthy++;
        },
    );

    try {
        monitor.start();
        await waitFor(() => healthy === 1, 'http healthy callback');
        ok = false;
        await waitFor(() => unhealthy === 1, 'http unhealthy callback');
        assertEquals(healthy, 1);
        assertEquals(unhealthy, 1);
    } finally {
        monitor.stop();
        await closeHttp(server);
    }
});

Deno.test({ name: 'HealthMonitor — sends Go-style HTTP health headers', sanitizeResources: false, sanitizeOps: false }, async () => {
    let seenHeader = '';
    const server = createHttpServer((req, res) => {
        seenHeader = String(req.headers['x-health-token'] ?? '');
        res.statusCode = seenHeader === 'secret' ? 204 : 500;
        res.end();
    });
    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });
    const target: ForwardTarget = { type: 'forward', host: '127.0.0.1', port };
    let healthy = 0;
    const monitor = new HealthMonitor(
        target,
        {
            type: 'http',
            intervalSeconds: 0.05,
            timeoutSeconds: 0.1,
            maxFailed: 1,
            httpHeaders: [{ name: 'x-health-token', value: 'secret' }],
        },
        () => {
            healthy++;
        },
        () => {},
    );

    try {
        monitor.start();
        await waitFor(() => healthy === 1, 'http healthy callback with headers');
        assertEquals(seenHeader, 'secret');
    } finally {
        monitor.stop();
        await closeHttp(server);
    }
});
