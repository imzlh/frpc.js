// src/auth_test.ts - Client auth provider tests

import { assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createClientAuth } from './auth.ts';
import { genPrivKey } from './protocol/index.ts';

Deno.test('createClientAuth — token login always signs with timestamp', async () => {
    const auth = createClientAuth({
        server: '127.0.0.1',
        token: 'secret',
        proxies: {},
    });

    assertEquals(await auth.login(123), {
        privilege_key: await genPrivKey('secret', 123),
        timestamp: 123,
    });
    assertEquals(await auth.ping(), {});
    assertEquals(await auth.newWorkConn('run-id'), { run_id: 'run-id' });
});

Deno.test('createClientAuth — token additional scopes sign ping and work conn', async () => {
    const auth = createClientAuth({
        server: '127.0.0.1',
        token: 'secret',
        auth: { additionalScopes: ['HeartBeats', 'NewWorkConns'] },
        proxies: {},
    });

    const ping = await auth.ping();
    assertEquals(typeof ping.privilege_key, 'string');
    assertEquals(typeof ping.timestamp, 'number');

    const work = await auth.newWorkConn('run-id');
    assertEquals(work.run_id, 'run-id');
    assertEquals(typeof work.privilege_key, 'string');
    assertEquals(typeof work.timestamp, 'number');
});

Deno.test({ name: 'createClientAuth — OIDC client credentials token is cached', sanitizeResources: false, sanitizeOps: false }, async () => {
    const seenBodies: string[] = [];
    const server = createServer(async (req, res) => {
        seenBodies.push(await readBody(req));
        respondJson(res, { access_token: 'oidc-token', expires_in: 3600 });
    });
    const port = await listen(server);

    try {
        const auth = createClientAuth({
            server: '127.0.0.1',
            auth: {
                method: 'oidc',
                additionalScopes: ['HeartBeats', 'NewWorkConns'],
                oidc: {
                    clientID: 'client-id',
                    clientSecret: 'client-secret',
                    audience: 'frps',
                    scope: 'openid profile',
                    tokenEndpointURL: `http://127.0.0.1:${port}/token`,
                    additionalEndpointParams: { resource: 'frp' },
                },
            },
            proxies: {},
        });

        assertEquals(await auth.login(456), { privilege_key: 'oidc-token', timestamp: 456 });
        assertEquals(await auth.ping(), { privilege_key: 'oidc-token' });
        assertEquals(await auth.newWorkConn('run-id'), {
            run_id: 'run-id',
            privilege_key: 'oidc-token',
        });
        assertEquals(seenBodies.length, 1);

        const params = new URLSearchParams(seenBodies[0]);
        assertEquals(params.get('grant_type'), 'client_credentials');
        assertEquals(params.get('client_id'), 'client-id');
        assertEquals(params.get('client_secret'), 'client-secret');
        assertEquals(params.get('audience'), 'frps');
        assertEquals(params.get('scope'), 'openid profile');
        assertEquals(params.get('resource'), 'frp');
    } finally {
        await close(server);
    }
});

function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('error', reject);
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

function respondJson(res: ServerResponse, body: unknown): void {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
}
