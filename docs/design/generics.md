# Generics Design

## Overview

Generics allow defining functions, classes, and interfaces that work over a
variety of types while maintaining type safety.

## Goals

1.  **Performance**: Zero-overhead abstractions. `List<i32>` should store raw
    `i32` values, not boxed objects.
2.  **Type Safety**: Compile-time checks for type correctness.
3.  **Simplicity**: Easy to understand syntax and semantics.

## Implementation Strategy: Monomorphization

There are two main approaches to implementing generics:

1.  **Type Erasure (Java/TypeScript)**: All generic types map to a single
    runtime representation (e.g., `Object` or `void*`). Primitives must be
    "boxed" (allocated on the heap).
2.  **Monomorphization (C++/Rust/AssemblyScript)**: The compiler generates a
    specialized copy of the code for each concrete type argument used.
    `List<i32>` and `List<f32>` become two distinct classes in the output.

### Recommendation for Rhea: Monomorphization

Given Rhea's goal of targeting WASM-GC efficiently:

- **WASM Primitives**: `i32`, `f64`, etc., are not objects. They cannot be
  stored in a `(ref any)` field without allocation (boxing).
- **Performance**: To avoid the massive overhead of boxing every integer in a
  `Map<i32, i32>`, we **must** use monomorphization.
- **Binary Size**: While this increases binary size (code duplication),
  dead-code elimination will ensure we only emit the specializations actually
  used.

## Syntax (TypeScript-like)

### Generic Classes

```typescript
class Box<T> {
  value: T;
  #new(v: T) {
    this.value = v;
  }
}

let b = new Box<i32>(10);
```

### Generic Functions

```typescript
const identity = <T>(arg: T): T => arg;

let x = identity<i32>(10);
```

## Variance

Variance describes how subtyping between complex types relates to subtyping
between their components.

- **Covariance (`out T`)**: If `Cat` extends `Animal`, then `Producer<Cat>` is
  a `Producer<Animal>`. Safe for _reading_.
- **Contravariance (`in T`)**: If `Cat` extends `Animal`, then
  `Consumer<Animal>` is a `Consumer<Cat>`. Safe for _writing_.
- **Invariance**: No subtyping relationship. `List<Cat>` is not
  `List<Animal>`. Required for mutable data structures (read & write).

### C# Approach

C# allows explicit variance annotations on **interfaces** and **delegates**
(e.g., `interface IEnumerable<out T>`). Classes are always invariant.

### Rhea Approach

To start, Rhea should enforce **Invariance** for all generic classes.

- `Box<String>` is NOT a subtype of `Box<Object>`.
- This is simple, safe, and sufficient for `Map` and `Array`.
- We can explore variance later if we add Interfaces.

## Compilation Process (Monomorphization)

1.  **Parsing**: Parse generic parameters `<T>` in AST.
2.  **Type Checking**:
    - When `new Box<i32>` is encountered, register a "request" for
      specialization `Box_i32`.
    - Check the body of `Box` substituting `T` with `i32`.
3.  **Codegen**:
    - Instead of generating code for `Box` directly, generate code for each
      requested specialization (`Box_i32`, `Box_string`, etc.).
    - Mangle names: `Box<i32>` -> `Box_i32`.

## Constraints

We may need to constrain generic types (e.g., `T extends SomeClass`).

- _Initial Scope_: Unconstrained generics.

## Impact on Standard Library

With generics, we can implement `Map` properly:

```typescript
class Map<K, V> {
  buckets: Array<Entry<K, V>>;
  // ...
}
```

The compiler will generate `Map_i32_string` when the user writes `new Map<i32,
string>()`.
