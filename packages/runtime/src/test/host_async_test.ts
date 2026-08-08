/**
 * zena:host-async — futures a JS host settles (docs/design/async.md §4,
 * Level 2).
 *
 * This is the only place the Level-2 path can be tested: it needs a host
 * with an event loop of its own, which is exactly what the portable
 * tests under tests/language/execution/async/ do not have. Those cover
 * the registry itself (`external_completions.zena`), driving it with no
 * host at all; this covers the boundary — the `__zena_complete_*`
 * exports, and the outstanding-work accounting `run()` depends on.
 *
 * Every test here goes through `run()` rather than calling `main`,
 * because on a host that cannot block an async `main` returns before its
 * host work has finished. That is the whole point of the split entry.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {
  instantiate,
  createStringReader,
  isAsyncMain,
  run,
  runSync,
  type CompletionKind,
} from '../index.js';

interface AsyncImport {
  kind: CompletionKind;
  fn: (...args: any[]) => PromiseLike<unknown> | unknown;
}

/**
 * Compile `source` for the host target and wire `test.*` async imports.
 *
 * The string reader is bound after instantiation and captured by
 * reference: imports cannot run before the instance exists, so a
 * deferred binding is safe and avoids threading exports through every
 * test.
 */
const hosted = async (source: string, imports: Record<string, AsyncImport>) => {
  const wasm = compile(source);
  const result = await instantiate(wasm, {asyncImports: {test: imports}});
  const instance =
    (result as {instance?: WebAssembly.Instance}).instance ??
    (result as WebAssembly.Instance);
  const readString = createStringReader(instance.exports);
  return {
    instance,
    main: () => run(instance) as Promise<number>,
    read: (ref: unknown, len: number) => readString(ref, len),
  };
};

/** The Zena half of a `test.echo` binding, shared by several cases. */
const ECHO_BINDING = `
  @external("test", "echo")
  declare function __echo(handle: i32, text: String, len: i32): void;

  let echo = (text: String): Future<String> => {
    let p = pending<String>();
    __echo(p.handle, text, text.length);
    return p.future;
  };
`;

suite('Runtime - zena:host-async', () => {
  test('a host promise settles the future the module awaits', async () => {
    let read: (ref: unknown, len: number) => string;
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';
      ${ECHO_BINDING}

      export async function main(): Future<i32> {
        let shout = await echo('hello');
        // 'HELLO' round-tripped: the host produced this string, and the
        // module is reading it back as an ordinary Zena String.
        if (!(shout == 'HELLO')) {
          return 0 - 1;
        }
        return shout.length;
      }
    `,
      {
        echo: {
          kind: 'string',
          fn: (ref: unknown, len: number) =>
            Promise.resolve(read(ref, len).toUpperCase()),
        },
      },
    );
    read = hostedModule.read;
    assert.strictEqual(await hostedModule.main(), 5);
  });

  test('the completion exports exist only where they are used', async () => {
    const withHostAsync = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';
      ${ECHO_BINDING}

      export async function main(): Future<i32> {
        return (await echo('x')).length;
      }
    `,
      {echo: {kind: 'string', fn: () => Promise.resolve('x')}},
    );
    const names = [
      '__zena_complete_void',
      '__zena_complete_i32',
      '__zena_complete_f64',
      '__zena_complete_string',
      '__zena_complete_error',
    ];
    for (const name of names) {
      assert.strictEqual(
        typeof withHostAsync.instance.exports[name],
        'function',
        `${name} should be exported`,
      );
    }

    // A program that awaits but does no host I/O pays nothing for it.
    const withoutHostAsync = await hosted(
      `
      import { Future, Completer } from 'zena:async';

      export async function main(): Future<i32> {
        let c = new Completer<i32>();
        c.complete(3);
        return await c.future;
      }
    `,
      {},
    );
    for (const name of names) {
      assert.strictEqual(
        withoutHostAsync.instance.exports[name],
        undefined,
        `${name} should not be exported`,
      );
    }
    assert.strictEqual(await withoutHostAsync.main(), 3);
  });

  test('each payload kind round-trips', async () => {
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';

      @external("test", "later_void")
      declare function __later_void(handle: i32): void;
      @external("test", "later_i32")
      declare function __later_i32(handle: i32, n: i32): void;
      @external("test", "later_f64")
      declare function __later_f64(handle: i32, x: f64): void;

      export async function main(): Future<i32> {
        let v = pending<void>();
        __later_void(v.handle);
        await v.future;

        let i = pending<i32>();
        __later_i32(i.handle, 20);
        let n = await i.future;

        let f = pending<f64>();
        __later_f64(f.handle, 1.5);
        let x = await f.future;

        // 20 doubled is 40; 1.5 doubled is 3.0.
        return n * 2 + ((x * 2.0) as i32);
      }
    `,
      {
        later_void: {kind: 'void', fn: () => Promise.resolve()},
        later_i32: {kind: 'i32', fn: (n: number) => Promise.resolve(n)},
        later_f64: {kind: 'f64', fn: (x: number) => Promise.resolve(x)},
      },
    );
    assert.strictEqual(await hostedModule.main(), 43);
  });

  test('completing a handle with the wrong payload type is loud', async () => {
    // The registry's only type check, and it is exact: the completer's
    // own specialized type is the tag. Here the binding registers a
    // String but the host is wired to complete an i32.
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';

      @external("test", "confused")
      declare function __confused(handle: i32): void;

      export async function main(): Future<i32> {
        let p = pending<String>();
        __confused(p.handle);
        return (await p.future).length;
      }
    `,
      {confused: {kind: 'i32', fn: () => Promise.resolve(7)}},
    );
    await assert.rejects(hostedModule.main());
  });

  test('a rejected promise becomes a catchable Zena failure', async () => {
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';
      import { Error } from 'zena:error';
      ${ECHO_BINDING}

      export async function main(): Future<i32> {
        try {
          let s = await echo('anything');
          return 0 - 1;
        } catch (e) {
          // The rejection's message crossed the boundary intact.
          if (e.message == 'the network is on fire') {
            return 7;
          }
          return 0 - 2;
        }
      }
    `,
      {
        echo: {
          kind: 'string',
          fn: () => Promise.reject(new Error('the network is on fire')),
        },
      },
    );
    assert.strictEqual(await hostedModule.main(), 7);
  });

  test('completions are delivered in the order the host finished them', async () => {
    let read: (ref: unknown, len: number) => string;
    // Started first, finishes last: the module must observe the host's
    // completion order, not its own call order.
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';
      import { StringBuilder } from 'zena:string-builder';
      ${ECHO_BINDING}

      var log = new StringBuilder();

      let record = async (text: String): Future<void> => {
        let got = await echo(text);
        log.append(got);
      };

      export async function main(): Future<i32> {
        let slow = record('slow');
        let fast = record('fast');
        await slow;
        await fast;
        if (!(log.toString() == 'fastslow')) {
          return 0 - 1;
        }
        return 1;
      }
    `,
      {
        echo: {
          kind: 'string',
          fn: (ref: unknown, len: number) => {
            const text = read(ref, len);
            return new Promise((resolve) =>
              setTimeout(() => resolve(text), text === 'slow' ? 30 : 5),
            );
          },
        },
      },
    );
    read = hostedModule.read;
    assert.strictEqual(await hostedModule.main(), 1);
  });

  test('host work and timers interleave on one drain loop', async () => {
    let read: (ref: unknown, len: number) => string;
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';
      import { sleep } from 'zena:time';
      import { StringBuilder } from 'zena:string-builder';
      ${ECHO_BINDING}

      var log = new StringBuilder();

      let hostWork = async (): Future<void> => {
        log.append(await echo('host'));
      };

      let timerWork = async (): Future<void> => {
        await sleep(25);
        log.append('timer');
      };

      export async function main(): Future<i32> {
        let a = hostWork();
        let b = timerWork();
        await a;
        await b;
        // The host echo resolves at ~5ms, the timer at ~25ms.
        if (!(log.toString() == 'hosttimer')) {
          return 0 - 1;
        }
        return 2;
      }
    `,
      {
        echo: {
          kind: 'string',
          fn: (ref: unknown, len: number) => {
            const text = read(ref, len);
            return new Promise((resolve) => setTimeout(() => resolve(text), 5));
          },
        },
      },
    );
    read = hostedModule.read;
    assert.strictEqual(await hostedModule.main(), 2);
  });

  test('run() waits for host work started after main returned', async () => {
    let read: (ref: unknown, len: number) => string;
    // A chain: the first completion is what starts the second, so `run()`
    // cannot resolve on the first quiet moment. This is the case the
    // shared outstanding-work count exists for.
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { pending } from 'zena:host-async';
      ${ECHO_BINDING}

      export async function main(): Future<i32> {
        var s = 'a';
        var n = 0;
        while (n < 4) {
          s = await echo(s);
          n += 1;
        }
        return s.length;
      }
    `,
      {
        echo: {
          kind: 'string',
          fn: (ref: unknown, len: number) => {
            const text = read(ref, len);
            return new Promise((resolve) =>
              setTimeout(() => resolve(text + 'a'), 5),
            );
          },
        },
      },
    );
    read = hostedModule.read;
    assert.strictEqual(await hostedModule.main(), 5);
  });
});

suite('Runtime - runSync / run', () => {
  test('runSync returns a synchronous main directly', async () => {
    const hostedModule = await hosted(
      `export function main(): i32 { return 41 + 1; }`,
      {},
    );
    assert.strictEqual(isAsyncMain(hostedModule.instance), false);
    assert.strictEqual(runSync(hostedModule.instance), 42);
    // run() still works on a sync main, resolving on the first turn.
    assert.strictEqual(await hostedModule.main(), 42);
  });

  test('runSync throws on an async main rather than guessing', async () => {
    const hostedModule = await hosted(
      `
      import { Future } from 'zena:async';
      import { sleep } from 'zena:time';

      export async function main(): Future<i32> {
        await sleep(1);
        return 5;
      }
    `,
      {},
    );
    assert.strictEqual(isAsyncMain(hostedModule.instance), true);
    assert.throws(() => runSync(hostedModule.instance), /async/);
    assert.strictEqual(await hostedModule.main(), 5);
  });
});
