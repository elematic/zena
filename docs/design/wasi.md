# WASI Support Design

## Overview

This document outlines the plan for adding WASI (WebAssembly System Interface) support to Zena. The goal is to allow Zena programs to run in WASI-compliant runtimes (wasmtime, Node.js via jco, browsers) and consume WASI APIs (filesystem, HTTP, etc.).

We target **WASI Preview 2** initially, moving to **Preview 3** for async support.

## 1. The Component Model & WIT

WASI is now built on the **Component Model**. This requires:

1.  **WIT (Wasm Interface Type) Files**: These define the "World" (imports and exports) of a component.
2.  **Canonical ABI**: A standard for passing high-level types (strings, records, variants) between components using Linear Memory.

### Strategy

- **Consumption**: The compiler will eventually need to read `.wit` files to generate type definitions and bindings. For now, we can manually define the bindings in Zena.
- **Production**: We will produce a standard WASM Core Module. We will use external tools (like `wasm-tools component new`) to package this into a WASM Component.

## 2. Type Mapping & Memory

Zena is a **WASM-GC** language. The Component Model currently relies on **Linear Memory**. This creates a "boundary" we must manage.

| WIT Type                | Zena Type    | ABI Representation                      |
| :---------------------- | :----------- | :-------------------------------------- |
| `u32`, `s32`, `float32` | `i32`, `f32` | Direct                                  |
| `string`                | `string`     | `(ptr: i32, len: i32)` in Linear Memory |
| `record`                | `struct`     | Serialized bytes in Linear Memory       |
| `list<T>`               | `array<T>`   | `(ptr: i32, len: i32)` in Linear Memory |
| `resource`              | `class`      | `i32` (Handle index)                    |

### The "Lowering" Process

To call a WASI function, we cannot pass a Zena GC object directly. We must:

1.  **Allocate** space in Linear Memory.
2.  **Copy** data from the GC object to Linear Memory (Serialization).
3.  **Call** the host function with pointers.

### The "Lifting" Process

When receiving data from WASI:

1.  The host writes data to Linear Memory.
2.  We **read** it and construct Zena GC objects (Deserialization).

## 3. Strings

Zena strings are UTF-8 bytes.

- **Exporting**: We pass `(pointer, length)`. Since Zena strings are GC objects, we might need to copy the bytes to Linear Memory to ensure they are pinned/stable, or use a mechanism to pin them if supported.
- **Importing**: The host needs to write strings into our memory. We must export a `cabi_realloc` function that the host calls to allocate space in our Linear Memory.

## 4. Resources & GC Integration

The Component Model uses **Resources** to represent opaque objects.

- **Handles**: A resource is passed as an `i32` handle.
- **Table**: We need a "Resource Table" in Zena to map these `i32` handles to actual Zena GC objects.
  - `host_handle -> Zena Object`: When the host gives us a handle.
  - `Zena Object -> host_handle`: When we pass an object to the host.

## 5. Async (Preview 3)

Preview 3 introduces `future` and `stream` types.

- **Model**: It is not a callback-based model like JS. It is a polling model.
- **Integration**:
  - We will likely map WASI `future` to a Zena `Promise` (or `Future`).
  - The runtime will need to integrate with the host's "task" system, yielding execution when waiting for a future.

## 6. Implementation Plan

### Phase 1: "Hello World" (CLI)

- Target `wasi:cli/stdout`.
- Implement `cabi_realloc`.
- Implement string lowering (copy GC string bytes -> Linear Memory).
- Manually write the Zena binding for `print`.
- Test using `jco` in Node.js.

### Phase 2: Tooling Integration

- Add a compiler flag to generate a Component (wrapping the core module).
- Automate WIT binding generation.

### Phase 3: Async & Resources

- Implement Resource Tables.
- Implement Async/Await mapped to WASI Futures.

## Testing Strategy

We will use **`jco` (JavaScript Component Toolchain)**.

1.  Compile Zena -> WASM.
2.  `jco transpile` -> JS.
3.  Run in Node.js.
    `jco` provides polyfills for WASI Preview 2, allowing us to run tests in our existing Node environment without needing a separate `wasmtime` binary for every test.
