// src/log.ts — Lightweight structured logger

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0, info: 1, warn: 2, error: 3,
};

export class ConsoleLogger implements Logger {
    private minLevel: number;
    private prefix: string;

    constructor(level: LogLevel = 'info', prefix = '[frpc]') {
        this.minLevel = LEVEL_ORDER[level];
        this.prefix = prefix;
    }

    debug(msg: string, ...args: unknown[]): void {
        if (this.minLevel <= 0) console.debug(`${this.prefix} ${msg}`, ...args);
    }

    info(msg: string, ...args: unknown[]): void {
        if (this.minLevel <= 1) console.info(`${this.prefix} ${msg}`, ...args);
    }

    warn(msg: string, ...args: unknown[]): void {
        if (this.minLevel <= 2) console.warn(`${this.prefix} ${msg}`, ...args);
    }

    error(msg: string, ...args: unknown[]): void {
        if (this.minLevel <= 3) console.error(`${this.prefix} ${msg}`, ...args);
    }
}

export const defaultLogger: Logger = new ConsoleLogger();
