// src/control/pool_test.ts - Work connection pool tests

import { assertEquals } from '@std/assert';
import { createServer, type Server, type Socket } from 'node:net';
import { WorkConnPool } from './pool.ts';
import { MsgType, readMsg, writeMsg } from '../protocol/index.ts';
import { TCP, type NetAddr, type NetSocket } from '../types.ts';
import type { Logger } from '../log.ts';
import { createClientAuth } from '../auth.ts';
import type { NewWorkConnMsg, StartWorkConnMsg } from '../protocol/index.ts';

function close(server: Server): Promise<void> {
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

function captureLogger(errors: string[]): Logger {
    return {
        debug() {},
        info() {},
        warn() {},
        error(message) { errors.push(message); },
    };
}

Deno.test({ name: 'WorkConnPool — reports server rejection without a fake proxy name', sanitizeResources: false, sanitizeOps: false }, async () => {
    const errors: string[] = [];
    let accepted: Socket | undefined;
    const server = createServer(async (socket) => {
        accepted = socket;
        await readMsg(socket);
        await writeMsg(socket, MsgType.StartWorkConn, {
            proxy_name: '',
            src_addr: '',
            src_port: 0,
            dst_addr: '',
            dst_port: 0,
            error: 'connect to server failed: EOF1!',
        } satisfies StartWorkConnMsg);
    });
    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    const pool = new WorkConnPool({
        serverAddr: { hostname: '127.0.0.1', port },
        useTls: false,
        runId: 'run-id',
        auth: createClientAuth({ server: '127.0.0.1', token: 'test-token', proxies: {} }),
        proxies: new Map(),
        max: 1,
        logger: captureLogger(errors),
    });

    try {
        pool.expand();
        await waitFor(() => errors.length === 1, 'server rejection log');
        assertEquals(errors, ['Work connection rejected by server: connect to server failed: EOF1!']);
        assertEquals(pool.stats().requested, 1);
        assertEquals(pool.stats().rejected, 1);
        assertEquals(pool.stats().accepted, 0);
    } finally {
        pool.stop();
        accepted?.destroy();
        await close(server);
    }
});

Deno.test({ name: 'WorkConnPool — emits connect and disconnect hooks around work dispatch', sanitizeResources: false, sanitizeOps: false }, async () => {
    const proxyName = 'tcp_echo';
    const events: Array<{ type: string; name: string; addr: NetAddr }> = [];
    let accepted: Socket | undefined;

    const server = createServer(async (socket) => {
        accepted = socket;
        const { type, msg } = await readMsg(socket);
        assertEquals(type, MsgType.NewWorkConn);
        assertEquals(typeof (msg as NewWorkConnMsg).privilege_key, 'string');

        await writeMsg(socket, MsgType.StartWorkConn, {
            proxy_name: proxyName,
            src_addr: '203.0.113.9',
            src_port: 54321,
            dst_addr: '127.0.0.1',
            dst_port: 6000,
            error: '',
        } satisfies StartWorkConnMsg);
    });

    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });

    const pool = new WorkConnPool({
        serverAddr: { hostname: '127.0.0.1', port },
        useTls: false,
        runId: 'run-id',
        auth: createClientAuth({
            server: '127.0.0.1',
            token: 'test-token',
            auth: { additionalScopes: ['NewWorkConns'] },
            proxies: {},
        }),
        proxies: new Map([
            [proxyName, new TCP({ remotePort: 6000 }, (socket) => {
                socket.end();
            })],
        ]),
        max: 1,
        hooks: {
            onConnect(name, addr) {
                events.push({ type: 'connect', name, addr });
            },
            onDisconnect(name, addr) {
                events.push({ type: 'disconnect', name, addr });
            },
        },
    });

    try {
        pool.expand();
        await waitFor(() => events.length === 2, 'connect/disconnect hooks');
        assertEquals(events, [
            { type: 'connect', name: proxyName, addr: { hostname: '203.0.113.9', port: 54321 } },
            { type: 'disconnect', name: proxyName, addr: { hostname: '203.0.113.9', port: 54321 } },
        ]);
        assertEquals(pool.stats().accepted, 1);
        assertEquals(pool.stats().completed, 1);
        assertEquals(pool.stats().failed, 0);
    } finally {
        pool.stop();
        accepted?.destroy();
        await close(server);
    }
});

Deno.test('WorkConnPool — closes a connection that finishes opening after stop', async () => {
    let resolveConnection!: (socket: NetSocket) => void;
    const connection = new Promise<NetSocket>((resolve) => {
        resolveConnection = resolve;
    });
    let writes = 0;
    let destroyed = false;
    const socket = {
        write(_data: Uint8Array, callback?: (error?: Error | null) => void) {
            writes++;
            callback?.();
            return true;
        },
        destroy() {
            destroyed = true;
        },
        on() { return this; },
        off() { return this; },
    } as unknown as NetSocket;
    const pool = new WorkConnPool({
        openConnection: () => connection,
        serverAddr: { hostname: '127.0.0.1', port: 7000 },
        useTls: false,
        runId: 'old-run-id',
        auth: createClientAuth({ server: '127.0.0.1', token: 'test-token', proxies: {} }),
        proxies: new Map(),
        max: 1,
    });

    pool.expand();
    pool.stop();
    resolveConnection(socket);
    await waitFor(() => destroyed, 'late connection cleanup');

    assertEquals(writes, 0);
});
