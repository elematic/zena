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

*   `arr[i]` compiles to `array.get`.
*   `arr[i] = v` compiles to `array.set`.
*   Bounds checking is performed by the WASM engine (traps on out-of-bounds).

### Properties

*   `.length`: This is a special property access. It compiles directly to the `array.len` WASM instruction.

## Methods & Extensions

Since WASM arrays are not structs, they do not have a VTable or fields other than their length and elements. This presents a challenge for method calls like `arr.map(...)`.

### Approach: Static Dispatch

Methods defined on the `Array` class in the prelude (or via extension methods in the future) will be compiled as **static functions**.

When the compiler sees a method call on an `Array<T>`:
1.  It checks if the method exists on the `Array` class definition.
2.  It emits a call to the corresponding static function, passing the array instance as the first argument (`this`).

This avoids the need for a VTable and keeps arrays as raw primitives.

## Growability

WASM GC arrays are **fixed-length** upon creation. They cannot be resized in place.

*   **`Array<T>`**: Will remain fixed-length, similar to arrays in Java or C#.
*   **`List<T>` / `Vector<T>`**: We will implement a growable collection class (e.g., `List<T>`) in the standard library. This class will:
    *   Be a standard `class` (struct).
    *   Contain a backing `Array<T>` field.
    *   Track a `size` (logical length) separate from the backing array's capacity.
    *   Reallocate and copy the backing array when capacity is exceeded.

## Inheritance

Since `Array<T>` maps directly to a WASM array primitive, it **cannot be subclassed**. WASM does not support inheritance for array types.

*   `class MyArray extends Array<i32> {}` // Compile-time Error

To create custom collection types, developers should:
1.  Implement a common interface (e.g., `List<T>`, `Iterable<T>`).
2.  Use composition (wrap an `Array<T>` in a field).

This aligns with the "composition over inheritance" principle and the limitations of the underlying VM.

This is similar to how `String` works in many languages (it's final/sealed) or how arrays work in Java/C#.
