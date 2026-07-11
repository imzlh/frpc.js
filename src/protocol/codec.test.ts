// src/protocol/codec_test.ts — Tests for MessageBuffer, readMsg, writeMsg

import { assertEquals, assertRejects } from '@std/assert';
import { MessageBuffer, MessageReader, pipeConn, readMsg, readMsgWithTail, writeMsg } from './codec.ts';
import { MsgType } from './message.ts';
import { Socket, createServer, connect } from 'node:net';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:net';
import { EventEmitter } from 'node:events';

Deno.test('MessageBuffer — single complete frame', () => {
    const mb = new MessageBuffer();
    mb.feed(Buffer.concat([Buffer.from([MsgType.Ping]), Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]), Buffer.from('{}')]));
    assertEquals(mb.tryReadMsg(), { type: MsgType.Ping, msg: {} });
    assertEquals(mb.tryReadMsg(), null);
});

Deno.test('MessageBuffer — two frames in one chunk', () => {
    const a = Buffer.concat([Buffer.from([MsgType.Ping]), Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]), Buffer.from('{}')]);
    const b = Buffer.concat([Buffer.from([MsgType.Pong]), Buffer.from([0, 0, 0, 0, 0, 0, 0, 12]), Buffer.from('{"error":""}')]);
    const mb = new MessageBuffer();
    mb.feed(Buffer.concat([a, b]));
    assertEquals(mb.tryReadMsg(), { type: MsgType.Ping, msg: {} });
    assertEquals(mb.tryReadMsg(), { type: MsgType.Pong, msg: { error: '' } });
    assertEquals(mb.tryReadMsg(), null);
});

Deno.test('MessageBuffer — frame split across chunks', () => {
    const frame = Buffer.concat([Buffer.from([MsgType.Ping]), Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]), Buffer.from('{}')]);
    const mb = new MessageBuffer();
    mb.feed(frame.subarray(0, 5));
    assertEquals(mb.tryReadMsg(), null);
    mb.feed(frame.subarray(5));
    assertEquals(mb.tryReadMsg(), { type: MsgType.Ping, msg: {} });
});

Deno.test('writeMsg — uses frp v1 binary length prefix', async () => {
    const { client, server, srv } = await loopback();
    try {
        await writeMsg(client, MsgType.Ping, {});
        const header = await new Promise<Buffer>((resolve) => server.once('data', resolve));
        assertEquals([...header], [MsgType.Ping, 0, 0, 0, 0, 0, 0, 0, 2, 123, 125]);
    } finally {
        client.destroy();
        server.destroy();
        srv.close();
    }
});

async function loopback(opts: { allowHalfOpen?: boolean } = {}): Promise<{ client: Socket; server: Socket; srv: Server }> {
    const srv = createServer({ allowHalfOpen: opts.allowHalfOpen });

    const port = await new Promise<number>((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address() as { port: number };
            resolve(addr.port);
        });
    });

    const serverP = new Promise<Socket>((resolve) => srv.once('connection', resolve));

    const client = connect({ host: '127.0.0.1', port, allowHalfOpen: opts.allowHalfOpen });
    await new Promise<void>((r) => client.once('connect', r));

    const server = await serverP;

    return { client, server, srv };
}

Deno.test({ name: 'writeMsg + readMsg — round-trip over TCP', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    try {
        await writeMsg(client, MsgType.Login, { version: '0.1.0', run_id: 'test' });
        const msg = await readMsg(server);
        assertEquals(msg.type, MsgType.Login);
        assertEquals((msg.msg as Record<string, unknown>).run_id, 'test');
    } finally {
        client.destroy();
        server.destroy();
        srv.close();
    }
});

Deno.test({ name: 'MessageReader — handles sequential messages', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    try {
        const reader = new MessageReader(server);
        await writeMsg(client, MsgType.Ping, { timestamp: 1 });
        await writeMsg(client, MsgType.Pong, { error: '' });
        const msg1 = await reader.readMsg();
        assertEquals(msg1.type, MsgType.Ping);
        const msg2 = await reader.readMsg();
        assertEquals(msg2.type, MsgType.Pong);
        reader.close();
    } finally {
        client.destroy();
        server.destroy();
        srv.close();
    }
});

Deno.test({ name: 'readMsg — rejects on connection close', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    client.destroy();
    await assertRejects(() => readMsg(server), Error);
    server.destroy();
    srv.close();
});

Deno.test({ name: 'readMsgWithTail — returns bytes after one frame', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    try {
        client.write(Buffer.concat([
            Buffer.from([MsgType.StartWorkConn, 0, 0, 0, 0, 0, 0, 0, 2]),
            Buffer.from('{}'),
            Buffer.from('hello-frp\n'),
        ]));

        const msg = await readMsgWithTail(server);
        assertEquals(msg.type, MsgType.StartWorkConn);
        assertEquals(msg.msg, {});
        assertEquals(msg.tail.toString(), 'hello-frp\n');
    } finally {
        client.destroy();
        server.destroy();
        srv.close();
    }
});

Deno.test({ name: 'readMsgWithTail — pause preserves bytes arriving after the frame', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    try {
        client.write(Buffer.concat([
            Buffer.from([MsgType.StartWorkConn, 0, 0, 0, 0, 0, 0, 0, 2]),
            Buffer.from('{}'),
        ]));

        const msg = await readMsgWithTail(server);
        assertEquals(msg.type, MsgType.StartWorkConn);
        assertEquals(msg.msg, {});
        assertEquals(msg.tail.toString(), '');

        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        client.write(Buffer.from('delayed-tail\n'));
        await new Promise<void>((resolve) => setTimeout(resolve, 10));

        const data = await new Promise<Buffer>((resolve) => {
            server.once('data', resolve);
            server.resume();
        });
        assertEquals(data.toString(), 'delayed-tail\n');
    } finally {
        client.destroy();
        server.destroy();
        srv.close();
    }
});

Deno.test({ name: 'pipeConn — does not destroy on readable end', fn: async () => {
    class FakeSocket extends EventEmitter {
        destroyed = false;
        ended = false;
        pipe(dest: FakeSocket): FakeSocket { return dest; }
        end(cb?: () => void): void {
            this.ended = true;
            cb?.();
        }
        destroy(): void {
            this.destroyed = true;
            this.emit('close');
        }
    }

    const left = new FakeSocket();
    const right = new FakeSocket();
    let resolved = false;
    const proxy = pipeConn(left as never, right as never);
    proxy.then(() => {
        resolved = true;
    });

    left.emit('end');
    await Promise.resolve();
    assertEquals(left.destroyed, false);
    assertEquals(right.destroyed, false);

    left.emit('close');
    await proxy;
    assertEquals(resolved, true);
    assertEquals(right.ended, true);
    assertEquals(left.destroyed, false);
    assertEquals(right.destroyed, false);
} });
