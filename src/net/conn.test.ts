import { assertEquals } from '@std/assert';
import { listenTcp } from './conn.ts';
import type { AddressInfo } from 'node:net';

Deno.test({ name: 'listenTcp — binds the requested host and port', sanitizeResources: false, sanitizeOps: false }, async () => {
    const server = await listenTcp('127.0.0.1', 0);

    try {
        const address = server.address() as AddressInfo;
        assertEquals(address.address, '127.0.0.1');
        assertEquals(address.port > 0, true);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
