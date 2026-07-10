// src/control/channel_test.ts - Control channel selection tests

import { assertEquals } from '@std/assert';
import { STCPVisitor, TCP } from '../types.ts';
import { createClientAuth } from '../auth.ts';
import { activeProxyEntries, activeVisitorEntries, buildLoginMsg } from './channel.ts';
import type { IConfig } from '../types.ts';

Deno.test('activeProxyEntries — empty start enables all proxies', () => {
    const cfg = config();

    assertEquals(activeProxyEntries(cfg).map(([name]) => name), ['ssh', 'web']);
});

Deno.test('activeProxyEntries — start selects named proxies only', () => {
    const cfg = config({ start: ['web', 'missing'] });

    assertEquals(activeProxyEntries(cfg).map(([name]) => name), ['web']);
});

Deno.test('activeProxyEntries — disabled proxies are not active', () => {
    const cfg = config({
        proxies: {
            ssh: new TCP({ remotePort: 6000, enabled: false }, TCP.forward({ host: '127.0.0.1', port: 22 })),
            web: new TCP({ remotePort: 6001, enabled: true }, TCP.forward({ host: '127.0.0.1', port: 80 })),
        },
    });

    assertEquals(activeProxyEntries(cfg).map(([name]) => name), ['web']);
});

Deno.test('activeProxyEntries — start cannot enable disabled proxies', () => {
    const cfg = config({
        start: ['ssh', 'web'],
        proxies: {
            ssh: new TCP({ remotePort: 6000, enabled: false }, TCP.forward({ host: '127.0.0.1', port: 22 })),
            web: new TCP({ remotePort: 6001 }, TCP.forward({ host: '127.0.0.1', port: 80 })),
        },
    });

    assertEquals(activeProxyEntries(cfg).map(([name]) => name), ['web']);
});

Deno.test('activeVisitorEntries — empty start enables all visitors', () => {
    const cfg = config({
        visitors: {
            secret: new STCPVisitor({ serverName: 'secret_ssh', secretKey: 'secret', bindPort: 9000 }),
            admin: new STCPVisitor({ serverName: 'admin_ssh', secretKey: 'secret', bindPort: 9001 }),
        },
    });

    assertEquals(activeVisitorEntries(cfg).map(([name]) => name), ['secret', 'admin']);
});

Deno.test('activeVisitorEntries — start selects named visitors only', () => {
    const cfg = config({
        start: ['web', 'secret'],
        visitors: {
            secret: new STCPVisitor({ serverName: 'secret_ssh', secretKey: 'secret', bindPort: 9000 }),
            admin: new STCPVisitor({ serverName: 'admin_ssh', secretKey: 'secret', bindPort: 9001 }),
        },
    });

    assertEquals(activeProxyEntries(cfg).map(([name]) => name), ['web']);
    assertEquals(activeVisitorEntries(cfg).map(([name]) => name), ['secret']);
});

Deno.test('activeVisitorEntries — disabled visitors are not active', () => {
    const cfg = config({
        visitors: {
            secret: new STCPVisitor({ serverName: 'secret_ssh', secretKey: 'secret', bindPort: 9000, enabled: false }),
            admin: new STCPVisitor({ serverName: 'admin_ssh', secretKey: 'secret', bindPort: 9001 }),
        },
    });

    assertEquals(activeVisitorEntries(cfg).map(([name]) => name), ['admin']);
});

Deno.test('buildLoginMsg — includes client_id and common client fields', async () => {
    const cfg = config({
        user: 'alice',
        clientID: 'client-1',
        metadatas: { env: 'test' },
        connection: { pool: { min: 3 } },
    });
    const msg = await buildLoginMsg(cfg, createClientAuth(cfg), 'run-id', 123);

    assertEquals(msg.user, 'alice');
    assertEquals(msg.client_id, 'client-1');
    assertEquals(msg.run_id, 'run-id');
    assertEquals(msg.timestamp, 123);
    assertEquals(msg.pool_count, 3);
    assertEquals(msg.metas, { env: 'test' });
});

Deno.test('buildLoginMsg — uses transport poolCount when connection pool is absent', async () => {
    const cfg = config({ transport: { poolCount: 4 } });
    const msg = await buildLoginMsg(cfg, createClientAuth(cfg), 'run-id', 123);

    assertEquals(msg.pool_count, 4);
});

function config(overrides: Partial<IConfig> = {}): IConfig {
    return {
        server: '127.0.0.1:7000',
        token: 'secret',
        proxies: {
            ssh: new TCP({ remotePort: 6000 }, TCP.forward({ host: '127.0.0.1', port: 22 })),
            web: new TCP({ remotePort: 6001 }, TCP.forward({ host: '127.0.0.1', port: 80 })),
        },
        ...overrides,
    };
}
