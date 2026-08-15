/**
 * zena:time on a non-WASI host.
 *
 * The WASI side is covered by tests/language/execution/async/, which
 * runs under wasmtime. This covers the other entry: the same Zena
 * program, compiled with --target host, parking on the runtime's
 * `time` imports instead of `poll_oneoff`.
 *
 * The host never waits: its clock schedules a `setTimeout` that pings
 * `__zena_drain`, and the drain unwinds in between. Both halves of that
 * matter and both are asserted — the observable results match the WASI
 * target exactly, and the JS event loop keeps running throughout.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {
  instantiate,
  createTimeHost,
  createStringReader,
  run,
} from '../index.js';

const run_ = async (source: string) => {
  const wasm = compile(source);
  const result = await instantiate(wasm);
  const instance =
    (result as {instance?: WebAssembly.Instance}).instance ??
    (result as WebAssembly.Instance);
  // run() drives the split entry: start the program, let the event loop
  // deliver each wake, then read the result.
  return () => run(instance) as Promise<number>;
};

suite('Runtime - zena:time host integration', () => {
  test('timers complete in deadline order, not call order', async () => {
    const main = await run_(`
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
    assert.strictEqual(await main(), 1234);
  });

  // What an embedder with its own output pane does — the playground's
  // worker being the one in this repo. It overrides `console`'s string
  // methods and leaves every other import to instantiate(), which is the
  // only way it gets `time` at all: a hand-rolled import object that
  // forgets it fails to instantiate the moment a program calls sleep().
  test('an embedder sees output from both sides of an await', async () => {
    const wasm = compile(`
      import { sleep } from 'zena:time';

      export async function main() {
        console.log('A');
        await sleep(20);
        console.log('B');
      }
    `);

    const logs: string[] = [];
    let exports: WebAssembly.Exports | undefined;
    const result = await instantiate(wasm, {
      console: {
        log_string: (strRef: unknown, length: number) => {
          logs.push(createStringReader(exports!)(strRef, length));
        },
      },
    });
    const instance =
      (result as {instance?: WebAssembly.Instance}).instance ??
      (result as WebAssembly.Instance);
    exports = instance.exports;

    // 'B' is on the far side of a timer, so it arrives because run()
    // drives the event loop — not because main() returned.
    assert.deepStrictEqual(logs, []);
    await run(instance);
    assert.deepStrictEqual(logs, ['A', 'B']);
  });

  test('sleep(0) is still asynchronous', async () => {
    const main = await run_(`
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
    assert.strictEqual(await main(), 89);
  });

  test('sleep actually waits', async () => {
    const main = await run_(`
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
    const reported = await main();
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
        'the timer did not actually delay anything',
    );
  });

  test('the event loop keeps running while wasm sleeps', async () => {
    const main = await run_(`
      import { Future } from 'zena:async';
      import { sleep } from 'zena:time';

      export async function main(): Future<i32> {
        await sleep(80);
        return 7;
      }
    `);

    // The whole point: JS work scheduled during the sleep must run. If
    // the host blocked instead of unwinding, this counter would stay 0.
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    const result = await main();
    clearInterval(interval);

    assert.strictEqual(result, 7);
    assert.ok(
      ticks >= 2,
      `the event loop ticked ${ticks} times during an 80ms sleep — ` +
        'the host blocked instead of unwinding the drain',
    );
  });

  test('createTimeHost reports idle only once timers have elapsed', async () => {
    // No instance behind it: the timer never gets to complete anything,
    // which is fine here — what is under test is the outstanding-work
    // accounting `run()` waits on, not the completion itself.
    const host = createTimeHost(() => undefined);
    const now = host.imports['now_ms'] as () => number;
    const sleepMs = host.imports['sleep_ms'] as (
      handle: number,
      ms: number,
    ) => void;

    assert.ok(typeof now() === 'number', 'now_ms must return a number');

    // Idle immediately when nothing is scheduled.
    await host.idle();

    sleepMs(1, 30);
    let settled = false;
    const waiting = host.idle().then(
      () => {
        settled = true;
      },
      () => {
        // Completing into a module that does not exist fails, and that
        // failure is reported through idle(). Either way it is no longer
        // outstanding, which is what this asserts.
        settled = true;
      },
    );
    assert.strictEqual(settled, false, 'idle resolved with a timer pending');
    await waiting;
    assert.strictEqual(settled, true);
  });
});
