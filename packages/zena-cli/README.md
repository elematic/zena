# Zena CLI (`zena-cli`)

The official Rust-based command-line interface and execution engine for the Zena
programming language.

## Purpose

Since Zena compiles to standard WebAssembly and targets WASI, Zena programs
_can_ run in any compliant Wasm runtime (including the web). However, this
custom Rust CLI exists for **convenience and enhanced capabilities**:

- **Extended APIs:** Several tools, such as the Zena compiler and CLI, work best
  with capabilities beyond standard WASI:
  - Extracting backtraces from exceptions
  - Spawning child processes
  - Dynamically compiling and running Wasm modules
- **Performance:** It caches Wasmtime-compiled native machine code, greatly
  speeding up startup times.
- **Ergonomics:** It automatically configures all the experimental Wasmtime
  flags required by Zena (e.g., GC, reference types, and exceptions).
- **Bundling:** It provides a vehicle to bundle the Zena compiler, CLI, and test
  runner into a single installable binary.

While standard Zena programs work anywhere, `zena-cli` acts as the optimized,
fully-featured native host for the Zena ecosystem.

## Building

```bash
cargo build --manifest-path packages/zena-cli/Cargo.toml
```

## Usage

```bash
# Run a Zena file directly (silently outputs only the program's output)
cargo run --manifest-path packages/zena-cli/Cargo.toml -- run examples/hello-world.zena

# Run with verbose engine diagnostic logs
cargo run --manifest-path packages/zena-cli/Cargo.toml -- --verbose run examples/hello-world.zena
```

## Development and Architecture

For architectural insights, design constraints, and AI agent instructions
regarding this application, please refer to [CONTEXT.md](./CONTEXT.md).
