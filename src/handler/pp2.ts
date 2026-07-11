// src/handler/pp2.ts — ProxyProtocol header injection

import type { StartWorkConnMsg, NetSocket, ProxyProtocolVersion } from '../types.ts';
import { writeFull } from '../codec.ts';

const SIG = new Uint8Array(
    [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]
);

export type { ProxyProtocolVersion } from '../types.ts';
export type ProxyProtocolTransport = 'tcp' | 'udp';
export interface ProxyProtocolAddr {
    hostname: string;
    port: number;
}

export async function writeProxyProtocol(
    conn: NetSocket,
    swc: StartWorkConnMsg,
    version: ProxyProtocolVersion,
): Promise<void> {
    await writeFull(conn, buildProxyProtocolHeader(
        { hostname: swc.src_addr, port: swc.src_port },
        { hostname: swc.dst_addr || '127.0.0.1', port: swc.dst_port || 0 },
        version,
    ));
}

export async function writeProxyProtocolV1(conn: NetSocket, swc: StartWorkConnMsg): Promise<void> {
    await writeFull(conn, buildProxyProtocolHeader(
        { hostname: swc.src_addr, port: swc.src_port },
        { hostname: swc.dst_addr || '127.0.0.1', port: swc.dst_port || 0 },
        'v1',
    ));
}

export async function writeProxyProtocolV2(conn: NetSocket, swc: StartWorkConnMsg): Promise<void> {
    await writeFull(conn, buildProxyProtocolHeader(
        { hostname: swc.src_addr, port: swc.src_port },
        { hostname: swc.dst_addr || '127.0.0.1', port: swc.dst_port || 0 },
        'v2',
    ));
}

export function buildProxyProtocolHeader(
    src: ProxyProtocolAddr,
    dst: ProxyProtocolAddr,
    version: ProxyProtocolVersion,
    transport: ProxyProtocolTransport = 'tcp',
): Uint8Array {
    if (version === 'v1') return buildProxyProtocolV1(src, dst, transport);
    return buildProxyProtocolV2(src, dst, transport);
}

function buildProxyProtocolV1(
    src: ProxyProtocolAddr,
    dst: ProxyProtocolAddr,
    transport: ProxyProtocolTransport,
): Uint8Array {
    if (transport === 'udp') return new TextEncoder().encode('PROXY UNKNOWN\r\n');
    const family = src.hostname.includes(':') || dst.hostname.includes(':') ? 'TCP6' : 'TCP4';
    return new TextEncoder().encode(
        `PROXY ${family} ${src.hostname} ${dst.hostname} ${src.port} ${dst.port}\r\n`,
    );
}

function buildProxyProtocolV2(
    src: ProxyProtocolAddr,
    dst: ProxyProtocolAddr,
    transport: ProxyProtocolTransport,
): Uint8Array {
    const srcIp = parseIp(src.hostname);
    const dstIp = parseIp(dst.hostname);
    const isV6 = srcIp.length === 16 || dstIp.length === 16;
    const addrLen = isV6 ? 36 : 12;

    const hdr = new Uint8Array(4);
    hdr[0] = 0x21;
    hdr[1] = isV6
        ? transport === 'udp' ? 0x22 : 0x21
        : transport === 'udp' ? 0x12 : 0x11;
    new DataView(hdr.buffer).setUint16(2, addrLen);

    const addrs = new Uint8Array(addrLen);
    const view = new DataView(addrs.buffer);
    if (isV6) {
        addrs.set(toIPv6(srcIp), 0);
        addrs.set(toIPv6(dstIp), 16);
        view.setUint16(32, src.port);
        view.setUint16(34, dst.port);
    } else {
        addrs.set(srcIp, 0);
        addrs.set(dstIp, 4);
        view.setUint16(8, src.port);
        view.setUint16(10, dst.port);
    }

    const frame = new Uint8Array(SIG.length + 4 + addrLen);
    frame.set(SIG);
    frame.set(hdr, SIG.length);
    frame.set(addrs, SIG.length + 4);
    return frame;
}

function parseIp(hostname: string): Uint8Array {
    return hostname.includes(':') ? parseIPv6(hostname) : parseIPv4(hostname);
}

function parseIPv4(hostname: string): Uint8Array {
    const parts = hostname.split('.');
    if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${hostname}`);
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        const n = Number(parts[i]);
        if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`Invalid IPv4 address: ${hostname}`);
        out[i] = n;
    }
    return out;
}

function parseIPv6(hostname: string): Uint8Array {
    const [head, tail = ''] = hostname.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    const parts = [
        ...headParts,
        ...Array(Math.max(missing, 0)).fill('0'),
        ...tailParts,
    ];
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    parts.forEach((part, i) => view.setUint16(i * 2, parseInt(part || '0', 16)));
    return out;
}

function toIPv6(ip: Uint8Array): Uint8Array {
    if (ip.length === 16) return ip;
    const out = new Uint8Array(16);
    out.set([0xff, 0xff], 10);
    out.set(ip, 12);
    return out;
}
