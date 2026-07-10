// src/handler/pp2_test.ts — ProxyProtocol header compatibility tests

import { assertEquals } from '@std/assert';
import { buildProxyProtocolHeader } from './pp2.ts';

const SIG_LEN = 12;

Deno.test('buildProxyProtocolHeader — v2 distinguishes TCP and UDP IPv4', () => {
    const src = { hostname: '127.0.0.1', port: 12345 };
    const dst = { hostname: '10.0.0.1', port: 54321 };

    const tcp = buildProxyProtocolHeader(src, dst, 'v2', 'tcp');
    const udp = buildProxyProtocolHeader(src, dst, 'v2', 'udp');

    assertEquals(tcp[SIG_LEN], 0x21);
    assertEquals(tcp[SIG_LEN + 1], 0x11);
    assertEquals(udp[SIG_LEN], 0x21);
    assertEquals(udp[SIG_LEN + 1], 0x12);
    assertEquals(new DataView(udp.buffer).getUint16(SIG_LEN + 2), 12);
    assertEquals([...udp.slice(SIG_LEN + 4, SIG_LEN + 12)], [
        127, 0, 0, 1,
        10, 0, 0, 1,
    ]);
    assertEquals(new DataView(udp.buffer).getUint16(SIG_LEN + 12), 12345);
    assertEquals(new DataView(udp.buffer).getUint16(SIG_LEN + 14), 54321);
});

Deno.test('buildProxyProtocolHeader — UDP v1 matches frp UNKNOWN header', () => {
    const src = { hostname: '127.0.0.1', port: 12345 };
    const dst = { hostname: '10.0.0.1', port: 54321 };

    assertEquals(
        new TextDecoder().decode(buildProxyProtocolHeader(src, dst, 'v1', 'udp')),
        'PROXY UNKNOWN\r\n',
    );
});
