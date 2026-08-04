# Row Types for Records and Tuples

Status: **Proposed**

This document designs **row polymorphism** for Zena's structural types —
records and tuples — as an incremental, TypeScript-flavored extension:
spread/rest syntax in type position plus row-bounded generics, rather than
a new `ρ`-variable calculus. It revises parts of
[records-and-tuples.md](records-and-tuples.md) (width subtyping, exact
record types, spread) and [destructuring.md](destructuring.md) (rest
patterns, exhaustiveness), and lays shared foundations for a possible
future effect-row system (see [generators.md](generators.md) §8 and the
sequencing note in [concurrency.md](concurrency.md)).

The headline claims, defended below:

1. Rows move record polymorphism from **runtime dispatch** (fat pointers +
   getter vtables) to **compile-time specialization** (monomorphization,
   the machine Zena already runs on) — and on wasm GC those are the _only
   two options_, because `struct.get` requires a static field index.
2. Rows **subsume exact record types**: "exact" stops being a performance
   annotation and becomes what record types mean by default; openness
   moves into function signatures (free after specialization) and into an
   explicit existential form (the one place dispatch remains).
3. Disjoint-by-default spread and exhaustive destructuring fall out of the
   same "rows are sets of labels" discipline, and both are
   loud-by-construction in the way this project prefers.

## 1. Motivation

Three pressures converge:

- **The fat-pointer tax.** Today's records use width subtyping ("behaves
  like interfaces", records-and-tuples.md §5.1), implemented as a fat
  pointer with a vtable of getter functions and a `call_ref` per field
  access (§Phase 4), plus rewrapping at every width coercion. §5.4 then
  enumerates static escape hatches to claw back the common cases. Rows
  make the escape hatches the semantics.
- **The exact-records tension.** §5.3 proposes `exact` record types as a
  perf opt-out of width subtyping, syntax TBD (Phase 6, unimplemented).
  That splits records into two kinds the user must choose between for
  performance reasons. Rows dissolve the split (§6).
- **The TS patterns are already rows.** `<T extends {x: number}>(p: T): T`
  to avoid losing fields through a function, `Pick`/`Omit`/`keyof`, spread
  typing — these are folk row polymorphism. Zena can offer the principled
  versions with syntax TS users already know, and — unlike TS — compile
  them to direct field access.

A fourth, strategic pressure: **effect rows** (the generalized
`gen`/`async` design sketched in generators.md §8) need the same type
machinery. Records are the low-risk place to build and evaluate it (§8).

### 1.1 Prerequisite decision: records are value types

This design builds on the decision recorded in
[records-and-tuples.md](records-and-tuples.md) §3.1: **records and
tuples are value types with permanently unobservable identity** (`===`
on record operands becomes a compile error; boxing is an implementation
detail). Several lowerings below are sound only under that decision —
width-by-projection (§3.2), re-layout at shared boundaries (§7.4), and
SoA scattering of record collections. Row-generic specialization itself
is identity-agnostic (the callee receives the caller's own reference),
but the design as a whole assumes the value-semantics contract. An
earlier draft of this document wrongly assumed identity was already
unobservable; in fact today's `===` observes record identity through
width adaptation, and tests pin it — §3.1 of the records doc states the
current behavior precisely and sequences the change.

## 2. Background: rows in ninety seconds

A **row** is a finite map from labels to types, possibly with a variable
"tail" standing for the labels not mentioned:

- **Closed row**: `{x: i32, y: i32}` — exactly these fields.
- **Open row (universal)**: `{x: i32, ...R}` — field `x` plus whatever
  `R` names; `R` is a type parameter. A function generic over `R` works
  for _every_ concrete tail — and in a monomorphizing compiler is
  compiled separately for each tail that actually occurs.
- **Open row (existential)**: `{x: i32, ...}` — field `x` plus _unknown_
  others, erased at rest. This is a runtime concept: values of different
  concrete shapes stored behind one type.

Rows come with **lacks constraints**: `{x: i32, ...R}` is well-formed
only when `R` does not itself contain `x`. Extension (add a field:
requires absence) and update (replace a field: requires presence) are the
two primitive operations. Everything in this document is these three
ideas wearing TypeScript syntax.

The crucial distinction from width **subtyping**: subtyping _forgets_
(once `{x,y,z}` flows into `{x: i32}`, the `y` and `z` are gone from the
type, and the value must carry a uniform runtime representation so the
narrow code can access it). Row polymorphism _tracks_ (the tail rides
along in the type, and every access site is compiled against a concrete
shape). Forgetting forces dispatch; tracking permits specialization.

## 3. Surface design

### 3.1 Row-bounded generics

Two new generic bounds:

```zena
<R extends record>   // R ranges over record rows
<R extends tuple>    // R ranges over tuple shapes
```

Used with **type-level spread**:

```zena
type WithId<R extends record> = { id: string, ...R };

type ExtendedUser<R extends record> = { id: string, name: string, ...R };

type CoreRoutes<R extends tuple> = [ "Home", "About", ...R ];
```

Instantiation substitutes the concrete row:

```zena
type User = ExtendedUser<{ email: string }>;
// = { id: string, name: string, email: string }
```

Row-generic functions are the payoff:

```zena
// Preserves the caller's full type — the TS `<T extends {x}>` pattern,
// but compiled to direct struct.get per instantiation:
let translate = <R extends record>(p: { x: i32, y: i32, ...R }, dx: i32)
    : { x: i32, y: i32, ...R } => {
  return { ...p with x: p.x + dx };
};

let p3 = translate({ x: 1, y: 2, z: 3 }, 10);  // p3.z is still typed
```

**Implied lacks constraints.** Writing `{ id: string, ...R }` implicitly
constrains `R` to lack `id` (and `name` too, in `ExtendedUser`). The
constraint is checked at instantiation; `ExtendedUser<{name: string}>` is
an error at the use site, naming the colliding label. There is no
TS-style silent overwrite or intersection-to-`never` collapse.

Spreading **concrete** types is also allowed, giving composition without
intersection types:

```zena
type Timestamps = { createdAt: i64, updatedAt: i64 };
type PostRow = { title: string, ...Timestamps };        // concrete spread
type Audited<R extends record> = { ...Timestamps, ...R }; // R lacks both
```

### 3.2 Closed by default; width by projection; `...` for existential

A record type with no spread is **closed**: it denotes exactly those
fields and compiles to a concrete struct with direct access. Closed is a
statement about **representation**, not an assignability wall:

- **Record literals check exactly** against their contextual type —
  extra fields are errors. This is TypeScript's excess-property checking
  as a language rule rather than a freshness heuristic (TS needed the
  heuristic precisely because width subtyping is its default, and the
  heuristic leaks through intermediate variables and unions). Misspelled
  option keys become compile errors, which is most of what "strictness"
  buys configs.
- **Previously-typed wider values coerce to narrower closed types by
  projection**: `let p2: {x: i32, y: i32} = point3d` compiles to
  constructing the narrow shape from the wide value's fields (or to a
  declared-subtype view, or to nothing at all under argument explosion —
  the lowerings are interchangeable because records have no observable
  identity, §1.1). This preserves the "almost-free polymorphism" of
  width subtyping between statically-known shapes: cost is one boundary
  conversion, never per-access dispatch, and it dissolves entirely when
  the target is an exploded parameter.

Projection is exactly the mechanism that **cannot** work for classes
(identity + mutable fields forbid copying), which is why classes still
reach record-typed positions only via row-generic bounds or the
existential — the line falls where the semantics put it.

The remaining case — shapes **not** statically known — is the
existential open record:

```zena
{ x: i32, y: i32 }        // closed: exactly x and y
{ x: i32, y: i32, ... }   // existential: x and y, plus unknown others
```

Assigning a wider value to an existential type is the **pack point** —
the one place a fat pointer is built (§7.3). The four situations and
their costs:

| Need                                   | Form                        | Cost                           |
| -------------------------------------- | --------------------------- | ------------------------------ |
| A concrete data shape                  | closed `{x: i32}`           | direct `struct.get`            |
| Width flow between static shapes       | closed → closed             | one projection at the boundary |
| A function accepting many shapes       | `<R>` + `{x: i32, ...R}`    | direct, per instantiation      |
| _Storing_ heterogeneous shapes at rest | existential `{x: i32, ...}` | fat pointer, getter dispatch   |

The design intent: the dispatch cost that today appears _silently
wherever the optimizer loses the shape_ instead appears _exactly where
the type says the shape is unknown_, and nowhere else.

Classes interact per form: a class can instantiate a row-generic bound
(the specialization reads the class's fields directly — faster than
today's §8.2 dispatch path) and can pack into an existential (as today);
a class is never assignable to a _closed_ record type (closed means
"record value of exactly this shape").

### 3.3 Tuples

Tuple rows are positional, so "lacks" is replaced by a uniqueness rule:
**at most one row variable per tuple type** (otherwise splitting
`[i32, i32]` across `[...A, ...B]` has no unique solution — the same
reason TS restricts inference around variadic tuples). Concrete spreads
compose freely:

```zena
type Vec2 = [f32, f32];
type Vec3 = [...Vec2, f32];                       // concrete concat
type Prepend<T, R extends tuple> = [T, ...R];     // one variable, any position
type CoreRoutes<R extends tuple> = ["Home", "About", ...R];
```

Value-level tuple spread and rest destructuring
(`let (head, ...tail) = t;`) are the term-level mirror — already listed
as "Future" in destructuring.md; rows give them their types.

A note for later: Zena's `inline` tuples (multi-value returns, the
`Iterator.next()` protocol shape) are tuples too. Row-generic code over
inline tuples would mean multi-value-signature polymorphism —
potentially useful for the signature-specialization pass in
[ir.md](ir.md) §9, out of scope here.

### 3.4 Optional fields

Today's `?` fields (records-and-tuples.md §5.2) are presence-variation
inside one type — which in row terms is **presence polymorphism**, a
heavier feature than v1 should carry. Interim position:

- `?` fields are permitted on **existential** records (where dispatch
  machinery exists anyway — this is today's implementation) and on
  **function parameter** records, where every call site has a concrete
  literal shape and the function specializes per present-set, so
  "optional" costs nothing (this is the option-bag pattern, and argument
  explosion — records doc Phase 7 — composes with it).
- `?` on a closed record type elsewhere (e.g. a class field's type) is
  rejected in v1 with a pointer to the existential form.

Full presence polymorphism (rows over `label: present|absent`) is listed
as future work (§10).

### 3.5 Default-bearing record types (config records)

The dominant record use cases are configs and named-parameter emulation,
and most "optional" fields there mean _"absent = use the default"_ — not
"absence is meaningful." That case deserves a first-class form that
never pays presence tracking:

```zena
type ServerOpts = {
  host: string = "localhost",
  port: i32 = 8080,
  tls: boolean = false,
};

let s = new Server({ port: 8080 });   // host and tls filled statically
```

- A literal checked against a default-bearing type may omit any
  defaulted field; the **construction site** fills it in. The layout is
  always the full shape — the type stays closed and exact downstream, no
  presence bits, no dispatch, and unknown keys are still errors
  (excess-property rule, §3.2).
- Combined with option-bag constructors and single-shot `struct.new`
  construction (ir.md §12.1, post-M4), this retires the
  new-then-imperatively-assign config idiom: terse call sites,
  immutable fields.
- The escape hatch when "explicitly set to the default" must be
  distinguishable from "absent" is a nullable field or true `?` (§3.4).

Open design point: defaults make the type declaration carry _values_
(evaluated where? — restrict to constant expressions initially), and
they interact with `with`-update and destructuring defaults; spelled out
at implementation time. Status: proposal, wanted for the config story.

## 4. Value-level spread: extension and update

Two operations, both loud, mapping to the two row primitives:

**Extension** — `{ ...base, x: 42 }` — requires `base` **lacks** `x`.
Adding a field that's already there is an error, not an override:

```zena
let a = { x: 1, y: 2 };
let b = { ...a, z: 3 };    // ✅ {x, y, z}
let c = { ...a, x: 9 };    // ❌ error: `a` already has `x` — use `with`
let d = { ...a, ...other } // ✅ iff fields of `a` and `other` are disjoint
```

**Update** — `{ ...base with x: 42 }` (spelling open, §11; `with` is
already a keyword) — requires `x` **present** in `base`, and the new
value assignable to the field's type:

```zena
let moved = { ...p with x: p.x + dx };   // ✅ p has x
let typo  = { ...p with z: 3 };          // ❌ error: p has no `z`
```

Why disjoint-by-default extension (the non-overlap rule proposed in
review):

- **It catches real bugs.** JS's last-wins spread silently shadows;
  every overlapping spread is either a typo or an intended override, and
  the two deserve different spellings.
- **It makes spread order-independent.** Disjoint extension is
  commutative, so `{...a, ...b}` ≡ `{...b, ...a}` — record construction
  stays canonical (matching the checker's existing sorted-field
  interning) and no reader ever reasons about precedence.
- **It's the row-calculus native rule.** Extension under a lacks
  constraint is what makes row inference simple and principal; last-wins
  is what makes TS spread typing approximate.

The JS idiom this displaces — `{...defaults, ...userOpts}` — becomes the
update form, and gets _better_:

```zena
let opts = { ...defaults with ...userOpts };
// every key in userOpts must exist in defaults — option typos are
// compile errors instead of silently-ignored keys
```

Spreading an **existential** record is rejected (its full field set is
unknown, so neither disjointness nor the result type is decidable) —
this also resolves the semantic landmine in today's design, where spread
of a width-narrowed value either drops fields the runtime value has or
copies fields the type doesn't admit. Destructure the fields you need,
or keep the value packed.

## 5. Destructuring: exhaustive by default, rest for the rest

For **closed** records, destructuring patterns must account for every
field:

```zena
type User = { id: i32, name: string, email: string };

let { id, name } = user;             // ❌ error: `email` unaccounted for
let { id, name, ..._ } = user;       // ✅ rest explicitly ignored
let { id, name, ...contact } = user; // ✅ contact: { email: string }
let { id, name, email } = user;      // ✅ exhaustive
```

This is the "don't accidentally miss a field" guarantee: adding a field
to a record type turns every non-rest destructuring of it into a compile
error — each site then decides to handle the new field or explicitly
discard it. (Precedent: match exhaustiveness in
[pattern-exhaustiveness-composite.md](pattern-exhaustiveness-composite.md);
this is the irrefutable-pattern analogue.)

On **row-generic** values, `...rest` binds the tail at its row type —
which is what makes `Omit`-style code first-class instead of a type
operator:

```zena
let dropId = <R extends record>(r: { id: i32, ...R }): { ...R } => {
  let { id as _, ...rest } = r;
  return rest;
};
```

On **existential** records, exhaustiveness is impossible by definition;
patterns extract named fields via dispatch (today's behavior) and
`...rest` is unavailable.

Codegen: rest patterns on closed/row-generic values compile to a
`struct.new` of the residual shape (statically known per instantiation)
— an allocation, unless the residual's uses let SRoA (ir.md §9)
scalarize it. `..._` compiles to nothing.

Tuple rest patterns (`let (head, ...tail) = t`) follow the same rules
positionally.

## 6. Interaction with exact record types: subsumption

The `exact` proposal (records-and-tuples.md §5.3, Phase 6) exists to buy
back direct field access from width subtyping. Under this design its
three properties are the _default_:

| §5.3 exact records                   | This design                                      |
| ------------------------------------ | ------------------------------------------------ |
| No width subtyping                   | Closed representation; width = projection (§3.2) |
| No optional fields                   | §3.4: `?` restricted; §3.5 defaults for configs  |
| Direct `struct.get`                  | Default for closed and row-generic access        |
| Opt-in syntax TBD (`exact`/`!`/attr) | Not needed — nothing to opt into                 |

So: **do not build Phase 6.** The syntax question dissolves; `exact` as
a keyword never ships. What remains of §5.4's "dispatch optimization"
work is the existential path only, and it stops being
performance-critical because hot code has no reason to route through
existentials.

The migration story for the width-subtyping default is in §9.

## 7. Compilation and the wasm GC mapping

### 7.1 Why wasm GC subtyping cannot carry width subtyping

Wasm GC struct subtyping is **declared and single-inheritance**: a struct
type names at most one supertype (`sub $super`), and its fields must
extend the supertype's fields as a **prefix** (with immutable-field
covariance). Structural width subtyping needs the full subset lattice:
`{x, y}` is a subtype of both `{x}` and `{y}` — two supertypes, whose
field orders conflict (`{x}` wants `x` first; `{y}` wants `y` first). The
checker's canonical sorted-field order salvages only _chains_ (`{a}` <:
`{a, b}` works as a declared prefix; `{b}` <: `{a, b}` cannot exist).

So on this target there are exactly two implementations of
polymorphic field access, with nothing in between:

- **Dispatch**: erase to `anyref` + a vtable of getter functions — the
  current fat pointer (records doc Phase 4).
- **Specialization**: monomorphize until every access names a concrete
  struct type and a static field index.

(There is no third option of passing field offsets at runtime:
`struct.get` takes an immediate index, not an operand. This is the same
"wasm GC cannot express the alternative" situation as ir.md §4.1.)

Rows are the type-system discipline that makes the specialization option
apply to _polymorphic_ code, not just statically-known shapes.

### 7.2 The three forms, compiled

- **Closed record** → one concrete `WasmStruct` per canonical row
  (the interning key already exists — records doc Phase 5). Declared
  `final`, no supertype: engines get exact-type knowledge, `ref.test`/
  `ref.cast` on record types stay cheap, and GVN/devirt see through
  accesses. Field access is `struct.get` with a static index. Structural
  equality specializes per shape.
- **Row-generic function** → monomorphized per instantiated tail,
  exactly like `Box<T>` per type argument (generics.md). Inside a
  specialization the row is concrete, so _every_ field access — including
  accesses to spread-provided fields — is direct. Instantiations are
  keyed by canonical row, deduplicated module-wide.
- **Existential record** → the current fat pointer: `(anyref instance,
ref $GetterVTable)`. Built at the pack point (§3.2), one vtable per
  (concrete shape → existential type) pair, reusing the Phase 4
  machinery unchanged. Field access is one `call_ref`.

**Width coercion (closed → closed)** lowers, per site, to whichever is
cheapest — all indistinguishable under value semantics (§1.1):
_projection_ (one `struct.new` of the narrow shape), _explosion_
(nothing at all, when the target is an exploded parameter or multi-value
position), or a _declared-subtype view_ (zero-cost `ref` reuse when the
narrow shape is a sorted-order prefix of the wide one — the one slice of
width that wasm's declared subtyping can express, §7.1).

**Spread codegen**: extension and update on closed/row-generic values
compile to a single `struct.new` of the result shape with operands drawn
from the source's fields (statically known) and the new values — no
loops, no reflection. Under template ZIR (ir.md §8), per-instantiation
bodies are array-copy + table-patch, so stamping out spread
specializations is cheap at compile time too.

### 7.3 Does this help or worsen the fat-pointer problem?

**Help — structurally.** Every place a fat pointer is built or rewrapped
today corresponds to a width coercion; under rows those sites become
(a) a projection/explosion at a static boundary, (b) a row-generic
instantiation — no fat pointer, direct access — or (c) for literals with
junk keys, a type error. Packing survives only at explicit `...`
boundaries.
Dispatch becomes rare, visible in the source, and stable under
refactoring (it can't reappear because an optimization got weaker —
contrast §5.4's "the compiler aggressively optimizes this away when
types are statically known").

**The cost shifted, not conjured away — two honest risks:**

1. **Monomorphization pressure.** Rows add an instantiation axis
   (function × tail), and monomorphization explosion is already the
   compiler's headline compile-time problem (ir.md §1). Mitigations, in
   order: canonical-row interning (exists); template ZIR (M5) making
   each instantiation a memcpy-and-patch; and a future sharing
   refinement — key specializations by the _layout of the fields the
   body actually touches_ rather than the full row, so `{x: i32, y: f64}`
   and `{x: i32, y: f64, z: string}` share code for a body that only
   reads `x` when `x`'s slot coincides. Sequencing consequence: ship
   row generics after or alongside M5, not long before.
2. **Existential overuse.** TS-trained users may write `{x: i32, ...}`
   reflexively, recreating today's dispatch-everywhere world with extra
   steps. The defaults defend against this: the terse spelling is
   closed, the generic form is the documented "accept many shapes"
   idiom, and the existential requires visible extra syntax. Lint-level
   guidance ("existential record in a hot signature") can come later
   under `ZENA_ZIR_STATS`-style counters.

Net: fat pointers go from the _default representation of record
polymorphism_ to a _storage feature you ask for by name_.

### 7.4 Size mode: shared lowering through the existential

Zena's planned size/speed flag for generics (generics.md §Future
Considerations: specialize primitive type arguments, share code for
reference arguments behind a runtime representation) translates to rows
— and more cleanly than to class generics, because **the row design
already contains its own erased form: the existential is the erasure of
the universal.**

`<R extends record>(p: {x: i32, y: i32, ...R})` admits two lowerings
with identical semantics:

- **Speed mode**: one specialization per instantiated tail (§7.2) —
  direct access, duplicated bodies.
- **Size mode**: one shared body compiled against the existential form
  `{x: i32, y: i32, ...}`; call sites perform the pack coercion the type
  system already defines. (The Rust analogy: generic `fn` vs
  `dyn Trait` — except here both are lowerings of one declaration, so
  the flag chooses instead of the programmer.)

Properties of the shared lowering:

- **The "runtime tag" is a getter vtable, not a tag** — different tails
  move field offsets, and `struct.get` needs a static index, so the
  dictionary must carry accessors. This is the records Phase 4 machinery
  reused.
- **Primitives never box.** Getter signatures are fixed by the row
  bound's known fields (`getX(): i32` returns a bare `i32`) — the
  analogue of "always specialize primitive type arguments" is inherent.
- **No allocation at the boundary.** The shared body takes
  `(instance, vtable)` as two parameters; pack is "pass two refs." The
  per-call cost is one `call_ref` per field access plus one tiny
  per-(shape, bound) accessor thunk — versus a whole duplicated body per
  tail in speed mode.
- **Mixing is sound, per instantiation.** Because universal → existential
  coercion always exists, hot instantiations can specialize while the
  long tail routes through the shared body — enabling body-size ×
  instantiation-count heuristics, `ZENA_ZIR_STATS` accounting of where
  the bytes went, and later PGO promotion.
- **Prefix bonus**: when the bound's known fields are a sorted-order
  prefix of every instantiating shape, declared wasm subtyping lets even
  the shared body read those fields with direct `struct.get` (§7.1's
  chain case) — free when it fires, detectable per bound.
- **Value semantics adds a tool** (§1.1): re-layout by copy at the
  shared boundary is legal, so the compiler may canonicalize an argument
  into a bound-preferred layout for direct access at the cost of one
  small copy — a door identity semantics would have closed.
- **Opt-outs**: operations needing the whole shape (`...rest`, spread of
  a row-generic value) can't run against the erased form without
  per-shape helper thunks; v1 rule: using them forces specialization of
  that function, stated loudly.

Nothing in the checker changes between modes; this is purely a backend
choice, and it slots into the same `-Ospeed`/`-Osize` flag matrix the
generics doc proposes.

## 8. Effects: what carries over

Record rows and effect rows are the same algebra (PureScript and Koka
share the implementation between records and effects). If Zena later
generalizes `gen`/`async` per generators.md §8, the reusable pieces
built here are:

| Built for record rows                                  | Reused by effect rows                           |
| ------------------------------------------------------ | ----------------------------------------------- |
| Row unification + inference in checker                 | Effect-row inference on function types          |
| Lacks constraints, instantiation checks                | Handler discharge (`handle` removes a label)    |
| Canonical row interning                                | Effect-row identity, ABI keys                   |
| Monomorphization over row parameters                   | Color specialization ("compile per effect row") |
| Diagnostics vocabulary (missing/extra/colliding label) | Unhandled-effect / unforwardable-effect errors  |

Two deliberate biases this design bakes in, both fine for effects v1:
rows are **sets** (disjointness — no duplicate labels; Koka's scoped
duplicate effects would be a later generalization), and row variables
are **inferable at instantiation sites** (no user-facing `ρ` syntax).

The strategic value runs both directions. Forward: if record rows prove
ergonomic — if the error messages land, if the instantiation costs stay
tame — the type-system half of userland effects is de-risked before any
commitment to them. Backward: if record rows turn out to be an
ergonomics problem in practice, that is decisive evidence _against_
effect rows, learned on a feature that is independently useful. Either
outcome pays.

## 9. Sequencing and migration

> The cross-track plan of record — generators/async first, the
> equality/identity contractions (V0/V1/V2), this document's additive
> track, and the flip — is
> [implementation-plan.md](implementation-plan.md). The R1/R2/R3
> structure below is the rows-specific detail it references (its
> tracks A and R3).

The breaking piece is the **closed-by-default flip** (§3.2): today's
records are width-subtyped, and the shared portable test suite runs
against both compilers. Changing record defaults self-hosted-only would
fork test _expectations_ across the suite — much worse than the additive
`// @skip: bootstrap` divergences (new features the bootstrap simply
never sees). Two viable orderings:

- **A (recommended): additive now, flip at bootstrap retirement.**
  - **R1 (additive, self-hosted only, `@skip: bootstrap`):** row-bounded
    generics (`R extends record` / `R extends tuple`), type-level
    spread, lacks constraints, monomorphized instantiation. No change to
    existing record semantics — closed types don't exist yet; row
    generics operate over today's record types.
  - **R2 (additive):** value-level extension spread with disjointness,
    the `with` update form, rest patterns in destructuring
    (destructuring.md already reserves the syntax).
  - **R3 (breaking, at bootstrap retirement):** one migration event for
    record semantics: flip un-spread record types to closed
    (width-by-projection replaces adaptation between static shapes);
    introduce `...` existential syntax; **land the value-semantics
    decision** (records-and-tuples.md §3.1 — `===` on records becomes a
    compile error; the two identity execution tests convert to
    expected-error tests; explosion/sinking/projection become
    unconditional); migrate remaining width call sites to row generics
    or existentials; exhaustive destructuring turns on with closed
    types. Delete the Phase 6 `exact` plan.
- **B: flip in both compilers now.** Implements row checking twice,
  including once in a compiler scheduled for deletion. Rejected for the
  same reason ir.md §12.1 deferred non-null fields past M4.

R1/R2 are pure wins on their own (TS-style shape-generic code with
direct access; safer spread), and they front-load exactly the machinery
(unification, lacks, instantiation) whose ergonomics we want to evaluate
before the effects decision.

## 10. Deliberately out of scope (v1)

- **Label/`keyof` types and `Pick`/`Omit`-style type operators** —
  §5's first-class `...rest` covers the main use; type-level label
  manipulation is a later, orthogonal layer.
- **Presence polymorphism** (rows over optional-ness) — §3.4's
  restriction stands until there's evidence `?` needs to generalize.
- **Multiple row variables per record type** (`{...A, ...B}` with both
  generic) — inference loses principal types; one variable + concrete
  spreads covers composition.
- **Duplicate/scoped labels** (Koka-style) — rows are sets here.
- **Intersection types** — concrete type-level spread (§3.1) is the
  bounded, canonical-order replacement for the composition use case.
- **Row-typed classes/interfaces** — rows are for structural types;
  nominal types keep nominal rules (generics.md variance design
  unchanged).

## 11. Open questions

1. **Update-form spelling**: `{ ...base with x: 42 }` reuses an existing
   keyword and reads well, but `with` is mixin-application syntax on
   classes — same keyword, two meanings. Alternatives: `{ base | x: 42 }`
   (Elm), a distinct spread token.
2. **Existential spelling**: bare `...` (`{x: i32, ...}`) vs `...?` vs
   `...unknown`. Bare `...` is proposed; confirm it doesn't collide with
   future rest-pattern-in-type-position ambiguities in the parser.
3. **Bound syntax**: `R extends record` / `R extends tuple` use soft
   contextual keywords (`record` is not currently reserved). Reserve, or
   spell as `R extends {}` / `R extends []`?
4. **Tuple type syntax consistency**: records-and-tuples.md uses both
   `(i32, string)` (§2.2) and `[f32, f32, f32]` (§5.2); destructuring.md's
   grammar uses `[...]` for tuple patterns while its examples use
   `( , )`. Row syntax (`[T, ...R]`) reads best with brackets; this
   should force the standardization decision.
5. **Structural equality across forms**: is a packed existential `==`
   comparable to a closed record of the same underlying shape? (Proposed:
   yes — equality is defined on the underlying shape; the existential's
   vtable carries an equality slot, mirroring interface dispatch.)
6. **Instantiation blowup telemetry**: emit per-function
   row-instantiation counts under `ZENA_ZIR_STATS` from day one, so the
   §7.3 risk is a number we watch, not a surprise.
7. **Should closed-record exhaustive destructuring extend to `match`
   record patterns** in the same release, for consistency with
   pattern-exhaustiveness-composite.md?
