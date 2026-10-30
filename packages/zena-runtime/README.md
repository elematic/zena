# zena-runtime

The host side of the `zena-cli` compilation target, as a Rust library on
wasmtime. It is the counterpart of `packages/runtime`, which does the same
job for the `js` target in JavaScript.

A component compiled for `zena-cli` imports two things from whatever runs
it:

- **WASI 0.3**, for stdio, files, clocks, arguments and environment,
  supplied by `wasmtime-wasi`'s `p3` support.
- **`wasi:http` 0.3**, supplied by `wasmtime-wasi-http`, except that
  outgoing requests go through `src/http_client.rs` instead of its
  default handler, which opens a connection per request and speaks
  HTTP/1.1 only. The replacement keeps one pooled client per process:
  `https://` connections offer `h2` and `http/1.1` through ALPN and use
  HTTP/2 when the server picks it, `http://` connections use HTTP/1.1,
  and idle connections are reused. An `http://` request whose
  `content-type` is `application/grpc` uses cleartext HTTP/2 with prior
  knowledge (h2c) instead, which local gRPC servers and the Firestore
  emulator speak. Trailers pass through both ways, and
  the request options' timeouts mean what they mean in the default
  handler. Connections run on a background runtime of their own
  (thread `zena-http`), so they outlive the per-call runtimes
  `run_main` builds. Where requests may connect is the process's
  `EgressPolicy`, from the environment: anywhere by default, and with
  `ZENA_DENY_PRIVATE_EGRESS=1` only to public addresses, except for the
  hosts `ZENA_ALLOW_EGRESS` lists, separated by commas. A name is then
  resolved once, refused with `destination-ip-prohibited` when any of its
  addresses is private, loopback, link-local or otherwise not on the
  internet, and connected to at those same addresses, so a second lookup
  cannot answer differently. A server that reads URLs other people chose
  sets it; the package host's image does.
- **The `zena-cli:host@1.0.0` interfaces**, declared in
  `packages/stdlib/zena/host-wit/host.wit` and implemented in
  `src/component.rs` with `bindgen!`:
  - `stack-trace`: `capture`, which formats the wasm backtrace at the
    point of the call; `Error` on this target reads its trace through it.
  - `process`: the `command` and `process` resources behind
    `zena:process`. Spawning host processes leaves the sandbox, so the
    embedder grants it per instantiation (`Grant`); without the grant
    the calls trap with an explanation.
  - `wasm`: the `run` resource and `precompile` behind `zena:wasm`, which
    starts other components and waits for their results. It is granted
    with `process`. Each run gets a fresh store on its own thread, and
    directories handed to a run are translated through the caller's own
    preopens, so a component can pass on only what it can reach. A run
    with a time limit uses a second engine with epoch interruption on
    (`engine::interruptible_component_engine`), so programs that never
    ask for a limit do not pay for its checks.
  - `extensions`: `load`, `load-trusted`, `check` and `drop` behind
    `zena:extensions`, which loads a component as an extension: a
    long-lived instance the program calls through objects, and which
    calls the program through objects the program made for it
    (`src/extensions.rs`,
    [docs/design/runtime-components.md](../../docs/design/runtime-components.md)).
    The program's WIT declares its side of each shared interface as a
    resource: `component::linker_for` defines the ones the program
    imports, with `attach` minting an object per extension and each
    method forwarding to that extension's export as wasmtime values;
    a load binds every import the extension has to the host, to a
    resource the program exports (one object per extension, vended by
    the plugin object the load names, through the plugin kind's
    `create`), or to another extension, and checks the two sides'
    types. A resource the shared interface declares crosses as a proxy
    in the other store's table, with its method calls and its drop
    forwarded to the owner. Each extension has a store on a thread of
    its own, with a
    memory limit and a per-call time limit when asked for, and a trap
    fails one call and restarts the instance. It is granted on its own
    (`Grant::extensions`, `--allow-extensions`).

A component's `main` is lifted async with a callback, so calling it goes
through wasmtime's concurrent machinery: `component::run_main` builds a
current-thread tokio runtime around the instantiation and the call.
Everything blocking a program does — reading a file, waiting on a child —
blocks inside that call, which the Component Model allows a task under an
async export to do.

Beyond the imports, the crate holds what every embedder otherwise
duplicates:

- `engine::component_config(debug)`: the wasmtime `Config` Zena output
  needs: the Component Model with its async ABI on, plus the proposals
  Zena relies on (GC, exception handling, typed function references,
  tail calls — on by default since wasmtime 48 — and wide arithmetic,
  still opt-in), backtrace details and inlining, and the ZENA_GC and
  ZENA_PROFILE environment switches; `reserve_gc_heap` reads
  ZENA_GC_RESERVE_MB. `shared_component_engine(debug)` is the one engine
  per setting.
- `cache`: ahead-of-time compiled `.cwasm` files kept beside each `.wasm`
  (or `.wat`; wasmtime reads the text format for components too), written
  under a file lock (`foo.lock`, beside it too) so concurrent processes
  compile a component once. `zena-cli` and `zena-run` share these files:
  the cache is keyed by the component's path, and both binaries build
  their engines from the same config and the same wasmtime version (one
  `Cargo.lock` at the repository root), so a `.cwasm` written by one loads
  in the other. Debug engines use a separate `.debug.cwasm`, and the
  interruptible engine a `.interruptible.cwasm`, since a cwasm only loads
  into an engine with the same compile-affecting settings. The other
  cache, compiled Zena source under `.zena/cache` or the user's cache
  directory, belongs to `zena-cli` alone, because only it compiles source.

## Use

```rust
use wasmtime::Store;
use wasmtime_wasi::WasiCtxBuilder;
use zena_runtime::component::ComponentState;

let engine = zena_runtime::engine::shared_component_engine(false)?;
let component = zena_runtime::cache::load_component_variant(
    &engine, "prog.wasm".as_ref(), false, false)?;
let linker = zena_runtime::component::linker_for(&engine, &component)?;

let wasi = WasiCtxBuilder::new().inherit_stdio().build();
let mut store = Store::new(&engine, ComponentState::new(&engine, wasi, None));
let results = zena_runtime::component::run_main(&mut store, &linker, &component, "main")?;
```

`run_main` keeps the error as a `wasmtime::Error` so the caller can still
read the guest's exit status (`exit_code`) or print the wasm backtrace
(`report_trap`). Passing a `Grant` in place of `None` lets the component
spawn processes and run components (`spawn`), or load components as
extensions (`extensions`), or both.

A core module — a `freestanding` build, a hand-written `.wat` benchmark,
an AssemblyScript or Rust `wasm32-unknown-unknown` build — runs through
`core_module`: `is_core_module_file` tells it from a component by the
file itself, and `call_export` instantiates it with every import linked
to a trap and calls one export. `zena:wasm` runs these too, with the
same result record and nothing to capture.

Two binaries in this repository embed the crate: [`zena-run`](../zena-run)
runs one compiled component or core module and nothing else;
[`zena-cli`](../zena-cli) adds the compiler and the test and benchmark
runners.

`examples/components_spike.rs` is a harness for the mechanism behind
`extensions` (#593): one Zena component calls another through its own
imports, and the other calls back while that call is in flight. It
predates the object shape, so its two components carry a handle as a
first parameter; its header says how to build and run them.

## Tests

```bash
cargo test -p zena-runtime
```

The `http_client` tests start local servers: a TLS one with a
self-signed certificate (from `rcgen`) that offers HTTP/2, a plain
HTTP/1.1 one, and a plain HTTP/2-only (h2c) one. They check the negotiated protocol, connection reuse
(by counting accepted connections), trailers, and error mapping, and
that a client denying private egress refuses a local server unless its
host is exempt.
