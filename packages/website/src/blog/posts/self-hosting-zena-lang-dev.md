---
title: 'Self-Hosting zena-lang.dev with Zena (Faster Than Node)'
description: 'zena-lang.dev has been running on a Zena HTTP server for over a month. Here is what the server looks like, what is in zena:http, how it works with WASI, and how it beats Fastify and Express on benchmarks.'
date: 2026-11-20T18:00:00Z
author: justinfagnani
tags:
  - announcements
  - performance
hero:
  image: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1600&q=80'
  alt: 'Rows of illuminated server racks in a data center'
  credit: 'Photo by Taylor Vick on Unsplash'
---

I'm a little late writing this post: [zena-lang.dev](https://zena-lang.dev) has
actually been running on a Zena HTTP server for over a month now.

We've been steadily self-hosting everything in the Zena ecosystem. The compiler,
package manager, build system (Zebra), formatter, linter, and language server
are all written in Zena already. Moving the website itself onto Zena felt like
a fun, practical way to prove you can build and run real services with the
language, not just compiler tools.

Before the switch, the site container ran Node.js with
[Zipadee](https://github.com/justinfagnani/zipadee), my modern HTTP package for
Node with an API like Koa and performance like Fastify. Since moving to
`zena:http` on Cloud Run, the site has been humming along for over a month with
zero downtime and an immediate ~50% drop in memory usage.

## The server running `zena-lang.dev`

Because `zena-lang.dev` is a static Eleventy site, the entire production server
([`packages/website/zena/server.zena`](https://github.com/elematic/zena/blob/main/packages/website/zena/server.zena))
only needs to serve one folder and a `404.html` page. It's 20 lines of Zena:

```zena
/**
 * Serves the built documentation site (`_site/`) using `zena:http`.
 */

import { getEnv } from 'zena:cli';
import { App, serve } from 'zena:http';

export async function main() {
  let siteDir = getEnv('SITE_DIR') ?? '.';
  let port = (parseI32(getEnv('PORT') ?? '') ?? 8080) as u16;

  let app = new App();

  app.use(serve(siteDir, {notFound: '404.html'}));

  let server = await app.listen(port);
  console.log(`🚀 Zena HTTP server running at http://localhost:${server.port}`);
  console.log(`Serving static site from: ${siteDir}`);
  await server.done;
}
```

`zena build` compiles `server.zena` to a WebAssembly component (`server.wasm`),
and the Docker image precompiles it ahead of time with `zena-run --precompile`
so cold starts don't wait on JIT compilation. `serve()` handles `ETag`,
`Last-Modified`, `Cache-Control`, `X-Content-Type-Options: nosniff`,
pre-compressed `.br`/`.gz` files, and `404.html` out of the box.

Our site only needs static file serving, of course, but `zena:http` can do a
lot more.

## A familiar, safe HTTP library

`zena:http` borrows heavily from Express, Koa, and Zipadee. You build an app by
stacking async middleware onto an `App`. You can also combine pipelines with
`compose()`, mount sub-apps at a path prefix with `mount()`, add `cors()`, or
dispatch routes with `Router`:

```zena
import { App, Router } from 'zena:http';
import { monotonic } from 'zena:time';

let app = new App();
let router = new Router();

app.use(async (req, res, next) => {
  let start = monotonic();
  await next(req);
  let elapsed = monotonic() - start;
  res.setHeader('x-response-time', `${elapsed as i64}ns`);
});

router.get('/users/:id', async (req, res, next, params) => {
  let id = params.get('id') ?? 'unknown';
  res.type = 'application/json; charset=utf-8';
  res.body = `{"id":"${id}"}`;
});

app.use(router.routes());
```

One nice Zena twist: `Request` is a resource class, so each middleware owns it
and hands it downstream with `await next(req)`. Calling `next` twice or reading
`req` after passing it along is a compile-time error, and whoever holds the
request last cleans up its underlying body stream automatically.

We also ported two of my favorite ideas from Zipadee:

- **Safe responses by default**: Assigning a plain `String` to `res.body`
  defaults to `Content-Type: text/plain; charset=utf-8`, so user input isn't
  accidentally rendered as HTML. To send HTML, you use the `html` tagged
  template literal, which sets `text/html; charset=utf-8` and automatically
  HTML-escapes interpolated values to prevent XSS.
- **Streaming `html` templates**: `html` returns an `HTMLPartial` that streams
  directly into the response without concatenating the whole page into one
  string in memory, and awaits any interpolated `Future`s or nested partials in
  order as the stream is consumed:

```zena
import { html } from 'zena:http';

function renderPage(title: String, items: Array<String>) {
  return html`
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
}
```

## Built on WASI (and runnable like Node)

Under the hood, `zena:http` is built on WASI 0.3 (`wasi:http@0.3.0`), and it
supports both ways you might want to run a WebAssembly HTTP server:

1. **As a standard `wasi:http/handler` component**: Any `App` can answer
   incoming WASI requests via `app.handle(request)` (or
   `handleWireRequest(app, request)`). Export a `handle` function, compile
   against a `wasi:http/handler` world, and you can run the component directly
   on standard WASI hosts like `wasmtime serve` (see
   [`examples/wasi-http-server.zena`](https://github.com/elematic/zena/blob/main/examples/wasi-http-server.zena)):

```zena
export async function handle(
  request: Own<WireRequest>
): Future<Result<Own<WireResponse>, ErrorCode>> {
  return await handleWireRequest(app, request);
}
```

2. **As a standalone server, like Node**: Sometimes you just want a program that
   reads `PORT` from the environment, binds a socket, and runs until you stop
   it, without needing a separate host wrapper. Our runtime (`zena` and
   `zena-run`) provides an extended `zena:host/http-server` interface that
   powers `await app.listen(port)`. Because `Server` is also a resource class,
   holding it with `await server.done` keeps it alive and dropping it closes
   the socket cleanly.

## How fast is it?

To see how `zena:http` stacks up against Node, we ported the standard
Fastify/Zipadee `{"hello":"world"}` JSON benchmark
([`benchmarks/http/json-server.zena`](https://github.com/elematic/zena/blob/main/benchmarks/http/json-server.zena))
and ran `autocannon -c 100 -d 10 -p 10` (100 connections, 10-deep pipelining,
10 seconds) on an Apple M1 Pro (10 cores, Node.js v26.10.0, Wasmtime 48.0.5):

| Server                   | Avg req/s   | p50 Latency | Throughput    |
| ------------------------ | ----------- | ----------- | ------------- |
| Express (Node.js v26.10) | 66,269      | 17 ms       | 16.7 MB/s     |
| Zipadee (Node.js v26.10) | 134,193     | 7 ms        | 26.0 MB/s     |
| Fastify (Node.js v26.10) | 150,758     | 6 ms        | 28.3 MB/s     |
| **Zena (`zena:http`)**   | **207,386** | **4 ms**    | **29.0 MB/s** |

On my laptop that's **3.1× faster than Express**, **1.5× faster than Zipadee**,
and **1.4× faster than Fastify**, all from a WebAssembly GC component. On
multi-core Linux VMs the gap grows even wider (over 300k req/s in our earlier
Linux runs), because the Rust host runs Hyper/Tokio socket I/O across worker
threads while Node stays single-threaded.

It definitely didn't start that fast. Our very first benchmark run crawled in
at ~1,400 req/s! Getting from there to 200k+ req/s came down to a few key fixes:

- **Fixing linear-memory fragmentation and lazy parsing**: Zena objects live on
  the Wasm GC heap, but WASI still stages strings and buffers through linear
  memory. Our first allocator didn't coalesce freed blocks, which turned into a
  free-list scan under load. Coalescing freed blocks and parsing `req.url`,
  `req.path`, and `req.headers` lazily gave us an immediate ~17× jump.
- **Skipping stream setup for in-memory strings**: `wasi:http` models every
  response body as an async stream, which is great for streaming HTML or files
  but meant a tiny 17-byte JSON string needed a pile of host calls and a
  background pump task. Adding a single-call `complete-text` fast path on
  `zena:host/http-server` for in-memory strings cut that overhead dramatically,
  while `HTMLPartial` and `Stream<u8>` bodies still take the standard
  streaming path.
- **Host-to-socket file streaming**: For static files, `serve()` passes the
  file's WASI stream (`file.readStream()`) straight to the response writer so
  Tokio copies bytes from disk to the socket without moving them through Wasm
  memory. In [`benchmarks/http/file-serving.sh`](https://github.com/elematic/zena/blob/main/benchmarks/http/file-serving.sh),
  a 64 MB transfer finishes in ~17 ms (~3.7 GB/s over loopback).

## Try it yourself

You can build and run the JSON benchmark locally from a checkout of the
[Zena repo](https://github.com/elematic/zena):

```bash
# Build and start the benchmark server on port 3000
./target/release/zena build benchmarks/http/json-server.zena -o /tmp/json-server.wasm
PORT=3000 ./target/release/zena-run /tmp/json-server.wasm

# In another terminal, benchmark it with autocannon
npx autocannon -c 100 -d 10 -p 10 http://127.0.0.1:3000/
```

You can also run the static file serving benchmark:

```bash
benchmarks/http/file-serving.sh
```

Or build and serve this very website locally on `zena:http`:

```bash
npm run serve -w @zena-lang/website
```
