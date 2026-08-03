---
title: 'Distinct types'
description: 'A nominal alias that erases to its base type. Free at runtime, checked statically, not sound.'
---

A `distinct type` gives an existing type a new name. The checker treats the two
as unrelated.

```zena
distinct type UserId = String;
distinct type OrderId = String;
```

Both are `String` at runtime. Neither is interchangeable with `String` or with
the other, so passing an order id where a user id is expected is a compile
error.

## Distinct types are opaque in both directions

Assignment fails both ways. A cast is required to cross:

```zena
let s: String = 'u_1';

let a: UserId = s; // error: expected UserId, got String
let b = s as UserId; // ok
let c: String = b; // error: expected String, got UserId
```

Blocking the outward direction matters too. If a `UserId` were assignable to
`String`, every function taking a `String` would accept it and the type would
constrain nothing.

Numeric distinct types keep their operators:

```zena
distinct type Meters = f64;
let m = 1.0 as Meters;
let n = m + m; // ok
```

## Distinct types are not sound

The type is erased, so nothing is checked at runtime, and the cast that produces
a value is unchecked. Two distinct types over the same base convert freely:

```zena
let u = 'u_1' as UserId;
let o = u as OrderId; // accepted, no check
```

The base type is sound. The brand is not. A value typed `UserId` is definitely a
`String`. It is not definitely a user id.

A checked brand would need a runtime tag on every value, costing a field or an
allocation. Distinct types cost nothing, and provide the same two things as
[literal types](/development/design/literal-types/): documentation the compiler
checks, and static flow. Both are bypassed only by an explicit cast, which is
visible in the source.

## `is` tests the base type

`x is UserId` is accepted today. It should not be. The check compiles against
the erased base type, so it asks whether the value is a `String`, not whether it
is a user id:

```zena
let s: String = 'q';
let b = s is UserId; // accepted, and true
```

Answering the question properly means validating the value — deciding whether
some particular string really is a user id — and that is a predicate the type
system does not have and cannot infer. Rejecting `is` on distinct types is the
likely fix. [Literal types](/development/design/literal-types/#is-tests-the-base-type)
have the same problem.

The check is usually easy to write; the compiler just cannot derive it. A
user-defined type predicate would let the developer supply it:

```zena
let isUserId = (s: String): s is UserId => s.startsWith('u_');

let f = (s: String) => {
  if (isUserId(s)) {
    // s is a UserId here
  }
};
```

The function returns a `boolean` at runtime and narrows its argument on the true
branch. That also supplies the missing piece for
[unions of distinct types](#erasure-restricts-unions-and-matching): the developer
provides the discriminator the compiler cannot infer. The same predicate makes
a value from outside the program safe to brand.

::: warning
This syntax currently parses and is silently discarded. A declaration whose
return type is written `x is T` is dropped whole — the names are never resolved
and the body is never checked, so
`let f = (q: String): s is Nonexistent => undefinedThing;` reports nothing. That
is a parser bug, not partial support.
:::

## Erasure restricts unions and matching

Two distinct types over one base are identical at runtime and cannot be told
apart:

- `UserId | OrderId` is rejected, because the union could not be narrowed.
- A `match` cannot have separate cases for both. The first would always match.

The union restriction is a restriction for now, not a permanent rule. Some
distinct types are distinguishable in practice — string keys with different
prefixes, for instance — and a developer who can supply that test could
reasonably be allowed the union. Zena has no way to express such a test today.
→ [Union types](/development/design/unions/)

Extension classes are erased the same way and carry the same restrictions.

→ Working document:
[`types.md`](https://github.com/elematic/zena/blob/main/docs/design/types.md)
