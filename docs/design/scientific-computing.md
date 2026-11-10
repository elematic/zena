# Scientific Computing in Zena

Zena should be a good language for scientific, mathematical and financial
computing: the work people do today in NumPy, R, MATLAB and Mathematica,
with a path to BLAS-backed linear algebra. This document records what the
language has for that today, what it lacks, the decisions still to make,
and the order of the work. The umbrella issue is
[#894](https://github.com/elematic/zena/issues/894).

Two features have their own designs and are summarized here rather than
repeated: [units of measure](units-of-measure.md) and [SIMD](simd.md).

## Current state

### Numeric core

Every integer width from `i8` to `u64`, `f32` and `f64`, with sound
promotion and no implicit coercion ([arithmetic-conversions.md](arithmetic-conversions.md)).
`/` always produces a float; integer division is `div` from `zena:math`.
`**` is exponentiation, right-associative. Literals take their type from
context, so `let x: f64 = 3;` and `let n: i64 = 5000000000;` compile.
Float printing and parsing are correct and shortest-round-trip
([float-conversion.md](float-conversion.md)). `zena:math` has the
operations Wasm has instructions for, the elementary functions from
musl's libm, and the 128-bit wide arithmetic intrinsics `mulWide`,
`add128` and `sub128`. `zena:bigint` provides arbitrary-precision signed
integers (`BigInt`) with `n`-suffixed literals, and `zena:decimal`
provides 128-bit IEEE 754 `decimal128` floating-point numbers (`Decimal`,
`RoundingMode` and `DecimalContext`).

### Operators on user types

A class can declare unary `operator -()`, binary `operator +`, `-`, `*`,
`/`, `%`, `**`, `&`, `|`, `^`, `<<`, `>>`, `>>>`, `==`, `<`, `<=`, `>`,
`>=`, `[]` and `[]=`, with multiple overloads distinguished by parameter
type and relational operators falling back to `compareTo(other): i32`
when not declared directly. An extension class over a primitive can
declare the same, and is erased, so a `Celsius on f64` costs a call per
operation and no allocation. `zena:simd`'s `F32x4` and siblings are
built this way over `v128`.

### SIMD

`v128` is a primitive, all 236 fixed-width instructions are intrinsics in
`zena:simd`, and the shaped types give them elementwise `+`, `-`, `*` and
named lanes. Reductions, unsigned shapes and boolean lane comparisons
remain ([simd.md](simd.md)).

### Memory and arrays

`FixedArray<T>` is a raw Wasm GC array, with narrow elements packed.
Ranges index arrays (`xs[1..3]`, a copy), take any numeric bound, and
iterate as counting loops. `zena:memory` has typed loads and stores over
linear memory, two allocators, and `@external` imports for host
functions ([linear-memory.md](linear-memory.md)).

### Value types

Records and tuples are value types, and inline tuple and record
parameters pass in locals with no allocation. The roadmap to nominal
value types, a class declared with value semantics and stored inline, is
[#140](https://github.com/elematic/zena/issues/140). That is what makes a
`Complex` or a `Vec3` free.

### Optimizer

The ZIR backend has an inliner at `-O2`, constant folding, GVN and
scalar replacement ([ir.md](ir.md)). Nothing yet measures it on a
floating-point loop.

### Units of measure

Designed in full ([units-of-measure.md](units-of-measure.md)): a unit kind
in the checker, erased before codegen, with literal suffixes and unit
polymorphism, and no compiler-derived conversion in the first version.
Its first step is a set of operator bugs that are still open.

## Gaps

Three gaps matter more than anything else on the list.

**No exponential, logarithm or trigonometry.** Wasm has no instructions
for them, so `zena:math` has `sqrt` and nothing above it. Every language
on Wasm ships its own libm; Zena needs one
([#879](https://github.com/elematic/zena/issues/879)).

**Float `**` is wrong for a non-integer exponent.** The lowering
truncates the exponent to an integer and runs a squaring loop, with `0.5`
special-cased as `sqrt`, so `2.0 ** 0.3` returns `1.0`
([#878](https://github.com/elematic/zena/issues/878)).

**Extension-class edges remain**, under
[#883](https://github.com/elematic/zena/issues/883). Unary `-`
([#233](https://github.com/elematic/zena/issues/233)), relational `<`,
`<=`, `>`, `>=` with `compareTo` fallback
([#253](https://github.com/elematic/zena/issues/253)), generic operator
type-argument substitution
([#232](https://github.com/elematic/zena/issues/232)), and multi-overload
operators by parameter type are implemented and used by `BigInt`,
`Decimal`, `Instant` and `Duration`. Still open are unary `~`
([#237](https://github.com/elematic/zena/issues/237)), `==` on a numeric
extension class without an explicit `operator ==`
([#252](https://github.com/elematic/zena/issues/252)), and `Array<T>`
over an extension class in ZIR
([#234](https://github.com/elematic/zena/issues/234)).

## Plan

### Work that can start now

These need no design decision and do not depend on each other.

- **A libm port in `zena:math`**
  ([#879](https://github.com/elematic/zena/issues/879)): `exp`, `log`,
  `pow`, the trigonometric and hyperbolic functions, `cbrt`, `hypot`,
  from the fdlibm or musl algorithms, tested against correctly rounded
  values with a per-function ULP tolerance. Float `**` then lowers to
  `pow` ([#878](https://github.com/elematic/zena/issues/878)).
- **A seeded pseudorandom generator**
  ([#880](https://github.com/elematic/zena/issues/880)): one fixed
  algorithm, independent streams, and the common distributions.
  Simulation, sampling and randomized tests all assume it.
- **Numeric benchmark kernels**
  ([#881](https://github.com/elematic/zena/issues/881)): nbody,
  spectral-norm, mandelbrot, matmul and saxpy beside the Rust variants
  the suite already builds. Each later step is then measured, and the
  optimizer gaps that numeric loops expose, bounds checks and loop
  invariants that are not hoisted, show up as numbers.
- **`BigInt`** ([#882](https://github.com/elematic/zena/issues/882)),
  which `Rational` and a wide `Decimal` build on.
- **Operator completeness**
  ([#883](https://github.com/elematic/zena/issues/883)): the bugs above,
  plus operator overloads by parameter type. The first consumer is
  `zena:time` ([#136](https://github.com/elematic/zena/issues/136)), and
  the units design's step 1 is done with it.
- **Numeric literals**
  ([#884](https://github.com/elematic/zena/issues/884)): decide the
  exponent grammar ([#235](https://github.com/elematic/zena/issues/235))
  as maximal munch, then exponent literals
  ([#74](https://github.com/elematic/zena/issues/74)), digit separators
  ([#75](https://github.com/elematic/zena/issues/75)) and representation
  suffixes. Code without `6.022e23` is not scientific code, and the unit
  suffixes cannot ship until the grammar is settled.

### Decisions

Three decisions shape the array library and should be made before it is
written. Each has an issue with the options and a recommendation.

**A `Number` interface for generic code**
([#885](https://github.com/elematic/zena/issues/885)). A type parameter
has no operators, so `sum<T>(xs: FixedArray<T>)` cannot be written and
every kernel would exist once per element type. The proposal is a family
of interfaces the numeric primitives satisfy without an `implements`
clause, as `Equatable` and `Hashable` already do, with operators
declared as binary methods over `this`: `Additive`, `Multiplicative`,
`Comparable`, and `Number` for all of them. `defaultValue<T>()` from
`zena:core` is the zero. Under a bound of `T extends Number`, each
instantiation is monomorphized and `total += x` lowers to `f64.add` as
it does today, so the interface appears only as a constraint and codegen
needs nothing new. The subsets are what let user types join generic
code honestly: `Complex` is `Additive` and `Multiplicative` and not
`Comparable`, and `Money * Money` must not type-check. A `Box` that
implements `Number` by forwarding to its primitive covers a `Number`
held as a value.

**The backing store of dense arrays**
([#886](https://github.com/elematic/zena/issues/886)). The earlier
version of this document chose linear memory, for zero-copy BLAS calls
and SIMD loads. The recommendation now is GC arrays for the first
version: they are what the rest of the language stores, so a
`FixedArray<f64>` becomes a matrix without a copy, the engine
bounds-checks them, and nothing frees them. A linear-memory store is
library work on top of the [ownership design](ownership.md), whose
moves, drops and handle kinds are implemented: an allocator whose
pointers are resource classes, so that a dropped matrix frees its block.
That store can come when a measurement asks for it. The costs of GC
arrays are two. SIMD has no load from a GC array, so a kernel that wants
`f64x2` arithmetic stores `v128` elements, which the contract below
allows, or copies to linear memory in bulk
([#248](https://github.com/elematic/zena/issues/248)); a host call per
load would cost more than the two scalar loads it replaces. And a host
BLAS call reads the array through wasmtime's API or a bulk copy, as
described under [Host libraries](#host-libraries). A layout contract
keeps every store a drop-in: row-major, explicit strides in elements,
views that share storage and change only shape, strides and offset, and
a store that is not part of the public API.

**A primitive on the left of an operator**
([#887](https://github.com/elematic/zena/issues/887)). `v * 2.0`
dispatches to `Vector`'s `operator *`; `2.0 * v` has nowhere to go,
because a primitive carries no operators for other types. The
recommendation is a reflected lookup for `*` and `+` only: when the left
operand is a primitive and the right operand's class has an operator
taking that primitive, call it with the operands swapped. Both operators
are commutative for every type this applies to, so the swap cannot be
misread; `-` and `/` are excluded for that reason.

### Work that follows

- **Units of measure**
  ([#893](https://github.com/elematic/zena/issues/893)), steps 2 to 5 of
  its design: declarations and the unit kind, suffixes, polymorphism,
  `zena:units`. Independent of the array work once the operator and
  literal issues are in.
- **`zena:ndarray` and `zena:linalg`**
  ([#888](https://github.com/elematic/zena/issues/888)): shape, strides
  and views; broadcasting; elementwise operations over the numeric
  bound; pairwise reductions; naive then blocked `matmul`; LU, Cholesky,
  QR and Jacobi eigenvalues in pure Zena.
- **Decimals**
  ([#889](https://github.com/elematic/zena/issues/889)): `zena:decimal`
  ships 128-bit IEEE 754-2008 `decimal128` Binary Integer Decimal
  (`Decimal`), nine `RoundingMode` variants, and `DecimalContext`
  (`sigFigs` and `fixedScale`) for single-rounded per-operation
  evaluation. Remaining follow-ups are `_dec` and contextual decimal
  literals ([#913](https://github.com/elematic/zena/issues/913)),
  contextual parameters when callers want an explicit scope-bound
  context, and an `@autoRound` expression macro once expression macros
  land. `Money` is omitted from the standard library because currency
  sets are not fixed; currency types belong in packages built over
  `Decimal`, `i64` or `f64` with [units of measure](units-of-measure.md).
- **Complex numbers and small vectors**
  ([#890](https://github.com/elematic/zena/issues/890)) as case classes
  now and as nominal value types when
  [#140](https://github.com/elematic/zena/issues/140) lands. They are the
  motivating consumers for that work.
- **The `@mat[...]` tagged literal**
  ([#891](https://github.com/elematic/zena/issues/891)), after there is
  a matrix type to construct.
- **Host BLAS and LAPACK**
  ([#892](https://github.com/elematic/zena/issues/892)), after the pure
  Zena baseline exists to compare against.

## Dense arrays

The layout decisions, kept here because the array library, the tagged
literal and the host interface all depend on them.

**Flat storage.** `[[1, 2], [3, 4]]` reads as an array of arrays, and an
array of arrays is the wrong layout: `m[i][j]` chases two pointers, rows
scatter across the heap, and neither SIMD nor BLAS can consume it. A
matrix is one contiguous array with a shape. Row-major order matches
NumPy and C.

**Views.** A matrix carries `shape`, `strides` (in elements) and an
`offset` into its store. A slice, a transpose or a column is a new header
over the same store. A kernel checks once whether the strides are the
contiguous row-major ones and takes a fast path when they are.

**Store.** `FixedArray<T>` for the first version, as decided in
[#886](https://github.com/elematic/zena/issues/886). Two other stores
fit the same header and contract: a `FixedArray<v128>` holding two `f64`
or four `f32` per element, for kernels that want SIMD arithmetic without
leaving the GC heap (a scalar read extracts a lane, selecting by the
index's low bits), and a linear-memory block owned by a resource class,
released by the ownership machinery when the matrix is dropped.

**Small vectors.** `Vec2`, `Vec3` and `Vec4` are not matrices. They are
two to four fields that belong in locals, and the `f32` four-wide one is
an `F32x4`. They become allocation-free with nominal value types.

## Matrix literals

The spelling is `@mat[...]`. `@` is the decorator sigil, and
[decorators.md](decorators.md) already reserves decorating an expression
as the way a macro is applied to it, so a tagged literal is a decorator
applied to a literal: `@mat[[1.0, 0.0], [0.0, 1.0]]`, `@Set[1, 2, 3]`,
`@Complex{re: 1.0, im: 2.0}`. The sigil removes the ambiguity with
indexing, so `mat[...]` without it stays indexing whatever `mat` names,
and no rule about an identifier's category is needed. Tagged literals
over user types are the subject of [macros.md](macros.md); `mat` itself
is a compiler intrinsic, so no macro engine is needed for it.

The intrinsic reads the nested literal for its shape, which must be
rectangular, and stores the elements directly into the matrix's array.
No intermediate array of arrays exists. A literal whose elements are all
constants goes into a data segment and is initialized with
`array.new_data`, which
[#272](https://github.com/elematic/zena/issues/272) asks for in general.
Details in [#891](https://github.com/elematic/zena/issues/891).

## Host libraries

A pure-Zena `matmul` will not match OpenBLAS, and a general eigensolver
or SVD is a large port. The Rust runtime already provides the host
imports behind `zena:error-stack`, `zena:process` and `zena:wasm`, so
the path is a BLAS interface in the same WIT package, which the runtime
implements by linking a BLAS and LAPACK, and which `zena:linalg` uses
when the import is present and falls back from otherwise. That WIT
package is `zena:host` (`packages/stdlib/zena/host-wit/host.wit`).

How a GC-stored matrix reaches the library is the first thing to settle.
The host can read a GC array through wasmtime's `ArrayRef` without any
guest-side copy, one `Val` per element; the runtime measured that path
at 2.4 s/GiB for writes, which beside a BLAS call on a matrix of a few
megabytes is acceptable and beside a vector operation is not. Whether
the reference can reach a host function on the component target before
the Component Model gains GC types is open. The alternative is a bulk
copy to linear memory in the guest
([#248](https://github.com/elematic/zena/issues/248)), which a
linear-memory store would skip. Details in
[#892](https://github.com/elematic/zena/issues/892). WASI-NN is the
standard interface for inference and a separate consideration.

## Use cases

How the four environments map onto this plan, and where the fit ends.

**NumPy.** The closest fit: an n-dimensional array with broadcasting,
views and elementwise functions over `Number`. Static types and
monomorphization put Zena nearer Julia than Python, and a kernel written
in Zena runs as the compiled code it is.

**R.** Columnar data frames, missing values and factors. The
struct-of-arrays layout in [row-types.md](row-types.md) is the data
frame's storage, nullable types cover missing values, and enums cover
factors. A formula language waits on macros.

**MATLAB.** Matrix literals, linear algebra and plots: the tagged
literal, `zena:linalg`, and plotting through `zenafx`. Indexing stays
zero-based.

**Mathematica.** Exact arithmetic and an interactive surface. `BigInt`,
`Rational` and a big float cover exactness. Symbolic algebra is out of
scope. An interactive runner is plausible, since the compiler is fast and
the language service exists, and a notebook kernel is a reasonable later
target.

**Finance.** Exact base-10 decimals (`zena:decimal`) with named rounding
modes and per-operation `DecimalContext`, `Instant` and `Duration` over
integers, and userland currency packages built on
[units of measure](units-of-measure.md) once units land.

## Alternatives considered

**Matrices before operators.** The earlier plan built vectors and
matrices in its third phase and units first, with the operator bugs
unaddressed. A matrix library built that way is written once per element
type and cannot negate a vector. The operator fixes and the `Number`
interface come first.

**Linear memory as the first store.** Deferred for the reasons under
Decisions: GC arrays convert from the rest of the language for free, and
the copy for a BLAS call is a cost to measure rather than a structural
one. The layout contract keeps it a drop-in, and the ownership design
makes it library work.

**Host finalization for linear-memory matrices.** The earlier design
proposed a `dispose()` method plus a JS `FinalizationRegistry` as a
safety net. With GC arrays as the store there is nothing to free, and a
linear-memory store is released by the ownership machinery when its
owner is dropped, so neither is needed.

**Tagged literals by identifier category.** The earlier design spelled
the literal `mat[...]` and told it from indexing by whether `mat` named
a variable or a type. The `@` sigil makes the distinction syntactic.

**Units as a library over extension classes.** Considered and rejected in
[units-of-measure.md](units-of-measure.md): the unit set is closed, the
operator table is quadratic, and the representation is fixed.
