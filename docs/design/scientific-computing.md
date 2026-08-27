# Scientific Computing in Zena

This document outlines the design for making Zena a first-class language for scientific and mathematical computing. The goal is to combine the safety and performance of Zena with the expressiveness required for complex mathematical modeling.

## 1. Units of Measure

Numeric types annotated with units — meters, seconds, kilograms — so that the
checker rejects adding a length to a time and derives the unit of a product or
quotient. Erased before code generation.

The design lives in [units-of-measure.md](units-of-measure.md): the split
between dimension and unit, the operator and conversion rules, literal suffix
syntax, unit polymorphism, and an incremental plan. That document supersedes
the sketch that was here.

## 2. Vectors and Matrices

Zena should support linear algebra operations with a clean, concise syntax.

### 2.1 Syntax

We can leverage Zena's tuple syntax `[...]` combined with a postfix modifier to denote vectors or matrices.

```zena
// Vector
let v = [1.0, 2.0, 3.0] v;

// Matrix (Row-major)
let m = [
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0]
] mat;
```

### 2.2 Operator Overloading

Standard operators should work on vectors/matrices element-wise or as linear algebra operations (dot product, matrix multiplication).

```zena
let v1 = [1, 2] v;
let v2 = [3, 4] v;

let sum = v1 + v2; // [4, 6] v
let dot = v1 * v2; // Dot product? Or element-wise?
                   // NumPy uses * for element-wise, @ for matmul.
                   // Zena might define a specific operator for dot product, e.g. `.*` or `dot(a, b)`.
```

### 2.4 Syntax Semantics: Tagged Literals

We can unify the syntax for `mat` with Zena's existing **Tagged Template Literals** and extend it to other literals (Tuples, Records, Arrays).

**Concept**: A "Tagged Literal" is an identifier followed immediately by a literal.

- `tag`template`` (Existing)
- `tag[...]` (Tagged Tuple/Array)
- `tag{...}` (Tagged Record)

**Application to Matrices**:
Instead of postfix `[...] mat`, we can use prefix `mat[...]`.

```zena
let m = mat[
  [1.0, 0.0],
  [0.0, 1.0]
];
```

**Ambiguity & Resolution**:
Syntactically, `mat[...]` is identical to **Array Indexing** (`arr[index]`). To resolve this, and to avoid conflicts with future features like Callable Objects (functors) that might also implement `[]` for indexing, we enforce a strict distinction based on the identifier's category:

1.  **Runtime Variables**: If the identifier resolves to a **Variable** (e.g., `let m = ...`), `m[...]` is always treated as **Indexing**.
    - Even if the object is "callable" (acts like a function), `[...]` remains the index operator.
    - This preserves standard semantics: `myVector[0]`.

2.  **Compile-Time Entities (Types/Macros)**: If the identifier resolves to a **Type** (e.g., `Set`) or **Macro** (e.g., `mat`), `Tag[...]` is treated as a **Tagged Literal**.
    - This allows `Set[1, 2]` or `mat[1, 2]` to act as constructors.
    - Since Types and Macros are not runtime values that can be indexed, there is no overlap.

**Restriction**: You cannot use a runtime variable as a tag.

```zena
let myTag = mat; // Assuming we could alias macros (unlikely) or types
myTag[1, 2];     // Error: 'myTag' is a variable, treated as indexing.
```

**Benefits**:

1.  **Consistency**: Aligns with `wat`...`` (inline WASM) and other DSLs.
2.  **Extensibility**: Users can define their own "Tags" (Classes or Macros).
    - `Set[1, 2, 3]` -> Creates a Set.
    - `Vec[1, 2]` -> Creates a Vector.
    - `Complex{r: 1, i: 2}` -> Creates a Complex number.

**Built-in Tags**:

- `mat[...]`: Matrix construction.
- `wat`...``: Inline WASM (returns `v128` or other types).

### 2.5 Zero-Copy Construction Strategy

Can avoid copying. **Yes, absolutely.** This is the primary motivation for treating `mat` as a macro rather than a function.

**The Naive Approach (Function Call)**:
If `mat` were a function `func mat(data: Array<f64>)`, the compiler would:

1.  Allocate a GC Array.
2.  Fill it with literals.
3.  Pass it to `mat`.
4.  `mat` would copy values to Linear Memory.
5.  GC Array is discarded (garbage).

**The Macro Approach (Zero-Copy)**:
Since `mat` is a compile-time construct, it consumes the _syntax_ of the literal.

1.  **Analysis**: The compiler sees `mat[1.0, 2.0]`.
2.  **Code Gen**: It generates instructions to write `1.0` and `2.0` _directly_ into the final destination (Linear Memory).
    - **No intermediate array is ever allocated.**
    - **No copying occurs.**

**Large Literals**:
For large constant matrices (e.g., embedding weights), the macro can optimize further:

1.  Store the data in a **WASM Data Segment** (static binary data).
2.  Emit a `memory.init` instruction to bulk-copy the data from the binary to the heap at runtime.
    - This is the fastest possible initialization.

**Future User-Defined Macros**:
To allow users to write efficient constructors like `mat`, we could introduce a macro system. This is a complex feature requiring a sandboxed execution environment (likely WASM-in-WASM) to safely run user code during compilation.

See `docs/design/macros.md` for the detailed design of the macro system.

For the near term, `mat` will be implemented as a **Compiler Intrinsic**, meaning the logic is hard-coded into the compiler, bypassing the need for a full macro engine.

### 2.6 Implementation & Storage

For a language targeting scientific computing, memory layout is critical for performance.

#### Flat vs. Nested Layout

While the syntax `[[1, 2], [3, 4]]` suggests an "Array of Arrays" (nested tuples), this is inefficient for numerical computing due to:

1.  **Pointer Chasing**: Accessing `m[i][j]` requires two memory lookups.
2.  **Cache Locality**: Rows might be scattered in memory.
3.  **SIMD/BLAS Incompatibility**: Hardware vector units and standard libraries (BLAS) expect contiguous blocks of memory.

**Design Decision**: The `mat` modifier (or constructor) MUST flatten the data into a **single contiguous array**.

- **Layout**: Row-Major (C-style) is preferred for compatibility with NumPy and C libraries.
- **Representation**: A Matrix is a struct containing:
  - `data`: The backing flat array.
  - `rows`: Number of rows.
  - `cols`: Number of columns.
  - `strides`: (Optional) To support views/slicing without copying.

#### Backing Storage: GC Arrays vs. Linear Memory

There are two options for the backing array in WASM:

1.  **WASM GC Packed Arrays** (`(array f64)`):
    - _Pros_: Managed by the engine's GC. Safe. No manual `free()`.
    - _Cons_: Harder to pass to C/C++ libraries (BLAS) which expect a raw pointer to Linear Memory. SIMD support for GC arrays is evolving but less mature than Linear Memory.

2.  **Linear Memory** (WASM `memory`):
    - _Pros_: Standard for C/C++/Rust interop. Zero-copy passing to BLAS. Native SIMD support (`v128.load`).
    - _Cons_: Requires manual memory management (malloc/free) or a custom allocator within Zena.

**Recommendation**:
For the "Scientific Computing" module, Zena should likely use **Linear Memory** (wrapped in a `Float64Array`-like class) as the backing store. This allows:

- **Zero-Copy Interop**: We can pass the pointer directly to a WASI implementation of BLAS.
- **SIMD**: We can easily load `v128` vectors from the buffer.

The `mat` syntax should compile to code that allocates this buffer and populates it directly.

**Optimization**: The compiler should **avoid** creating an intermediate tuple or array at runtime.

1.  **Allocation**: Allocate the linear memory buffer.
2.  **Initialization**: Emit `f64.store` instructions to write the literal values directly into the buffer.
    - _Constant Data_: If the matrix is fully constant, the compiler can place the data in a WASM Data Segment and use `memory.init` for bulk initialization.

```zena
// Conceptually compiles to (pseudo-code):
let ptr = malloc(6 * 8); // 6 elements * 8 bytes
f64.store(ptr, 1.0);
f64.store(ptr + 8, 0.0);
// ...
let m = new Matrix(2, 3, ptr);
```

#### Memory Management (Linear Memory)

Using Linear Memory introduces a challenge: **Who frees the memory?** The `Matrix` object is a GC struct, but the pointer it holds points to unmanaged linear memory. If the `Matrix` is collected, the linear memory leaks.

**Strategy 1: Explicit Disposal (Deterministic)**
Users must manually free large matrices.

```zena
let m = ...;
// use m
m.dispose(); // Calls free(m.ptr)
```

_Pros_: Deterministic, simple.
_Cons_: Unsafe (use-after-free), ergonomic burden.

**Strategy 2: Host Finalization (Safety Net)**
We can leverage the Host's `FinalizationRegistry` (in JS) to free memory when the Zena object is collected.

1.  **Zena**: Exports a `free(ptr: i32)` function.
2.  **Host**: Imports a `registerFinalizer(obj: anyref, ptr: i32)` function.
3.  **Runtime**: When `Matrix` is allocated, Zena calls `registerFinalizer(this, this.ptr)`.
4.  **Cleanup**: When the JS engine detects the Zena `Matrix` is unreachable, it triggers the registry callback, which calls Zena's `free(ptr)`.

This provides a "best effort" automatic cleanup, similar to how Node.js `Buffer` or WebGL resources work.

**Strategy 3: WASM WeakRefs (Future)**
Native WASM WeakRefs and Finalizers are a [Post-MVP proposal](https://github.com/WebAssembly/gc/blob/main/proposals/gc/Post-MVP.md). Once available, Zena can implement this entirely within WASM without host help.

**Decision**: Implement **Strategy 1 (Dispose)** for immediate control and **Strategy 2 (Host Finalization)** as the automatic safety net for JS environments.

#### Small Vectors

Small fixed-size vectors (Vec2, Vec3, Vec4) should be treated differently. They should be value types (structs) or mapped directly to `v128` where possible, living on the stack or in registers, not the heap.

## 3. WASM SIMD Support

**Status: implemented.** See [simd.md](simd.md) for the design as built; this
section records what that means for scientific computing.

### 3.1 The `v128` Type

`v128` is a primitive type. It has no literals, operators or casts: the bits
carry no interpretation of their own, so an instruction decides whether they
are four floats or sixteen bytes.

### 3.2 Intrinsics

`zena:simd` exposes all 236 fixed-width instructions as `@intrinsic`
functions, named after the wasm instructions.

```zena
import { f32x4Splat, f32x4Add } from 'zena:simd';

let a = f32x4Splat(10.0 as f32);
let b = f32x4Splat(20.0 as f32);
let c = f32x4Add(a, b);
```

### 3.3 High-Level Abstractions

The Vector/Matrix syntax described in Section 2 should compile down to these SIMD instructions whenever the dimensions allow (e.g., a `Vector4` should fit in a single `v128`).

## 4. Host Interop & Libraries (BLAS/LAPACK)

For heavy-duty scientific computing, Zena should not reinvent the wheel. It should be able to bind to highly optimized native libraries (like BLAS, LAPACK, TensorFlow, Torch) provided by the host environment.

### 4.1 The "Scientific Interface"

We can define a standard Zena interface for matrix operations that can be swapped out.

```zena
interface LinearAlgebraBackend {
  matmul(a: Matrix, b: Matrix): Matrix;
  svd(m: Matrix): SVDResult;
}
```

### 4.2 WASI-NN and Host Bindings

- **WASI-NN**: Zena should support the WASI-NN standard for machine learning inference.
- **Custom Host Imports**: Zena's `declare` syntax can import optimized math functions from JavaScript (which might call into WebGPU or WebGL) or a native host.

```zena
@external("env", "cblas_dgemm")
declare func dgemm(...): void;
```

### 4.3 Integration with NumPy (via Python Host)

If Zena is running in a Python environment (e.g., via a WASM runtime in Python), we can design a bridge where Zena `Matrix` objects are actually handles to NumPy arrays, and operations are delegated to NumPy.

## 5. Roadmap

1.  **Phase 1**: Design and implement the **Units of Measure** system in the type checker. This is a pure compile-time feature.
2.  **Phase 2**: Add `v128` support and SIMD intrinsics to the code generator.
3.  **Phase 3**: Implement Vector/Matrix syntax and basic pure-Zena implementation.
4.  **Phase 4**: Build the Host Interop layer for hardware-accelerated linear algebra.
