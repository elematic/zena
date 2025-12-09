# Arithmetic Conversions Design

This document outlines the proposed rules for mixed-type arithmetic operations in Zena.

## Principles

1.  **Widening**: When mixing types of different sizes or precision, operands are promoted to the larger/more precise type.
2.  **Signedness**: Mixing signed and unsigned integers requires care.
3.  **Division**: The `/` operator on integers produces a float (matching JavaScript/TypeScript), while a separate operator or function is used for integer division.

## Proposed Conversion Table

The following table defines the result type for binary operations (`+`, `-`, `*`, `/`, `%`) between different numeric types.

| Left  | Right | Result | Notes                                                                           |
| :---- | :---- | :----- | :------------------------------------------------------------------------------ |
| `i32` | `i32` | `i32`  | Standard integer arithmetic. **Exception**: `/` returns `f32` (Default Float).  |
| `i32` | `i64` | `i64`  | `i32` promoted to `i64`. **Exception**: `/` returns `f64`.                      |
| `i32` | `f32` | `f32`  | `i32` promoted to `f32`.                                                        |
| `i32` | `f64` | `f64`  | `i32` promoted to `f64`.                                                        |
| `i32` | `u32` | `i32`  | `u32` reinterpreted as `i32`. (User suggestion). Alternative: Promote to `i64`. |
| `u32` | `i64` | `i64`  | `u32` promoted to `i64`. **Exception**: `/` returns `f64`.                      |
| `u32` | `f32` | `f32`  | `u32` promoted to `f32`.                                                        |
| `u32` | `f64` | `f64`  | `u32` promoted to `f64`.                                                        |
| `i64` | `i64` | `i64`  | Standard integer arithmetic. **Exception**: `/` returns `f64`.                  |
| `i64` | `f32` | `f64`  | `i64` promoted to `f64` to preserve precision.                                  |
| `i64` | `f64` | `f64`  | `i64` promoted to `f64` (Precision loss possible).                              |
| `f32` | `f32` | `f32`  | Standard float arithmetic.                                                      |
| `f32` | `f64` | `f64`  | `f32` promoted to `f64`.                                                        |
| `f64` | `f64` | `f64`  | Standard float arithmetic.                                                      |

_Note: The table is symmetric. `Right` | `Left` produces the same result._

## Division Semantics

**Decision**: The `/` operator always performs floating-point division.

**Integer / Integer**:

- `i32 / i32` -> `f32` (Default Float)
- `i64 / i64` -> `f64` (Promoted to preserve precision)
- `i32 / i64` -> `f64`

**Mixed Integer / Float**:

- `i32 / f32` -> `f32`
- `i32 / f64` -> `f64`
- `i64 / f32` -> `f64` (Promoted to preserve precision)
- `i64 / f64` -> `f64`

**Float / Float**:

- `f32 / f32` -> `f32`
- `f32 / f64` -> `f64`
- `f64 / f64` -> `f64`

This avoids the "surprise" of `1 / 2 == 0` and aligns with JavaScript/TypeScript behavior. The return type is the default floating point type (currently `f32`), but may change to `f64` in the future.

**Integer Division**:
To perform integer division (truncating), use the `div` function from `zena:math`.

- `div(10, 3)` -> `3`
- `div(-10, 3)` -> `-3`

This function maps directly to the WASM `i32.div_s` or `i64.div_s` instructions, ensuring zero overhead.

## Unsigned Mixing

`i32` op `u32`:

- If result is `i32`: `u32` is treated as `i32` (bit pattern).
  - `(-1 as i32) + (1 as u32)` -> `-1 + 1 = 0`.
  - `(1 as i32) + (0xFFFFFFFF as u32)` -> `1 + -1 = 0`.
- If result is `i64`: Both promoted to `i64`. Safe.
  - `(-1 as i32)` -> `-1L`.
  - `(0xFFFFFFFF as u32)` -> `4294967295L`.
  - Result: `4294967294L`.

The `i64` promotion is safer but might be unexpected if the user wants wrapping 32-bit arithmetic.

## Implementation Plan

1.  Update `checkBinaryExpression` to implement the lookup table.
2.  Update `generateBinaryExpression` to emit conversion instructions.
3.  Decide on Division.
