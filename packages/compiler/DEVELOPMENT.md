# Development

Notes for working on `compiler`.

## Layout

- `src/lib/` — compiler libraries (`compiler.zena`, `parser.zena`, `checker.zena`, `codegen/`, etc.), published as the `compiler` package (`"source": "src/lib"`)
- `src/cli/` — standalone compiler CLI entry point (`zc`)
- `src/test/` — unit and compiler pipeline tests
- `src/bench/` — microbenchmarks for the lexer and string interning
- `src/` and `scripts/` — TypeScript build and test runner harnesses

## Building and Testing

Make sure you have the Nix environment active (`direnv allow` or `nix develop`) so Wasmtime is available for execution tests.

Run scripts via npm to use the Wireit cache:

```bash
# Build the self-hosted compiler CLI (stage A, compiled by packages/cli/bootstrap/zena.wasm)
npm run build:cli -w @zena-lang/compiler-zena

# Build all TypeScript scripts and Wasm test runners
npm run build -w @zena-lang/compiler-zena

# Run all self-hosted compiler tests (including the stage B = stage C fixpoint check)
npm test -w @zena-lang/compiler-zena

# Run compiler tests without the fixpoint check
npm run test:smoke -w @zena-lang/compiler-zena

# Run only the end-to-end execution tests
npm run test:execution -w @zena-lang/compiler-zena
```

To run a single Zena unit test file directly:

```bash
./target/release/zena test packages/compiler/src/test/compiler-api_test.zena
```

## Reseeding the Bootstrap Binary

When compiler changes need to be available to stage A (`packages/cli/bootstrap/zena.wasm`), reseed the bootstrap from the repository root after all tests and the fixpoint check pass:

```bash
npm run reseed
```

See `packages/cli/bootstrap/README.md` and `docs/design/bootstrapping.md` for details on the bootstrap stages and verification.

## Benchmarking

Benchmarks live at the repository root under `benchmarks/workloads/`, one program per workload, built at `-O2` and timed by `zena bench` with statistical sampling (`benchmarks/README.md` lists them).

```bash
npm run bench                                   # build every workload, report sizes
npm run bench:speed                             # time every workload
npm run bench -- --build --speed poly-param     # one workload
```

To time the compiler itself on a source file:

```bash
./target/release/zena build <file>.zena -o out.wasm --time --no-cache
```
