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

| Expression   | Type                    | Mathematical Notation | Description                                                      |
| :----------- | :---------------------- | :-------------------- | :--------------------------------------------------------------- |
| `start..end` | `BoundedRange<T = i32>` | `[start, end)`        | Half-open interval from `start` (inclusive) to `end` (exclusive) |
| `start..`    | `FromRange<T = i32>`    | `[start, ∞)`          | Range from `start` through the end of the collection             |
| `..end`      | `ToRange<T = i32>`      | `[0, end)`            | Range from 0 up to `end` (exclusive)                             |
| `..`         | `FullRange<T = i32>`    | `[0, length)`         | Full range spanning all elements                                 |

All four classes are variants of the sealed `Range<T = i32>` class exported from `zena:core`:

```zena
sealed class Range<T = i32> {
  case BoundedRange, FromRange, ToRange, FullRange

  abstract bounds(length: T): inline (T, T);
  abstract contains(value: T): boolean;
}
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

The start and end operands of a range expression may be any numeric type
(`i32`, `i64`, `f32`, `f64`, etc.) or `StringIndex`:

```zena
let start = 2;
let end = 7;
let dynamicRange = start..end; // BoundedRange<i32>(2, 7)

// Float ranges and mixed integer/float literal bounds:
let unit = 0.0..1.0;           // BoundedRange<f64>
let pct = 0..100.0;            // BoundedRange<f64>
let f32Range: BoundedRange<f32> = 0.0..1.0;

// Membership checks on any range:
println(unit.contains(0.5));   // true
println(unit.contains(1.0));   // false

// Non-numeric operands (other than StringIndex) produce compile-time type errors:
let invalid = 'a'..10;
//            ^^^^^^^ error: Range start must be a numeric type or StringIndex
```

Only `i32` ranges (`BoundedRange<i32>` and `FromRange<i32>`) are iterable in
`for-in` loops; float ranges represent continuous intervals and are not
iterable.

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
