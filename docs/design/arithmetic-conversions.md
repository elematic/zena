# Arithmetic Conversions

## Status

- **Implemented** for `i32`/`u32`/`i64`/`u64`/`f32`/`f64` — the tables below
  describe `promoteNumeric` in `packages/zena-compiler/zena/lib/types.zena`,
  not a proposal.
- **Narrow integers (`u8`, `u16`, `i8`, `i16`) implemented 2026-08-06**, as
  types, promotion, casts and literal range checking. Their *packed storage*
  is not built yet — see [Two representations](#two-representations). See
  [Narrow integers](#narrow-integers).
- This document previously proposed rules that the compiler never adopted —
  notably `i32 op u32 -> i32` by bit-pattern reinterpretation. The compiler
  **rejects** that combination. The proposal has been replaced with what
  actually ships.

## Principles

1. **Widening within a signedness.** Mixing sizes is fine when both operands
   are signed, or both unsigned: the narrower operand widens.
2. **Mixed signedness is an error.** `i32 + u32` does not compile. There is no
   reinterpretation and no silent promotion to a wider signed type; write the
   conversion you mean. This is the one place Zena refuses to guess, because
   both plausible answers (reinterpret vs widen to `i64`) are defensible and
   silently differ.
3. **Narrowing is always explicit.** No arithmetic result implicitly narrows.

## Result types for `+`, `-`, `*`, `%`

Symmetric — swapping the operands gives the same answer.

| Left | Right | Result |
| --- | --- | --- |
| anything | `f64` | `f64` |
| `f32` | `i64`/`u64` | `f64` (precision) |
| `f32` | anything else | `f32` |
| `u64` | `u64` | `u64` |
| `u64` | anything else | **error** |
| `i64` | any signed integer | `i64` |
| `u32` | `u32` | `u32` |
| `i32` | `i32` | `i32` |
| signed int | unsigned int | **error** |

Integer literals without a `.` start as `i32`; with a `.`, `f64`.

## Division

`/` always produces a float — `i32 / i32` is `f64`, not `0`. This avoids the
`1 / 2 == 0` surprise.

For truncating integer division use `div` from `zena:math`, which lowers
directly to `i32.div_s` / `i64.div_s` at zero cost. For powers of two, `>> 1`
is idiomatic (and appears throughout the compiler).

## Narrow integers

`u8`, `u16`, `i8`, `i16` exist for two reasons: WIT interop (WASI p2 uses `u8`
21 times and `u16` 13 times) and packed array storage. They are **not** a
general-purpose numeric tier.

### Two representations

A narrow integer is stored packed and computed wide:

| Position | Representation | Status |
| --- | --- | --- |
| array element | packed — wasm `i8` / `i16` storage | implemented |
| struct/record field | packed — wasm `i8` / `i16` storage | **not yet** — currently `i32` |
| local, parameter, return, expression value | unpacked — wasm `i32` | implemented |

This is exactly what `ByteArray` already does: a wasm `(array i8)` whose reads
produce `i32`. Loads zero-extend for unsigned types (`array.get_u`) and
sign-extend for signed ones (`array.get_s`), so the unpacked value always
carries the mathematically correct number, never a bit pattern needing
interpretation.

Packing is a storage-size optimization, not a semantic one, so it was
deliberately left out of the first implementation: it changes no observable
behaviour, and it belongs with the array work that needs it (`FixedArray<u8>`
for WIT's `list<u8>`), where `array.get_u`/`array.get_s` can be introduced
once rather than twice.

**The invariant that makes this work** is that an unpacked narrow value is
always in *canonical* form — unsigned values zero-extended, signed values
sign-extended — so every promotion and comparison downstream is plain 32-bit
work with no masking. Only `as` can break that invariant, so `as` is the only
operation that re-normalizes (`normalizeNarrow` in `ir/operators.zena`).

### Arithmetic: narrow operands promote, narrow results do not exist

**Decision: mixed-size arithmetic is allowed within a signedness — consistent
with `i32 + i64 -> i64`, which already ships — but a narrow type never
survives an arithmetic operation.** Every narrow operand promotes to its
32-bit counterpart first:

- `u8`, `u16` → `u32`
- `i8`, `i16` → `i32`

So `b[i] + 1` is `u32`, `u8 + u8` is `u32`, `u8 + u32` is `u32`, and
`u8 + i32` is an error like every other mixed-signedness pair. Assigning back
into a narrow location requires an explicit `as u8`, which is where the range
check or mask happens — one conversion at a place the author chose.

Two alternatives were considered and rejected:

**`u8 + u8 -> u8`, wrapping at 8 bits.** Superficially the most consistent
choice, since `u32 + u32 -> u32`. Rejected because it costs a mask after every
operation to maintain the invariant, and because `200 + 100 == 44` is a far
sharper edge than `i32` wrapping at 2³² — the widths people actually reach in
practice are the narrow ones.

**Forbidding narrow arithmetic entirely, requiring an explicit widen.** Safe
and cheap to implement, and relaxable later without breaking code. Rejected
because `b[i] + 1` is the single most common thing anyone does with a byte,
and making it `(b[i] as u32) + 1` taxes every byte loop in the standard
library to buy nothing — the promotion is not lossy, so there is no error for
the ceremony to prevent.

The promotion is implicit, which is a real cost against "no implicit
coercion". It is precedented (`i32 + i64 -> i64` already widens implicitly)
and it is *value-preserving* — unlike the mixed-signedness case, no operand
changes meaning. Narrowing, which can change meaning, stays explicit.

### Comparison and equality

Comparisons follow the same promotion, so `b[i] == 0` works without a cast.
Mixed signedness is an error in comparisons too.

### Literals

An integer literal takes its type from context, so `let b: u8 = 200;` needs no
cast, and in `b + 1` the literal adopts `u8` from the other operand before both
promote. A literal that cannot be represented is an error:

```zena
let ok: u8 = 255;
let bad: u8 = 256;   // Error: Integer literal 256 is out of range for type 'u8'
let low: i8 = -128;  // fine — the sign is part of the literal for this check
```

The range check covers the narrow types and the unsigned types. `i32` and
`i64` are deliberately excluded: they have never checked their literals, and
tightening them is a separate change with its own fallout.

This replaced a hard `throw` in the checker that rejected *every* literal in a
`u32` or `u64` context, which is why unsigned code previously had to write
`5 as u32` on each constant.

### `as` conversions

`x as u8` on a wider integer truncates to the low 8 bits — the same semantics
as the packed store it feeds. It is explicit precisely because it can lose
information. The signed narrow types sign-extend on the way back out, so
`200 as i8` is `-56`.

## Related

- [component-model.md](./component-model.md) — the WIT interop that motivates
  the narrow types
- [arrays.md](./arrays.md) — packed array storage
