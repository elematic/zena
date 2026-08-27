# Units of Measure

## Overview

A unit of measure is a compile-time annotation on a numeric value: `f64<m>` is
an `f64` that holds meters. The checker propagates units through arithmetic —
meters divided by seconds is meters-per-second — and rejects operations that
are not dimensionally meaningful, such as adding a length to a time. Units are
erased before code generation, so a program that uses them emits the same
instructions as one that does not.

The feature has three parts, which land separately:

1. **A unit kind in the checker.** Declarations that introduce dimensions and
   units, unit expressions in type position, normalization, and the rules
   governing each operator.
2. **Literal syntax.** `3.0m` and `42_u32`, one mechanism serving both.
3. **Unit polymorphism.** Functions generic over the unit of their arguments.

Conversion between units is deliberately not among them. Version one has no
compiler-derived conversions: a unit declares no scale relative to any other,
and converting feet to meters is an ordinary function someone writes. That
choice is what keeps the first milestone small, and it is also what makes
temperature work — see [Conversion](#conversion).

## Terms

**Representation** — the numeric type holding the value: `f64`, `f32`, `i32`,
`i64`. Independent of the unit.

**Base dimension** — an independent axis of measurement. SI has seven: length,
mass, time, electric current, thermodynamic temperature, amount of substance,
luminous intensity.

**Dimension** — a product of base dimensions with integer exponents. Force is
`Mass · Length · Time⁻²`. The dimensionless dimension is the empty product,
written `1`.

**Unit** — a named measure on a dimension. `m`, `ft`, and `mi` are three units
on the dimension Length. `m/s` is a unit on the dimension `Length · Time⁻¹`.

**Quantity** — a representation paired with a unit: `f64<m>`, `i64<ns>`.

## What today's types can express

`distinct type Meters = f64` gives `Meters` its own identity, which stops a
`Meters` being passed where a `Seconds` is expected. It stops nothing else. A
distinct type has no operators at all — `(3.0 as Meters) + (4.0 as Meters)` is
`Type mismatch: cannot apply operator '+' to Meters and Meters` — and the
representation is fixed at the declaration, so there is no way to say `Meters`
over `f32` on one target and `f64` on another.

An [extension class](../language-reference.md#extension-classes) over a
primitive gets much further. Extension classes are erased, may define
operators, and the operator may return a different type from the receiver.
This compiles and runs today, printing `35`:

```zena
final extension class Seconds on f64 {}
final extension class MPS on f64 {}
final extension class Meters on f64 {
  operator *(k: f64): Meters { return ((this as f64) * k) as Meters; }
  operator /(t: Seconds): MPS { return ((this as f64) / (t as f64)) as MPS; }
  operator <(other: Meters): boolean { return (this as f64) < (other as f64); }
}

export function main(): f64 {
  let d = 10.0 as Meters;
  let t = 2.0 as Seconds;
  return ((d / t) as f64) + ((d * 3.0) as f64);
}
```

So a closed set of units, with a hand-written table of operators relating them,
works with no compiler changes at all. `+=` works. Comparison works.

What does not work is generalizing it. A quantity type parameterized by its
unit is rejected twice over:

```zena
final extension class Qty<D> on f64 {
  operator +(other: Qty<D>): Qty<D> {
    return ((this as f64) + (other as f64)) as Qty<D>;
  }
}
let sum = (3.0 as Qty<Length>) + (4.0 as Qty<Length>);
```

```
Error: Cannot cast type 'f64' to 'Qty<D>': the target's type arguments are not
supplied by the source, so the cast would mint values of them.
Error: Type mismatch in operator '+': expected 'Qty<D>', got 'Qty<Length>'.
```

The first error is the [anti-laundering
rule](../language-reference.md#casts-through-type-parameters) working as
designed: a generic quantity cannot construct itself from a raw number, for the
same reason a generic function cannot mint a `T` from an `i32`. F# hits the
same wall and answers it with a primitive, `FloatWithMeasure`, which is exactly
the escape hatch the rule otherwise forbids.

The second error is a bug ([#337](https://code.rictic.com/justin/zena/issues/337)),
and it is not specific to units: an operator method on a generic class does not
substitute the receiver's type arguments into the operator's parameter type.
The identical method under an ordinary name works:

```zena
class Qty<D> {
  v: f64;
  new(this.v);
  plus(other: Qty<D>): Qty<D> { return new Qty<D>(this.v + other.v); }
}
// (new Qty<Length>(3.0)).plus(new Qty<Length>(4.0)).v  ==>  7
```

Even setting generics aside, a unit built as an extension class over `f64` has
two sharp edges, both filed:

- Unary minus is rejected. `-(10.0 as Meters)` reports
  `Unary '-' requires a numeric type, got 'Meters'`. Negative displacements and
  deltas are ordinary, so this is not a corner case.
  ([#338](https://code.rictic.com/justin/zena/issues/338))
- `Array<Meters>` fails to compile, reporting
  `zir unsupported: identity compare on non-refs @FixedArray.contains`.
  `Array<f64>` works, and so does `Array<Meters>` where `Meters` is a
  `distinct type`, so this is specific to an extension class over a primitive
  used as an element type.
  ([#339](https://code.rictic.com/justin/zena/issues/339))

## Representation and unit are orthogonal

A unit annotates a representation rather than replacing it. `f64<m>`, `f32<m>`
and `i32<m>` are three types, all meaning meters, differing in how the number
is stored. This matters in both directions: a physics simulation wants `f64`, a
graphics pipeline wants `f32`, and a clock wants `i64<ns>` because nanoseconds
since an epoch do not fit a float without losing the low bits.

`distinct type` cannot express this — it names one representation at the
declaration — which is the first reason units cannot be a library over
`distinct type`.

Syntax follows F#: the unit goes in type arguments on the representation.

```zena
let d: f64<m> = 3.0m;
let t: f32<s> = 0.5s;
let elapsed: i64<ns> = clock.now();
```

`f64<m>` parses today and is rejected by the checker with `Type 'f64' is not
generic`, so the syntax is unclaimed and the change is confined to type
resolution.

Alternatives were considered and rejected in [Type
syntax](#type-syntax-alternatives).

### Dimensionless

`f64<1>` is the same type as `f64`, not a distinct wrapper around it. A
dimensionless quantity is a number; `Math.sin` should take one without a
conversion, and `d / d` should be usable as a scalar directly. Making the
dimensionless case identical to the bare representation is what keeps units
from leaking into code that does not use them.

### Non-unit-aware code

A quantity is not accepted where its bare representation is expected. Passing
`f64<m>` to `(x: f64) => f64` is an error, because the function may do anything
to the number — add a dimensionless constant, square it, use it as an index —
and none of that preserves the unit. Stripping is explicit:

```zena
let d: f64<m> = 3.0m;
let rounded = Math.floor(d as f64) as f64<m>;
```

That is correct but tedious, and it applies to a specific and annoying list:
`abs`, `min`, `max`, `floor`, `ceil`, `round`, and the rest of the functions
that are unit-preserving in fact but not in type. The fix is
[unit polymorphism](#unit-polymorphism), which lets `abs` be declared once over
any unit; that is the argument for it landing early rather than last.

### Mixed representations

Units change nothing about which representations may be combined. `f64<m> +
f32<m>` is an error for the same reason `f64 + f32` is, and the one implicit
promotion Zena has — `i32` with `f32` in binary arithmetic — carries the unit
through unchanged. The unit rules and the numeric rules compose; neither
relaxes the other.

A cast that changes representation carries the unit along: `3.0m as f32<m>` is
an ordinary numeric conversion with the unit untouched.

## Dimensions, units, and normalization

Dimension and unit are separate levels. `m` and `ft` are two units on one
dimension. The dimension is what decides whether an operation is meaningful;
the unit is what decides whether two operands are the same type.

### Declarations

```zena
dimension Length;
dimension Time;
dimension Mass;

unit m: Length;
unit ft: Length;
unit s: Time;
unit kg: Mass;

dimension Force = Mass * Length / Time**2;
unit N: Force = kg * m / s**2;
```

A `dimension` with no definition introduces a new base dimension. A `dimension`
with a definition names a product of existing ones, for use in signatures and
diagnostics. A `unit` with no definition is an atom on its dimension. A `unit`
with a definition is an abbreviation for a product of other units.

Names live in a namespace of their own. A unit `m` and a variable `m` can
coexist, because a unit name only resolves in unit position — inside the type
arguments of a numeric type, in another unit's definition, and as a literal
suffix. Without this, SI symbols would be unusable as unit names, and SI
symbols are the point: `f64<m/s**2>` should read the way it reads on paper.

### Defined and atomic units

Whether a unit expands is decided by how it is declared, and that single choice
does the work that other systems need a separate concept for.

`N` is declared as `kg * m / s**2`, so it expands: `f64<N>` and
`f64<kg*m/s**2>` are the same type, and a force computed from a mass and an
acceleration is a `f64<N>` with nothing in between.

`ft` is declared as an atom, so it does not expand, and `f64<ft>` is not
`f64<m>` however much they measure the same thing. Getting from one to the
other takes a function.

This also answers the problem that mp-units solves with a hierarchy of quantity
kinds. Frequency and radioactivity are both `Time⁻¹`, and interchanging them is
a bug. Declare them as atoms and they are separate types:

```zena
dimension Rate = 1 / Time;
unit Hz: Rate;              // atom — does not expand to s**-1
unit Bq: Rate;              // atom — a different type from Hz
```

The same trick separates torque from energy. The cost is that `1.0 / (2.0s)`
produces `f64<s**-1>` rather than `f64<Hz>`, so a program that wants `Hz` labels
it — one function at the boundary, in exchange for the two never being confused
downstream.

A `distinct type` over `f64<s**-1>` would also give nominality, and it is the
wrong tool: distinct types have no operators, so the result could not be added
to itself. Unit atoms give the same separation and keep the arithmetic.

### Normalization

A unit expression normalizes to a map from unit atom to exponent, with defined
units replaced by their definitions until only atoms remain. Two unit
expressions are the same type when their normal forms are equal. Exponent zero
drops out, so `m/m` is `1`, which is the dimensionless case above.

The dimension of a unit expression is the image of its atoms under
dimension-of, so dimensional compatibility is computed rather than declared.

Deciding what a unit expression means therefore needs multiplication over an
abelian group of exponents. That is the reason this is a checker feature and
not a library: nothing in Zena's type system today can compute
`m × (m·s⁻¹) = m²·s⁻¹`.

Exponents are stored as rationals, not integers, from the start. Nothing in
version one produces a fractional exponent, but volts per root-hertz is a real
unit in signal processing, and widening the exponent type later would touch
every comparison in the checker. Writing `f64<V/Hz**(1/2)>` is allowed;
producing a value of it takes a labelling cast, because `Math.sqrt` is not
unit-aware.

### Operator rules

| Operation                 | Requires                   | Result               |
| :------------------------ | :------------------------- | :------------------- |
| `a + b`, `a - b`, `a % b` | identical normalized units | that unit            |
| `-a`                      | —                          | same unit            |
| `a * b`                   | —                          | exponents summed     |
| `a / b`                   | —                          | exponents subtracted |
| `a < b`, `a == b`, …      | identical normalized units | `boolean`            |
| `a += b`                  | as `+`                     | —                    |

A scalar is unit `1`, so scaling falls out of the multiplication rule with no
special case: `3.0 * (2.0m)` is `f64<m>`, and `1.0 / (2.0s)` is `f64<s**-1>`.

### Exponent syntax

Unit expressions need exponentiation, and the spelling is `**` — matching what
a value-level exponent operator would have to be, since `^` is bitwise XOR in
Zena. One idea should not have two spellings depending on which side of a `<`
it appears.

```zena
unit N: Force = kg * m / s**2;
let g = 9.8 as f64<m/s**2>;
```

Giving `^` to exponentiation instead would mean moving XOR, and Zena's sources
use infix `^` about 260 times — hashing, bit masks, flag clearing — while using
exponentiation zero times; there is no `Math.pow` call anywhere in the
repository. Moving a load-bearing operator to free a spelling for one nothing
has needed would also make `a ^ b`, which means XOR to anyone arriving from C,
JavaScript, Rust or Python, silently compile to a power.

For the record, since it comes up: freeing `^` would not require a new spelling
for bitwise NOT. Lua added bitwise operators to a language that already used
`^` for powers and moved XOR to `~`, which serves as binary exclusive-or and
prefix bitwise NOT at once, disambiguated by arity exactly as `-` is already
both subtraction and negation. Alternatively `!` can carry both logical and
bitwise NOT, dispatched on the operand type as it is in Rust — safe here
because Zena has no truthiness, so `!5` is a type error today and the meaning
is unclaimed. Neither is needed under the `**` decision, but bitwise NOT does
want `~` wired through the parser to the lowering ZIR already has
([#343](https://code.rictic.com/justin/zena/issues/343)).

#### Superscripts

Unit expressions may also be written with Unicode superscripts, which is how
the notation appears everywhere outside a text editor:

```zena
let g = 9.8 as f64<m/s²>;
let f: f64<s⁻¹> = ...;
```

`m²` and `m**2` are the same unit expression, and the formatter normalizes one
to the other so a file is internally consistent. Superscripts cover integer
exponents only — `⁰` through `⁹` and `⁻` exist, and there is no readable
composition for `-1/2` — so a rational exponent is written `Hz**(-1/2)` and
stays that way.

Which direction the formatter normalizes is worth deciding deliberately.
Normalizing **to `**`** keeps source ASCII, greppable and typable on any
keyboard, and is the conservative choice. Normalizing **to superscripts** makes
the formatter do the typing, so `f64<m/s²>`is what a reader sees while`m**2`is what an author types — the same bargain as a formatter that rewrites quotes.
The recommendation is`**` as canonical, on greppability, but this is close.

## Conversion

**Version one has no compiler-derived conversions.** A unit declares no scale
relative to any other unit, and converting between two units on a dimension is
a function someone writes:

```zena
export function feetToMeters(x: f64<ft>): f64<m> {
  return ((x as f64) * 0.3048) as f64<m>;
}
```

The casts in that function are the ones `as` already does: strip a unit, or
attach one, leaving the value alone. `as` never rescales.

### Why not `as`

Every conversion `as` performs today is one the reader can name from the two
types alone: truncate a float, sign-extend an integer, reinterpret a bit
pattern, check a downcast. A unit conversion is not — it multiplies by a
constant drawn from a declaration in another file, and two casts that look
identical differ by whichever factors those declarations happen to carry.

Numeric `as` is genuinely a runtime conversion, not a compile-time retyping:
`3.7 as i32` emits `f64.const 3.7` followed by `i32.trunc_sat_f64_s`, and so
does `f as i32` for a variable `f`. But that is a weak defense of overloading
it further, because `as` on a numeric literal is a stopgap for a missing
feature rather than a design: it is how you currently write a literal of a
non-default type. Once suffixes land, `1.0 as f64` becomes `1.0f64` and the
lossy remainder — `3.7 as i32` — is arguably an error rather than a cast.
Adding unit conversion to `as` would grow a role that is scheduled to shrink.

### What deferring costs

The cost is that authored conversions do not compose. `mi` to `m` and `h` to
`s` do not give you `f64<mi/h>` to `f64<m/s>`; that is a third function. A
compiler that knew each unit's scale would derive it, and derive every other
compound conversion on those atoms for free. The number of base units is small;
the number of compound units people convert between is not.

So this is a real cost, paid deliberately, and the eventual design is
foreseeable: units gain an optional scale in their declaration, and a builtin —
`convert<mi/h>(speed)`, not `as` — derives the factor by normalizing both
units and dividing. The declaration grammar above leaves room for it, so
adding it is not a breaking change. Two things have to be settled first, and
neither is settled now: what integer representations do when the factor is not
an exact integer, and what happens to temperature.

### Temperature, and why it is not a special case yet

Celsius and Fahrenheit differ from kelvin by an offset, not only a scale, and
this is usually presented as a reason to forbid adding two temperatures.
Without compiler-derived conversion the objection evaporates: `°C` is an atom
like any other, `20°C + 5°C` is `25°C`, and nothing in the language disagrees.

The defect is specific and it belongs to conversion, not to addition. Addition
of an affine quantity does not commute with converting it. Adding 20 °C and
5 °C gives 25 °C; converting both to kelvin first gives 293.15 K + 278.15 K =
571.30 K, which is 298.15 °C. Two answers from the same expression, chosen by
where the conversion happened. That is the sense in which the operation is
wrong, and it is invisible until something converts.

So the decision about affine units _is_ the decision about conversion, and
version one takes the package where both are absent: temperature units are
ordinary atoms, they add and subtract like everything else, and conversions
between them are written out. When compiler-derived conversion arrives, offsets
arrive with it, and so does the split between a temperature and a temperature
difference — at which point `20°C + 5°C` becomes an error and
`20°C + 5Δ°C` is how it is spelled. Instants and durations have the same shape
and get the same treatment.

## Literals

`3.0 as f64<m>` is too heavy for the thing programs do most. The target is
`3.0m`.

### What other languages do

| Language          | Spelling                      | Mechanism                                                           |
| :---------------- | :---------------------------- | :------------------------------------------------------------------ |
| F#                | `3.0<m>`                      | measures in type-argument position on the literal                   |
| C++ (mp-units)    | `3.0 * si::metre`, or `3.0_m` | unit values, or a user-defined literal suffix (must start with `_`) |
| Rust (`uom`)      | `Length::new::<meter>(3.0)`   | constructor; no literal syntax                                      |
| Julia (Unitful)   | `3.0u"m"`                     | string macro                                                        |
| Nim (`unchained`) | `3.0.m`                       | field access on a numeric literal                                   |
| Kotlin, Swift     | `3.days`, `.seconds`          | extension property on the numeric type                              |
| Frink             | `3 m`                         | juxtaposition; units are values in a language built around them     |
| Rust, Zig, C      | `3u32`, `3.0f32`              | built-in suffixes for representations only                          |

Two clusters. The suffix languages get the shortest spelling and pay for it in
lexer rules. The others avoid touching the lexer by making units values or by
routing through an existing extension mechanism, and they are all longer.

The Kotlin and Nim spelling — `3.0.m` — is unavailable to Zena for a reason
that is not a missing feature. Member lookup on a bare primitive does not
consult extension classes, and that is a deliberate design decision: extension
classes apply to a static type, not ambiently to whatever the value happens to
be underneath. `(3.0).m` reports `Property access not supported on type 'f64'`
and should keep doing so.

### Suffixes

A numeric literal may be followed, with no intervening whitespace, by an
identifier:

```zena
let n = 42_u32;           // u32
let big = 42_i64;         // i64
let d = 3.0m;             // f64<m> — the default for an unannotated float literal
let d2: f32<m> = 3.0m;    // f32<m> — the annotation picks the representation
let d3 = 3.0m as f32<m>;  // f32<m> — the cast does the same job
let t = 30s;              // i32<s>
```

A literal takes one suffix, naming either a representation or a unit. Saying
both at once — `3.0f32m` — is not a spelling this proposes; an annotation or a
cast covers it, as above.

### Separators before a suffix

`42u32` is hard to read, and the fix is the one Rust uses: a digit separator may
sit between the number and the suffix, so `42_u32` and `3.0_m` are the readable
spellings and `42u32` and `3.0m` remain legal. Nothing new is needed in the
lexer beyond digit separators themselves — the numeric literal consumes digits
and underscores greedily, and whatever identifier remains is the suffix.

Zena has no digit separators today: `1_000` is a parse error. They should land
in the same step as suffixes rather than after, because the readable spelling
of a suffixed literal depends on them, and because deciding the interaction
once is cheaper than deciding it twice.

Short unit names rarely need the separator — `3.0m` reads fine, `42_u32` does
not — so in practice the separator shows up on representation suffixes and
disappears on unit suffixes. That is a style question a formatter can settle.

Resolution order for the suffix: a primitive type name first, then a unit name
in scope. One mechanism covers the representation suffixes the language wants
anyway and the unit suffixes this feature needs.

The suffix names only the unit. The representation comes from Zena's existing
rules for numeric literals, which already adapt to an annotation: both
`let x: f64 = 3.0;` and `let x: i64 = 3;` compile today. So `3.0m` in an
`f64<m>` context is an `f64`, and the suffix never has to spell the
representation and the unit at once.

Two lexer constraints:

- **The numeric grammar is lexed maximally first.** Zena has no exponent
  literals today — `1.5e3` is a parse error. If suffixes ship first, `1.5e3`
  silently becomes "the literal 1.5 with suffix `e3`", and the exponent form
  can never be added. The grammar has to be decided before suffixes ship, even
  if it is not implemented
  ([#340](https://code.rictic.com/justin/zena/issues/340)); then `1.5e3f64`
  lexes the way it does in Rust. Hex is already fine: `0xff` works today and
  `0xffu32` follows the same maximal-munch rule.
- **No whitespace.** `3.0 m` stays what it is today — a syntax error, and
  available for something else later.

#### The `3m/s` trap

A suffix is one identifier, so `3m/s` does not mean three meters per second. It
parses as `(3m) / s` — a quantity divided by whatever `s` names in the value
namespace. If nothing does, it is an unresolved name; if something does, it is
a division by that variable, silently.

This is the one place the suffix syntax reads as though it should work and does
not, and it deserves a diagnostic rather than a footnote. When a unit-suffixed
literal is divided or multiplied by a bare identifier that is also a unit name
in scope, the checker should say so and point at `f64<m/s>` or a named unit.
Nothing prevents the code from being written; the message is what stops the
misreading.

Juxtaposition does not solve this either — see below — so it is a property of
compound units in literals rather than a discriminator between the two
spellings.

### Juxtaposition

`3 m`, with a space, is Frink's spelling. It is not an alternative to suffixes
but an addition to them — the language wants `42_u32` regardless — so the
question is whether to have a second literal syntax, and what it buys is
`3u64 m`: a representation and a unit on one literal, without an annotation or
a cast.

Two objections that look good and are not:

- **Automatic semicolon insertion.** Does not apply. Zena requires semicolons
  except after block-ended expressions used as statements, so `let x = 3`
  followed by a line starting with `meters` is already an error and cannot be
  silently reinterpreted.
- **Postfix.** `3 m.abs()` would bind `.abs()` to `m`, and `3m.abs()` would
  not. But primitives have no methods in this design — member lookup on a bare
  primitive does not consult extension classes — so `3m.abs()` is not valid
  either way, and `(3 m)` parenthesizes cleanly when something eventually
  wants a postfix. This argument is close to empty.

Compound units are a wash: neither spelling reaches them, for the reason in
[the `3m/s` trap](#the-3ms-trap) above. `3 m/s` would need `m/s` parsed
greedily as a unit expression while `3 m / t` divides by a variable, and the
parser cannot tell those apart without knowing which names are units.

What is left is one objection, and it carries the decision: **whitespace
becomes significant in expressions**, which it is not anywhere in Zena today.
The concrete cost is that a missing operator becomes valid code — `let x = 3 m`
is a unit literal rather than the `3 * m` or `3 + m` the author meant, with no
diagnostic. That failure mode is worse than typing `3.0m as f32<m>` in the rare
case a literal needs both a representation and a unit.

### Composite units in literals

A suffix is one identifier, so `9.8` in m/s² has no suffix form. Two answers,
both available:

```zena
unit mps2: Acceleration = m / s**2;
let g1 = 9.8mps2;
let g2 = 9.8 as f64<m/s**2>;
```

Named units for the compound quantities a program actually uses is the better
habit, and it is what SI itself does.

## Unit polymorphism

Code that is generic over a unit is what separates a units feature from a
naming convention. Without it, every helper is written per unit, and every call
into `zena:math` strips and relabels.

```zena
function square<unit u>(x: f64<u>): f64<u**2> {
  return x * x;
}

function sum<unit u>(xs: Array<f64<u>>): f64<u> { ... }

function abs<unit u>(x: f64<u>): f64<u> { ... }

let area = square(3.0m);   // f64<m**2>
```

Unit parameters are declared `unit u` rather than reusing ordinary type
parameters, because a unit is not a type: it cannot be instantiated, cannot be
a field's type, and is erased. F# makes the same separation for the same
reason, with `[<Measure>] 'u`.

Bounds restrict a unit parameter to a dimension:

```zena
function magnitude<unit u: Length>(v: Vec3<f64<u>>): f64<u> { ... }
```

Matching a call argument's unit against a parameter's unit expression is
unification in an abelian group — matching `f64<m**2>` against `f64<u**2>` means
solving `u² = m²`. The general problem is decidable but the algorithm is
substantial; Kennedy's is the reference implementation and it is what F# runs.

**Version one takes a restricted rule:** every unit parameter must appear
somewhere in the parameter list with exponent 1 and not multiplied by anything
else, so that its binding is read off directly. `square<unit u>(x: f64<u>)`
qualifies. A signature that only ever mentions `u**2` does not, and is rejected
at the declaration with a message saying so. This covers the functions people
actually write, and leaves room to lift the restriction later without breaking
anything.

## Alternatives considered

### A `zena:units` library on today's compiler

One `final extension class ... on f64` per unit, with a hand-written operator
table, as in the example that opens this document. It works, and it was
proposed as a first step to settle names before touching the checker. It is not
worth building, because its limits are structural rather than incidental:

- **The unit set is closed.** `m * m` requires that `m**2` already be one of the
  library's units. Any product a user needs and the library did not enumerate
  is unavailable, and users cannot add one without also writing every operator
  relating it to every existing unit.
- **The operator table is quadratic.** Each supported product or quotient is a
  method written by hand or generated by a script outside the language.
- **The representation is fixed.** One class per unit means `f64` or `f32`, not
  both.
- Negation does not work and arrays of quantities do not compile
  ([#338](https://code.rictic.com/justin/zena/issues/338),
  [#339](https://code.rictic.com/justin/zena/issues/339)).

A library that has to be thrown away teaches less than it costs, and the names
it would settle are settled just as well by writing them down here.

### Dimension-typed values with canonical storage

Carry the dimension in the type and store every value in the base unit of that
dimension. `3.0m` and `2.0ft` would both be `Length`, the second stored as
0.9144, and adding them would work.

This is simpler, and it catches the error that matters most — the Mars Climate
Orbiter bug lived at the boundary where a raw number was read, not inside an
arithmetic expression, and this model forces a unit to be named at that
boundary just as well.

It is wrong for Zena because of integers. `i32<mm>` cannot be stored in a
canonical unit without either losing the value or changing the representation,
and a language that offers `i32` and `i64` quantities cannot make canonical
storage the rule. It also has no answer for units whose conversion is not a
pure scale, and it forces a choice of canonical unit on domains that have no
natural one.

### Encoding units in the existing type system

Dimension exponents as numeric literal type arguments — `Qty<Dim<1, -1>>` for
speed — with type-level arithmetic to combine them. This fails at three
independent points, in increasing order of severity: negative literals do not
parse in type position (`Dim<1, -1>` is `Expected type annotation (got '-')`,
while `Dim<1, 0>` compiles); operators do not substitute type arguments
([#337](https://code.rictic.com/justin/zena/issues/337)); and there is no way
to compute a type from other types, which is what `Mul<D1, D2>` would need. The
third is not a small feature, and adding a type-level computation language to
get units would be a much larger change than adding units.

### Type syntax alternatives

`Meters<f64>` — unit first, representation as the argument — reads well for
atoms and badly for compounds: `(Meters/Second**2)<f64>` against
`f64<m/s**2>`.

`Quantity<f64, m>` — a plain generic — needs no new syntax in type position but
needs the unit kind anyway, and is longer everywhere it appears.

### Literal syntax alternatives

`3.0<m>` (F#'s spelling) collides with comparison: `3.0<m>` against
`3.0 < m > 2` is the same ambiguity that makes `a<b>(c)` hard in every language
that tries it.

## Deferred

**Compiler-derived conversion**, and with it declared scales, the rule for
integer representations, and the affine split between points and deltas. See
[Conversion](#conversion) — this is one decision, not four.

**Printing and parsing.** A quantity knows its unit at compile time, so
formatting can name it and parsing can require it.

**Rational exponents in arithmetic.** The exponent representation is rational
from the start and `*` and `/` handle fractional exponents for free, so what is
actually deferred is narrow: a unit-aware `Math.sqrt` that halves exponents.
Until then `f64<V/Hz**(1/2)>` is a type you can write, and values of it come
from a labelling cast or from a helper that builds one out of quantities the
checker can already relate.

## Implementation plan

**Step 1 — The compiler bugs, first.** [#337](https://code.rictic.com/justin/zena/issues/337)
(operator methods do not substitute type arguments),
[#338](https://code.rictic.com/justin/zena/issues/338) (unary minus on numeric
extension classes) and [#339](https://code.rictic.com/justin/zena/issues/339)
(`Array<T>` over an extension class fails in ZIR). All three are bugs on their
own terms. [#340](https://code.rictic.com/justin/zena/issues/340) — deciding
the exponent-literal grammar — is a design decision that only has to be made,
not implemented, and it blocks step 3.

**Step 2 — Dimension and unit declarations.** The unit namespace, unit
expressions in type position on numeric primitives, normalization over rational
exponents, the operator rules, stripping and labelling casts, and erasure. This
is the step that makes the feature real; literals are `as`-form until step 3.

**Step 3 — Literal suffixes.** Digit separators, the suffix lexer, and
resolution against primitive type names and unit names. Delivers `42_u32` and
`3.0m` together.

**Step 4 — Unit polymorphism.** `unit u` parameters with the
linear-occurrence restriction, and dimension bounds. Wanted early in practice,
because without it every call into `zena:math` strips and relabels.

**Step 5 — `zena:units`.** SI base and derived units, the common non-SI units,
and authored conversion functions between them.

Compiler-derived conversion, affine units and unit-aware `sqrt` follow, in that
order of demand.
