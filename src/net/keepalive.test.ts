import { assertEquals } from '@std/assert';
import { configureTcpKeepAlive } from './keepalive.ts';

Deno.test('configureTcpKeepAlive — converts seconds to milliseconds', () => {
    const calls: Array<[boolean | undefined, number | undefined]> = [];
    configureTcpKeepAlive({
        setKeepAlive(enable, initialDelay) {
            calls.push([enable, initialDelay]);
        },
    }, 30);
    assertEquals(calls, [[true, 30_000]]);
});

Deno.test('configureTcpKeepAlive — negative value disables probes', () => {
    const calls: Array<[boolean | undefined, number | undefined]> = [];
    configureTcpKeepAlive({
        setKeepAlive(enable, initialDelay) {
            calls.push([enable, initialDelay]);
        },
    }, -1);
    assertEquals(calls, [[false, 0]]);
});

Deno.test('configureTcpKeepAlive — omitted value leaves socket unchanged', () => {
    let called = false;
    configureTcpKeepAlive({
        setKeepAlive() {
            called = true;
        },
    });
    assertEquals(called, false);
});
