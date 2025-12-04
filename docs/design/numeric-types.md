# Numeric Types Design

## Overview

This document details the design of numeric types in Zena, specifically addressing the mapping between Zena types and WebAssembly (WASM) types, and the handling of signed vs. unsigned operations.

## The WASM Model

WebAssembly provides four basic value types for numbers: `i32`, `i64`, `f32`, and `f64`.

Crucially, the integer types (`i32`, `i64`) are **sign-agnostic** regarding their bit pattern storage. An `i32` is simply a bag of 32 bits. It does not inherently know if it represents a signed 2's complement integer or an unsigned integer.

Instead, the **instructions** determine the interpretation:

- **Sign-Agnostic Instructions**: Work correctly for both signed and unsigned representations (due to 2's complement properties).
  - `i32.add`, `i32.sub`, `i32.mul`
  - `i32.and`, `i32.or`, `i32.xor`, `i32.shl` (shift left)
- **Signed Instructions**: Treat the bits as a signed 2's complement number.
  - `i32.div_s` (division)
  - `i32.rem_s` (remainder)
  - `i32.lt_s`, `i32.le_s`, `i32.gt_s`, `i32.ge_s` (comparisons)
  - `i32.shr_s` (arithmetic shift right - preserves sign bit)
- **Unsigned Instructions**: Treat the bits as an unsigned integer.
  - `i32.div_u`
  - `i32.rem_u`
  - `i32.lt_u`, `i32.le_u`, `i32.gt_u`, `i32.ge_u`
  - `i32.shr_u` (logical shift right - fills with zeros)

## Zena's Current Implementation

Currently, Zena exposes a single integer type: **`i32`**.

- **Storage**: Maps to WASM `i32`.
- **Semantics**: **Signed**.
- **Operators**:
  - `+`, `-`, `*`: Map to sign-agnostic WASM instructions.
  - `/`, `%`: Map to **signed** WASM instructions (`i32.div_s`, `i32.rem_s`).
  - `<`, `<=`, `>`, `>=`: Map to **signed** WASM instructions (`i32.lt_s`, etc.).

This means that in Zena, `i32` behaves like `int` in C/Java or `number` (bitwise) in JavaScript.

### Implications

1.  **No Unsigned Arithmetic**: Users currently cannot perform unsigned division or comparison. For example, comparing two large 32-bit addresses (where the high bit is 1) will result in incorrect behavior if treated as signed (negative numbers).
2.  **Bitwise Operations**: `&`, `|`, `^` work as expected for bits.
3.  **Shifting**: Zena does not yet expose shift operators, but when it does, we must choose between arithmetic (`>>`) and logical (`>>>`) shifts if we stick to a single type.

## Proposal: Explicit Unsigned Types

To fully support the capabilities of WASM and provide a robust system for systems programming, Zena should introduce explicit unsigned types.

### New Types

- **`u32`**: 32-bit unsigned integer.
  - Storage: WASM `i32`.
  - Semantics: Unsigned.

### Operator Overloading / Selection

The compiler will select the appropriate WASM instruction based on the type of the operands.

| Operator | `i32` (Signed) | `u32` (Unsigned) |
| :------- | :------------- | :--------------- |
| `+`      | `i32.add`      | `i32.add`        |
| `-`      | `i32.sub`      | `i32.sub`        |
| `*`      | `i32.mul`      | `i32.mul`        |
| `/`      | `i32.div_s`    | `i32.div_u`      |
| `%`      | `i32.rem_s`    | `i32.rem_u`      |
| `<`      | `i32.lt_s`     | `i32.lt_u`       |
| `>>`     | `i32.shr_s`    | `i32.shr_u`      |

### Type Rules

1.  **No Implicit Mixing**: Operations between `i32` and `u32` should be forbidden to prevent accidental signed/unsigned mismatch bugs.
2.  **Casting**: Explicit casting (`as`) allows converting between `i32` and `u32`. This is a no-op at runtime (just reinterprets the bits).

```zena
let s: i32 = -1;
let u: u32 = s as u32; // u is 4294967295
```

### Literals

- Default integer literals are `i32`.
- Suffix `u` for unsigned literals? (e.g., `123u`).

## Alternative: Unsigned Operators (Not Recommended)

An alternative is to keep only `i32` but add specific operators for unsigned math, similar to JavaScript's `>>>`.

- `>>>` (Unsigned Right Shift)
- `+/` (Unsigned Divide? - Syntax invention required)
- `+<` (Unsigned Less Than? - Syntax invention required)

**Verdict**: This leads to awkward syntax and doesn't solve the semantic issue of what the data _represents_. Explicit types are cleaner.

## Future Work: 64-bit Integers

When `i64` support is added, the same pattern will apply:

- `i64`: Signed 64-bit integer.
- `u64`: Unsigned 64-bit integer.

## Summary

Zena treats `i32` as signed by default. To support unsigned operations, we will introduce `u32` in the type system, which maps to the same WASM storage but selects unsigned instructions during code generation.
