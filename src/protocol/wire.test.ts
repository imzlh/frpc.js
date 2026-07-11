import { assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { MessageBuffer, MessageReader, writeMsg } from './codec.ts';
import { createAeadCryptoConn } from './crypto.ts';
import { MsgType } from './message.ts';
import { FRAME_TYPE_MESSAGE, WireFrameBuffer, encodeV2Message } from './wire.ts';

Deno.test('V2 message codec - frames message IDs and decodes fragmented payloads', () => {
    const encoded = encodeV2Message(MsgType.NewWorkConn, { run_id: 'run-1' });
    const frames = new WireFrameBuffer();
    frames.feed(encoded.subarray(0, 6));
    assertEquals(frames.tryReadFrame(), null);
    frames.feed(encoded.subarray(6));
    const frame = frames.tryReadFrame();
    assertEquals(frame?.type, FRAME_TYPE_MESSAGE);
    assertEquals(frame?.payload.readUInt16BE(0), 6);

    const messages = new MessageBuffer('v2');
    messages.feed(encoded.subarray(0, 9));
    assertEquals(messages.tryReadMsg(), null);
    messages.feed(encoded.subarray(9));
    assertEquals(messages.tryReadMsg(), {
        type: MsgType.NewWorkConn,
        msg: { run_id: 'run-1' },
    });
});

Deno.test('V2 AEAD control stream - authenticates V2 messages in both directions', async () => {
    const rawClient = new LinkedSocket();
    const rawServer = new LinkedSocket();
    rawClient.peer = rawServer;
    rawServer.peer = rawClient;
    const transcript = new Uint8Array(32).fill(0x5a);
    const client = await createAeadCryptoConn(rawClient as never, 'test-token', transcript, 'client');
    const server = await createAeadCryptoConn(rawServer as never, 'test-token', transcript, 'server');
    const serverReader = new MessageReader(server, 'v2');
    const clientReader = new MessageReader(client, 'v2');

    try {
        const incoming = serverReader.readMsg();
        await writeMsg(client, MsgType.Ping, { timestamp: 123 }, 'v2');
        assertEquals(await incoming, { type: MsgType.Ping, msg: { timestamp: 123 } });

        const nextIncoming = serverReader.readMsg();
        await writeMsg(client, MsgType.Ping, { timestamp: 456 }, 'v2');
        assertEquals(await nextIncoming, { type: MsgType.Ping, msg: { timestamp: 456 } });

        const response = clientReader.readMsg();
        await writeMsg(server, MsgType.Pong, { error: '' }, 'v2');
        assertEquals(await response, { type: MsgType.Pong, msg: { error: '' } });
    } finally {
        serverReader.close();
        clientReader.close();
        client.destroy();
        server.destroy();
    }
});

class LinkedSocket extends EventEmitter {
    peer!: LinkedSocket;

    write(data: Uint8Array | Buffer, cb?: (err?: Error | null) => void): boolean {
        const copy = Buffer.from(data);
        queueMicrotask(() => {
            this.peer.emit('data', copy);
            cb?.();
        });
        return true;
    }

    destroy(error?: Error): void {
        this.emit('close');
        if (error) this.emit('error', error);
    }

    pause(): this { return this; }
    resume(): this { return this; }
    unshift(_data: Buffer): this { return this; }
}
