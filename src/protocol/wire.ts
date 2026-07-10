// src/protocol/wire.ts - frp V2 wire framing and handshake

import { Buffer } from 'node:buffer';
import type { WireProtocol } from '../types.ts';
import type { MessageSocket } from './codec.ts';
import { MsgType } from './message.ts';

export const V2_MAGIC = Buffer.from('FRP\x00\x02\r\n', 'binary');
export const FRAME_TYPE_CLIENT_HELLO = 1;
export const FRAME_TYPE_SERVER_HELLO = 2;
export const FRAME_TYPE_MESSAGE = 16;
export const MAX_FRAME_PAYLOAD = 64 * 1024;
export const AEAD_ALGORITHM_AES_256_GCM = 'aes-256-gcm';

export type { WireProtocol } from '../types.ts';

export interface WireFrame {
    type: number;
    flags: number;
    payload: Buffer<ArrayBufferLike>;
}

export interface V2BootstrapInfo {
    transport: string;
    tls: boolean;
    tcpMux: boolean;
}

interface V2ServerHello {
    selected?: {
        message?: { codec?: string };
        crypto?: { algorithm?: string; serverRandom?: string };
    };
    error?: string;
}

export interface V2CryptoContext {
    algorithm: typeof AEAD_ALGORITHM_AES_256_GCM;
    transcriptHash: Uint8Array;
}

const v2TypeByMsgType = new Map<number, number>([
    [MsgType.Login, 1],
    [MsgType.LoginResp, 2],
    [MsgType.NewProxy, 3],
    [MsgType.NewProxyResp, 4],
    [MsgType.CloseProxy, 5],
    [MsgType.NewWorkConn, 6],
    [MsgType.ReqWorkConn, 7],
    [MsgType.StartWorkConn, 8],
    [MsgType.NewVisitorConn, 9],
    [MsgType.NewVisitorConnResp, 10],
    [MsgType.Ping, 11],
    [MsgType.Pong, 12],
    [MsgType.UDPPacket, 13],
    [MsgType.NatHoleVisitor, 14],
    [MsgType.NatHoleClient, 15],
    [MsgType.NatHoleResp, 16],
    [MsgType.NatHoleSid, 17],
    [MsgType.NatHoleReport, 18],
]);

const msgTypeByV2Type = new Map([...v2TypeByMsgType].map(([msgType, v2Type]) => [v2Type, msgType]));
export class WireFrameBuffer {
    private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    feed(data: Buffer): void {
        this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    }

    tryReadFrame(): WireFrame | null {
        if (this.buf.length < 8) return null;

        const type = this.buf.readUInt16BE(0);
        const flags = this.buf.readUInt16BE(2);
        const length = this.buf.readUInt32BE(4);
        if (flags !== 0) throw new Error(`Unsupported V2 frame flags: ${flags}`);
        if (length > MAX_FRAME_PAYLOAD) {
            throw new Error(`V2 frame payload exceeds limit: ${length}`);
        }
        if (this.buf.length < 8 + length) return null;

        const payload = this.buf.subarray(8, 8 + length);
        this.buf = this.buf.subarray(8 + length);
        return { type, flags, payload };
    }

    get length(): number { return this.buf.length; }

    drain(): Buffer {
        const out = this.buf;
        this.buf = Buffer.alloc(0);
        return out;
    }
}

export function encodeV2Message(type: number, msg: unknown): Buffer {
    const typeId = v2TypeByMsgType.get(type);
    if (!typeId) throw new Error(`Unknown V2 message type: 0x${type.toString(16)}`);

    const json = Buffer.from(JSON.stringify(msg));
    const payload = Buffer.alloc(2 + json.length);
    payload.writeUInt16BE(typeId, 0);
    payload.set(json, 2);
    return encodeWireFrame(FRAME_TYPE_MESSAGE, payload);
}

export function decodeV2Message(frame: WireFrame): { type: number; msg: unknown } {
    if (frame.type !== FRAME_TYPE_MESSAGE) {
        throw new Error(`Unexpected V2 frame type: ${frame.type}`);
    }
    if (frame.payload.length < 2) throw new Error('V2 message frame payload is too short');

    const typeId = frame.payload.readUInt16BE(0);
    const type = msgTypeByV2Type.get(typeId);
    if (!type) throw new Error(`Unknown V2 message type ID: ${typeId}`);
    const json = frame.payload.subarray(2);
    return { type, msg: json.length === 0 ? {} : JSON.parse(json.toString('utf8')) };
}

export function encodeWireFrame(type: number, payload: Uint8Array, flags = 0): Buffer {
    if (flags !== 0) throw new Error(`Unsupported V2 frame flags: ${flags}`);
    if (payload.length > MAX_FRAME_PAYLOAD) {
        throw new Error(`V2 frame payload exceeds limit: ${payload.length}`);
    }
    const out = Buffer.alloc(8 + payload.length);
    out.writeUInt16BE(type, 0);
    out.writeUInt16BE(flags, 2);
    out.writeUInt32BE(payload.length, 4);
    out.set(payload, 8);
    return out;
}

export function writeWireFrame(socket: MessageSocket, type: number, payload: Uint8Array): Promise<void> {
    return writeRaw(socket, encodeWireFrame(type, payload));
}

export function writeV2Magic(socket: MessageSocket): Promise<void> {
    return writeRaw(socket, V2_MAGIC);
}

export async function beginV2Handshake(
    socket: MessageSocket,
    bootstrap: V2BootstrapInfo,
): Promise<Buffer> {
    const clientRandom = new Uint8Array(32);
    crypto.getRandomValues(clientRandom);
    const hello = {
        bootstrap,
        capabilities: {
            message: { codecs: ['json'] },
            crypto: {
                algorithms: [AEAD_ALGORITHM_AES_256_GCM],
                clientRandom: Buffer.from(clientRandom).toString('base64'),
            },
        },
    };
    const payload = Buffer.from(JSON.stringify(hello));
    await writeV2Magic(socket);
    await writeWireFrame(socket, FRAME_TYPE_CLIENT_HELLO, payload);
    return payload;
}

export async function readV2ServerHello(
    socket: MessageSocket,
    clientHelloPayload: Uint8Array,
): Promise<V2CryptoContext> {
    const frame = await readWireFrame(socket);
    if (frame.type !== FRAME_TYPE_SERVER_HELLO) {
        throw new Error(`Expected V2 ServerHello, got frame type ${frame.type}`);
    }

    let hello: V2ServerHello;
    try {
        hello = JSON.parse(frame.payload.toString('utf8')) as V2ServerHello;
    } catch {
        throw new Error('V2 ServerHello is not valid JSON');
    }
    if (hello.error) throw new Error(`V2 ServerHello rejected: ${hello.error}`);

    const messageCodec = hello.selected?.message?.codec;
    if (messageCodec !== 'json') {
        throw new Error(`Unsupported V2 message codec: ${messageCodec ?? ''}`);
    }
    const algorithm = hello.selected?.crypto?.algorithm;
    if (algorithm !== AEAD_ALGORITHM_AES_256_GCM) {
        throw new Error(`Unsupported V2 AEAD algorithm: ${algorithm ?? ''}`);
    }
    const serverRandom = hello.selected?.crypto?.serverRandom;
    if (typeof serverRandom !== 'string' || Buffer.from(serverRandom, 'base64').length !== 32) {
        throw new Error('Invalid V2 ServerHello crypto random');
    }

    return {
        algorithm,
        transcriptHash: await hashCryptoTranscript(clientHelloPayload, frame.payload),
    };
}

export function readWireFrame(socket: MessageSocket): Promise<WireFrame> {
    return new Promise((resolve, reject) => {
        const buffer = new WireFrameBuffer();
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('close', onClose);
            socket.off('error', onError);
        };
        const done = (frame: WireFrame) => {
            cleanup();
            socket.pause?.();
            const tail = buffer.drain();
            if (tail.length > 0) socket.unshift?.(tail);
            resolve(frame);
        };
        const onData = (data: Buffer) => {
            try {
                buffer.feed(data);
                const frame = buffer.tryReadFrame();
                if (frame) done(frame);
            } catch (err) {
                cleanup();
                reject(err as Error);
            }
        };
        const onEnd = () => { cleanup(); reject(new Error('Connection closed')); };
        const onClose = () => { cleanup(); reject(new Error('Connection closed')); };
        const onError = (err: Error) => { cleanup(); reject(err); };

        socket.on('data', onData);
        socket.on('end', onEnd);
        socket.on('close', onClose);
        socket.on('error', onError);
        socket.resume?.();
    });
}

export async function hashCryptoTranscript(
    clientHelloPayload: Uint8Array,
    serverHelloPayload: Uint8Array,
): Promise<Uint8Array> {
    const bytes = Buffer.concat([
        Buffer.from('frp wire v2 crypto transcript'),
        cryptoTranscriptPart('client hello', clientHelloPayload),
        cryptoTranscriptPart('server hello', serverHelloPayload),
    ]);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function cryptoTranscriptPart(label: string, payload: Uint8Array): Buffer {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
    return Buffer.concat([
        Buffer.from([0]),
        Buffer.from(label),
        Buffer.from([0]),
        length,
        Buffer.from(payload),
    ]);
}

export function isWireProtocol(value: string | undefined): value is WireProtocol {
    return value === 'v1' || value === 'v2';
}

function writeRaw(socket: MessageSocket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(data, (err) => err ? reject(err) : resolve());
    });
}
