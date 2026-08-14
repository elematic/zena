# Config Records: Default-Bearing Record Types

Status: **Plan of record** (2026-08)

This document is the full design for the proposal sketched in
[row-types.md](row-types.md) §3.5 (track A3 in
[implementation-plan.md](implementation-plan.md)): record types whose
fields carry default values, so that a record literal may omit them and
the compiler fills them in at the construction site. It resolves the
open points §3.5 deferred — where defaults live, where they are
evaluated, and how they interact with optional fields, spread, and
destructuring.

## 1. Motivation

The target idiom is named parameters via records, especially for
constructors:

```zena
type ServerOpts = {
  host: String = 'localhost',
  port: i32 = 8080,
  tls: boolean = false,
};

class Server {
  host: String;        // immutable
  port: i32;           // immutable
  tls: boolean;        // immutable
  new(opts: ServerOpts)
    : host = opts.host, port = opts.port, tls = opts.tls {}
}

let s = new Server({port: 9090});   // host and tls filled at this call
```

Without defaults, every optional knob forces one of: a long positional
parameter list, presence-optional fields (`?`, a heavier feature — §5),
or the construct-then-assign idiom that forces fields to be `var`. With
defaults, call sites stay terse, fields stay immutable, and — combined
with single-shot `struct.new` construction (ir.md §12.1, unblocked
since M4) — construction is one allocation with no imperative
assignments.

Most fields that today would be marked "optional" in an options record
mean "absent = use the default", not "absence is meaningful". Defaults
serve that dominant case without any runtime presence tracking: the
built record always has the full shape.

## 2. Semantics

### 2.1 Defaults are a property of the annotation, not the type

A default is attached to the **record type annotation** it is written
in — the syntactic form — and never becomes part of the structural
record type. Structural identity, assignability, interning, and
`typesEqual` are computed exactly as if the defaults were absent:

```zena
type A = {x: i32 = 1};
type B = {x: i32 = 2};
type C = {x: i32};
// A, B, and C all denote the same record type {x: i32}.
```

Defaults act at exactly one point: **checking a record literal against
a contextual type that was resolved from a default-bearing
annotation**. The literal may omit any defaulted field; the checker
records the omission, and the construction site emits the default's
value into the omitted slot. The literal's type — and everything
downstream — is the full shape.

This is what lets defaults live on "just a type": nothing about them
exists at runtime, so the type never needs to carry code the way a
class does. The precedent is excess-property checking in the row-types
design (§3.2): a rule about how literals check against an annotation,
not a change to the type algebra.

Consequences, stated explicitly:

- A record **value** (not a literal) missing a defaulted field is not
  assignable to the annotated type, same as today. Filling applies to
  literals only; there is no implicit coercion that conjures fields
  onto existing values. (Post-flip, width-by-projection may narrow a
  wider value, but never widen a narrower one.)
- Two annotations of the same shape with different defaults are the
  same type. Which defaults apply to a given literal is decided by the
  annotation that contextually types it, which is always syntactically
  evident at the literal.
- A literal with **no** contextual type, or a contextual type resolved
  from a default-free annotation, is checked as today: all fields
  required.

### 2.2 Per-consumer defaults

There are two established idioms for optional-field defaults: the type
declares the default (`port: i32 = 8080`), or the type declares only
optionality and each consumer fills in its own default (TypeScript's
`let {timeout = 30} = opts`, Dart/Swift default parameter values).
Because defaults attach to annotations and never to the type (§2.1),
this design supports both with one mechanism:

```zena
type FetchOpts = {timeout: i32 = 30_000, retries: i32 = 3};

// The same shape with different defaults is the SAME type — values
// flow freely between the two. Only literal checking differs.
let fetchWithRetry = (opts: {timeout: i32 = 5_000, retries: i32 = 10})
    => ...;
```

A shared canonical bag puts the defaults on the alias; a consumer that
wants its own puts them in its own parameter annotation. In both forms
the defaults sit where callers look (the signature or the named type,
surfaced on hover), unlike TypeScript's variant, where types cannot
carry values and defaults end up buried in a destructuring statement
inside the body — the arrangement that makes defaults undiscoverable
and motivates `@defaultValue` doc tags.

Defaults that are logic rather than values — a default that depends on
another field or on consumer state — are out of scope for annotations
by design; use a nullable field and compute in the consumer, the same
form §5 gives for distinguishing "omitted" from "explicitly set".

### 2.3 Evaluation site and the constant restriction

A default expression is evaluated **at each construction site that
omits the field**, in field-declaration order, interleaved with the
literal's explicit fields as if the programmer had written the value
out. Initially, default expressions are restricted to **constant
expressions**: literals of primitive type, string literals, `null`,
enum members, and unary minus on numeric literals. Under that
restriction the evaluation-site rule is unobservable; it is stated now
so that a later relaxation (e.g. calling a function) has defined
semantics — per-omission evaluation, so a mutable default value is
never shared between two constructions.

Defaults may not reference other fields of the record, `this`, or any
local binding.

### 2.4 Syntax

```ebnf
RecordTypeProperty ::= Identifier '?'? ':' Type ('=' Expression)?
```

`=` is accepted in any record type annotation: type aliases, parameter
annotations, field annotations, return types. Combining `?` and `=` on
one field is an error — a defaulted field is already omittable, and
`?` asserts that absence is meaningful (§5), which a default
contradicts.

### 2.5 Interaction with spread and `with`

Filling happens after the literal's explicit content — spreads
included — is resolved. In `{...partial, tls: true}` checked against
`ServerOpts`, fields provided by the spread or explicitly count as
present; remaining defaulted fields are filled; remaining
non-defaulted fields are missing-field errors.

The `with` update form (row-types.md §4) operates on a complete value
of the full shape, so defaults never participate: there is no absent
field to fill.

### 2.6 Interaction with destructuring defaults

Destructuring defaults (`let {timeout = 30} = opts`) are a different
mechanism at the consumption end, and they exist to handle
presence-optional fields (§5). A config record's fields are always
present, so a destructuring default on one never applies. The two
compose without interaction: config records make destructuring
defaults unnecessary for the options-record use case, since the callee
receives a complete record.

### 2.7 Interaction with argument explosion

Explosion (records-and-tuples.md Phase 7, Track B) rewrites a
record-typed parameter into individual scalar parameters. Filling is
complete before that lowering runs — the call site passes full-shape
values — so exploded signatures are unaffected. The combination is the
end state for named parameters: `new Server({port: 9090})` compiles to
passing three scalars into a constructor that performs one
`struct.new`, with no record allocated.

## 3. Implementation sketch

All of the work is in the front end; there is no new runtime
representation.

1. **Parser**: accept `= Expression` on record type annotation
   properties, storing the initializer on `PropertySignature`
   (alongside the existing `optional` flag).
2. **Checker**:
   - When resolving a `RecordTypeAnnotation`, validate defaults
     (constant expression, assignable to the field type, not combined
     with `?`) and record them keyed by the annotation — not on the
     interned `RecordType`, which stays defaults-free so that
     interning and assignability are untouched.
   - When checking a record literal whose contextual type came from a
     default-bearing annotation, allow omission of defaulted fields
     and record the completed field set in the semantic model for the
     literal node.
   - Interning must not be keyed or polluted by defaults; a test
     asserts that aliases differing only in defaults are
     interchangeable as types.
3. **Codegen**: when lowering a record literal, consult the semantic
   model for completed fields and emit their constant values into the
   `struct.new` operands alongside the explicit ones.

The contextual-typing plumbing is the one open implementation
question: the checker's expected-type flow passes `Type` values, which
by design no longer carry the defaults. The recommended mechanism is a
semantic-model side table from annotation node to default set,
consulted at the two places a literal acquires its contextual type
(declared-type checking and call-argument checking), with the
annotation threaded alongside the expected type on those paths only.
Threading it everywhere is not needed: filling is defined only where a
literal meets an annotation-derived context (§2.1).

Because this adds syntax the checked-in bootstrap compiler cannot
parse, the compiler's own sources cannot use config records until a
reseed after the feature lands (see `docs/design/bootstrapping.md`);
portable tests are unaffected.

## 4. Diagnostics

- Omitting a non-defaulted field: today's missing-field error,
  unchanged.
- `?` combined with `=`: error at the annotation, pointing at this
  distinction (§5).
- Non-constant default expression: error at the annotation, naming the
  restriction.
- Unknown keys in a literal follow the excess-property rule
  (row-types.md §3.2) once the closed-by-default flip lands; before
  the flip, today's width rules apply. Defaults are orthogonal to
  both.

## 5. Relation to presence-optional fields

`?` on a record field means the field may be **absent**, and absence
is observable — distinct from a default (absence is erased at
construction) and from nullability (`T | null`, where the field is
present holding `null`). The three forms:

```zena
{retries: i32 = 3}   // omittable at construction; always present after
{retries?: i32}      // may be absent; absence is meaningful
{retries: i32?}      // always present; may be null (boxing for primitives)
```

Presence-optional fields are presence polymorphism, deferred by
row-types.md §3.4/§10; as of this writing the implementation is
front-end only (the checker rejects every literal that omits the
field, and no runtime representation of absence exists), so `?` in
record types is rejected with a clear diagnostic until the feature is
built. When it is built, the planned runtime representation is a
vtable accessor returning `inline (boolean, T)` — present-flag plus
value, the same multi-value shape as `Map.get` and `Iterator.next` —
which represents absent primitives without boxing or sentinel values.
Config records are expected to absorb most demand for `?`; it should
be implemented only if meaningful-absence use cases accumulate.

## 6. Alternatives considered

- **Consumption-site filling.** Build the partial record as-is and
  apply defaults where the record is *read* — colocating the filling
  in the consumer instead of at every construction site. The runtime
  mechanics exist: every record value today is a fat pointer whose
  vtable identifies its concrete shape, so an adapted vtable for
  (partial shape → default-bearing type) could synthesize getters for
  absent fields that return the default constant — a per-(shape, type)
  cost instead of a per-call-site cost, with no branching at reads.
  Rejected on three grounds:

  1. Partial records become first-class values, which is observable
     absence: equality and hashing across present-sets, spread of a
     partial value, and what a read sees before "consumption" (once
     the value is stored or passed, every access site is a consumption
     site) all need answers. That is presence polymorphism —
     row-types.md §3.4/§10 defers it as too heavy — reintroduced as
     the semantics of every config record. Under construction-site
     filling a partial record never exists as a value.
  2. It welds config records to the dispatch representation as the
     row-types plan retires it. `struct.get` takes a static field
     index, so polymorphic-shape access is vtable dispatch or
     per-shape specialization, nothing in between (row-types.md §7.1).
     The vtable form keeps every config read a `call_ref` and hands
     constructors a heap-allocated bag, defeating argument explosion
     and single-shot construction on the hottest path; the
     specialization form is up to 2^n bodies per consumer across
     present-sets, on the compiler's known instantiation-pressure
     axis.
  3. The colocation benefit already holds at the source level —
     defaults are declared once, on the type, under either scheme.
     What repeats per construction site is only constant operands (an
     immediate, or a ref to an interned constant), and identical
     filled literals may be shared under value semantics if that ever
     matters. Late binding of defaults pays off when callers must not
     recompile as defaults change — a separate-compilation/ABI
     pressure a whole-program compiler does not have.

- **Defaults on the interned structural type.** Rejected: either
  defaults join the interning key (aliases of one shape become
  distinct types, breaking structural typing) or they don't (two
  aliases intern to one type object and one alias's defaults win by
  interning order — nondeterminism of exactly the kind the
  sorted-field canonicalization exists to prevent).
- **Defaults at the destructuring site** (today's documented pattern:
  `let {timeout = 30} = opts` in the callee). Requires
  presence-optional fields to work at all, pays presence tracking at
  runtime, and repeats the defaults at every consumer instead of
  stating them once at the type.
- **Default parameter values on a named-parameter call syntax**
  (`new Server(port: 9090)`, Dart/Swift style). A larger language
  addition — new call syntax, overload interactions — that duplicates
  what records plus explosion already provide; records also give the
  options bag a name and a reusable type.
- **Nullable fields as poor-man's optionality** (`timeout: i32?` with
  `?? 30` at each use). Boxes primitives, moves the default to every
  read, and makes `null` ambiguous between "unset" and "explicitly
  null".
