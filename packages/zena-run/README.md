# zena-run

Runs one compiled Zena component, or a core module, on wasmtime.

```bash
zena-run prog.wasm arg1 arg2
zena-run --dir . --dir /tmp prog.wasm
zena-run --allow-spawn tool.wasm       # lets it use zena:process and zena:wasm
zena-run -g prog.wasm                  # no inlining: backtraces name functions
zena-run --no-cache prog.wasm          # compile in memory, write nothing
```

This is the smallest host a component built for the `zena-cli`
compilation target can run under. Plain `wasmtime run` cannot run such a
component: beside WASI 0.3 it imports the `zena-cli:host@1.0.0`
interfaces — `stack-trace` for `Error`'s stack traces, `process` when it
uses `zena:process`, and `wasm` when it uses `zena:wasm` to run other
components. Those interfaces, the engine flags Zena output needs, and the
`.cwasm` cache come from the [`zena-runtime`](../zena-runtime) crate,
which [`zena-cli`](../zena-cli) shares. The difference between the two
binaries is that `zena-cli` also bundles the compiler and the test and
benchmark runners, and so needs a checkout (or installed tree) of this
repository; `zena-run` needs only the component. A component built for
the portable `component` target runs here too, and under `wasmtime run`.

A core module runs here as well, with no imports: a program built for
the `freestanding` target, a hand-written `.wat` file, or another
language's `wasm32-unknown-unknown` build. `zena-run` tells the two
kinds apart from the file. A core module gets no WASI, so `--dir`,
`--allow-spawn` and the arguments do not reach it, and an import it
declares traps if called.

Behavior matches `zena run prog.wasm`:

- stdio and the environment are inherited; `argv[0]` is the component path.
- `--dir HOST` or `--dir HOST::GUEST` pre-opens a directory, in wasmtime's
  syntax.
- A scalar return value from the invoked export is printed on its own line.
- The program's `exit(n)` becomes the process exit status. A trap prints
  the wasm backtrace and exits non-zero.
- The first run writes `prog.cwasm` (or `prog.debug.cwasm` under `-g`)
  beside the component; later runs load it instead of recompiling.
  `--no-cache` turns this off, for a component in a read-only directory.

To produce a component, build with the compiler:

```bash
zena build prog.zena -o prog.wasm    # zena-cli
zena-run prog.wasm
```

## Building and testing

```bash
cargo build --release -p zena-run    # target/release/zena-run
cargo test -p zena-run               # runs the binary on small wat components
```
