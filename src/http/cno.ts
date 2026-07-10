/// <reference path="../../types/lib.cno.d.ts" />

// src/http/cno.ts — HTTP parser implementation for CNO (using CNO.llhttp)

import { Buffer } from 'node:buffer';
import type { HttpResponseData, NetAddr, NetSocket } from '../types.ts';
import type { HttpParser, ParsedRequest } from './types.ts';

const STATUS_TEXT: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

export class CnoHttpParser implements HttpParser {
    async *serve(socket: NetSocket, remoteAddr: NetAddr): AsyncGenerator<ParsedRequest> {
        const queue: ParsedRequest[] = [];
        let wake: (() => void) | null = null;
        let done = false;

        const notify = () => {
            const fn = wake;
            wake = null;
            fn?.();
        };

        const parser = CNO.llhttp.createRequestStreamParser(
            (msg: CNO.HttpRequestMessage) => {
                queue.push(this.#toParsedRequest(socket, remoteAddr, msg));
                notify();
            },
            (err: Error) => { socket.destroy(err); },
        );

        socket.on('close', () => { done = true; notify(); });
        socket.on('end', () => { done = true; notify(); });
        socket.on('error', () => { done = true; notify(); });
        socket.on('data', (chunk: Buffer) => {
            parser.feed(chunk);
        });

        while (!done || queue.length > 0) {
            const next = queue.shift();
            if (next) {
                yield next;
                continue;
            }
            await new Promise<void>((resolve) => { wake = resolve; });
        }
    }

    #toParsedRequest(socket: NetSocket, remoteAddr: NetAddr, msg: CNO.HttpRequestMessage): ParsedRequest {
        return {
            type: 'request',
            request: {
                method: msg.method,
                url: this.#absoluteUrl(msg.url, msg.headers, remoteAddr),
                headers: this.#headersToMap(msg.headers),
                body: null,
            },
            respond: async (res: HttpResponseData) => {
                await writeResponse(socket, {
                    status: res.status || 200,
                    statusText: res.statusText,
                    headers: this.#recordToHeaders(res.headers),
                    body: this.#bodyToBytes(res.body),
                });
            },
        };
    }

    #absoluteUrl(url: string, headers: Headers, remoteAddr: NetAddr): string {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
        const host = headers.get('host') ?? remoteAddr.hostname;
        return `http://${host}${url || '/'}`;
    }

    #headersToMap(headers: Headers): Map<string, string> {
        const out = new Map<string, string>();
        headers.forEach((value, key) => out.set(key.toLowerCase(), value));
        return out;
    }

    #recordToHeaders(headers?: Record<string, string>): Map<string, string> | undefined {
        if (!headers) return undefined;
        return new Map(Object.entries(headers));
    }

    #bodyToBytes(body?: Uint8Array | string | null): Uint8Array | null {
        if (body == null) return null;
        return typeof body === 'string' ? new TextEncoder().encode(body) : body;
    }
}

/** Write an HTTP response to a socket */
export async function writeResponse(socket: NetSocket, res: { status: number; statusText?: string; headers?: Map<string, string>; body?: Uint8Array | null }): Promise<void> {
    return new Promise((resolve, reject) => {
        const statusText = res.statusText || STATUS_TEXT[res.status] || 'Unknown';
        let head = `HTTP/1.1 ${res.status} ${statusText}\r\n`;
        if (res.headers) {
            res.headers.forEach((v, k) => { head += `${k}: ${v}\r\n`; });
        }
        if (res.body && !res.headers?.has('content-length')) {
            head += `content-length: ${res.body.length}\r\n`;
        }
        head += 'connection: keep-alive\r\n\r\n';

        const headBuf = Buffer.from(head, 'utf-8');
        if (res.body && res.body.length > 0) {
            const full = Buffer.concat([headBuf, Buffer.from(res.body)]);
            socket.write(full, (err) => { if (err) reject(err); else resolve(); });
        } else {
            socket.write(headBuf, (err) => { if (err) reject(err); else resolve(); });
        }
    });
}
