import { assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { CfbStream, createEncryptedConn, deriveFrpCryptoKey } from './crypto.ts';

Deno.test('frp control crypto matches Go AES-128-CFB vector', async () => {
    const key = await deriveFrpCryptoKey('test-token');
    const iv = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const stream = new CfbStream(key, iv, 'encrypt');
    const out = await stream.process(new TextEncoder().encode('frp-control-frame'));

    assertEquals(Buffer.from(out).toString('hex'), '1efa31a88a8666fff4d075da5c327bc0bb');
});

async function loopback(): Promise<{ client: Socket; server: Socket; srv: Server }> {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
            resolve((srv.address() as { port: number }).port);
        });
    });
    const serverP = new Promise<Socket>((resolve) => srv.once('connection', resolve));
    const client = connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => client.once('connect', resolve));
    return { client, server: await serverP, srv };
}

Deno.test({ name: 'EncryptedConn — decrypts work-connection traffic both ways', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const left = await createEncryptedConn(client as never, 'test-token');
    const right = await createEncryptedConn(server as never, 'test-token');

    try {
        const leftData = new Promise<Buffer>((resolve) => left.once('data', resolve));
        const rightData = new Promise<Buffer>((resolve) => right.once('data', resolve));
        left.write(Buffer.from('left-to-right'));
        right.write(Buffer.from('right-to-left'));

        assertEquals((await rightData).toString(), 'left-to-right');
        assertEquals((await leftData).toString(), 'right-to-left');
    } finally {
        left.destroy();
        right.destroy();
        srv.close();
    }
});

Deno.test({ name: 'EncryptedConn — decrypts initial data captured before wrapping', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const left = await createEncryptedConn(client as never, 'test-token');

    try {
        const initialData = new Promise<Buffer>((resolve) => {
            server.once('data', (chunk) => {
                server.pause();
                resolve(Buffer.from(chunk));
            });
            server.resume();
        });
        left.write(Buffer.from('early-encrypted'));
        const right = await createEncryptedConn(server as never, 'test-token', await initialData);
        try {
            const rightData = new Promise<Buffer>((resolve) => right.once('data', resolve));
            assertEquals((await rightData).toString(), 'early-encrypted');
        } finally {
            right.destroy();
        }
    } finally {
        left.destroy();
        srv.close();
    }
});
