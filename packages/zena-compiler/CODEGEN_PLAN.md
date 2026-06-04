# Self-Hosted Zena Compiler: Codegen Roadmap

This document outlines the detailed roadmap and progress of the code generation (WASM-GC) phase for the self-hosted Zena compiler (`packages/zena-compiler`). For architecture and design overview, see [self-hosted-compiler.md](../../docs/design/self-hosted-compiler.md).

---

## Detailed Codegen Plan

This plan tracks all features required for the code generation phase to achieve feature parity with the bootstrap compiler, organized by category.

### 1. Variables, Scope, & Expressions

- [x] **Local & Global Variables:**
  - [x] Local and global variable declarations (`let` and `var`).
  - [x] Assignment expressions and chained assignments (`a = b = c`).
  - [x] Optimizing assignment statements to only leave values on the stack when needed.
- [x] **Operators:**
  - [x] Binary arithmetic and comparison operators.
  - [x] Compound assignments (`+=`, `-=`, `*=`, `/=`, `%=`, `??=`).
  - [x] Unary operators (`!`, `-`, `~`).
  - [ ] Intercepting overloaded operators to compile as method dispatch instead of primitive instructions.
- [x] **Literals:**
  - [x] Number literals (`i32`, `f32`, `f64`, etc.).
  - [x] Boolean literals (`true` and `false`).
  - [x] String literals.

### 2. Types, Casts, & Values

- [ ] **Type Casting & Type Tests:**
  - [ ] Checked downcasting for reference types (`as` operator) emitting WASM runtime type assertions.
  - [ ] Numeric conversions (`i32` to `i64`, `f32` to `i32`, etc.) using WASM conversion/truncation instructions.
  - [ ] Elision of zero-cost casts (e.g. casting distinct types or matching types).
  - [ ] Runtime type tests (`is` operator) returning a boolean.
- [ ] **Unions & Primitives Boxing:**
  - [ ] Boxing primitives (`i32`, `f32`, `boolean`) into `Box<T>` when assigned to reference types or the top type `any`.
  - [ ] Auto-unboxing primitives when casting from `any` back to value types.
- [ ] **Distinct Types:**
  - [ ] Compile-time nominal distinction with zero runtime overhead (complete erasure to backing type).
- [ ] **Strings & Templates:**
  - [x] Basic string literals.
  - [ ] String concatenation (`+` operator) using runtime helper functions.
  - [ ] Template literals with `${expression}` interpolation.
  - [ ] Tagged template literals with referentially stable `TemplateStringsArray` allocated globally.

### 3. Records, Tuples, & Destructuring

- [ ] **Records:**
  - [x] Canonical WASM GC struct representations with lexicographically sorted keys.
  - [x] Record literals and member access (`.` operator) via fat-pointers for width subtyping (adaptation).
  - [ ] Record spread expressions (`{...p, z: 3}`) with field copying into a new structural struct.
  - [ ] **Record Devirtualization Optimizations:**
    - [ ] Devirtualize member access for exact type matches (skipping fat-pointer and vtable).
    - [ ] Devirtualize member access for prefix matches.
- [x] **Tuples:**
  - [x] Fixed-length WASM GC struct/array layout representing the tuple.
  - [x] Compile-time known index access (`t[idx]`) mapping to structural field access.
- [ ] **Destructuring:**
  - [ ] Destructuring patterns for records (`let {x, y} = p`) and tuples (`let (a, b) = t`) in variable declarations.
- [ ] **Multi-Value Returns:**
  - [ ] Unboxed multi-value returns mapping directly to WASM's multi-value stack representation (zero-heap allocation).
  - [ ] Immediate call-site destructuring for multi-value return bindings.

### 4. Functions, Closures, & Intrinsics

- [x] **Functions:**
  - [x] Simple functions with block and expression bodies.
  - [x] Function calls.
  - [x] Default parameters (including referencing earlier params).
  - [x] Dead Code Elimination (DCE) to elide unused functions/methods.
  - [x] External functions (`declare` with `@external` decorators).
- [ ] **Compiler Intrinsics:**
  - [x] `@intrinsic` decorator discovery.
  - [x] Low-level WASM instructions (e.g. `memory.size`, `memory.grow`, `i32.load`, etc.).
  - [ ] Standard library array/byte array intrinsics (`__array_*`, `__byte_array_*`) mapping to WASM GC array operations.
- [ ] **Closure Environments:**
  - [ ] Capture analysis to identify non-local variables.
  - [ ] Heap-allocated context struct creation to store captured lexical state.
  - [ ] Rewriting variable references inside inner functions to access the context struct.
- [ ] **Argument Adaptation:**
  - [ ] Automatic generation of adapter wrappers when passing functions with fewer arguments than expected by the call site.
- [ ] **Overloaded Functions:**
  - [ ] Overload name mangling based on parameter counts and types to resolve unique WASM export names.
- [ ] **Custom Operator Protocols:**
  - [ ] Custom `operator ==` overloading resolution and method/vtable compilation.
  - [ ] Custom index accessors (`operator []`) resolving to indexed `get`/`set` function calls.

### 5. Classes & Objects

- [ ] **Fields & Getters/Setters:**
  - [x] Object field storage layouts for public, final, and private (`#`) fields
        in WASM structs.
  - [x] Constructor initialization lists (`: field = expr, super(...)`).
  - [x] Parameter properties (`this.field` constructor parameters).
  - [ ] Private fields
  - [ ] Mutable fields with private setters (`var(#foo) foo: i32;`)
  - [x] Accessors (`get` / `set` computed properties) wrapping property accesses.
- [ ] **Inheritance & Polymorphism:**
  - [x] Single inheritance structural extension layouts in WASM GC.
  - [x] Virtual method dispatch tables (vtables) matching subclass overrides.
  - [x] Cross-module class name collision and registry deduplication.
  - [ ] Static fields and class-level helper method execution.
  - [ ] Extension classes (`extension class A on B`) adding static/instance dispatch wrappers.
  - [ ] Super calls in methods


### 6. Interfaces, Mixins, & Case/Sealed Classes

- [ ] **Interfaces:**
  - [ ] Dynamic fat-pointer representation containing the object reference and a pointer to the specific interface's vtable.
  - [ ] Multi-interface implementation handling and vtable pointer selection.
- [ ] **Mixins:**
  - [ ] Field and method composition from `mixin` definitions into target class structures.
- [ ] **Case & Sealed Classes:**
  - [ ] Auto-generation of constructor, structural `==`, `hashCode`, and field properties for case classes.
  - [ ] Sealed class variant type discriminators (tagging variant classes).
  - [x] Enums (constant-folded during member access to bypass runtime struct allocation).

### 7. Control Flow, Pattern Matching, & Iteration

- [x] **Basic Control Flow:**
  - [x] `if` statements and expressions.
  - [x] Basic `while` and C-style `for` loops (without custom iteration/pattern matching).
  - [x] `break` and `continue` statement redirection.
  - [x] Strict reachability analysis and control flow codegen.
- [ ] **Match Expressions:**
  - [ ] Code generation for exhaustive `match` expressions.
  - [ ] Pattern compilation tree (nested tests/casts) for literal, wildcard, variable, tuple, and record/class patterns.
  - [ ] Conditional guard execution (`case ... if ...`).
  - [ ] Exhaustiveness checks producing compile-time traps or errors.
- [ ] **Conditional Patterns:**
  - [ ] `if let` statement pattern checking and local scope binding.
  - [ ] `while let` loop condition checking and iteration control.
- [ ] **Loop Iterations:**
  - [ ] `for-in` loop compilation over collections implementing `Iterator`/`Sequence` protocol (unrolling iteration steps).
- [ ] **Ranges & Pipelines:**
  - [ ] Range object instantiation (`..` operator variants: `BoundedRange`, `FromRange`, etc.).
  - [ ] Pipeline expressions (`|>`) replacing temporary variables via stack manipulation/placeholder `$` replacement.

### 8. Exception Handling

- [ ] **Throw Expressions:**
  - [ ] `throw` expression of type `never` creating a WASM exception payload.
- [ ] **Try-Catch Blocks:**
  - [ ] Code generation mapping `try-catch-finally` to WASM standard exception handlers.
  - [ ] Runtime type-matching of caught exception payloads to Zena `Error` subclasses.

### 9. Module Execution & Infrastructure

- [ ] **Startup & Top-Level Statements:**
  - [ ] Dependency-ordered module initialization sequences.
  - [ ] WASM start function executing top-level statement blocks (essential for test registrations).
- [ ] **Modular Exports:**
  - [ ] Namespace object structures (`import * as alias`).
  - [ ] Re-exporting wrappers (`export { X } from 'mod'`).

### 10. Testing Infrastructure

- [x] **Execution Tests:**
  - [x] Initial setup of portable execution tests in `tests/language/execution/`.
  - [x] Execution in CI using `runList` in `run-execution-tests.ts`.

---

## Ongoing Maintenance

- [ ] Continually port bootstrap compiler unit tests to portable execution tests.
- [ ] Keep `runList` in `packages/zena-compiler/test-files/run-execution-tests.ts` updated with newly passing tests.
- [ ] Expand reachability and data flow analyses as more control flow constructs are added.
