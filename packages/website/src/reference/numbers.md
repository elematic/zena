---
title: 'Numbers'
description: 'Integer, narrow integer, and floating-point numeric types in Zena.'
---

Zena provides a complete set of primitive numeric types covering signed integers,
unsigned integers, narrow storage integers, and IEEE 754 floating-point numbers.
All numeric types in Zena are unboxed WebAssembly primitives that execute with zero
allocation overhead.

## Integers

Zena supports two standard integer widths, each available in signed and unsigned
variants:

| Type  | Bit width | Signedness | Min value                           | Max value                              | WebAssembly type |
| :---- | :-------- | :--------- | :---------------------------------- | :------------------------------------- | :--------------- |
| `i32` | 32-bit    | Signed     | `-2_147_483_648` (-2³¹)             | `2_147_483_647` (2³¹ - 1)              | `i32`            |
| `u32` | 32-bit    | Unsigned   | `0`                                 | `4_294_967_295` (2³² - 1)              | `i32`            |
| `i64` | 64-bit    | Signed     | `-9_223_372_036_854_775_808` (-2⁶³) | `9_223_372_036_854_775_807` (2⁶³ - 1)  | `i64`            |
| `u64` | 64-bit    | Unsigned   | `0`                                 | `18_446_744_073_709_551_615` (2⁶⁴ - 1) | `i64`            |

`i32` is the default integer type in Zena. Integer literals without a decimal point
or contextual type annotation evaluate to `i32`:

```zena
let count = 42; // Inferred as i32
let bigCount: i64 = 5_000_000_000; // Typed as i64 via contextual annotation
```

Both `i32` and `u32` map directly to the WebAssembly `i32` value type, and `i64` and
`u64` map directly to WebAssembly `i64`. The difference between signed and unsigned
types is semantic: operations that depend on sign (such as division, modulo, shifts,
and comparisons) emit sign-appropriate WebAssembly instructions.

## Narrow integers

Narrow integers represent exact sub-word storage widths:

| Type  | Bit width | Signedness | Min value | Max value | Storage size |
| :---- | :-------- | :--------- | :-------- | :-------- | :----------- |
| `i8`  | 8-bit     | Signed     | `-128`    | `127`     | 1 byte       |
| `u8`  | 8-bit     | Unsigned   | `0`       | `255`     | 1 byte       |
| `i16` | 16-bit    | Signed     | `-32_768` | `32_767`  | 2 bytes      |
| `u16` | 16-bit    | Unsigned   | `0`       | `65_535`  | 2 bytes      |

### Motivation and WebAssembly architecture

In WebAssembly GC, the type system distinguishes between _value types_ (the types
allowed for local variables, global variables, function parameters, and return
values) and _storage types_ (the types allowed inside heap-allocated arrays and
struct fields).

WebAssembly GC only provides 32-bit and 64-bit value types (`i32`, `i64`, `f32`, `f64`).
There is no WebAssembly instruction or operand-stack type for an 8-bit or 16-bit
integer. Consequently, a local variable, parameter, or return value cannot physically
be `i8` or `u8` in WebAssembly—it must be an `i32`.

However, applications frequently need to work with byte buffers, binary network payloads,
string encodings, and WebAssembly Component Model (WIT) interfaces. Storing bytes in
32-bit words would quadruple memory usage. WebAssembly GC solves this by supporting
packed storage types in arrays (`(array i8)` and `(array i16)`).

To support packed array storage and typed Component Model boundaries without sacrificing
type safety, Zena introduces first-class narrow integer types (`i8`, `u8`, `i16`, `u16`).

### Dual representation model

Narrow integers follow a dual representation model: they are **stored packed** and
**computed wide**:

| Location                                       | Representation           | WebAssembly implementation                  |
| :--------------------------------------------- | :----------------------- | :------------------------------------------ |
| Array elements (`ByteArray`, `FixedArray<u8>`) | Packed (8-bit or 16-bit) | Native `(array i8)` / `(array i16)` storage |
| Locals, globals, parameters, return values     | Unpacked (32-bit)        | WebAssembly `i32` register                  |
| Class, record, and tuple fields                | Unpacked (32-bit)        | WebAssembly `i32` field storage             |

- **Reading from packed storage**: Reading an element from a packed array (e.g. `b[i]`)
  emits `array.get_u` for unsigned types (`u8`, `u16`) to zero-extend the byte into an
  `i32`, or `array.get_s` for signed types (`i8`, `i16`) to sign-extend it. The unpacked
  value always carries the exact, mathematically correct integer in a 32-bit register.
- **Writing to packed storage**: Writing into a packed array (`b[i] = val`) emits
  `array.set`, which automatically truncates the 32-bit register value to the low 8 or
  16 bits.
- **Canonical normalized form**: Because unpacked values are held in canonical normalized
  form (zero-extended for unsigned, sign-extended for signed), downstream operations,
  comparisons, and function calls execute directly as standard 32-bit WebAssembly
  instructions without runtime bitmasking overhead.

### Narrow promotion rule

Narrow integers are **storage types, not arithmetic types**. In any arithmetic
operation (`+`, `-`, `*`, `/`, `%`), narrow operands automatically promote to their
32-bit counterpart before computation:

- `i8` and `i16` promote to `i32`
- `u8` and `u16` promote to `u32`

Narrow types never survive an arithmetic operation:

```zena
let a: u8 = 200;
let b: u8 = 100;
let sum = a + b; // Inferred as u32, evaluates to 300
```

Because `a + b` produces a `u32`, storing the result back into a narrow storage location
requires an explicit `as` cast:

```zena
var byte: u8 = 10;
byte = (byte + 1) as u8; // Explicit truncation and normalization
```

This prevents unexpected truncation bugs (e.g. `200 + 100` silently wrapping to `44`)
while ensuring that byte arithmetic is efficient and easy to reason about.

## Floats

Zena supports IEEE 754 floating-point numbers in single and double precision:

| Type  | Precision        | Bit width | WebAssembly type |
| :---- | :--------------- | :-------- | :--------------- |
| `f32` | Single precision | 32-bit    | `f32`            |
| `f64` | Double precision | 64-bit    | `f64`            |

`f64` is the default floating-point type in Zena for literals without context:

```zena
let pi = 3.141592653589793; // Inferred as f64
let ratio: f32 = 3.14159; // Typed as f32 via annotation
let scaled = 1.5 as f32; // Or via a cast
```

### Rationale for the default widths

Integer literals default to the narrow width (`i32`) and float literals to the
wide one (`f64`). The two families differ in what the narrow choice risks.

An `f32` holds about 7 decimal digits and exact integers only up to
16,777,216, which ordinary code passes without trying: a total in cents stops
being exact at $167,772.16, and accumulating `0.01` a million times gives
9865.22 instead of 10000. An `f64` holds about 16 digits and every integer up
to 2⁵³. The extra precision costs 4 bytes per stored value and half as many
lanes per SIMD vector, while scalar addition and multiplication run at the same
rate as `f32` on the CPUs a WebAssembly engine targets.

An `i32` reaches 2,147,483,647, which already covers the indices, lengths,
counts and loop variables that unannotated integers hold — `Array.length` is
an `i32`. Code handling values beyond that range, such as file sizes or
nanosecond timestamps, is specific enough to name `i64` at the declaration.
Defaulting to `i64` would double the storage of every integer field and array
element for a range most programs never reach, and 64-bit division is slower
than 32-bit.

Both defaults yield to context, so `let x: f32 = 1.5;` and `let n: i64 = 1;`
need no cast. Full rationale:
[types.md](https://github.com/elematic/zena/blob/main/docs/design/types.md#default-literal-types).

### Division behavior

The division operator `/` always performs floating-point division in Zena, even when
both operands are integers:

```zena
let x: i32 = 7;
let y: i32 = 2;
let q = x / y; // 3.5 (f64)
```

Dividing two integer operands evaluates to `f64` to prevent integer truncation bugs
(such as `1 / 2 == 0`). Dividing `f32` operands produces `f32`:

```zena
let a: f32 = 7.0;
let b: f32 = 2.0;
let result = a / b; // 3.5 (f32)
```

For truncating integer division, import `div` from `zena:math`, which lowers directly
to native WebAssembly integer division instructions (`i32.div_s`, `i64.div_s`,
`i32.div_u`, `i64.div_u`):

```zena
import {div} from 'zena:math';

let quotient = div(7, 2); // 3 (i32)
```

## Number literals

Zena supports decimal and hexadecimal number literals:

```zena
let decimal = 42;
let hex = 0xff; // 255
let floatVal = 3.14;
```

### Contextual typing

Number literals in Zena infer their type contextually from surrounding code:

1. **Variable annotations**: When assigned to an explicitly typed variable, the literal
   adopts that type:
   ```zena
   let a: i64 = 100; // Literal 100 is typed as i64
   let b: u8 = 255;  // Literal 255 is typed as u8
   let c: f64 = 1.0; // Literal 1.0 is typed as f64
   ```
2. **Binary expressions**: In binary operations, an untyped literal adopts the type of
   the other operand:
   ```zena
   let count: i64 = 100;
   let next = count + 1; // 1 is inferred as i64; next is i64
   ```
3. **Function calls**: An untyped literal argument adapts to the parameter type of the
   function or method being invoked:
   ```zena
   function delay(ms: u64): void { ... }
   delay(5000); // 5000 is inferred as u64
   ```

### Compile-time range checking

When a literal takes its type contextually, the compiler verifies at compile time that
the literal's value fits within the target type's representable range:

```zena
let validByte: u8 = 255; // OK
let overflowByte: u8 = 256;
//                     ^^^ error: Integer literal 256 is out of range for type 'u8'
```

Negative literals are measured as a whole with their unary negation:

```zena
let minI8: i8 = -128; // OK: fits within i8 range (-128..127)
let badI8: i8 = -129; // Error: out of range
//              ^^^^ error: Integer literal -129 is out of range for type 'i8'.
```

Range checking applies to all narrow types (`i8`, `u8`, `i16`, `u16`) and unsigned
types (`u32`, `u64`).

## Unsigned semantics

Unsigned integer types (`u32`, `u64`) treat bit patterns as non-negative magnitudes.
Operations that depend on signedness behave differently on unsigned types:

- **Comparison**: Relational operators (`<`, `<=`, `>`, `>=`) perform unsigned comparisons.
  For example, `0xffff_ffff as u32 > 0 as u32` is `true` (4,294,967,295 > 0),
  whereas for `i32`, `-1 > 0` is `false`.
- **Modulo**: `%` computes the unsigned remainder using `i32.rem_u` / `i64.rem_u`.
- **Right shift**: Shifting an unsigned integer with `>>` performs a logical zero-filling
  shift, identical to `>>>`.

### Strict separation of signed and unsigned types

Zena enforces a strict separation between signed and unsigned types. Mixing signed and
unsigned operands in binary operations or comparisons without an explicit cast is a
compile-time error:

```zena
let s: i32 = 10;
let u: u32 = 20;

let sum = s + u;
//          ^^^ error: Type mismatch: cannot apply operator '+' to i32 and u32
```

Zena deliberately rejects implicit mixed-signedness operations because neither
automatic reinterpretation nor implicit widening to `i64` is universally safe. To
combine signed and unsigned values, convert one operand explicitly:

```zena
let total = (s as u32) + u; // Explicit cast
```

## Overflow and special values

### Integer overflow

Integer arithmetic in Zena follows standard two's complement modular arithmetic without
runtime overflow checks. Operations that exceed the representable range wrap around:

```zena
let max: i32 = 2147483647;
let wrapped = max + 1; // -2147483648
```

### Integer division by zero

Dividing an integer by zero using `div` or `%` traps at runtime with a WebAssembly
integer divide-by-zero runtime error:

```zena
import {div} from 'zena:math';

let zero = 0;
let trapped = div(10, zero); // Runtime trap: integer divide by zero
```

### Floating-point special values

Floating-point operations adhere to the IEEE 754 standard and never trap:

- **Division by zero**: Dividing a non-zero float by zero evaluates to `Infinity` or
  `-Infinity`. Dividing zero by zero (`0.0 / 0.0`) evaluates to `NaN`.
- **Special values**:
  - `Infinity`: Positive infinity
  - `-Infinity`: Negative infinity
  - `NaN`: Not-a-number
  - `-0.0`: Negative zero (compares equal to `+0.0` with `==`)

In accordance with IEEE 754 rules, `NaN` is not equal to any value, including itself:

```zena
let n = 0.0 / 0.0;
n == n; // false
```

To test whether a floating-point value is `NaN`, import `isNaN` from `zena:math`:

```zena
import {isNaN} from 'zena:math';

if (isNaN(n)) {
  // Value is NaN
}
```

## Numeric conversions

### Explicit casting with `as`

Conversions between numeric types must be explicit using the `as` operator:

```zena
let count: i32 = 100;
let bigCount = count as i64;       // Sign-extended to i64
let floatCount = count as f64;     // Converted to f64
let truncated = 3.99 as i32;        // Truncated towards zero to 3
```

When casting a wider integer to a narrow integer type, the value is truncated to the
lower bits and normalized:

- Casting to unsigned narrow types (`as u8`, `as u16`) masks to the lowest 8 or 16 bits:
  ```zena
  let b = 300 as u8; // 300 % 256 = 44
  ```
- Casting to signed narrow types (`as i8`, `as i16`) truncates and sign-extends the
  result:
  ```zena
  let s = 200 as i8; // -56
  ```

### Implicit promotion hierarchy

In binary arithmetic operations (`+`, `-`, `*`, `%`), operands are symmetrically
promoted according to the following hierarchy:

1. **`f64` dominance**: If either operand is `f64`, the result is `f64`.
2. **`f32` with 64-bit integers**: Mixing `f32` with `i64` or `u64` promotes to `f64`
   to preserve precision.
3. **`f32` with 32-bit integers**: Mixing `f32` with `i32` or `u32` promotes to `f32`.
4. **Narrow integer promotion**: Narrow integers (`i8`, `u8`, `i16`, `u16`) promote to
   their 32-bit counterparts (`i32` or `u32`) before arithmetic.
5. **Signed widening**: An `i32` mixed with `i64` widens to `i64`.
6. **Mixed signedness**: Mixing a signed integer with an unsigned integer is always a
   compile-time error.

```zena
let a: i32 = 10;
let b: i64 = 20;
let c = a + b; // i64 (a widens to i64)

let f: f32 = 2.5;
let d = a + f; // f32 (a promotes to f32)
```
