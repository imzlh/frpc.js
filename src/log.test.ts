// src/log_test.ts — Tests for ConsoleLogger

import { assertEquals } from '@std/assert';
import { ConsoleLogger, formatError, type Logger, withLogScope } from './log.ts';
Deno.test('ConsoleLogger — info level filters debug', () => {
    const log = new ConsoleLogger('info');
    const captured: string[] = [];
    const orig = console.debug;
    console.debug = (...args: unknown[]) => captured.push(String(args[0]));
    log.debug('should not appear');
    console.debug = orig;
    assertEquals(captured.length, 0);
});

Deno.test('ConsoleLogger — debug level allows all', () => {
    const log = new ConsoleLogger('debug');
    const captured: string[] = [];
    const orig = console.debug;
    console.debug = (...args: unknown[]) => captured.push(String(args[0]));
    log.debug('visible');
    console.debug = orig;
    assertEquals(captured.length, 1);
});

Deno.test('ConsoleLogger — error level filters info', () => {
    const log = new ConsoleLogger('error');
    const captured: string[] = [];
    const orig = console.info;
    console.info = (...args: unknown[]) => captured.push(String(args[0]));
    log.info('should not appear');
    console.info = orig;
    assertEquals(captured.length, 0);
});

Deno.test('ConsoleLogger — prefix applied', () => {
    const log = new ConsoleLogger('info', '[test]');
    const captured: string[] = [];
    const orig = console.info;
    console.info = (...args: unknown[]) => captured.push(String(args[0]));
    log.info('hello');
    console.info = orig;
    assertEquals(captured[0], '[test] hello');
});

Deno.test('withLogScope — preserves level and adds scope', () => {
    const entries: Array<[string, string]> = [];
    const logger: Logger = {
        debug: (msg) => entries.push(['debug', msg]),
        info: (msg) => entries.push(['info', msg]),
        warn: (msg) => entries.push(['warn', msg]),
        error: (msg) => entries.push(['error', msg]),
    };

    withLogScope(logger, 'pool').warn('connection failed');

    assertEquals(entries, [['warn', 'pool: connection failed']]);
});

Deno.test('withLogScope — composes ConsoleLogger scopes into one prefix', () => {
    const captured: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => captured.push(String(args[0]));
    try {
        withLogScope(new ConsoleLogger('info'), 'webui').info('started');
    } finally {
        console.info = original;
    }
    assertEquals(captured, ['[frpc:webui] started']);
});

Deno.test('formatError — includes nested causes', () => {
    const error = new Error('outer', { cause: new TypeError('inner') });
    assertEquals(formatError(error), 'Error: outer; cause: TypeError: inner');
});

Deno.test('formatError — handles circular causes', () => {
    const error = new Error('loop');
    Object.defineProperty(error, 'cause', { value: error });
    assertEquals(formatError(error), 'Error: loop; cause: Error: loop (circular cause)');
});
