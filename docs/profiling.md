# Profiling the Zena Self-Hosted Compiler

This guide explains how to profile the self-hosted compiler (`cli.wasm`) executing under Wasmtime JIT on macOS using **`samply`** and the Firefox Profiler.

---

## How It Works

Because the self-hosted compiler runs as a WebAssembly module inside `zena-cli`, standard system-level profilers (like Apple Instruments) cannot resolve WebAssembly guest stack traces by default.

To solve this, we configure Wasmtime to emit native JIT symbol maps via `--profile=perfmap` (or `ProfilingStrategy::PerfMap` in the Rust API) whenever the `ZENA_PROFILE` environment variable is defined. The `samply` profiler captures these JIT symbols to construct a symbolicated flame graph on [profiler.firefox.com](https://profiler.firefox.com).

---

## Setup Instructions

### 1. Install `samply`

Install the native sampler tool using cargo:

```bash
cargo install samply --locked
```

### 2. Configure Entitlements & Workaround Library Validation (macOS)

On macOS, attaching to a running process requires the debugger entitlement. Run:

```bash
samply setup
```

Because our development environment uses Nix flakes, `samply` will load Nix-managed dynamic libraries (like `libiconv`) that are ad-hoc signed under a different Team ID. To prevent macOS's Hardened Runtime from blocking library loading, re-sign the `samply` binary to disable library validation:

```bash
cat <<EOF > entitlements.xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
        <key>com.apple.security.cs.debugger</key>
        <true/>
        <key>com.apple.security.cs.disable-library-validation</key>
        <true/>
</dict>
</plist>
EOF

codesign --force --options runtime --sign - --entitlements entitlements.xml ~/.cargo/bin/samply
rm entitlements.xml
```

---

## Running a Profiling Session

To record the compiler while building a benchmark (e.g., `stdlib_moderate`):

```bash
ZENA_PROFILE=1 samply record target/release/zena-cli build packages/zena-compiler/test-files/benchmarks/stdlib_moderate.zena -o out.wasm --time --no-cache
```

### Options:

- **`ZENA_PROFILE=1`**: Tells Wasmtime to enable PerfMap JIT symbol writing and native unwind registrations.
- **`--no-cache`**: Disables the compiler's internal caches to force a full compile run.

Once compilation finishes, `samply` will automatically spin up a local web server and launch your default browser to [profiler.firefox.com](https://profiler.firefox.com) pre-loaded with the execution profile.

---

## Analyzing the Profile

1. **Call Tree**: Displays flat hierarchical execution times. Filter by `cli.wasm` or specific Zena modules (e.g. `DiscoveryPass`, `Type`, `substituteTypeParamsInCodegen`) to inspect hot functions.
2. **Flame Graph**: Visualizes call stack depth and self time (bar width).
3. **Exclusive (Self) vs Inclusive (Total) Time**:
   - High **Inclusive** time but low **Self** time indicates a function is a driver (e.g., AST walkers).
   - High **Self** time indicates where execution cycles are actively being spent (e.g., GC scanning, string hashing, or array growing).

---

## Tuning Wasmtime Performance

By default, Wasmtime compiles with `native_unwind_info` enabled to support external unwinders (like `samply`). However, registering and deregistering DWARF frames for thousands of functions dynamically introduces significant process startup/teardown overhead (~130ms or ~24% of compiler process runtime).

For production execution:

- `native_unwind_info` is **disabled** by default in `zena-cli` to guarantee maximum speed.
- It is only turned back on when `ZENA_PROFILE=1` is specified to allow accurate stack capture.
