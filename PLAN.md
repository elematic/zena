# Zena Development Plan

This document tracks completed work and planned features. For project instructions and coding standards, see [AGENTS.md](./AGENTS.md).

## Completed

- **Core Infrastructure**: Project setup with TypeScript compiler, CLI, and portable test suites.
- **Language Syntax & Semantics**: Arrow functions, top-level `function` declarations (hoisted, never closures), lexical blocks, and control flow.
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

> Detailed cross-track sequencing for the 2026-08 language arc —
> generators → async, value-semantics/equality contractions, row types,
> and the record-semantics flip at bootstrap retirement — is in
> [docs/design/implementation-plan.md](docs/design/implementation-plan.md).

### Phase 1: Self-Hosted Compiler (COMPLETE 2026-08-06)

- **Goal**: Retire the TypeScript bootstrap compiler and move entirely to the self-hosted compiler (`packages/zena-compiler`).
- **Status**: **Done.** The TypeScript compiler is deleted; a fresh checkout bootstraps from the checked-in `packages/zena-compiler/bootstrap/cli.wasm` (see `docs/design/bootstrapping.md`), gated by the `test:fixpoint` self-compilation byte-parity check.
- **New IR Backend**: Building a new IR-based backend to unlock advanced optimizations (devirtualization, specialization, and size reductions).
- **Performance Optimizations**:
  - Solve quadratic JIT compilation/lookups. Introduce hashed lookup indices for WASM functions in the code generator to eliminate $O(N)$ linear scans.
  - Implement hybrid monomorphization: share specialized reference type methods (e.g. `Box<anyref>`) to reduce compiled WASM code size.

### Phase 2: Platform Features (Post-Retirement)

- **Async Functions & Cooperative Multithreading**: Native support for asynchronous execution, targeting upcoming WASM P3 features with cooperative multithreading.
  - **A0 (front end) and A1 (transform) are done.** `async`/`await` parse,
    check, and _run_: the split pass compiles async bodies into frame-based
    state machines that park on futures and resume off a microtask queue, and
    an async `main` is driven to completion by a synthesized export wrapper —
    so async programs run under plain `wasmtime --invoke main` today, with no
    host event loop and no changes to `zena-cli`. See
    [async.md](docs/design/async.md) §5 for what A1 deliberately left out
    (union `await`).
  - **await-in-try is done too** (§6), the fast-follow to A1: resuming
    re-enters each enclosing `try` region, so a failed await is caught by
    the handler the user wrote rather than silently rejecting the
    function's own future.
  - **`Future<void>` works** — the fire-and-forget shape. It needed no
    async machinery: the blocker was that `void` could not be a type
    argument at all. `void` is now a zero-width type argument (it takes
    no wasm slot, so callers omit its arguments); see the language
    reference under "Generic Classes".
  - Next: A2 (timers over WASI p1 `poll_oneoff`), then A3 (external
    completions on a JS host).
- **WASI Component Model & WIT Support**: Direct parser and bindings generator for WebAssembly Interface Type (`.wit`) files, enabling Zena programs to natively import/export WIT interfaces and compile into compliant WASI Component Model binaries.
  - The WIT parser and resolver are **done** (real WASI p2 and p3 both parse and
    resolve); what remains is everything that turns a parsed WIT into a running
    component. The near-term work is _language_ work, because a WIT import needs
    a Zena type for every construct it mentions — see
    [component-model.md](docs/design/component-model.md) Part 8:
    1. ~~`Result<T, E>` in the stdlib, plus `inline` tuples permitted in type
       aliases~~ **done** (45% of WASI p2 functions return a `result`)
    2. ~~Narrow integers `u8`/`u16`/`i8`/`i16`~~ **done** — types, promotion,
       casts and literal range checking
       ([arithmetic-conversions.md](docs/design/arithmetic-conversions.md)).
       Their packed `i8`/`i16` storage is deliberately left to step 3, which
       is the step that needs it.
    3. ~~`FixedArray<u8>` / `Array<u8>`, retiring the bespoke `ByteArray`
       primitive~~ **done** (`list<u8>` is half of all lists in p2): narrow
       array elements are stored packed, and `ByteArray` is now simply
       `array<u8>` rather than a type of its own. Packed _struct fields_
       are still outstanding.
    4. `Disposable`, giving WIT `resource` a shape (79% of p2 functions are
       resource methods). This is the first step of **Track O**, adopted
       2026-08-06 — see [ownership.md](docs/design/ownership.md). The layer 0
       protocol lives in `zena:ownership`; the rest of O0 (`resource class`,
       `Own<T>`/`Borrow<T>`/`Unmanaged<T>`, `disown`/`adopt`) follows there and
       is what freezes the generated-wrapper signatures.
    5. Only then: first-class WIT imports.
- **Tooling & DX**: A package manager, online playground, and enhanced VS Code integration.

### Phase 3: Post-Bootstrap Headline Features

Features that distinguish Zena from TypeScript:

- **Ownership & Affine Resources** (Track O): `Own<T>`/`Borrow<T>`/`Unmanaged<T>`, second-class borrows, a checker flow graph, and implicit drop — one release mechanism shared by WIT handles, WASI descriptors, linear-memory allocations and FFI pointers. Plan of record in [ownership.md](docs/design/ownership.md); phase 2 step 4 above is its first milestone.
- **Numeric Unit Types & Units of Measure**: Statically verified physical units and units of measure (e.g. preventing adding meters to feet at compile time).
- **SIMD**: Native WebAssembly vector instruction support for high-performance computing.
- **Decorators and Macros**: Metaprogramming capabilities for compile-time code generation and extension.
- **Contracts**: `requires` and `ensures` pre/post-conditions, enabling runtime assertion checks and future static verification using SMT solvers.
