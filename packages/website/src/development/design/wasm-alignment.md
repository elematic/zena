---
title: 'WebAssembly alignment'
description: 'A catalog of design decisions in the Zena language and compiler that align with WebAssembly and WebAssembly GC.'
---

A catalog of design decisions in the Zena language and compiler that align with
WebAssembly and WebAssembly GC.

This document serves as an internal reference for language design,
documentation, and compiler implementation.

## Design premise

Languages running on WebAssembly generally fall into two categories:

1. **Linear memory languages** (C, C++, Rust, Go): Compile against linear memory
   byte arrays and bundle custom memory allocators or runtime garbage collectors
   into the module.
2. **Multi-target GC languages** (Dart, Kotlin, Java, Scala): Designed for
   dedicated virtual machines, requiring compilers to map legacy semantics (such
   as universal runtime type information, dynamic object headers, and generic
   type erasure) onto WebAssembly's structural GC type system.

Zena targets WebAssembly GC exclusively. Because it has no legacy virtual
machine or native execution target, its core semantics—types, constructors,
memory layout, and calling conventions—map directly to WebAssembly primitives
without intermediate runtime layers.

## Type system and primitives

### Unboxed numeric types

Zena's numeric types (`i32`, `i64`, `f32`, `f64`) map directly to WebAssembly's
four core value types:

- Arithmetic and bitwise operations (`+`, `-`, `*`, `/`, `&`, `|`, `^`, `<<`,
  `>>`) compile to single WebAssembly instructions (`i32.add`, `f64.mul`, etc.).
- Primitive values reside on the WebAssembly operand stack and in local
  variables without tagging, NaN-boxing, or heap allocations.

### Strict boolean conditions

Zena has no implicit type coercion or truthiness rules:

- Control flow branch conditions (`if`, `while`, ternary expressions) strictly
  require an expression of type `boolean`.
- The `boolean` type compiles to WebAssembly `i32` (`1` for `true`, `0` for
  `false`), matching WebAssembly's integer branch conditions (`br_if`, `if`).
- Because condition expressions cannot receive non-boolean values, the compiler
  emits condition results directly into branch instructions without truthiness
  checks, null checks, or conversions.

### Separation of values and references

Because Wasm GC strictly separates primitives from references types, Zena has no
universal `any` or `Object` type that can hold both primitives and heap
references:

- `anyref` is the top type for reference types only.
- Primitives cannot be assigned to `anyref` without explicit boxing (`new
Box<i32>(x)`).
- The compiler never performs auto-boxing.
- Unions cannot hold types with different Wasm storage types. `i32 | String` is
  not allowed.

### Non-nullability by default

Types are non-nullable by default:

- A type `T` compiles to a non-nullable reference `(ref $T)`.
- A type that includes null via a union (`T | null` or the shorthand `T?`)
  compiles to a nullable reference `(ref null $T)`.
- Non-nullable references eliminate runtime `ref.as_non_null` checks before
  field reads and method calls, allowing host JIT compilers to omit defensive
  null checks in emitted machine code.

### Multi-value function returns

Zena support multi-value function returns via unboxed stack-bound tuples using
the `inline` modifier:

- An `inline (A, B)` return type compiles directly to WebAssembly multi-value
  function returns (`(result T_A T_B)`).
- Returned values occupy execution stack slots and local registers.
- Destructuring an inline tuple (`let (x, y) = getPair();`) binds locals
  directly without allocating a heap struct.

### Direct array types

`FixedArray<T>` and `ImmutableArray<T>` map directly to low-level WebAssembly GC
array types:

- `FixedArray<T>` compiles to `(ref (array (mut T)))`.
- `ImmutableArray<T>` compiles to `(ref (array T))`.
- These types have no wrapper objects, indirection layers, or synthesized
  bounds-checking code. Indexed reads and writes compile directly to `array.get`
  and `array.set`, relying on the engine's native trap for out-of-bounds access.
- Array literals (`[1, 2, 3]`) construct `ImmutableArray` instances by default.
  When an expression has a contextual type (such as `FixedArray<T>`), the literal
  adapts to that contextual type at compile time without runtime conversion.

### Dense and packed array storage

Array storage maps directly to contiguous WebAssembly GC memory:

- Arrays in Zena are dense and contiguous in memory. There are no sparse arrays,
  hole checks, or dictionary representations.
- Narrow integer types (`i8`, `u8`, `i16`, `u16`) map directly to WebAssembly GC
  packed storage types `(array i8)` and `(array i16)`. For example, `ByteArray`
  and `FixedArray<u8>` store elements as packed 8-bit bytes.
- Reading from a packed array compiles to `array.get_u` or `array.get_s`, which
  zero-extends or sign-extends the value into an `i32` operand on the execution
  stack. Writing compiles to `array.set`, which truncates the `i32` value to the
  packed storage width.

## Object model and memory layout

### Constructor initializers compiling to `struct.new`

Zena requires fields to be initialized before constructor bodies, and evaluates
field initialization before allocating objects. Field initializers, onstructor
parameters, and initializer list expressions compute all field values for the
entire inheritance chain upfront. Allocation compiles directly to a single
WebAssembly `struct.new` instruction populated with the evaluated field
arguments.

Because fields receive their values at allocation time, class fields can be
declared immutable and non-nullable in WebAssembly GC structs. If Zena
initialized fields inside constructor bodies after allocation, objects would
have to be allocated with default or null values and mutated afterward,
requiring fields to be declared mutable and nullable in WebAssembly bytecode.

### Immutable struct fields by default

Class fields are immutable by default:

- Immutable fields compile to `(field $name T)`.
- Only fields explicitly marked `var` compile to `(field (mut $name) T)`.
- Immutable fields allow host JIT compilers to perform constant propagation,
  load hoisting across loops, and redundant load elimination.

### Structural subtyping with `struct.sub`

Zena is single inheritance only. Class hierarchies compile directly to
WebAssembly GC's native subtyping mechanism (`sub` declarations):

- Subclasses place inherited fields at identical index offsets to their
  superclasses.
- Reading an inherited field on a subclass compiles to a direct `struct.get`
  instruction using a fixed index, without dynamic offset lookup.

### Native type testing and downcasting

Dynamic type operations map directly to WebAssembly GC type instructions:

- `x is TargetClass` compiles to `ref.test $TargetClass`.
- `x as TargetClass` compiles to `ref.cast $TargetClass`.
- Both instructions execute natively in engine machine code without traversing
  prototype chains or comparing string type tags.

### Final struct types

Case classes and classes with no subclasses are emitted with the `final` keyword
in WebAssembly (`(type $T (sub final ...))`):

- Declaring a struct final informs the engine that no further subtypes exist.
- Engines use this information to devirtualize method calls and omit polymorphic
  inline cache entries.

### Interface polymorphism and fat pointer dispatch

WebAssembly GC provides native single inheritance via `sub` declarations, but
lacks a primitive mechanism for multiple interface subtyping. Zena provides
multiple interface implementation for familiar object-oriented polymorphism,
accepting the representation overhead.

Because a class can implement multiple interfaces, method offsets cannot be
assigned to a single linear table. Zena represents interface values as fat
pointers:

1. A fat pointer is a two-field struct containing the object instance
   (`anyref`) and an interface table (ITable) reference.
2. The ITable contains function references ordered specifically for that
   interface's method layout.
3. Upcasting to an interface constructs a fat pointer struct (`iface.pack`).
   Method dispatch loads the function reference from the ITable and executes
   `call_ref`, passing the instance reference as the first argument.
4. Classes generate ITables only for the interfaces they explicitly implement,
   avoiding global dispatch matrices.

The compiler's optimization pipeline alleviates the overhead of fat pointers and
indirect calls through several passes:

- **Devirtualization**: When type propagation, provenance tracking, or inlining
  identifies the concrete receiver type, the compiler replaces the indirect
  interface call with a direct function call (`call $f`). This avoids
  constructing the fat pointer and eliminates indirect dispatch.
- **Escape analysis, scalar replacement, and argument explosion**: When a fat
  pointer does not escape the local function scope, escape analysis and scalar
  replacement of aggregates (SRoA) decompose the two-field struct into separate
  local variables. Argument explosion passes the instance and ITable references
  as separate arguments across specialized function boundaries, avoiding heap
  allocations.
- **Loop-invariant code motion, GVN, and redundant load elimination**: When
  interface calls remain dynamic inside loops, loop-invariant code motion (LICM)
  hoists fat pointer field reads and ITable slot loads outside the loop body.
  Global value numbering (GVN) and common load elimination deduplicate repeated
  loads across multiple calls on the same receiver.

### Closed hierarchies and sealed classes

Sealed classes define a fixed set of subclasses known at compile time:

- Pattern matching on sealed classes compiles to jump tables (`br_table`) or
  ordered type-test cascades.
- Because exhaustiveness is verified at compile time, the compiler omits
  unreachable fallback branches and defensive runtime exceptions.
- Closed hierarchies help the compiler devirtualize method calls.

## Functions and calling conventions

### Function declarations and direct calls

Functions compile directly to WebAssembly functions (`(func $name ...)`):

- Calls to non-closure functions compile to direct WebAssembly `call $func`
  instructions with no custom dispatch logic or preamble checks.
- Functions have fixed arity because WebAssembly function signatures require a
  fixed parameter count (`(param ...)`).
- For ergonomics, functions support default parameter values. Default
  expressions are evaluated at the call site rather than inside the callee,
  allowing the function to retain a single fixed WebAssembly signature without
  entry-point branching.
- Top-level functions cannot capture surrounding lexical variables and are
  never closures, incurring zero allocation overhead.

### Closures as typed GC structs

Arrow functions can be used as closures which compile to WebAssembly GC structs
and naturally have some overhead vs plain functions:

- The struct contains a typed function reference (`(ref $func_type)`) and fields
  for each captured variable.
- Invocation loads the function pointer from the closure struct and executes
  `call_ref`, passing the closure struct as the environment argument.
- Closure wrapper allocation can be mitigated by the same compiler optimizations
  that help with interface references: SRoA, argument explosion, etc.
- Higher-order functions with inline callbacks, like `map((i) => i)`, are
  optimized to simple loops via inlining, loop-invariant code motion, SRoA, etc.

### Compiler-synthesized arity adaptation

When a callback with fewer parameters (e.g., `(item) => expr`) is passed to a
callee expecting more parameters (e.g., `(item, index, collection)`), the
compiler generates an adaptation trampoline:

- The trampoline matches the callee's expected parameter signature, discards the
  unused arguments, and calls the target closure.
- This preserves exact WebAssembly function reference typing without boxing
  arguments into an array or inspecting argument counts at runtime.

## Memory management and runtime footprint

### No bundled garbage collector

Zena compiles exclusively to WebAssembly GC instructions:

- Binaries do not bundle a a garbage collector or memory allocator (unless using
  the `zena:memory` library)
- The compiler and runtime do not have to insert GC safepoint checks or
  stack-inspection hooks into single-threaded application code.
- Memory management is handled directly by the host engine's garbage collector,
  which is likely faster and more sophisticated than any bundled GC.

### Direct references to host objects

Zena GC references can hold host objects directly:

- In GC environments, like browsers and Node.js, Zena objects share the garbage
  collector with the host, like the JavaScript engine and the DOM, allowing
  direct collectible references to JavaScript objects, DOM nodes, and other host
  objects.
- Collection across host↔Wasm boundary works, allowing Zena to correctly hold on
  to DOM objects, or JavaScript to hold Zena objects with working collection.
- Interaction does not require handle tables, integer object IDs, or finalizer
  registries, eliminating cross-boundary memory leaks.

### Coexisting linear memory via `zena:memory`

When low-level byte access is necessary, Zena code can allocate and read
WebAssembly linear memory:

- Linear memory pages support SIMD vector operations (`v128`), binary buffer
  parsing, and C-ABI data structures.
- Linear memory and GC objects coexist within the same module, allowing
  byte-level operations without forcing the entire application into unmanaged
  memory.
- WASI component ABI lowering is written in Zena using the standard linear
  memory library.

### Whole-program reachability analysis

The compiler performs whole-program reachability analysis from module entry
points:

- Types, methods, and functions that are not reachable are omitted from the
  output binary.
- This bounds the size of the WebAssembly type section and element segment in
  applications using large libraries.

## Host interoperability and component model

### Adaptive string lowering

Strings in Zena are abstract sequences of Unicode characters:

- For browser environments, strings can compile to UTF-16 using the WebAssembly
  JS String Builtins proposal, allowing direct passing of string references to
  the DOM without memory copying or re-encoding. (In progress)
- For WASI and standalone runtimes, strings compile to UTF-8/WTF-8 buffers.
- User code uses the same `String` API across both compilation targets.
- Applications can use a mix of Zena-native, host, and linear memory strings.
  (In progress)

### Native exception handling

Zena's `throw` and `try/catch` statements compile to the WebAssembly Exception
Handling proposal:

- Throws emit `throw_ref` or `throw`.
- Handlers emit `try_table` with `catch` clauses.
- Exceptions unwind using native engine stack management without manual error
  code checks or `setjmp`/`longjmp` emulations.

### Component Model and WIT integration

Zena has native support for the WebAssembly Component Model:
Zena is designed to align directly with the WebAssembly Component Model and
WebAssembly Interface Types (WIT):

- **WIT imports**: Zena libraries can import WIT files directly.
- **Direct component output**: The compiler directly emits component definitions
  and canonical ABI lift/lower logic. No external tools or macros needed.
- **Primitive type correspondence**: Zena's numeric and scalar primitives match
  WIT types with identical bit widths and signedness. Narrow integers provide
  exact storage widths for WIT records and lists.
- **Resource management and ownership**: WIT models host and foreign resources
  through `own<T>` and `borrow<T>`. Because WebAssembly GC has no finalizers,
  Zena models non-memory resources using `resource class`, `Own<T>`, and
  `Borrow<T>`. Moving an owned resource transfers ownership, and dropping it
  invokes the host `resource.drop` canonical ABI operation deterministically.
- **Async streams and futures**: Zena's `Future<T>` and `Stream<T>` designs map
  directly to the Component Model canonical ABI built-ins, `future<T>` and
  `stream<T>`, including the stream rendezvous architecture, eliminating glue
  code.
