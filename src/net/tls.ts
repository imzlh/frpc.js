// src/net/tls.ts — TLS server/client using node:tls

import { TLSSocket, connect as tlsConnect, createServer as createTlsServer } from 'node:tls';
import { Socket } from 'node:net';
import { readFileSync } from 'node:fs';

export { TLSSocket, tlsConnect, createTlsServer };
export type { TlsOptions as TlsServerOpts } from 'node:tls';

/** Wrap a raw TCP socket as a TLS server connection (for HTTPS termination) */
export async function startTlsServer(socket: Socket, opts: { cert: string; key: string }): Promise<TLSSocket> {
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
export async function startTlsConnect(
    addr: { hostname: string; port: number },
    opts?: { ca?: string; servername?: string; rejectUnauthorized?: boolean },
): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
        const tlsSocket = tlsConnect({
            host: addr.hostname,
            port: addr.port,
            ca: opts?.ca,
            servername: opts?.servername,
            rejectUnauthorized: opts?.rejectUnauthorized,
        });
        tlsSocket.on('secureConnect', () => resolve(tlsSocket));
        tlsSocket.on('error', reject);
    });
}
