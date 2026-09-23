# Zena CLI (`zena-cli`)

The `zena` command: build, run and test Zena programs, build targets,
extract API docs, format and benchmark.

The command is a Zena program. `zena/main.zena` and the files beside it
are the **CLI module**, compiled to `out/zena.wasm` with the compiler,
zb, zenadoc and the formatter linked in. `zena-cli` is the Rust binary
that runs it on wasmtime. See
[docs/design/cli-module.md](../../docs/design/cli-module.md).

The host-side pieces (engine configuration, the `.cwasm` cache, the
stack-trace, `zena:process` and `zena:wasm` imports) live in the
[`zena-runtime`](../zena-runtime) crate. [`zena-run`](../zena-run) embeds
the same crate to run any compiled module.

## Building

```bash
npm run build -w @zena-lang/zena-cli
```

That builds the binary (`build:host`), then the compiler from the
checked-in bootstrap, then the CLI module with that compiler
(`build:module`).

## Usage

```bash
zena-cli run examples/hello-world.zena
zena-cli build main.zena -o main.wasm
zena-cli test packages/stdlib/tests
zena-cli build ./packages/zb:test      # a wireit target, run with zb
zena-cli --help
```

## Development and Architecture

For architectural insights, design constraints, and AI agent instructions
regarding this application, please refer to [CONTEXT.md](./CONTEXT.md).
