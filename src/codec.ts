// src/codec.ts — Low-level I/O helpers for node:net sockets

import type { NetSocket } from './types.ts';

export function writeFull(socket: NetSocket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        const written = socket.write(data, (err) => {
            if (err) reject(err);
            else resolve();
        });
        if (written === false) {
            socket.once('drain', () => resolve());
        }
    });
}
