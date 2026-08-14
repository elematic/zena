/**
 * zena:fetch — HTTP over the host's own fetch() (docs/design/async.md
 * §4, Level 2; the module is stdlib/zena/fetch/host.zena).
 *
 * The runtime supplies the `web.*` imports by default, backed by
 * `globalThis.fetch` — these tests replace that global with a stub, so
 * they exercise the real default binding end to end (URL out, status
 * and body back in, failures as failed futures) without touching a
 * network.
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
  test('fetch resolves with status, ok, and a readable body', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response('pong');
    }) as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/ping');
        if (!response.ok || response.status != 200) {
          return 0 - 1;
        }
        let body = await response.text();
        if (!(body == 'pong')) {
          return 0 - 2;
        }
        return body.length;
      }
    `);
    assert.strictEqual(await main(), 4);
    assert.deepStrictEqual(requested, ['https://example.test/ping']);
  });

  test('a 404 is a normal completion, like the web', async () => {
    globalThis.fetch = (async () =>
      new Response('not here', {
        status: 404,
        statusText: 'Not Found',
      })) as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/absent');
        if (response.ok) {
          return 0 - 1;
        }
        // The error page's body is still there for whoever wants it.
        let body = await response.text();
        if (!(body == 'not here')) {
          return 0 - 2;
        }
        return response.status;
      }
    `);
    assert.strictEqual(await main(), 404);
  });

  test('a network rejection fails the future, caught around the await', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network unreachable');
    }) as typeof fetch;

    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        try {
          await fetch('https://example.test/down');
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
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        try {
          await fetch('https://example.test/anywhere');
          return 0 - 1;
        } catch (e) {
          return 1;
        }
      }
    `);
    assert.strictEqual(await main(), 1);
  });

  test('the body reads once; a second text() throws', async () => {
    globalThis.fetch = (async () => new Response('once')) as typeof fetch;

    // The try/catch lives in a helper that returns from both arms: a
    // local carried across a try that holds an await and a return is
    // the miscompile in BUGS.md ("A local live across a try…"), and
    // this test found its silent form.
    const {main} = await hosted(`
      import { Future } from 'zena:async';
      import { fetch, Response } from 'zena:fetch';

      let secondReadThrew = async (response: Response): Future<boolean> => {
        try {
          await response.text();
          return false;
        } catch (e) {
          return true;
        }
      };

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/body');
        let first = await response.text();
        if (!(await secondReadThrew(response))) {
          return 0 - 1;
        }
        return first.length;
      }
    `);
    assert.strictEqual(await main(), 4);
  });
});
