# Zena Development Plan

This document tracks completed work and planned features. For project instructions and coding standards, see [AGENTS.md](./AGENTS.md).

## Completed

- **Core Infrastructure**: Project setup with TypeScript compiler, CLI, and portable test suites.
- **Language Syntax & Semantics**: Arrow functions, lexical blocks, and control flow.
- **WASM-GC Native Code Generation**: Implemented natively targeting WebAssembly GC.
- **Data Structures & Types**:
  - Primitives (`i32`, `i64`, `u32`, `f32`, `f64`, `boolean`, `String`).
  - Records & Tuples (boxed canonical WASM structs, destructured bindings, and unboxed multi-value returns).
  - Arrays (Fixed-size WASM arrays and growable array implementations).
- **Generics & Polymorphism**:
  - Reified generics with complete monomorphization (no auto-boxing overhead for primitives).
  - Single inheritance, abstract classes, mixins, and interfaces (fat pointer representation with vtables).
- **Functional Programming**: Closures and captures, inline tuples, and the pipeline operator (`|>`).
- **Control Flow & Pattern Matching**:
  - Exhaustive pattern matching (`match` expression) supporting literals, variables, records, classes, logical combinators, and guards.
  - Pattern conditions (`if let`, `while let`) and `for-in` loops over `Iterator`/`Sequence`.
- **Error Handling**: WASM-GC exception handling (`throw` and `try`/`catch`).
- **Standard Library**: Core library modules (`String`, `StringBuilder`, `Array`, `Map`, `HashSet`, `Option`, `JSON`, `Regex`, file I/O).
- **Optimization**: Compiler-driven dead code elimination (DCE) for functions, classes, methods, and WASM types.
- **Tooling & IDE**: Incremental type-checking (ScopeResult caching, export signature comparison) and language service support.

## Planned / Next Milestones

### Phase 1: Self-Hosted Compiler (Current Focus)

- **Goal**: Retire the TypeScript bootstrap compiler and move entirely to the self-hosted compiler (`packages/zena-compiler`).
- **Current Status**: The self-hosted compiler already passes all syntax, language, and execution tests.
- **New IR Backend**: Building a new IR-based backend to unlock advanced optimizations (devirtualization, specialization, and size reductions).
- **Performance Optimizations**:
  - Solve quadratic JIT compilation/lookups. Introduce hashed lookup indices for WASM functions in the code generator to eliminate $O(N)$ linear scans.
  - Implement hybrid monomorphization: share specialized reference type methods (e.g. `Box<anyref>`) to reduce compiled WASM code size.

### Phase 2: Platform Features (Post-Retirement)

- **Async Functions & Cooperative Multithreading**: Native support for asynchronous execution, targeting upcoming WASM P3 features with cooperative multithreading.
- **WASI Component Model & WIT Support**: Direct parser and bindings generator for WebAssembly Interface Type (`.wit`) files, enabling Zena programs to natively import/export WIT interfaces and compile into compliant WASI Component Model binaries.
- **Tooling & DX**: A package manager, online playground, and enhanced VS Code integration.

### Phase 3: Post-Bootstrap Headline Features

Features that distinguish Zena from TypeScript:

- **Numeric Unit Types & Units of Measure**: Statically verified physical units and units of measure (e.g. preventing adding meters to feet at compile time).
- **SIMD**: Native WebAssembly vector instruction support for high-performance computing.
- **Decorators and Macros**: Metaprogramming capabilities for compile-time code generation and extension.
- **Contracts**: `requires` and `ensures` pre/post-conditions, enabling runtime assertion checks and future static verification using SMT solvers.
