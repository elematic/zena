# Iterable and Array Utility Methods

This document outlines the design and implementation phases for standard
iteration utility methods in the Zena standard library.

## Overview

Zena aims to provide a rich set of iteration utilities (similar to Rust, Swift,
and JavaScript) to allow ergonomic data processing. To maximize code reuse
without sacrificing WASM layout predictability, generalized utilities will be
provided via **Mixins** applied to the standard library collections (`Array`,
`FixedArray`, `String`, etc.).

The implementation is split into two phases due to current language constraints
surrounding generic instantiation (Higher-Kinded Types) and static factories.

## Phase 1: Terminal and Non-Allocating Methods (Current)

The first phase focuses on methods that evaluate an iterator and return a
terminal value without allocating new dynamically-typed collections. These can
be implemented immediately using existing language features.

These methods will be housed in a generalized `IterableUtils<T>` mixin that can
be applied to any class implementing `Iterable<T>`.

### Planned Methods

- **`contains(value: T): boolean`**: Checks for value equality. Chosen over
  JavaScript's `includes` to match strictly typed languages and align with
  `String.contains`.
- **`all(predicate: (T) => boolean): boolean`**: Returns true if all elements
  match the predicate.
- **`some(predicate: (T) => boolean): boolean`**: Returns true if any element
  matches the predicate.
- **`fold<R>(initial: R, combine: (R, T) => R): R`**: Reduces the collection to
  a single value. Named `fold` (requiring an explicit initial value) instead of
  JavaScript's `reduce` to ensure type safety and avoid runtime traps on empty
  collections.
- **`join(separator: String): String`**: Concatenates elements into a string.
- **`find(predicate: (T) => boolean): inline (true, T) | inline (false, _)`**:
  Finds the first matching element. Uses Zena's zero-allocation inline
  multi-value returns instead of `Option<T>` for maximum performance (matching
  `Map.get()`).

### Intentional Omissions

- **`forEach`**: Intentionally omitted. Idiomatic Zena uses `for/in` loops,
  which the compiler natively lowers into zero-overhead Wasm loops. Omitting
  `forEach` prevents unnecessary closure allocations and encourages idiomatic
  performance.

## Phase 2: Transforming and Allocating Methods (Future)

The second phase introduces type-transforming and collection-allocating methods
(`map`, `filter`, `flatMap`).

For data structures like `FixedArray<T>`, we want `map<U>` to return a
`FixedArray<U>`, not a generic `Sequence<U>` or `GrowableArray<U>`.

### The Challenge

Providing these generically inside a mixin currently conflicts with limitations:

1. **Generic Construction / HKTs**: We cannot easily return `this<U>` from a
   mixin, as Zena does not currently support using `this` as a generic type
   constructor.
2. **Static Factories**: Creating a new array generically requires calling a
   static `create(capacity)` method on the implementing class, which depends on
   the "Classes as Values and Static Interfaces" feature.

### The Future Architecture

Once **Classes as Values** and **Static Interfaces** are implemented in the
compiler:

1. Base collections will implement generic static factories.
2. An `ArrayOps<T>` mixin will leverage `(typeof this).create(len)` to allocate
   the exact concrete class array natively.
3. Language support for `this<U>` (or a similar construct) will allow the
   mixin's `map<U>` signature to correctly type the return value as the
   transformed concrete type (e.g., `GrowableArray<U>`).

### Short-Term Workaround (Manual Implementation)

Until Phase 2 compiler features are available, `map` and `filter` will remain
manually duplicated within the concrete collection classes (e.g., `FixedArray`
implements its own `map<U>` directly). This ensures type safety and performance
via duplication until the generics system can safely abstract it.
