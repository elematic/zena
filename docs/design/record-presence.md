# Presence-Optional Record Fields

Status: **Proposed — review-favored direction** (2026-08-14)

This document designs true presence for optional record fields: a
record typed `{url: String, timeout?: i32}` may or may not *have*
`timeout`, absence is observable, and the consumer supplies defaults
at destructuring. It is the semantic model
[row-types.md](row-types.md) §3.4 deferred as presence polymorphism.
It supersedes [config-records.md](config-records.md): review rejected
type-level defaults as categorically wrong (a type describes shape;
defaults are behavior), so defaults appear **only in destructuring and
spread**. Two representation choices make presence tractable now: a
**presence bitmask** in a single full-width struct, and
**`inline (boolean, T)`** as the accessor shape on the dispatch path.

## 1. Motivation

Type-level defaults (the superseded config-records design) serve
shared option bags but cannot express callee-owned defaults: an
adapter that conditionally sets a field or leaves the decision to the
callee needs absence to *flow through it*. With presence, the
destructured parameter with field defaults — already parsed and
compiled today, with the defaults inert — becomes the natural
signature-visible spelling of consumer defaults:

```zena
let fetch = ({url: String, timeout: i32 = 30_000, retries: i32 = 3})
    => ...;

fetch({url: '/api'});                 // defaults applied in the callee
fetch({url: '/api', timeout: 5});     // presence flows, not values

// The adapter that motivated this: conditionally set, or defer.
function go(timeout: i32): Response {
  var opts: FetchOpts = {url: '/api'};
  if (timeout > 0) { opts = {...opts, timeout: timeout}; }
  return fetch(opts);                 // absent timeout reaches fetch
}
```

Argument explosion and escape analysis can compile presence away where
the literal or the flow is visible; they are optimizations over these
semantics, not part of them.

## 2. Representation: one struct, full width, a mask

Every cost previously attributed to presence came from treating each
present-set as a distinct shape: 2^n struct types, per-present-set
specialization, (shape × type) adaptation. The mask collapses them.

A record type with optional fields compiles to **one wasm struct**:

- a slot for every field, optional or not, in the existing canonical
  sorted order;
- one `$present: i32` field; bit *i* corresponds to the *i*-th
  optional field in sorted order (canonical per interned type);
- absent slots hold the zero value of their type; optional reference
  fields use nullable slots internally regardless of the declared
  type — the mask guards every read, so the placeholder never
  escapes. This is compatible with the post-M4 non-null-field flip:
  only optional slots stay nullable, by design rather than by
  limitation.

`{url: 'x'}` and `{url: 'x', timeout: 5}` checked against
`{url: String, timeout?: i32}` build the *same* struct type with
different mask constants. More than 32 optional fields is a compile
error initially (widen to i64, then a second word, if ever needed).

Primitives are why the mask exists at all: `0` is a valid `i32`, so
absence cannot be a sentinel. For reference fields a null-sentinel
encoding could drop the mask bit, but the uniform mask keeps `?`
orthogonal to the field's own type (`timeout?: Option<i32>` is
expressible — absent vs present-holding-none stay distinct) and keeps
equality and patterns one code path. The slot-plus-bit technique is
also the natural unboxed representation for `Option<T>`-typed fields
themselves, if `Option` moves to an inline representation — the two
features can share machinery.

## 3. Typing

- **Assignability**: a source may omit a target's optional fields
  (restores the rule the self-hosted port lost; the checker's
  `RecordType.optionalProperties` is already plumbed). A required
  field satisfies an optional field of the same name and type; the
  reverse fails.
- **Identity**: optionality is part of the type.
  `{timeout: i32}` and `{timeout?: i32}` are different types — the
  interning key and `typesEqual` must both incorporate it (today both
  ignore it; with `?` rejected that is unobservable, but it is a
  latent bug this work fixes).
- **Coercion**: a required-shape value flowing into an optional-typed
  position builds the wider struct (projection plus mask) — §3.1
  below works the example.
- **Access**: `opts.timeout` on an optional field is a compile error;
  presence must be consumed through a pattern (§4) or the `??` sugar:
  `opts.timeout ?? 30_000` compiles to the guarded read and has type
  `i32`. (This makes the row-types §5.2 access rule real; today the
  checker does not guard it.)

### 3.1 Which values carry a mask, and how maskless values acquire one

Presence tracking is a property of the **type**, not the value's
history: an interned record type has a `$present` field iff it has at
least one optional field, and every value of that type has that
layout. There is no fat pointer and no side channel on the closed
path. The case that must be answered explicitly:

```zena
type FetchOpts = {timeout?: i32};

let opts = {};                    // type {} — no optional fields, no mask
let fetchOpts: FetchOpts = opts;  // FetchOpts has a mask. Where from?
```

The assignment is a **projection copy**: it builds a `FetchOpts`
struct — zero-valued `timeout` slot, mask `0` — from the maskless
`{}` value. Because records are value types with unobservable
identity (records-and-tuples.md §3.1, step V0), the copy is
unobservable; this is the same lowering family as post-flip
width-by-projection, with the mask constant derived from which target
fields the source type has (present) and lacks (absent). The copy
makes **V0 a hard prerequisite** for this feature: under today's
observable `===`, a copy at this boundary could be witnessed.
Contextually-typed literals never hit the copy — `let f: FetchOpts =
{};` builds the `FetchOpts` layout directly.

On the pre-flip dispatch representation the same flow needs no copy:
the fat pointer repacks with an adapted vtable whose getter for the
absent field returns `(false, zero)` (§4) — presence lives in the
choice of adaptation rather than in a mask field. Both
representations answer every presence question identically; which one
a given boundary uses is the closed-vs-existential story of
row-types.md, not part of presence semantics.

## 4. Patterns are the presence API

The pattern grammar already distinguishes the two consumption modes;
presence gives the existing rules their meaning instead of adding
forms:

- **Irrefutable, with default** — `let {timeout = 30_000} = opts;` —
  compiles to mask-test, `struct.get`, select. This is the existing
  "optional requires a default" rule, now with live semantics.
- **Refutable, without default** — `if (let {timeout} = opts) {...}`
  and `match` arms — an optional field named without a default makes
  the pattern *refutable*: the test is the mask bit, the binding is
  the field read. What is currently a bypass hole in the
  requires-default check (the `checkPattern` path never consults
  optionality) becomes the intended behavior of refutable positions.
- Exhaustiveness over presence follows the composite rules
  (pattern-exhaustiveness-composite.md): `case {timeout}` and
  `case {}` cover an optional field.

On the closed/direct representation all of this is inline mask
arithmetic — no calls. On the **dispatch path** (fat pointers, and the
future explicit existential), the vtable getter for an optional field
has the multi-value signature `() -> inline (boolean, T)` — the
`Map.get`/`Iterator.next` shape — and an adapted vtable for a concrete
shape lacking the field returns `(false, zero)`. Virtual multi-value
calls already work in ZIR (`lowerVtableCallMulti`), so this is a
signature variant on existing machinery, not new machinery.

## 5. Semantics that follow

- **Equality and hashing**: masks compare first, then present fields;
  hashing mixes the mask. Consequently absent is observably distinct
  from present-with-the-default-value: `{} != {timeout: 30_000}`.
  This is the point of presence — the config-records model erases
  exactly this distinction, which is why the two features are
  complements, not rivals (§8).
- **Spread**: `{...opts, x: 1}` copies mask bits for optional fields;
  setting an optional field that is absent in the source is presence
  extension within the same type. An *unset* form (remove a field /
  clear a bit — the analogue of JS `delete` in immutable clothing) is
  deliberately deferred; destructure-and-rebuild covers it.
- **Destructured parameters**: `({timeout: i32 = 30_000})` types the
  parameter as `{timeout?: i32}` and applies the default in the
  prologue. The defaults are visible in the signature — this is the
  named-parameters-with-defaults form, owned by the callee.

## 6. Normalization: full records from partial ones

The boundary idiom: accept a presence-optional record, fill defaults
once, then hold a fully-required record whose every later read is
unguarded.

### 6.1 The `Required` and `Partial` type operators

Because optionality is part of the interned type (§3), stripping or
adding it is a type-level rewrite, not a new type constructor:
`Required<FetchOpts>` resolves at annotation time to the same fields
with the optional set empty — an ordinary interned record type — and
`Partial<T>` is the dual (every field optional). Assignability,
equality and interning get nothing new. The names follow TypeScript's
operators. v1 restricts the operand to a concrete record type;
row-generic operands wait for the row machinery (row-types.md §10's
type-operator layer).

### 6.2 Baseline patterns

Both work with §4's machinery alone:

```zena
// Destructure–rebuild:
let {url, timeout = 30_000, retries = 3} = partial;
this.opts = {url, timeout, retries};          // : Required<FetchOpts>

// Guarded-read sugar, field by field:
this.opts = {
  url: partial.url,
  timeout: partial.timeout ?? 30_000,
  retries: partial.retries ?? 3,
};
```

### 6.3 Presence-aware spread: definite + conditional = fallback

The terse spelling is a spread with explicit fallbacks:

```zena
this.opts = {timeout: 30_000, retries: 3, ...partial};
// : Required<FetchOpts> — partial's present fields win, absent ones
// take the explicit values; lowering is one mask-tested select each
```

This extends the extension-spread rules of row-types.md §4 with a
third supply kind. A label in a record literal may be supplied by at
most one **definite** source (an explicit field, or a required field
of a spread) and at most one **conditional** source (an optional field
of a spread):

- definite + definite: error (disjointness, unchanged).
- conditional + conditional: error — there is no order to break the
  tie, and rejecting keeps spread commutative.
- definite + conditional: the field is the conditional value when
  present, else the definite one, and the **resulting field is
  required**.
- conditional alone: the field stays optional in the result (mask bit
  copied).

So the literal above types as `Required<FetchOpts>` exactly when every
optional field has a fallback, and a missing fallback fails
assignability loudly, naming the field.

One deliberate divergence from JavaScript: this rule is
**commutative** — `{timeout: 30_000, ...partial}` and
`{...partial, timeout: 30_000}` both mean *fallback* — where JS
last-wins would read the second as force-override. Force is the
`with` form's job: `{...partial with timeout: 30_000}` sets the field
present with the new value regardless of the prior mask (a
well-defined extension of update to optional fields, since the label
exists in the base's type). Each intent has exactly one
order-independent spelling, and the JS definite-collision idiom
errors with a pointer to `with` instead of silently meaning
something.

## 7. Cost model and optimizations

The unoptimized floor: one i32 field per optional-bearing record, one
mask-test branch (or select) per defaulted read. Everything cheaper is
an optimization over unchanged semantics:

- A literal argument makes the mask a compile-time constant; under
  inlining/explosion (records-and-tuples.md Phase 7, the M3 fixpoint
  loop) the branches fold and the default inlines at the call site —
  the config-records lowering re-derived, per call site, where the
  compiler can see it.
- Exploded signatures carry the mask (or its known bits) as scalars.
- Escape analysis is *not* required for correctness anywhere; the V0
  value-semantics decision already licenses the representation
  changes.

## 8. Relation to config records

The two features answer different questions and compose:

- **Config records** (defaults on the alias, filling at construction)
  answer "this bag has a canonical default configuration" — the
  shared-type story, zero runtime cost, absence erased.
- **Presence** answers "the consumer decides, and absence must flow" —
  callee-owned defaults, adapters, and any case where
  set-to-default and unset differ.

A field is one or the other (`?` with `=` in a type remains an
error). If presence ships first, the config-records constructor form
remains the type-level complement for shared bags; if experience
shows presence covers the config story well enough, config records
can stay shelved — the designs are separable on purpose.

## 9. Implementation plan

**Prerequisite: V0** (the `===`-on-records ban, equality.md D1 /
implementation-plan.md Track V) — §3.1's projection copies are
unobservable only once record identity is. V0 is small and already
first in the plan of record.

Ordered, each stage green under the full suite and fixpoint:

1. **Checker semantics**: optionality in interning and `typesEqual`;
   assignability with omission; the access restriction and `??`
   sugar typing; requires-default confined to irrefutable positions,
   refutable presence patterns typed.
2. **Representation and literals**: mask field in layout, constant
   masks at `struct.new`, nullable internal slots for optional refs;
   required→optional projection.
3. **Patterns**: mask tests in `patternRefutable`/`lowerPatternTest`,
   guarded binds with defaults in `lowerPatternBindings` (the
   AssignmentPattern seams from the destructuring-defaults repair are
   the insertion points).
4. **Equality/hash synthesizers**: mask-aware per-shape `==` and
   `hashCode`.
5. **Dispatch path**: multi-value optional getters and
   `(false, zero)` adapted vtables.
6. **Destructured parameters**: derive `{f?: T}` parameter types from
   defaulted patterns; prologue defaults become live. Portable tests
   throughout; the three deleted optional-field semantics tests
   return as execution tests.
7. **Normalization** (§6): the `Required`/`Partial` operators
   (annotation-time rewrites — can land any time after stage 1); the
   presence-aware spread and `with`-set rules land with the A2
   value-level spread work (row-types.md §4), whose extension/update
   checking they refine.

No stage needs presence polymorphism in the type system (row
variables over optionality stay future work, row-types.md §10), and
none needs the M5 template work — the mask is per-type data, not
per-shape code.

## 10. Open questions

1. **A `record` declaration construct.** Review floated

   ```zena
   record FetchOpts {
     timeout?: i32,
   }
   ```

   as a more concrete-looking declaration than a `type` alias.
   Nothing in this design requires it: presence needs no
   value-namespace name (the superseded constructor form was what
   raised that question, and it died with type-level defaults), and
   records stay structural. A `record` declaration would earn its
   keep only if records grow declaration-attached affordances —
   derived constructors, member functions — at which point the line
   between it and a case class (`class Pair(a, b)`: nominal, final,
   derived `==`/`hashCode`) needs drawing. Deferred until such an
   affordance is actually wanted.
2. **An unset form** — remove a field / clear a presence bit in a
   spread (`delete`'s immutable analogue). Deferred (§5);
   destructure-and-rebuild covers it.
3. **Mask width** past 32 optional fields — widen to i64 or a second
   word; currently a compile error (§2).
4. **`??` sugar scope** — whether `opts.timeout ?? d` is the only
   direct-access affordance, or `"timeout" in opts` narrowing is also
   wanted alongside if-let patterns. The pattern forms are the v1
   answer; `in` stays out unless patterns prove insufficient.
