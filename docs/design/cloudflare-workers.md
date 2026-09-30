# Cloudflare Workers

Running Zena on Cloudflare Workers, and what a `zena:cloudflare` binding
layer would have to provide.

## Overview

A Cloudflare Worker is a JavaScript module running in a V8 isolate under
[workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source
runtime. WebAssembly reaches the platform through that JavaScript module:
the Worker imports a compiled `.wasm`, instantiates it, and passes values
across the boundary itself.

The WebAssembly features Zena emits already work there. A demo under
`examples/cloudflare-worker/` runs a Zena module inside workerd —
`npm run demo:cloudflare` builds it and starts a local server. It covers
GC allocation, exceptions, an async suspension, and a Durable Object, and
returns:

```json
{"count": 1, "message": "Hello world from Zena | caught: boom | awaited"}
```

The work remaining is a binding layer, not compiler support for the
platform's WebAssembly features.

## Platform constraints

**The entry module is JavaScript.** workerd's configuration schema lists
the module types a Worker bundle can contain
(`src/workerd/server/workerd.capnp`):

```capnp
esModule @1 :Text;
commonJsModule @2 :Text;
wasm @5 :Data;
# A Wasm module. The value is a compiled binary Wasm module file. Importing this will produce
# a `WebAssembly.Module` object, which you can then instantiate.
```

A `.wasm` file is a value a JavaScript module imports. There is no entry
type that names a wasm module, so every Worker written in a compiled
language ships a JavaScript shim. This is why
[workers-rs](https://github.com/cloudflare/workers-rs) generates one:
`worker-build` writes a `shim.js` that begins
`import { WorkerEntrypoint } from "cloudflare:workers"`, substitutes
generated handler assignments (`Entrypoint.prototype.fetch = async function
fetch(request) {…}`), and bundles it with the wasm-bindgen output. Its
`worker-sys` crate declares each Cloudflare type as a wasm-bindgen extern
over `js_sys::Object`.

**Modules are compiled at deploy time and cannot be compiled at runtime.**
workerd ties wasm compilation to eval permission
(`IsolateBase::allowWasmCallback` in `src/workerd/jsg/setup.c++`: "Don't
allow WASM unless arbitrary eval() is allowed"). A Worker cannot fetch
bytes and compile them, which rules out serving the Zena compiler as a
Worker that compiles submitted source.

**WASI is not the path.** Cloudflare documents WASI support as
experimental with only some syscalls implemented, and workerd offers no
wasi:http or Component Model entry point. The `js` target is the one that
fits.

## WebAssembly feature support

workerd passes V8 no WebAssembly flags. The only flags it sets at startup
are `--noincremental-marking`, `--js-source-phase-imports`, and
`--single-threaded-gc` on macOS (`src/workerd/jsg/setup.c++`), so a Worker
gets stock V8 defaults, including WasmGC and the exception-handling
proposal.

Confirmed by running the demo under `wrangler dev`, which executes the
same workerd binary that serves production:

| Feature                                         | Result |
| ----------------------------------------------- | ------ |
| WasmGC structs and arrays, `ref.cast`           | works  |
| Exceptions (`tag`, `try_table`)                 | works  |
| Async suspension and resumption on a host timer | works  |
| Durable Object with SQLite storage and RPC      | works  |
| `@zena-lang/runtime` unmodified                 | works  |

`@zena-lang/runtime` needed no changes. It imports nothing from Node and
uses only `TextDecoder`, `TextEncoder`, `performance` and `setTimeout`,
all of which workerd provides.

Zena's async design is what makes async handlers possible here. Host
operations settle through numeric handles and a completion callback
rather than JSPI (`docs/design/async.md`), so nothing depends on a
proposal workerd might not enable.

The demo has only been run against local workerd. Deploying it to
Cloudflare's network needs an account and has not been done.

## Gaps

### Async exports

An async Zena function returns a `Future`, which is a GC object rather
than a JavaScript promise. The compiler splits an async `main` into
`__zena_main_start` and `__zena_main_result` so a host can start the body,
let its event loop deliver completions, and read the result once nothing
is outstanding; `run()` in `@zena-lang/runtime` drives that pair.

Only `main` gets the split. A Worker needs it for any exported async
function, because `fetch`, `scheduled`, and every Durable Object method
are separately invoked entry points, and several of them can be in flight
at once. Generalizing the split to any exported async function is the
compiler work this needs.

Until then a Worker has one async entry point, named `main`, which is what
the demo does.

### Shim generation

A Durable Object or a `WorkerEntrypoint` is bound by its class, so the
class must exist in JavaScript, and something has to emit it. Writing
shims by hand, as the demo does, works for one entry point and stops
scaling at the first Durable Object with several RPC methods.

The generator belongs in the compiler. The alternative — a separate
build step that reads the compiled module's exports, as `worker-build`
does for Rust — has to recover from the wasm exports what the compiler
already knew from the source: which functions are handlers, which are
async, what each parameter means. `worker-build` shows the cost of
recovering it, scraping wasm-bindgen's generated JavaScript with string
matching to find the entry points. The compiler has the declarations,
so it should write the shim from them, driven by an annotation on the
exported function or class.

This makes JavaScript shim emission a compiler feature rather than
tooling around it, which suits how much of Zena's reach runs through a
JS host. Whether the emitter is a component a build can leave out is
open; nothing about the design requires every compiler build to carry
it.

[host-interop.md](host-interop.md) holds the JS interop design this
builds on. Its "Extern class declarations" layer generates the wasm
side of a binding from declarations and deliberately generates nothing
on the JS side. Workers is the case that needs the other direction as
well, because the host requires the guest to present a JavaScript
module with classes in it; see "Generated JavaScript for host-imposed
module shapes" in that document.

### Bindings for Cloudflare types

`Env`, `DurableObjectState`, `SqlStorage`, `DurableObjectStub` and the
rest are JavaScript objects. The planned way to reach them is the
extern class layer in [host-interop.md](host-interop.md), which
declares a host object's shape in Zena and lowers member access onto
the generic call layer:

```zena
declare extern class DurableObjectState {
  storage: SqlStorage;
  blockConcurrencyWhile(callback: () => Future<void>): Future<void>;
}
```

Writing those declarations by hand for the Workers API is a large and
perpetual transcription job. Cloudflare already publishes the same
information as TypeScript declarations, in `@cloudflare/workers-types`,
regenerated alongside the runtime.

The compiler should consume `.d.ts` and generate both halves of a
binding — the Zena representation, and the JavaScript glue that goes
with the generated shim for the members needing any. "Declarations from
TypeScript" in [host-interop.md](host-interop.md) covers the design,
including why resolving these types argues for running the official
TypeScript checker rather than reimplementing its type system, and what
`undefined` should map to in a language that has no such value.

Workers is a good first target for that work, and not only because it
is wanted here. `@cloudflare/workers-types` is a large body of
real-world declarations that exercises the hard parts — `undefined`
returns, generics over host types, overloads — against an API that can
be tested by running it. What needs a real representation and what can
be approximated with a runtime check is a question this answers by
being attempted.

## Strings across the boundary

Reading a Zena string from JavaScript calls an exported getter once per
byte (`createStringReader` in `packages/runtime/src/index.ts`). A WebAssembly
GC array is opaque to JavaScript — no indexed access, no length, no
iterator — so calling back into wasm is the only way to read one, and the
per-byte loop driven from JavaScript is the fastest form available today.
`docs/design/host-interop.md` covers why under "Strings", including the
constraint that V8's Wasm-into-JS inlining triggers only for nullable
`externref` parameters. Nothing about this is specific to Workers.

The cost is per request, against the free plan's 10ms of CPU per
invocation. Host-backed strings through the `js-string-builtins` proposal
would remove the copy by representing a Zena string as a JavaScript
string; that work is in progress for the `js` target and will apply here
without changes.

## Platform limits

| Limit              | Free                | Paid                    |
| ------------------ | ------------------- | ----------------------- |
| Requests           | 100,000/day         | billed per request      |
| CPU per invocation | 10 ms               | 30 s default, 5 min max |
| Startup time       | 1 s                 | 1 s                     |
| Worker size        | 64 MiB uncompressed | 64 MiB uncompressed     |
| Durable Objects    | SQLite backend only | SQLite or key-value     |

Deploying needs no paid plan and no custom domain: a Worker gets a free
`<name>.<subdomain>.workers.dev` route. Local development needs no account
at all, since `wrangler dev` runs workerd on the machine.

Two limits shape the design. Instantiation happens at module scope and
counts against the 1s startup limit, so a large module is a startup cost
paid per isolate. The 10ms free-tier CPU budget is per invocation, which
is where string copying at the boundary shows up.

## Demo

`examples/cloudflare-worker/` holds `hello.zena` (the Zena module),
`worker.js` (the shim), and `wrangler.jsonc` (the Worker configuration).

```bash
cd examples/cloudflare-worker
npm install                      # this directory has its own dependencies
npm run dev                      # build the wasm and start local workerd
curl http://localhost:8787/a     # {"count":1,...}
curl http://localhost:8787/a     # {"count":2,...}
curl http://localhost:8787/b     # {"count":1,...} — a different object
```

The demo is not part of `npm test` and no build depends on it. The Nix
check runs the suite in a sandbox without network, where starting workerd
would fail.

wrangler is a dependency of that directory rather than of the repository
root, because a lockfile records every platform variant of an optional
dependency and `fetchNpmDeps` fetches all of them — `npmDepsHash` is a
fixed-output derivation, so its hash cannot vary by platform. wrangler
brings workerd and sharp, and in the root lockfile those took the Nix
dependency fetch from 210 MB to 613 MB. The example's README covers this.
