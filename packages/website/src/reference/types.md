---
title: 'Type System Overview'
description: 'Type system architecture, WebAssembly GC foundations, soundness, nominal and structural typing, variance, special types, and built-in type operators in Zena.'
---

Zena features a sound, static type system targeting WebAssembly GC. Every
expression has a type verified at compile time, providing memory safety,
ahead-of-time optimizations, and early error detection without runtime type
guessing.

## Key features

- **Static and sound**: Types are verified at compile time. Variables and
  expressions are guaranteed to conform to their static types at runtime, with
  no unchecked escape hatches like `any`.
- **Strict (no implicit coercion)**: No silent conversions between numeric types
  (such as `i32` to `f64`) or between primitives and references.
- **Inferred (bidirectional)**: Combines local variable type inference with
  contextual typing for lambda parameters, array literals, and record
  expressions.
- **Nominal and structural**: Nominal declarations (classes, interfaces, enums)
  for explicit identity; structural types (records, tuples, function signatures)
  for shape-based composition.
- **True unboxed primitives**: Machine integers (`i32`, `i64`), floats (`f32`,
  `f64`), booleans, and SIMD vectors (`v128`) live directly in registers and
  stack slots without heap allocation.
- **No auto-boxing**: Primitive scalars are never implicitly wrapped in heap
  objects. Boxing is explicit via `Box<T>`.
- **Reified generics**: Generic classes and methods specialize to concrete
  WebAssembly GC types, preserving type parameters at runtime and enabling
  checks like `x is Box<i32>`.
- **Sound variance**: Function parameters are contravariant and return types are
  covariant. Mutable generic containers are invariant, preventing runtime
  mutation errors.

## Soundness

In Zena, soundness means that **an expression or variable never evaluates to a
value that violates its static type**. A variable typed as `String` is
guaranteed at runtime to hold a valid string reference—it can never hold `null`,
an integer, or an instance of another class.

Zena establishes and preserves soundness through several core design rules:

- **Complete field initialization**: Non-nullable class fields must be
  initialized before constructor completion (via field declarations, `this.`
  constructor parameters, or initializer lists). Code can never observe an
  uninitialized field holding an illegal `null` or zero value.
- **Invariant mutable containers**: Generic collections are invariant
  (`Array<Dog>` is not assignable to `Array<Animal>`). This eliminates the
  classic covariance loophole where an incompatible object (such as a `Cat`)
  could be stored into a specialized collection.
- **Strict assignability**: No implicit coercions exist between numeric types or
  between primitives and references. Representation transitions must always be
  explicit.
- **Exhaustive pattern matching**: `match` expressions over enums and
  [sealed classes](/reference/classes/sealed/) must handle all cases at compile
  time, guaranteeing control flow never falls through without producing a value.
- **Checked downcasts**: When polymorphism requires narrowing via `as`,
  reference casts compile directly to WebAssembly GC's `ref.cast` instruction.
  If the operand does not match the target type, the engine traps immediately,
  preventing invalid values from ever entering typed variables.

## Primitives, references, and the WebAssembly GC hierarchy

Zena's type system is shaped by the execution model of WebAssembly GC. The type
universe is divided into two distinct categories: unboxed value primitives and
garbage-collected reference types.

### Value primitives

Value primitives represent raw machine scalars stored directly on the
WebAssembly execution stack or in CPU registers. They are passed by value
without heap allocation:

- **Integers**: `i32` (32-bit signed), `i64` (64-bit signed), `u32` (32-bit
  unsigned), `u64` (64-bit unsigned).
- **Floating-point**: `f32` (32-bit float), `f64` (64-bit float).
- **Booleans**: `boolean` (`true` and `false`).
- **SIMD vectors**: `v128` (128-bit vector data).

#### Narrow integer storage types

Zena also provides narrow integer types: `u8`, `u16`, `i8`, and `i16`.
WebAssembly compute instructions operate exclusively on 32-bit and 64-bit
registers. Consequently, narrow integers function as **storage types** for
compact arrays (such as `array<u8>`), packed struct fields, and WebAssembly
Component Model (WIT) ABI boundaries.

During arithmetic operations, narrow integers promote to their 32-bit
counterparts (`u8`/`u16` to `u32`, `i8`/`i16` to `i32`). Storing a computed
result back into a narrow storage location requires an explicit `as` truncation
cast:

```zena
let byte: u8 = 100 as u8;
let widened = byte + 5;        // Inferred as u32
let stored: u8 = widened as u8; // Truncation required
```

### Reference types

Reference types represent heap-allocated objects managed by the WebAssembly GC
engine. References are passed by pointer and include:

- Class instances and interfaces
- Strings (`String` is a managed UTF-8 object)
- Arrays (`FixedArray<T>`, `Array<T>`, `ImmutableArray<T>`, `GrowableArray<T>`)
- Heap-allocated records and tuples
- Functions and closures

#### No implicit boxing

WebAssembly GC maintains a strict barrier between unboxed numeric registers and
managed heap references. Zena does not perform implicit auto-boxing: an `i32` is
never silently wrapped in an object.

To pass a primitive value where a reference is expected, wrap it explicitly
using the `Box<T>` class from `zena:core`:

```zena
import { Box } from 'zena:core';

let boxed = new Box<i32>(42);
let unboxed: i32 = boxed.value;
```

### The WebAssembly GC reference hierarchy

Because primitives are unboxed and never implicitly boxed, Zena has **no
universal top type** that encompasses both numbers and objects. Instead, the top
of the reference hierarchy maps directly to WebAssembly GC reference types:

- **`anyref`**: The top type for all garbage-collected reference types. Any
  class instance, string, array, record, tuple, or closure is assignable to
  `anyref`. Unboxed primitives cannot be assigned to `anyref`.
- **`externref`**: Represents an opaque reference to an external host or
  embedder object (such as a JavaScript object in a browser or a WASI host
  handle). `externref` values flow across FFI boundaries and convert to the
  internal GC hierarchy via WebAssembly conversion instructions.
- **`funcref`**: Raw WebAssembly function references. In Zena, closures and
  first-class functions are represented as GC structs containing both a code
  pointer and an environment context, placing them natively within `structref`
  and `anyref`.

## Nominal versus structural typing

Zena combines nominal typing for declared entities with structural typing for
data shapes.

### Nominal types

Nominal types establish identity through explicit declarations. Two nominal
types with identical fields or methods are distinct and not interchangeable:

- **Classes and Interfaces**: Subtyping must be explicitly declared via
  `extends` or `implements`. Closed sum-type hierarchies are declared with
  [sealed classes](/reference/classes/sealed/).
- **Enums**: An `enum Status { Active, Inactive }` is distinct from any other
  enum or its backing `i32`/`String` type.

```zena
class Point2D {
  x: f64;
  y: f64;
  new(this.x, this.y);
}

class Vector2D {
  x: f64;
  y: f64;
  new(this.x, this.y);
}

let p = new Point2D(1.0, 2.0);
// Point2D and Vector2D are nominal: they cannot be substituted for each other
```

### Structural types

Structural types establish equivalence based entirely on shape, properties, or
signature:

- **Records**: A record `{x: f64, y: f64}` is compatible with any record
  containing the same properties with assignable types.
- **Tuples**: A tuple `(i32, String)` is equivalent to any other tuple with
  matching element types in the same positional order.
- **Function types**: A function `(x: i32) => boolean` matches any closure or
  top-level function with a compatible signature.

```zena
type PointRecord = {x: f64, y: f64};
let origin: PointRecord = {x: 0.0, y: 0.0}; // Matches by structure
```

For defining structural type aliases, generic aliases, and function types, see
[Type Declarations](/reference/type-declarations/).

### Runtime distinguishability and erased types

An important distinction in Zena is between **runtime-distinguishable types**
and **erased types**:

- **Erased distinct types and extension classes**: Types declared with `distinct
type` (such as `distinct type UserId = String`) or extension classes share the
  exact runtime representation of their underlying type. They provide
  compile-time safety with zero memory or performance overhead. See
  [Type Declarations](/reference/type-declarations/) for syntax and details.
- **Domain invariant safety**: Because distinct types erase at runtime, an
  explicit `as` cast (such as `rawString as UserId`) bypasses compile-time
  checks without triggering a VM-level validation check. If an invariant must be
  validated at runtime (e.g., ensuring a string is a valid UUID), an unvalidated
  cast can violate domain expectations. See how `opaque type` enforces file-level
  boundaries in [Type Declarations](/reference/type-declarations/#opaque-types-with-opaque-type).
- **Runtime-distinguishable wrapper classes**: When runtime verification is
  essential, use a nominal class (`class UserId { id: String; new(this.id); }`).
  A nominal class allocates a distinct WebAssembly GC struct with a unique
  runtime type identifier (vtable). The VM verifies the type during `is` checks
  and `as` casts.

Runtime distinguishability is also critical for union types: for a union `A | B`
to be safely narrowed at runtime using `is` or `match`, each branch must possess a
distinct runtime representation. See
[Unions](/reference/unions/#restrictions-on-indistinguishable-types) for details
on restrictions such as multiple extension classes.

## Assignability, subtyping, and variance

Assignability determines whether a value of source type `S` can be safely used
where a target type `T` is expected (`let target: T = source`).

### Subtyping rules

Subtyping in Zena follows strict rules:

1. **Nominal subtyping**: A class `C` is assignable to its superclasses and
   implemented interfaces.
2. **Union inclusion**: A type `T` is assignable to any union containing `T`
   (e.g., `String` is assignable to `String | null`). See
   [Unions](/reference/unions/).
3. **Record structural subtyping**:
   - **Width subtyping**: A record type is assignable to a target record type if
     it contains all required properties of the target. Extra properties in the
     source are permitted.
   - **Depth subtyping**: The corresponding property types in the source must be
     assignable to the property types in the target.
4. **Strict numeric typing**: There is no implicit widening or coercion between
   numeric types. An `i32` cannot be assigned to an `i64` or `f64` without an
   explicit `as` cast or conversion method.

### Variance

Variance describes how subtyping between complex types relates to subtyping
between their component types.

#### Function variance

Function types in Zena are **contravariant in parameter types** and **covariant
in return types**:

- A function that accepts a broader parameter type can be used where a function
  accepting a narrower parameter type is expected.
- A function that returns a narrower type can be used where a function returning
  a broader type is expected.

```zena
class Animal {}
class Dog extends Animal {}

// (Animal) => Dog is assignable to (Dog) => Animal:
let transform: (d: Dog) => Animal = (a: Animal): Dog => new Dog();
```

Zena also supports argument adaptation: a function that expects fewer parameters
can satisfy a callback signature that provides more parameters.

#### Invariance of mutable generic containers

Generic nominal types in Zena are **invariant**: `Container<Dog>` is not
assignable to `Container<Animal>`, even though `Dog` is a subtype of `Animal`.

If `Array<Dog>` were assignable to `Array<Animal>`, code holding the
`Array<Animal>` reference could store a `Cat` into it, corrupting the
`Array<Dog>` without violating static rules. Invariance prevents this category
of errors at compile time.

While invariance guarantees soundness, it can be strict and cumbersome when
working with read-only data. Planned future enhancements to Zena include
declaration-site `in`/`out` variance annotations (such as `interface
Sequence<out T>`) to enable safe covariance on producer types without runtime
checks.

### Bidirectional typing

Zena employs bidirectional typing, combining bottom-up type synthesis with
top-down type analysis (contextual typing):

- **Synthesis**: The compiler infers the type of an expression from its
  components (e.g., `1 + 2` synthesizes `i32`).
- **Contextual typing**: The expected type from the enclosing context guides the
  type checking of inner expressions. This allows array literals (`[] as
Array<String>`) and lambda parameters (`items.map((x) => x.length)`) to omit
  redundant type annotations.

For complete details on type inference and contextual typing, see the
[Inference](/reference/inference/) reference.

## Special types

Zena includes several special types designed for boundary conditions, absence,
and control flow.

### `anyref`

`anyref` is the top type for all garbage-collected reference types. It can hold
any object, array, string, record, tuple, closure, or `null`. Operations cannot
be performed on `anyref` directly; it must be narrowed using `is` checks or
downcast using `as`:

```zena
let handle: anyref = 'hello';

if (handle is String) {
  println(handle.length);
}
```

### `never`

`never` is the bottom type of the entire type system. It has no runtime values.
Expressions that cannot complete normally—such as functions that unconditionally
throw an error or enter an infinite loop—have the return type `never`:

```zena
function panic(message: String): never {
  throw new Error(message);
}
```

Because `never` is a subtype of every type, a call to a `never`-returning
function can appear in any expression context.

### `void`

`void` represents the absence of a meaningful return value from a function. A
function with a `void` return type finishes execution without returning a value:

```zena
function logMessage(msg: String): void {
  println(msg);
}
```

### The wildcard type `_`

The wildcard type `_` (Hole type) represents an omitted, unpopulated, or
irrelevant slot. It is primarily used in inline tuple unions to express
lightweight variants without heap allocation:

```zena
// Multi-value return without allocating an object:
type Lookup<T> = inline (true, T) | (false, _);

let found = (): Lookup<i32> => (true, 42);
let missing = (): Lookup<i32> => (false, _);
```

When destructuring inline tuples, an omitted position yields the `_` type,
indicating that the slot carries no value in that branch.

### `null` and nullability

Types in Zena are non-nullable by default. A variable of type `String` cannot
hold `null`. Nullability is expressed explicitly using union types:

```zena
let name: String = 'Alice';          // Cannot be null
let nickname: String | null = null;  // Nullable
let title: String? = null;           // Shorthand for String | null
```

See [Unions](/reference/unions/) for full coverage of union normalization, the
`?` shorthand, reference constraints, and null narrowing.

### Record field presence

In Zena records, optional fields (`{url: String, timeout?: i32}`) use **presence
semantics** rather than nullability:

- An optional field `timeout?: i32` is not typed as `i32 | null`. An `i32` is an
  unboxed
  primitive and cannot be `null`.
- Instead, presence is tracked via an internal 64-bit bitmask in the record
  struct. The field is either **present** (carrying a valid value) or **absent**
  (unpopulated).

Absence is inspected and resolved using pattern matching, nullish coalescing, or
destructuring with default values:

```zena
type RequestOptions = {url: String, timeout?: i32};

let opts: RequestOptions = {url: '/api'};

// Destructuring with a default value:
let {url, timeout = 5000} = opts;

// Coalescing on presence:
let effectiveTimeout = opts.timeout ?? 5000;
```

## Built-in type operators

Type operators are generic intrinsic type aliases evaluated directly by the
compiler during type analysis.

### `Awaited<T>`

`Awaited<T>` models the type produced by awaiting an expression of type `T`:

- If `T` is `Future<U>`, it evaluates to `U`.
- If `T` is a union, it distributes over each branch (`Future<String> | null`
  becomes `String | null`).
- Non-future types pass through unchanged (`Awaited<i32>` is `i32`).

`Awaited<T>` operates on a single level, matching Zena's async model where
nested futures (`Future<Future<T>>`) are distinct values rather than
automatically flattened thenables.

```zena
import { Awaited } from 'zena:async';

type T1 = Awaited<Future<i32>>;          // i32
type T2 = Awaited<Future<String> | null>; // String | null
type T3 = Awaited<i32>;                  // i32
```

### `WithDefault<T>`

`WithDefault<T>` evaluates to `T` for primitive types and `T | null` for
reference types.
It represents the honest default-initialized type of an unconstrained generic
type parameter `T`, allowing data structures to represent uninitialized slots
without boxing.

## Ownership and resource types

WebAssembly GC automatically reclaims memory, but external operating system and
host resources require deterministic cleanup. Zena provides an ownership type
system to manage resources such as WASI file descriptors, Component Model
handles, and linear memory allocations.

- **Resource classes**: Classes declared with the `resource` modifier (`resource
class File`) carry a mandatory disposal contract (`[Disposable.dispose](this:
Own<this>): void`).
- **`Own<T>`**: Represents unique, linear ownership of a resource. Owned
  resources must be consumed or disposed of exactly once and cannot be copied
  implicitly.
- **`Borrow<T>`**: Represents a temporary, non-escaping reference to an owned
  resource, ensuring the resource remains valid for the duration of the borrow.

For an in-depth explanation of ownership rules, linear consumption, handles,
and second-class borrows, see the [Ownership and Resources](/reference/ownership/)
reference.

## Comparison with other languages

Different languages design their type systems around different runtime
environments and goals:

- **TypeScript**: Built as a gradual, optional type system designed to layer
  over existing JavaScript. Because TypeScript must interoperate with untyped or
  dynamically typed JS libraries and enable progressive adoption across massive
  codebases, it embraces pragmatic flexibility, including the `any` type,
  bivariant method parameters, and type assertions.
- **Dart**: Prioritizes natural object-oriented ergonomics alongside runtime
  safety. To allow intuitive class and collection hierarchies, Dart adopts
  covariant generics by default (such as `List<Dog>` being assignable to
  `List<Animal>`), pairing this flexibility with runtime checks so that invalid
  operations are caught safely before memory or types can be corrupted.
- **Zena**: Designed from the ground up for WebAssembly GC, targeting
  ahead-of-time compilation and strict execution guarantees without a dynamic
  runtime heritage. Because Zena does not need to accommodate untyped legacy
  code, its type system is fully static and sound: there is no gradual `any`
  type, mutable generic containers are invariant at compile time, and all
  downcasts are verified directly by the WebAssembly GC engine.

## Future type system directions

Zena's type system continues to evolve. Planned and candidate features include:

- **Declaration-site variance (`in`/`out`)**: Allowing interfaces and immutable
  types to declare variance (e.g. `interface Sequence<out T>`), providing sound
  covariance for producer types without compromising safety.
- **Units of measure**: Statically checked dimensioned types (such as `10<px>`,
  `5<ms>`, or `100<km/h>`) that allow dimensional analysis and unit safety at
  compile time with zero runtime performance overhead.
- **Value types and value classes**: Migration of records and tuples to
  value-type semantics, and potential support for user-defined `value class`
  declarations that pass by value.
- **Advanced type operators**: Exploration of TypeScript-inspired types
  including mapped types, conditional types, and intersection types for
  expressive record transformations.
