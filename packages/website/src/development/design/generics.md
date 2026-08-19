---
title: 'Generics'
description: 'Reified generics: type arguments survive to runtime. Monomorphization is how that is done today, not the decision itself.'
---

Type parameters can appear on classes, interfaces, functions, type aliases, and
on individual methods.

```zena
class Box<T> { ... }
interface Array<T> { ... }
let id = <T>(x: T): T => x;
type Pair<T> = (T, T);
distinct type Handle<T> = Box<T>;

class C {
  m<T>(x: T): T { ... } // the method has its own parameter
}
```

## Generics are reified

Generics are **reified**: a type argument is part of the type at runtime, not
erased at the boundary. `Box<i32>` and `Box<String>` are different types to the
program and different types to Wasm, and `b is Box<i32>` can be answered.

We choose reification over erasure because erasure would box. Wasm's common
representation is a reference, so an erased `Box<T>` holds an `anyref` and every
`i32` reaching it needs a `Box` allocation — a per-value cost with nothing in
the source to show it.
→ [Automatic boxing](/development/design/automatic-boxing/)

The implementation below is likely to change.

## Generics are monomorphized

Reification is currently implemented by full monomorphization: every distinct
type argument gets its own copy of the class, its methods, and its vtable.

The cost is binary size. For a `Box<T>` with a `get()` method, each
instantiation adds two Wasm struct types and roughly 200 bytes:

| Program                   | Struct types | Size   |
| ------------------------- | ------------ | ------ |
| baseline, no `Box`        | 63           | 12,834 |
| `Box<Cat>`                | 65           | 13,040 |
| `Box<Cat>` and `Box<Dog>` | 67           | 13,238 |
| `Box<i32>`                | 65           | 13,032 |
| `Box<i32>` and `Box<f64>` | 67           | 13,229 |

`Box<Cat>` and `Box<Dog>` have identical Wasm layouts and are still emitted
twice. Collapsing instantiations with identical layouts is not implemented.

Beyond that, partial monomorphization: specialize primitives, share a single
copy across reference type arguments, and carry the real type argument in a
`TypeInfo` field so `is` still answers correctly. Swift does roughly this with
witness tables, C# does it automatically, Rust leaves it to the developer via
`dyn Trait`. If Zena adopts it, it is a compiler flag rather than a new default.

Sharing affects unions. `Box<Cat> | Box<Dog>` is legal today
only because monomorphization gives them distinct struct types. Share one struct
type and they become indistinguishable, and the
[union rules](/development/design/unions/) reject them.

## Generic methods

A method may introduce a type parameter the class does not have, such as
`map<U>` on a `Array<T>`.

```zena
interface Array<T> {
  map<U>(f: (item: T) => U): Array<U>;
}
```

::: warning The method type parameter is erased
This is a bug. Erasing `U` forces a box on every element, and `map`'s result
type mentions `U`, so an erased `map` returns a `Array` of boxed values whose
Wasm type does not match the `Array<i32>` the caller holds. The mismatch
propagates to every use of the result.

The fix is to reify the method's type parameter like any other, which means
reserving vtable slots per reached (member, type-argument) pair rather than per
member. Zena is a whole-program compiler, so the set of pairs is enumerable.
:::

## Variance

::: warning Variance is not implemented
Zena does not support variance annotations. `in` and `out` do not parse, and the
failure is silent: an `interface R<out T> { ... }` declaration is **discarded
whole**, so `R` becomes an unknown type and every use of it is accepted without
complaint — including calls to methods it never declared.

```zena
interface R<out T> {
  get(): T;
}
let f = (r: R<Nonexistent>) => r.neverDeclared(); // no diagnostic
```

Without the modifier the same interface is correctly invariant.
:::

The intended design is declaration-site variance with `in` and `out`, allowed on
interfaces only. Classes stay invariant, which keeps the memory model simple and
avoids the covariant-array hole that Java and Dart both have.

Use-site variance — Java's `? extends T` — is not planned. The intended pattern
is a split interface: a covariant read-only view and an invariant mutable one
that extends it.

## Constraints

`T extends Bound` parses, including the F-bounded form `T extends Cmp<T>`.

::: warning Constraints are not enforced
A constrained type parameter cannot be used as its bound. Member access through
`T` is unimplemented, for class and interface bounds alike:

```zena
let f = <T extends Base>(x: T) => x.m();
// error: Property access not supported on type 'T'.
```

The constraint is checked at the call site, but the body cannot rely on it.
:::

## Casts and type checks

`b is Box<i32>` and `b as Box<i32>` are both accepted, and monomorphization
makes them exact: each instantiation is a distinct Wasm struct type, so a single
`ref.test` answers with no type-argument comparison at runtime.

Sharing changes that. With reference instantiations behind one struct type, `is`
becomes a `TypeInfo` comparison whose cost scales with the depth of the type
arguments — `Box<Map<String, Array<i32>>>` is a tree walk rather than one
instruction. Cheap type tests are an argument for keeping full monomorphization
the default even after sharing exists.

## Soundness

Three ways to make generic subtyping sound:

1. **Declaration-site variance.** `in` and `out`, checked statically, nothing to
   verify at runtime. The plan, and currently absent.
2. **Runtime checks.** Dart's approach: permit covariance and check on every
   write through a covariant reference. Sound, but it puts a check on a hot path
   to catch what static rules could reject outright.
3. **Lean on Wasm.** `ref.cast` traps on failure, so some of this could ride on
   checks the engine already performs. That covers class identity, not type
   arguments — monomorphization has already folded those into the struct type.

Declaration-site variance costs nothing at runtime, so it is the plan. It is
not implemented.

→ Working documents:
[`generics.md`](https://github.com/elematic/zena/blob/main/docs/design/generics.md),
[`generic-specialization-strategy.md`](https://github.com/elematic/zena/blob/main/docs/design/generic-specialization-strategy.md)
