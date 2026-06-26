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

### Closure Context Optimization

- **Problem**: Separately boxing every mutated captured variable (via individual cell structs) leads to multiple heap allocations and multiple levels of indirection (`struct.get` operations) inside the closure to dereference them.
- **Solution**: Group captured variables that share the same exact set of closures into a single shared environment structure (or context struct).
  - Closures sharing the same variables will reference the same environment struct.
  - This reduces the number of heap allocations and simplifies retrieval (a single `struct.get` offset access on the shared environment, instead of fetching a cell pointer and then dereferencing it).
- **Complexity**: Moderate. Requires identifying variable sharing sets during capture analysis.
- **Priority**: Low for Phase 1. Box-per-variable keeps the initial implementation simple, correct, and matching the bootstrap compiler.

### String Operations & Identity Caching

- **Problem**: In Zena, strings are objects on the heap. Evaluating a string literal dynamically allocates a new heap object. In hot loops or recursive lookups, this causes high GC allocation pressure and frequent object header creation. Furthermore, operations like `operator ==` and `hashCode` re-evaluate string bytes repeatedly, even for identical string references or duplicate literals.
- **Solution**:
  1.  **String Literal Interning**: During compilation, the compiler tracks all unique string literals. They are defined as WASM global variables initialized exactly once in the start function. In code generation, string literals compile to `global.get $globalIndex`, avoiding heap allocation at runtime. This guarantees duplicate literals point to the same memory reference.
  2.  **Identity Short-Circuiting**: Update `String.operator ==` in the standard library to check reference equality (`this === other`) first. If they are the same pointer, return `true` immediately.
  3.  **Hash Code Caching**: Add a `#hashCode` cache field to the `String` class (field index 6). The first time `hashCode()` is evaluated, the compiler computes the FNV-1a hash, clamps any 0 result to 1, and saves it in the cache field. Subsequent calls return the cached value.
  4.  **Hash Mismatch Short-Circuiting**: In `String.operator ==`, if both strings have a non-zero cached hash code and the hash codes differ, return `false` immediately without comparing bytes.
  5.  **Zero-Copy StringBuilder**:
      - To optimize string construction, `StringBuilder` collects segments in chunked `ByteArray` buffers.
      - `toString()` returns a `String` view directly referencing the builder's active chunk (`#currentChunk`) with no copying or allocation if the builder has not grown beyond its first chunk.
      - Because a `String` is a sliced view (`start` to `end`) and the builder only ever appends data at `#currentPos` (never overwriting indices prior to `#currentPos`), previously returned `String` views remain completely immutable even when the builder is subsequently appended to.
      - `clear()` is defined to allocate a new buffer instead of reusing the old one, preventing future writes from overwriting the characters of handed-out strings.
      - `StringBuilder.fromString(s)` adopts a string's backing `ByteArray` directly (zero-copy) if the string spans the entire array (making it full by definition, ensuring any subsequent writes trigger new chunk allocations).
- **Results**: String search benchmarks (`StringSearch`) under Wasmtime dropped from **2037.16 ms** to **0.77 ms** (nearly a **2600x** speedup), and map indexing (`StringMapIndexing`) dropped from **19.34 ms** to **3.05 ms** (a **6.3x** speedup). `StringBuilder` string construction benchmarks (`StringConcatBuilder`) dropped from **12.08 ms** to **0.66 ms** (an **18.3x** speedup).

---

## Benchmarking Suite

A micro-benchmark suite has been added under `packages/zena-compiler/test-files/benchmarks/` and `packages/zena-compiler/src/scripts/` to measure compiler code output and runtime execution overhead against native JS:

- **`string_bench.zena` / `string-bench-node.js`**: Measures string concatenation (`+` vs `StringBuilder`), slicing, searching, and HashMap lookup with string keys.
- **`basic_bench.zena` / `basic-bench-node.js`**: Measures recursive function calls (Fibonacci), iterative loops, and basic function call overhead.

### Key Architectural Findings:

1. **The Inlining Gap & Call Overhead**:
   - In recursive calls (like recursive Fibonacci), Zena running on Wasmtime is **2x-3x faster** than Node.js (V8 JS). Wasm GC's raw function call and recursion handling has significantly less stack frame setup overhead.
   - However, in tight loops with simple method calls (like `FunctionCallSimple`), Node.js (V8 JS) performs inlining. V8 JS runs the loop in **5.27 ms**, and Zena on Node.js (with V8 JIT warmup) runs in **3.24 ms** (8x faster than its cold Liftoff execution of **25.29 ms**).
   - Wasmtime executes the same simple call loop at **12.41 ms** with no inlining, highlighting the cost of raw `call` branch instruction sequences. This makes compile-time **devirtualization** and **inlining** (Tier 1 & Tier 2 optimizations) critical for AOT runtimes.

2. **Standard Library Allocation / Copy Overhead**:
   - Profiling of `StringBuilder` showed that frequent appends incurred significant overhead from repeated calls to the `__byte_array_length()` compiler intrinsic and standard array copy helpers.
   - Caching the current chunk length in a private field and adding a single-character fast-path using `__byte_array_set` directly yielded a **33% runtime performance improvement** for string building.
