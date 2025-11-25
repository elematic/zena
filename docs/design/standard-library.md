# Standard Library & Module System Design

## Overview

The Rhea Standard Library (stdlib) should be implemented primarily in Rhea
itself ("self-hosted"). This ensures that the language is capable enough to
build complex data structures and allows for better optimization.

## Goals

1.  **Self-Hosting**: Implement core types (`Map`, `Set`, `List`, etc.) in Rhea.
2.  **Zero-Overhead Inclusion**: The compiler must perform **Dead Code
    Elimination (DCE)** or **Reachability Analysis**. Code from the stdlib (or
    any module) should only be emitted into the final WASM binary if it is
    transitively reachable from the program's entry point (exports or main
    function).
3.  **Implicit Availability**: Core stdlib types (like `Map`) should be
    available in the global scope without explicit `import` statements, similar
    to `Array` or `String` in JavaScript.

## Implementation Strategy

### 1. Module System

- **File-based Modules**: Each file is a module.
- **Imports/Exports**: Support ES-style `import` and `export`.
- **Resolution**: The compiler needs a module resolution phase to locate files.

### 2. The "Prelude"

- The compiler will maintain a list of "Prelude" modules (e.g., `std/core`,
  `std/map`, `std/string`).
- These modules are automatically loaded and their exported symbols are injected
  into the global scope of the user's program during the Type Checking phase.

### 3. Compilation Pipeline Updates

1.  **Parse**: Parse user code AND Prelude modules.
2.  **Type Check**: Check user code against the combined scope (User + Prelude).
3.  **Reachability Analysis (Tree Shaking)**:
    - Start with the user's exported functions and `main`.
    - Traverse the dependency graph (function calls, class instantiations,
      global variable usage).
    - Mark all reachable functions, types, and globals.
4.  **Codegen**:
    - Iterate through the reachable set.
    - Generate WASM code _only_ for reachable items.
    - This ensures that if `Map` is not used, its code (and helper methods) are
      not emitted.

## Challenges

- **Generics**: Implementing a reusable `Map` requires Generics (e.g., `Map<K,
V>`) or a top-type (`any` / `eqref`) with runtime casting.
  - _Recommendation_: Prioritize a basic Generics implementation or Templates to
    allow type-safe, specialized collections without runtime overhead
    (monomorphization).
- **Circular Dependencies**: The stdlib might depend on itself (e.g., `Map` uses
  `Array`). The compiler must handle circular references gracefully.
