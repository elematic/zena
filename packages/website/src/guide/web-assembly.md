---
title: 'WebAssembly'
description: 'How Zena targets WebAssembly GC, type mapping, memory layout, polymorphism, and runtime execution.'
---

Zena is designed from the ground up specifically for **WebAssembly GC** (Wasm GC).

Most languages that target WebAssembly fall into one of two categories:

1. **Linear memory languages** (such as C++, Rust, or Go), which compile against
   raw linear memory bytes and bundle their own custom memory allocators or
   garbage collection runtimes into the binary.
2. **Multi-target GC languages** (such as Dart, Kotlin, Scala, or Java), which
   target Wasm GC alongside traditional VMs or native backends. Because their
   type systems were established for other runtime environments, their compilers
   must map existing semantics—like generic type erasure, runtime type inspection
   (RTTI), and legacy object lifecycles—onto WebAssembly's structural GC type
   system.

Zena is designed primarily with WebAssembly GC in mind: its core language
features—such as constructor initializer lists that compile directly to
`struct.new`, explicit boxing with no universal `any`, immutability by default,
and unboxed inline tuples—align naturally with WebAssembly GC primitives from
first principles.

## Targeting Wasm GC

Targeting Wasm GC natively offers several core architectural advantages:

- **Zero-runtime GC bundling**: Zena binaries do not embed a custom garbage
  collector or memory allocator, avoiding fixed runtime footprint overhead in
  small modules.
- **Direct host engine integration**: Objects allocated in Zena are managed
  directly by the host engine's garbage collector (such as V8 in Chrome and Node.js,
  SpiderMonkey in Firefox, JavaScriptCore in Safari, or Wasmtime). Zena GC
  references can hold JavaScript DOM nodes and host objects directly without
  cross-heap handles or memory leak hazards.
- **Engine-level optimizations**: High-performance Wasm engines provide
  generational, parallel, and concurrent collectors with deep OS and hardware
  optimizations that single-language embedded GCs rarely match.
- **Direct semantic alignment**: Because Zena's semantics match Wasm GC
  capabilities (such as non-nullable references and immutable struct fields), the
  compiler emits direct WebAssembly instructions without layers of runtime shims
  or defensive null checks.

### The type section trade-off

Because Wasm GC is statically typed at the bytecode level, every distinct class,
interface vtable, closure environment, and array shape must be explicitly
declared in the WebAssembly module's **type section**.

This introduces an architectural trade-off: while Zena avoids bundling GC engine
code, modules with numerous generic specializations or class hierarchies emit
larger type sections. Whole-program reachability analysis and dead-code
elimination ensure that only types and methods actually constructed or called
are emitted into the final binary.

## Type mapping and representation

A core architectural principle of Zena is that **the compiler always strives to
use the most compact and fastest WebAssembly representation possible**.

Whenever a Zena variable, field, or parameter is non-nullable and immutable, the
compiler emits strictly **non-nullable** (`(ref $T)`) and **non-mutable**
(`(field $T)`) WebAssembly types. This design yields smaller binary sizes,
enables host JIT optimizations (constant propagation, load hoisting), and
eliminates runtime null checks (`ref.as_non_null`).

| Zena Type           | WebAssembly Representation | Description                            |
| :------------------ | :------------------------- | :------------------------------------- |
| `i32`               | `i32`                      | 32-bit signed integer                  |
| `i64`               | `i64`                      | 64-bit signed integer                  |
| `f32`               | `f32`                      | 32-bit IEEE 754 float                  |
| `f64`               | `f64`                      | 64-bit IEEE 754 float                  |
| `boolean`           | `i32`                      | `1` for `true`, `0` for `false`        |
| `class Foo`         | `(ref $Foo)`               | Non-nullable typed GC struct reference |
| `Foo?`              | `(ref null $Foo)`          | Nullable typed GC struct reference     |
| `anyref`            | `anyref`                   | Top reference type (references only)   |
| `inline (A, B)`     | `(result T_A T_B)`         | Unboxed multi-value return             |
| `FixedArray<T>`     | `(ref (array (mut T)))`    | Fixed-length mutable Wasm GC array     |
| `ImmutableArray<T>` | `(ref (array T))`          | Native immutable Wasm GC array         |

### Primitive operations

Operations on primitive types map directly to single WebAssembly instructions
without boxing, tag checks, or allocations:

- Arithmetic and bitwise operations (`+`, `-`, `*`, `/`, `&`, `|`, `^`, `<<`, `>>`)
  compile directly to their corresponding `i32` and `f64` Wasm instructions.
- Identity equality (`===`) compiles directly to `i32.eq`, `f64.eq`, or `ref.eq`.
  Value equality (`==`) dispatches to the overridable `==` method.

### No implicit boxing and no universal top type

Unlike TypeScript, JavaScript, Dart, or Java, Zena has **no `any`, `dynamic`, or
`Object` type** that can hold primitives directly.

`anyref` is the top type for **references only**. A primitive `i32` or `f64`
cannot be assigned to `anyref` without explicitly allocating a container
(`new Box<i32>(42)`). Because there is no universal type that transparently
accepts both primitives and heap references, the compiler never introduces
hidden boxing allocations.

### Inline tuples and multi-value returns

Zena supports both first-class heap tuples (`(A, B)`, backed by synthesized GC
structs) and zero-allocation **inline tuples**.

When a tuple is prefixed with `inline` (e.g., `inline (i32, f64)`), it is an
unboxed, stack-bound value that compiles directly to WebAssembly **multi-value
function returns**:

```zena
function getCoordinates(): inline (f64, f64) {
  return (10.0, 20.0);
}
```

Compiles in WebAssembly to:

```wat
(func $getCoordinates (result f64 f64)
  f64.const 10.0
  f64.const 20.0
  return
)
```

When destructured via `let (x, y) = getCoordinates();`, the values remain in local
registers on the WebAssembly execution stack without touching the GC heap.

## Arrays

Zena provides specialized array types backed directly by WebAssembly GC `(array ...)` definitions:

- **`FixedArray<T>`**: Backed by `(ref (array (mut T)))`, representing a fixed-length
  array whose elements can be updated in-place via `array.set`.
- **`ImmutableArray<T>`**: Backed by `(ref (array T))` with non-mutable elements.
  Array literals (`[1, 2, 3]`) currently produce `FixedArray<T>` and are designed
  to produce `ImmutableArray<T>`, allowing engines to share and constant-fold
  array data safely.
- **`GrowableArray<T>`**: A class that wraps a backing `FixedArray<T>` with
  length and capacity tracking, resizing via `array.copy` when capacity is exceeded.
- **`Array<T>`**: The common read-only interface implemented by `FixedArray<T>`,
  `ImmutableArray<T>`, and `GrowableArray<T>`.

### Array interface overhead

Because `Array<T>` is an interface rather than a concrete class, references
typed as `Array<T>` pay the overhead of **Fat Pointer interface dispatch** (an
ITable lookup).

While alternative designs could have eliminated this indirection, keeping
`Array<T>` as an interface provides a familiar, unified API across fixed,
immutable, and growable buffers. Future whole-program optimizations will
automatically devirtualize and specialize interface-typed array calls in
monomorphic contexts.

## Strings

Strings in Zena are abstract sequences of Unicode characters rather than raw byte
or code unit arrays.

By hiding underlying bytes and encoding details from userland APIs, the compiler
can compile strings to UTF-8/WTF-8 (for WASI and native runtimes) or UTF-16/WTF-16
(for JavaScript and the DOM via the WebAssembly JS String Builtins proposal) to
match the host platform and avoid costly re-encoding—without breaking Zena
programs.

See [Strings and Unicode](/guide/strings/) for full details on string semantics,
Unicode indexing, and string operations.

## Linear memory and `zena:memory`

While general Zena code uses Wasm GC objects, high-performance systems programming
often requires byte-level layout control.

Through the `zena:memory` module, Zena provides access to standard WebAssembly
**Linear Memory** (pages of unmanaged bytes). Linear memory is used for:

- SIMD vector operations (`v128`).
- Low-level binary serialization and network protocol decoding.
- Interoperating with C-ABI libraries or WASI file system calls.

Wasm GC structs and linear memory coexist within the same Zena module.

## Classes, polymorphism, and dispatch

Zena implements class inheritance and polymorphism by leveraging WebAssembly GC
structural subtyping and specialized virtual tables.

### Single inheritance with `struct.sub`

Classes with single inheritance map directly to WebAssembly's native subtyping
hierarchy (`sub` declarations):

```wat
;; Base class struct
(type $Shape (sub (struct (field $vtable (ref $Shape_vtable)) (field $color (ref $String)))))

;; Derived class struct extending $Shape
(type $Circle (sub $Shape (struct (field $vtable (ref $Circle_vtable)) (field $color (ref $String)) (field $radius f64))))
```

Because derived class fields are laid out at identical offsets to their superclasses,
accessing inherited fields on a subclass is a direct `struct.get` instruction
without dynamic offset lookups.

### Virtual method dispatch

Method calls on classes are dispatched through static virtual tables (vtables):

1. The class instance holds a non-nullable reference to its static vtable struct.
2. The vtable struct contains typed function references (`(ref $FuncType)`).
3. The method call loads the function reference from the vtable and invokes it via
   `call_ref`.

When a class or method is marked `final`, or when reachability analysis proves a
class has no subclasses, the compiler automatically devirtualizes the call into a
direct `call $func` instruction (see [Performance](/guide/performance/)).

### Interface dispatch via fat pointers

Because a class in Zena can implement multiple interfaces, single-vtable offsets
cannot accommodate all interface layouts.

Zena represents interface references as **Fat Pointers**—a lightweight pair of:

1. **Instance reference**: The underlying object (`anyref`).
2. **Interface table (ITable)**: A specialized vtable tailored specifically to
   the interface's method offsets for that concrete class.

When an object is upcast to an interface (`let drawable: Drawable = circle;`),
the compiler constructs this pair. Method calls through the interface load the
adapted function pointer from the ITable and pass the instance as the receiver.

### Native checked casts

Dynamic type testing (`obj is Circle`) and downcasting (`obj as Circle`) compile
directly to native Wasm GC instructions:

- `ref.test $Circle`: Returns `1` if the reference is an instance of `$Circle`,
  `0` otherwise.
- `ref.cast $Circle`: Downcasts the reference, trapping or failing if the type
  does not match.

These instructions execute in hardware or JIT machine code without walking
prototype chains or checking string type tags.

## Struct construction and immutability

WebAssembly GC struct fields can be declared as either mutable (`(field (mut T))`)
or immutable (`(field T)`).

Immutable fields offer substantial performance advantages: modern JIT compilers
can fold constant field reads, cache loads across loops, and optimize field
accesses aggressively.

### Why constructor initializer lists matter

In languages like TypeScript or Java, constructor bodies run after an object is
allocated with zeroed or null fields, requiring fields to be mutable during
construction.

Zena avoids this through **constructor initializer lists**:

```zena
class Point {
  x: f64;
  y: f64;
  new(this.x, this.y);
}
```

Because all fields and constructor parameter expressions are fully evaluated
_before_ the struct is created, the compiler emits a single `struct.new`
instruction:

```wat
;; Compiles directly to a single struct.new with initialized arguments
local.get $x
local.get $y
struct.new $Point
```

This architecture allows Zena to declare class fields as **non-mutable** and
**non-nullable** in WebAssembly GC structs.

## Functions and calling conventions

Top-level functions and arrow functions have distinct WebAssembly representations
in Zena.

### Functions vs. closures

- **Top-level `function` declarations**: Emitted as plain WebAssembly functions
  (`(func $name ...)`). They have zero allocation overhead and cannot capture
  surrounding lexical variables.
- **Arrow functions and closures**: Emitted as a WebAssembly GC closure struct
  containing a typed function reference (`(ref $func)`) and fields for each
  captured local variable.

### Default arguments and arity adaptation

WebAssembly functions require fixed, exact parameter lists. To support flexible
calling patterns efficiently:

- **Default values**: Evaluated at the **call site** whenever arguments are
  omitted, passing the complete parameter list to the underlying function.
- **Arity adaptation**: When a callback accepting fewer parameters (e.g.,
  `(x) => print(x)`) is passed to a higher-order function expecting more
  arguments (e.g., `(item, index)`), the compiler generates a lightweight
  trampoline wrapper that discards unused arguments safely.

## Async, exceptions, and runtime execution

Zena compiles modern asynchronous control flow and exception handling to native
WebAssembly features.

### Stackless async transformation

Rather than waiting for experimental WebAssembly stack-switching proposals or
relying on heavy runtime fibers, Zena uses a **stackless state machine split
transformation**:

1. An `async` function is transformed into a state machine struct that stores its
   local variables and resume step.
2. Each `await` point splits the function body into continuation blocks.
3. When an awaited `Future` completes, the state machine's resume function is
   scheduled onto the microtask queue.

This coroutine architecture runs on any standard Wasm GC runtime today,
integrating seamlessly with JavaScript Promises and WASI event loops.

### Exception handling

Zena's `throw` and `try/catch` statements compile to the standard WebAssembly
**Exception Handling** proposal (`throw_ref`, `try_table`, and `catch`).
Exceptions propagate using native engine stack unwinding without manual error-code
polling.

### Stack traces and debug symbols

Standard WebAssembly does not provide a built-in bytecode instruction for
inspecting the call stack or reading exception backtraces from inside a module.

To provide first-class stack traces on exception objects, Zena uses a **host
import protocol**:

- When an `Error` or `Exception` is created, Zena invokes host import functions
  (`captureStackTrace`, `formatStackTrace`, or `getStackTrace`).
- **Host implementations**: Zena ships implementations of this protocol for both
  **JavaScript / V8** (extracting frames from `Error.stack`) and **Wasmtime /
  Rust** (capturing `wasmtime::WasmBacktrace`).

By default, production WebAssembly binaries strip function names to optimize
file size, resulting in numeric stack traces (e.g., `wasm-function[42]`). When
compiled with the debug names flag (`-g`), the compiler emits a standard
WebAssembly **name section**, allowing host backtraces to format human-readable
traces with original class names, method identifiers, and function names.

## Next

- [Performance](/guide/performance/) — devirtualization, monomorphization, and binary size
- [Values and Variables](/guide/values-and-variables/) — immutability and variable semantics
- [Classes](/guide/classes/) — class inheritance, vtables, and accessors
