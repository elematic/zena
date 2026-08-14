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
  if (val is i32) {
    return val as i32;
  } else if (val is boolean) {
    return (val as boolean) ? 1 : 0;
  } else if (val is string) {
    return stringHash(val as string); // Internal helper
  } else if (val is Hashable) {
    return (val as Hashable).hashCode();
  } else {
    return 0; // Or identity hash
  }
}
```

## Required Language Features

To make this implementation as fast as the intrinsic, Zena needs specific features and optimizations.

### 1. `is` for Primitives

We need to be able to check if a generic type `T` is a specific primitive type.

- `val is i32`
- `val is boolean`

### 2. Compile-Time Constant Folding & Dead Code Elimination (DCE)

This is the critical piece. Zena uses **Monomorphization** for generics. When `hash<i32>(10)` is compiled, the compiler generates a specialized function `hash_i32(val: i32)`.

Inside `hash_i32`, `T` is known to be `i32`.

- `val is i32` becomes `true`.
- `val is string` becomes `false`.

The compiler **must** perform Dead Code Elimination to remove the unreachable branches _before_ code generation.

**Resulting Code for `hash_i32`:**

```zena
function hash_i32(val: i32): i32 {
  return val;
}
```

This can then be **inlined** at the call site, resulting in zero overhead, matching the intrinsic.

### 3. `is` Interface Checks

For `val is Hashable`, the compiler needs to check if the concrete type `T` implements `Hashable`.

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

1.  Implement `is` for primitives.
2.  Ensure the optimizer runs on monomorphized function bodies to strip dead branches.
3.  Move `hash` logic to `stdlib/hash.zena`.

## Status (2026-07-18)

Partially implemented, via a different route than proposed above:

- `Hashable` (hashCode-only) lives in `zena:hashable`, and `HashMap`,
  `HashSet`, `OrderedHashMap`, and `OrderedHashSet` constrain their keys with
  `K extends Hashable`.
- The `hash`/`eq` intrinsics remain the implementation mechanism, but they are
  no longer exported from the stdlib — they are private declarations inside
  the `zena:collections` library.
- All numeric primitives hash by value: i64/u64 fold high and low bits
  (`wrap(x ^ (x >>> 32))`), floats hash their bits after adding `+0.0` so
  that `-0.0` and `+0.0` (which compare equal) hash equally.
- Case class `hashCode()`/`==` are structural: string fields hash/compare by
  content, class-typed fields delegate to the field type's
  `hashCode()`/`operator ==` (null-safely), other reference fields fall back
  to identity.

### How Hashable conformance works today

Interface conformance is nominal, with layers for types that cannot declare
an implements clause:

- **Classes**: declare `implements Hashable` explicitly. `String` does this
  in the stdlib, delegating `hashCode()` to the compiler's cached FNV-1a
  helper.
- **Case classes**: _nominally implement_ `Hashable`. Both checkers append
  the well-known interface to their implements list during member synthesis,
  so case classes are assignable to `Hashable` (interface dispatch included)
  without an explicit clause.
- **Primitives, enums, distinct types**: these cannot implement interfaces
  (no extension classes in the stdlib yet), so they get a special
  _constraint-satisfaction_ rule in both checkers: they satisfy
  `K extends Hashable` but are **not** assignable to `Hashable` as values —
  assignability would require boxing, while constraint satisfaction only
  requires that the monomorphized intrinsics hash them correctly.

### Future direction

- **Bring back `operator ==` on `Hashable`**, likely as f-bounded
  polymorphism (`interface Hashable<T> { operator ==(other: T): boolean }`)
  so implementors keep their precise parameter types under invariant
  interface-method checking.
- **Swift-style `==` semantics**: a type must implement the `==` operator
  overload to be used with `==`, making `==` regular method dispatch (open to
  devirtualization and inlining). `===` remains reference equality on all
  objects.
- **Identity-keyed collections**: classes wanting identity semantics can
  implement `==` as `===` and `hashCode` as a counter, but we should offer an
  `IdentityMap` where the compiler injects an identity field for classes that
  need one.
- **Extension classes for all primitives**, to rationalize how primitives
  declare and check the interfaces they implement (including `Hashable`) and
  to hang utility methods off them. Two things follow from Zena's
  no-implicit-boxing rule:
  - Extension classes on primitives are **erased — type aliases with
    methods**. An extension class on `i32` _is_ an `i32` at runtime (they are
    already "indistinguishable" per the type-erasure rules), and its methods
    compile to static calls that take the receiver by value. There is no
    per-value vtable to hang dynamic dispatch off.
  - Therefore `implements Hashable` on such a type grants **constraint
    satisfaction, not assignability**. It makes the type usable where
    `K extends Hashable` is required — monomorphization resolves
    `key.hashCode()` to a direct call to the extension method, unboxed — but
    `let h: Hashable = 42` remains a compile error. Converting a primitive to
    an interface _value_ requires representation change, so it must be an
    explicit boxing step (e.g. a stdlib `Box<i32>` that itself implements
    `Hashable` by delegation), never an implicit coercion.

  This is Rust's model (traits on primitives are bounds first; trait objects
  are an explicit, separate step) rather than Swift's (implicit existential
  boxing via witness tables). It splits interface conformance into two
  capabilities — satisfying constraints vs. being an interface-typed value —
  and erased types simply only ever get the first. Today's hard-coded
  constraint-satisfaction rule for primitives is exactly this semantics; once
  extension classes land, it dissolves into stdlib declarations like
  `extension class on i32 implements Hashable { hashCode(): i32 { return
this; } }`, and the `hash` intrinsic's primitive fast paths become an
  optimization detail rather than language semantics. Distinct types over a
  primitive would inherit conformance from their underlying type's extension
  (as they do under today's rule).

- Replacing the intrinsics with pure-Zena dispatch (this document's original
  proposal) still requires `is` on primitives plus monomorphization-aware
  DCE.
