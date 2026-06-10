# Polymorphic References in Wasm GC

This document outlines Zena's final architectural design for compiling classes, records, and interfaces to WebAssembly GC.

Our dual goals are **binary size** and **execution performance**, with an emphasis on **strict Wasm-side typing and eliminating dynamic downcasts (`ref.cast`)**.

---

## 1. Dual-Path Polymorphism

Zena's type system features nominal classes (`class`), nominal interfaces (`interface`), and structural records (`{...}`). WebAssembly GC only supports single-inheritance nominal subtyping, meaning we must carefully map our type relationships based on whether they form a linear chain.

### Path A: Nominal Classes (Direct References)

Classes are compiled as **raw Wasm GC Structs**.

- **Subtyping**: Inheritance uses Wasm's native `(sub)` typing. `class Dog extends Animal` compiles to `(type $Dog (sub $Animal (struct ...)))`.
- **VTable Placement**: By default, classes have **no vtable field** embedded in their Wasm structs.
- **Virtual Calls**: If a method is truly virtual and cannot be devirtualized, the compiler will either:
  1. Embed a classic vtable pointer at field 0 (only if virtual methods exist).
  2. Emit a `br_on_cast` jump table (for closed, small class hierarchies) to keep the struct 100% data.
- **Overhead**: 0 bytes per object in the optimal/devirtualized case. Accessing an object via its class type is a direct `struct.get` and static `call`.

### Path B: Interfaces & Records (Fat Pointers)

When subtyping requires multiple inheritance or complex structural shapes, the compiler uses **Fat Pointers**.

- **Why they are needed**: Wasm GC only supports single linear inheritance.
  - **Interfaces** (Nominal): A class can implement multiple interfaces (e.g., `Dog` implements `Animal` and `Pet`), which Wasm cannot natively express in a single `(sub)` chain.
  - **Records** (Structural): While simple prefix extensions (e.g., passing `{a: i32, b: i32}` to a variable expecting `{a: i32}`) _can_ map to Wasm's width subtyping without fat pointers, arbitrary intersections (e.g., casting `{a: i32, b: i32, c: i32}` to `{b: i32}`) break the linear inheritance constraint and require an adapter.
    - **Note on Whole-Program Analysis**: Because Zena compiles with closed-world whole-program analysis, the compiler can prove when a structural type like `{a: i32}` is only ever populated by exact matches or linear prefix-extensions. When this is proven, the compiler statically promotes the record to **Path A (Direct References)** and eliminates the Fat Pointer entirely.
- **Structure**: A Fat Pointer adapts an arbitrary payload to a specific expectation by pairing the payload (`anyref`) with a specific Virtual Method Table (`ref $VTable_Target`).
- **Generation**: Fat pointers are manufactured _on demand_ at the moment of upcasting (e.g., assigning a class to an interface variable, or adapting a record to a non-prefix target).

---

## 2. Optimizing Fat Pointers

While Fat Pointers provide excellent structural flexibility, churning heap allocations for them strains the Garbage Collector, and passing them opaquely requires excessive `ref.cast` operations.

We solve this using two advanced techniques:

### Optimization 1: Typed Scratch Locals (Local-Only SROA)

While full Scalar Replacement of Aggregates (SROA) across function boundaries (parameters and returns) seems compelling, it **breaks function subtyping**. If `(param $fat_ptr)` is flattened to `(param $inst) (param $vtable)`, the Wasm function signature changes from 1 parameter to 2. This breaks Wasm `call_ref` compatibility when functions are passed as generic closures or upcast to interfaces.

Therefore, we strictly preserve Fat Pointers as single `structref` values across ABI boundaries.

Instead of flattening across boundaries, we use **Typed Scratch Locals**—effectively a form of local-only SROA. When a Fat Pointer's fields are accessed, the compiler dynamically allocates a strongly typed Wasm local (e.g., `ValTypeRefNull(FatPtrType)`). We place the incoming fat pointer value into this local, allowing us to seamlessly emit `local.get $scratch; struct.get $inst; local.get $scratch; struct.get $method; call_ref` without repeated memory/validation tricks.

- **The Result**: Zero `ref.cast` overhead when dispatching virtual methods from a local, while preserving the 1-parameter signature for strict WebAssembly GC structural subtyping.
- **Future SROA Heuristics**: If we ever implement formal SROA to eliminate the initial `struct.new` heap allocations, it _must_ be limited to local variables only. We could introduce heuristics (e.g., if a fat pointer local is accessed more than $N$ times, or never escapes to the heap) to fully unpack it into two separate unboxed locals `$inst` and `$vtable`, skipping the struct allocation entirely. But currently, typed scratch locals provide the performance baseline we need.

### Optimization 2: Strict VTable Typing (Zero Call-Site Casts)

To eliminate `ref.cast` overhead, VTables are tightly typed to the specific interface/record field signatures.

```wasm
;; 1. The precise signature
(type $sig_get_x (func (param anyref) (result i32)))

;; 2. The strictly typed VTable
(type $VTable_Point (struct
  (field $get_x (ref $sig_get_x))
))
```

At the call site, we read the typed function reference and invoke it directly. The only `ref.cast` in the entire lifecycle occurs _inside_ the generated getter function, which downcasts the `anyref` back to the concrete backing struct before reading memory.

---

## 3. Compiler Implementation

Both the bootstrap and self-hosted compilers now fully implement this strict typing architecture:

1. **Strictly Typed VTables**: VTable structs declare their method fields using exact `(ref $method_sig)` types instead of anonymous `funcref`s.
2. **Strictly Typed Fat Pointers**: Fat pointers declare their VTable field using `(ref $VTable)` instead of `anyref`.
3. **Typed Scratch Locals**: The codegen leverages `getStructScratchLocal()` to dynamically allocate strongly-typed locals (e.g., `(ref null $FatPtr)`) for evaluating paths. This ensures the single `struct.get` and `call_ref` sequence requires zero dynamic `ref.cast`ing overhead.
4. **Class Nominal Types**: `ClassType` maps directly to its corresponding target `WasmStruct` via `ValTypeRefNull(classStruct)`. This guarantees Wasm validation engine correctness and prevents downcasting during object creation, parameter passing, and member accesses.
