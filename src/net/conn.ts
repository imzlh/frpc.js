// src/net/conn.ts — TCP connect/listen using node:net

import { Socket, connect, createServer, Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { NetAddr, NetSocket } from '../types.ts';
import { startTlsConnect } from './tls.ts';

export { Socket, connect, createServer, Server };
export type { AddressInfo };

export function toNetAddr(addr: AddressInfo): NetAddr {
    return { hostname: addr.address, port: addr.port };
}

export function connectTcp(addr: { hostname: string; port: number }): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: addr.hostname, port: addr.port });
        socket.on('connect', () => resolve(socket));
        socket.on('error', reject);
    });
}

export function connectTo(
    addr: { hostname: string; port: number },
    tls?: boolean,
    tlsOpts?: { ca?: string; servername?: string; rejectUnauthorized?: boolean; customFirstByte?: boolean },
): Promise<NetSocket> {
    if (tls) {
        return startTlsConnect(addr, tlsOpts);
    }
    return connectTcp(addr);
}

export function listenTcp(host: string, port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.off('error', onError);
            resolve(server);
        });
    });
}

export function socketAddr(socket: NetSocket): { local: NetAddr; remote: NetAddr } {
    const local = socket.address() as AddressInfo;
    return {
        local: { hostname: local.address, port: local.port },
        remote: { hostname: (socket as Socket).remoteAddress ?? '0.0.0.0', port: (socket as Socket).remotePort ?? 0 },
    };
}
