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

As of today, [zena-lang.dev](https://zena-lang.dev) is served by a Zena program
running on `zena:http` and `zena-run`.

Previously, the website container ran Node.js and served the static Eleventy
output with [Zipadee](https://github.com/justinfagnani/zipadee). Replacing that
server with Zena was a practical milestone for dogfooding `zena:http` in
production, and it prompted a round of profiling across the HTTP library, memory
allocator, and WASI host integration that took our JSON benchmark throughput
from **1,431 req/s** to **314,982 req/s**—over **4× faster than Fastify** on the
same machine.

This post walks through the production server running `zena-lang.dev`, the
design of `zena:http`, and the runtime and WIT changes behind those numbers.

## The Server Running `zena-lang.dev`

The entire production server (`packages/website/zena/server.zena`) is 56 lines
of Zena:

```zena
/**
 * Serves the built documentation site (`_site/`) using `zena:http`.
 */

import { getEnv } from 'zena:cli';
import { App, send, serve } from 'zena:http';

function resolvePort(): u16 {
  let envPort = getEnv('PORT');
  if (envPort != null) {
    if (let (true, p) = parseI32(envPort)) {
      return p as u16;
    }
  }
  return 8080 as u16;
}

function resolveSiteDir() {
  return getEnv('SITE_DIR') ?? '.';
}

export function main() {
  let app = new App();
  let port = resolvePort();
  let siteDir = resolveSiteDir();

  app.use(serve(siteDir, {
    setHeaders: (res, path, stat) => {
      // Assets are not content-hashed, so revalidate via ETag/Last-Modified.
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
    },
  }));

  app.use(async (req, res, next) => {
    if (req.method != 'GET' && req.method != 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      res.body = 'Method Not Allowed';
      return;
    }
    res.statusCode = 404;
    await send(req, res, '404.html', {
      root: siteDir,
      setHeaders: (r, path, stat) => {
        r.setHeader('cache-control', 'no-cache');
        r.setHeader('x-content-type-options', 'nosniff');
      },
    });
  });

  app.listen(port, () => {
    console.log(`🚀 Zena HTTP server running at http://localhost:${port}`);
    console.log(`Serving static site from: ${siteDir}`);
  });
}
```

During the build, `zena-cli build` compiles `server.zena` to a WASI 0.3
component (`server.wasm`), and inside the Docker image `zena-run --precompile`
compiles that component ahead of time into a native Cranelift artifact
(`server.cwasm`). The container ships only `zena-run`, `server.wasm`,
`server.cwasm`, and the built `_site` directory (mounted at `.` via
`zena-run --dir /app/_site::. /app/server.wasm`), starting in milliseconds
without JIT compilation at cold start.

## What Is in `zena:http`

`zena:http` is an async middleware framework modeled after Zipadee and Koa,
built on WASI 0.3 async tasks and streams.

### Composable Async Middleware

An `App` runs an ordered pipeline of middleware functions:

```zena
type NextFunction = () => Future<void>;
type Middleware = (req: Request, res: Response, next: NextFunction) => Future<void>;
```

Calling `await next()` invokes the downstream middleware and resumes when it
completes, making logging, timing, authentication, and error handling
composable:

```zena
import { App } from 'zena:http';
import { monotonic } from 'zena:time';

let app = new App();

app.use(async (req, res, next) => {
  let start = monotonic();
  await next();
  let elapsed = monotonic() - start;
  res.setHeader('x-response-time', `${elapsed as i64}ns`);
});
```

Pipelines can also be combined with `compose([...])`, wrapped with `cors()`, or
mounted at a path prefix with `mount('/api', apiHandler)`, which strips the
prefix for the inner handler and restores `req.path` afterward.

### Routing

`Router` dispatches by HTTP method and path pattern, supporting named parameters
(`:name`) and wildcard tails (`*`):

```zena
import { App, Router } from 'zena:http';

let router = new Router();

router.get('/users/:id', async (req, res, next, params) => {
  let id = params['id'] ?? 'unknown';
  res.type = 'application/json; charset=utf-8';
  res.body = `{"id":"${id}"}`;
});

router.get('/files/*', async (req, res, next, params) => {
  let relativePath = params['*'] ?? '';
  res.body = `Requested: ${relativePath}`;
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

`html` returns an `HTMLPartial` that can be assigned directly to `res.body`,
automatically setting `Content-Type: text/html; charset=utf-8` and streaming the
rendered markup without concatenating the full page into a single string first:

- **Automatic escaping**: Interpolated strings are HTML-escaped (`&`, `<`, `>`,
  `"`, `'`), while nested `HTMLPartial` values are emitted verbatim.
- **Indentation normalization**: Common leading whitespace across template lines
  is stripped at construction time.
- **Async streaming**: Interpolated `Future` values and iterables of
  `HTMLPartial`s are awaited in order as the response stream is consumed.

### Static File Serving (`serve` and `send`)

`serve(root, options)` and `send(req, res, path, options)` handle static assets:

- **Path confinement**: Rejects NUL bytes and `..` traversal above the root with
  `403 Forbidden`, and ignores hidden dotfile segments by default.
- **Directory index & extension resolution**: Resolves directories to
  `index.html` and supports fallback extensions (e.g., `extensions: ['html']`).
- **Conditional requests**: Sets `Last-Modified` and weak `ETag`
  (`W/"<size>-<mtime>"`) headers, returning `304 Not Modified` when
  `If-None-Match` matches.
- **Pre-compressed sidecars**: Negotiates `Accept-Encoding` (including `q`
  weights) to serve `<file>.br` or `<file>.gz` when present on disk.
- **Host-to-socket streaming**: Streams file descriptors directly to the HTTP
  response via `wasi:filesystem`'s `read-via-stream` without copying file
  contents through WebAssembly memory.

## Benchmarking & Optimizing `zena:http`

To measure framework and runtime overhead, we ported the standard
Fastify/Zipadee JSON benchmark (`benchmarks/http/json-server.zena`):

```zena
import { getEnv } from 'zena:cli';
import { App } from 'zena:http';
import { JsonBuilder } from 'zena:json';

let resolvePort = (): u16 => {
  let envPort = getEnv('PORT');
  if (envPort != null) {
    if (let (true, p) = parseI32(envPort as String)) {
      return p as u16;
    }
  }
  return 3000 as u16;
};

export function main(): void {
  let app = new App();
  let port = resolvePort();

  app.use(async (req, res, next) => {
    res.type = 'application/json; charset=utf-8';
    let b = new JsonBuilder();
    b.beginObject().key('hello').string('world').endObject();
    res.body = b.toString();
  });

  app.listen(port, (): void => {});
}
```

We ran `autocannon -c 100 -d 10 -p 10` (100 concurrent connections, 10-deep HTTP
pipelining, 10 seconds) on a 16-vCPU Linux VM against Zipadee and Fastify on
Node.js v26.10.0:

| Server / Stage                            | Avg req/s   | p50 Latency | µs/req      | Throughput    |
| ----------------------------------------- | ----------- | ----------- | ----------- | ------------- |
| `zena:http` initial baseline              | 1,431       | 658 ms      | 698.6 µs    | 0.23 MB/s     |
| + Guest allocator & lazy `Request`        | 24,859      | 41 ms       | 40.2 µs     | 3.48 MB/s     |
| + Stream, ABI copy & batching fixes       | 32,132      | 41 ms       | 31.1 µs     | 4.50 MB/s     |
| **Zipadee** (Node.js v26.10.0)            | 71,607      | 15 ms       | 14.0 µs     | 13.9 MB/s     |
| **Fastify** (Node.js v26.10.0)            | 75,820      | 14 ms       | 13.2 µs     | 14.3 MB/s     |
| **`zena:http` + `complete-text` WIT API** | **314,982** | **3 ms**    | **3.17 µs** | **44.1 MB/s** |

Three areas accounted for the jump from 1,431 req/s to 314,982 req/s:

### 1. Linear-Memory Coalescing & Guest Hot Paths (`1.4k` → `32k` req/s)

Zena objects live on the WebAssembly GC heap, but the WASI Canonical ABI still
uses linear memory as a staging buffer whenever strings, lists, or stream chunks
cross between the component and the host. Our initial `FreeListAllocator` in
`zena:memory` split 4 KB stream buffers to satisfy tiny header allocations
without coalescing adjacent blocks on `free()`, leaving thousands of fragments to
scan under load. Switching to an address-ordered coalescing free list—combined
with parsing `req.url`, `req.path`, and `req.headers` lazily on first access—took
throughput from **1,431** to **24,859 req/s** (17.4×).

Replacing generator-based byte streams with direct `Stream<u8>` classes, copying
ABI strings 4 bytes at a time via `i32.load`/`i32.store` (a 5× speedup for
string transfers), and accepting up to 64 requests per `stream.read` batch
brought throughput to **32,132 req/s**.

### 2. Bypassing WASI Stream Ceremony for In-Memory Responses (`32k` → `315k` req/s)

At 32k req/s, Zena's own HTTP code was barely visible in CPU profiles; almost
all ~31 µs per request went into crossing the WASI Component Model boundary.
Because `wasi:http/types@0.3.0` models every response as an asynchronous stream
of chunks, returning a 17-byte `{"hello":"world"}` string required **9 separate
host calls** (`fields.new`, `fields.append`, `stream.new`, `response.new`,
`response.set-status-code`, `response-writer.respond`, `stream.write`,
`stream.drop-writable`, and four `resource.drop` calls) plus a background Tokio
task and channel to pump the stream into Hyper.

That machinery is great for streaming bodies, but pure overhead when `res.body`
is already a complete `String` in memory. We added a single `complete-text`
static method to `response-writer` in `zena-cli:host/http-server` that accepts
the status code, content-type, headers, and body string in one host call,
constructs an `http::Response<Full<Bytes>>` directly in Rust, and disposes both
the `response-writer` and unconsumed `request` handles in place. For in-memory
text and JSON responses, that reduced 9 host calls to **1**, jumping throughput
nearly **10×** to **314,982 req/s**—over **4× faster than Fastify**. Streaming
bodies (`HTMLPartial` and `Stream<u8>`) continue to use the standard
`wasi:http/types` streaming path automatically.

### 3. Host-to-Socket Static Files (`245 ms` → `17 ms` for 64 MB)

For static files, `send()` opens a WASI `stream<u8>` directly from the file
descriptor via `wasi:filesystem`'s `readViaStream` and attaches it to `res.body`:

```zena
let (contents, done) = file.readViaStream(0 as u64);
closeWhenRead(file, done);
res.body = contents;
```

Because both the file stream reader and the HTTP response writer live in
Wasmtime's host resource table, Tokio streams file bytes straight from the OS
file descriptor to the socket without copying them through WebAssembly memory.
Bumping the host `read-via-stream` buffer in `zena-runtime` from `wasmtime-wasi`'s
default 8 KiB to 256 KiB cut a 64 MB static file transfer from **245 ms** (8,192
blocking-pool reads) to **17 ms** (~3.7 GB/s over loopback).

## Try It Out

`zena:http` ships in the Zena standard library today, and the server running
this site is in the repository at
[`packages/website/zena/server.zena`](https://github.com/elematic/zena/blob/main/packages/website/zena/server.zena).
You can build and run the site locally on `zena:http` with:

```bash
npm run serve -w @zena-lang/website
```
