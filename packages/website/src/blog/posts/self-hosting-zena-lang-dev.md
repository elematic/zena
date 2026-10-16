---
title: 'Self-Hosting zena-lang.dev on zena:http (and Reaching 315k req/s)'
description: 'zena-lang.dev now runs on a Zena HTTP server compiled to a WebAssembly component. Here is how zena:http works, what it includes, and how we took it from 1,431 req/s to 314,982 req/s—over 4x faster than Fastify.'
date: 2026-10-16T04:00:00Z
author: justinfagnani
tags:
  - announcements
  - performance
hero:
  image: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1600&q=80'
  alt: 'Rows of illuminated server racks in a data center'
  credit: 'Photo by Taylor Vick on Unsplash'
---

As of today, [zena-lang.dev](https://zena-lang.dev) is served by a Zena program running on `zena:http` and `zena-run`.

Previously, the website container ran Node.js and served the static Eleventy output with [Zipadee](https://github.com/justinfagnani/zipadee). Replacing that server with Zena was a practical milestone for dogfooding `zena:http` in production, and it prompted a round of profiling across the HTTP library, memory allocator, and WASI host integration that took our JSON benchmark throughput from **1,431 req/s** to **314,982 req/s**—over **4× faster than Fastify** on the same machine.

This post walks through the production server running `zena-lang.dev`, the design of `zena:http`, and the runtime and WIT changes behind those numbers.

## The Server Running `zena-lang.dev`

The entire production server (`packages/website/zena/server.zena`) is 55 lines of Zena:

```zena
import { getEnv } from 'zena:env';
import { exists } from 'zena:fs';
import { App, HttpError, Request, Response, send, serve } from 'zena:http';
import { parseInt } from 'zena:Number';

let resolveSiteDir = (): String => {
  let envDir = getEnv('ZENA_SITE_DIR');
  if (envDir != '') {
    return envDir;
  }
  if (exists('packages/website/_site')) {
    return 'packages/website/_site';
  }
  return '_site';
};

export let main = async () => {
  let portStr = getEnv('PORT');
  var port = 8080;
  if (portStr != '') {
    if (let (true, parsed) = parseInt(portStr)) {
      port = parsed;
    }
  }

  let siteDir = resolveSiteDir();
  let app = new App();

  let setHeaders = (res: Response, path: String): void => {
    if (path.endsWith('.wasm')) {
      res.headers['Cache-Control'] = 'public, max-age=3600';
    } else if (
      path.endsWith('.css') ||
      path.endsWith('.js') ||
      path.endsWith('.woff2') ||
      path.endsWith('.png') ||
      path.endsWith('.jpg') ||
      path.endsWith('.svg')
    ) {
      res.headers['Cache-Control'] = 'public, max-age=86400';
    } else {
      res.headers['Cache-Control'] = 'public, max-age=600';
    }
  };

  app.use(serve(siteDir, { setHeaders }));

  app.use(async (req: Request, res: Response, next) => {
    if (req.method == 'GET' || req.method == 'HEAD') {
      let sent = await send(req, res, '404.html', { root: siteDir, setHeaders });
      if (sent) {
        res.status = 404;
        return;
      }
    }
    throw new HttpError(404);
  });

  let server = app.listen(port);
  console.log(`zena-lang.dev listening on http://localhost:${server.port} (serving ${siteDir})`);
};
```

During the Docker build, `zena build` compiles `server.zena` to a WASI 0.3 component (`server.wasm`), and `zena-run --precompile` compiles that component ahead of time into a native Cranelift artifact (`server.cwasm`). The final container image copies only the `zena-run` binary, `server.cwasm`, and the static `_site` directory (with pre-compressed `.br` and `.gz` sidecar files), starting in milliseconds without JIT compilation at cold start.

## What Is in `zena:http`

`zena:http` is an async middleware framework modeled after Zipadee and Koa, built on WASI 0.3 async tasks and streams.

### Composable Async Middleware

An `App` runs an ordered pipeline of middleware functions with the signature:

```zena
type Handler = (req: Request, res: Response, next: Next) => Promise<void>;
```

Calling `await next()` invokes the downstream middleware and resumes when it completes, making logging, timing, authentication, and error recovery straightforward:

```zena
import { App } from 'zena:http';

let app = new App();

app.use(async (req, res, next) => {
  let start = performance.now();
  await next();
  res.headers['X-Response-Time'] = `${performance.now() - start}ms`;
});
```

Pipelines can also be combined with `compose([...])` or mounted at a path prefix with `mount('/api', apiHandler)`, which strips the prefix for the inner handler and restores `req.path` afterward.

### Routing

`Router` dispatches by HTTP method and path pattern, supporting named parameters (`:name`) and wildcard tails (`*`):

```zena
import { App, Router } from 'zena:http';

let router = new Router();

router.get('/users/:id', async (req, res, next) => {
  let id = req.params['id'];
  res.json(`{"id":"${id}"}`);
});

router.get('/files/*', async (req, res, next) => {
  let relativePath = req.params['*'];
  res.send(`Requested: ${relativePath}`);
});

let app = new App();
app.use(router.routes());
```

### Safe Streaming HTML Templates (`html`)

`zena:http` includes an `html` tagged template literal for server-rendered HTML:

```zena
import { html } from 'zena:http';

let renderPage = (title: String, items: Array<String>) => html`
  <!doctype html>
  <html>
    <head><title>${title}</title></head>
    <body>
      <ul>
        ${items.map((item) => html`<li>${item}</li>`)}
      </ul>
    </body>
  </html>
`;
```

`html` returns an `HTMLPartial` that implements `Stream<u8>`, so assigning it to `res.body` (or passing it to `res.html(...)`) streams the rendered markup without concatenating the full page into a single string first:

- **Automatic escaping**: Interpolated strings are HTML-escaped (`&`, `<`, `>`, `"`, `'`), while nested `HTMLPartial` values are emitted verbatim.
- **Indentation normalization**: Common leading whitespace across template lines is stripped at construction time.
- **Async streaming**: Interpolated `Future` values and iterables of `HTMLPartial`s are awaited in order as the response stream is consumed.

### Static File Serving (`serve` and `send`)

`serve(root, options)` and `send(req, res, path, options)` handle static assets:

- **Path sanitization**: Rejects null bytes, backslashes, and `..` traversal segments before touching the filesystem.
- **Directory index resolution**: Automatically resolves directory requests to `index.html`.
- **Conditional requests**: Generates weak `ETag` (`W/"<size>-<mtime>"`) and `Last-Modified` headers, returning `304 Not Modified` when `If-None-Match` or `If-Modified-Since` matches.
- **Pre-compressed sidecars**: When `Accept-Encoding` includes `br` or `gzip`, `send()` checks for `<file>.br` or `<file>.gz` on disk and serves the pre-compressed variant with `Content-Encoding` and `Vary: Accept-Encoding`.
- **Host-to-socket streaming**: File bodies are attached as a `FileStream` from `wasi:filesystem/types.descriptor.read-via-stream`, streaming from the OS file descriptor to the HTTP socket without copying file bytes through WebAssembly memory.

## Benchmarking `zena:http` Against Fastify and Zipadee

To measure framework and runtime overhead, we ported the standard Fastify/Zipadee JSON benchmark (`benchmarks/http/json-server.zena`):

```zena
import { App } from 'zena:http';

export let main = async () => {
  let app = new App();
  app.use(async (req, res, next) => {
    res.headers['content-type'] = 'application/json; charset=utf-8';
    res.send('{"hello":"world"}');
  });
  let server = app.listen(3000);
  server.keepAlive();
};
```

We ran `autocannon -c 100 -d 10 -p 10` (100 concurrent connections, 10-deep HTTP pipelining, 10 seconds) on a 16-vCPU Linux VM with Node.js v26.10.0 and Wasmtime 48.0.5:

| Server / Optimization Stage                     | Avg req/s   | p50 Latency | µs/req      | Throughput    |
| ----------------------------------------------- | ----------- | ----------- | ----------- | ------------- |
| `zena:http` initial baseline                    | 1,431       | 658 ms      | 698.6 µs    | 0.23 MB/s     |
| + Free-list coalescing & lazy `Request`         | 24,859      | 41 ms       | 40.2 µs     | 3.48 MB/s     |
| + Middleware & header fast paths                | 29,815      | 37 ms       | 33.5 µs     | 4.17 MB/s     |
| + Batched accept stream & `TCP_NODELAY`         | 32,132      | 41 ms       | 31.1 µs     | 4.50 MB/s     |
| **Zipadee** (Node.js v26.10.0)                  | 71,607      | 15 ms       | 14.0 µs     | 13.9 MB/s     |
| **Fastify** (Node.js v26.10.0)                  | 75,820      | 14 ms       | 13.2 µs     | 14.3 MB/s     |
| **`zena:http` + `complete-text` WIT fast path** | **314,982** | **3 ms**    | **3.17 µs** | **44.1 MB/s** |

Every stage on the path from 1,431 req/s to 314,982 req/s uncovered a distinct bottleneck across the guest allocator, the HTTP middleware layer, or the WASI host boundary.

## 1. Linear-Memory Fragmentation (`1,431` → `24,859` req/s)

Zena objects live on the WebAssembly GC heap, so normal object allocations never touch linear memory. However, the WASI Canonical ABI still uses linear memory as a staging buffer whenever strings, lists, or stream chunks cross between the Wasm component and the host.

When we profiled the initial `1,431 req/s` baseline, the server was spending most of its CPU time inside `FreeListAllocator.alloc` in `zena:memory`. Each HTTP response allocated a 4 KB linear-memory buffer to write the response stream, freed it, and also allocated small 8–32 byte blocks for Canonical ABI return areas and header strings.

`FreeListAllocator` split freed 4 KB blocks to satisfy small allocations, but `free()` simply prepended freed regions to the head of the free list without coalescing adjacent blocks. Under sustained load, the free list accumulated thousands of tiny fragments that had to be scanned on every allocation.

Changing `FreeListAllocator` to maintain an address-ordered free list and merge adjacent blocks on `free()`—plus reusing blocks within 64 bytes without splitting—eliminated the fragmentation and immediately raised throughput by **17.4×** (to 24,859 req/s).

In the same pass, we made the high-level `Request` wrapper lazy:

- `req.url`, `req.path`, and `req.query` are only parsed on first access.
- `req.headers` only copies headers out of the WASI `fields` resource if middleware inspects them.
- `req.body` only calls `wasi:http/types.request.consume-body` when read, avoiding creating a WASI stream resource on GET requests.

## 2. Removing Per-Chunk Coroutines and ABI Byte Loops (`24,859` → `32,132` req/s)

Next, we cleaned up the guest-side hot paths:

- **Direct `Stream<u8>` implementations**: `TextStream` and `BytesStream` previously used generator methods (`yield`), which allocate a coroutine state machine per stream. Replacing them with classes that implement `Stream<u8>` directly removed two coroutine allocations per response.
- **4-byte packed `i32` ABI copies**: Copying strings and byte arrays between Wasm-GC arrays (`ByteArray`) and linear memory previously copied one byte at a time. Copying 4 bytes per iteration via `i32.load` / `i32.store` sped up ABI string transfers by **4.98×**.
- **Single-handler pipeline bypass**: When an `App` has a single middleware handler, `app.handle()` invokes it directly instead of allocating a `compose` dispatch closure per request.
- **Batched request acceptance**: Instead of reading one incoming `(request, response-writer)` pair per async poll from the listen stream, the server loop reads up to 64 pending connections per `stream.read` call and enables `TCP_NODELAY` on accepted sockets.

That brought `zena:http` to **32,132 req/s**—roughly 42% of Fastify's throughput.

## 3. Why Standard `wasi:http` Capped Us at 32k req/s

At 32,132 req/s, profiling showed that Zena's own HTTP code was barely registering in the profile. Instead, almost all time per request (~31 µs) went into crossing the WASI Component Model boundary and scheduling async tasks in the Rust host.

On the standard `wasi:http/types@0.3.0` path, sending a 17-byte `{"hello":"world"}` response requires **9 separate host calls** and multiple async channels per request:

1. `fields.new` — allocate a header map resource in the host table.
2. `fields.append` — copy `"content-type"` and `"application/json; charset=utf-8"` through linear memory and parse them as HTTP header names/values.
3. `stream.new` — allocate a WASI `stream<u8>` reader/writer pair in the host table.
4. `response.new` — allocate a `response` resource and a `future<result<_, error-code>>` completion trailer.
5. `response.set-status-code` — set `200`.
6. `response-writer.respond` — spawn a background Tokio task with an `mpsc::channel(4)` to pump chunks from the WASI stream into Hyper's body, plus a `oneshot` channel to signal completion.
7. `stream.write` — copy the 17-byte body into linear memory and transfer it across the async stream channel.
8. `stream.drop-writable` — close the stream and wake the pump task.
9. `resource.drop` (×4) — drop the `fields`, `response`, `response-writer`, and `request` handles via individual Canonical ABI calls.

For streaming responses or large bodies, that machinery is useful. For an in-memory string or JSON payload that is already complete when the handler finishes, creating a WASI stream, spawning a Tokio pump task, and making nine host calls is pure overhead.

## 4. The `zena-cli:host/http-server` WIT Interface (`32,132` → `314,982` req/s)

`zena-run` provides a small host WIT interface (`zena-cli:host/http-server` in `packages/stdlib/zena/host-wit/host.wit`) that bridges `wasi:http/types@0.3.0` to a persistent listening socket. To eliminate the multi-call ceremony for complete in-memory responses, we added a single static method, `complete-text`, to `response-writer`:

```wit
interface http-server {
  use wasi:http/types@0.3.0.{request, response, error-code};

  /// Handle for sending a response back to the client for a single request.
  resource response-writer {
    /// Send the HTTP response back to the client.
    respond: func(response: response);
    /// Fast path: construct and send a complete in-memory text response in one
    /// host call, consuming the writer (and optionally dropping the request).
    complete-text: static func(
      writer: response-writer,
      req: option<request>,
      status: u16,
      content-type: string,
      headers: list<tuple<string, string>>,
      body: string
    );
    /// Report an error instead of a response.
    respond-error: func(error: error-code);
  }

  /// An HTTP server listening on a port.
  resource server {
    create: static func(port: u16) -> server;
    port: func() -> u16;
    /// Returns a stream of incoming requests paired with their response writer.
    listen: func() -> stream<tuple<request, response-writer>>;
    close: func();
  }
}
```

When `res.send(text)` (or `res.json(text)`) is called, `Response` records the string in a sidecar field instead of immediately wrapping it in a `TextStream`. If the middleware pipeline finishes with that in-memory string still intact, the server takes the `complete-text` branch:

- If `res.headers` was only used to set `content-type`, Zena skips allocating the header list altogether and passes `content-type` directly as a string argument.
- `complete-text` takes ownership of both `writer` and `req`, so the Rust host drops both resource handles from the Wasmtime resource table inside the same call—saving two separate `[resource-drop]` ABI calls.
- On the Rust side (`packages/zena-runtime/src/component.rs`), `complete-text` constructs an `http::Response<Full<Bytes>>` directly from the linear-memory slice and sends it over the connection's `oneshot` channel without creating a WASI `Fields` resource, a `stream<u8>`, or a background stream-pumping task.

If middleware assigns a streaming body (`FileStream`, `HTMLPartial`, or custom `Stream<u8>`), `zena:http` transparently uses the standard `wasi:http/types` `respond` path.

With `complete-text`, the entire request-response cycle for an in-memory response makes **one host call** (plus amortized batched `stream.read` calls—1/64th of a call per request). Throughput jumped from **32,132 req/s** to **314,982 req/s** (3.17 µs per request), outperforming both Zipadee (71.6k req/s) and Fastify (75.8k req/s) by more than **4×**.

## 5. Fast Static Files with Host-Side `read-via-stream`

While `complete-text` accelerates small dynamic responses, a static file server like `zena-lang.dev` needs to move larger files efficiently without copying megabytes of asset data through WebAssembly linear memory.

When `send()` serves a file in `packages/stdlib/zena/http/static.zena`, it opens a `FileStream` via `wasi:filesystem`'s `read-via-stream` and assigns it directly to `res.body`:

```zena
res.body = new FileStream(fd, 0);
```

When `toWireResponse` passes that `FileStream`'s underlying WASI `stream<u8>` handle into `wasi:http/types.response.new`, the bytes never enter the WebAssembly guest. Both the filesystem reader and the HTTP response writer live in Wasmtime's host resource table, so Tokio streams data straight from the file descriptor to the socket.

Profiling a 64 MB file download revealed one catch: `wasmtime-wasi`'s default `read-via-stream` implementation reads files in 8 KiB chunks, requiring 8,192 `spawn_blocking` thread-pool round-trips per 64 MB file (245 ms total). Overriding `read-via-stream` in `zena-runtime` (`packages/zena-runtime/src/fs_read.rs`) to use a 256 KiB buffer reduced that 64 MB transfer from **245 ms** to **17 ms** (~3.7 GB/s over loopback).

## Try It Out

`zena:http` ships in the Zena standard library today, and the server running this site is in the repository at [`packages/website/zena/server.zena`](https://github.com/elematic/zena/blob/main/packages/website/zena/server.zena). You can run it locally against a built site with:

```bash
zena run packages/website/zena/server.zena
```
