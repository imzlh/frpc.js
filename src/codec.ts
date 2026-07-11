// src/codec.ts — Low-level I/O helpers for node:net sockets

import type { NetSocket } from './types.ts';

export function writeFull(socket: NetSocket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err?: Error | null) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
        };
        const written = socket.write(data, done);
        if (written === false) {
            socket.once('drain', () => done());
        }
    });
}
