# Development

Notes for working on `zena-compiler`.

## Layout

- `zena/lib/` — compiler libraries (`compiler.zena`, `parser.zena`, `checker.zena`, `codegen/`, etc.), published as the `zena-compiler` package (`"source": "zena/lib"`)
- `zena/cli/` — standalone compiler CLI entry point (`zc`)
- `zena/test/` — unit and compiler pipeline tests
- `zena/bench/` — microbenchmarks for the lexer and string interning
- `bootstrap/` — checked-in bootstrap compiler binary (`cli.wasm`)
- `src/` and `scripts/` — TypeScript build and test runner harnesses

## Building and Testing

Make sure you have the Nix environment active (`direnv allow` or `nix develop`) so Wasmtime is available for execution tests.

Run scripts via npm to use the Wireit cache:

```bash
# Build the self-hosted compiler CLI (stage A, compiled by bootstrap/cli.wasm)
npm run build:cli -w @zena-lang/zena-compiler

# Build all TypeScript scripts and Wasm test runners
npm run build -w @zena-lang/zena-compiler

# Run all self-hosted compiler tests (including the stage B = stage C fixpoint check)
npm test -w @zena-lang/zena-compiler

# Run compiler tests without the fixpoint check
npm run test:smoke -w @zena-lang/zena-compiler

# Run only the end-to-end execution tests
npm run test:execution -w @zena-lang/zena-compiler
```

To run a single Zena unit test file directly:

```bash
./target/release/zena-cli test packages/zena-compiler/zena/test/compiler-api_test.zena
```

## Reseeding the Bootstrap Binary

When compiler changes need to be available to stage A (`bootstrap/cli.wasm`), reseed the bootstrap binary after all tests and the fixpoint check pass:

```bash
npm run reseed -w @zena-lang/zena-compiler
```

See `bootstrap/README.md` for details on the bootstrap stages and verification.

## Benchmarking

Benchmarks live at the repository root under `benchmarks/workloads/`, one program per workload, built at `-O2` and timed by `zena-cli bench` with statistical sampling (`benchmarks/README.md` lists them).

```bash
npm run bench                                   # build every workload, report sizes
npm run bench:speed                             # time every workload
npm run bench -- --build --speed poly-param     # one workload
```

To time the compiler itself on a source file:

```bash
./target/release/zena-cli build <file>.zena -o out.wasm --time --no-cache
```
