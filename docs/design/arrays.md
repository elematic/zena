# Arrays Design

## Overview

Arrays in Zena (`Array<T>`) are implemented as raw WebAssembly GC Arrays (`(array (mut T))`). They are **not** boxed in a struct wrapper. This ensures zero-overhead access and interoperability with other WASM languages/modules that use standard GC arrays.

## Type System

The `Array<T>` class is defined in the standard library prelude.

```typescript
export class Array<T> {
  length: i32;
}
```

However, the compiler treats this class specially:

1.  **Type Checking**: The checker resolves `Array<T>` to an internal `ArrayType` rather than a `ClassType`.
2.  **Code Generation**: The generator maps `Array<T>` directly to a WASM array type index, not a struct type index.

## Implementation Details

### Literals

Array literals `#[a, b, c]` are compiled to `array.new_fixed`.

### Indexing

- `arr[i]` compiles to `array.get`.
- `arr[i] = v` compiles to `array.set`.
- Bounds checking is performed by the WASM engine (traps on out-of-bounds).

### Properties

- `.length`: This is a special property access. It compiles directly to the `array.len` WASM instruction.

## Methods & Extensions

Since WASM arrays are not structs, they do not have a VTable or fields other than their length and elements. This presents a challenge for method calls like `arr.map(...)`.

### Approach: Static Dispatch

Methods defined on the `Array` class in the prelude (or via extension methods in the future) will be compiled as **static functions**.

When the compiler sees a method call on an `Array<T>`:

1.  It checks if the method exists on the `Array` class definition.
2.  It emits a call to the corresponding static function, passing the array instance as the first argument (`this`).

## ByteArray vs Array<i8>

Zena includes a specialized `ByteArray` type.

### Why not just `Array<i8>`?

1.  **WASM Storage Types**: While WASM only has `i32`/`i64`/`f32`/`f64` as value types on the stack, it supports `i8` and `i16` as **storage types** in arrays and structs.
2.  **Efficiency**: `ByteArray` maps directly to `(array (mut i8))`. This is the most compact representation for binary data and strings.
3.  **Ambiguity**: If we used `Array<i32>` (since `i8` isn't a first-class language type yet), it would use 4 bytes per element. `ByteArray` guarantees 1 byte per element.
4.  **Access**: Accessing a `ByteArray` uses `array.get_u` (or `array.get_s`), which loads the byte and automatically extends it to an `i32` on the stack. No manual shifting is required.

In the future, if Zena supports `i8` as a distinct type in the type system (even if it's `i32` at runtime), `Array<i8>` could become an alias for `ByteArray`. For now, `ByteArray` is an explicit primitive for this optimized storage.

## Growability

WASM GC arrays are **fixed-length** upon creation. They cannot be resized in place.

- **`Array<T>`**: Will remain fixed-length, similar to arrays in Java or C#.
- **`List<T>` / `Vector<T>`**: We will implement a growable collection class (e.g., `List<T>`) in the standard library. This class will:
  - Be a standard `class` (struct).
  - Contain a backing `Array<T>` field.
  - Track a `size` (logical length) separate from the backing array's capacity.
  - Reallocate and copy the backing array when capacity is exceeded.

## Inheritance

Since `Array<T>` maps directly to a WASM array primitive, it **cannot be subclassed**. WASM does not support inheritance for array types.

- `class MyArray extends Array<i32> {}` // Compile-time Error

To create custom collection types, developers should:

1.  Implement a common interface (e.g., `List<T>`, `Iterable<T>`).
2.  Use composition (wrap an `Array<T>` in a field).

This aligns with the "composition over inheritance" principle and the limitations of the underlying VM.

This is similar to how `String` works in many languages (it's final/sealed) or how arrays work in Java/C#.

## Future: Typed Arrays & Buffers

The user might ask about `Uint8Array`, `Int32Array`, or `ArrayBuffer` support, similar to JavaScript.

### Design Decision

Since Zena targets WASM-GC, we do not have direct access to "linear memory" in the same way as WASM MVP. All objects are managed by the GC.

1.  **Typed Arrays**:
    - We do **not** need separate `Int32Array`, `Float32Array` classes.
    - `Array<i32>` compiles to `(array (mut i32))`, which is already a packed, efficient 32-bit integer array.
    - `Array<f32>` compiles to `(array (mut f32))`.
    - `ByteArray` (or `Array<i8>`) compiles to `(array (mut i8))`.
    - Therefore, generic arrays `Array<T>` **are** the typed arrays in Zena.

2.  **ArrayBuffer & Views**:
    - In JS, `ArrayBuffer` allows viewing the same memory chunk as different types (e.g., bytes vs floats).
    - WASM-GC arrays are **opaque** and strongly typed. You cannot cast `(array i8)` to `(array f32)` cheaply.
    - **DataView**: We can implement a `DataView` class that wraps a `ByteArray` and provides methods like `getFloat32(offset)`, `getInt32(offset)`. These methods would use bit-manipulation or WASM conversion instructions to reconstruct values from bytes.
    - **Conclusion**: We likely won't have `ArrayBuffer` as a primitive. `ByteArray` serves as the raw binary storage.
