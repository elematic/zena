/**
 * zena:fetch — HTTP over the host's own fetch() (docs/design/async.md
 * §4, Level 2; the module is stdlib/zena/fetch/host.zena).
 *
 * The runtime supplies the `web.fetch_text` import by default, backed by
 * `globalThis.fetch` — these tests replace that global with a recording
 * stub, so they exercise the real default binding end to end (URL out,
 * body back in, failures as failed futures) without touching a network.
 *
 * Everything runs through `run()`: an async `main` returns before its
 * request has come back, and the outstanding-work accounting is part of
 * what is under test here.
 */
import {suite, test, afterEach} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {instantiate, run} from '../index.js';

const hosted = async (source: string) => {
  const wasm = compile(source);
  const result = await instantiate(wasm);
  const instance =
    (result as {instance?: WebAssembly.Instance}).instance ??
    (result as WebAssembly.Instance);
  return {instance, main: () => run(instance) as Promise<number>};
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

suite('Runtime - zena:fetch', () => {
  test('fetchText resolves with the response body', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response('pong');
    }) as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetchText } from 'zena:fetch';

      export async function main(): Future<i32> {
        let body = await fetchText('https://example.test/ping');
        if (!(body == 'pong')) {
          return 0 - 1;
        }
        return body.length;
      }
    `);
    assert.strictEqual(await main(), 4);
    assert.deepStrictEqual(requested, ['https://example.test/ping']);
  });

  test('a non-2xx status fails the future, caught around the await', async () => {
    globalThis.fetch = (async () =>
      new Response('missing', {
        status: 404,
        statusText: 'Not Found',
      })) as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetchText } from 'zena:fetch';

      export async function main(): Future<i32> {
        try {
          let body = await fetchText('https://example.test/absent');
          return 0 - body.length;
        } catch (e) {
          return 1;
        }
      }
    `);
    assert.strictEqual(await main(), 1);
  });

  test('a network rejection fails the future the same way', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network unreachable');
    }) as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetchText } from 'zena:fetch';

      export async function main(): Future<i32> {
        try {
          await fetchText('https://example.test/down');
          return 0 - 1;
        } catch (e) {
          return 1;
        }
      }
    `);
    assert.strictEqual(await main(), 1);
  });

  test('a host with no fetch() fails the future, not instantiation', async () => {
    globalThis.fetch = undefined as unknown as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetchText } from 'zena:fetch';

      export async function main(): Future<i32> {
        try {
          await fetchText('https://example.test/anywhere');
          return 0 - 1;
        } catch (e) {
          return 1;
        }
      }
    `);
    assert.strictEqual(await main(), 1);
  });

  test('a user-supplied web import overrides the default', async () => {
    globalThis.fetch = (async () => {
      throw new Error('the default binding should not run');
    }) as typeof fetch;

    const wasm = compile(`
      import { Future } from 'zena:async';
      import { fetchText } from 'zena:fetch';

      export async function main(): Future<i32> {
        return (await fetchText('anything')).length;
      }
    `);
    const result = await instantiate(wasm, {
      asyncImports: {
        web: {fetch_text: {kind: 'string', fn: () => 'stubbed'}},
      },
    });
    const instance =
      (result as {instance?: WebAssembly.Instance}).instance ??
      (result as WebAssembly.Instance);
    assert.strictEqual(await run(instance), 'stubbed'.length);
  });
});
