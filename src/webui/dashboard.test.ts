import { assertEquals } from '@std/assert';
import { createServer, type AddressInfo } from 'node:net';
import { WebUI } from './dashboard.ts';

Deno.test({ name: 'WebUI — handles an asynchronous listen error', sanitizeResources: false, sanitizeOps: false }, async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (occupied.address() as AddressInfo).port;
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const webui = new WebUI({
        server: '127.0.0.1:7000',
        proxies: {},
        webui: { enabled: true, host: '127.0.0.1', port },
    });

    try {
        webui.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assertEquals(errors.length, 1);
    } finally {
        webui.stop();
        console.error = originalError;
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
});
