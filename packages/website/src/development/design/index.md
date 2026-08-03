---
title: 'Design'
description: "The reasoning behind Zena's more surprising design decisions — one page per decision."
---

Most of Zena is deliberately unsurprising. The parts that are not are shaped by
the compile target, and by a rule the language applies throughout: an allocation
should be visible in the source that causes it.

This section is one page per decision — what the language does, what the
alternatives were, and why this one won.

## Decisions

- [**Strings**](/development/design/strings/) — one `String` type that doesn't
  tell you whether it holds WTF-8 or WTF-16, and why slicing is free.
- [**Multi-value returns**](/development/design/multi-value-returns/) — returning
  several values instead of wrapping one in a heap-allocated `Result` or
  `Option`.
- [**Union types**](/development/design/unions/) — why `String | null` is fine,
  `i32 | null` is not, and you can't cast to a union.
- [**Classes and interfaces**](/development/design/classes-and-interfaces/) —
  vtables, fat pointers, and when the indirection is removed.
- [**Generics**](/development/design/generics/) — full monomorphization, what it
  costs in binary size, and variance.
- [**Literal types**](/development/design/literal-types/) — a type inhabited by
  one value, checked statically and not at runtime.
- [**Distinct types**](/development/design/distinct-types/) — a nominal alias
  that erases to its base type and costs nothing.
- [**Automatic boxing**](/development/design/automatic-boxing/) — why
  primitives are never boxed implicitly, and why `any` was removed.
- [**Regular expressions**](/development/design/regex/) — a regex engine written
  in Zena, with no `/pattern/` literal.

## The working documents

These pages are written for a reader. The decisions behind them were made in
[`docs/design/`](https://github.com/elematic/zena/tree/main/docs/design) in
the repository — around seventy documents written _while_ deciding, covering
much more ground than this section does.

They record the full argument, but they are a record rather than documentation:
some describe decisions that changed afterwards, and some describe things that
were never built. The [reference](/reference/) is what the language does today.
