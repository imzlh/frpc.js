// src/handler/tcp.ts — TCP & RawHTTP proxy handlers

import { Buffer } from 'node:buffer';
import { targetProxyProtocolVersion, type TcpHandler, type ForwardTarget, type StartWorkConnMsg, type NetAddr, type NetSocket, type ProxyProtocolVersion } from '../types.ts';
import { connectTcp } from '../net/index.ts';
import { writeProxyProtocol } from './pp2.ts';
import { pipeConn } from '../protocol/index.ts';

function toAddr(swc: StartWorkConnMsg): NetAddr {
    return { hostname: swc.src_addr, port: swc.src_port };
}

async function forward(
    socket: NetSocket,
    t: ForwardTarget,
    swc: StartWorkConnMsg,
    initialData?: Uint8Array,
    proxyProtocolVersion?: ProxyProtocolVersion,
): Promise<void> {
    const local = await connectTcp({ hostname: t.host, port: t.port });
    try {
        const version = targetProxyProtocolVersion(t, proxyProtocolVersion);
        if (version) {
            await writeProxyProtocol(local, swc, version);
        }
        if (initialData && initialData.length > 0) {
            await new Promise<void>((resolve, reject) => {
                local.write(initialData, (err) => err ? reject(err) : resolve());
            });
        }
        await pipeConn(socket as any, local);
    } finally {
        try { local.destroy(); } catch { /* ignore */ }
    }
}

export async function handleTcp(
    socket: NetSocket,
    swc: StartWorkConnMsg,
    handler: TcpHandler,
    initialData?: Uint8Array,
    proxyProtocolVersion?: ProxyProtocolVersion,
): Promise<void> {
    if (typeof handler === 'function') {
        if (initialData && initialData.length > 0 && socket.unshift) {
            socket.unshift(Buffer.from(initialData));
        }
        await handler(socket, toAddr(swc));
    } else {
        await forward(socket, handler, swc, initialData, proxyProtocolVersion);
    }
}

export async function handleRawHttp(
    socket: NetSocket,
    swc: StartWorkConnMsg,
    handler: ForwardTarget,
    initialData?: Uint8Array,
    proxyProtocolVersion?: ProxyProtocolVersion,
): Promise<void> {
    await forward(socket, handler, swc, initialData, proxyProtocolVersion);
}
