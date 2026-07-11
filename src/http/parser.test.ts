import { assertEquals, assertStringIncludes } from '@std/assert';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { serveHttp } from './parser.ts';

Deno.test({ name: 'serveHttp — honors Connection: close', sanitizeResources: false, sanitizeOps: false }, async () => {
    const server = createServer((socket: Socket) => {
        void (async () => {
            for await (const req of serveHttp(socket, { hostname: '127.0.0.1', port: 0 })) {
                await req.respond({
                    status: 200,
                    headers: new Map([['content-type', 'text/plain']]),
                    body: new TextEncoder().encode('ok'),
                });
                break;
            }
        })();
    });
    const port = await listen(server);
    const client = connect({ host: '127.0.0.1', port });
    await once(client, 'connect');

    client.write([
        'GET / HTTP/1.1',
        'Host: close.test',
        'Connection: close',
        '',
        '',
    ].join('\r\n'));

    const response = await readAll(client);
    assertStringIncludes(response.toLowerCase(), 'connection: close');
    assertStringIncludes(response, 'ok');
    server.close();
});

Deno.test({ name: 'serveHttp — decodes chunked request bodies and keeps pipelined data', sanitizeResources: false, sanitizeOps: false }, async () => {
    const seen: string[] = [];
    const server = createServer((socket: Socket) => {
        void (async () => {
            for await (const req of serveHttp(socket, { hostname: '127.0.0.1', port: 0 })) {
                seen.push(`${new URL(req.url).pathname}:${new TextDecoder().decode(req.body ?? new Uint8Array())}`);
                await req.respond({
                    status: 200,
                    headers: new Map([['content-type', 'text/plain']]),
                    body: new TextEncoder().encode(`ok-${seen.length}`),
                });
                if (seen.length === 2) break;
            }
        })();
    });
    const port = await listen(server);
    const client = connect({ host: '127.0.0.1', port });
    await once(client, 'connect');

    client.write([
        'POST /chunked HTTP/1.1',
        'Host: chunked.test',
        'Transfer-Encoding: chunked',
        '',
        '5',
        'hello',
        '6',
        ' world',
        '0',
        '',
        'GET /next HTTP/1.1',
        'Host: chunked.test',
        'Connection: close',
        '',
        '',
    ].join('\r\n'));

    const response = await readAll(client);
    assertEquals(seen, ['/chunked:hello world', '/next:']);
    assertStringIncludes(response, 'ok-1');
    assertStringIncludes(response, 'ok-2');
    server.close();
});

function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });
}

function once(socket: Socket, event: 'connect'): Promise<void> {
    return new Promise((resolve) => socket.once(event, resolve));
}

function readAll(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
    });
}
