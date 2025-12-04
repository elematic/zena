# Design: Implementing `hash` in Zena

## Overview

Currently, the `hash` function is implemented as a compiler intrinsic (`@intrinsic('hash')`). This allows it to be highly optimized for primitives (returning the value itself) and strings, while falling back to a `hashCode()` method for objects.

This document explores the feasibility of implementing `hash` entirely in the Zena standard library, removing the need for a special compiler intrinsic.

## Goals

1.  **Performance**: The Zena implementation must match the performance of the intrinsic.
    - `hash(123)` must compile to `i32.const 123` (no function call, no boxing).
    - `hash(point)` must compile to a direct call to `Point.hashCode`.
2.  **Compactness**: The generated code should not be significantly larger.
3.  **Extensibility**: Users should be able to define how their types are hashed via a standard interface.

## Current Implementation Analysis

The current intrinsic implementation in `codegen/expressions.ts` (`generateHash`) works as follows:

1.  **Primitives (`i32`, `boolean`)**: The compiler emits the value directly.
    - **Code Duplication**: None (inlined).
    - **Performance**: Zero overhead.
2.  **Strings**: The compiler emits a call to a shared helper function.
    - **Code Duplication**: The hashing logic (FNV-1a) is generated **once** per module (`generateStringHashFunction`). All `hash(string)` calls share this single function.
    - **Performance**: Function call overhead + hashing logic.
3.  **Objects**: The compiler emits a call to the `hashCode()` method.
    - **Code Duplication**: None (method call).
    - **Performance**: Virtual or static method call.

This means the current implementation is already quite compact for strings. A pure Zena implementation should aim to replicate this "shared helper" behavior, likely via a private exported function in the standard library that the generic `hash` function calls.

## Proposed Implementation

### 1. The `Hashable` Interface

We define a standard interface that objects can implement.

```zena
interface Hashable {
  hashCode(): i32;
}
```

### 2. The `hash` Function

The `hash` function would be a generic function in the standard library.

```zena
export let hash = <T>(val: T): i32 => {
  if (val instanceof i32) {
    return val as i32;
  } else if (val instanceof boolean) {
    return (val as boolean) ? 1 : 0;
  } else if (val instanceof string) {
    return stringHash(val as string); // Internal helper
  } else if (val instanceof Hashable) {
    return (val as Hashable).hashCode();
  } else {
    return 0; // Or identity hash
  }
}
```

## Required Language Features

To make this implementation as fast as the intrinsic, Zena needs specific features and optimizations.

### 1. `instanceof` for Primitives

We need to be able to check if a generic type `T` is a specific primitive type.

- `val instanceof i32`
- `val instanceof boolean`

### 2. Compile-Time Constant Folding & Dead Code Elimination (DCE)

This is the critical piece. Zena uses **Monomorphization** for generics. When `hash<i32>(10)` is compiled, the compiler generates a specialized function `hash_i32(val: i32)`.

Inside `hash_i32`, `T` is known to be `i32`.

- `val instanceof i32` becomes `true`.
- `val instanceof string` becomes `false`.

The compiler **must** perform Dead Code Elimination to remove the unreachable branches _before_ code generation.

**Resulting Code for `hash_i32`:**

```zena
function hash_i32(val: i32): i32 {
  return val;
}
```

This can then be **inlined** at the call site, resulting in zero overhead, matching the intrinsic.

### 3. `instanceof` Interface Checks

For `val instanceof Hashable`, the compiler needs to check if the concrete type `T` implements `Hashable`.

- If `T` is `Point` (which implements `Hashable`), this check is statically true.
- The cast `val as Hashable` becomes a no-op (or a simple upcast).
- The call `(val as Hashable).hashCode()` becomes a direct call (or vtable call) to `Point.hashCode`.

### 4. Internal Helpers

We would need to expose the string hashing logic (currently hidden in the compiler) as a standard library function, perhaps `String.hash(s)`.

## Comparison

| Feature                  | Intrinsic                  | Zena Stdlib (with DCE)                  |
| :----------------------- | :------------------------- | :-------------------------------------- |
| **Performance (i32)**    | Instant (Inlined constant) | Instant (Inlined after DCE)             |
| **Performance (Object)** | Virtual Call / VTable      | Interface Call / VTable                 |
| **Binary Size**          | Small (Logic in compiler)  | Small (Specialized functions are small) |
| **Maintainability**      | Hard (TypeScript Codegen)  | Easy (Zena Code)                        |
| **Flexibility**          | Fixed behavior             | User can modify/extend                  |

## Conclusion

Implementing `hash` in Zena is **feasible and desirable**, provided that the compiler implements robust **Dead Code Elimination** for monomorphized generics.

**Benefits:**

1.  **Simplifies Compiler**: Removes complex intrinsic logic from `codegen/expressions.ts`.
2.  **Unifies Behavior**: The rules for hashing are visible in Zena code, not hidden in the compiler.
3.  **Optimizable**: Standard inlining and optimization passes apply naturally.

**Next Steps:**

1.  Implement `instanceof` for primitives.
2.  Ensure the optimizer runs on monomorphized function bodies to strip dead branches.
3.  Move `hash` logic to `stdlib/hash.zena`.
