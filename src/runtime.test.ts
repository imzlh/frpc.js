// src/runtime_test.ts - Runtime shim tests

import { assertEquals } from '@std/assert';
import { runtimeHostname } from './runtime.ts';

Deno.test('runtimeHostname — returns a string', () => {
    assertEquals(typeof runtimeHostname(), 'string');
});
