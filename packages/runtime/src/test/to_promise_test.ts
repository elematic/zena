/**
 * zena:js `toPromise` — a Zena future handed to JavaScript as a promise.
 *
 * Like host_async_test.ts, this can only be tested here: `zena:js`
 * resolves only on the JS-hosted targets. The module under test calls
 * `toPromise` from ordinary synchronous exports, and the test awaits
 * what comes back, so each case is also a check that the promise
 * settles without anything else driving the module.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {
  instantiate,
  createStringReader,
  createStringWriter,
} from '../index.js';

type Exports = Record<string, (...args: unknown[]) => unknown>;

const load = async (source: string): Promise<Exports> => {
  const result = await instantiate(compile(source), {});
  const instance =
    (result as {instance?: WebAssembly.Instance}).instance ??
    (result as WebAssembly.Instance);
  return instance.exports as unknown as Exports;
};

suite('Runtime - zena:js toPromise', () => {
  test('each payload type crosses as its JavaScript value', async () => {
    const exports = await load(`
      import { Future } from 'zena:async';
      import { toPromise } from 'zena:js';

      class Token {
        n: i32;
        new(n: i32) : n = n {}
      }

      async function anI32(): Future<i32> { return 42; }
      async function anF64(): Future<f64> { return 2.5; }
      async function aString(): Future<String> { return 'héllo'; }
      async function nothing(): Future<void> {}
      async function aHostObject(o: anyref): Future<anyref> { return o; }
      async function aToken(): Future<Token> { return new Token(7); }

      export let i32Promise = (): anyref => toPromise(anI32());
      export let f64Promise = (): anyref => toPromise(anF64());
      export let stringPromise = (): anyref => toPromise(aString());
      export let voidPromise = (): anyref => toPromise(nothing());
      export let hostObjectPromise = (o: anyref): anyref =>
          toPromise(aHostObject(o));
      export let tokenPromise = (): anyref => toPromise(aToken());
      export let tokenValue = (t: anyref): i32 => (t as Token).n;
    `);

    assert.strictEqual(await exports.i32Promise(), 42);
    assert.strictEqual(await exports.f64Promise(), 2.5);
    assert.strictEqual(await exports.stringPromise(), 'héllo');
    assert.strictEqual(await exports.voidPromise(), undefined);

    // A host object goes in and comes back as the same object.
    const box = {label: 'mine'};
    assert.strictEqual(await exports.hostObjectPromise(box), box);

    // A Zena object comes back as an opaque reference the module can
    // still read.
    const token = await exports.tokenPromise();
    assert.strictEqual(exports.tokenValue(token), 7);
  });

  test('a failed future rejects with its message', async () => {
    const exports = await load(`
      import { Future } from 'zena:async';
      import { toPromise } from 'zena:js';

      async function broken(): Future<i32> {
        throw new Error('it broke');
      }

      export let failing = (): anyref => toPromise(broken());
    `);

    await assert.rejects(exports.failing() as Promise<unknown>, {
      name: 'Error',
      message: 'it broke',
    });
  });

  test('a cancelled future rejects with an AbortError', async () => {
    const exports = await load(`
      import { Future, Completer, TaskGroup } from 'zena:async';
      import { toPromise } from 'zena:js';

      async function waitFor(gate: Future<i32>): Future<i32> {
        return await gate;
      }

      // The gate never completes, so only the cancellation can settle
      // the member.
      let gate = new Completer<i32>();
      let group = TaskGroup.detached();

      export let parked = (): anyref =>
          toPromise(group.spawn(() => waitFor(gate.future)));
      export let cancel = (): void => group.cancel();
    `);

    const promise = exports.parked() as Promise<unknown>;
    exports.cancel();
    await assert.rejects(promise, {name: 'AbortError'});
  });

  test('promises in flight together settle independently', async () => {
    // Two futures waiting on host timers, the first longer than the
    // second: each promise settles when its own future does, whichever
    // was asked for first.
    const exports = await load(`
      import { Future } from 'zena:async';
      import { toPromise } from 'zena:js';
      import { sleep, milliseconds } from 'zena:time';

      async function after(ms: i64, value: String): Future<String> {
        await sleep(milliseconds(ms));
        return value;
      }

      export let slow = (): anyref => toPromise(after(40, 'slow'));
      export let fast = (): anyref => toPromise(after(5, 'fast'));
    `);

    const order: string[] = [];
    const slow = (exports.slow() as Promise<string>).then((v) => {
      order.push(v);
    });
    const fast = (exports.fast() as Promise<string>).then((v) => {
      order.push(v);
    });
    await Promise.all([slow, fast]);
    assert.deepStrictEqual(order, ['fast', 'slow']);
  });

  test('a future the host settles comes back out as a promise', async () => {
    // Both directions at once: the module awaits a host operation
    // (pending, settled through __zena_complete_string) and hands the
    // result back through toPromise.
    let exports: Exports | undefined;
    const result = await instantiate(
      compile(`
        import { Future } from 'zena:async';
        import { pending, toPromise } from 'zena:js';

        @external("test", "upper")
        declare function __upper(handle: i32, text: String, len: i32): void;

        let upper = (text: String): Future<String> => {
          let p = pending<String>();
          __upper(p.handle, text, text.length);
          return p.future;
        };

        async function greet(name: String): Future<String> {
          let loud = await upper(name);
          return 'hi ' + loud;
        }

        export let greeting = (name: String): anyref => toPromise(greet(name));
      `),
      {
        asyncImports: {
          test: {
            upper: {
              kind: 'string',
              fn: async (ref: unknown, len: number) =>
                createStringReader(exports as unknown as WebAssembly.Exports)(
                  ref,
                  len,
                ).toUpperCase(),
            },
          },
        },
      },
    );
    const instance =
      (result as {instance?: WebAssembly.Instance}).instance ??
      (result as WebAssembly.Instance);
    exports = instance.exports as unknown as Exports;
    const name = createStringWriter(instance.exports)('ada');
    assert.strictEqual(await exports.greeting(name), 'hi ADA');
  });
});
