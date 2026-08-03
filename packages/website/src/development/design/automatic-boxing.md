---
title: 'Automatic boxing'
description: 'Zena does not box primitives implicitly. Boxing is an allocation, and allocations are written in the source.'
---

Zena has no automatic boxing. A primitive is never silently wrapped in a heap
object to make it fit somewhere a reference is expected. Where a boxed primitive
is needed, `Box<T>` is written explicitly:

```zena
let x: Box<i32> = new Box(42); // the allocation is visible
```

## Why it is rejected

Boxing is an allocation. Zena's rule is that an allocation is visible in the
source that causes it, and automatic boxing breaks that rule in the worst place:
inside loops, per element, in code that reads as if it does nothing.

The rule is not an isolated preference. Three other decisions exist to enforce
it:

- [Unions](/development/design/unions/) cannot mix primitives with references,
  so `i32 | String` is rejected rather than boxed.
- [Generics](/development/design/generics/) are reified, so `Array<i32>` holds
  unboxed `i32` rather than boxed elements.
- [Multi-value returns](/development/design/multi-value-returns/) exist so that
  an optional result does not need an allocated `Option`.

Automatic boxing would have undone all three.

## No `any`

Zena has no `any` type. A type that accepts every value has to do one of two
things, and neither is acceptable:

- **Waive type checking**, as TypeScript's `any` does. Zena's type system is
  sound: a program that type-checks has correct types at runtime. A construct
  that opts out of checking gives that up wherever it appears.
- **Box primitives** so they fit alongside references. That is the allocation
  this page exists to rule out.

A checked `any` — one that requires an explicit cast before use — solves the
first problem and not the second. It still allocates on `let x: any = 42`, with
nothing in the line to say so.

## `anyref` is a different type

`anyref` is the top type for _reference_ types. Every class, array, and closure
is an `anyref`; no primitive is.

```zena
let r: anyref = someObject; // no allocation — already a reference
let n: anyref = 42; // error
```

It is the version of "could be anything" that costs nothing, and it covers the
case an `any` type would be reached for.

→ Working documents:
[`primitive-boxing-semantic-types.md`](https://github.com/elematic/zena/blob/main/docs/design/primitive-boxing-semantic-types.md),
[`polymorphic-references.md`](https://github.com/elematic/zena/blob/main/docs/design/polymorphic-references.md)
