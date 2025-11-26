# Standard Library & Module System Design

## Overview

The Zena Standard Library (stdlib) should be implemented primarily in Zena
itself ("self-hosted"). This ensures that the language is capable enough to
build complex data structures and allows for better optimization.

## Goals

1.  **Self-Hosting**: Implement core types (`Map`, `Array`, `String`, etc.) in Zena.
2.  **Zero-Overhead Inclusion**: The compiler must perform **Dead Code Elimination (DCE)**. Code from the stdlib (especially the implicitly imported classes) should only be emitted into the final WASM binary if it is actually used. This allows us to hang many utility methods on `String` or `Array` without bloating the binary size of simple programs.
3.  **Implicit Availability**: Core stdlib types (`String`, `Array`, `Map`) must be available in the global scope without explicit `import` statements, as they back language literals.
4.  **Compiler Intrinsics**: Some methods on core classes (e.g., `Array.length`, `String.concat`) cannot be implemented purely in Zena or require direct mapping to WASM instructions. We need a mechanism to mark these methods as intrinsics.

## Core Classes

The following classes are the foundation of the standard library and have special compiler support:

### 1. String

- **Backing**: UTF-8 bytes (WASM array or struct).
- **Literal**: `"hello world"`
- **Intrinsics**: Length, concatenation, equality.

### 2. Array<T>

- **Backing**: WASM GC Array.
- **Literal**: `#[1, 2, 3]`
- **Intrinsics**: `get`, `set`, `length`, `push` (if dynamic).

### 3. Map<K, V>

- **Backing**: Hash Map implementation (likely open addressing or chaining).
- **Literal**: `#{ "key": "value" }`
- **Intrinsics**: Hashing helpers (if not pure Zena).

## Compiler Intrinsics

To implement low-level operations or map directly to WASM instructions, we need a way to declare "native" or "intrinsic" methods in Zena source files.

**Proposal: Decorator or Keyword**

```typescript
class Array<T> {
  // Maps to array.len instruction
  @intrinsic('array.len')
  length(): i32 {
    return 0;
  } // Body is ignored or used as fallback/stub

  // Implemented in Zena
  isEmpty(): boolean {
    return this.length() == 0;
  }
}
```

The compiler's code generator will detect the `@intrinsic` marker (or similar mechanism) and emit the corresponding WASM instruction instead of compiling the function body.

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

- **Circular Dependencies**: The stdlib might depend on itself (e.g., `Map` uses
  `Array`). The compiler must handle circular references gracefully.
