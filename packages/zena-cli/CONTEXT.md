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
     `test-run.zena`, `bench-run.zena`, which hands a suite to
     `zena:bench`'s `runSuite` with a function that compiles its `zena`
     variants, `lsp.zena`, which connects the language server
     (`language-service:server`) to stdin and stdout, `lint.zena`,
     which runs zena-lint's rules (`zena-lint:lint`) over files and
     prints the findings or, with `--fix`, applies them, `fetch.zena`,
     which fetches the packages `zena-lock.json` pins into the package
     cache with `package-manager:fetch`, and `add.zena`, for `zena add`
     and `zena update`, which change the dependencies in
     `zena-package.json`, select versions (`package-manager:resolve`), pin
     them and fetch them, and `login.zena`, for `zena login` and
     `zena logout`, which keep the maintainer's atproto session
     (`atproto:session`) in the configuration directory, and
     `publish.zena`, for `zena publish` and `zena package create`, which
     call a package host's `dev.zena-lang.host.*` methods with service-auth
     tokens from that session.
   - It is built to `out/zena.wasm` by `build:module`, with the compiler
     (`zena-compiler:compile-file`), zb, zenadoc, the language service and
     the formatter linked
     in. Other programs (the VS Code extension's `lsp.wasm`, the
     playground) have their own entry points built from the same
     libraries.

2. **The host binary: `src/main.rs`**
   - Loads the CLI module and runs its `main`, with WASI preview 1 and the
     `zena-runtime` imports. It has no command-line logic of its own.
   - The repository's binary (`build:cargo`) is built without
     `--features bundled`, so its bundle is a stub. That is all an
     in-repository binary needs: `resolve_stdlib_dir` and `cli_module`
     prefer the repository's own `packages/stdlib/zena` and `out/zena.wasm`
     and reach the embedded copies only when there is no repository. So the
     binary's inputs are Rust alone: cargo builds it while the bootstrap
     builds the compiler, and a change to the standard library or the
     compiler needs no Rust rebuild to take effect.
   - `build:standalone` builds the copy that runs outside a repository.
     `--features bundled` makes `build.rs` require `out/stdlib_bundle.rs`,
     which `build:bundle-assets` generates from the standard library's
     sources and the CLI module. It builds into `target/standalone`, so it
     never replaces the repository's binary, and `build` does not run it,
     since nothing in the repository runs that binary.
   - `zena-run`, `zena-cli` and `zfx` share every compiled dependency,
     wasmtime and Cranelift included, because every crate depends on
     `packages/workspace-hack`, which `cargo hakari` generates with the
     union of the features the workspace turns on for each shared crate.
     Without it each `cargo build -p <binary>` resolves its own features,
     and one feature apart is a separate copy of wasmtime: `log`'s `std`,
     which only `zena-run` turned on, was enough. After changing a Rust dependency, run
     `cargo hakari generate && cargo hakari manage-deps`; CI fails until
     the crate matches. See `packages/workspace-hack/CONTEXT.md`.
   - Preopens the repository root as `.` (first, so relative paths mean the
     repository: the compiler reads the workspace's `zena-package.json` and
     `packages/stdlib/zena` relative to it) and `/` as `/`.
   - Grants spawning, so zb can run build commands and the module can run
     other modules with `zena:wasm`.
   - Sets `ZENA_REPO_ROOT`, `ZENA_CWD` (where the user is; user paths are
     resolved against it, see `resolveUserPath`), `ZENA_CLI_MODULE`,
     `ZENA_AVAILABLE_PARALLELISM` and `ZENA_STDLIB_DIR` (`/stdlib`), in
     place of any values the shell has for them
     (`zena_runtime::inherited_env_with`).
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
   - This package's own tests run the built binary from Zena
     (`tests/*_test.zena`, the `test:zena` script). What they vary is the
     command's environment (the compile cache's directory, the standard
     library it reads, the configuration directory, the PLC directory),
     which a test module cannot change for itself. So each test starts
     the `zena` command with `zena:process`, setting and removing
     variables with `SpawnOptions.env` and `envRemove`
     (`tests/cli-support.zena`). The test runner gives each test
     `ZENA_REPO_ROOT`, the repository's host path, so a test can name its
     scratch directories, under `.zena/test-scratch`, both ways. Servers a
     test needs, such as the fake PDSes in `tests/fixtures/`, run as
     separate `zena run` processes, since waiting on a process blocks the
     test's event loop. They compile into one cache that every test and
     run shares (`.zena/test-fixture-cache`), so a fixture compiles again
     only when it, its imports or the compiler change; the commands a test
     runs get caches of their own in its scratch directory. `cargo test` (`test:cargo`) covers the Rust
     crates' own unit tests.
   - `test:pds-js`, which `test` does not run because it needs the
     network, signs in to pds.js, a PDS someone else wrote, with a real
     app password (`tests/pds-js/`). `setup.mjs` fetches pds.js at the
     revision docs/design/pds.md pins into the cache, and runs its server
     on Node.js 24 from nixpkgs, or `PDS_JS_NODE`, since the
     better-sqlite3 it locks does not build on Node.js 26.

5. **The bootstrap and the build order**
   - `zena-run` runs the checked-in bootstrap to build the compiler
     (`zena-compiler:build:cli`), and then that compiler to build the CLI
     module. Neither step needs `zena-cli`, which needs the module. The
     language service's `lsp.wasm`, which the playground and the VS Code
     extension load, is built the same way, so neither waits for the
     `zena` command.
   - `build:bundle-assets` keeps that true for the standalone binary:
     `zena-run` compiles `dev/bundle.zena` with the compiler and runs the
     result, so the bundle the binary embeds is produced without a binary.
     Precompiling the module (`precompile:module`) comes after the binary,
     because wasmtime's version is what decides whether a `.cwasm` loads.

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
  Add `--release` to reuse the artifacts `npm run build` compiled; without
  it cargo builds wasmtime again in the dev profile.
