---
title: 'Types'
description: 'Type system architecture, taxonomy of types, nominal and structural typing, unions, distinct and opaque types, and type operators in Zena.'
---

Zena is a statically typed language targeting WebAssembly GC. The type system is
sound: types are checked ahead of time, non-nullable by default, and guaranteed
at runtime without implicit coercion or silent auto-boxing.

## Type system overview

Zena's type system is built around several core principles:

- **Static and sound**: All type checking, except casts, occurs at compile time.
  Types are runtime guarantees, not suggestions: a value typed `String` is
  always an initialized String instance, never `null` or a coerced number. Casts
  are checked, so there's no unchecked type escape hatch.
- **Every value and slot has a type**: Every expression produces a value with a
  concrete static type, and every storage slot—variables, function parameters,
  record fields, class fields, and return types—has a fixed type.
- **Reified types and generics**: Types are preserved at runtime, including
  generics. You can test exact generic types with `is` (such as `x is
Box<i32>`), and checked downcasts (`as`) are verified safely at runtime.
- **Nominal and structural typing**: Named types (`class`, `interface`, `mixin`,
  `enum`) are nominal, distinguished by declaration identity and inheritance.
  Anonymous types (`records`, `tuples`, `function` signatures) are structural,
  distinguished by their shape.
- **Non-nullable by default**: Reference types cannot hold `null` unless
  declared with a union type (`String | null` or the shorthand `String?`).
- **Separation of primitives and references**: Value primitives (`i32`, `f64`,
  `boolean`) and heap references (`String`, classes, arrays) have distinct
  representations in WebAssembly. Primitives are never implicitly boxed.

## Taxonomy of types

| Category             | Kinds                                  | Examples                                                                | Equivalence               |
| :------------------- | :------------------------------------- | :---------------------------------------------------------------------- | :------------------------ |
| **Primitives**       | Machine value types                    | `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `boolean`, `v128`, `u8`, `i8` | Exact                     |
| **Nominal types**    | Classes, interfaces, mixins, enums     | `Point`, `Drawable`, `Color`                                            | By declaration            |
| **Structural types** | Records and tuples                     | `{x: f64, y: f64}`, `(i32, String)`                                     | By shape                  |
| **Function types**   | Closures and signatures                | `(a: i32, b: i32) => i32`, `() => void`                                 | By signature              |
| **Generics**         | Type parameters                        | `T` in `Array<T>`, `Map<K, V>`                                          | By identity               |
| **Unions**           | Union and nullable types               | `Cat \| Dog`, `String \| null` (`String?`), `'read' \| 'write'`         | By member compatibility   |
| **Type aliases**     | Synonyms, distinct types, opaque types | `type Point = ...`, `distinct type ID = i32`, `opaque type Token = i32` | Depends on alias kind     |
| **Type operators**   | Intrinsic compiler operations          | `Awaited<T>`, `WithDefault<T>`                                          | Normalizes to result type |
| **Affine types**     | Resource ownership                     | `Own<T>`, `Borrow<T>`                                                   | By underlying resource    |
| **Special types**    | Top, bottom, absence                   | `anyref`, `never`, `void`, `null`                                       | Dedicated typing rules    |

## Type annotations

Explicit type annotations use a colon after an identifier across variables,
function parameters, return types, and class fields:

```zena
// Variables
let count: i32 = 42;

// Function parameters and return types
let add = (a: i32, b: i32): i32 => a + b;

// Class fields
class Point {
  x: f64;
  y: f64;
  new(this.x, this.y);
}
```

Annotations on local variables are optional when the compiler can infer the type
from the initializing expression:

```zena
let count = 42;        // Inferred as i32
let message = 'hello'; // Inferred as String
```

## Primitives, references, and boxing

Zena distinguishes between value primitives and heap-allocated references.

### Value primitives

Primitives map directly to WebAssembly machine types and live on the stack or
packed into arrays:

- **Integers**: `i32` (default integer), `i64`, `u32`, and `u64`.
- **Floating-point**: `f64` (default float) and `f32`.
- **Narrow integers**: `u8`, `u16`, `i8`, and `i16`. These serve as storage
  types in arrays and packed records; they promote to 32-bit integers during
  arithmetic operations.
- **Booleans**: `boolean` (`true` or `false`).
- **SIMD**: `v128` (128-bit vector).

Conversions between different primitive types must be explicit using `as`:

```zena
let a: i32 = 42;
let b: f64 = a as f64;
let c: u8 = (a & 0xFF) as u8;
```

### Reference types

References point to heap-allocated objects managed by the WebAssembly GC:

- `String` (UTF-8 string instances).
- Class instances and closures.
- Fixed and growable arrays (`FixedArray<T>`, `Array<T>`).
- Records and boxed tuples.

References are non-nullable by default.

### Explicit boxing with Box&lt;T&gt;

Because Zena avoids implicit boxing overhead, primitives cannot be stored
directly in reference slots or generic containers without explicit wrapping. Use
`Box<T>` from `zena:box`:

```zena
import { Box } from 'zena:box';

let boxed: Box<i32> = new Box<i32>(42);
let unboxed: i32 = boxed.value;
```

### Special types

- **`anyref`**: The top type for reference values. It can hold any class
  instance, array, record, string, closure, or `null`. It cannot hold unboxed
  primitives (`i32`, `f64`, `boolean`).
- **`void`**: Indicates that a function returns no value.
- **`never`**: The bottom type representing computations that never produce a
  value (such as expressions that throw or infinite loops). `never` is a subtype
  of every type.
- **`null`**: The singleton type for absent references.

```zena
let logMessage = (msg: String): void => {
  console.log(msg);
};

let fail = (msg: String): never => {
  throw new Error(msg);
};
```

## Nominal and structural types

Zena combines nominal typing for declared types with structural typing for
anonymous data structures.

### Nominal types

Classes, interfaces, mixins, and enums are **nominal**. Two classes with
identical fields and methods are distinct types:

```zena
class UserId {
  id: i32;
  new(this.id);
}

class OrderId {
  id: i32;
  new(this.id);
}

let user = new UserId(1);
// let order: OrderId = user; // Compile error: Type 'UserId' is not assignable to 'OrderId'
```

### Structural types

Records and tuples are **structural**. Compatibility is determined by field
names, types, and element order:

```zena
type Point = { x: f64, y: f64 };
type Coordinate = { x: f64, y: f64 };

let p: Point = { x: 10.0, y: 20.0 };
let c: Coordinate = p; // OK: identical shape
```

### Function types

Function types describe callable signatures with named parameters and a return
type:

```zena
type BinaryOp = (a: i32, b: i32) => i32;
type Callback = (result: String) => void;

let add: BinaryOp = (a, b) => a + b;
```

Function types are structural: any function whose parameter and return types
match the signature is assignable to it. Parameter names in signatures are
required to disambiguate function types from tuple types `(i32, i32)`.

## Generics

Functions, classes, interfaces, and type aliases can be parameterized over
types using angle brackets (`<T>`):

```zena
class Box<T> {
  value: T;
  new(this.value);
}

let wrap = <T>(value: T): Box<T> => new Box(value);
```

### Generic type inference

The compiler infers generic type arguments at call sites and constructors from
arguments:

```zena
let b1 = new Box(42);         // Inferred as Box<i32>
let b2 = wrap('hello');       // Inferred as Box<String>
```

When a type parameter cannot be determined from arguments, specify the type
arguments explicitly:

```zena
let list = new GrowableArray<String>();
```

### Constraints

Type parameters can be constrained with `extends`:

```zena
class Animal { name: String; new(this.name); }
class Dog extends Animal {}

class Shelter<T extends Animal> {
  residents: Array<T>;
  new(this.residents);
}
```

Constraints can reference preceding type parameters:

```zena
type Container<T extends Box<V>, V> = { item: T, inner: V };
```

An unconstrained type parameter `T` ranges over all types, including value
primitives (`i32`, `f64`) and heap references (`String`, classes).

### Variance

Variance defines how subtyping of type arguments affects subtyping of the
generic type:

- **Classes are invariant**: `Box<Dog>` is not a subtype of `Box<Animal>`. This
  prevents unsound reads and writes on mutable and immutable fields alike.
- **Interfaces support declaration-site variance**: Interfaces can declare type
  parameters with `out` (covariant, read-only positions) or `in` (contravariant,
  write-only positions):

```zena
interface Reader<out T> {
  read(): T;
}

interface Writer<in T> {
  write(value: T): void;
}
```

A `Reader<Dog>` is assignable to `Reader<Animal>`.

### Generics and unions

Because an unconstrained type parameter `T` may be instantiated with a
primitive type, writing `T | null` (or `T?`) is rejected for unbounded `T`:
primitives cannot be `null` in WebAssembly without boxing.

To use nullable generic values, either constrain `T` to reference types:

```zena
class RefHolder<T extends anyref> {
  value: T?; // OK: T is known to be a reference
  new(this.value);
}
```

Or wrap the generic value in an explicit box: `Box<T>?`.

### Generics and affine types

Affine types (`Own<T>`, `Borrow<T>`) represent non-GC resources with linear
ownership. When passed into generic containers or functions, move semantics and
single-ownership invariants are preserved.

::: note Planned feature: Type argument defaults
Zena does not currently support default type parameters (such as `<T = i32>`).
All type parameters must be inferred or explicitly specified. Default type
arguments are planned for a future release.
:::

## Unions and nullability

Union types represent values that can hold one of several types, written with
`|`.

### Nullable shorthand

A trailing `?` on a reference type is shorthand for a union with `null`:

```zena
let name: String? = null;     // Exactly equivalent to String | null
let status: String? = 'ready';
```

### Union storage and distinguishability

Members of a union type must share a common WebAssembly storage representation
and be runtime-distinguishable:

- **Reference unions**: Multiple reference types can form a union because they
  share a reference representation (`String | null`, `Cat | Dog`,
  `Array<i32> | null`).
- **Literal unions**: Literal types sharing the same underlying primitive base
  type can form a union (`'read' | 'write'`, `1 | 2 | 3`, `true | false`).
- **Mixed storage disallowed**: Primitives and references cannot be mixed in a
  union directly (`i32 | String`, `i32 | null` are compile errors). To include a
  primitive in a reference union, box it explicitly (`Box<i32>?`).
- **Different primitive bases disallowed**: Primitives of different base types
  cannot form a union directly (`i32 | f64` is a compile error).

```zena
type Mode = 'read' | 'write' | 'append'; // OK: literal union over String
let maybeNum: Box<i32>? = new Box(42);   // OK: boxed primitive in nullable union
```

### Control-flow type narrowing

Checking a union variable with `!= null` or the `is` operator automatically
narrows its type within conditional branches:

```zena
class Cat { meow(): String => 'meow'; }
class Dog { bark(): String => 'woof'; }

let speak = (pet: Cat | Dog): String => {
  if (pet is Cat) {
    return pet.meow(); // Narrowed to Cat
  } else {
    return pet.bark(); // Narrowed to Dog
  }
};
```

Type narrowing also applies to immutable paths, including `let` class fields,
record properties, and tuple elements.

## Type aliases, distinct types, and opaque types

Zena provides three ways to define named types from existing types:

### Type aliases

Type aliases create transparent synonyms using `type`:

```zena
type Point = { x: f64, y: f64 };
type Pair<T> = (T, T);
type Callback<T> = (value: T) => void;
```

### Distinct types

A `distinct type` creates a zero-cost nominal wrapper around a base type:

```zena
distinct type Meters = f64;
distinct type Seconds = f64;

let distance = 100.0 as Meters;
let time = 9.58 as Seconds;

// let invalid = distance + time; // Compile error: distinct types cannot be mixed
let speed = (distance as f64) / (time as f64); // OK with explicit casts
```

Casts between a distinct type and its base type are checked at compile time and
elided at runtime.

### Opaque types

An `opaque type` is a distinct type that **cannot be forged**. Casts _to_ an
opaque type are restricted strictly to the source file where the type is
declared:

```zena [tokens.zena]
export opaque type Token = i32;

export let createToken = (raw: i32): Token => {
  if (raw <= 0) { throw new Error('Invalid token'); }
  return raw as Token; // OK inside the declaring file
};

export let readToken = (t: Token): i32 => t as i32;
```

```zena [main.zena]
import { Token, createToken, readToken } from './tokens.zena';

let token = createToken(123); // OK
// let forged = 123 as Token; // Compile error: Cannot cast to opaque type 'Token'
let raw = token as i32;       // OK: casting out is permitted anywhere
```

## Type operators

Type operators are generic intrinsic type aliases evaluated directly by the
compiler.

### Awaited&lt;T&gt;

`Awaited<T>` computes the unwrapped value type produced by `await x` when `x: T`:

- `Future<U>` unwraps to `U`.
- Union types unwrap any `Future` arms while passing bare reference arms through.
- Non-future types pass through unchanged.

```zena
import { Awaited } from 'zena:async';

type T1 = Awaited<Future<i32>>;          // i32
type T2 = Awaited<Future<String> | null>; // String | null
type T3 = Awaited<i32>;                  // i32
```

`Awaited<T>` operates on a single level, matching Zena's async model where nested
futures (`Future<Future<T>>`) are real values.

### WithDefault&lt;T&gt; <span class="badge info">Planned</span>

`WithDefault<T>` evaluates to `T` for primitives and `T | null` for references.
It represents the honest default-initialized type of an unbounded generic type
parameter `T`.

## Next

- [Values and Variables](/guide/values-and-variables/) — `let`, `var`, mutability, and destructuring
- [Functions](/guide/functions/) — arrow functions, parameter defaults, and closures
- [Classes](/guide/classes/) — class declarations, constructors, mixins, and interfaces
- [Control Flow](/guide/control-flow/) — pattern matching, expressions, and narrowing
