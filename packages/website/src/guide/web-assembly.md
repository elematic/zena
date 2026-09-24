---
title: 'WebAssembly'
description: 'How Zena targets WebAssembly GC, type mapping, memory layout, polymorphism, and runtime execution.'
---

::: note Draft
This guide is currently a draft and under active development.
:::

Zena is designed from the ground up specifically for **WebAssembly GC** (Wasm GC).

Most languages that target WebAssembly fall into one of two categories:

1. **Linear memory languages** (such as C++, Rust, or Go), which compile against
   raw linear memory bytes and bundle their own custom memory allocators or
   garbage collection runtimes into the binary.
2. **Multi-target GC languages** (such as Dart, Kotlin, Scala, or Java), which
   target Wasm GC alongside traditional VMs or native backends. Because their
   type systems were established for other runtime environments, their compilers
   must map existing semantics—like generic type erasure, runtime type
   information (RTTI), and legacy object lifecycles—onto WebAssembly's
   structural GC type system.

Zena is designed primarily with WebAssembly GC in mind: its core language
features purposefully align with WebAssembly GC primitives to enable fast and
small binaries.

## Architectural overview

Targeting WebAssembly GC natively provides several technical characteristics:

- **Zero-runtime GC bundling**: Zena binaries do not bundle a custom garbage collector or memory allocator, avoiding fixed runtime footprint overhead in small modules.
- **Direct host engine integration**: Objects allocated in Zena are managed directly by the host engine's garbage collector (such as V8 in Chrome and Node.js, SpiderMonkey in Firefox, JavaScriptCore in Safari, or Wasmtime). Zena GC references can hold host objects (such as JavaScript DOM nodes) directly without cross-heap handles or memory leak hazards.
- **Direct instruction mapping**: Because Zena's semantics match WebAssembly GC capabilities (such as non-nullable references and immutable struct fields), the compiler emits direct WebAssembly instructions without intermediate runtime shims or defensive null checks.

## Language alignment with Wasm GC

### Primitives and reference separation

Zena strictly separates value types from reference types to reflect WebAssembly's execution model:

- **Unboxed numeric and vector types**: Numeric primitives (`i32`, `i64`, `f32`, `f64`) and SIMD vectors (`v128`) map directly to WebAssembly core value types, residing on the operand stack and in local registers without tagging or NaN-boxing.
- **Narrow storage types**: `i8`, `u8`, `i16`, and `u16` describe exact storage widths for byte buffers, packed records, and WIT interop, promoting to 32-bit types during arithmetic.
- **No universal top type**: `anyref` is the top type for reference types only. There is no `any` or universal `Object` type that can hold both primitives and references.
- **No mixed-representation unions**: Union types cannot combine types that have different WebAssembly storage representations (for example, `i32 | String` is rejected at compile time).
- **Explicit boxing only**: Primitives are never implicitly boxed. Storing a primitive behind a reference requires explicit allocation (`new Box<i32>(42)`).

### Operations and conditionals

Zena's operators and control flow map directly to WebAssembly instructions:

- **Direct instruction mapping**: The operator set corresponds directly to WebAssembly numeric instructions (`+` compiles to `i32.add` or `f64.add`, `*` compiles to `i32.mul`, etc.). Primitive operations map to a single WebAssembly bytecode instruction without runtime library calls.
- **No implicit type coercion**: Operands must match their expected types. Arithmetic between differing widths or signedness (such as `i32` and `i64`, or `i32` and `u32`) requires explicit casting with `as`.
- **Strict boolean conditions**: Branch conditions in `if`, `while`, and ternary expressions strictly require an expression of type `boolean`. The `boolean` type compiles to WebAssembly `i32` (`1` for `true`, `0` for `false`), matching `br_if` and `if` branch conditions without emitted truthiness conversions or null tests.

### Functions and calling conventions

Functions compile directly to WebAssembly functions (`(func $name ...)`):

- **Direct WebAssembly calls**: Calls to non-closure functions compile to direct WebAssembly `call $func` instructions with no wrappers, trampolines, or custom dispatch logic.
- **Fixed arity**: Functions have a fixed parameter count matching WebAssembly function signatures (`(param ...)`).
- **Call-site default parameters**: Default parameter expressions are evaluated at the call site rather than inside the callee, allowing the function to retain a single fixed WebAssembly signature without entry-point branching.
- **Multi-value returns**: Unboxed tuples marked `inline` compile directly to WebAssembly multi-value function returns (`(result T_A T_B)`). Returned values occupy stack slots and local registers without heap allocation:

```zena
function getCoordinates(): inline (f64, f64) {
  return (10.0, 20.0);
}

let (x, y) = getCoordinates();
```

- **Closures as typed GC structs**: Arrow functions and local closures compile to WebAssembly GC structs containing a typed function reference (`(ref $func)`) and fields for captured variables, invoked via `call_ref`.

### Direct and packed arrays

Array implementations map directly to low-level WebAssembly GC array types:

- **Direct array types**: `FixedArray<T>` compiles to `(ref (array (mut T)))`, and `ImmutableArray<T>` compiles to `(ref (array T))`. They have no wrapper objects or length fields.
- **Native bounds checking**: Indexed reads and writes compile directly to `array.get` and `array.set`, relying on native engine hardware/JIT traps for out-of-bounds access without synthesized software bounds checks.
- **Packed element storage**: Narrow integer types (`i8`, `u8`, `i16`, `u16`) map directly to WebAssembly GC packed storage types `(array i8)` and `(array i16)` (such as `ByteArray`), reading via `array.get_u`/`array.get_s` and writing via `array.set`.
- **Contextual literals**: Array literals (`[1, 2, 3]`) construct `ImmutableArray` instances by default, adapting to contextual types (such as `FixedArray<T>`) at compile time without conversion.

### Adaptive string lowering

Strings in Zena are abstract sequences of Unicode characters with a uniform API, lowering adaptively to the host runtime:

- **Browser DOM integration**: In browser environments, strings can compile to UTF-16 using the WebAssembly JS String Builtins proposal, enabling direct reference passing to the DOM and JavaScript without memory copies or re-encoding.
- **WASI and native execution**: In WASI and standalone runtimes, strings compile to UTF-8/WTF-8 buffers in GC memory.

### Immutability and non-nullability by default

Zena's default type modifiers flow directly through to WebAssembly GC struct definitions:

- **Non-nullability by default**: Types compile to non-nullable WebAssembly references (`(ref $T)`). This allows the host JIT to omit defensive `ref.as_non_null` checks before field reads and method invocations. Nullable types are explicitly written (`T?` or `T | null`) and compile to `(ref null $T)`.
- **Immutability by default**: Class fields are immutable unless explicitly marked `var`. Immutable fields compile to `(field $name T)`, enabling host JIT optimizations such as constant propagation and load hoisting across loops.
- **Constructor initializers**: Field expressions are evaluated before object allocation. The constructor compiles directly to a single `struct.new` instruction with initialized field arguments:

```zena
class Point {
  x: f64;
  y: f64;
  new(this.x, this.y);
}
```

Because fields receive their values at allocation time, they can be declared immutable and non-nullable in WebAssembly GC structs.

## Type mapping

Zena maps its types to the most compact WebAssembly representation:

| Zena Type           | WebAssembly Representation | Description                                |
| :------------------ | :------------------------- | :----------------------------------------- |
| `i32`, `i64`        | `i32`, `i64`               | Native 32-bit and 64-bit integers          |
| `u32`, `u64`        | `i32`, `i64`               | Unsigned 32-bit and 64-bit integers        |
| `f32`, `f64`        | `f32`, `f64`               | Native 32-bit and 64-bit IEEE floats       |
| `boolean`           | `i32`                      | `1` for `true`, `0` for `false`            |
| `class Foo`         | `(ref $Foo)`               | Non-nullable typed GC struct reference     |
| `Foo?`              | `(ref null $Foo)`          | Nullable typed GC struct reference         |
| `anyref`            | `anyref`                   | Top reference type (references only)       |
| `inline (A, B)`     | `(result T_A T_B)`         | Unboxed stack-allocated multi-value return |
| `FixedArray<T>`     | `(ref (array (mut T)))`    | Fixed-length mutable Wasm GC array         |
| `ImmutableArray<T>` | `(ref (array T))`          | Native immutable Wasm GC array             |
| `ByteArray`         | `(ref (array (mut i8)))`   | Packed 8-bit mutable byte array            |

## Deep dive

For an exhaustive catalog of all compiler passes and low-level alignment decisions, see the [WebAssembly alignment](/development/design/wasm-alignment/) design document.

## Next

- [Why Zena?](/guide/why-zena/) — Design motivations and philosophy
- [Performance](/guide/performance/) — Devirtualization, reachability analysis, and binary size
- [Types](/guide/types/) — Zena's sound, static type system
