# Zena Self-Hosted Compiler

This package contains the **self-hosted compiler** for the Zena language
(`@zena-lang/zena-compiler`). It is written entirely in Zena and compiles itself
to WebAssembly (Wasm GC).

## Architecture

The compiler is organized into traditional phases:

- **Lexer**: Tokenizes Zena source code.
- **Parser**: Produces an Abstract Syntax Tree (AST).
- **Type Checker**: Performs name resolution and static type validation, storing
  semantic information.
- **Code Generator**: Converts the AST into executable WebAssembly GC bytecode.

## Building and Testing

Make sure you have the Nix environment active (`direnv allow` or `nix develop`)
to ensure Wasmtime is available for execution tests.

Run scripts via NPM to utilize the Wireit cache matrix:

```bash
# Build the self-hosted compiler CLI
npm run build:cli -w @zena-lang/zena-compiler

# Build all typescript scripts and wasm test runners
npm run build -w @zena-lang/zena-compiler

# Run all self-hosted compiler tests
npm test -w @zena-lang/zena-compiler

# Run only the end-to-end execution tests (Wasmtime sandbox)
npm run test:execution -w @zena-lang/zena-compiler
```

## Benchmarking

We have a micro-benchmarking suite to measure execution speed of Zena code (under `wasmtime` and Node.js) against native JS.

To run the full suite:

```bash
npm run benchmark -w @zena-lang/zena-compiler
```

### Filtering and Options

You can pass flags to the benchmark script to select specific suites or filter by test name:

- `--compiler`: Run only compiler compilation tests (comparing self-hosted and bootstrap compiler speeds).
- `--strings`: Run only the string micro-benchmark suite.
- `--filter <pattern>` (or `-f <pattern>`): Filter benchmarks to those whose names match the pattern.
- `--runs <N>` (or `-r <N>`): Number of iterations per benchmark target (defaults to 5).

Example to run only the `StringBuilder` benchmarks:

```bash
npm run benchmark -w @zena-lang/zena-compiler -- --filter StringBuilder
```
