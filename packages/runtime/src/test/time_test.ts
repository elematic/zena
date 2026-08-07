/**
 * zena:time on a non-WASI host.
 *
 * The WASI side is covered by tests/language/execution/async/, which
 * runs under wasmtime. This covers the other entry: the same Zena
 * program, compiled with --target host, parking on the runtime's
 * `time` imports instead of `poll_oneoff`. Behaving identically on both
 * is the point of making the host wait blocking rather than
 * callback-driven.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {instantiate, createTimeImports} from '../index.js';

const run = async (source: string) => {
  const wasm = compile(source);
  const result = await instantiate(wasm);
  const instance = (result as {instance?: WebAssembly.Instance}).instance ??
    (result as WebAssembly.Instance);
  return instance.exports as {main: () => number};
};

suite('Runtime - zena:time host integration', () => {
  test('timers complete in deadline order, not call order', async () => {
    const exports = await run(`
      import { Future, drainMicrotasks } from 'zena:async';
      import { sleep } from 'zena:time';

      var log = 0;
      let mark = (n: i32): void => {
        log = log * 10 + n;
      };

      let after = async (ms: i32, n: i32): Future<void> => {
        await sleep(ms);
        mark(n);
      };

      export async function main(): Future<i32> {
        // Armed out of order on purpose.
        let c = after(60, 3);
        let a = after(20, 1);
        let d = after(80, 4);
        let b = after(40, 2);
        await d;
        if (!a.isCompleted || !b.isCompleted || !c.isCompleted) {
          return 0 - 2;
        }
        return log;
      }
    `);
    assert.strictEqual(exports.main(), 1234);
  });

  test('sleep(0) is still asynchronous', async () => {
    const exports = await run(`
      import { Future } from 'zena:async';
      import { sleep } from 'zena:time';

      var log = 0;
      let mark = (n: i32): void => {
        log = log * 10 + n;
      };

      let zero = async (): Future<void> => {
        await sleep(0);
        mark(9);
      };

      export async function main(): Future<i32> {
        let f = zero();
        // Runs before the awaited sleep resumes, despite the 0 delay.
        mark(8);
        await f;
        return log;
      }
    `);
    assert.strictEqual(exports.main(), 89);
  });

  test('sleep actually waits', async () => {
    const exports = await run(`
      import { Future } from 'zena:async';
      import { sleep, monotonicMs } from 'zena:time';

      export async function main(): Future<i32> {
        let start = monotonicMs();
        await sleep(50);
        // Report elapsed milliseconds, floored.
        return (monotonicMs() - start) as i32;
      }
    `);
    const wallStart = Date.now();
    const reported = exports.main();
    const wallElapsed = Date.now() - wallStart;

    // Lower bounds only. An upper bound would be flaky under load, and
    // the guarantee sleep() makes is "at least this long" anyway.
    assert.ok(
      reported >= 45,
      `zena reported ${reported}ms elapsed for a 50ms sleep`,
    );
    assert.ok(
      wallElapsed >= 45,
      `only ${wallElapsed}ms of wall clock passed for a 50ms sleep — ` +
        'the host sleep did not block',
    );
  });

  test('createTimeImports exposes a monotonic clock and a blocking wait', () => {
    const imports = createTimeImports();
    const now = imports['now_ms'] as () => number;
    const sleepMs = imports['sleep_ms'] as (ms: number) => void;

    const before = now();
    sleepMs(20);
    const after = now();
    assert.ok(
      after - before >= 15,
      `clock advanced only ${after - before}ms across a 20ms sleep`,
    );

    // Non-positive durations return immediately rather than throwing.
    sleepMs(0);
    sleepMs(-1);
  });
});
