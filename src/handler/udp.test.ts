// src/handler/udp_test.ts — UDP work connection compatibility tests

import { assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { connect, createServer, Socket } from 'node:net';
import type { Server } from 'node:net';
import { handleUdp } from './udp.ts';
import { MsgType, readMsg, writeMsg } from '../protocol/index.ts';
import type { StartWorkConnMsg } from '../types.ts';

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

    return { client, server: await serverP, srv };
}

Deno.test({ name: 'handleUdp — reads and writes frp c/l/r wire packets', sanitizeResources: false, sanitizeOps: false }, async () => {
    const { client, server, srv } = await loopback();
    const swc = { proxy_name: 'udp', src_addr: '1.1.1.1', src_port: 1111, dst_addr: '2.2.2.2', dst_port: 2222, error: '' } satisfies StartWorkConnMsg;

    try {
        const task = handleUdp(client, swc, (pkt, addr) => {
            assertEquals(new TextDecoder().decode(pkt.content), 'ping');
            assertEquals(pkt.remote_addr, { hostname: '8.8.8.8', port: 53 });
            assertEquals(addr, { hostname: '8.8.8.8', port: 53, transport: 'udp' });
            return new TextEncoder().encode('pong');
        });

        await writeMsg(server, MsgType.UDPPacket, {
            c: Buffer.from('ping').toString('base64'),
            l: { IP: '127.0.0.1', Port: 7000, Zone: '' },
            r: { IP: '8.8.8.8', Port: 53, Zone: '' },
        });

        const { type, msg } = await readMsg(server);
        assertEquals(type, MsgType.UDPPacket);
        assertEquals(msg, {
            c: Buffer.from('pong').toString('base64'),
            l: null,
            r: { IP: '8.8.8.8', Port: 53, Zone: '' },
        });

        client.destroy();
        server.destroy();
        await task;
    } finally {
        client.destroy();
        server.destroy();
        srv.close();
    }
});
