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
import {suite, test} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {instantiate, run, type ZenaImports} from '../index.js';

const hosted = async (source: string, options?: ZenaImports) => {
  const wasm = compile(source);
  const result = await instantiate(wasm, options);
  const instance =
    (result as {instance?: WebAssembly.Instance}).instance ??
    (result as WebAssembly.Instance);
  return {instance, main: () => run(instance) as Promise<number>};
};

suite('Runtime - zena:fetch', () => {
  test('fetch resolves with status, ok, and a readable body', async () => {
    const requested: string[] = [];
    const mockFetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response('pong');
    }) as typeof fetch;

    const {main} = await hosted(
      `
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
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 4);
    assert.deepStrictEqual(requested, ['https://example.test/ping']);
  });

  test('a 404 is a normal completion, like the web', async () => {
    const mockFetch = (async () =>
      new Response('not here', {
        status: 404,
        statusText: 'Not Found',
      })) as typeof fetch;

    const {main} = await hosted(
      `
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
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 404);
  });

  test('a network rejection fails the future, caught around the await', async () => {
    const mockFetch = (async () => {
      throw new TypeError('network unreachable');
    }) as typeof fetch;

    const {main} = await hosted(
      `
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
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 1);
  });

  test('fetch is disabled by default (opt-in), failing the future', async () => {
    // Calling instantiate without {fetch: ...} disables fetch by default
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

  test('fetch: false explicitly disables fetch', async () => {
    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        try {
          await fetch('https://example.test/disabled');
          return 0 - 1;
        } catch (e) {
          return 1;
        }
      }
    `,
      {fetch: false},
    );
    assert.strictEqual(await main(), 1);
  });

  test('fetch: true uses globalThis.fetch', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('global')) as typeof fetch;
      const {main} = await hosted(
        `
        import { Future } from 'zena:async';
        import { fetch } from 'zena:fetch';

        export async function main(): Future<i32> {
          let response = await fetch('https://example.test/global');
          let body = await response.text();
          return body.length;
        }
      `,
        {fetch: true},
      );
      assert.strictEqual(await main(), 6);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('web: false omits web namespace, causing link failure', async () => {
    const wasm = compile(`
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/link-error');
        return response.status;
      }
    `);
    await assert.rejects(
      async () => instantiate(wasm, {web: false}),
      (err: unknown) =>
        err instanceof TypeError || err instanceof WebAssembly.LinkError,
    );
  });

  test('the body reads once; a second text() throws', async () => {
    const mockFetch = (async () => new Response('once')) as typeof fetch;

    // A local carried across a try that holds an await and a return —
    // the shape that once miscompiled by silently skipping the catch
    // (found by this very test, fixed 2026-08-14). Kept in its direct
    // form as the regression guard.
    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/body');
        let first = await response.text();
        try {
          await response.text();
          return 0 - 1;
        } catch (e) {
          return first.length;
        }
      }
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 4);
  });

  test('a status-only response carries no release obligation', async () => {
    const mockFetch = (async () =>
      new Response('unread', {status: 202})) as typeof fetch;

    // The response crosses as a reference the unified GC owns, so a
    // caller that never reads the body holds nothing that needs
    // releasing — no `using`, no dispose().
    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/head');
        return response.status;
      }
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 202);
  });

  test('response.header(name) reads headers case-insensitively and returns null when missing', async () => {
    const mockFetch = (async () =>
      new Response('ok', {
        headers: {
          'Content-Type': 'text/plain',
          'X-Custom': 'custom-value',
        },
      })) as typeof fetch;

    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/headers');
        let contentType = response.header('content-type');
        let xCustom = response.header('X-Custom');
        let missing = response.header('x-missing');
        if (contentType == null || !(contentType == 'text/plain')) {
          return 0 - 1;
        }
        if (xCustom == null || !(xCustom == 'custom-value')) {
          return 0 - 2;
        }
        if (missing != null) {
          return 0 - 3;
        }
        return 0;
      }
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 0);
  });

  test('web imports can be directly overridden', async () => {
    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/override');
        return response.status;
      }
    `,
      {
        fetch: async () => new Response(null, {status: 200}),
        web: {
          response_status: () => 999,
        },
      },
    );
    // Overridden response_status returns 999
    assert.strictEqual(await main(), 999);
  });

  test('fetch sends method, headers, and a text body', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenAuth = '';
    let seenCustom = '';
    let seenBody = '';
    const mockFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      seenAuth = headers.get('authorization') ?? '';
      seenCustom = headers.get('x-custom') ?? '';
      seenBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('created', {status: 201});
    }) as typeof fetch;

    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let response = await fetch('https://example.test/items', {
          method: 'POST',
          headers: [
            ('authorization', 'Bearer tok'),
            ('x-custom', 'val'),
          ],
          body: '{"name":"widget"}',
        });
        let text = await response.text();
        return if (text == 'created') response.status else 0 - 1;
      }
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 201);
    assert.strictEqual(seenUrl, 'https://example.test/items');
    assert.strictEqual(seenMethod, 'POST');
    assert.strictEqual(seenAuth, 'Bearer tok');
    assert.strictEqual(seenCustom, 'val');
    assert.strictEqual(seenBody, '{"name":"widget"}');
  });

  test('a timeout aborts the request through its signal', async () => {
    let seenSignal: AbortSignal | undefined;
    // Never answers, unless the request's signal aborts it.
    const mockFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal!.reason),
        );
      });
    }) as typeof fetch;

    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';
      import { milliseconds } from 'zena:time';

      export async function main(): Future<i32> {
        try {
          await fetch('https://example.test/slow', {timeout: milliseconds(50 as i64)});
          return 1;
        } catch (e) {
          return 2;
        }
      }
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 2);
    assert.ok(seenSignal?.aborted, 'the signal aborted');
  });

  test('fetch sends a byte body and reads response.bytes() once', async () => {
    let seenBytes: number[] = [];
    const mockFetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.body instanceof Uint8Array) {
        seenBytes = Array.from(init.body);
      }
      return new Response(new Uint8Array([10, 20, 255]));
    }) as typeof fetch;

    const {main} = await hosted(
      `
      import { Future } from 'zena:async';
      import { fetch } from 'zena:fetch';

      export async function main(): Future<i32> {
        let payload = new FixedArray<u8>(3, 0 as u8);
        payload[0] = 1 as u8;
        payload[1] = 2 as u8;
        payload[2] = 250 as u8;
        let response = await fetch('https://example.test/bytes', {
          method: 'PUT',
          body: payload,
        });
        let out = await response.bytes();
        if (out.length != 3 || out[0] != (10 as u8) || out[1] != (20 as u8) || out[2] != (255 as u8)) {
          return 0 - 1;
        }
        try {
          await response.bytes();
          return 0 - 2;
        } catch (e) {
          return out.length;
        }
      }
    `,
      {fetch: mockFetch},
    );
    assert.strictEqual(await main(), 3);
    assert.deepStrictEqual(seenBytes, [1, 2, 250]);
  });
});
