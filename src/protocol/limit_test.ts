// src/protocol/limit_test.ts - Client bandwidth limiter tests

import { assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { RateLimitedConn, TokenBucket } from './limit.ts';

Deno.test('TokenBucket — reserves burst immediately then queues later bytes', () => {
    const bucket = new TokenBucket(1024, 0);

    assertEquals(bucket.reserve(1024, 0), 0);
    assertEquals(bucket.reserve(512, 0), 500);
    assertEquals(bucket.reserve(512, 0), 1000);
    assertEquals(bucket.reserve(512, 1000), 500);
});

Deno.test({ name: 'RateLimitedConn — preserves socket reads and writes', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const limited = new RateLimitedConn(server, 1024 * 1024);
    try {
        client.write('from-client');
        const inbound = await new Promise<Buffer>((resolve) => limited.once('data', resolve));
        assertEquals(inbound.toString(), 'from-client');

        limited.write(Buffer.from('from-limited'));
        const outbound = await new Promise<Buffer>((resolve) => client.once('data', resolve));
        assertEquals(outbound.toString(), 'from-limited');
    } finally {
        limited.destroy();
        client.destroy();
        server.destroy();
        srv.close();
    }
});

async function loopback(): Promise<{ client: Socket; server: Socket; srv: Server }> {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address() as { port: number };
            resolve(addr.port);
        });
    });

    const serverP = new Promise<Socket>((resolve) => srv.once('connection', resolve));
    const client = connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => client.once('connect', resolve));
    const server = await serverP;
    return { client, server, srv };
}
