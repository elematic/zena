---
title: 'Multi-value returns'
description: 'Wasm functions can return several values at once. Zena uses that to express optional results without allocating.'
---

Wasm functions return multiple values natively — it is in the core spec, not a
proposal. Zena exposes that through the `inline` modifier on a tuple type:

```zena
let minMax = (a: i32, b: i32): inline (i32, i32) => if (a < b) (a, b) else (b, a);

let (lo, hi) = minMax(3, 1);
```

An `inline` tuple compiles to a Wasm multi-value return and exists only on the
stack. A tuple without the modifier is a boxed struct, so the keyword is the
difference between an allocation and none.

The trade is that return position is the only place the type may appear, and
destructuring is the only way to receive it. There is no value to store, pass,
or hold in a field:

```zena
let t = minMax(3, 1); // error: inline tuples only in return types
let f = (t: inline (i32, i32)) => 1; // error: same
class C {
  var t: inline (i32, i32); // error: same
}
```

Values returned this way are also easier for an engine to place in registers or
on the machine stack than fields of a heap object, so a multi-value return
doubles as an optimization hint.

## Motivation

Three cases in the standard library need to answer "here is a value, if there is
one" without allocating.

### Iteration

An iterator answers two questions per step: whether another element exists, and
what it is. Without multi-value returns there are two shapes:

- **Two members** — a `next()` that advances and returns a `boolean`, and a
  `current` that holds the element. Cheap, but `current` is only meaningful
  after `next()` returned `true`, and nothing in the type system says so.
- **One method returning an object** with the element and a completion flag, the
  way JavaScript's `{value, done}` works. Safe, and it allocates once per
  element.

### Map lookup

A map needs to report whether a key is present and hand back its value. The two
usual options are a `has()` followed by a `get()` — two lookups for one question
— or a `get()` returning `V | null`.

Zena cannot offer the second. [Union rules](/development/design/unions/) forbid
mixing a primitive with a reference, so the signature does not type-check for a
generic map:

```zena
get(key: K): V | null;
// error: Union types cannot contain unbounded type parameters mixed with
// reference types.
```

`Map<String, i32>` would need `i32 | null`, which is rejected for the same
reason. A nullable return is not available here.

### `Option<T>` and `Result<T, E>`

Both cases above are the same problem: representing "maybe a value" without
allocating a wrapper for it. As classes, `Option<T>` and `Result<T, E>` are heap
objects, and paying for one per lookup, per loop iteration, or per fallible call
is the cost the language is built to avoid.

The wrapper is also the only part that costs anything. The discriminant and the
payload are exactly what a two-value return carries, so the shape survives; only
the allocation goes.

## The shape Zena uses

This is the signature in `zena:iterator`:

```zena
export interface Iterator<T> {
  next(): inline (true, T) | inline (false, _);
}
```

Two things are doing work.

**`inline`** means the tuple exists only as Wasm stack values. It is not a heap
object that gets destructured; it never becomes one.

**A union of two literal-typed tuples** makes it safe. The return type is not "a
boolean and a T" — it is "either `(true, T)` or `(false, nothing)`".
Destructuring in a pattern position binds `item` only on the branch where the
first element is `true`:

```zena
while (let (true, item) = iterator.next()) {
  use(item);
}
```

`Map.get` has the same shape, alongside `has` for callers that only need the
question answered:

```zena
get(key: K): inline (true, V) | inline (false, _);
```

## `Option` still exists

`zena:option` defines `Option<T>` as `Some<T> | None`, and `Map` offers
`getOption` alongside `get`. The argument is not that sum types are wrong, but
which one is the default.

`Some<T>` is a class, so `getOption` allocates on every hit. That is the right
trade when the result is stored, passed around, or mapped over. It is the wrong
trade for a loop that runs once per element, so the primary API is the
allocation-free one. A [planned change](#planned-changes) removes the
distinction by making `Option<T>` an alias for the tuple.

## Errors

Every failure goes through [exceptions](/reference/exceptions/) today. There is
no `Result` type in the standard library.

The objection to `Result<T, E>` was cost. As a heap type it allocates on every
call that can fail, including the majority that do not, while Wasm GC exception
handling costs nothing on the path where nothing is thrown. Paying an allocation
per fallible call to describe a failure that usually does not happen is the
wrong default.

An inline `Result` removes that objection, and the intended split is then the
conventional one: `Result` for ordinary expected failures — a missing file,
input that does not parse — and exceptions for the genuinely exceptional. That
also fixes what exceptions cost in exchange: a failure that a caller is expected
to handle becomes visible in the signature.

## Planned changes

**`inline` becomes a modifier on the whole type.** Today it is repeated on every
member of the union. It should apply once, in front:

```zena
next(): inline (true, T) | (false, _);
```

**`??` accepts a `(boolean, _)` tuple.** Taking the value or a fallback
currently needs an `if` or a `match`. The operator should handle it directly:

```zena
let port = config.get('port') ?? 8080;
```

**`Option<T>` and `Result<T, E>` become aliases for the tuple.**

```zena
type Option<T> = inline (true, T) | (false, _);
type Result<T, E> = inline (true, T) | (false, E);
```

Both keep the name and the place in signatures that people expect, and neither
is a heap object. `getOption` would then cost the same as `get`, differing only
in how it reads at the call site. `Result` becomes affordable enough to use for
ordinary errors, which is what the [errors](#errors) section describes.

**`inline` may also apply to a named type**, as in `inline Option<T>`, giving a
user-defined type both a heap and a stack form — the direction Java's Project
Valhalla takes, and what a struct-of-arrays container needs, since there the
element type is inline while the container decides the layout.

`Option` and `Result` would deliberately not use it. Defining them inline puts
the whole ecosystem on the non-allocating form instead of making it a
per-signature choice, and avoids the trap of the shorter spelling being the one
that allocates.

→ Working documents:
[`multi-return-values.md`](https://github.com/elematic/zena/blob/main/docs/design/multi-return-values.md),
[`records-and-tuples.md`](https://github.com/elematic/zena/blob/main/docs/design/records-and-tuples.md)
