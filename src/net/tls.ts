// src/net/tls.ts — TLS server/client using node:tls

import { TLSSocket, connect as tlsConnect, createServer as createTlsServer } from 'node:tls';
import { Socket, connect as connectTcp, isIP } from 'node:net';
import { readFileSync } from 'node:fs';

// frps consumes this byte before the TLS ClientHello (FRPTLSHeadByte in frp).
const FRP_TLS_HEAD_BYTE = Buffer.from([0x17]);

export { TLSSocket, tlsConnect, createTlsServer };
export type { TlsOptions as TlsServerOpts } from 'node:tls';

/** Wrap a raw TCP socket as a TLS server connection (for HTTPS termination) */
export function startTlsServer(socket: Socket, opts: { cert: string; key: string }): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
        const tlsOptions = {
            isServer: true,
            key: readFileSync(opts.key, 'utf8'),
            cert: readFileSync(opts.cert, 'utf8'),
            start: true,
        };
        const tlsSocket = new TLSSocket(socket, tlsOptions);
        const onSecure = () => resolve(tlsSocket);
        tlsSocket.once('secure', onSecure);
        tlsSocket.once('secureConnect', onSecure);
        tlsSocket.on('error', reject);
    });
}

/** Connect to a remote TLS server */
export function startTlsConnect(
    addr: { hostname: string; port: number },
    opts?: { ca?: string; servername?: string; rejectUnauthorized?: boolean; customFirstByte?: boolean },
): Promise<TLSSocket> {
    const servername = opts?.servername && isIP(opts.servername) === 0
        ? opts.servername
        : undefined;
    if (!opts?.customFirstByte) {
        return new Promise((resolve, reject) => {
            const tlsSocket = tlsConnect({
                host: addr.hostname,
                port: addr.port,
                ca: opts?.ca,
                servername,
                rejectUnauthorized: opts?.rejectUnauthorized,
            });
            tlsSocket.once('secureConnect', () => resolve(tlsSocket));
            tlsSocket.once('error', reject);
        });
    }

    return new Promise((resolve, reject) => {
        const rawSocket = connectTcp({ host: addr.hostname, port: addr.port });
        const fail = (err: Error) => {
            rawSocket.destroy();
            reject(err);
        };
        rawSocket.once('error', fail);
        rawSocket.once('connect', () => {
            rawSocket.write(FRP_TLS_HEAD_BYTE, (err) => {
                if (err) return fail(err);
                rawSocket.removeListener('error', fail);
                const tlsSocket = tlsConnect({
                    socket: rawSocket,
                    ca: opts?.ca,
                    servername,
                    rejectUnauthorized: opts?.rejectUnauthorized,
                });
                tlsSocket.once('secureConnect', () => resolve(tlsSocket));
                tlsSocket.once('error', reject);
            });
        });
    });
}
