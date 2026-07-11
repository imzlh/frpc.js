// src/protocol/auth_test.ts — Tests for genPrivKey

import { assertEquals } from '@std/assert';
import { genPrivKey } from './auth.ts';

Deno.test('genPrivKey — produces MD5 hex of token+timestamp', () => {
    const key = genPrivKey('mytoken', 1700000000);
    assertEquals(typeof key, 'string');
    assertEquals(key.length, 32);
    assertEquals(/^[0-9a-f]{32}$/.test(key), true);
});

Deno.test('genPrivKey — empty token + 0 timestamp', () => {
    const key = genPrivKey('', 0);
    assertEquals(key, 'cfcd208495d565ef66e7dff9f98764da');
});

Deno.test('genPrivKey — deterministic', () => {
    const a = genPrivKey('abc', 123);
    const b = genPrivKey('abc', 123);
    assertEquals(a, b);
});

Deno.test('genPrivKey — different token different key', () => {
    const a = genPrivKey('abc', 123);
    const b = genPrivKey('xyz', 123);
    assertEquals(a === b, false);
});
