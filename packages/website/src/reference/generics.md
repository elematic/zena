---
title: 'Generics'
description: 'Generic programming in Zena: type parameters, constraints, the scoped modifier, monomorphization, variance, and type argument inference.'
---

Generics allow functions, classes, interfaces, and type declarations to be
parameterized by types. In Zena, generics are **reified**: type arguments exist
at runtime and participate in exact `is` tests and `as` casts.

Generics compile via **full monomorphization**, specializing each instantiation
into distinct WebAssembly GC struct types. Consequently, primitive types like
`i32` and `f64` remain true unboxed machine scalars inside generic classes and
arrays, with zero implicit auto-boxing overhead.

## Type parameters

Type parameters are declared inside angle brackets (`<...>`) immediately
following the declaration name.

### Functions and arrows

Both arrow functions and top-level function declarations can declare type
parameters:

```zena
// Arrow function
let identity = <T>(x: T): T => x;

// Top-level function
function wrapInArray<T>(item: T): Array<T> {
  return [item];
}
```

### Classes and interfaces

Classes and interfaces declare type parameters that are in scope across all
instance fields, methods, and accessors:

```zena
class Box<T> {
  value: T;
  new(this.value);

  get(): T => this.value;
}

interface Container<T> {
  get(): T;
  size(): i32;
}
```

### Type declarations

All forms of non-class type declarations can be parameterized by types:

- **Structural type definitions**:
  ```zena
  type Pair<T> = (T, T);
  type Transform<T, U> = (input: T) => U;
  type Result<T, E> = (true, T) | (false, E);
  ```
- **Type aliases**:
  ```zena
  type StringMap<T> = Map<String, T>;
  ```
- **Distinct types (`distinct type`)**:
  ```zena
  distinct type Id<T> = i32;
  distinct type Box<T> = T;
  ```
- **Opaque types (`opaque type`)**:
  ```zena
  export opaque type Handle<T> = i32;
  ```

For details on how distinct and opaque types interact with generic casting and
inference, see [Type Declarations](/reference/type-declarations/#generic-type-definitions).

### Multiple type parameters

Declarations can introduce multiple comma-separated type parameters:

```zena
class Map<K, V> {
  // ...
}

let pair = <A, B>(first: A, second: B): (A, B) => (first, second);
```

### Method-level type parameters

Methods on classes and interfaces can introduce their own type parameters,
distinct from any class-level parameters:

```zena
interface Sequence<T> {
  map<U>(transform: (item: T) => U): Sequence<U>;
}
```

In the example above, `T` is the class-level type parameter, while `U` is
scoped exclusively to the `map` method.

## Constraints

Type parameter constraints enforce upper bounds on what type arguments can be
supplied, using the `extends` keyword.

### Declaring bounds

A bound `<T extends Bound>` restricts `T` to `Bound` or any of its subtypes:

```zena
interface Hashable {
  hash(): i32;
}

class HashSet<T extends Hashable> {
  add(item: T): void {
    let code = item.hash();
    // ...
  }
}
```

Constraints can be applied to functions, classes, interfaces, and type
definitions:

```zena
let printHash = <T extends Hashable>(item: T): void => {
  println(item.hash());
};
```

### Member access on constrained types

Within a generic body, the compiler allows direct access to all fields, methods,
and operators declared on the bound:

```zena
interface Identifiable {
  id(): String;
}

function logEntity<T extends Identifiable>(entity: T): void {
  // Direct member access permitted because T extends Identifiable
  println('Entity ID: ' + entity.id());
}
```

### Call-site verification

Supplying a type argument that does not satisfy the declared constraint produces
a compile-time error:

```zena
class Item {}

let set = new Set<Item>();
// Compile error: Type 'Item' does not satisfy constraint 'Hashable'
```

### F-bounded polymorphism

F-bounded polymorphism occurs when a type parameter appears within its own
bound, such as `<T extends Comparable<T>>`:

```zena
interface Comparable<T> {
  compareTo(other: T): i32;
}
```

::: note Planned Feature
Self-referential bounds (such as `<T extends Comparable<T>>`) are not yet
supported by the Zena compiler. Support for F-bounded polymorphism is planned for
a future release.
:::

## The scoped modifier

By default, generic type parameters accept only ordinary first-class types.
Values that have second-class storage limits—such as borrowed handles
(`Borrow<R>`) and scoped values (`Scoped<T>`)—cannot bind an unconstrained type
parameter `<T>` because the generic body might attempt to store or capture them.

To allow a generic function or class to accept second-class types, declare the
type parameter with the contextual `scoped` modifier:

```zena
let keep = <scoped T>(x: T): T => {
  return x;
};
```

The `scoped` modifier composes directly with bounds:

```zena
import { Disposable } from 'zena:core';

let processResource = <scoped T extends Disposable>(res: T): void => {
  // ...
};
```

Within a `scoped T` body, the compiler enforces second-class discipline: values
of type `T` must be consumed on every path and cannot be stored in heap
fields or captured by closures. Ordinary first-class values (`i32`, `String`,
classes) are also accepted by `scoped T` parameters.

For the full specification of second-class types, consumption rules, and
storage extents, see
[Ownership and Resources](/reference/ownership/#scoped-values-and-the-scoped-modifier).

## Monomorphization and reification

In WebAssembly GC, generic types in Zena are reified rather than erased.

### Reified runtime types

Because type arguments are preserved at runtime, `is` tests and `as` casts on
generic types evaluate accurately:

```zena
class Box<T> {
  value: T;
  new(this.value);
}

let b1: anyref = new Box<i32>(42);
let b2: anyref = new Box<String>('hello');

println(b1 is Box<i32>);    // true
println(b1 is Box<String>); // false
```

The runtime distinguishes `Box<i32>` from `Box<String>` as two distinct types.

### Monomorphization in WebAssembly GC

Zena implements reification through full monomorphization. For every distinct
type argument combination used in a program, the compiler generates:

1. A distinct WebAssembly GC struct type.
2. Specialized method bodies tailored to those field types.
3. A distinct vtable for interface dispatch.

For example, using both `Box<Cat>` and `Box<Dog>` generates two separate
WebAssembly struct declarations in the emitted binary.

### Unboxed primitive specialization

In languages that erase generics to a universal reference type (like Java or
TypeScript), storing a primitive like `i32` in a generic container requires
boxing it into a heap object.

In Zena, monomorphization eliminates boxing. A `Box<i32>` contains an unboxed
32-bit integer field directly in its WebAssembly struct, while `Box<f64>`
contains an unboxed 64-bit float field:

```zena
let intBox = new Box<i32>(100);     // Value 100 stored directly as Wasm i32
let floatBox = new Box<f64>(3.14);  // Value 3.14 stored directly as Wasm f64
```

Arrays also specialize without boxing: an `Array<i32>` compiles to an unboxed
Wasm GC array of raw 32-bit integers (`array i32`), maintaining compact memory
layout and high cache efficiency.

### Code size considerations

Monomorphization provides optimal execution speed and memory compactness at the
cost of binary size. Each distinct generic instantiation adds struct type
declarations and function bytecode to the compiled output. For instance,
`Box<Cat>` and `Box<Dog>` share identical pointer representations in WebAssembly
GC, yet full monomorphization currently compiles them into separate struct
types.

To mitigate code size in larger applications, Zena is considering a **hybrid
monomorphization scheme**:

- **Unboxed primitives**: Primitive types (`i32`, `f64`, `boolean`, etc.) will
  continue to receive dedicated specializations, preserving unboxed storage and
  avoiding heap boxing.
- **Shared reference specializations**: Reference type arguments can share a
  single compiled specialization, augmented by runtime type tags (such as a
  type descriptor or `TypeInfo` field).

This hybrid model allows reference instantiations to reuse code while ensuring
that reified runtime type checks (such as `val is Box<Cat>`) continue to evaluate
accurately.

## Variance

Variance describes how the subtyping relationship between type arguments affects
the subtyping relationship between the enclosing generic types.

### Invariance of generic classes

All generic classes in Zena are strictly **invariant**:

```zena
class Animal {}
class Dog extends Animal {}

// Compile error: 'Array<Dog>' is not assignable to 'Array<Animal>'
let pets: Array<Animal> = new Array<Dog>();
```

Even though `Dog` is a subtype of `Animal`, `Array<Dog>` is not a subtype of
`Array<Animal>`.

Invariance guarantees soundness for mutable containers. If `Array<Dog>` were
assignable to `Array<Animal>`, a program could insert a `Cat` into the
`Array<Animal>` reference, corrupting the underlying `Array<Dog>`:

```zena
class Cat extends Animal {}

function addCat(animals: Array<Animal>): void {
  // If covariance were allowed, storing Cat would corrupt Array<Dog>
  animals.push(new Cat());
}
```

By enforcing invariance, Zena prevents this error at compile time without
requiring expensive runtime write barriers or array store checks.

### Function type variance

Function types follow standard subtyping variance:

- **Contravariant in parameter types**: A function expecting a broader parameter
  type can be passed where a function expecting a narrower parameter type is
  required.
- **Covariant in return types**: A function returning a narrower type can be
  passed where a function returning a broader type is required.

```zena
// (Animal) => Dog is assignable to (Dog) => Animal:
let transform: (d: Dog) => Animal = (a: Animal): Dog => new Dog();
```

### Future declaration-site variance

To allow safe covariance on read-only interfaces without compromising safety,
Zena plans to introduce declaration-site variance annotations (`out` for
covariance and `in` for contravariance) on interfaces:

```zena
// Planned future syntax
interface ReadOnlySequence<out T> {
  get(index: i32): T;
}
```

Classes will remain invariant, while read-only interfaces will be able to
express covariance safely.

## Type argument inference

The compiler infers generic type arguments automatically when sufficient
context is available.

### Call-site inference

When calling a generic function or constructor, type arguments are deduced from
the argument values:

```zena
class Box<T> {
  value: T;
  new(this.value);
}

let b = new Box(42);            // Inferred as Box<i32>
let greeting = identity('hi');  // Inferred as identity<String>
```

### Multi-phase closure inference

When a generic function accepts both collection arguments and callback closures,
the compiler resolves type arguments across multiple phases:

```zena
let numbers = [1, 2, 3];

// Array.map is <T, U>(items: Array<T>, transform: (item: T) => U): Array<U>
let doubled = numbers.map((n) => n * 2);
```

1. The element type of `numbers` fixes `T = i32`.
2. The compiler uses `T = i32` as the contextual parameter type for the closure,
   inferring `n: i32` without an explicit annotation.
3. Checking the closure body `n * 2` synthesizes return type `i32`, fixing
   `U = i32`.
4. The return type of `map` is resolved as `Array<i32>`.

### When explicit type arguments are required

Type arguments must be supplied explicitly when:

1. **No arguments provide context**: The type parameter appears only in the
   return type:
   ```zena
   let config = parse<AppConfig>(jsonString);
   ```
2. **Empty collections without contextual target**: An empty array constructor
   has no elements to infer from:
   ```zena
   let list = new Array<String>();
   ```
3. **Ambiguous constraints**: Multiple possible types satisfy the call, or an
   explicit supertype is intended:
   ```zena
   let animals = new Array<Animal>();
   animals.push(new Dog());
   animals.push(new Cat());
   ```

For an in-depth explanation of bidirectional typing and inference algorithms,
see the [Inference](/reference/inference/#generic-type-argument-inference)
reference.
