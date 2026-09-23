# zena-runtime

The host side of the `zena-cli` compilation target, as a Rust library on
wasmtime. It is the counterpart of `packages/runtime`, which does the same
job for the `js` target in JavaScript.

A module compiled for `zena-cli` imports three things from whatever runs
it:

- **WASI preview 1** (`wasi_snapshot_preview1`), for stdio, files, clocks,
  arguments and environment.
- **`env.captureStackTrace` and `env.formatStackTrace`**, which back
  `Error`'s stack traces. Every module imports these because `Error` is in
  the prelude. (`env.getStackTrace`, which does both in one call, is also
  provided; nothing in the stdlib imports it.)
- **`zena_process`**, the eleven functions behind `zena:process`, when the
  program uses that module. Spawning host processes leaves the sandbox, so
  the embedder grants it per instantiation (`Spawn::Allow`) or links
  trapping stubs (`Spawn::Deny`).
- **`zena_wasm`**, the functions behind `zena:wasm`, which starts other
  Wasm modules and waits for their results (`wasm_runner.rs`). It is
  granted with `zena_process`. Each run gets a fresh store on its own
  thread, and directories handed to a run are translated through the
  caller's own preopens, so a module can pass on only what it can reach.
  A run with a time limit uses a second engine with epoch interruption on
  (`engine::interruptible_engine`), so programs that never ask for a
  limit do not pay for its checks.

Strings cross the boundary through four helpers every compiled module
exports (`$stringCreate`, `$stringSetByte`, `$stringGetLength`,
`$stringGetByte`); `strings.rs` wraps them.

Beyond the imports, the crate holds what every embedder otherwise
duplicates:

- `engine::config(debug)`: the wasmtime `Config` Zena output needs. The
  proposals Zena relies on (GC, exception handling, typed function
  references, tail calls) are on by default since wasmtime 48, so the
  config only adds wide arithmetic (still opt-in), backtrace details
  (off unless `WASMTIME_BACKTRACE_DETAILS` is set) and inlining, plus
  the ZENA_GC and ZENA_PROFILE environment switches; `reserve_gc_heap`
  reads ZENA_GC_RESERVE_MB.
- `cache`: ahead-of-time compiled `.cwasm` files kept beside each `.wasm`,
  written under a file lock (`foo.lock`, beside it too) so concurrent
  processes compile a module once. `zena-cli` and `zena-run` share these
  files: the cache is keyed by the module's path, and both binaries build
  their engines from the same `config` and the same wasmtime version (one
  `Cargo.lock` at the repository root), so a `.cwasm` written by one loads
  in the other. Debug engines use a separate `.debug.cwasm`, since a cwasm
  only loads into an engine with the same compile-affecting settings. The
  other cache, compiled Zena source under `.zena/cache` or the user's cache
  directory, belongs to `zena-cli` alone, because only it compiles source.

## Use

```rust
use wasmtime::{Engine, Linker, Store};
use zena_runtime::{HostState, Spawn};

let engine = Engine::new(&zena_runtime::engine::config(false))?;
let module = zena_runtime::cache::load_module(&engine, "prog.wasm".as_ref(), false)?;

let mut linker: Linker<HostState> = Linker::new(&engine);
zena_runtime::add_to_linker(&mut linker, &engine, &module, Spawn::Deny)?;

let wasi = wasmtime_wasi::WasiCtxBuilder::new().inherit_stdio().build_p1();
let mut store = Store::new(&engine, HostState { wasi });
let instance = linker.instantiate(&mut store, &module)?;
zena_runtime::call_export(&mut store, &instance, "main")?;
```

`call_export` keeps the error as a `wasmtime::Error` so the caller can
still read the guest's exit status (`exit_code`) or print the wasm
backtrace (`report_trap`).

Two binaries in this repository embed the crate: [`zena-run`](../zena-run)
runs one compiled module and nothing else; [`zena-cli`](../zena-cli) adds
the compiler and the test and benchmark runners.

## Tests

```bash
cargo test -p zena-runtime
```
