# Argument Explosion

**Status: Proposed**

A function that takes a record parameter compiles to a wasm signature
carrying the record's fields as individual scalar parameters, and a
record-literal call site passes field values directly — no allocation,
no fat pointer, no vtable dispatch. This is the lowering that makes the
named-parameters idiom cost what positional parameters cost:

```zena
type FetchOpts = {url: String, timeout?: i32, retries?: i32};

function fetch({url, timeout = 30000, retries = 3}: FetchOpts): i32 { ... }

fetch({url: u, retries: 5});   // no record is ever allocated
```

[records-and-tuples.md](records-and-tuples.md) §4.2.1 sketched this;
[record-presence.md](record-presence.md) §7 defined how presence masks
ride exploded signatures. This document is the implementation design.
Multi-value _returns_ (records-and-tuples.md §4.2's other half) are out
of scope here.

## Semantics

V0 (records-and-tuples.md §3.1) made record and tuple identity
unobservable — `===`/`!==` on them is a compile error — so dissolving
the argument record is a semantics-preserving rewrite everywhere, not
an optimization guarded by escape analysis. What escape analysis still
decides is _where the rewrite is profitable and simple_: a callee that
stores the record somewhere would need it re-boxed inside, which moves
the allocation instead of removing it. Such parameters stay boxed.

Explosion must preserve:

- **Evaluation order.** A record literal evaluates its properties in
  written order; the exploded call site does too, into temporaries when
  written order differs from signature order.
- **Presence.** An optional field's mask bit travels as part of the
  `$present` words (one i64 parameter per 64 optional fields,
  record-presence.md §7). Absent slots pass zero/null, exactly the
  representation the boxed layout uses.
- **Width adaptation.** A call site holding a wider record than the
  parameter type reads just the fields the signature wants. This
  _replaces_ fat-pointer adaptation at exploded edges — the callee
  never sees a view, only values.

## Costs

Explosion applies uniformly to every eligible parameter — no field-count
cap, no call-site heuristic. The cost table justifies that. For a
record with N fields (every record field read today is a two-`call_ref`
getter dispatch; there is no direct `struct.get` path for records):

| per call, argument is a…  | boxed signature                           | exploded signature                    |
| ------------------------- | ----------------------------------------- | ------------------------------------- |
| record literal            | `struct.new` + `iface_pack` + field evals | field evals only                      |
| already-boxed value       | one reference                             | one call (the boxed forwarder, below) |
| callee, per field **use** | getter dispatch (2 `call_ref`s)           | `local.get`                           |

For literal arguments explosion deletes the allocation and, inside the
callee, replaces every field use's double indirection with a local
read. For already-boxed arguments it does not add dispatch work — the
getter calls the callee would have made per use happen once per field
in the forwarder instead — and the callee still gets the cheap body.
The case that would lose without the forwarder is a branchy callee
that reads few of its fields per invocation, called from many sites
with pre-boxed records: eager per-field reads inlined at every such
site would cost code size, which is why boxed call sites go through
one shared forwarder rather than open-coded reads.

What no signature-level scheme can give is per-call-site
representation: one function has one signature, so a function reached
by both literal and boxed arguments serves both through the split
above (exploded core + forwarder) rather than through a heuristic
picking a single loser.

## Scope

Explosion applies per (function, parameter). The parameter must have a
concrete record type, and both of the following must hold.

### Eligible functions

A function is eligible when every way it is reached is a direct call
whose signature the rewrite controls:

- Top-level `function` declarations and module-level `let` arrows,
  called through `functionMap` (`ir/lowering.zena` `#lowerDirectCallTo`)
  — including cross-module imports, which canonicalize to the same
  symbol.
- Constructors, called through `classMethodMap`
  (`#constructInstance`). This is the case the class-initialization
  idiom needs: an exploded constructor plus the planned single-shot
  `struct.new` lowering (ir.md §12.1) makes
  `new Server({port: 8080})` allocation-free end to end.

Excluded in v1, each because some consumer derives from the boxed
signature:

- **Value-taken functions** — a function referenced as a value gets a
  wrapper built from its `FunctionType`
  (`reachability/visitor.zena` `registerWrapper`); the wrapper would
  disagree with an exploded target. Value-use discovery is only stable
  once RTA's fixpoint completes, which is one reason the explosion
  decision runs after RTA (see below).
- **Exported and component-visible functions** — component adapters
  assert declared params match core params one for one
  (`ir/component-adapters.zena`).
- **Async functions and generators** — their ramps copy
  `signature.params` into frame structs; explosion composes with that
  in principle but is untested machinery times untested machinery.
- **Virtual methods** — a vtable slot's signature is shared across
  overrides; exploding one override is unsound alone. Non-virtual
  methods can join constructors in a later phase.
- **Generic functions** — each specialization has its own signature
  and could explode independently; deferred to keep v1's rewrite in
  one place.

### Eligible parameters

A record parameter explodes when its uses in the callee body never
need the box. The escape walk (below) accepts a parameter whose every
reference is one of:

- the receiver of a field read (`opts.timeout`), including under `??`;
- the source of a record destructuring or record pattern (`let {a, b =
d} = opts`, `if (let {t} = opts)`, `match (opts)` with record arms —
  presence and absence patterns included);

and rejects anything else: passed whole to another call, stored in a
field/array/variable that outlives the call, returned, spread into a
literal, compared with `==`, or referenced from a nested function
expression (a capture needs a cell to close over). Spread and `==`
could be taught to consume exploded fields later; v1 keeps the walk's
accept-list short and obviously sound.

## The explosion pass

The decision and the signature rewrite run as a pass in
`module-generator.zena` after RTA and the generator/async splits, and
before `wasm.layout()` — after, because value-use and reachability
facts are only stable once the fixpoint completes; before, because the
rewrite interns new `WasmSignature`s and no type may be created after
layout.

For each eligible function, the pass:

1. Runs the escape walk over the function's AST body (a `walkEnter`
   with `model.getParent` context classification, the shape of
   `lib/analysis/capture.zena`'s `analyzeCaptures`).
2. For each exploding parameter, replaces its one signature slot with
   the record's fields in canonical order (`sortedOptionalNames` /
   `recordWasmFields` order from `type-mapping.zena`, the same order
   the struct layout uses) followed by its `$present` i64 words.
   Optional reference fields take their nullable slot type, optional
   primitives their plain type — again matching the struct layout.
3. Records the plan on the `WasmFunction` as an explosion spec
   (per original param index: the record type, field names in slot
   order, mask word count), which both ends of every call consult.

Field order comes from sorted names, never hash iteration — stage-2
byte parity gates any nondeterminism here.

### Callee lowering

`#bindParams` currently maps source parameter _i_ to one signature
slot; with a spec present it maps an exploding parameter to its slot
_range_. The parameter's symbol binds not to a value but to an
exploded-record binding in the lowering context: field name → param
value, plus mask param values. Then:

- a field read on the symbol becomes the param value directly (no
  `recordDispatchRead`);
- a presence test becomes a bit test on the mask param
  (`maskBitTest`'s arithmetic on a param value instead of a loaded
  field);
- destructuring with defaults binds through the same guarded-select
  shape `bindRecordProp` emits today, minus the getter calls.

The escape walk guarantees no other use exists.

### Call-site lowering

`#lowerDirectCallTo` and `#constructInstance` consult the callee's
spec per argument slot:

- **Record literal argument**: lower each property expression in
  written order into values, compute mask words the way
  `#lowerRecordLiteral` already does (constant bits for explicit
  fields, remapped bits for spread sources), and pass values in slot
  order. The `struct.new` + `iface_pack` tail is simply not emitted.
  The literal lowering refactors into "produce field values + mask
  words" and "pack them", with packing skipped here.
- **Record value argument**: call the callee's **boxed forwarder** — a
  synthesized function with the pre-explosion signature whose body
  reads each field through the existing dispatch getters, reads the
  mask words, and calls the exploded core. One forwarder per exploded
  function, minted on demand the first time a call site passes a
  record value rather than a literal (the same on-demand shape as
  `registerWrapper`'s function-value wrappers, and value-taken
  functions already need exactly this adapter if they ever join the
  eligible set). The forwarder is what keeps boxed call sites at
  today's cost — one call, one reference — instead of inlining N
  getter reads into every such site; without it, a widely-called
  function with boxed arguments would trade one allocation-free path
  for N-fold call-site growth everywhere else. It also subsumes
  fat-pointer width adaptation at these edges.

Arity gates (`sig.params.length != liveArgCount` in
`#lowerDirectCallTo`, `#lowerSpecializedCall`, `#constructInstance`)
compare against a spec-aware expected-slot count.

### Record dispatch liveness

Exploding a call edge does not retire the record shape's dispatch
info: other sites (patterns over record values, spread sources, boxed
uses of the same shape) may still need it, and
`typeToValType`'s record arm throws on an undiscovered shape. The
dispatch stays registered; unreferenced getters are dead code the same
way any unreached synthesized function is. Measuring whether dead
getters cost measurable size is part of validation.

## Verification

- **Allocation invariants**: `assertNoAllocation`
  (`zena/test/wat-invariants.zena`) on both the call-site function and
  the exploded callee of a fixture, plus `assertFunctionOmits` of
  `call_ref` in the callee (no getter dispatch). Written so the
  failure has been seen: force the boxed path, watch the message.
- **Semantics parity**: execution tests mirroring the existing
  presence suite through exploded edges — defaults, zero-vs-absent,
  spread call sites, wider-record arguments, `??` on optional fields,
  reference-typed optional fields.
- **Escape fallback**: a fixture whose callee stores the record keeps
  the boxed signature and still passes.
- **Forwarder path**: a fixture calling one exploded function with a
  literal at one site and a record value at another — the value site
  routes through the forwarder, both agree on results, and the
  call-site function stays allocation-free.
- **Byte parity**: stage-2 fixpoint, as always. The compiler's own
  sources contain record-typed parameters, so the self-compile
  exercises the pass immediately.

## Alternatives considered

**Explode only destructured parameters.** Keying explosion to the
parameter being destructured in the signature would make the trigger
visible in source, but `({timeout = 30}: Opts) => …` and
`(opts: Opts) => opts.timeout ?? 30` are the same program — tying the
representation to the spelling means a style refactor silently flips
the cost model, and destructuring becomes a performance incantation.
The escape walk keys on the semantic property both spellings share:
the callee consumes fields, never the box.

**A profitability heuristic** (field-count cap, explode only when some
call site passes a literal). With the boxed forwarder there is no
remaining case for a heuristic to save, and a cap is a cliff — the
seventeenth field silently changing a function's calling convention is
the kind of illegible cost model this project avoids.

**A hint to enable explosion.** Automatic-where-legal needs no
opt-in. The useful explicit form is the opposite polarity — a
_guarantee_, below.

### The `inline` parameter guarantee

The escape guard makes explosion automatic but also silent in both
directions: adding `this.lastOpts = opts;` deep in a callee re-boxes
every call site and nothing reports it. `inline` on a record parameter
(the same word, and the same meaning, as `inline` tuples: a
representation guarantee, not a request) would assert the parameter
explodes and turn any escaping use into a compile error. Deferred from
v1 only because it is syntax; the check is the escape walk's existing
verdict.

## Later phases

Multi-value returns; non-virtual methods; per-specialization explosion
of generic functions; the `inline` parameter guarantee above; teaching
spread and `==` to consume exploded bindings; treating
pass-whole-to-an-exploded-parameter as non-escaping, so an option bag
forwards through a call chain as scalars end to end (a call-graph
fixpoint: each callee's verdict depends on its callees'); re-boxing on
demand (explode a parameter that escapes on one cold path by
reconstructing the record there) if profiles ask for it.

Compiler adoption of the named-parameters idiom is gated on a reseed,
not on this design: the checked-in bootstrap predates optional record
fields, so compiler sources cannot use `?` fields until
`npm run reseed` bakes a baseline that includes them.
