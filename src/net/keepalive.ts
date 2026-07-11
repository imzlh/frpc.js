export interface KeepAliveSocket {
    setKeepAlive(enable?: boolean, initialDelay?: number): unknown;
}

export function configureTcpKeepAlive(socket: KeepAliveSocket, seconds?: number): void {
    if (seconds === undefined) return;
    socket.setKeepAlive(seconds >= 0, Math.max(0, seconds) * 1_000);
}
