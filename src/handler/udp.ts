// src/handler/udp.ts — UDP proxy handler

import { Buffer } from 'node:buffer';
import dgram from 'node:dgram';
import type {
    ForwardTarget,
    NetAddr,
    NetSocket,
    StartWorkConnMsg,
    UdpHandler,
    UDPPacketMsg,
    UdpWireAddr,
    UdpWirePacketMsg,
    ProxyProtocolVersion,
} from '../types.ts';
import { targetProxyProtocolVersion } from '../types.ts';
import { MsgType, MessageReader, writeMsg } from '../protocol/index.ts';
import type { WireProtocol } from '../types.ts';
import { buildProxyProtocolHeader } from './pp2.ts';

function toNetAddr(addr: UdpWireAddr | null | undefined): NetAddr {
    if (!addr) return { hostname: '0.0.0.0', port: 0, transport: 'udp' };
    return { hostname: addr.IP, port: addr.Port, transport: 'udp' };
}

function toPublicAddr(addr: UdpWireAddr | null | undefined): UDPPacketMsg['remote_addr'] {
    if (!addr) return undefined;
    return { hostname: addr.IP, port: addr.Port };
}

function toWireAddr(addr: UDPPacketMsg['remote_addr']): UdpWireAddr | null {
    if (!addr) return null;
    return { IP: addr.hostname, Port: addr.port, Zone: '' };
}

function decodeContent(content: string | undefined): Uint8Array {
    if (!content) return new Uint8Array();
    return new Uint8Array(Buffer.from(content, 'base64'));
}

function encodeContent(content: Uint8Array): string {
    return Buffer.from(content).toString('base64');
}

export async function handleUdp(
    conn: NetSocket,
    _swc: StartWorkConnMsg,
    handler: UdpHandler,
    proxyProtocolVersion?: ProxyProtocolVersion,
    wireProtocol: WireProtocol = 'v1',
): Promise<void> {
    const reader = new MessageReader(conn, wireProtocol);
    let writeChain = Promise.resolve();
    const send = (type: number, msg: unknown) => {
        writeChain = writeChain.then(() => writeMsg(conn, type, msg, wireProtocol));
        return writeChain;
    };
    const heartbeat = setInterval(() => {
        void send(MsgType.Ping, {}).catch(() => {});
    }, 30_000);

    try {
        for (;;) {
            const { type, msg } = await reader.readMsg();
            if (type === MsgType.UDPPacket) {
                const pkt = msg as UdpWirePacketMsg;
                const udpPkt: UDPPacketMsg = {
                    content: decodeContent(pkt.c),
                    local_addr: toPublicAddr(pkt.l),
                    remote_addr: toPublicAddr(pkt.r),
                };
                const remoteAddr = toNetAddr(pkt.r);
                const response = typeof handler === 'function'
                    ? await handler(udpPkt, remoteAddr)
                    : await forwardUdp(udpPkt, remoteAddr, handler, proxyProtocolVersion);
                await send(MsgType.UDPPacket, {
                    c: encodeContent(response),
                    l: null,
                    r: toWireAddr(udpPkt.remote_addr),
                } satisfies UdpWirePacketMsg);
            } else if (type === MsgType.Ping) {
                await send(MsgType.Pong, { error: '' });
            }
        }
    } catch { /* connection closed */ }
    finally {
        reader.close();
        clearInterval(heartbeat);
    }
}

async function forwardUdp(
    pkt: UDPPacketMsg,
    remoteAddr: NetAddr,
    target: ForwardTarget,
    proxyProtocolVersion?: ProxyProtocolVersion,
): Promise<Uint8Array> {
    const socket = dgram.createSocket(target.host.includes(':') ? 'udp6' : 'udp4');
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, () => resolve());
    });

    const version = targetProxyProtocolVersion(target, proxyProtocolVersion);
    const payload = version
        ? concatBytes([
            buildProxyProtocolHeader(
                { hostname: remoteAddr.hostname, port: remoteAddr.port },
                { hostname: target.host, port: target.port },
                version,
                'udp',
            ),
            pkt.content,
        ])
        : pkt.content;

    const response = new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('UDP forward timeout')), 10_000);
        socket.once('message', (message: Buffer) => {
            clearTimeout(timer);
            resolve(new Uint8Array(message));
        });
        socket.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });

    socket.send(Buffer.from(payload), target.port, target.host);
    try {
        return await response;
    } finally {
        socket.close();
    }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
