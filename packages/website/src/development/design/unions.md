---
title: 'Union types'
description: 'Zena has union types, with restrictions that come from what Wasm can store and what can be told apart at runtime.'
---

Zena has union types, written `A | B`. They carry four jobs:

- **Nullability.** `String | null`, rather than a dedicated `String?` form.
  Nullable references are just unions, so everything below applies to them.
- **Classes and interfaces.** `Cat | Dog` or `Animal | null`, narrowed with `is`
  or a `null` check. This is the ordinary case and has no restrictions at all.
- **Functions.** `(() => i32) | ((x: i32) => i32)` — and a union of function
  types is directly callable, not something you have to narrow first.
- **Closed sets of literals.** `'aloof' | 'grumpy'`, `1 | 2 | 3`.

Scala 3 is the closest mainstream precedent. C#, Java, Kotlin, and Swift have
no general union types and cover the same ground with nullable types and sealed
hierarchies.

They are also restricted, in ways that surprise people arriving from TypeScript.
Every restriction comes from one of two questions: **can the union be stored?**
and **can its members be told apart at runtime?**

## Constraints

**Storage.** A union has to compile to a single Wasm type that can hold any
member. An `i32` is four bytes in a local; a reference is a GC pointer. There is
no Wasm type that is either, so `i32 | String` has nowhere to live. Every
language that offers it is boxing the primitive, which allocates.

**Distinguishability.** Narrowing an `A | B` means asking at runtime which one
you have. References carry their type and `ref.test` can ask. A raw `i32` carries
nothing — no bit pattern distinguishes the integer `0` from `null`. And two Zena
types that erase to the _same_ Wasm type can't be told apart either, even when
both are references.

Those two questions produce all of the rules below.

## Illegal unions

The following are rejected, each for one of those two reasons:

| Union                                  | Why                                        |
| -------------------------------------- | ------------------------------------------ |
| `i32 \| null`, `boolean \| String`     | Different Wasm types                       |
| `i32 \| f32`                           | Different Wasm types                       |
| `i32 \| u32`, `boolean \| i32`         | Indistinguishable                          |
| `String \| void`                       | `void` is not a type                       |
| `T \| null` where `T` is unbounded     | `T` could be instantiated with a primitive |
| `T \| Foo` where `T` is unbounded      | `T` could be instantiated with a primitive |
| Two distinct types over the same type  | Indistinguishable                          |
| Two extension classes on the same type | Indistinguishable                          |

`i32 | u32` is rejected for the second reason only. Both are `i32` in Wasm, so
storage is fine, but nothing at runtime says whether the bits are signed, so the
union could not be narrowed.

Distinct types and extension classes fail the same test from the other side:
`distinct type IdA = String` and `distinct type IdB = String` are separate types
to the checker and both plain `String` at runtime, so `IdA | IdB` could never be
narrowed.

## Allowed unions

Unions of reference types are unrestricted — classes, interfaces, arrays,
records, functions, and `null`, in any combination:

```zena
let a: String | null = null;
let b: Cat | Dog | null = null;

let r = if (b is Cat) b.meow() else 0; // narrowed by `is`
```

Primitives may union with primitives **of the same base type**, which is what
makes literal unions work — `true | false` is still one `i32` at runtime, and no
narrowing is needed to represent it:

```zena
let mood: 'aloof' | 'grumpy' = 'aloof';
let flag: true | false = true;
let small: 1 | 2 | 3 = 1;
```

A union of function types is callable without narrowing, provided every member
accepts the arguments given and their return types unify. Members may take
_fewer_ parameters than the call site passes, so the usual
[argument adaptation](/reference/functions/) applies:

```zena
let f: (() => i32) | ((x: i32) => i32) = () => 1;
let r = f(5); // fine: the zero-arg member ignores the argument
```

Unions of inline tuples are how `Map.get` and `Iterator.next` return an optional
value without allocating.
→ [Multi-value returns](/development/design/multi-value-returns/)

## Casts and type checks

Both reject a union target today, for different reasons.

### `is` cannot test a union

```zena
let b = c is C | null; // error: Test each type separately.
```

A type test compiles to one `ref.test`. Testing against a union would test each
member in turn, putting a loop inside what reads as a single operation. The same
problem was raised for Dart
([dart-lang/language#2711](https://github.com/dart-lang/language/issues/2711)).

Narrowing works one type at a time:

```zena
if (x is Cat) {
  x.meow();
}
if (x == null) {
  /* ... */
}
```

### `as` cannot fill a union

```zena
let d = c as C | null; // error: Cast to each type separately.
```

This is unimplemented rather than deliberate. Some unions need a cast to fill
them:
`1 | 2 | 3` accepts a literal at the assignment site and nothing else, so a
value computed at runtime can never enter it.

```zena
let a: 1 | 2 | 3 = 1; // fine
let n: i32 = readNumber();
let b: 1 | 2 | 3 = n; // error: expected 1 | 2 | 3, got i32
let c = n as 1 | 2 | 3; // error: Cast to each type separately
```

Casting should follow assignability, and for unions that should fall out of
widening and simplification rather than needing a rule of its own: `1 | 2 | 3`
widens to `i32`, so `n as 1 | 2 | 3` is legal for any `n: i32`.
→ [Literal types](/development/design/literal-types/)

→ Working documents:
[`types.md`](https://github.com/elematic/zena/blob/main/docs/design/types.md),
[`non-nullable-refs.md`](https://github.com/elematic/zena/blob/main/docs/design/non-nullable-refs.md)
