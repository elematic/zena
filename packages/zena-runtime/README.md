# zena-runtime

The host side of the `zena-cli` compilation target, as a Rust library on
wasmtime. It is the counterpart of `packages/runtime`, which does the same
job for the `js` target in JavaScript.

A component compiled for `zena-cli` imports two things from whatever runs
it:

- **WASI 0.3**, for stdio, files, clocks, arguments and environment,
  supplied by `wasmtime-wasi`'s `p3` support.
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
let linker = zena_runtime::component::linker(&engine)?;

let wasi = WasiCtxBuilder::new().inherit_stdio().build();
let mut store = Store::new(&engine, ComponentState::new(&engine, wasi, None));
let results = zena_runtime::component::run_main(&mut store, &linker, &component, "main")?;
```

`run_main` keeps the error as a `wasmtime::Error` so the caller can still
read the guest's exit status (`exit_code`) or print the wasm backtrace
(`report_trap`). Passing a `Grant` in place of `None` lets the component
spawn processes and run components.

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

## Tests

```bash
cargo test -p zena-runtime
```
