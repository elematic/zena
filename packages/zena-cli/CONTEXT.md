# Zena CLI Context (For AI Agents)

This document is to be used by AI agents (and human developers) to understand
the architectural boundaries, design decisions, and debugging expectations for
the `zena` command. The design is in
[docs/design/cli-module.md](../../docs/design/cli-module.md).

## Architecture & Responsibilities

1. **The command is a Zena program: the CLI module**
   - `zena/main.zena` reads the command line (`zena:args`) and dispatches.
     Beside it: `env.zena` (what the host told the module, shared flags),
     `compile.zena` (compiling, and the compile cache), `run.zena`,
     `test-run.zena`, and `bench-run.zena`, which hands a suite to
     `zena:bench`'s `runSuite` with a function that compiles its `zena`
     variants.
   - It is built to `out/zena.wasm` by `build:module`, with the compiler
     (`zena-compiler:compile-file`), zb, zenadoc and the formatter linked
     in. Other programs (the VS Code extension's `lsp.wasm`, the
     playground) have their own entry points built from the same
     libraries.

2. **The host binary: `src/main.rs`**
   - Loads the CLI module and runs its `main`, with WASI preview 1 and the
     `zena-runtime` imports. It has no command-line logic of its own.
   - Preopens the repository root as `.` (first, so relative paths mean the
     repository: the compiler reads `zena-packages.json` and
     `packages/stdlib/zena` relative to it) and `/` as `/`.
   - Grants spawning, so zb can run build commands and the module can run
     other modules with `zena:wasm`.
   - Sets `ZENA_REPO_ROOT`, `ZENA_CWD` (where the user is; user paths are
     resolved against it, see `resolveUserPath`), `ZENA_CLI_MODULE` and
     `ZENA_AVAILABLE_PARALLELISM`.
   - `ZENA_REPO_ROOT` defaults to the checkout the binary was built in;
     `ZENA_CLI_MODULE` defaults to `packages/zena-cli/out/zena.wasm` under
     it.

3. **Compiling**
   - In-process by default: the compiler is part of the module. With
     `ZENA_COMPILER_WASM` set, that compiler module is run instead, through
     `zena:wasm`, with the preopens `zc` expects. Build scripts use it to
     pick a compiler (`build:self-hosted` uses stage A, the fixpoint check
     uses stage B).
   - `run`, `test` and `bench` compile through a cache (`compileCached`): a
     module plus a `.deps` file listing every file the compile read, with
     modification time and size. `build` always compiles.

4. **Tests**
   - `zena test` finds files with `zena:fs`'s `glob`, then starts one copy
     of the CLI module per file (`zena test --single <file>`) with
     `zena:wasm`, at most `ZENA_TEST_PARALLELISM` (default: CPUs, up to 8)
     at a time. Each copy compiles its file in test mode and runs it with
     `zena:wasm`, with the repository as `.`, the stdlib as `/stdlib` and a
     temporary directory as `/tmp`.

5. **The bootstrap and the build order**
   - `zena-run` runs the checked-in bootstrap to build the compiler
     (`zena-compiler:build:cli`), and then that compiler to build the CLI
     module. Neither step needs `zena-cli`, which needs the module.

6. **Output Standardization (Silent by Default)**
   - Standard output is the program's own output only, so
     `zena run data.zena | grep foo` works. The compiler's output from a
     `run` is held back unless the compile fails; with the in-process
     compiler, diagnostics go to stderr and `--time` reports to stdout.

## Agent Guidelines & Warnings

- **A change to the CLI module needs a rebuild of the module**, not just of
  the binary: `npm run build -w @zena-lang/zena-cli` does both.
- **Debugging**: `-g` names functions in compiled modules and turns off
  wasmtime's inlining for the runs the command starts. The CLI module is
  built with its name section, so a trap inside it prints a readable
  backtrace.
- **Workspace Navigation**: The Cargo workspace is the repository root
  (`Cargo.toml` and `Cargo.lock` there); use `cargo build -p zena-cli`,
  `cargo check`, and `cargo clippy` from the root, and
  `cargo test -p zena-runtime -p zena-cli -p zena-run` for all three crates.
