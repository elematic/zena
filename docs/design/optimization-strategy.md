# Optimization Strategy

This document outlines the strategy for ensuring Zena achieves its performance goals (Performance & Binary Size) without hindering the rapid evolution of language features during the bootstrapping phase.

## Philosophy

1.  **Correctness First**: Semantics must be stable before they are optimized.
2.  **Explicit over Implicit**: In the early phases, prefer language features that allow users to opt-in to performance (e.g., `final`, `private`) over complex compiler inference.
3.  **Measure Everything**: Optimizations must be verified by inspecting generated code (WAT) and measuring runtime execution.

## Phasing

### Phase 1: Semantics & Baseline (Current)

- **Goal**: Implement features correctly with the simplest possible WASM mapping.
- **Strategy**: "Everything is Virtual" (for public members).
- **Focus**:
  - Clean AST and IR.
  - Robust correctness tests.
  - **Snapshot Testing**: Ensure we can easily see the generated WAT to manually verify overhead.

### Phase 2: Explicit Optimization (Near Term)

- **Goal**: Allow users to manually optimize critical paths.
- **Features**:
  - `final` keyword: Classes or methods marked `final` cannot be overridden. The compiler can trivially devirtualize calls to these.
  - `private` fields: Already non-virtual.
  - `const` / Immutable types: Enable value-type optimizations.
- **Implementation**: Local analysis only. No global flow analysis required.

### Phase 3: Implicit Optimization (Long Term)

- **Goal**: Compiler automatically optimizes idiomatic code.
- **Features**:
  - **Class Hierarchy Analysis (CHA)**: Automatically detect if a method is never overridden in the entire program to devirtualize it.
  - **Inlining**: Inline small accessors and methods.
  - **Escape Analysis**: Stack-allocate objects that don't escape.
  - **Dead Code Elimination (DCE)**: Remove unused methods from VTables.

## Verification & Benchmarking

### Verification (Golden Testing)

We must verify that optimizations actually trigger.

- **Mechanism**: Snapshot tests that match specific WASM instructions.
- **Example**: A test for `final` should assert that the output contains `call $Method` and NOT `call_ref`.

### Benchmarking

We need a suite of micro-benchmarks to track performance regressions.

- **Metrics**:
  1.  **Runtime**: Execution time of tight loops.
  2.  **Binary Size**: Size of the `.wasm` output.
  3.  **Compilation Time**: Time to compile Zena source.

## Specific Optimization Plans

### Devirtualization

- **Problem**: `call_ref` (dynamic dispatch) is slower than `call` (static dispatch) and inhibits inlining.
- **Solution**:
  1.  **Private Members**: Always static.
  2.  **Final Members**: Always static.
  3.  **Constructors**: Always static (allocates struct, then calls init).

### Field Access

- **Problem**: Accessing a public field is a virtual method call in the "Everything is Virtual" model.
- **Solution**:
  - If the class is `final`, the compiler knows the exact struct layout and can emit `struct.get` directly.

### Boxing/Unboxing

- **Problem**: Generics currently box primitives (e.g., `Box<i32>` stores `i32` as `(ref any)` or similar).
- **Solution**: Monomorphization (generating specialized copies of classes for each type argument) is planned to eliminate boxing overhead.

### Local Slot Reuse

- **Problem**: Currently, WASM locals accumulate monotonically within a function. Each variable declaration gets a unique local index, even when variables in separate scopes could share slots.
- **Example**:
  ```zena
  const foo = () => {
    { let a = 1; }  // local 0
    { let b = 2; }  // local 1 (could reuse local 0)
  };
  ```
- **Solution**: Track "live ranges" for locals. When exiting a scope, mark its locals as available for reuse. The next declaration in a disjoint scope can reuse those slots.
- **Benefits**:
  - Reduces function local count (smaller WASM binary)
  - Better register allocation opportunities for WASM engines
- **Complexity**: Moderate. Requires tracking live ranges and ensuring correctness when variables are captured by closures (captured variables can't be reused).
- **Priority**: Low. Modern WASM engines handle many locals efficiently. Implement only if profiling shows local count is a bottleneck.
