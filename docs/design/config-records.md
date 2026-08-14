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

Defaults act at exactly one point: **checking a record literal whose
contextual type is a default-bearing named alias** (§2.2 for why the
alias is the only carrier). The literal may omit any defaulted field;
the checker records the omission, and the construction site emits the
default's value into the omitted slot. The literal's type — and
everything downstream — is the full shape.

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
- A literal whose contextual type is a bare structural shape (or
  absent) is checked as today: all fields required. Only the named
  alias fills, so where no alias is written, omission is a loud
  missing-field error.

### 2.2 Defaults live on named aliases; filling follows the name

Defaults may be declared **only in a named type alias**, and a literal
is filled wherever *that alias* is the literal's contextual type — a
call or constructor argument, a `let` with a declared type, a field
initializer, a return, a branch of a conditional in any of those
positions. One name, one default set, every site.

The restriction to aliases is what makes filling in all of those
positions safe. An earlier draft also allowed defaults inline on a
parameter's annotation, which lets the same shape carry two default
sets — and then the ordinary extract-to-local refactor changes
behavior silently:

```zena
type FetchOpts = {timeout: i32 = 30_000, retries: i32 = 3};
let fetchWithRetry = (opts: {timeout: i32 = 5_000, retries: i32 = 10})
    => ...;                          // rejected: defaults outside an alias

fetchWithRetry({});                  // would fill 5_000 / 10 ...

let opts: FetchOpts = {};            // ... but this fills 30_000 / 3
fetchWithRetry(opts);                // and passes the already-full value
```

That is the leaks-through-an-intermediate-variable defect row-types.md
§3.2 criticizes in TypeScript's excess-property heuristic. With
defaults on aliases only, the callee's parameter *is* the alias, so
the natural refactor — annotate the extracted local with the
parameter's type, which is what the signature and hover show —
preserves the name and therefore the behavior. Extraction either
behaves identically or fails loudly (a bare-shape or missing
annotation leaves the literal's fields required); drift requires
writing a *different alias name* at the local, a visible source
change. A callable that wants its own defaults declares its own
one-line alias — the Dart/Swift signature-defaults idiom, with the
defaults hoisted into a name the caller can also use.

Because the alias itself carries the defaults, the fill source never
depends on resolving a callee declaration: a call through a
function-typed value fills from the alias written in the function
type, an override's callers fill from the alias in the signature they
resolve against, and all of them agree by construction.

### 2.3 Dynamic construction of options

Conditionally *including* a field is a staple of JS option-bag code
and is awkward even there (`...(cond ? {timeout: 5} : {})` — setting
a field to `undefined` still defines it). Zena's answer: materialize
the defaults, then conditionally *override*. The two are
indistinguishable here by construction, since absence is erased the
moment a literal is filled:

```zena
var opts: FetchOpts = {};                          // full defaults
if (verbose) { opts = {...opts, timeout: 60_000}; }
if (retryHard) { opts = {...opts, retries: 10}; }
fetchWithRetry(opts);
```

N independent conditions compose as N updates — no 2^N branch
combinations, no presence tracking. (Once the `with` update form
lands — row-types.md §4 — the spread-override above becomes
`{...opts with timeout: 60_000}`; under today's last-wins spread the
plain form works.) This pattern is why let-position filling matters:
`{}` against the alias is the canonical way to obtain the default
configuration as a value.

The alternative — letting a *partial* value flow to the callee and
adapting there — is rejected in §6: statically it needs flow-typed
present-sets (2^N shapes through every join), dynamically it is the
N×M vtable-adaptation problem, i.e. presence polymorphism by another
road.

Defaults that are logic rather than values — a default that depends on
another field or on consumer state — are out of scope for annotations
by design; use a nullable field and compute in the consumer, the same
form §5 gives for distinguishing "omitted" from "explicitly set".

### 2.4 Evaluation site and the constant restriction

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

### 2.5 Syntax

```ebnf
RecordTypeProperty ::= Identifier '?'? ':' Type ('=' Expression)?
```

`=` is accepted only in a record type annotation that is the target of
a **named type alias** (§2.2); on a record annotation in any other
position — a parameter's inline annotation, a field type, a return
type, a local's declared type — `=` is an error whose message points
at declaring an alias. Combining `?` and `=` on one field is an
error — a defaulted field is already omittable, and `?` asserts that
absence is meaningful (§5), which a default contradicts. Defaults on a
field whose type mentions a type parameter of a generic alias are
rejected in v1 (a constant cannot be generic in `T`).

### 2.6 Interaction with spread and `with`

Filling happens after the literal's explicit content — spreads
included — is resolved. In `new Server({...partial, tls: true})`,
fields provided by the spread or explicitly count as present;
remaining defaulted fields are filled; remaining non-defaulted fields
are missing-field errors.

The `with` update form (row-types.md §4) operates on a complete value
of the full shape, so defaults never participate: there is no absent
field to fill.

### 2.7 Interaction with destructuring defaults

Destructuring defaults (`let {timeout = 30} = opts`) are a different
mechanism at the consumption end, and they exist to handle
presence-optional fields (§5). A config record's fields are always
present, so a destructuring default on one never applies. The two
compose without interaction: config records make destructuring
defaults unnecessary for the options-record use case, since the callee
receives a complete record.

### 2.8 Interaction with argument explosion

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
   - When resolving a defaulted record annotation inside a type alias
     declaration, validate the defaults (constant expression,
     assignable to the field type, not combined with `?`) and store
     them **on the `TypeAliasType`** — not on the interned
     `RecordType`, which stays defaults-free so that interning and
     assignability are untouched. `TypeAliasType` is already a
     distinct object per declaration that flows through the checker's
     expected-type paths unexpanded (the distinct-alias machinery), so
     no new plumbing carries the defaults to use sites.
   - When checking a record literal whose contextual type is (or
     unwraps directly to) a default-bearing `TypeAliasType`, allow
     omission of defaulted fields and record the completed field set
     in the semantic model for the literal node.
   - Interning must not be keyed or polluted by defaults; a test
     asserts that aliases differing only in defaults are
     interchangeable as types.
3. **Codegen**: when lowering a record literal, consult the semantic
   model for completed fields and emit their constant values into the
   `struct.new` operands alongside the explicit ones.

One caution: expected types reach literals through several paths
(declared types, call arguments, returns, conditional branches), and
some of them eagerly unwrap aliases. Each unwrap site on those paths
must preserve the alias long enough for the literal check to see its
defaults — the same class of hazard as the `Own<T>` alias-peeling trap
already documented for ownership handles.

Because this adds syntax the checked-in bootstrap compiler cannot
parse, the compiler's own sources cannot use config records until a
reseed after the feature lands (see `docs/design/bootstrapping.md`);
portable tests are unaffected.

## 4. Diagnostics

- Omitting a non-defaulted field: today's missing-field error,
  unchanged.
- Omitting a defaulted field where the contextual type is the bare
  shape rather than the alias (§2.2): the missing-field error, with a
  note that defaults fill through the named alias.
- `=` on a record annotation outside a named type alias (§2.5): error
  at the annotation, suggesting an alias.
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

- **Inline per-callable defaults.** An earlier draft allowed `=` on
  any record annotation, including a parameter's inline annotation, so
  each callable could declare its own defaults for a shared shape.
  Rejected in review: two default sets for one shape make
  extract-argument-to-local silently switch defaults (§2.2's
  counterexample). An intermediate revision kept inline defaults and
  compensated by scoping filling to direct call arguments only — which
  restored behavior preservation but broke the dynamic-construction
  pattern (`let opts: FetchOpts = {}` had no way to materialize the
  defaults, §2.3) and needed special rules for function-typed
  indirection and overrides. Alias-only defaults dissolve all three:
  the name carries the defaults, so every position that names the
  alias agrees.

- **Call-site adaptation of partial values.** Let
  `let opts: FetchOpts = {}` build a genuinely partial value and have
  each call site (or callee) complete it. Statically this requires
  tracking present-sets through the type system — flow-typed partial
  shapes and unions, up to 2^n per join; dynamically it is the
  (shape × type) vtable-adaptation machinery of consumption-site
  filling below. Both are presence polymorphism by another road, and
  unnecessary once the alias fills at the `let` itself.

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
