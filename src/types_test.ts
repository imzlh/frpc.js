// src/types_test.ts — Tests for normBw, parseServer

import { assertEquals, assertThrows } from '@std/assert';
import { createServer } from 'node:net';
import { HTTP, RawHTTP, STCP, TCP, TCPMux, UDP, backendForwardTarget, bandwidthLimitBytes, connectionOptions, domainNames, headerOperations, healthCheckHeaders, httpAuthFields, httpBackendHandler, normBw, parseServer, proxyOptions, responseHeaderOperations, serverEndpoint, targetProxyProtocolVersion, targetServerProxyName, webuiOptions, wireBwMode } from './types.ts';

Deno.test('normBw — undefined returns undefined', () => {
    assertEquals(normBw(undefined), undefined);
});

Deno.test('normBw — empty string returns undefined', () => {
    assertEquals(normBw(''), undefined);
});

Deno.test('normBw — plain number', () => {
    assertEquals(normBw('100'), '100B');
});

Deno.test('normBw — KB', () => {
    assertEquals(normBw('100KB'), '100KB');
});

Deno.test('normBw — MB with /s suffix', () => {
    assertEquals(normBw('50MB/s'), '50MB');
});

Deno.test('normBw — lowercase kb', () => {
    assertEquals(normBw('10kb'), '10KB');
});

Deno.test('bandwidthLimitBytes — parses normalized byte rates', () => {
    assertEquals(bandwidthLimitBytes(undefined), undefined);
    assertEquals(bandwidthLimitBytes('10KB/s'), 10 * 1024);
    assertEquals(bandwidthLimitBytes('1.5MB'), 1.5 * 1024 * 1024);
    assertEquals(bandwidthLimitBytes('100'), 100);
});

Deno.test('wireBwMode — omits frp client default', () => {
    assertEquals(wireBwMode(undefined), undefined);
    assertEquals(wireBwMode('client'), undefined);
    assertEquals(wireBwMode('server'), 'server');
});

Deno.test('parseServer — host:port', () => {
    assertEquals(parseServer('example.com:7000'), { hostname: 'example.com', port: 7000 });
});

Deno.test('parseServer — no port defaults to 7000', () => {
    assertEquals(parseServer('example.com'), { hostname: 'example.com', port: 7000 });
});

Deno.test('parseServer — IPv6 with port', () => {
    assertEquals(parseServer('[::1]:7000'), { hostname: '::1', port: 7000 });
});

Deno.test('parseServer — bare IPv6 defaults to 7000', () => {
    assertEquals(parseServer('::1'), { hostname: '::1', port: 7000 });
});

Deno.test('parseServer — bracketed IPv6 invalid port defaults to 7000', () => {
    assertEquals(parseServer('[2001:db8::1]:abc'), { hostname: '2001:db8::1', port: 7000 });
});

Deno.test('parseServer — invalid port defaults to 7000', () => {
    assertEquals(parseServer('host:abc'), { hostname: 'host', port: 7000 });
});

Deno.test('serverEndpoint — keeps legacy server string', () => {
    assertEquals(serverEndpoint({ server: 'example.com:6000', serverAddr: 'ignored', serverPort: 7000 }), 'example.com:6000');
});

Deno.test('serverEndpoint — builds Go-style serverAddr/serverPort', () => {
    assertEquals(serverEndpoint({ serverAddr: 'example.com', serverPort: 6000 }), 'example.com:6000');
});

Deno.test('serverEndpoint — defaults missing Go-style fields', () => {
    assertEquals(serverEndpoint({ serverPort: 6000 }), '0.0.0.0:6000');
    assertEquals(serverEndpoint({ serverAddr: 'example.com' }), 'example.com:7000');
});

Deno.test('serverEndpoint — brackets IPv6 serverAddr', () => {
    assertEquals(serverEndpoint({ serverAddr: '::1', serverPort: 6000 }), '[::1]:6000');
});

Deno.test('connectionOptions — maps Go-style transport fields', () => {
    assertEquals(connectionOptions({
        transport: {
            poolCount: 4,
            heartbeatInterval: 10,
            heartbeatTimeout: 40,
            tls: {
                enable: true,
                trustedCaFile: '/ca.pem',
                serverName: 'frps.example.com',
                insecureSkipVerify: true,
            },
        },
    }), {
        tls: true,
        tlsTrustedCaFile: '/ca.pem',
        tlsServerName: 'frps.example.com',
        tlsInsecureSkipVerify: true,
        retries: 3,
        pool: { min: 4, max: 5 },
        heartbeat: 10,
        heartbeatTimeout: 40,
    });
});

Deno.test('connectionOptions — connection config overrides transport aliases', () => {
    assertEquals(connectionOptions({
        connection: {
            tls: false,
            tlsTrustedCaFile: '/connection-ca.pem',
            tlsServerName: 'connection.example.com',
            tlsInsecureSkipVerify: false,
            retries: 9,
            pool: { min: 2, max: 8 },
            heartbeat: 11,
            heartbeatTimeout: 44,
        },
        transport: {
            poolCount: 4,
            heartbeatInterval: 10,
            heartbeatTimeout: 40,
            tls: {
                enable: true,
                trustedCaFile: '/transport-ca.pem',
                serverName: 'transport.example.com',
                insecureSkipVerify: true,
            },
        },
    }), {
        tls: false,
        tlsTrustedCaFile: '/connection-ca.pem',
        tlsServerName: 'connection.example.com',
        tlsInsecureSkipVerify: false,
        retries: 9,
        pool: { min: 2, max: 8 },
        heartbeat: 11,
        heartbeatTimeout: 44,
    });
});

Deno.test('webuiOptions — keeps legacy webui config', () => {
    assertEquals(webuiOptions({
        webui: {
            enabled: false,
            host: '0.0.0.0',
            port: 7500,
            user: 'legacy',
            password: 'secret',
        },
        webServer: {
            addr: '127.0.0.2',
            port: 7600,
            user: 'go',
            password: 'ignored',
        },
    }), {
        enabled: false,
        host: '0.0.0.0',
        port: 7500,
        user: 'legacy',
        password: 'secret',
    });
});

Deno.test('webuiOptions — maps Go-style webServer config', () => {
    assertEquals(webuiOptions({
        webServer: {
            addr: '0.0.0.0',
            port: 7500,
            user: 'admin',
            password: 'admin',
        },
    }), {
        enabled: true,
        host: '0.0.0.0',
        port: 7500,
        user: 'admin',
        password: 'admin',
    });
});

Deno.test('webuiOptions — webServer port 0 disables dashboard', () => {
    assertEquals(webuiOptions({ webServer: { addr: '0.0.0.0', port: 0 } }), {
        enabled: false,
        host: '0.0.0.0',
        port: 0,
        user: undefined,
        password: undefined,
    });
});

Deno.test('webuiOptions — preserves current default dashboard behavior', () => {
    assertEquals(webuiOptions({}), {
        enabled: true,
        host: '127.0.0.1',
        port: 7400,
    });
});

Deno.test('proxyOptions — maps Go-style nested proxy options', () => {
    assertEquals(proxyOptions({
        loadBalancer: { group: 'group-a', groupKey: 'key-a' },
        transport: {
            bandwidthLimit: '10KB/s',
            bandwidthLimitMode: 'server',
            useEncryption: true,
            useCompression: true,
            proxyProtocolVersion: 'v1',
        },
    }), {
        group: 'group-a',
        groupKey: 'key-a',
        bandwidthLimit: '10KB/s',
        bandwidthLimitMode: 'server',
        useEncryption: true,
        useCompression: true,
        proxyProtocolVersion: 'v1',
    });
});

Deno.test('proxyOptions — flat proxy options override nested aliases', () => {
    assertEquals(proxyOptions({
        group: 'flat-group',
        groupKey: 'flat-key',
        bandwidthLimit: '20KB',
        bandwidthLimitMode: 'client',
        useEncryption: false,
        useCompression: false,
        loadBalancer: { group: 'nested-group', groupKey: 'nested-key' },
        transport: {
            bandwidthLimit: '10KB/s',
            bandwidthLimitMode: 'server',
            useEncryption: true,
            useCompression: true,
        },
    }), {
        group: 'flat-group',
        groupKey: 'flat-key',
        bandwidthLimit: '20KB',
        bandwidthLimitMode: 'client',
        useEncryption: false,
        useCompression: false,
    });
});

Deno.test('targetProxyProtocolVersion — uses Go-style transport fallback', () => {
    assertEquals(
        targetProxyProtocolVersion(TCP.forward({ host: '127.0.0.1', port: 8080 }), 'v1'),
        'v1',
    );
});

Deno.test('targetProxyProtocolVersion — explicit forward target overrides transport fallback', () => {
    assertEquals(
        targetProxyProtocolVersion(TCP.forward({
            host: '127.0.0.1',
            port: 8080,
            proxyProtocol: true,
        }), 'v1'),
        'v2',
    );
});

Deno.test('backendForwardTarget — maps Go-style localIP/localPort backend', () => {
    assertEquals(backendForwardTarget({ localIP: '127.0.0.2', localPort: 8080 }, 'TCP'), {
        type: 'forward',
        host: '127.0.0.2',
        port: 8080,
    });
});

Deno.test('backendForwardTarget — defaults localIP to Go frp default', () => {
    assertEquals(backendForwardTarget({ localPort: 8080 }, 'TCP'), {
        type: 'forward',
        host: '127.0.0.1',
        port: 8080,
    });
});

Deno.test('backendForwardTarget — requires localPort when handler is omitted', () => {
    assertThrows(
        () => new TCP({ remotePort: 6000 }),
        Error,
        'TCP proxy requires a handler or localPort',
    );
});

Deno.test({ name: 'httpBackendHandler — forwards request to Go-style localIP/localPort backend', sanitizeResources: false, sanitizeOps: false }, async () => {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    const abort = new AbortController();
    const server = Deno.serve({
        hostname: '127.0.0.1',
        port,
        signal: abort.signal,
        onListen: () => undefined,
    }, async (req) => {
        const url = new URL(req.url);
        return new Response(`${req.method}:${url.pathname}:${req.headers.get('host')}:${req.headers.get('x-local-test')}:${await req.text()}`, {
            headers: { 'x-backend': 'yes' },
        });
    });

    try {
        const handler = httpBackendHandler({ localPort: port }, 'HTTP');
        const resp = await handler({
            method: 'POST',
            url: 'http://example.com/backend?q=1',
            headers: new Map([
                ['host', 'example.com'],
                ['connection', 'close'],
                ['x-local-test', 'ok'],
            ]),
            body: new TextEncoder().encode('body'),
        }, { hostname: '203.0.113.1', port: 12345 });

        assertEquals(resp.status, 200);
        assertEquals(resp.headers?.['x-backend'], 'yes');
        assertEquals(new TextDecoder().decode(resp.body as Uint8Array), 'POST:/backend:example.com:ok:body');
    } finally {
        abort.abort();
        await server.finished;
    }
});

Deno.test({ name: 'httpBackendHandler — decodes chunked backend responses', sanitizeResources: false, sanitizeOps: false }, async () => {
    const server = createServer((socket) => {
        socket.once('data', () => {
            socket.end([
                'HTTP/1.1 200 OK',
                'Transfer-Encoding: chunked',
                'X-Backend: chunked',
                '',
                '5',
                'hello',
                '6',
                ' world',
                '0',
                '',
                '',
            ].join('\r\n'));
        });
    });
    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });

    try {
        const handler = httpBackendHandler({ localPort: port }, 'HTTP');
        const resp = await handler({
            method: 'GET',
            url: 'http://example.com/chunked',
            headers: new Map([['host', 'example.com']]),
            body: null,
        }, { hostname: '203.0.113.1', port: 12345 });

        assertEquals(resp.status, 200);
        assertEquals(resp.headers?.['X-Backend'], 'chunked');
        assertEquals(resp.headers?.['Transfer-Encoding'], undefined);
        assertEquals(new TextDecoder().decode(resp.body as Uint8Array), 'hello world');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

Deno.test('healthCheckHeaders — maps Go-style httpHeaders array', () => {
    assertEquals(healthCheckHeaders({
        type: 'http',
        httpHeaders: [
            { name: 'x-health-token', value: 'secret' },
            { name: 'x-env', value: 'test' },
        ],
    }), {
        'x-health-token': 'secret',
        'x-env': 'test',
    });
});

Deno.test('healthCheckHeaders — flat headers override httpHeaders alias', () => {
    assertEquals(healthCheckHeaders({
        type: 'http',
        headers: { 'x-health-token': 'flat' },
        httpHeaders: [{ name: 'x-health-token', value: 'nested' }],
    }), { 'x-health-token': 'flat' });
});

Deno.test('headerOperations — maps Go-style set operation', () => {
    assertEquals(headerOperations(undefined, { set: { 'x-request': 'yes' } }), { 'x-request': 'yes' });
});

Deno.test('headerOperations — flat request headers override Go-style set operation', () => {
    assertEquals(headerOperations({ 'x-request': 'flat' }, { set: { 'x-request': 'nested' } }), { 'x-request': 'flat' });
});

Deno.test('responseHeaderOperations — maps Go-style set operation', () => {
    assertEquals(responseHeaderOperations({ set: { 'x-response': 'yes' } }), { 'x-response': 'yes' });
});

Deno.test('responseHeaderOperations — keeps legacy response header map', () => {
    assertEquals(responseHeaderOperations({ 'x-response': 'yes', set: 'literal-header' }), { 'x-response': 'yes', set: 'literal-header' });
});

Deno.test('httpAuthFields — maps Go-style httpUser and httpPassword', () => {
    assertEquals(httpAuthFields({ httpUser: 'alice', httpPassword: 'secret' }), {
        user: 'alice',
        password: 'secret',
    });
});

Deno.test('httpAuthFields — legacy httpAuth overrides Go-style aliases', () => {
    assertEquals(httpAuthFields({
        httpUser: 'go-user',
        httpPassword: 'go-pass',
        httpAuth: { user: 'legacy-user', password: 'legacy-pass' },
    }), {
        user: 'legacy-user',
        password: 'legacy-pass',
    });
});

Deno.test('domainNames — maps Go-style customDomains alias', () => {
    assertEquals(domainNames({ customDomains: ['go.example.com'] }), ['go.example.com']);
});

Deno.test('domainNames — legacy domains override customDomains alias', () => {
    assertEquals(domainNames({
        domains: ['legacy.example.com'],
        customDomains: ['go.example.com'],
    }), ['legacy.example.com']);
});

Deno.test('HTTP.toNewProxy — maps request and response header options', () => {
    const proxy = new HTTP({
        domains: ['example.com'],
        subdomain: 'web',
        group: 'web-group',
        groupKey: 'web-key',
        metadatas: { owner: 'team-web' },
        annotations: { dashboard: 'visible' },
        headers: { 'x-request': 'yes' },
        responseHeaders: { 'x-response': 'yes' },
        routeByHTTPUser: 'alice',
    }, () => ({ status: 200 }));

    assertEquals(proxy.toNewProxy('web'), {
        proxy_name: 'web',
        proxy_type: 'http',
        custom_domains: ['example.com'],
        subdomain: 'web',
        group: 'web-group',
        group_key: 'web-key',
        metas: { owner: 'team-web' },
        annotations: { dashboard: 'visible' },
        locations: undefined,
        host_header_rewrite: undefined,
        headers: { 'x-request': 'yes' },
        response_headers: { 'x-response': 'yes' },
        route_by_http_user: 'alice',
        http_user: undefined,
        http_pwd: undefined,
        bandwidth_limit: undefined,
        bandwidth_limit_mode: undefined,
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('HTTP.toNewProxy — maps Go-style requestHeaders and responseHeaders operations', () => {
    const proxy = new HTTP({
        domains: ['example.com'],
        requestHeaders: { set: { 'x-request': 'yes' } },
        responseHeaders: { set: { 'x-response': 'yes' } },
    }, () => ({ status: 200 }));

    assertEquals(proxy.toNewProxy('web'), {
        proxy_name: 'web',
        proxy_type: 'http',
        custom_domains: ['example.com'],
        subdomain: undefined,
        group: undefined,
        group_key: undefined,
        metas: undefined,
        annotations: undefined,
        locations: undefined,
        host_header_rewrite: undefined,
        headers: { 'x-request': 'yes' },
        response_headers: { 'x-response': 'yes' },
        route_by_http_user: undefined,
        http_user: undefined,
        http_pwd: undefined,
        bandwidth_limit: undefined,
        bandwidth_limit_mode: undefined,
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('HTTP.toNewProxy — maps Go-style httpUser and httpPassword aliases', () => {
    const proxy = new HTTP({
        domains: ['example.com'],
        httpUser: 'alice',
        httpPassword: 'secret',
    }, () => ({ status: 200 }));

    assertEquals(proxy.toNewProxy('web').http_user, 'alice');
    assertEquals(proxy.toNewProxy('web').http_pwd, 'secret');
});

Deno.test('HTTP.toNewProxy — legacy request headers override Go-style requestHeaders', () => {
    const proxy = new HTTP({
        domains: ['example.com'],
        headers: { 'x-request': 'flat' },
        requestHeaders: { set: { 'x-request': 'nested' } },
    }, () => ({ status: 200 }));

    assertEquals(proxy.toNewProxy('web').headers, { 'x-request': 'flat' });
});

Deno.test('HTTP.toNewProxy — maps Go-style customDomains alias', () => {
    const proxy = new HTTP({
        customDomains: ['go.example.com'],
    }, () => ({ status: 200 }));

    assertEquals(proxy.toNewProxy('web').custom_domains, ['go.example.com']);
});

Deno.test('HTTP.toNewProxy — maps nested transport and load balancer options', () => {
    const proxy = new HTTP({
        domains: ['example.com'],
        loadBalancer: { group: 'web-group', groupKey: 'web-key' },
        transport: {
            bandwidthLimit: '1MB/s',
            bandwidthLimitMode: 'server',
            useEncryption: true,
            useCompression: true,
        },
    }, () => ({ status: 200 }));

    assertEquals(proxy.toNewProxy('web'), {
        proxy_name: 'web',
        proxy_type: 'http',
        custom_domains: ['example.com'],
        subdomain: undefined,
        group: 'web-group',
        group_key: 'web-key',
        metas: undefined,
        annotations: undefined,
        locations: undefined,
        host_header_rewrite: undefined,
        headers: undefined,
        response_headers: undefined,
        route_by_http_user: undefined,
        http_user: undefined,
        http_pwd: undefined,
        bandwidth_limit: '1MB',
        bandwidth_limit_mode: 'server',
        use_encryption: true,
        use_compression: true,
    });
});

Deno.test('RawHTTP.toNewProxy — maps subdomain without custom domains', () => {
    const proxy = new RawHTTP(
        { subdomain: 'raw' },
        TCP.forward({ host: '127.0.0.1', port: 8080 }),
    );

    assertEquals(proxy.toNewProxy('raw'), {
        proxy_name: 'raw',
        proxy_type: 'http',
        custom_domains: undefined,
        subdomain: 'raw',
        group: undefined,
        group_key: undefined,
        metas: undefined,
        annotations: undefined,
        bandwidth_limit: undefined,
        bandwidth_limit_mode: undefined,
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('RawHTTP.toNewProxy — maps Go-style customDomains alias', () => {
    const proxy = new RawHTTP(
        { customDomains: ['raw.example.com'] },
        TCP.forward({ host: '127.0.0.1', port: 8080 }),
    );

    assertEquals(proxy.toNewProxy('raw').custom_domains, ['raw.example.com']);
});

Deno.test('TCPMux.toNewProxy — maps Go-style HTTP CONNECT multiplexer fields', () => {
    const proxy = new TCPMux(
        {
            customDomains: ['mux.example.com'],
            httpUser: 'alice',
            httpPassword: 'secret',
            routeByHTTPUser: 'alice',
            loadBalancer: { group: 'mux-group', groupKey: 'mux-key' },
            transport: { bandwidthLimit: '1MB/s', bandwidthLimitMode: 'server' },
        },
        TCPMux.forward({ host: '127.0.0.1', port: 22 }),
    );

    assertEquals(proxy.toNewProxy('mux'), {
        proxy_name: 'mux',
        proxy_type: 'tcpmux',
        custom_domains: ['mux.example.com'],
        subdomain: undefined,
        group: 'mux-group',
        group_key: 'mux-key',
        metas: undefined,
        annotations: undefined,
        http_user: 'alice',
        http_pwd: 'secret',
        route_by_http_user: 'alice',
        multiplexer: 'httpconnect',
        bandwidth_limit: '1MB',
        bandwidth_limit_mode: 'server',
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('STCP.toNewProxy — maps Go-style secret proxy fields', () => {
    const proxy = new STCP(
        {
            secretKey: 'secret',
            allowUsers: ['alice', '*'],
            loadBalancer: { group: 'secret-group', groupKey: 'secret-key' },
            transport: { bandwidthLimit: '1MB/s', bandwidthLimitMode: 'server' },
        },
        STCP.forward({ host: '127.0.0.1', port: 22 }),
    );

    assertEquals(proxy.toNewProxy('secret_ssh'), {
        proxy_name: 'secret_ssh',
        proxy_type: 'stcp',
        group: 'secret-group',
        group_key: 'secret-key',
        metas: undefined,
        annotations: undefined,
        sk: 'secret',
        allow_users: ['alice', '*'],
        bandwidth_limit: '1MB',
        bandwidth_limit_mode: 'server',
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('targetServerProxyName — matches Go visitor target naming', () => {
    assertEquals(targetServerProxyName('alice', undefined, 'secret_ssh'), 'alice.secret_ssh');
    assertEquals(targetServerProxyName('alice', 'bob', 'secret_ssh'), 'bob.secret_ssh');
    assertEquals(targetServerProxyName(undefined, undefined, 'secret_ssh'), 'secret_ssh');
});

Deno.test('TCP and UDP toNewProxy — map group options', () => {
    const tcp = new TCP(
        { remotePort: 6000, group: 'tcp-group', groupKey: 'tcp-key' },
        TCP.forward({ host: '127.0.0.1', port: 22 }),
    );
    const udp = new UDP(
        { remotePort: 7000, group: 'udp-group', groupKey: 'udp-key' },
        (pkt) => pkt.content,
    );

    assertEquals(tcp.toNewProxy('tcp'), {
        proxy_name: 'tcp',
        proxy_type: 'tcp',
        remote_port: 6000,
        group: 'tcp-group',
        group_key: 'tcp-key',
        metas: undefined,
        annotations: undefined,
        bandwidth_limit: undefined,
        bandwidth_limit_mode: undefined,
        use_encryption: false,
        use_compression: false,
    });
    assertEquals(udp.toNewProxy('udp'), {
        proxy_name: 'udp',
        proxy_type: 'udp',
        remote_port: 7000,
        group: 'udp-group',
        group_key: 'udp-key',
        metas: undefined,
        annotations: undefined,
        bandwidth_limit: undefined,
        bandwidth_limit_mode: undefined,
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('TCP.toNewProxy — maps nested transport and load balancer options', () => {
    const tcp = new TCP(
        {
            remotePort: 6000,
            loadBalancer: { group: 'tcp-group', groupKey: 'tcp-key' },
            transport: {
                bandwidthLimit: '2MB/s',
                bandwidthLimitMode: 'server',
                useEncryption: true,
                useCompression: true,
            },
        },
        TCP.forward({ host: '127.0.0.1', port: 22 }),
    );

    assertEquals(tcp.toNewProxy('tcp'), {
        proxy_name: 'tcp',
        proxy_type: 'tcp',
        remote_port: 6000,
        group: 'tcp-group',
        group_key: 'tcp-key',
        metas: undefined,
        annotations: undefined,
        bandwidth_limit: '2MB',
        bandwidth_limit_mode: 'server',
        use_encryption: true,
        use_compression: true,
    });
});

Deno.test('TCP.toNewProxy — keeps explicit server bandwidth limit mode', () => {
    const tcp = new TCP(
        { remotePort: 6000, bandwidthLimit: '10KB/s', bandwidthLimitMode: 'server' },
        TCP.forward({ host: '127.0.0.1', port: 22 }),
    );

    assertEquals(tcp.toNewProxy('limited'), {
        proxy_name: 'limited',
        proxy_type: 'tcp',
        remote_port: 6000,
        group: undefined,
        group_key: undefined,
        metas: undefined,
        annotations: undefined,
        bandwidth_limit: '10KB',
        bandwidth_limit_mode: 'server',
        use_encryption: false,
        use_compression: false,
    });
});

Deno.test('TCP.toNewProxy — maps encryption and compression flags', () => {
    const tcp = new TCP(
        { remotePort: 6000, useEncryption: true, useCompression: true },
        TCP.forward({ host: '127.0.0.1', port: 22 }),
    );

    assertEquals(tcp.toNewProxy('secure'), {
        proxy_name: 'secure',
        proxy_type: 'tcp',
        remote_port: 6000,
        group: undefined,
        group_key: undefined,
        metas: undefined,
        annotations: undefined,
        bandwidth_limit: undefined,
        bandwidth_limit_mode: undefined,
        use_encryption: true,
        use_compression: true,
    });
});
