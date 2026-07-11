// src/log.ts — Lightweight structured logger

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
}

export function formatError(value: unknown, seen = new Set<Error>()): string {
    if (!(value instanceof Error)) return String(value);
    if (seen.has(value)) return `${value.name}: ${value.message} (circular cause)`;
    seen.add(value);
    const cause = value.cause === undefined ? '' : `; cause: ${formatError(value.cause, seen)}`;
    return `${value.name}: ${value.message}${cause}`;
}

export function withLogScope(log: Logger, scope: string): Logger {
    if (log instanceof ConsoleLogger) return log.withScope(scope);
    const prefix = `${scope}:`;
    return {
        debug: (msg, ...args) => log.debug(`${prefix} ${msg}`, ...args),
        info: (msg, ...args) => log.info(`${prefix} ${msg}`, ...args),
        warn: (msg, ...args) => log.warn(`${prefix} ${msg}`, ...args),
        error: (msg, ...args) => log.error(`${prefix} ${msg}`, ...args),
    };
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export class ConsoleLogger implements Logger {
    private minLevel: number;
    private prefix: string;
    private level: LogLevel;

    constructor(level: LogLevel = 'info', prefix = '[frpc]') {
        this.level = level;
        this.minLevel = LEVEL_ORDER[level];
        this.prefix = prefix;
    }

    withScope(scope: string): ConsoleLogger {
        const prefix = this.prefix.endsWith(']')
            ? `${this.prefix.slice(0, -1)}:${scope}]`
            : `${this.prefix}:${scope}`;
        return new ConsoleLogger(this.level, prefix);
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
