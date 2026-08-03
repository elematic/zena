---
title: 'Literal types'
description: 'A type inhabited by a single value. Checked statically, not at runtime.'
---

A literal type is inhabited by one value: `1`, `'aloof'`, `true`. In a union
they describe a closed set.

```zena
let mood: 'aloof' | 'grumpy' = 'aloof';
let flag: true | false = true;
```

The compiler checks the value against the type wherever it can see it, including
across a call:

```zena
let a: 1 = 2; // error: expected 1, got i32
let f = (x: 1 | 2) => x;
f(3); // error: expected 1 | 2, got i32
```

## Literal types are not sound

There is no runtime check. A literal type is its base type at runtime — `1` is
an `i32`, `'aloof'` is a `String` — and a cast to it is unchecked:

```zena
let n: i32 = 99;
let a = n as 1; // accepted. `a` has type 1 and value 99.
let b: 1 | 2 = a; // accepted.
```

The base type is sound. The literal refinement is not. A value typed `1` is
definitely an `i32`. It is not definitely `1`.

Enforcing the refinement would mean a value check at every assignment and every
call, to catch a cast the author wrote deliberately. That cost is not worth
paying. [Distinct types](/development/design/distinct-types/) make the same
choice.

Literal types provide two things:

- **Documentation the compiler checks.** A parameter typed `'get' | 'post'`
  states what it accepts, and callers are held to it.
- **Static flow.** Values reaching that parameter by ordinary assignment are
  checked. Only an explicit cast avoids the check.

## `is` tests the base type

`n is 1` is accepted today. It should not be. The check compiles against the
erased base type, so it asks whether the value is an `i32`, which it always is:

```zena
let n: i32 = 5;
let b = n is 1; // accepted, and evaluates to true
```

Answering it properly means comparing the value, not testing a type. That is a
different operation — `n == 1` — and the type system has no way to turn one into
the other. Rejecting `is` on literal types is the likely fix.
[Distinct types](/development/design/distinct-types/#is-tests-the-base-type) have
the same problem.

A user-defined type predicate would let the developer write the comparison and
have it narrow:

```zena
let isSmall = (n: i32): n is 1 | 2 | 3 => n >= 1 && n <= 3;

let f = (n: i32) => {
  if (isSmall(n)) {
    // n is 1 | 2 | 3 here
  }
};
```

This is also the sound way to get an outside value into a literal union, which
`as` cannot currently do at all. The predicate performs the check; the cast
would only assert it.
→ [Union types](/development/design/unions/#as-cannot-fill-a-union)

The syntax is
[not implemented, and currently mis-parsed](/development/design/distinct-types/#is-tests-the-base-type).

## Values from outside the program are unchecked

A literal type is enforced only along paths the compiler can see. Parsed input,
host calls, and bytes read from disk have no such path, so validating them is
the program's job.

Today they cannot reach a literal union at all. `as` rejects a union target, so
there is no way to move an `i32` into `1 | 2 | 3`.
→ [Union types](/development/design/unions/#as-cannot-fill-a-union)

::: warning Implementation is partial
Literal types work in annotations, unions, parameters, and `match`, and are
checked in the places shown above. Coverage beyond that is thin. The compiler
also carries an open `TODO` for numeric literal types in union base-type
resolution: `i32 | 1` is rejected with a message about mixing primitives with
references, which is not the actual reason.
:::

→ Working document:
[`types.md`](https://github.com/elematic/zena/blob/main/docs/design/types.md)
