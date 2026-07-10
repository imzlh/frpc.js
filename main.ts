/**
 * frpc - frp client for Deno/Node-compatible runtimes
 *
 * Usage:
 *   deno run -A main.ts ./my.config.ts
 *   npx tsx main.ts ./my.config.ts
 *   ../cno-cli/build/stage/cno main.ts ./my.config.ts
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FrpClient } from './src/client.ts';
import { addRuntimeSignalListener, runtimeArgs, runtimeCwd, runtimeExit } from './src/runtime.ts';
import { hasServerConfig } from './src/types.ts';
import type { IConfig } from './src/types.ts';

async function loadConfig(path: string): Promise<IConfig> {
    const resolved = isAbsolute(path) ? path : resolve(runtimeCwd(), path);
    const specifier = pathToFileURL(resolved).href;

    if (path.endsWith('.ts')) {
        const mod = await import(specifier);
        const config = mod.default ?? mod;
        if (!config?.proxies || !hasServerConfig(config)) {
            throw new Error('Config must export a default IConfig with .server or .serverAddr/.serverPort and .proxies');
        }
        return config as IConfig;
    }

    const mod = await import(specifier);
    const config = mod.default ?? mod;
    if (!config?.proxies || !hasServerConfig(config)) {
        throw new Error('Config must export a default IConfig with .server or .serverAddr/.serverPort and .proxies');
    }
    return config as IConfig;
}

async function main(): Promise<void> {
    const configPath = runtimeArgs()[0];

    if (!configPath) {
        console.error('Usage: deno run -A main.ts <config.ts>');
        console.error('   or: npx tsx main.ts <config.ts>');
        console.error('   or: ../cno-cli/build/stage/cno main.ts <config.ts>');
        runtimeExit(1);
    }

    let config: IConfig;
    try {
        config = await loadConfig(configPath);
    } catch (err) {
        console.error('[frpc] Failed to load config:', (err as Error).message);
        runtimeExit(1);
    }

    const client = new FrpClient(config);

    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.info('[frpc] Shutting down…');
        client.stop();
    };

    addRuntimeSignalListener('SIGINT', shutdown);
    addRuntimeSignalListener('SIGTERM', shutdown);

    try {
        await client.start();
    } catch (err) {
        console.error('[frpc] Fatal:', err);
        if (config.hooks?.onError) {
            await Promise.resolve(config.hooks.onError(err as Error));
        }
        runtimeExit(1);
    }
}

main();
