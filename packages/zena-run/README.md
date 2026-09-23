# zena-run

Runs one compiled Zena module on wasmtime.

```bash
zena-run prog.wasm arg1 arg2
zena-run --dir . --dir /tmp prog.wasm
zena-run --allow-spawn tool.wasm       # lets it use zena:process and zena:wasm
zena-run -g prog.wasm                  # no inlining: backtraces name functions
zena-run --no-cache prog.wasm          # compile in memory, write nothing
```

This is the smallest host a module built for the `zena-cli` compilation
target can run under. Plain `wasmtime run` cannot run such a module: it
imports `env.captureStackTrace` and `env.formatStackTrace` for `Error`'s
stack traces, `zena_process` when it uses `zena:process`, and `zena_wasm`
when it uses `zena:wasm` to run other modules. Those imports,
the engine flags Zena output needs, and the `.cwasm` cache come from the
[`zena-runtime`](../zena-runtime) crate, which [`zena-cli`](../zena-cli)
shares. The difference between the two binaries is that `zena-cli` also
bundles the compiler and the test and benchmark runners, and so needs a
checkout (or installed tree) of this repository; `zena-run` needs only the
module.

Behavior matches `zena run prog.wasm`:

- stdio and the environment are inherited; `argv[0]` is the module path.
- `--dir HOST` or `--dir HOST::GUEST` pre-opens a directory, in wasmtime's
  syntax.
- A scalar return value from the invoked export is printed on its own line.
- The program's `exit(n)` becomes the process exit status. A trap prints
  the wasm backtrace and exits non-zero.
- The first run writes `prog.cwasm` (or `prog.debug.cwasm` under `-g`)
  beside the module; later runs load it instead of recompiling. `--no-cache`
  turns this off, for a module in a read-only directory.

To produce a module, build with the compiler:

```bash
zena build prog.zena -o prog.wasm    # zena-cli
zena-run prog.wasm
```

## Building and testing

```bash
cargo build --release -p zena-run    # target/release/zena-run
cargo test -p zena-run               # runs the binary on small wat modules
```
