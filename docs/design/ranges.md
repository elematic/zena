# Range Syntax & Types Design

## Overview

Zena aims to support array slicing (`arr[1..5]`) and potentially range iteration (`for i in 1..5`). This document explores the design space for Range syntax, types, and semantics, comparing other languages and proposing a path for Zena.

## Design Goals

1.  **Zero-Overhead Abstraction**: Iterating a range `1..100` should compile to a simple loop, not an object allocation if possible.
2.  **Expressivity**: Support common slicing operations (start, end, full, strides).
3.  **Type Safety**: Static typing should guide the usage of ranges (e.g., distinguishing open vs closed ranges if necessary).

## Comparative Analysis of Other Languages

### Python

- **Syntax**: `start:stop:step` (e.g., `arr[1:10:2]`).
- **Semantics**: Creates a `slice` object at runtime.
- **Handling**: Dynamic. Indices can be negative (relative to end). Strides supported natively in `__getitem__`.
- **Pros**: Extremely concise and flexible.
- **Cons**: Dynamic dispatch, runtime overhead if not optimized. `slice` object is heap-allocated.

### Rust

- **Syntax**:
  - `start..end` (`Range`, exclusive)
  - `start..=end` (`RangeInclusive`)
  - `start..` (`RangeFrom`)
  - `..end` (`RangeTo`)
  - `..` (`RangeFull`)
- **Semantics**: Distinct structs for each variant.
- **Handling**: Implementation (traits) must handle each type separately or use a unifying trait (`RangeBounds`).
- **Pros**: Zero-overhead (structs on stack), very precise typing.
- **Cons**: Combinatorial explosion of types. APIs must accept generics to handle all range types.

### Swift

- **Syntax**: `start..<end` (half-open), `start...end` (closed).
- **Semantics**: Strongly typed structs.
- **Strides**: No syntax. Uses function `stride(from:to:by:)`.

### Kotlin

- **Syntax**: `1..10` (inclusive), `1 until 10` (exclusive). `1..10 step 2`.
- **Semantics**: `IntRange`, `IntProgression`.

## Proposal for Zena

Given Zena's preference for specialized types (to avoid nullable `i32` or sentinels) and performance, we should follow the **Rust model** of distinct types, but simplify where possible.

### 1. Syntax

We propose using `..` for the range operator.

| Syntax  | Meaning                  | Type                            |
| :------ | :----------------------- | :------------------------------ |
| `a..b`  | Half-open `[a, b)`       | `Range`                         |
| `a..=b` | Closed `[a, b]`          | `InclusiveRange` (Future/Maybe) |
| `a..`   | Start to Infinity/Length | `RangeFrom`                     |
| `..b`   | Zero to `b`              | `RangeTo`                       |
| `..`    | Full Range               | `RangeFull`                     |

**Decision**:

- Start with **exclusive** upper bound (`a..b` means `i >= a && i < b`) as the default. This is standard for 0-indexed systems (arrays).
- Defer `InclusiveRange` (`..=`) as it complicates loop logic (overflow handling) and is less common for slicing.

### 2. Strides

**Decision**: Do **not** support stride syntax (like `1..10:2`).

- **Reasoning**: It adds parser complexity and makes the `Range` types significantly larger or slower.
- **Alternative**: Use method chaining. `(0..10).step(2)` or `range(0, 10, 2)`.

### 3. Types

To support `arr[..5]`, `arr[1..]`, and `arr[1..5]` efficiently without boxing `i32` into `Option<i32>`, we should define distinct structs in the standard library.

```zena
// stdlib/range.zena

// a..b
struct Range {
  start: i32;
  end: i32;
}

// a..
struct RangeFrom {
  start: i32;
}

// ..b
struct RangeTo {
  end: i32;
}

// ..
struct RangeFull {}
```

### 4. Integration with Index Operator

Collection classes will overload `operator []` to accept these types.

```zena
class FixedArray<T> {
  // arr[1..5]
  operator [](r: Range): FixedArray<T> {
    return this.slice(r.start, r.end);
  }

  // arr[1..]
  operator [](r: RangeFrom): FixedArray<T> {
    return this.slice(r.start, this.length);
  }

  // arr[..5]
  operator [](r: RangeTo): FixedArray<T> {
    return this.slice(0, r.end);
  }

  // arr[..] - Clone
  operator [](r: RangeFull): FixedArray<T> {
    return this.slice(0, this.length);
  }
}
```

### 5. Implementation in Compiler

1.  **Parser**: Update `Parser` to handle `DOT_DOT` token.
    - Binary expression `expr .. expr` -> `Range`.
    - Prefix expression `.. expr` -> `RangeTo`.
    - Suffix expression `expr ..` -> `RangeFrom` (Need to handle carefully in parser to avoid ambiguity).
    - Standalone `..` -> `RangeFull`.
2.  **Desugaring**: The parser or checker should treat these literals as constructor calls to the corresponding stdlib structs.
    - `1..5` -> `new Range(1, 5)`.

### 6. Slice Semantics (Refresher)

- **Return Semantics**: Slicing returns a **Copy** (new allocation).
- **Negative Indices**:
  - The `Range` structs hold raw `i32`.
  - The `slice()` implementation on `FixedArray` _could_ choose to support negative start/end if desired, or throw.
  - **Recommendation**: Keep `Range` fields simple. If `start` is negative, `slice` throws or clamps?
    - Zena `slice(start, end)` should probably behave like JS `.slice()` (allow negatives) for ergonomics, or be strict. Given the "Performance" goal, strict (0-based) is faster, but JS compatibility suggests flexible.
    - _Refinement_: `Range` literals should just capture the values. `FixedArray.slice` logic decides how to interpret them.

### 7. Iteration

Ranges are naturally iterable.

```zena
// Future Iterator Interface
interface Iterable<T> {
  iterator(): Iterator<T>;
}

extension class Range implements Iterable<i32> {
  // ...
}
```

This enables:

```zena
for (var i in 0..10) { ... }
```

## Summary Recommendation

1.  Standardize on `..` for exclusive ranges.
2.  Implement distinct types: `Range`, `RangeFrom`, `RangeTo`, `RangeFull` to avoid nullable fields.
3.  No special syntax for strides; use methods.
4.  Overload `operator []` in collections to handle these types.
