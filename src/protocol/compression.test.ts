import { assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { createCompressedConn } from './compression.ts';
import { createEncryptedConn } from './crypto.ts';

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

Deno.test({ name: 'CompressedConn — reads and writes snappy framed data', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const left = createCompressedConn(client as never);
    const right = createCompressedConn(server as never);

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

Deno.test({ name: 'CompressedConn — decodes Go snappy compressed chunks', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const conn = createCompressedConn(server as never);
    const goSnappyFrame = Buffer.from(
        'ff060000734e61507059000e0000f15be11a80010061fe0100fa0100',
        'hex',
    );

    try {
        const data = new Promise<Buffer>((resolve) => conn.once('data', resolve));
        client.write(goSnappyFrame);
        assertEquals((await data).toString(), 'a'.repeat(128));
    } finally {
        conn.destroy();
        client.destroy();
        srv.close();
    }
});

Deno.test({ name: 'CompressedConn — decodes Go snappy repeated literal chunks', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const conn = createCompressedConn(server as never);
    const goSnappyFrame = Buffer.from(
        'ff060000734e61507059001d0000e70969c0274c7365637265742d636f6d707265737369626c652d4a1400',
        'hex',
    );

    try {
        const data = new Promise<Buffer>((resolve) => conn.once('data', resolve));
        client.write(goSnappyFrame);
        assertEquals((await data).toString(), 'secret-compressible-secret-compressible');
    } finally {
        conn.destroy();
        client.destroy();
        srv.close();
    }
});

Deno.test({ name: 'CompressedConn — composes over encrypted work connections', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const leftEncrypted = await createEncryptedConn(client as never, 'test-token');
    const rightEncrypted = await createEncryptedConn(server as never, 'test-token');
    const left = createCompressedConn(leftEncrypted as never);
    const right = createCompressedConn(rightEncrypted as never);

    try {
        const rightData = new Promise<Buffer>((resolve) => right.once('data', resolve));
        left.write(Buffer.from('encrypted-compressed'));

        assertEquals((await rightData).toString(), 'encrypted-compressed');
    } finally {
        left.destroy();
        right.destroy();
        srv.close();
    }
});
