// src/http/types.ts — HTTP parser abstraction interface

import type { NetSocket, NetAddr, HttpResponseData } from '../types.ts';
import type { HttpRequest } from '../types.ts';

export type { HttpRequest };

export type ParsedRequest = {
    type: 'request';
    request: HttpRequest;
    respond: (res: HttpResponseData) => Promise<void>;
} | {
    type: 'connect';
    socket: NetSocket;
};

export interface HttpParser {
    serve(socket: NetSocket, remoteAddr: NetAddr): AsyncGenerator<ParsedRequest>;
}
