import { assertEquals } from '@std/assert';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { connectTcp } from '../net/conn.ts';
import { STCPVisitor } from '../types.ts';
import { STCPVisitorRuntime } from './stcp.ts';

function listen(server = createServer()): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve({ server, port: (server.address() as AddressInfo).port });
        });
    });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

Deno.test({ name: 'STCPVisitorRuntime — stop closes a visitor handshake in progress', sanitizeResources: false, sanitizeOps: false }, async () => {
    let accepted!: Socket;
    let accept!: () => void;
    const acceptedPromise = new Promise<void>((resolve) => {
        accept = resolve;
    });
    const remote = await listen(createServer((socket) => {
        accepted = socket;
        accept();
    }));
    const binding = await listen();
    const bindPort = binding.port;
    await close(binding.server);
    const visitor = new STCPVisitor({
        serverName: 'secret',
        secretKey: 'key',
        bindPort,
    });
    const runtime = new STCPVisitorRuntime('visitor', visitor, {
        serverAddr: { hostname: '127.0.0.1', port: remote.port },
        useTls: false,
        runId: 'run-id',
    });

    await runtime.start();
    const user = await connectTcp({ hostname: '127.0.0.1', port: bindPort });
    await acceptedPromise;
    runtime.stop();
    await new Promise<void>((resolve) => accepted.once('close', () => resolve()));

    assertEquals(accepted.destroyed, true);
    user.destroy();
    await close(remote.server);
});
