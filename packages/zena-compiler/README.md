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

Benchmarks live at the repository root under `benchmarks/workloads/`, one
small program per workload, built at `-O2` and timed by `zena-cli bench`
with statistical sampling; `benchmarks/README.md` lists them. Several are
pairs that set an abstract form of a computation against the same
computation written concretely, so the optimizer's remaining gap is the
number reported.

```bash
npm run bench                                   # build every workload, report sizes
npm run bench:speed                             # time every workload
npm run bench -- --build --speed poly-param     # one workload
```

To time the compiler itself on a source file:

```bash
./target/release/zena-cli build <file>.zena -o out.wasm --time --no-cache
```

