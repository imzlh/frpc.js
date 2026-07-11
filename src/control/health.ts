// src/control/health.ts — Local backend health checks

import { connect } from 'node:net';
import { type ForwardTarget, healthCheckHeaders, type HealthCheckOptions, type ProxyBase, RawHTTP, STCP, TCP, TCPMux, UDP } from '../types.ts';
import { defaultLogger, formatError, type Logger } from '../log.ts';

export interface HealthTarget {
    target: ForwardTarget;
    healthCheck: HealthCheckOptions;
}

export function getHealthTarget(proxy: ProxyBase): HealthTarget | undefined {
    const opts = 'opts' in proxy ? proxy.opts as { healthCheck?: HealthCheckOptions } : undefined;
    const healthCheck = opts?.healthCheck;
    if (!healthCheck) return undefined;

    if (proxy instanceof TCP && typeof proxy.handler !== 'function') {
        return { target: proxy.handler, healthCheck };
    }
    if (proxy instanceof TCPMux && typeof proxy.handler !== 'function') {
        return { target: proxy.handler, healthCheck };
    }
    if (proxy instanceof STCP && typeof proxy.handler !== 'function') {
        return { target: proxy.handler, healthCheck };
    }
    if (proxy instanceof RawHTTP) {
        return { target: proxy.handler, healthCheck };
    }
    if (proxy instanceof UDP && typeof proxy.handler !== 'function') {
        return { target: proxy.handler, healthCheck };
    }
    return undefined;
}

export class HealthMonitor {
    private stopped = false;
    private healthy = false;
    private failed = 0;
    private unavailableLogged = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private target: ForwardTarget,
        private opts: HealthCheckOptions,
        private onHealthy: () => void | Promise<void>,
        private onUnhealthy: () => void | Promise<void>,
        private log: Logger = defaultLogger,
    ) {}

    start(): void {
        this.#schedule(0);
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
    }

    async #tick(): Promise<void> {
        if (this.stopped) return;
        try {
            let checkError: unknown;
            const ok = await this.#check().then(() => true).catch((error) => {
                checkError = error;
                return false;
            });
            if (this.stopped) return;
            if (ok) {
                this.failed = 0;
                this.unavailableLogged = false;
                if (!this.healthy) {
                    await Promise.resolve(this.onHealthy());
                    this.healthy = true;
                }
            } else if (this.healthy) {
                this.failed++;
                this.log.debug(
                    `Backend check failed (${this.failed}/${this.opts.maxFailed ?? 1}): ${formatError(checkError)}`,
                );
                if (this.failed >= (this.opts.maxFailed ?? 1)) {
                    await Promise.resolve(this.onUnhealthy());
                    this.healthy = false;
                    this.unavailableLogged = true;
                }
            } else if (!this.unavailableLogged) {
                this.log.debug(
                    `Backend unavailable: ${formatTarget(this.target)}: ${formatError(checkError)}`,
                );
                this.unavailableLogged = true;
            }
        } finally {
            this.#schedule((this.opts.intervalSeconds ?? 10) * 1_000);
        }
    }

    #schedule(ms: number): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            void this.#tick().catch((error) => {
                if (!this.stopped) {
                    this.log.warn(`Health state update failed: ${formatError(error)}`);
                }
            });
        }, ms);
    }

    #check(): Promise<void> {
        return this.opts.type === 'http' ? this.#httpCheck() : this.#tcpCheck();
    }

    #tcpCheck(): Promise<void> {
        const timeout = (this.opts.timeoutSeconds ?? 3) * 1_000;
        return new Promise((resolve, reject) => {
            const socket = this.target.type === 'unix'
                ? connect({ path: this.target.path })
                : connect({
                    host: this.target.host,
                    port: this.target.port,
                });
            const done = (err?: Error) => {
                clearTimeout(timer);
                socket.removeAllListeners();
                socket.destroy();
                err ? reject(err) : resolve();
            };
            const timer = setTimeout(
                () => done(new Error('health check timeout')),
                timeout,
            );
            socket.once('connect', () => done());
            socket.once('error', done);
        });
    }

    async #httpCheck(): Promise<void> {
        const timeout = (this.opts.timeoutSeconds ?? 3) * 1_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const path = this.opts.path ?? '/';
            const url = this.target.type === 'unix'
                ? `http://localhost${path.startsWith('/') ? path : `/${path}`}`
                : `http://${this.target.host}:${this.target.port}${path.startsWith('/') ? path : `/${path}`}`;
            const resp = await fetch(url, {
                method: 'GET',
                headers: healthCheckHeaders(this.opts),
                signal: controller.signal,
            });
            try {
                if (Math.floor(resp.status / 100) !== 2) {
                    throw new Error(`health check status ${resp.status}`);
                }
            } finally {
                await resp.body?.cancel();
            }
        } finally {
            clearTimeout(timer);
        }
    }
}

function formatTarget(target: ForwardTarget): string {
    return target.type === 'unix' ? `unix:${target.path}` : `${target.host}:${target.port}`;
}
