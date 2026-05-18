# Compiler Intrinsics

This document serves as the canonical reference for compiler intrinsics in the Zena language. Intrinsics are special functions or operations that are understood natively by the compiler, bypassing standard function call semantics to emit direct WebAssembly opcodes or GC array instructions.

Intrinsics are declared in standard library files using the `@intrinsic("name")` decorator on a `declare function` or `declare class` method, or they are injected as hardcoded prefixes during compilation.

## 1. WebAssembly Memory & General Intrinsics

These intrinsics map directly to native WebAssembly memory or administrative opcodes.

| Intrinsic Name | WebAssembly Opcode | Description                                                           |
| -------------- | ------------------ | --------------------------------------------------------------------- |
| `memory.size`  | `memory.size`      | Returns the current size, in pages, of the module's memory.           |
| `memory.grow`  | `memory.grow`      | Grows memory by a given number of pages. Returns previous size or -1. |
| `i32.load`     | `i32.load`         | Loads a 32-bit integer from memory.                                   |
| `i32.load8_u`  | `i32.load8_u`      | Zero-extends an 8-bit value loaded from memory.                       |
| `i32.load8_s`  | `i32.load8_s`      | Sign-extends an 8-bit value loaded from memory.                       |
| `i64.load`     | `i64.load`         | Loads a 64-bit integer from memory.                                   |
| `f32.load`     | `f32.load`         | Loads a 32-bit float from memory.                                     |
| `f64.load`     | `f64.load`         | Loads a 64-bit float from memory.                                     |
| `i32.store`    | `i32.store`        | Stores a 32-bit integer into memory.                                  |
| `i32.store8`   | `i32.store8`       | Stores an 8-bit integer into memory (wrapping the value).             |
| `i64.store`    | `i64.store`        | Stores a 64-bit integer into memory.                                  |
| `f32.store`    | `f32.store`        | Stores a 32-bit float into memory.                                    |
| `f64.store`    | `f64.store`        | Stores a 64-bit float into memory.                                    |
| `unreachable`  | `unreachable`      | Emits a trap instruction.                                             |

## 2. Low-Level Math & Operations (Dynamic Dispatches)

Any operation matching standard WebAssembly opcodes where the name mimics the opcode structure (replacing `.` with `_`).

Examples include:

- `i32.clz`
- `f64.abs`
- `f32.copysign`
- `i32.trunc_sat_f32_s` (saturating truncation opcodes fall back via `SatOpcode` maps).

## 3. Dynamic System Intrinsics

These require more complex codegen than a single opcode.

- `eq`: Handles deep comparison. It dispatches statically to exact `i32.eq` / `f32.eq` for primitives, calls `String.operator==` statically for strings, and relies on vtable dynamic dispatch for classes implementing overloaded `==` operators. Falls back to `ref.eq`.
- `hash`: Computes the proper hash of a value, traversing the vtable for `hashCode` implementations on reference objects.
- `wasi_write_string`: Synthesizes an ad-hoc function internally that performs the WASI standard `fd_write` procedure on string buffers.

## 4. Wasm GC Arrays (`__array_*`)

The compiler predefines these explicitly for `array<T>` structures (represented under the hood as `array` GC types).

| Intrinsic Function  | Emitted Wasm GC Opcode | Notes                                                                             |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `__array_len`       | `array.len`            | Gets the length of an array.                                                      |
| `__array_get`       | `array.get`            | Gets an element by index.                                                         |
| `__array_set`       | `array.set`            | Sets an element by index.                                                         |
| `__array_new`       | `array.new`            | Allocates an array initializing all slots to the default parameter value.         |
| `__array_new_empty` | `array.new_default`    | Allocates an array leaving slots initialized to their Wasm default (`null`, `0`). |

## 5. Byte Arrays (`__byte_array_*`)

Zena manages byte arrays (like strings/buffers) as a globally declared type: struct 8 array. These functions ensure type generation mapping to that unique byte array `TypeIndex`.

| Intrinsic Function    | Emitted Wasm GC Opcode | Notes                                                            |
| --------------------- | ---------------------- | ---------------------------------------------------------------- |
| `__byte_array_new`    | `array.new_default`    | Allocates a byte array of the specific `ctx.byteArrayTypeIndex`. |
| `__byte_array_length` | `array.len`            |                                                                  |
| `__byte_array_get`    | `array.get_u`          | Unsigned 8-bit read from the byte array GC struct.               |
| `__byte_array_set`    | `array.set`            | Modifies the byte array.                                         |
| `__byte_array_copy`   | `array.copy`           | Performs hardware-accelerated GC array segment copying.          |
