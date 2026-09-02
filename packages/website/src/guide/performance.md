---
title: 'Performance'
description: 'Performance characteristics, cost model, monomorphization, devirtualization, and binary size optimization in Zena.'
---

Zena is designed to deliver predictable, near-native execution speed on
WebAssembly GC.

This performance profile comes from two complementary factors:
   and hidden runtime checks simply by omitting those features from the language.
## What each construct costs

Understanding how language features translate to WebAssembly instructions helps
you make informed architectural choices.

| Cost Category | Language Construct | WebAssembly Lowering | Runtime Impact |
| :--- | :--- | :--- | :--- |
| **Zero-Cost** | Primitive operations (`+`, `*`, `==`) | `i32.add`, `f64.mul`, `i32.eq` | Raw hardware ALU speed; no boxing or tagging. |
| **Zero-Cost** | Inline tuples (`inline (a, b)`) | `(result T_A T_B)` | Kept on the execution stack/registers; zero GC allocations. |
| **Zero-Cost** | Extension class methods | Direct `(func $name ...)` | Erased at compile time; receiver passed as first argument. |
| **Zero-Cost** | `final` methods and direct calls | Direct `call $func` | Direct call target; eligible for host engine inlining. |
| **Zero-Cost** | Top-level `function` declarations | Plain `(func ...)` | Zero closure environment allocation. |
| **Low-Cost** | Class field access (`obj.field`) | `struct.get $Class $offset` | Single-instruction direct offset load. |
| **Low-Cost** | Class construction (`new Point(...)`) | `struct.new $Point` | Single-instruction allocation with pre-evaluated fields. |
| **Low-Cost** | Virtual method calls | `struct.get` + `call_ref` | Single load from static vtable followed by indirect call. |
| **Moderate** | Interface method calls | Fat Pointer ITable lookup | Two-word indirection (load ITable from fat pointer, then `call_ref`). |
| **Moderate** | Arrow functions / Closures | `struct.new $Closure` | Allocates a GC closure struct to capture local variables. |
| **Moderate** | Function arity adaptation | Adapter trampoline | Lightweight wrapper when passing a callback with fewer arguments. |
| **Allocation** | Explicit boxing (`new Box(42)`) | `struct.new $Box` | Heap allocation to wrap primitive in a reference type. |
| **Allocation** | `GrowableArray<T>` resizing | `array.copy` + `array.new` | Reallocates backing buffer when exceeding capacity. |

## Monomorphized generics

Zena uses **generic monomorphization** (specialization) rather than runtime
generic erasure to `Object` or `anyref`.

When you write a generic class or function:

```zena
class Cell<T>(value: T)

let intCell = new Cell<i32>(42);
let floatCell = new Cell<f64>(3.14);
```

The compiler synthesizes distinct, specialized WebAssembly types and functions
for each unique concrete type argument:

```wat
;; Specialized struct for Cell<i32>
(type $Cell_i32 (struct (field $value i32)))

;; Specialized struct for Cell<f64>
(type $Cell_f64 (struct (field $value f64)))
```

### Benefits of monomorphization

- **Unboxed primitive collections**: An `Array<i32>` is backed by a native Wasm
  `(array i32)`. Reading or writing elements requires no boxing or unboxing
  conversions.
- **Direct struct layout**: Generic fields containing primitives occupy exact
  scalar bitwidths (e.g., 4 bytes for `i32`, 8 bytes for `f64`) without pointer
  indirection.
- **Specialized operations**: Arithmetic inside generic functions compiles to
  native hardware instructions rather than virtual method dispatch.

### Managing specialization overhead

Monomorphizing generics creates a separate copy of code and type declarations for
each concrete type instantiation. To keep binaries compact:

- The compiler's **reachability analysis** only emits specializations that are
  actually instantiated in the program.
- Shared logic that does not depend on type parameters can be factored into
  non-generic base classes or helper functions.

## Devirtualization and inlining

Virtual method dispatch in object-oriented programming introduces a level of
indirection by loading a function reference from a vtable before calling it.

Zena applies **compile-time devirtualization** to eliminate this indirection
wherever possible, replacing virtual dispatches with direct WebAssembly
`call $func` instructions.

### Explicit devirtualization with `final`

Declaring a class or method as `final` informs the compiler that it cannot be
overridden:

```zena
final class FastCalculator {
  compute(x: i32): i32 {
    return x * 2 + 1;
  }
}
```

Calls to `FastCalculator.compute` bypass vtable lookups completely. Direct calls
are prime candidates for host JIT compilers (such as V8 or Wasmtime) to inline
the method body entirely.

### Whole-program devirtualization

Even when a class is not explicitly marked `final`, Zena's compiler performs
whole-program reachability analysis during compilation. If the compiler proves
that a class has no derived subclasses instantiated anywhere in the application,
it automatically devirtualizes calls on that class.

## Boxing and how to avoid it

In many languages, boxing occurs implicitly whenever primitive values are passed
to generic APIs, collections, or interfaces.

In Zena, **primitives are never implicitly boxed**.

### Soundness without a universal `any`

Zena has no universal `any` or `Object` type that can transparently hold both
primitives and references. `anyref` is the top type for **references only**.

If code requires putting a primitive value behind a reference type, it must be
explicitly wrapped using `Box<T>`:

```zena
class Box<T> {
  value: T;
  new(this.value);
}

let boxed: anyref = new Box<i32>(42);
```

Because boxing requires an explicit `new Box(...)`, allocations are never hidden
inside language syntax.

### Best practices for avoiding allocations

1. **Use monomorphic collections**: Use `Array<i32>` or `FixedArray<f64>`
   instead of generic wrapper types.
2. **Use inline tuples for multi-value returns**: Return multiple values using
   `inline (A, B)` to leverage unboxed WebAssembly multi-value returns:
   ```zena
   function divide(a: i32, b: i32): inline (i32, i32) {
     return (a / b, a % b); // Stored in registers; zero heap allocations
   }
   ```
3. **Prefer value parameters in extension classes**: Extension classes on
   primitives (`extension class IntOps on i32`) are completely erased at
   compile time with zero object wrapper overhead.
4. **Use concrete array types in hot loops**: Because `Array<T>` is an interface,
   accessing elements via `Array<T>` incurs Fat Pointer interface dispatch.
   Typing variables or parameters as concrete classes (`FixedArray<T>` or
   `GrowableArray<T>`) allows direct method dispatch and inlining in tight loops.

## What ends up in the binary

Zena produces compact, standalone WebAssembly modules containing only the code
required to execute the application.

A compiled `.wasm` file consists of:

- **Type section**: Nominal declarations for every reached class struct,
  interface vtable, closure environment, and array type.
- **Function section**: Compiled WebAssembly bytecode for all reached methods,
  functions, and synthesized initializers.
- **Global section**: Static singletons, immutable vtables, and constant string
  references.
- **Element section**: Function pointer tables used for indirect vtable calls.
- **Data section**: Static string bytes and binary data literals.

### Impact of debug metadata (`-g`)

By default, production builds strip all symbol names and debug metadata to
minimize binary size.

When compiling with the `-g` flag, the compiler attaches a WebAssembly **name
section** containing original function, class, and method names. While
invaluable for debugging and stack traces, the name section adds metadata
bytes and should be omitted in size-critical production deployments.

## Dead code elimination

Zena utilizes a whole-program **Rapid Type Analysis (RTA)** pass during compilation
to eliminate unused code and types.

### How reachability analysis works

1. **Rooting entry points**: Compilation begins by marking the main entry point
   function (`export function main(...)`) or public library exports as live.
2. **Propagating references**: As functions are analyzed, any classes
   constructed, methods called, or fields read are added to the reachable set.
3. **Pruning unused members**: Methods in imported libraries or unused classes
   that are never instantiated or invoked are completely stripped from the final
   WebAssembly binary.
4. **Pruning type declarations**: Any Wasm GC struct or array types that are
   never constructed or referenced are omitted from the module's type section.

This whole-program analysis allows developers to import comprehensive standard
library modules without incurring code size penalties for features they do not
use.

## Measuring and benchmarking

To measure and optimize Zena applications, use the built-in benchmarking tools
and inspection utilities.

### Running benchmarks

The Zena repository includes a micro-benchmarking suite that compares Zena's
execution performance against native JavaScript under Node.js and Wasmtime:

```bash
npm run benchmark -w @zena-lang/zena-compiler
```

To filter for specific benchmarks:

```bash
npm run benchmark -w @zena-lang/zena-compiler -- --filter StringBuilder
```

### Inspecting WebAssembly bytecode

To inspect the generated WebAssembly bytecode and verify compiler optimizations:

```bash
# Compile to WebAssembly Text format (.wat)
npm run zena -w @zena-lang/zena-cli -- build main.zena -o main.wat

# Inspect section sizes using wasm-tools
wasm-tools objdump main.wasm
```

## Next

- [WebAssembly](/guide/web-assembly/) — type mapping, memory layout, and runtime architecture
- [Values and Variables](/guide/values-and-variables/) — immutability and variable semantics
- [Classes](/guide/classes/) — case classes, vtables, and devirtualization
