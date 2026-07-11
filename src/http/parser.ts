// src/http/parser.ts — Simple HTTP/1.x request parser
// Works on both Deno and CNO (no dependency on llhttp or node:http internals)

import { Buffer } from "node:buffer";
import type { NetAddr, NetSocket } from "../types.ts";

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export interface ServedRequest {
  method: string;
  url: string;
  headers: Map<string, string>;
  body: Uint8Array | null;
  respond(res: HttpResponse): Promise<void>;
}

export interface HttpResponse {
  status: number;
  statusText?: string;
  headers?: Map<string, string>;
  body?: Uint8Array | null;
}

/**
 * Read HTTP requests from a socket.
 * Parses request line + headers, then reads body if content-length is present.
 */
export async function* serveHttp(
  socket: NetSocket,
  remoteAddr: NetAddr,
  initialData?: Uint8Array,
): AsyncGenerator<ServedRequest> {
  const reader = new SocketReader(socket, initialData);
  while (!socket.destroyed) {
    const req = await readOneRequest(reader, remoteAddr);
    if (!req) break;

    yield {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      respond: (res: HttpResponse) => writeResponse(socket, res, { close: req.closeAfterResponse }),
    };
  }
}

interface RawRequest {
  method: string;
  url: string;
  headers: Map<string, string>;
  body: Uint8Array | null;
  closeAfterResponse: boolean;
}

async function readOneRequest(
  reader: SocketReader,
  remoteAddr?: NetAddr,
): Promise<RawRequest | null> {
  let headerBuf = Buffer.alloc(0);
  let headerDone = false;

  // Read headers
  while (!headerDone) {
    const chunk = await reader.read();
    if (!chunk) return null;

    headerBuf = Buffer.concat([headerBuf, chunk]);
    const headerStr = headerBuf.toString("utf-8");
    const headerEnd = headerStr.indexOf("\r\n\r\n");

    if (headerEnd !== -1) {
      headerDone = true;
      const headerPart = headerStr.substring(0, headerEnd);
      const lines = headerPart.split("\r\n");

      // Parse request line
      const [method, url, version = "HTTP/1.1"] = (lines[0] ?? "GET / HTTP/1.1").split(" ");
      const headers = new Map<string, string>();
      let contentLength = 0;
      let transferEncoding = "";

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.substring(0, colonIdx).trim().toLowerCase();
        const value = line.substring(colonIdx + 1).trim();
        headers.set(key, value);
        if (key === "content-length") contentLength = parseInt(value, 10) || 0;
        if (key === "transfer-encoding") transferEncoding = value.toLowerCase();
      }

      // Check for body already in buffer
      const bodyStart = headerEnd + 4;
      const alreadyRead = headerBuf.length - bodyStart;
      let body: Uint8Array | null = null;

      if (isChunkedTransfer(transferEncoding)) {
        let pending = alreadyRead > 0 ? headerBuf.subarray(bodyStart) : Buffer.alloc(0);
        let decoded = parseChunkedBody(pending);
        while (!decoded) {
          const chunk = await reader.read();
          if (!chunk) break;
          pending = Buffer.concat([pending, chunk]);
          decoded = parseChunkedBody(pending);
        }
        if (decoded) {
          body = new Uint8Array(decoded.body);
          if (decoded.rest.length > 0) reader.unshift(decoded.rest);
        } else {
          body = new Uint8Array();
        }
      } else if (contentLength > 0) {
        const chunks: Buffer[] = [];
        let received = 0;

        if (alreadyRead > 0) {
          const bodyEnd = Math.min(bodyStart + contentLength, headerBuf.length);
          chunks.push(headerBuf.subarray(bodyStart, bodyEnd));
          received += chunks[chunks.length - 1].length;
          if (bodyEnd < headerBuf.length) {
            reader.unshift(headerBuf.subarray(bodyEnd));
          }
        }

        while (received < contentLength) {
          const chunk = await reader.read();
          if (!chunk) break;
          const need = contentLength - received;
          chunks.push(chunk.subarray(0, Math.min(chunk.length, need)));
          received += chunks[chunks.length - 1].length;
          if (chunk.length > need) {
            reader.unshift(chunk.subarray(need));
          }
        }

        body = new Uint8Array(Buffer.concat(chunks));
      }

      const hostname = remoteAddr?.hostname ?? "localhost";
      const host = headers.get("host") ?? hostname;

      return {
        method: method ?? "GET",
        url: `http://${host}${url ?? "/"}`,
        headers,
        body,
        closeAfterResponse: shouldCloseAfterResponse(version, headers),
      };
    }
  }

  return null;
}

function isChunkedTransfer(value: string): boolean {
  return value.split(",").map((v) => v.trim()).includes("chunked");
}

function parseChunkedBody(data: Buffer): { body: Buffer; rest: Buffer } | null {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = data.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const sizeText = data.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0]!.trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error(`Invalid chunk size: ${sizeText}`);
    offset = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = findTrailerEnd(data, offset);
      if (trailerEnd === -1) return null;
      return {
        body: Buffer.concat(chunks),
        rest: data.subarray(trailerEnd),
      };
    }
    if (data.byteLength < offset + size + 2) return null;
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
    if (data[offset] !== 0x0d || data[offset + 1] !== 0x0a) {
      throw new Error("Invalid chunk terminator");
    }
    offset += 2;
  }
}

function findTrailerEnd(data: Buffer, offset: number): number {
  if (data.byteLength >= offset + 2 && data[offset] === 0x0d && data[offset + 1] === 0x0a) {
    return offset + 2;
  }
  const trailerEnd = data.indexOf("\r\n\r\n", offset);
  return trailerEnd === -1 ? -1 : trailerEnd + 4;
}

function shouldCloseAfterResponse(version: string, headers: Map<string, string>): boolean {
  const connection = headers.get("connection")?.toLowerCase().split(",").map((v) => v.trim()) ?? [];
  if (connection.includes("close")) return true;
  if (version.toUpperCase() === "HTTP/1.0" && !connection.includes("keep-alive")) return true;
  return false;
}

class SocketReader {
  private pending = Buffer.alloc(0);

  constructor(private socket: NetSocket, initialData?: Uint8Array) {
    if (initialData && initialData.length > 0) {
      this.pending = Buffer.from(initialData);
    }
  }

  unshift(data: Uint8Array): void {
    if (data.length === 0) return;
    this.pending = Buffer.concat([Buffer.from(data), this.pending]);
  }

  read(): Promise<Buffer | null> {
    if (this.pending.length > 0) {
      const out = this.pending;
      this.pending = Buffer.alloc(0);
      return Promise.resolve(out);
    }

    return new Promise((resolve, reject) => {
      const onData = (data: Buffer) => {
        this.socket.pause?.();
        cleanup();
        resolve(data);
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("end", onEnd);
        this.socket.off("close", onEnd);
        this.socket.off("error", onError);
      };
      this.socket.on("data", onData);
      this.socket.on("end", onEnd);
      this.socket.on("close", onEnd);
      this.socket.on("error", onError);
      this.socket.resume?.();
    });
  }
}

export function writeResponse(
  socket: NetSocket,
  res: HttpResponse,
  opts: { close?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const statusText = res.statusText || STATUS_TEXT[res.status] || "Unknown";
    let head = `HTTP/1.1 ${res.status} ${statusText}\r\n`;
    if (res.headers) {
      res.headers.forEach((v, k) => {
        head += `${k}: ${v}\r\n`;
      });
    }
    if (res.body && !res.headers?.has("content-length")) {
      head += `content-length: ${res.body.length}\r\n`;
    }
    head += `connection: ${opts.close ? "close" : "keep-alive"}\r\n\r\n`;

    const headBuf = Buffer.from(head, "utf-8");
    const payload = res.body && res.body.length > 0
      ? Buffer.concat([headBuf, Buffer.from(res.body)])
      : headBuf;
    socket.write(payload, (err) => {
      if (err) {
        reject(err);
        return;
      }
      if (!opts.close) {
        resolve();
        return;
      }
      const end = (socket as { end?: (cb?: () => void) => void }).end;
      if (end) end.call(socket, resolve);
      else {
        try { socket.destroy(); } catch { /* ignore */ }
        resolve();
      }
    });
  });
}
