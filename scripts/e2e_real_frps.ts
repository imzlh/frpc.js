import dgram from "node:dgram";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

type RuntimeName = "deno" | "cno" | "node";
type ScenarioName = "plain" | "tls";

interface ChildHandle {
  child: Deno.ChildProcess;
  name: string;
  stdout: string;
  stderr: string;
  outputDone: Promise<void>;
  killGroup: boolean;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const frpsPath = resolve(rootDir, "frp/bin/frps");
const cnoPath = resolve(rootDir, "../cno-cli/build/stage/cno");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function runtimeFilter(): RuntimeName[] {
  const arg = Deno.args.find((value) => value.startsWith("--runtime="));
  const value = arg?.slice("--runtime=".length) ?? "both";
  if (value === "deno") return ["deno"];
  if (value === "cno") return ["cno"];
  if (value === "node") return ["node"];
  if (value === "both") return ["deno", "cno"];
  throw new Error(`Unsupported runtime filter: ${value}`);
}

function scenarioFilter(): ScenarioName[] {
  const arg = Deno.args.find((value) => value.startsWith("--scenario="));
  const value = arg?.slice("--scenario=".length) ?? "both";
  if (value === "plain") return ["plain"];
  if (value === "tls") return ["tls"];
  if (value === "both") return ["plain", "tls"];
  throw new Error(`Unsupported scenario filter: ${value}`);
}

async function readInto(
  stream: ReadableStream<Uint8Array> | null,
  append: (text: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) append(decoder.decode(value, { stream: true }));
  }
}

function spawn(
  name: string,
  command: string,
  args: string[],
  cwd = rootDir,
  options: { killGroup?: boolean } = {},
): ChildHandle {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const handle: ChildHandle = {
    child,
    name,
    stdout: "",
    stderr: "",
    outputDone: Promise.resolve(),
    killGroup: options.killGroup ?? false,
  };
  handle.outputDone = Promise.all([
    readInto(child.stdout, (text) => {
      handle.stdout += text;
    }),
    readInto(child.stderr, (text) => {
      handle.stderr += text;
    }),
  ]).then(() => undefined);
  return handle;
}

async function sendSignal(handle: ChildHandle, signal: Deno.Signal): Promise<void> {
  if (!handle.killGroup) {
    try {
      handle.child.kill(signal);
    } catch {
      // Already exited.
    }
    return;
  }

  const sig = signal.startsWith("SIG") ? signal.slice(3) : signal;
  await new Deno.Command("kill", {
    args: [`-${sig}`, `-${handle.child.pid}`],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => undefined);
}

async function stopChild(
  handle: ChildHandle,
  signal: Deno.Signal = "SIGINT",
): Promise<void> {
  await sendSignal(handle, signal);

  const status = await Promise.race([
    handle.child.status,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (status === null) {
    await sendSignal(handle, "SIGKILL");
    await handle.child.status.catch(() => undefined);
  }
  await handle.outputDone.catch(() => undefined);
}

async function assertChildAlive(handle: ChildHandle): Promise<void> {
  const status = await Promise.race([
    handle.child.status,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
  ]);
  if (status !== null) {
    throw new Error(
      `${handle.name} exited early with code ${status.code}\nstdout:\n${handle.stdout}\nstderr:\n${handle.stderr}`,
    );
  }
}

async function childLogs(handles: ChildHandle[]): Promise<string> {
  const parts: string[] = [];
  for (const handle of handles) {
    if (handle.stdout.trim()) {
      parts.push(`stdout:${handle.name}\n${handle.stdout}`);
    }
    if (handle.stderr.trim()) {
      parts.push(`stderr:${handle.name}\n${handle.stderr}`);
    }
  }
  return parts.join("\n");
}

async function tcpPort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function udpPort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolvePromise());
  });
  const addr = socket.address();
  socket.close();
  if (typeof addr === "string") throw new Error("unexpected UDP pipe address");
  return addr.port;
}

async function createSelfSignedCert(tempDir: string): Promise<{
  certFile: string;
  keyFile: string;
}> {
  const certFile = join(tempDir, "https.crt");
  const keyFile = join(tempDir, "https.key");
  const output = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(`openssl failed: ${decoder.decode(output.stderr).trim()}`);
  }
  return { certFile, keyFile };
}

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `Timed out waiting for ${label}${
      lastError ? `: ${(lastError as Error).message}` : ""
    }`,
  );
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = text.indexOf(needle, offset);
    if (next === -1) return count;
    count++;
    offset = next + needle.length;
  }
}

async function waitTcp(port: number): Promise<void> {
  await waitFor(`TCP port ${port}`, async () => {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  });
}

async function httpBody(
  port: number,
  host: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    return (await writeHttpRequest(
      host,
      path,
      body,
      headers,
      (data) => conn.write(data),
      async (buffer) => await conn.read(buffer),
    )).body;
  } finally {
    conn.close();
  }
}

async function httpChunkedBody(
  port: number,
  host: string,
  path: string,
  chunks: string[],
  headers: Record<string, string> = {},
): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    return (await writeChunkedHttpRequest(
      host,
      path,
      chunks,
      headers,
      (data) => conn.write(data),
      async (buffer) => await conn.read(buffer),
    )).body;
  } finally {
    conn.close();
  }
}

async function httpResponse(
  port: number,
  host: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<HttpResponseResult> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    return await writeHttpRequest(
      host,
      path,
      body,
      headers,
      (data) => conn.write(data),
      async (buffer) => await conn.read(buffer),
    );
  } finally {
    conn.close();
  }
}

async function httpsBody(
  port: number,
  host: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port,
    servername: host,
    rejectUnauthorized: false,
  });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`TLS handshake timeout for ${host}:${port}`)),
        10_000,
      )
    ),
  ]);

  try {
    return (await writeHttpRequest(
      host,
      path,
      body,
      headers,
      (data) =>
        new Promise<number>((resolve, reject) => {
          socket.write(Buffer.from(data), (err) => {
            if (err) reject(err);
            else resolve(data.byteLength);
          });
        }),
      (buffer) =>
        new Promise<number | null>((resolve, reject) => {
          const onData = (chunk: Buffer) => {
            cleanup();
            buffer.set(chunk.subarray(0, buffer.byteLength));
            resolve(Math.min(chunk.byteLength, buffer.byteLength));
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
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
          };
          socket.on("data", onData);
          socket.on("end", onEnd);
          socket.on("error", onError);
          socket.resume();
        }),
    )).body;
  } finally {
    socket.destroy();
  }
}

interface HttpResponseResult {
  statusLine: string;
  headers: Map<string, string>;
  body: string;
}

async function writeChunkedHttpRequest(
  host: string,
  path: string,
  chunks: string[],
  headers: Record<string, string>,
  write: (data: Uint8Array) => Promise<number>,
  read: (buffer: Uint8Array) => Promise<number | null>,
): Promise<HttpResponseResult> {
  const body = chunks.flatMap((chunk) => [
    Buffer.byteLength(chunk).toString(16),
    chunk,
  ]).concat(["0", "", ""]).join("\r\n");
  const request = [
    `POST ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Transfer-Encoding: chunked",
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "Connection: close",
    "",
    body,
  ].join("\r\n");
  await write(encoder.encode(request));
  return await readHttpResponse(read);
}

async function writeHttpRequest(
  host: string,
  path: string,
  body: string,
  headers: Record<string, string>,
  write: (data: Uint8Array) => Promise<number>,
  read: (buffer: Uint8Array) => Promise<number | null>,
): Promise<HttpResponseResult> {
  const content = encoder.encode(body);
  const request = [
    `POST ${path} HTTP/1.1`,
    `Host: ${host}`,
    `Content-Length: ${content.byteLength}`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "Connection: close",
    "",
    body,
  ].join("\r\n");
  await write(encoder.encode(request));

  return await readHttpResponse(read);
}

async function readHttpResponse(
  read: (buffer: Uint8Array) => Promise<number | null>,
): Promise<HttpResponseResult> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const n = await readWithTimeout(read, buffer, deadline);
    if (n === null) break;
    chunks.push(buffer.slice(0, n));

    const parsed = parseHttpResponse(chunks);
    if (parsed) return parsed;
  }

  const parsed = parseHttpResponse(chunks);
  if (parsed) return parsed;

  const text = decoder.decode(concat(chunks));
  const split = text.indexOf("\r\n\r\n");
  if (split === -1) throw new Error(`Invalid HTTP response:\n${text}`);
  const statusLine = text.slice(0, text.indexOf("\r\n"));
  if (!statusLine.includes(" 200 ")) {
    throw new Error(`Unexpected HTTP status: ${statusLine}`);
  }
  return {
    statusLine,
    headers: parseHttpHeaders(text.slice(0, split)),
    body: text.slice(split + 4),
  };
}

async function readWithTimeout(
  read: (buffer: Uint8Array) => Promise<number | null>,
  buffer: Uint8Array,
  deadline: number,
): Promise<number | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("HTTP response timeout");
  return await Promise.race([
    read(buffer),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("HTTP response timeout")), remaining)
    ),
  ]);
}

function parseHttpResponse(chunks: Uint8Array[]): HttpResponseResult | null {
  const bytes = concat(chunks);
  const text = decoder.decode(bytes);
  const split = text.indexOf("\r\n\r\n");
  if (split === -1) return null;

  const statusLine = text.slice(0, text.indexOf("\r\n"));
  if (!statusLine.includes(" 200 ")) {
    throw new Error(`Unexpected HTTP status: ${statusLine}`);
  }

  const head = text.slice(0, split);
  let contentLength: number | null = null;
  for (const line of head.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
      contentLength = Number(line.slice(colon + 1).trim());
    }
  }

  const bodyStart = split + 4;
  if (contentLength === null) return null;
  if (bytes.byteLength < bodyStart + contentLength) return null;
  return {
    statusLine,
    headers: parseHttpHeaders(head),
    body: decoder.decode(bytes.subarray(bodyStart, bodyStart + contentLength)),
  };
}

function parseHttpHeaders(head: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of head.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return headers;
}

async function tcpBody(port: number, body: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  const timer = setTimeout(() => conn.close(), 3000);

  try {
    await conn.write(encoder.encode(body));
    for (;;) {
      const n = await conn.read(buffer);
      if (n === null) break;
      chunks.push(buffer.slice(0, n));
    }
  } finally {
    clearTimeout(timer);
    conn.close();
  }

  return decoder.decode(concat(chunks));
}

async function tcpMuxBody(
  port: number,
  host: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const buffer = new Uint8Array(4096);
  const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => conn.close(), 3000);

  try {
    const request = [
      `CONNECT ${host}:443 HTTP/1.1`,
      `Host: ${host}:443`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      "",
      "",
    ].join("\r\n");
    await conn.write(encoder.encode(request));

    let head = "";
    while (!head.includes("\r\n\r\n")) {
      const n = await conn.read(buffer);
      if (n === null) throw new Error("TCPMux CONNECT closed before response");
      head += decoder.decode(buffer.subarray(0, n));
    }
    const statusLine = head.slice(0, head.indexOf("\r\n"));
    if (!statusLine.includes(" 200 ")) {
      throw new Error(`Unexpected TCPMux CONNECT status: ${statusLine}`);
    }

    await conn.write(encoder.encode(body));
    for (;;) {
      const n = await conn.read(buffer);
      if (n === null) break;
      chunks.push(buffer.slice(0, n));
    }
  } finally {
    clearTimeout(timer);
    conn.close();
  }

  return decoder.decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function handleTcpEchoConn(conn: Deno.Conn): Promise<void> {
  await handleTaggedTcpEchoConn(conn, "tcp");
}

async function handleTaggedTcpEchoConn(
  conn: Deno.Conn,
  tag: string,
): Promise<void> {
  try {
    const buffer = new Uint8Array(4096);
    const n = await conn.read(buffer);
    if (n !== null) {
      const body = decoder.decode(buffer.subarray(0, n));
      await conn.write(encoder.encode(`${tag}:${body}`));
    }
  } finally {
    conn.close();
  }
}

function startTcpEchoServer(port: number): {
  close(): void;
  finished: Promise<void>;
} {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  let closed = false;
  const finished = (async () => {
    try {
      for await (const conn of listener) {
        void handleTcpEchoConn(conn);
      }
    } catch (err) {
      if (!closed) throw err;
    }
  })();

  return {
    close() {
      closed = true;
      listener.close();
    },
    finished,
  };
}

function startTaggedTcpEchoServer(port: number, tag: string): {
  close(): void;
  finished: Promise<void>;
} {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  let closed = false;
  const finished = (async () => {
    try {
      for await (const conn of listener) {
        void handleTaggedTcpEchoConn(conn, tag);
      }
    } catch (err) {
      if (!closed) throw err;
    }
  })();

  return {
    close() {
      closed = true;
      listener.close();
    },
    finished,
  };
}

async function readExact(conn: Deno.Conn, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const n = await conn.read(out.subarray(offset));
    if (n === null) throw new Error("connection closed");
    offset += n;
  }
  return out;
}

async function handleProxyProtocolEchoConn(conn: Deno.Conn): Promise<void> {
  try {
    const header = await readExact(conn, 16);
    const sig = [
      0x0d,
      0x0a,
      0x0d,
      0x0a,
      0x00,
      0x0d,
      0x0a,
      0x51,
      0x55,
      0x49,
      0x54,
      0x0a,
    ];
    if (!sig.every((value, index) => header[index] === value)) {
      throw new Error("invalid proxy protocol signature");
    }
    if (header[12] !== 0x21 || header[13] !== 0x11) {
      throw new Error(
        `unexpected proxy protocol header ${header[12]} ${header[13]}`,
      );
    }

    const addrLen = new DataView(header.buffer, header.byteOffset).getUint16(14);
    const addr = await readExact(conn, addrLen);
    if (addrLen !== 12) throw new Error(`unexpected IPv4 length ${addrLen}`);

    const view = new DataView(addr.buffer, addr.byteOffset);
    const srcIp = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    const srcPort = view.getUint16(8);
    const payload = new Uint8Array(4096);
    const n = await conn.read(payload);
    const body = n === null ? "" : decoder.decode(payload.subarray(0, n));
    await conn.write(encoder.encode(`pp2:${srcIp}:${srcPort}:${body}`));
  } finally {
    conn.close();
  }
}

async function handleProxyProtocolV1EchoConn(conn: Deno.Conn): Promise<void> {
  try {
    const chunks: Uint8Array[] = [];
    const buffer = new Uint8Array(1);
    for (;;) {
      const n = await conn.read(buffer);
      if (n === null) throw new Error("connection closed");
      chunks.push(buffer.slice(0, n));
      const bytes = concat(chunks);
      if (bytes.byteLength >= 2 &&
        bytes[bytes.byteLength - 2] === 0x0d &&
        bytes[bytes.byteLength - 1] === 0x0a) break;
      if (bytes.byteLength > 108) throw new Error("proxy protocol v1 line too long");
    }

    const line = decoder.decode(concat(chunks)).trimEnd();
    const parts = line.split(" ");
    if (parts.length !== 6 || parts[0] !== "PROXY" || parts[1] !== "TCP4") {
      throw new Error(`invalid proxy protocol v1 line: ${line}`);
    }

    const payload = new Uint8Array(4096);
    const n = await conn.read(payload);
    const body = n === null ? "" : decoder.decode(payload.subarray(0, n));
    await conn.write(encoder.encode(`pp1:${parts[2]}:${parts[4]}:${body}`));
  } finally {
    conn.close();
  }
}

function startProxyProtocolEchoServer(port: number): {
  close(): void;
  finished: Promise<void>;
} {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  let closed = false;
  const finished = (async () => {
    try {
      for await (const conn of listener) {
        void handleProxyProtocolEchoConn(conn);
      }
    } catch (err) {
      if (!closed) throw err;
    }
  })();

  return {
    close() {
      closed = true;
      listener.close();
    },
    finished,
  };
}

function startProxyProtocolV1EchoServer(port: number): {
  close(): void;
  finished: Promise<void>;
} {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  let closed = false;
  const finished = (async () => {
    try {
      for await (const conn of listener) {
        void handleProxyProtocolV1EchoConn(conn);
      }
    } catch (err) {
      if (!closed) throw err;
    }
  })();

  return {
    close() {
      closed = true;
      listener.close();
    },
    finished,
  };
}

async function udpEcho(port: number, body: string): Promise<string> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolvePromise());
  });
  const done = new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("UDP timeout")), 3000);
    socket.once("message", (message) => {
      clearTimeout(timer);
      resolvePromise(message.toString());
    });
    socket.once("error", reject);
  });
  socket.send(Buffer.from(body), port, "127.0.0.1");
  try {
    return await done;
  } finally {
    socket.close();
  }
}

function startUdpEchoServer(port: number, prefix: string): {
  close(): void;
  finished: Promise<void>;
} {
  const socket = dgram.createSocket("udp4");
  let closed = false;
  const finished = new Promise<void>((resolve, reject) => {
    socket.on("message", (message, rinfo) => {
      socket.send(Buffer.from(`${prefix}:${message.toString()}`), rinfo.port, rinfo.address);
    });
    socket.on("error", (err) => {
      if (closed) resolve();
      else reject(err);
    });
    socket.on("close", () => resolve());
    socket.bind(port, "127.0.0.1");
  });

  return {
    close() {
      closed = true;
      socket.close(() => {});
    },
    finished,
  };
}

function parseUdpProxyProtocolV2(message: Buffer): string {
  const sig = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];
  if (message.length < 28) return `bad-short:${message.length}`;
  for (let i = 0; i < sig.length; i++) {
    if (message[i] !== sig[i]) return "bad-sig";
  }
  if (message[12] !== 0x21) return `bad-version:${message[12]}`;
  if (message[13] !== 0x12) return `bad-family:${message[13]}`;
  const len = message.readUInt16BE(14);
  if (len !== 12 || message.length < 16 + len) return `bad-len:${len}`;
  const srcIp = [...message.slice(16, 20)].join(".");
  const dstIp = [...message.slice(20, 24)].join(".");
  const srcPort = message.readUInt16BE(24);
  const dstPort = message.readUInt16BE(26);
  const payload = message.slice(16 + len).toString();
  return `${srcIp}:${srcPort}:${dstIp}:${dstPort}:${payload}`;
}

function startUdpProxyProtocolV2EchoServer(port: number, prefix: string): {
  close(): void;
  finished: Promise<void>;
} {
  const socket = dgram.createSocket("udp4");
  let closed = false;
  const finished = new Promise<void>((resolve, reject) => {
    socket.on("message", (message, rinfo) => {
      const parsed = parseUdpProxyProtocolV2(message);
      socket.send(Buffer.from(`${prefix}:${parsed}`), rinfo.port, rinfo.address);
    });
    socket.on("error", (err) => {
      if (closed) resolve();
      else reject(err);
    });
    socket.on("close", () => resolve());
    socket.bind(port, "127.0.0.1");
  });

  return {
    close() {
      closed = true;
      socket.close(() => {});
    },
    finished,
  };
}

function parseUdpProxyProtocolV1(message: Buffer): string {
  const prefix = Buffer.from("PROXY UNKNOWN\r\n");
  if (message.length < prefix.length) return `bad-short:${message.length}`;
  if (!message.subarray(0, prefix.length).equals(prefix)) {
    return `bad-header:${message.toString()}`;
  }
  return message.subarray(prefix.length).toString();
}

function startUdpProxyProtocolV1EchoServer(port: number, prefix: string): {
  close(): void;
  finished: Promise<void>;
} {
  const socket = dgram.createSocket("udp4");
  let closed = false;
  const finished = new Promise<void>((resolve, reject) => {
    socket.on("message", (message, rinfo) => {
      const parsed = parseUdpProxyProtocolV1(message);
      socket.send(Buffer.from(`${prefix}:${parsed}`), rinfo.port, rinfo.address);
    });
    socket.on("error", (err) => {
      if (closed) resolve();
      else reject(err);
    });
    socket.on("close", () => resolve());
    socket.bind(port, "127.0.0.1");
  });

  return {
    close() {
      closed = true;
      socket.close(() => {});
    },
    finished,
  };
}

function startRawBackend(port: number): {
  close(): void;
  finished: Promise<void>;
} {
  const abort = new AbortController();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port,
      signal: abort.signal,
      onListen: () => undefined,
    },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");
      const body = await req.text();
      if (url.pathname === "/host") {
        return new Response(`host:${req.headers.get("host") ?? ""}:${req.headers.get("x-added-by-frps") ?? ""}:${body}`, {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(`raw:${url.pathname}:${body}`, {
        headers: { "content-type": "text/plain" },
      });
    },
  );

  return {
    close() {
      abort.abort();
    },
    finished: server.finished.then(() => undefined),
  };
}

async function assertEqual(
  label: string,
  actual: string,
  expected: string,
): Promise<void> {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function runRuntime(
  scenario: ScenarioName,
  runtime: RuntimeName,
  configPath: string,
  ports: {
    vhost: number;
    https: number;
    tcp: number;
    tcpEncrypted: number;
    tcpCompressed: number;
    tcpEncryptedCompressed: number;
    tcpGroup: number;
    tcpMux: number;
    stcpVisitor: number;
    pp1: number;
    pp2: number;
    udp: number;
    udpForward: number;
    udpPp1: number;
    udpPp1Backend: number;
    udpPp2: number;
    udpPp2Backend: number;
  },
  controls: {
    stopTcpGroupB(): Promise<void>;
    startTcpGroupB(): void;
    stopRawBackend(): Promise<void>;
    startRawBackend(): void;
  },
): Promise<void> {
  const command = runtime === "deno" ? Deno.execPath() : runtime === "cno" ? cnoPath : "setsid";
  const args = runtime === "deno"
    ? ["run", "--allow-net", "--allow-read", "main.ts", configPath]
    : runtime === "cno"
    ? ["main.ts", configPath]
    : ["--wait", "npx", "--yes", "tsx", "main.ts", configPath];
  const handle = spawn(`frpc:${runtime}`, command, args, rootDir, {
    killGroup: runtime === "node",
  });

  try {
    await waitFor(`${scenario}/${runtime} proxy registration`, async () => {
      await assertChildAlive(handle);
      return handle.stdout.includes('Proxy "tcp_echo"') &&
        handle.stdout.includes('Proxy "tcp_encrypted"') &&
        handle.stdout.includes('Proxy "tcp_compressed"') &&
        handle.stdout.includes('Proxy "tcp_encrypted_compressed"') &&
        handle.stdout.includes('Proxy "tcp_group_a"') &&
        handle.stdout.includes('Proxy "tcp_group_b"') &&
        handle.stdout.includes('Proxy "tcpmux_echo"') &&
        handle.stdout.includes('Proxy "stcp_echo"') &&
        handle.stdout.includes('Proxy "tcp_pp1"') &&
        handle.stdout.includes('Proxy "tcp_pp2"') &&
        handle.stdout.includes('Proxy "http_direct"') &&
        handle.stdout.includes('Proxy "http_subdomain"') &&
        handle.stdout.includes('Proxy "http_options"') &&
        handle.stdout.includes('Proxy "http_route_alice"') &&
        handle.stdout.includes('Proxy "http_route_bob"') &&
        handle.stdout.includes('Proxy "http_group_a"') &&
        handle.stdout.includes('Proxy "http_group_b"') &&
        handle.stdout.includes('Proxy "https_direct"') &&
        handle.stdout.includes('Proxy "raw_http"') &&
        handle.stdout.includes('Proxy "udp_forward"') &&
        handle.stdout.includes('Proxy "udp_pp1"') &&
        handle.stdout.includes('Proxy "udp_pp2"') &&
        handle.stdout.includes('Proxy "udp_echo"');
    });

    await waitFor(`${scenario}/${runtime} HTTP proxy readiness`, async () => {
      await assertChildAlive(handle);
      return await httpBody(
        ports.vhost,
        `${runtime}-http.local`,
        "/ready",
        "ok",
      )
        .then((body) => body === `raw:/ready:ok`)
        .catch(() => false);
    });

    await assertEqual(
      `${runtime} HTTP`,
      await httpBody(ports.vhost, `${runtime}-http.local`, "/alpha", "hello"),
      "raw:/alpha:hello",
    );
    await assertEqual(
      `${runtime} HTTP chunked request`,
      await httpChunkedBody(ports.vhost, `${runtime}-http.local`, "/chunked", ["hello", " ", "world"]),
      "raw:/chunked:hello world",
    );
    await assertEqual(
      `${runtime} HTTP backend headers`,
      await httpBody(ports.vhost, `${runtime}-http.local`, "/host", "hello"),
      "host:local-http-backend.local:yes:hello",
    );
    await assertEqual(
      `${runtime} HTTP subdomain`,
      await httpBody(ports.vhost, "sub.frpc-e2e.local", "/sub", "hello"),
      "subdomain:POST:/sub:hello",
    );
    await assertEqual(
      `${runtime} HTTP route by user alice`,
      await httpBody(
        ports.vhost,
        `${runtime}-route.local`,
        "/who",
        "hello",
        { Authorization: basicAuth("alice", "unused") },
      ),
      "route:alice:/who:hello",
    );
    await assertEqual(
      `${runtime} HTTP route by user bob`,
      await httpBody(
        ports.vhost,
        `${runtime}-route.local`,
        "/who",
        "hello",
        { Authorization: basicAuth("bob", "unused") },
      ),
      "route:bob:/who:hello",
    );
    const groupResponses = new Set<string>();
    for (let i = 0; i < 2; i++) {
      groupResponses.add(
        await httpBody(
          ports.vhost,
          "group.local",
          `/group-${i}`,
          "hello",
        ),
      );
    }
    if (![...groupResponses].some((body) => body.startsWith("group:a:")) ||
      ![...groupResponses].some((body) => body.startsWith("group:b:"))) {
      throw new Error(
        `${runtime} HTTP group: expected both group backends, got ${
          JSON.stringify([...groupResponses])
        }`,
      );
    }
    const optionsResponse = await httpResponse(
        ports.vhost,
        `${runtime}-options.local`,
        "/opts/alpha",
        "hello",
        { Authorization: basicAuth("tester", "secret") },
    );
    await assertEqual(
      `${runtime} HTTP options`,
      optionsResponse.body,
      "POST:/opts/alpha:rewritten.local:yes:hello",
    );
    await assertEqual(
      `${runtime} HTTP response headers`,
      optionsResponse.headers.get("x-added-by-frpc") ?? "",
      "yes",
    );
    await assertEqual(
      `${runtime} RawHTTP`,
      await httpBody(ports.vhost, `${runtime}-raw.local`, "/beta", "hello"),
      "raw:/beta:hello",
    );
    await assertEqual(
      `${runtime} HTTPS`,
      await httpsBody(
        ports.https,
        `${runtime}-secure.local`,
        "/secure",
        "hello",
      ),
      "https:POST:/secure:hello",
    );
    await waitFor(`${runtime} TCP`, async () => {
      return await tcpBody(ports.tcp, "hello")
        .then((body) => body === "tcp:hello")
        .catch(() => false);
    });
    await waitFor(`${runtime} TCP encrypted`, async () => {
      return await tcpBody(ports.tcpEncrypted, "secret")
        .then((body) => body === "tcp-encrypted:secret")
        .catch(() => false);
    });
    await waitFor(`${runtime} TCP compressed`, async () => {
      return await tcpBody(ports.tcpCompressed, "compressible-compressible-compressible")
        .then((body) => body === "tcp-compressed:compressible-compressible-compressible")
        .catch(() => false);
    });
    await waitFor(`${runtime} TCP encrypted+compressed`, async () => {
      return await tcpBody(ports.tcpEncryptedCompressed, "secret-compressible-secret-compressible")
        .then((body) => body === "tcp-encrypted-compressed:secret-compressible-secret-compressible")
        .catch(() => false);
    });
    await waitFor(`${runtime} TCP group`, async () => {
      const responses = new Set<string>();
      for (let i = 0; i < 4; i++) {
        responses.add(await tcpBody(ports.tcpGroup, `hello-${i}`));
      }
      return [...responses].some((body) => body.startsWith("tcp-group-a:")) &&
        [...responses].some((body) => body.startsWith("tcp-group-b:"));
    });
    const tcpGroupFailedMarker = 'Proxy "tcp_group_b" health check failed';
    const tcpGroupFailedCount = countOccurrences(handle.stderr, tcpGroupFailedMarker);
    await controls.stopTcpGroupB();
    await waitFor(`${runtime} TCP group health reports failed backend`, async () => {
      return countOccurrences(handle.stderr, tcpGroupFailedMarker) > tcpGroupFailedCount;
    });
    await waitFor(`${runtime} TCP group health removes failed backend`, async () => {
      const responses: string[] = [];
      for (let i = 0; i < 4; i++) {
        responses.push(await tcpBody(ports.tcpGroup, `health-down-${i}`));
      }
      return responses.every((body) => body.startsWith("tcp-group-a:"));
    });
    const tcpGroupSuccessMarker = 'Proxy "tcp_group_b" health check success';
    const tcpGroupSuccessCount = countOccurrences(handle.stdout, tcpGroupSuccessMarker);
    controls.startTcpGroupB();
    await waitFor(`${runtime} TCP group health reports restored backend`, async () => {
      return countOccurrences(handle.stdout, tcpGroupSuccessMarker) > tcpGroupSuccessCount;
    });
    await waitFor(`${runtime} TCP group health restores backend`, async () => {
      const responses = new Set<string>();
      for (let i = 0; i < 4; i++) {
        responses.add(await tcpBody(ports.tcpGroup, `health-up-${i}`));
      }
      return [...responses].some((body) => body.startsWith("tcp-group-a:")) &&
        [...responses].some((body) => body.startsWith("tcp-group-b:"));
    });
    await waitFor(`${runtime} TCPMux`, async () => {
      return await tcpMuxBody(
        ports.tcpMux,
        `${runtime}-mux.local`,
        "hello",
        { "Proxy-Authorization": basicAuth("tester", "secret") },
      )
        .then((body) => body === "tcpmux:hello")
        .catch(() => false);
    });
    await waitFor(`${runtime} STCP`, async () => {
      return await tcpBody(ports.stcpVisitor, "hello")
        .then((body) => body === "stcp:hello")
        .catch(() => false);
    });
    await waitFor(`${runtime} ProxyProtocol v2`, async () => {
      return await tcpBody(ports.pp2, "hello")
        .then((body) => {
          const parts = body.split(":");
          return parts.length === 4 &&
            parts[0] === "pp2" &&
            parts[1] === "127.0.0.1" &&
            Number(parts[2]) > 0 &&
            parts[3] === "hello";
        })
        .catch(() => false);
    });
    await waitFor(`${runtime} ProxyProtocol v1`, async () => {
      return await tcpBody(ports.pp1, "hello")
        .then((body) => {
          const parts = body.split(":");
          return parts.length === 4 &&
            parts[0] === "pp1" &&
            parts[1] === "127.0.0.1" &&
            Number(parts[2]) > 0 &&
            parts[3] === "hello";
        })
        .catch(() => false);
    });
    await waitFor(`${runtime} UDP`, async () => {
      return await udpEcho(ports.udp, "ping")
        .then((body) => body === "udp:ping")
        .catch(() => false);
    });
    await waitFor(`${runtime} UDP forward`, async () => {
      return await udpEcho(ports.udpForward, "ping")
        .then((body) => body === "udp-forward:ping")
        .catch(() => false);
    });
    await waitFor(`${runtime} UDP ProxyProtocol v1`, async () => {
      return await udpEcho(ports.udpPp1, "ping")
        .then((body) => body === "udp-pp1:ping")
        .catch(() => false);
    });
    await waitFor(`${runtime} UDP ProxyProtocol v2`, async () => {
      return await udpEcho(ports.udpPp2, "ping")
        .then((body) => {
          const parts = body.split(":");
          return parts.length === 6 &&
            parts[0] === "udp-pp2" &&
            parts[1] === "127.0.0.1" &&
            Number(parts[2]) > 0 &&
            parts[3] === "127.0.0.1" &&
            Number(parts[4]) === ports.udpPp2Backend &&
            parts[5] === "ping";
        })
        .catch(() => false);
    });
    const rawFailedMarker = 'Proxy "raw_http" health check failed';
    const rawFailedCount = countOccurrences(handle.stderr, rawFailedMarker);
    await controls.stopRawBackend();
    await waitFor(`${runtime} RawHTTP health reports failed backend`, async () => {
      return countOccurrences(handle.stderr, rawFailedMarker) > rawFailedCount;
    });
    await waitFor(`${runtime} RawHTTP health removes failed backend`, async () => {
      return await httpBody(ports.vhost, `${runtime}-raw.local`, "/beta", "hello")
        .then(() => false)
        .catch(() => true);
    });
    const rawSuccessMarker = 'Proxy "raw_http" health check success';
    const rawSuccessCount = countOccurrences(handle.stdout, rawSuccessMarker);
    controls.startRawBackend();
    await waitFor(`${runtime} RawHTTP health reports restored backend`, async () => {
      return countOccurrences(handle.stdout, rawSuccessMarker) > rawSuccessCount;
    });
    await waitFor(`${runtime} RawHTTP health restores backend`, async () => {
      return await httpBody(ports.vhost, `${runtime}-raw.local`, "/beta", "hello")
        .then((body) => body === "raw:/beta:hello")
        .catch(() => false);
    });
    console.log(
      `ok ${scenario}/${runtime}: TCP, TCP encrypted, TCP compressed, TCP encrypted+compressed, TCP group, TCP health, TCPMux, STCP, PPv1, PPv2, HTTP, HTTP subdomain, HTTP route user, HTTP group, HTTP opts+headers, HTTP health, HTTPS, RawHTTP, UDP, UDP forward, UDP PPv1, UDP PPv2`,
    );
  } catch (err) {
    await stopChild(handle);
    throw new Error(
      `${scenario}/${runtime} e2e failed: ${
        (err as Error).message
      }\nstdout:\n${handle.stdout}\nstderr:\n${handle.stderr}`,
    );
  } finally {
    await stopChild(handle);
  }
}

async function runScenario(
  scenario: ScenarioName,
  runtimes: RuntimeName[],
): Promise<void> {
  const usedTcpPorts = new Set<number>();
  const usedUdpPorts = new Set<number>();
  const uniqueTcpPort = async (): Promise<number> => {
    for (;;) {
      const port = await tcpPort();
      if (!usedTcpPorts.has(port)) {
        usedTcpPorts.add(port);
        return port;
      }
    }
  };
  const uniqueUdpPort = async (): Promise<number> => {
    for (;;) {
      const port = await udpPort();
      if (!usedUdpPorts.has(port)) {
        usedUdpPorts.add(port);
        return port;
      }
    }
  };
  const ports = {
    bind: await uniqueTcpPort(),
    vhost: await uniqueTcpPort(),
    https: await uniqueTcpPort(),
    backend: await uniqueTcpPort(),
    tcp: await uniqueTcpPort(),
    tcpBackend: await uniqueTcpPort(),
    tcpEncrypted: await uniqueTcpPort(),
    tcpEncryptedBackend: await uniqueTcpPort(),
    tcpCompressed: await uniqueTcpPort(),
    tcpCompressedBackend: await uniqueTcpPort(),
    tcpEncryptedCompressed: await uniqueTcpPort(),
    tcpEncryptedCompressedBackend: await uniqueTcpPort(),
    tcpGroup: await uniqueTcpPort(),
    tcpGroupBackendA: await uniqueTcpPort(),
    tcpGroupBackendB: await uniqueTcpPort(),
    tcpMux: await uniqueTcpPort(),
    tcpMuxBackend: await uniqueTcpPort(),
    stcpVisitor: await uniqueTcpPort(),
    stcpBackend: await uniqueTcpPort(),
    pp1: await uniqueTcpPort(),
    pp1Backend: await uniqueTcpPort(),
    pp2: await uniqueTcpPort(),
    pp2Backend: await uniqueTcpPort(),
    udp: await uniqueUdpPort(),
    udpForward: await uniqueUdpPort(),
    udpForwardBackend: await uniqueUdpPort(),
    udpPp1: await uniqueUdpPort(),
    udpPp1Backend: await uniqueUdpPort(),
    udpPp2: await uniqueUdpPort(),
    udpPp2Backend: await uniqueUdpPort(),
  };
  const tempDir = await Deno.makeTempDir({ prefix: "frpc-e2e-" });
  const frpsConfig = join(tempDir, "frps.toml");
  const frpcConfig = join(tempDir, "frpc.config.ts");
  const cert = await createSelfSignedCert(tempDir);
  const children: ChildHandle[] = [];

  await Deno.writeTextFile(
    frpsConfig,
    [
      'bindAddr = "127.0.0.1"',
      `bindPort = ${ports.bind}`,
      'proxyBindAddr = "127.0.0.1"',
      `vhostHTTPPort = ${ports.vhost}`,
      `vhostHTTPSPort = ${ports.https}`,
      `tcpmuxHTTPConnectPort = ${ports.tcpMux}`,
      'subDomainHost = "frpc-e2e.local"',
      'log.to = "console"',
      'log.level = "trace"',
      "log.disablePrintColor = true",
      "transport.tcpMux = false",
      scenario === "tls" ? "transport.tls.force = true" : "",
      'auth.method = "token"',
      'auth.token = "test-token"',
      "",
    ].join("\n"),
  );

  await Deno.writeTextFile(
    frpcConfig,
    `
import { HTTP, RawHTTP, STCP, STCPVisitor, TCP, TCPMux, UDP } from '${join(rootDir, "src/types.ts")}';
import type { IConfig } from '${join(rootDir, "src/types.ts")}';

const text = (bytes: Uint8Array | null) => bytes ? new TextDecoder().decode(bytes) : '';

export default {
    server: '127.0.0.1:${ports.bind}',
    token: 'test-token',
    logLevel: 'debug',
    connection: {
        tls: ${scenario === "tls" ? "true" : "false"},
        retries: 0,
        pool: { min: 0, max: 32 },
        heartbeat: 2,
        heartbeatTimeout: 8,
    },
    webui: { enabled: false },
    proxies: {
        tcp_echo: new TCP(
            {
                remotePort: ${ports.tcp},
                localIP: '127.0.0.1',
                localPort: ${ports.tcpBackend},
                bandwidthLimit: '64MB/s',
                metadatas: { suite: 'e2e' },
                annotations: { coverage: 'metadata' },
            },
        ),
        tcp_encrypted: new TCP(
            { remotePort: ${ports.tcpEncrypted}, useEncryption: true },
            TCP.forward({ host: '127.0.0.1', port: ${ports.tcpEncryptedBackend} }),
        ),
        tcp_compressed: new TCP(
            { remotePort: ${ports.tcpCompressed}, useCompression: true },
            TCP.forward({ host: '127.0.0.1', port: ${ports.tcpCompressedBackend} }),
        ),
        tcp_encrypted_compressed: new TCP(
            { remotePort: ${ports.tcpEncryptedCompressed}, useEncryption: true, useCompression: true },
            TCP.forward({ host: '127.0.0.1', port: ${ports.tcpEncryptedCompressedBackend} }),
        ),
        tcp_group_a: new TCP(
            {
                remotePort: ${ports.tcpGroup},
                group: 'tcp-e2e-group',
                groupKey: 'tcp-e2e-key',
            },
            TCP.forward({ host: '127.0.0.1', port: ${ports.tcpGroupBackendA} }),
        ),
        tcp_group_b: new TCP(
            {
                remotePort: ${ports.tcpGroup},
                group: 'tcp-e2e-group',
                groupKey: 'tcp-e2e-key',
                healthCheck: {
                    type: 'tcp',
                    intervalSeconds: 1,
                    timeoutSeconds: 1,
                    maxFailed: 1,
                },
            },
            TCP.forward({ host: '127.0.0.1', port: ${ports.tcpGroupBackendB} }),
        ),
        tcpmux_echo: new TCPMux(
            {
                customDomains: ['deno-mux.local', 'cno-mux.local', 'node-mux.local'],
                localIP: '127.0.0.1',
                localPort: ${ports.tcpMuxBackend},
                httpUser: 'tester',
                httpPassword: 'secret',
                routeByHTTPUser: 'tester',
            },
        ),
        stcp_echo: new STCP(
            {
                secretKey: 'stcp-secret',
                localIP: '127.0.0.1',
                localPort: ${ports.stcpBackend},
            },
        ),
        tcp_pp1: new TCP(
            {
                remotePort: ${ports.pp1},
                transport: { proxyProtocolVersion: 'v1' },
            },
            TCP.forward({
                host: '127.0.0.1',
                port: ${ports.pp1Backend},
            }),
        ),
        tcp_pp2: new TCP(
            { remotePort: ${ports.pp2} },
            TCP.forward({
                host: '127.0.0.1',
                port: ${ports.pp2Backend},
                proxyProtocol: true,
            }),
        ),
        http_direct: new HTTP(
            {
                customDomains: ['deno-http.local', 'cno-http.local', 'node-http.local'],
                localIP: '127.0.0.1',
                localPort: ${ports.backend},
                hostHeaderRewrite: 'local-http-backend.local',
                headers: { 'x-added-by-frps': 'yes' },
            },
        ),
        http_subdomain: new HTTP(
            { subdomain: 'sub' },
            async (req) => {
                console.log(\`[e2e] http subdomain handler \${new URL(req.url).pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: \`subdomain:\${req.method}:\${new URL(req.url).pathname}:\${text(req.body)}\`,
                };
            },
        ),
        http_route_alice: new HTTP(
            {
                domains: ['deno-route.local', 'cno-route.local', 'node-route.local'],
                routeByHTTPUser: 'alice',
            },
            async (req) => {
                console.log(\`[e2e] http route alice handler \${new URL(req.url).pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: \`route:alice:\${new URL(req.url).pathname}:\${text(req.body)}\`,
                };
            },
        ),
        http_route_bob: new HTTP(
            {
                domains: ['deno-route.local', 'cno-route.local', 'node-route.local'],
                routeByHTTPUser: 'bob',
            },
            async (req) => {
                console.log(\`[e2e] http route bob handler \${new URL(req.url).pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: \`route:bob:\${new URL(req.url).pathname}:\${text(req.body)}\`,
                };
            },
        ),
        http_group_a: new HTTP(
            {
                domains: ['group.local'],
                group: 'http-e2e-group',
                groupKey: 'http-e2e-key',
            },
            async (req) => {
                console.log(\`[e2e] http group a handler \${new URL(req.url).pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: \`group:a:\${new URL(req.url).pathname}:\${text(req.body)}\`,
                };
            },
        ),
        http_group_b: new HTTP(
            {
                domains: ['group.local'],
                group: 'http-e2e-group',
                groupKey: 'http-e2e-key',
            },
            async (req) => {
                console.log(\`[e2e] http group b handler \${new URL(req.url).pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: \`group:b:\${new URL(req.url).pathname}:\${text(req.body)}\`,
                };
            },
        ),
        http_options: new HTTP(
            {
                domains: ['deno-options.local', 'cno-options.local', 'node-options.local'],
                locations: ['/opts'],
                hostHeaderRewrite: 'rewritten.local',
                headers: { 'x-added-by-frps': 'yes' },
                responseHeaders: { 'x-added-by-frpc': 'yes' },
                httpUser: 'tester',
                httpPassword: 'secret',
            },
            async (req) => {
                const url = new URL(req.url);
                console.log(\`[e2e] http options handler \${url.pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: [
                        req.method,
                        url.pathname,
                        req.headers.get('host') ?? '',
                        req.headers.get('x-added-by-frps') ?? '',
                        text(req.body),
                    ].join(':'),
                };
            },
        ),
        https_direct: new HTTP(
            {
                domains: ['deno-secure.local', 'cno-secure.local', 'node-secure.local'],
                secure: true,
                certFile: '${cert.certFile}',
                keyFile: '${cert.keyFile}',
            },
            async (req) => {
                console.log(\`[e2e] https handler \${new URL(req.url).pathname}\`);
                return {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                    body: \`https:\${req.method}:\${new URL(req.url).pathname}:\${text(req.body)}\`,
                };
            },
        ),
        raw_http: new RawHTTP(
            {
                customDomains: ['deno-raw.local', 'cno-raw.local', 'node-raw.local'],
                localIP: '127.0.0.1',
                localPort: ${ports.backend},
                healthCheck: {
                    type: 'http',
                    path: '/healthz',
                    intervalSeconds: 1,
                    timeoutSeconds: 1,
                    maxFailed: 1,
                },
            },
        ),
        udp_forward: new UDP(
            {
                remotePort: ${ports.udpForward},
                localIP: '127.0.0.1',
                localPort: ${ports.udpForwardBackend},
            },
        ),
        udp_pp1: new UDP(
            {
                remotePort: ${ports.udpPp1},
                transport: { proxyProtocolVersion: 'v1' },
            },
            UDP.forward({
                host: '127.0.0.1',
                port: ${ports.udpPp1Backend},
            }),
        ),
        udp_pp2: new UDP(
            { remotePort: ${ports.udpPp2} },
            UDP.forward({
                host: '127.0.0.1',
                port: ${ports.udpPp2Backend},
                proxyProtocol: true,
            }),
        ),
        udp_echo: new UDP(
            { remotePort: ${ports.udp} },
            async (pkt) => {
                console.log(\`[e2e] udp handler \${pkt.content.length}\`);
                return new TextEncoder().encode(\`udp:\${text(pkt.content)}\`);
            },
        ),
    },
    visitors: {
        stcp_visitor: new STCPVisitor({
            serverName: 'stcp_echo',
            secretKey: 'stcp-secret',
            bindAddr: '127.0.0.1',
            bindPort: ${ports.stcpVisitor},
        }),
    },
} satisfies IConfig;
`,
  );

  const tcpBackend = startTcpEchoServer(ports.tcpBackend);
  const tcpEncryptedBackend = startTaggedTcpEchoServer(ports.tcpEncryptedBackend, "tcp-encrypted");
  const tcpCompressedBackend = startTaggedTcpEchoServer(ports.tcpCompressedBackend, "tcp-compressed");
  const tcpEncryptedCompressedBackend = startTaggedTcpEchoServer(ports.tcpEncryptedCompressedBackend, "tcp-encrypted-compressed");
  const tcpGroupBackendA = startTaggedTcpEchoServer(ports.tcpGroupBackendA, "tcp-group-a");
  let tcpGroupBackendB = startTaggedTcpEchoServer(ports.tcpGroupBackendB, "tcp-group-b");
  const tcpMuxBackend = startTaggedTcpEchoServer(ports.tcpMuxBackend, "tcpmux");
  const stcpBackend = startTaggedTcpEchoServer(ports.stcpBackend, "stcp");
  let tcpGroupBackendBRunning = true;
  const stopTcpGroupB = async () => {
    if (!tcpGroupBackendBRunning) return;
    tcpGroupBackendBRunning = false;
    tcpGroupBackendB.close();
    await tcpGroupBackendB.finished.catch(() => undefined);
  };
  const startTcpGroupB = () => {
    if (tcpGroupBackendBRunning) return;
    tcpGroupBackendB = startTaggedTcpEchoServer(ports.tcpGroupBackendB, "tcp-group-b");
    tcpGroupBackendBRunning = true;
  };
  const pp1Backend = startProxyProtocolV1EchoServer(ports.pp1Backend);
  const pp2Backend = startProxyProtocolEchoServer(ports.pp2Backend);
  const udpForwardBackend = startUdpEchoServer(ports.udpForwardBackend, "udp-forward");
  const udpPp1Backend = startUdpProxyProtocolV1EchoServer(ports.udpPp1Backend, "udp-pp1");
  const udpPp2Backend = startUdpProxyProtocolV2EchoServer(ports.udpPp2Backend, "udp-pp2");
  let backend = startRawBackend(ports.backend);
  let rawBackendRunning = true;
  const stopRawBackend = async () => {
    if (!rawBackendRunning) return;
    rawBackendRunning = false;
    backend.close();
    await backend.finished.catch(() => undefined);
  };
  const restartRawBackend = () => {
    if (rawBackendRunning) return;
    backend = startRawBackend(ports.backend);
    rawBackendRunning = true;
  };

  try {
    const frps = spawn("frps", frpsPath, ["-c", frpsConfig]);
    children.push(frps);
    await waitTcp(ports.bind);
    await waitTcp(ports.vhost);
    await waitTcp(ports.https);
    await waitTcp(ports.tcpMux);

    for (const runtime of runtimes) {
      await runRuntime(scenario, runtime, frpcConfig, {
        vhost: ports.vhost,
        https: ports.https,
        tcp: ports.tcp,
        tcpEncrypted: ports.tcpEncrypted,
        tcpCompressed: ports.tcpCompressed,
        tcpEncryptedCompressed: ports.tcpEncryptedCompressed,
        tcpGroup: ports.tcpGroup,
        tcpMux: ports.tcpMux,
        stcpVisitor: ports.stcpVisitor,
        pp1: ports.pp1,
        pp2: ports.pp2,
        udp: ports.udp,
        udpForward: ports.udpForward,
        udpPp1: ports.udpPp1,
        udpPp1Backend: ports.udpPp1Backend,
        udpPp2: ports.udpPp2,
        udpPp2Backend: ports.udpPp2Backend,
      }, {
        stopTcpGroupB,
        startTcpGroupB,
        stopRawBackend,
        startRawBackend: restartRawBackend,
      });
    }
  } catch (err) {
    await Promise.all(children.map((child) => stopChild(child)));
    const logs = await childLogs(children);
    throw new Error(
      `scenario ${scenario} failed: ${(err as Error).message}${
        logs ? `\n${logs}` : ""
      }`,
    );
  } finally {
    pp2Backend.close();
    await pp2Backend.finished.catch(() => undefined);
    pp1Backend.close();
    await pp1Backend.finished.catch(() => undefined);
    udpForwardBackend.close();
    await udpForwardBackend.finished.catch(() => undefined);
    udpPp1Backend.close();
    await udpPp1Backend.finished.catch(() => undefined);
    udpPp2Backend.close();
    await udpPp2Backend.finished.catch(() => undefined);
    await stopTcpGroupB();
    tcpGroupBackendA.close();
    await tcpGroupBackendA.finished.catch(() => undefined);
    tcpMuxBackend.close();
    await tcpMuxBackend.finished.catch(() => undefined);
    stcpBackend.close();
    await stcpBackend.finished.catch(() => undefined);
    tcpEncryptedBackend.close();
    await tcpEncryptedBackend.finished.catch(() => undefined);
    tcpCompressedBackend.close();
    await tcpCompressedBackend.finished.catch(() => undefined);
    tcpEncryptedCompressedBackend.close();
    await tcpEncryptedCompressedBackend.finished.catch(() => undefined);
    tcpBackend.close();
    await tcpBackend.finished.catch(() => undefined);
    await stopRawBackend();
    await Promise.all(children.map((child) => stopChild(child)));
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const runtimes = runtimeFilter();
  const scenarios = scenarioFilter();
  const stat = await Deno.stat(frpsPath).catch(() => null);
  if (!stat?.isFile) throw new Error(`frps binary not found: ${frpsPath}`);
  if (runtimes.includes("cno")) {
    const cno = await Deno.stat(cnoPath).catch(() => null);
    if (!cno?.isFile) throw new Error(`cno binary not found: ${cnoPath}`);
  }

  for (const scenario of scenarios) {
    for (const runtime of runtimes) {
      await runScenario(scenario, [runtime]);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
