// src/handler/http.ts — HTTP/HTTPS proxy handler

import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';
import type { HttpOptions, HttpHandler, HttpRequest, StartWorkConnMsg, NetAddr, NetSocket } from '../types.ts';
import { startTlsServer } from '../net/index.ts';
import { serveHttp } from '../http/parser.ts';

export async function handleHttp(
    socket: NetSocket, swc: StartWorkConnMsg, opts: HttpOptions, handler: HttpHandler, initialData?: Uint8Array,
): Promise<void> {
    let s: NetSocket = socket;

    if (opts.secure) {
        if (!opts.certFile || !opts.keyFile) {
            throw new Error(`HTTP proxy "${swc.proxy_name}": secure=true requires certFile + keyFile`);
        }
        if (initialData && initialData.length > 0 && socket.unshift) {
            socket.unshift(Buffer.from(initialData));
            initialData = undefined;
        }
        s = await startTlsServer(socket as Socket, { cert: opts.certFile, key: opts.keyFile });
    }

    const remoteAddr: NetAddr = { hostname: swc.src_addr, port: swc.src_port };

    for await (const { method, url, headers, body, respond } of serveHttp(s, remoteAddr, initialData)) {
        const req: HttpRequest = {
            method,
            url,
            headers,
            body,
        };

        const responseData = await Promise.resolve(handler(req, remoteAddr)).catch((e: unknown) => {
            console.error(`[frpc] HTTP handler error (${swc.proxy_name}):`, e);
            return { status: 500, statusText: 'Internal Server Error', headers: {}, body: null };
        });

        const resHeaders = new Map<string, string>();
        if (responseData.headers) {
            for (const [k, v] of Object.entries(responseData.headers)) {
                resHeaders.set(k, v);
            }
        }

        await respond({
            status: responseData.status || 200,
            statusText: responseData.statusText,
            headers: resHeaders,
            body: responseData.body ? new Uint8Array(Buffer.from(responseData.body)) : null,
        });
    }
}
