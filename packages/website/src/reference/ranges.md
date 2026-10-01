---
title: 'Ranges'
description: 'Range syntax, BoundedRange, FromRange, ToRange, FullRange, and collection slicing in Zena.'
---

Zena provides first-class range expressions using the `..` operator. Rather than
being a specialized indexing syntax confined to brackets, range expressions
evaluate to first-class objects that can be stored in variables, passed to
functions, and inspected at runtime.

## First-class range objects

Range expressions construct instances of dedicated range classes defined in
`zena:core` and included in the standard prelude:

| Expression   | Type           | Mathematical Notation | Description                                                      |
| :----------- | :------------- | :-------------------- | :--------------------------------------------------------------- |
| `start..end` | `BoundedRange` | `[start, end)`        | Half-open interval from `start` (inclusive) to `end` (exclusive) |
| `start..`    | `FromRange`    | `[start, ∞)`          | Range from `start` through the end of the collection             |
| `..end`      | `ToRange`      | `[0, end)`            | Range from index 0 up to `end` (exclusive)                       |
| `..`         | `FullRange`    | `[0, length)`         | Full range spanning all elements                                 |

All four classes are part of the `Range` union type exported from `zena:core`:

```zena
type Range = BoundedRange | FromRange | ToRange | FullRange;
```

Because ranges are ordinary objects, they can be bound to variables, passed as
arguments, and inspected:

```zena
let r: BoundedRange = 10..20;
println(r.start); // 10
println(r.end);   // 20

let from = 5..;
println(from.start); // 5

let to = ..15;
println(to.end);     // 15

let all = ..; // FullRange
```

## Range syntax and precedence

The range operator `..` supports four syntactic forms:

```zena
let bounded = 1..10; // BoundedRange
let postfix = 5..;   // FromRange
let prefix = ..8;    // ToRange
let bare = ..;       // FullRange
```

### Operand types

Both the start and end operands of a range expression must evaluate to 32-bit
signed integers (`i32`):

```zena
let start = 2;
let end = 7;
let dynamicRange = start..end; // BoundedRange(2, 7)

// Non-i32 operands produce compile-time type errors:
let invalid = 'a'..'z';
//            ^^^^^^^^ error: Range start must be i32
```

::: note Planned support for generalized operand types

Currently, range expressions require `i32` operands. Zena plans to relax this
constraint to support generic range bounds `Range<T>`, drawing inspiration from
range models in languages such as Swift and Rust:

- **Discrete ordered types**: Types with a discrete ordering where every element
  has a well-defined immediate successor (often termed _enumerable_,
  _steppable_, or _discrete ordered_ types) can support range formation and
  sequential iteration. A key candidate is a future Unicode-safe string index
  type (similar to Swift's `String.Index`), enabling expressive string slicing
  like `str[start..end]`. An interface (such as `Steppable<T>` or
  `Enumerable<T>`) will allow ranges over any discrete type to be iterated
  automatically.
- **Continuous and non-iterable types**: Range expressions can also encompass
  types that have an ordering but no discrete successor, such as floating-point
  numbers (`f32`, `f64`). While continuous ranges cannot be iterated without an
  explicit stride, they enable interval operations, containment checks
  (`range.contains(val)`), clamping, and custom-stepped iteration (for example,
  progressing through `0.0..1.0` by steps of `0.1` or `1.0`).

:::

### Operator precedence

The `..` operator has lower precedence than arithmetic, bitwise, and comparison
operators. Expressions on either side of `..` evaluate before the range is
constructed, eliminating the need for grouping parentheses in dynamic
calculations:

```zena
let offset = 4;
let count = 6;

// Evaluates as (offset + 1)..(offset + count):
let window = offset + 1..offset + count; // BoundedRange(5, 10)
```

## Slicing with ranges

Ranges are primarily used for slicing collections via the index operator `[]`.

### Slicing arrays

The `Array<T>` interface and all concrete array classes (`FixedArray<T>`,
`ImmutableArray<T>`, and `GrowableArray<T>`) implement overloads of `operator
[]` for all four range types, returning a new array containing a shallow copy of
the selected elements:

```zena
let items = [10, 20, 30, 40, 50];

// BoundedRange: items from index 1 up to 4:
let slice1 = items[1..4]; // [20, 30, 40]

// FromRange: items from index 2 through the end:
let slice2 = items[2..];  // [30, 40, 50]

// ToRange: items from index 0 up to 3:
let slice3 = items[..3];  // [10, 20, 30]

// FullRange: shallow copy of the entire array:
let copy = items[..];     // [10, 20, 30, 40, 50]
```

Slicing an array with a range clamps bounds outside the array to its valid
length, and inverted ranges (where `start >= end`) produce an empty array.

### Current limitations and planned work

Ranges are not yet supported on every collection type:

- **Strings**: `String` currently supports slicing through method calls such as
  `str.slice(start, end)`. Slicing strings with range syntax (`str[a..b]`) is
  planned once a Unicode-safe design is finalized. Taking inspiration from
  Swift's `String.Index`, this will use dedicated index positions that navigate
  code-point or grapheme-cluster boundaries, ensuring string ranges cannot slice
  across invalid byte sequences.

## Range iteration

`BoundedRange` and `FromRange` implement `Iterable<i32>`. You can loop over a
range directly using `for-in` syntax:

```zena
for (let i in 0..10) {
  println(i);
}
```

A `for-in` loop over a range compiles to the same efficient counting loop as
`for (var i = 0; i < 10; i += 1)`. The range bounds are evaluated once before
the loop.

Ranges held in variables can be iterated the same way:

```zena
let r = 1..5;
for (let i in r) {
  println(i);
}
```

Because `BoundedRange` and `FromRange` implement `Iterable<i32>`, they also
support standard iterable methods such as `.filter()`, `.map()`, and `.fold()`:

```zena
let sum = (0..10).fold(0, (total, i) => total + i);
```
