# frpc-ts - frp client for Deno/Node-compatible runtimes

TypeScript rewrite of [frp](https://github.com/fatedier/frp) client, compatible
with the frp V1 and V2 Wire message protocols.

## Features

- **Proxy types**: TCP, TCPMux HTTP CONNECT, HTTP, HTTPS, UDP, RawHTTP
- **Protocol**: V1 JSON messages and V2 Wire frames with AES-256-GCM control-channel encryption
- **Auth**: token auth plus OIDC client credentials/token source auth
- **TLS**: Control and work connections over TLS
- **Pool**: Configurable work connection pool (min/max)
- **Health checks**: TCP/HTTP checks for forwarded local backends
- **Heartbeat**: Ping/Pong with timeout detection
- **Keepalive**: Go-compatible TCP probes (`dialServerKeepalive`) and configurable TCP mux probes (`tcpMuxKeepaliveInterval`). With `tcpMux: true`, application heartbeat defaults to disabled; set `heartbeatInterval`/`heartbeatTimeout` explicitly to enable it.
- **Reconnect**: Exponential backoff with max retries
- **WebUI**: Built-in dashboard (port 7400) with Basic Auth
- **ProxyProtocol v1/v2**: Optional header injection for TCP and UDP
- **Proxy metadata/annotations**: Per-proxy `metadatas` and `annotations`
- **Proxy selection**: `start` and per-proxy `enabled` select active proxies
- **Hooks**: onLogin, onProxyRegister, onProxyError, onReconnect, onError
- **Logger**: Configurable log levels (debug/info/warn/error)

## Quick Start

```bash
deno run -A main.ts ./example.config.ts
```

Or with Node.js:

```bash
npx --yes tsx main.ts ./example.config.ts
```

Or with CNO from the sibling checkout (recommended):

```bash
cno main.ts ./example.config.ts
```

## Configuration

Config is a TypeScript file exporting an `IConfig` object:

```typescript
import { HTTP, TCP } from "./src/types.ts";
import type { IConfig } from "./src/types.ts";

export default {
  serverAddr: "frps.example.com",
  serverPort: 7000,
  token: "my-secret",
  auth: {
    method: "token",
    additionalScopes: ["HeartBeats", "NewWorkConns"],
  },
  user: "alice",
  clientID: "alice-laptop",
  start: ["ssh", "web"],
  logLevel: "info",
  transport: {
    tcpMux: true,
    poolCount: 1,
    heartbeatInterval: 30,
    heartbeatTimeout: 90,
    dialServerKeepalive: 7200,
    tcpMuxKeepaliveInterval: 30,
    tls: { enable: false },
  },
  webServer: {
    addr: "127.0.0.1",
    port: 7400,
    user: "admin",
    password: "admin",
  },
  proxies: {
    "ssh": new TCP(
      {
        remotePort: 6000,
        enabled: true,
        transport: { useEncryption: true, useCompression: true },
        healthCheck: { type: "tcp", intervalSeconds: 10 },
      },
      TCP.forward({ host: "127.0.0.1", port: 22 }),
    ),
    "web": new HTTP(
      {
        domains: ["app.example.com"],
        healthCheck: {
          type: "http",
          path: "/healthz",
          httpHeaders: [{ name: "x-health-token", value: "secret" }],
        },
      },
      async (req, addr) => ({ status: 200, body: "Hello" }),
    ),
  },
} satisfies IConfig;
```

## Architecture

```
main.ts → FrpClient → ControlChannel → [Login, ProxyRegister, Heartbeat]
                                  ↘ WorkConnPool → [Handler: TCP/TCPMux, HTTP, UDP]
```

| Layer    | Module          | Description                          |
| -------- | --------------- | ------------------------------------ |
| Protocol | `src/protocol/` | V1/V2 codecs, AEAD control crypto, message types, token auth  |
| Control  | `src/control/`  | Login, registration, heartbeat, pool |
| Handler  | `src/handler/`  | TCP/HTTP/UDP proxy handlers          |
| Network  | `src/net/`      | TCP/TLS connect, ProxyProtocol       |
| HTTP     | `src/http/`     | Custom HTTP/1.x request parser       |
| WebUI    | `src/webui/`    | Built-in dashboard                   |

## Testing

```bash
deno task check
deno task test
deno task cno:test
deno task cno:cache
deno task verify
```

Run the real `frps` compatibility smoke test after runtime-sensitive changes:

```bash
deno task e2e
```

The default e2e task uses `./frp/bin/frps`, starts Deno first, then starts CNO with the
same generated scenario shape and isolated `frps`/backend processes per runtime.
It verifies TCP, work-connection encryption, Snappy framed work-connection
compression, encryption+compression, TCP group, TCP health check failover and
restore, TCPMux HTTP CONNECT, ProxyProtocol v1/v2, HTTP, HTTP health check
failover and restore, HTTP group, HTTP options (subdomain/location/auth/
route-by-user/request headers/response headers/host rewrite), HTTPS, RawHTTP,
UDP forwarding, and UDP ProxyProtocol v1/v2 for both plain TCP and TLS
transport. The control and work connections use the same yamux path enabled by
default in Go `frpc`/`frps`. Node.js 22+ via `tsx` can
be checked separately when changing Node compatibility:

```bash
npm install
deno task e2e:node
```

To narrow a failure
while debugging the harness:

```bash
deno run --allow-net --allow-read --allow-write=/tmp --allow-run scripts/e2e_real_frps.ts --scenario=plain --runtime=deno
deno run --allow-net --allow-read --allow-write=/tmp --allow-run scripts/e2e_real_frps.ts --scenario=plain --runtime=cno
deno run --allow-net --allow-read --allow-write=/tmp --allow-run scripts/e2e_real_frps.ts --scenario=plain --runtime=node
```

Transport TLS can also be exercised explicitly:

```bash
deno run --allow-net --allow-read --allow-write=/tmp --allow-run scripts/e2e_real_frps.ts --scenario=tls --runtime=deno
deno run --allow-net --allow-read --allow-write=/tmp --allow-run scripts/e2e_real_frps.ts --scenario=tls --runtime=cno
```

Pass `--wire=v2` to validate the V2 Wire path. V2 was added to upstream `dev`
after `v0.68.1`, so a released `v0.68.1` server must stay on the default `v1`:

```bash
deno run --allow-net --allow-read --allow-write=/tmp --allow-run scripts/e2e_real_frps.ts --scenario=plain --runtime=deno --wire=v2
```

For an upstream build that includes V2, opt in explicitly:

```typescript
transport: { wireProtocol: "v2" }
```

TLS uses the standard ClientHello by default, matching current Go `frpc`. Set
`transport.tls.disableCustomTLSFirstByte` to `false` only for a server setup
that requires the legacy `0x17` prefix. Supplying `trustedCaFile` enables
certificate verification unless `insecureSkipVerify` is explicitly `true`.

## Not Implemented (vs Go frp)

- WebSocket/QUIC transport
- XTCP/SUDP visitors
