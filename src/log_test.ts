// src/log_test.ts — Tests for ConsoleLogger

import { assertEquals } from '@std/assert';
import { ConsoleLogger } from './log.ts';

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
