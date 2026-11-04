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
operations Wasm has instructions for, and the 128-bit wide arithmetic
intrinsics `mulWide`, `add128` and `sub128`.

### Operators on user types

A class can declare `operator +`, `-`, `*`, `/`, `**`, `==`, `[]` and
`[]=`. An extension class over a primitive can declare the same, and is
erased, so a `Celsius on f64` costs a call per operation and no
allocation. `zena:simd`'s `F32x4` and siblings are built this way over
`v128`.

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

**Operator dispatch is incomplete**, in ways that every numeric type hits
at once. Unary minus never dispatches
([#233](https://github.com/elematic/zena/issues/233)), relational
operators never dispatch
([#253](https://github.com/elematic/zena/issues/253)), an operator on a
generic class does not substitute its type arguments
([#232](https://github.com/elematic/zena/issues/232)), a second
`operator -` with a different parameter type is never considered, `==`
on a numeric extension class is an internal compiler error
([#252](https://github.com/elematic/zena/issues/252)), and `Array<T>`
over an extension class fails in ZIR
([#234](https://github.com/elematic/zena/issues/234)). `Instant` and
`Duration` spell ordering as methods because of these, and units,
`Complex`, `Decimal`, `BigInt` and any matrix type would each hit them in
turn. Tracked together as
[#883](https://github.com/elematic/zena/issues/883).

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

**A numeric bound for generic code**
([#885](https://github.com/elematic/zena/issues/885)). A type parameter
has no operators, so `sum<T>(xs: FixedArray<T>)` cannot be written and
every kernel would exist once per element type. The recommendation is a
builtin bound, `where T: numeric`, satisfied by the numeric primitives,
inside which the arithmetic operators and contextually typed literals are
allowed on `T`. Monomorphization already gives each instantiation the
concrete type, so the change is in the checker. It is written so that an
interface the primitives implement through their extension classes can
replace it later, which is what would let user types such as `Complex`
satisfy it.

**The backing store of dense arrays**
([#886](https://github.com/elematic/zena/issues/886)). The earlier
version of this document chose linear memory, for zero-copy BLAS calls
and SIMD loads. The recommendation now is GC arrays for the first
version: nothing frees them, the engine bounds-checks them, and the
ownership design that would release linear memory is not built. The
costs are that SIMD loads need linear memory unless the element type is
`v128`, and a host BLAS call copies out and back. A layout contract keeps
a linear-memory store a later drop-in: row-major, explicit strides in
elements, views that share storage and change only shape, strides and
offset, and a store that is not part of the public API.

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
- **Fixed-scale decimals**
  ([#889](https://github.com/elematic/zena/issues/889)): `Money` over
  `i64` as an erased extension class, which needs only the operator
  fixes, then a 128-bit `Decimal` with a per-value scale.
- **Complex numbers and small vectors**
  ([#890](https://github.com/elematic/zena/issues/890)) as case classes
  now and as nominal value types when
  [#140](https://github.com/elematic/zena/issues/140) lands. They are the
  motivating consumers for that work.
- **The `mat[...]` tagged literal**
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
[#886](https://github.com/elematic/zena/issues/886). A linear-memory
store, when the ownership work gives it a release mechanism, has the
same header and the same contract.

**Small vectors.** `Vec2`, `Vec3` and `Vec4` are not matrices. They are
two to four fields that belong in locals, and the `f32` four-wide one is
an `F32x4`. They become allocation-free with nominal value types.

## Matrix literals

`mat[...]` is an identifier followed by a bracketed literal. The parser
cannot tell it from indexing, so the identifier's category decides: a
variable is always indexed, and a type or a macro is a tag. A variable
cannot be a tag. The same rule gives `Set[1, 2, 3]` and
`Complex{re: 1.0, im: 2.0}` as tagged literals over user types, which is
the subject of [macros.md](macros.md); `mat` itself is a compiler
intrinsic, so no macro engine is needed for it.

The intrinsic reads the nested literal for its shape, which must be
rectangular, and stores the elements directly into the matrix's array.
No intermediate array of arrays exists. A literal whose elements are all
constants goes into a data segment and is initialized with
`array.new_data`, which
[#272](https://github.com/elematic/zena/issues/272) asks for in general.
Details in [#891](https://github.com/elematic/zena/issues/891).

## Host libraries

A pure-Zena `matmul` will not match OpenBLAS, and a general eigensolver
or SVD is a large port. The Rust host already provides the
`zena-cli:host` imports, so the path is a `zena-cli:blas` WIT interface
the host implements by linking a BLAS and LAPACK, with `zena:linalg`
choosing between a pure-Zena backend and the host one by whether the
import is present. GC-stored arrays copy to linear memory for the call
([#248](https://github.com/elematic/zena/issues/248) asks for the bulk
copy); a linear-memory store passes its pointer. Details in
[#892](https://github.com/elematic/zena/issues/892). WASI-NN is the
standard interface for inference and a separate consideration.

## Use cases

How the four environments map onto this plan, and where the fit ends.

**NumPy.** The closest fit: an n-dimensional array with broadcasting,
views and elementwise functions over a numeric bound. Static types and
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

**Finance.** Exact decimals with named rounding modes, `Instant` and
`Duration` over integers, and units for currencies once units land. The
`Money` type ships first because it needs the least.

## Alternatives considered

**Matrices before operators.** The earlier plan built vectors and
matrices in its third phase and units first, with the operator bugs
unaddressed. A matrix library built that way is written once per element
type and cannot negate a vector. The operator fixes and the numeric bound
come first.

**Linear memory as the first store.** Rejected for the first version
for the reasons under Decisions: no release mechanism yet, and the copy
to linear memory for a BLAS call is a measurable cost rather than a
structural one. The layout contract keeps it available.

**Host finalization for linear-memory matrices.** The earlier design
proposed a `dispose()` method plus a JS `FinalizationRegistry` as a
safety net. With GC arrays as the store there is nothing to free, and
when a linear-memory store arrives the ownership design is its release
mechanism, so neither is needed.

**Units as a library over extension classes.** Considered and rejected in
[units-of-measure.md](units-of-measure.md): the unit set is closed, the
operator table is quadratic, and the representation is fixed.
