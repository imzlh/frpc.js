// src/runtime.ts - Small runtime shims for Deno and Node entrypoints

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { hostname as nodeHostname } from 'node:os';
import process from 'node:process';
import {
    arch as nodeArch,
    argv as nodeArgv,
    cwd as nodeCwd,
    exit as nodeExit,
    platform as nodePlatform,
} from 'node:process';

interface DenoLike {
    args: string[];
    build: { os: string; arch: string };
    cwd(): string;
    exit(code?: number): never;
    addSignalListener(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
}

export interface RuntimeInfo {
    os: string;
    arch: string;
}

function denoGlobal(): DenoLike | undefined {
    return (globalThis as unknown as { Deno?: DenoLike }).Deno;
}

export function runtimeArgs(): string[] {
    return denoGlobal()?.args ?? nodeArgv.slice(2);
}

export function runtimeCwd(): string {
    return denoGlobal()?.cwd() ?? nodeCwd();
}

export function runtimeExit(code: number): never {
    const deno = denoGlobal();
    if (deno) return deno.exit(code);
    nodeExit(code);
}

export function addRuntimeSignalListener(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void {
    const deno = denoGlobal();
    if (deno) {
        deno.addSignalListener(signal, handler);
        return;
    }
    process.on(signal, handler);
}

export function getRuntimeInfo(): RuntimeInfo {
    const deno = denoGlobal();
    if (deno) return deno.build;

    return {
        os: nodePlatform,
        arch: normalizeNodeArch(nodeArch),
    };
}

export function runtimeRandomUUID(): string {
    return globalThis.crypto?.randomUUID?.() ?? nodeRandomUUID();
}

export function runtimeHostname(): string {
    try {
        return nodeHostname();
    } catch {
        return '';
    }
}

function normalizeNodeArch(arch: string): string {
    if (arch === 'x64') return 'x86_64';
    if (arch === 'arm64') return 'aarch64';
    return arch;
}
