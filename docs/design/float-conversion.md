# Float conversion

`zena:string-convert` converts between binary floats and decimal
exactly: `parseF64` returns the float nearest the decimal it was given,
and `f64ToString` returns the shortest decimal that reads back as the
float it was given. This document covers how, and what it cost.

## Prior state

Parsing a decimal into an `f64` and printing an `f64` as a decimal both
returned incorrect results.

`floatToStringImpl` scaled the value by a floating-point power of ten
and truncated to 15 significant digits. `parseF64` accumulated digits
into an `f64` and divided the fractional ones by a running power of
ten. Measured against correctly-rounded conversions:

|                                                   | failure rate |
| ------------------------------------------------- | ------------ |
| `f64ToString` round-trip, random f64              | 94.2%        |
| `parseF64` on correctly-shortest text, random f64 | 85.7%        |
| `parseF64` on decimal literals of ≤17 digits      | 2.2%         |
| `f64ToString` round-trip on those same values     | 10.4%        |

`f64ToString(0.30000000000000004)` printed `0.3` — a different number.
`f64ToString(9007199254740992)` printed `9007199254740990`, an
exactly-representable integer printed wrong. `parseF64` turned
`1.7976931348623157e308` into `Infinity` and every subnormal into `0`.

Three call sites carried the errors further than a direct call to
`f64ToString`. `zena:json` parses every number through `parseF64`, so
JSON did not round-trip. `n` is the prelude's number formatter, which
`StringBuilder.append` and template literals call. And
`wat-emitter.zena` writes `f64.const` operands with it, so the
compiler's own WAT output did not faithfully represent float constants.

## Algorithm

The implementation follows the unrounded scaling of
[research.swtch.com/fp](https://research.swtch.com/fp). One primitive
underlies everything:

```
uscale(x, e, p) = an unrounded x * 2^e * 10^p
```

An _unrounded number_ is the value times four, with bit 1 saying the
fraction reaches one half and bit 0 sticky — some fraction beyond that.
Every rounding mode is then an add and a shift: `floor` is `u >> 2`,
`ceil` is `(u + 3) >> 2`, round-half-to-even is
`(u + 1 + ((u >> 2) & 1)) >> 2`.

Printing and parsing are each about twenty lines on top of it.
`shortestDigits` scales the two ends of the float's rounding interval,
takes the ceiling of one and the floor of the other, and returns the
shortest integer between them (preferring a multiple of ten, which is
one digit shorter still). `decimalToF64` picks the binary exponent that
lands `d * 10^p` in `[2^52, 2^53)`, scales, and rounds.

### Exactness of the scaling

`uscale` multiplies by a 128-bit approximation of `10^p`, and still
reports exactness correctly. How it does so decides where the sticky
bit comes from, and getting it wrong is silent, so it is spelled out
here.

The stored `pm` is `10^p`'s significand rounded **up**, kept in borrow
form `pm = hi * 2^64 - lo`. Rounding up means `x * pm` exceeds the true
`x * 10^p * 2^-pe` by less than `2^64` — at most one unit of the
product's middle word. So a middle-word residue of 0 or 1 cannot be
distinguished from an exact zero, and the algorithm's precision
argument is exactly the claim that it never has to be: at this scale
the true value is exact, or it is more than a middle-word unit away
from exact. Hence `sticky = (mid - mid2) > 1` rather than `!= 0`.

Deriving the sticky bit from the raw product bits instead — which is
what "the exact 192-bit product, with every discarded bit folded into
sticky" suggests — reports every exactly-representable value as
inexact, because the rounded-up table entry made it so. That produced
shortest forms one digit too short for about one value in 13,000.

`packages/stdlib/dev/fp-reference.js` is the same algorithm in
JavaScript and `fp-check.js` tests `uscale` against exact rational
arithmetic directly, over the whole `(x, e, p)` domain the conversions
use.

### Powers of two

The set of reals that round to a given float is normally one ulp wide,
half an ulp each way. At an exact power of two it is three quarters of
an ulp: the binade below has half the spacing, so the interval runs a
quarter ulp down and half an ulp up.

The decimal exponent estimate for that case is therefore
`floor(log10(3 * 2^(e-2)))`. Writing `2^(e-1)` gives the width in units
of the _lower_ binade's ulp, which is 1.5 of them — the same interval
measured against the wrong ulp. That picks a grid one power of ten too
coarse and prints a value that does not round-trip, for about one value
in 2,500.

## Compressed power-of-ten cache

Printing indexes `p` over `[-292, 324]` and parsing over `[-344, 309]`.
A full table covering the union, 669 entries at 16 bytes, is 10,704
bytes of data and more as emitted wasm: as an array of `i64` constants
it compiles to 15,166 bytes.

Instead the table stores 26 anchors — `10^(27q)` truncated to 192 bits
— and the 27 exact values `5^r` for `r` in `[0, 26]`, normalized to bit 63. Any entry is `10^p = 10^(27q) * 5^r * 2^r`, recovered with one
192×64 multiply and a normalize by one bit or none: the anchor is at
least `2^191` and the multiplier at least `2^63`, so the product's top
bit is bit 255 or bit 254 and never lower. The same shape of module
built from these compiles to 2,364 bytes, so the compression saves
12,802 bytes of wasm.

The stride is 27 because `5^26 < 2^61` still fits a `u64` exactly, and
192-bit anchors because that leaves the recovery's relative error below
`2^-191` where the 128-bit result needs only `2^-128`.

The recovery is verified rather than argued for.
`dev/fp-gen-tables.js` generates the tables,
runs the recovery in exact `u64`-word arithmetic, and checks it against
a full 128-bit table for every `p` in range; the emitted source is only
printed if all 669 match. Regenerate with:

```bash
node packages/stdlib/dev/fp-gen-tables.js
```

## The wide-arithmetic intrinsics

`uscale` needs a 64×64→128 multiply, which core WebAssembly does not
have. `zena:math` declares four intrinsics matching the
[wide-arithmetic proposal](https://github.com/WebAssembly/wide-arithmetic)
one for one — `mulWide`, `mulWideSigned`, `add128`, `sub128` — each
returning `inline (u64, u64)`, low half first, as the proposal's
instructions do.

`WasmModule.wideArithmetic` decides whether they lower to the
proposal's instructions (`0xFC 19`..`22`) or to the 32-bit-halves
sequences that mean the same thing. It is off by default: wasmtime,
wasmi, JavaScriptCore and SpiderMonkey implement the proposal, V8 does
not, and the stdlib has to run under `node`. `ZENA_WIDE_ARITHMETIC=1`
turns it on.

The two lowerings produce identical results for every input by
construction, so the flag trades bytes and speed and never results.
`codegen-wat_test.zena` compiles one source twice, once with the flag
and once without, and asserts that each emits its own instructions and
not the other's. A lowering that ignored the flag fails one of the two.

In ZIR these are four ops that produce two values each, read through
the same `mv_get` projections a multi-result call uses. That machinery
already worked for any producer; two places had hard-coded `IrOp.call`
and `IrOp.call_ref` as the only ones — the verifier's check that a
projection's operand produces a value, and `#storeMultiResults` in
`emit.zena`.

## Accuracy

`dev/fp-difftest.js` runs a generated corpus through a Zena program
and compares against JavaScript's conversions, which are correctly
rounded and shortest. Over 584,995 cases:

|                                              | cases    | failures |
| -------------------------------------------- | -------- | -------- |
| `f64ToString`                                | ~265,000 | 0        |
| `f32ToString`                                | ~30,000  | 0        |
| `parseF64`, inputs of ≤19 significant digits | 260,057  | 0        |
| `parseF64`, longer inputs                    | 29,955   | 6        |

The corpus covers every binade at its edges, the subnormals from both
ends, the powers of ten, and the values that have historically broken
implementations.

The failures are all inputs with more than 19 significant digits.
`parseF64` keeps 19 of them in a `u64` and normalizes that to 64 bits,
which leaves `64 - bits(d)` low bits to hold everything after the
nineteenth. The remaining digits are placed to within half of the last
of those bits, so a rounding boundary falling inside that span sends
the result one ulp the wrong way — measured at about one such input in
five thousand.

Closing this needs exact arithmetic on the full digit string, which is
the fallback other implementations use and which the algorithm this
follows leaves to its caller (its `Parse` takes a `uint64` significand
and rejects anything larger). Seventeen digits suffice to round-trip
any `f64`, so nothing `f64ToString` produces reaches this case.

## Size

Float conversion is reachable from the prelude, so its cost is worth
stating: a program that does not call it pays nothing.

| program                           | bytes |
| --------------------------------- | ----- |
| `main` returning a constant       | 51    |
| `console.log` of a string literal | 632   |
| ...plus `i64ToString`             | 1,306 |
| ...plus `f64ToString`             | 7,246 |
| ...plus `parseF64`                | 9,459 |

## Gaps

- **Exponent notation in float literals.** `1e10` does not lex; the
  literal must be written out in full or built with `parseF64`. This is
  a parser gap rather than a conversion one, and it is why the tests
  here construct extreme values by parsing strings.
- **`toFixed`.** `f64ToPrecision` gives `n` significant digits.
  Digits-after-the-point formatting needs the exact decimal expansion,
  which can run to about 1,100 digits and does not fit a `u64` path.
