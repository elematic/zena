# Argument Explosion

**Status: Implemented for top-level functions and constructors, and
for top-level functions' record results** (`ir/explode.zena`). The later
phases below are not.

A function that takes a record parameter also gets a version whose
signature carries the record's fields as individual parameters, and a
call that passes a record literal calls that version with the field
values: no allocation, no fat pointer, no getter dispatch. This is the
lowering that makes the named-parameters idiom cost what positional
parameters cost:

```zena
type FetchOpts = {url: String, timeout?: i32, retries?: i32};

function fetch({url, timeout = 30000, retries = 3}: FetchOpts): i32 { ... }

fetch({url: u, retries: 5});   // no record is ever allocated
```

[records-and-tuples.md](records-and-tuples.md) §4.2.1 sketched this;
[record-presence.md](record-presence.md) §7 defined how presence masks
ride exploded signatures. The same machinery returns a record result as
its fields when the callers only read the fields
([Results](#results), records-and-tuples.md §4.2's other half).

## Semantics

Record and tuple identity is unobservable (`===`/`!==` on them is a
compile error, records-and-tuples.md §3.1), so dissolving the argument
record changes nothing a program can see. Escape analysis decides only
where the rewrite pays: a callee that stores the record, returns it or
passes it on needs it whole, and would rebuild it on entry, which moves
the allocation instead of removing it. Such parameters are not
exploded.

Explosion preserves:

- **Evaluation order.** A record literal evaluates its properties left
  to right as written, spreads included, and the exploded call does the
  same: the literal's field values are computed by the same code that
  builds the record (`#lowerRecordLiteralFields`), minus the final
  `struct.new` and pack.
- **Presence.** An optional field's mask bit travels in the `$present`
  words (one i64 parameter per 64 optional fields, record-presence.md
  §7). Absent slots pass zero/null, exactly the representation the
  boxed layout uses.

## Costs

A record value is a fat pointer: the record struct and a vtable of one
getter per field. Reading a required field costs one `call_ref`;
reading an optional field behind a presence test (`??`, a default, a
pattern) costs two, the mask getter and the field getter.

Measured on a callee too large to inline, called in a loop with two
record literals and once with a record held in a variable:

| build        | allocations in the caller's loop, per iteration | `call_ref` in the callee          |
| ------------ | ----------------------------------------------- | --------------------------------- |
| `-O1` before | 4 (two structs, two fat pointers)               | 24                                |
| `-O1` after  | 0                                               | 0 (the core)                      |
| `-O2` before | 4                                               | 0 (specialized and devirtualized) |
| `-O2` after  | 0                                               | 0                                 |

At `-O2` the existing passes already remove the getter dispatch when
every caller passes the same record shape (`specialize.zena` then
devirtualization), and remove the record entirely when the callee is
small enough to inline: the `record-ctor` benchmark compiles to the
same module as `positional-ctor`. What they cannot remove is the
allocation at a call to a callee that stays out of line, and that is
what explosion removes at every level.

## Scope

Explosion applies per (function, parameter).

### Eligible functions

Top-level `function` declarations and module-level `let` arrows, when
they have no receiver, context, captures, suspension (`async`,
generators) or zero-width parameters, return at most one value, and
declare no parameter defaults. A default injected at the call site can
name an earlier parameter, which the core no longer has as one value.

A generic function is eligible per specialization: each
`first_spec_i32` is a function of its own, with its own candidate
(keyed by its name), its own core and its own verdicts, and the
template is never emitted. Reachability records a generic call where it
instantiates the specialization, with the caller's type arguments
substituted (`#noteSpecializedCall`): its literal arguments under
`recordLiteralSpecArgs`, and a record result as a `RecordResultCall`
naming the specialization (`specTarget`), once per call and target. In
demand, a call to a generic function resolves to a specialization the
way lowering does (`functionCallKey`, mirroring
`#solvedCallTypeArguments`): the call's solved type arguments,
instantiated as the calling function sees them, so a call in a generic
body names the specialization of the same instantiation. A core keeps
its forwarder's type arguments, so its body substitutes them the same
way, and `#lowerSpecializedCall` calls a core under the same conditions
`#lowerDirectCallTo` does.

A call returned from a generic function's body counts toward that
function's result only when the function has one specialization among
the candidates, for the reason a generic class's method's does
(Results). A held `var` in a generic body is held in every
specialization once one qualifies; a write whose callee does not
return fields in another specialization is read field by field there
(`heldFields`), which is correct but not free.

On a loop destructuring `shift<i32>({x: i, y: 1}, 0)`, two million
iterations, `-O1` goes from 125 ms to 3.3 ms; at `-O2` the inliner had
already removed the record. No generic function in the compiler's own
module gets a core. It grows by 2.9 KB (2,282,367 to 2,285,315): the
new analysis code, and three `Completer.complete` and `Future.#propagate`
specializations the inliner no longer inlines at their call sites, a
budget shift rather than an effect of explosion on them.

Being used as a value, exported, or called from a tagged template does
not exclude a function, because explosion never changes the original
function's signature (below).

### Constructors

A class's own written constructors, unnamed and named, are eligible on a
class that is not an extension, a case class, a mixin intermediate or a
resource, including each concrete instantiation of a generic class,
when the constructor is undecorated, synchronous, and has no parameter
defaults or `this.` parameters. As with methods, a generic class's
constructor is one function per instantiation, and reachability records
literal `new` arguments under the instantiation's class key, so each
instantiation explodes on its own evidence. On a loop calling
`new Box<i32>(i, {x: i})`, two million iterations, `-O1` goes from 68 ms
to 12 ms; at `-O2` the factory was already inlined and the record
removed. The compiler's own module grows by 33 bytes. Its escape check walks the
initializer list and the `super(...)` arguments as well as the body.

`new C(...)` is one call to C's **factory**, which computes the field
values, allocates and runs the body. The factory gets the core, like a
function: `#constructInstance`, the one place `new` lowers to a call,
calls the core when an argument is unpacked. The core lowers as a
factory too. It carries the factory's class, struct and declaration but
no method name, because `layout()` rebuilds the class method map from
method names and the core must not replace the factory there.

Reachability records literal `new` arguments in
`recordLiteralCtorArgs`, keyed by class and constructor. Candidates are
keyed `f<symbol>` for functions and `c<class>|<constructor>` for
constructors, where the constructor is `<constructor>` or, for a named
one, `<constructor>.name`, so a forward can target any of them. A named
constructor's factory, `new C.name(...)`, and its phase functions
(`<ctor-init>.name`, `<ctor-body>.name`) get cores the same way, and a
subclass's `super.name(...)` forwards to it or passes it literals.

Measured on a loop calling `new P.from({x: i})`, a named constructor
reading an optional field, two million iterations (wall time, including
process start):

| build | before | after  |
| ----- | ------ | ------ |
| `-O1` | 69 ms  | 12 ms  |
| `-O2` | 2.4 ms | 2.9 ms |

At `-O2` the two builds' `main` is the same loop, with the factory
inlined and nothing allocated; the difference is process start. The new
module is smaller, but every type after the ones it drops moves to a
new index, and wasmtime's start-up cost is sensitive to that. The
compiler's own module grows by 333 bytes (2,282,886 to 2,283,219).

**Phase functions.** A subclass never calls its superclass's factory.
Its own factory evaluates the `super(...)` arguments, then calls the
superclass's `<ctor-init>` (which computes the superclass's fields) and
`<ctor-body>` (which runs its body on the new instance), both minted by
reachability from the factory's signature. When the superclass's
constructor explodes, those two get cores as well, `<ctor-body>`'s after
its instance parameter. A core of a phase has no method name, so
`lowerFunction` runs it as the phase its forwarder runs.

- **Literal `super(...)` arguments** of exactly the parameter's record
  type are lowered as fields in `#lowerCtorLevel`, and the record built
  from them is registered in `explodedRecords`; literal super arguments
  seed availability like literal `new` arguments.
- **`super(init)`** counts as a forward to the superclass constructor's
  parameter, so a subclass constructor that passes its own record up is
  fields-only, and its core passes the fields it holds.
- **A heap record** passed to `super(...)` is read once, in the
  subclass's factory, and registered as held, so both phase cores take
  the same values. Calling the phase forwarders instead would read it
  twice, once in each.

`#allocateInstance` makes these phase calls through
`#explodedCallArgs`, so a phase with a core is always called through it.

**Arguments past the first superclass.** In `Leaf extends Middle extends
Base`, `Middle`'s own `super({...})` is evaluated inside
`Middle.<ctor-init>`, whose results are `Middle`'s own fields followed
by `Base`'s arguments, and `Leaf`'s factory passes those on to `Base`'s
phases. When `Base`'s constructor explodes a parameter,
`Middle.<ctor-init>` gets a core that returns that argument as its
fields (`ExplosionSpec.tail`, computed by `superArgTail`), whether or
not `Middle`'s own parameters explode:

- The core's return (`#emitCtorInitReturn`) passes the fields of a
  record it holds as fields, a literal or its own exploded parameter,
  and reads any other record's fields.
- `#allocateInstance` calls that core, and holds each returned argument
  as a record rebuilt from its fields (`#callValuePhaseCore`), so
  `Base`'s phase cores take the same values and the record dies. The
  next level up does the same, so a chain of any length passes fields.
- The forwarder keeps its signature, building the records from the
  core's fields.

On a loop calling `new Leaf(i)` for `Leaf extends Middle extends Base`,
`Middle` passing `Base` a literal, two million iterations, `-O1` goes
from 104 ms to 17 ms; at `-O2` the phases were already inlined and the
record removed. The compiler's own module grows by 2.3 KB (2,280,264 to
2,282,547), all of it the code that does this: no constructor chain in
the compiler uses it.

A core called with a constant presence mask, which is what a record
literal becomes, gets the inliner's argument budget (`inline.zena`).
Before explosion, the literal's allocation earned the boxed factory that
budget, and at `-O2` the factory was inlined into its caller. Without
the rule, removing the allocation would have stopped the inlining.

Measured on the `record-ctor` benchmark (two million `new Node({...})`
with optional fields), against `positional-ctor`, the same class built
positionally:

| build      | `record-ctor` before | after  | `positional-ctor` |
| ---------- | -------------------- | ------ | ----------------- |
| `-O1` time | 1198 ms              | 112 ms | 110 ms            |
| `-O1` size | 762 B                | 361 B  | 228 B             |
| `-O2` size | 190 B                | 190 B  | 190 B             |

### Methods

An instance or static method is eligible on a class that is not an
extension or a mixin intermediate, including each concrete
instantiation of a generic class, when the method is not abstract,
`async`, a generator, decorated, or declared with an explicit
receiver, and has no parameter defaults. A generic method is eligible
per specialization of its own type parameters (below). Its parameters and
its result explode under the same rules as a function's. A static
method's calls are all direct, so its core is used like a function's.

The method keeps its signature and its vtable slot, and becomes the
forwarder, so a call that dispatches through the vtable (some reached
subclass overrides the method) still passes and receives the record.
Only a call the lowering makes directly, to the method itself, can call
the core, which takes the receiver ahead of the fields. The core has no
method name of its own, so that `layout()` never puts it in the class
method map; the lowering takes the forwarder's name for its prologue.

A method is named by its declaration node in the instantiation of the
class that declares it (`methodTargetKey`): one declaration in a
generic class is one function per instantiation. Reachability records a
method call by that key, found from the receiver's static class as the
walk resolved it (`recordLiteralMethodArgs`, and
`RecordResultCall.methodTarget`): whether a call is direct is only known
when it is lowered, so these are the evidence that some call could pass
or take the fields. Passing a parameter on to a method (`this.m(p)`,
`Grid.m(p)`) is a forward like passing it to a function; demand
resolves its target from the calling function, with the receiver's type
instantiated as that function sees it (`methodTargetOf`), so a call in a
generic class's body names the method of the same instantiation.
A forward to a method some reached subclass overrides does not keep the
parameter fields-only: that call dispatches through the vtable, which
passes the record.

Measured on a loop calling `g.shift({x: i, y: 1}, 2)`, a method of a
class with no subclass that returns a record, destructured, two million
iterations (wall time, including process start):

| build | before | after |
| ----- | ------ | ----- |
| `-O1` | 119 ms | 7 ms  |
| `-O2` | 6 ms   | 6 ms  |

At `-O2` the inliner already brought this small method into the loop,
and scalar replacement removed the record. The compiler's own module
grows by 2.9 KB (2,240,334 to 2,243,268 bytes).

**Generic methods.** A method's own type parameters are a second axis:
a generic method exists only as its specializations (`map_spec_i32`,
reachability's CONTEXT.md), each a function under its specialized slot
name. Such a method is named by its `methodTargetKey` together with
that slot name (`specMethodTargetKey`), which reachability computes
from the call's solved type arguments as the walk sees them, and
demand's `methodTargetOf` from the same arguments instantiated as the
calling function sees them, as lowering's slot lookup does. The
candidate reads the member's type under its declared name, since the
slot name is the specialization's. Lowering needed no change: its
direct path resolves the specialized slot before it checks for a core.

A generic method a subclass overrides is not dispatched through a
class-typed receiver yet (#364): the call binds to the receiver's
static class. Explosion follows the method lowering calls, so it adds
no error of its own; when #364 adds per-specialization class vtable
slots, `Candidate.overridden` must see the subclass's specialization
for a dispatched call to keep passing the record.

On a loop destructuring `g.shift<i32>({x: i, y: 1}, 0)`, two million
iterations, `-O1` goes from 113 ms to 2.4 ms; at `-O2` the inliner had
already removed the record. No generic method in the compiler's own
module gets a core; it grows by 1.0 KB (2,285,315 to 2,286,343), the
code that does this.

### Not yet eligible

- **Async functions and generators**, for the reasons the rest of this
  document's later phases list.

### Eligible parameters

Two facts are kept per (function, parameter). They are function
summaries in the usual interprocedural-analysis sense: each function's
facts come from its own body and its callees' facts, never from a
whole-program search. GHC's demand analysis keeps the same kind of fact
("boxity": whether a function needs the box or only the fields) to drive
its worker/wrapper split, which has the same shape as the core and
forwarder here.

**Demand**, computed bottom-up. A record parameter is _fields-only_ when
every use of it, outside any nested function (which would capture it),
is one of:

- `p.field` (not `p?.field`), including under `??`;
- `let {...} = p`, and a destructuring parameter's own pattern;
- `g(..., p, ...)` for a top-level function `g` whose matching parameter
  has the same record type and is itself fields-only;
- returning it whole (a `return` operand, the expression body, a value
  block's tail, or an arm of an `if` or `match` in one of those
  places), when the parameter has the result's record type and the
  function's result explodes (see [Results](#results)).

Any other use (stored, spread, compared, matched, captured, passed to
anything else) means the function needs the record. Demand
starts optimistic and only turns to "needs the record" on evidence, so a
function that passes its record to itself, or to a mutually recursive
partner, is fields-only.

**Availability**, computed top-down. A parameter is _available
unpacked_ when some reached direct call passes it a record literal
(reachability records these in
`ReachabilityContext.recordLiteralArgs`), or when an exploded parameter
of some core is passed on to it whole.

A parameter explodes when it is both. Without availability, a function
whose callers all hold heap records would gain a forwarding call and
save nothing.

Together the two keep the number of unpackings down across a chain of
calls. A record that enters as a literal is never built: each core
passes the fields it was given to the next core. A record that enters
as a heap value is unpacked once, by the first forwarder it reaches.
No core rebuilds a record it was given as fields, because a parameter
that needs the record is never exploded.

## The explosion pass

`explodeRecordParameters` runs in `module-generator.zena` after
reachability, the generator and async splits and the component
adapters, and before `wasm.layout()`: after, because those passes add
callers and value uses; before, because it interns signatures.

For each eligible function `f` it adds a **core**: a new `WasmFunction`
named `f.core` with the same node and model, whose signature has each
exploded parameter replaced by its record's fields in `dispatch.fields`
order. That is the record struct's own field order, sorted by name, so
the `$present` words come first. An `ExplosionSpec` on both `f` and the
core records, per declared parameter, the dispatch it was exploded
through.

`f` itself keeps its signature and becomes the **forwarder**: its body
reads each exploded record's fields through the record's getters and
calls the core. So every way of reaching `f` that does not pass a
literal (a record value, a function value, an export, a tagged
template, an injected default) still calls a function with the boxed
signature, unchanged. Only the direct-call lowering knows about cores.

### Callee lowering

The core binds each exploded parameter's fields as entry block
parameters, then rebuilds the record from them (`#packRecord`) and binds
the parameter's symbol to that record, recording it in
`LoweringContext.explodedRecords` with the field values. Every record
read in the lowering goes through `recordDispatchRead`, which answers a
read off such a record, through the same dispatch, with the field value
directly. Field reads, presence tests, `??` and destructuring defaults
all go through it.

The rebuilt record then has no uses, and dead-code elimination deletes
it at `-O1`. If a use the escape check accepted turns out to need the
record whole, the record is still there and the program is still
correct; it only pays the allocation back.

### Call-site lowering

`#lowerDirectCallTo` calls the core when the call injects no defaults
and at least one argument for an exploded parameter is unpacked:

- a record literal whose type is exactly the parameter's record type,
  with no record adaptation recorded on it, lowered by
  `#lowerRecordLiteralFields` against the parameter's dispatch;
- an exploded parameter of the calling core, passed as the field values
  it was bound from (`LoweringContext.explodedRecords`).

Any other exploded argument in that call is a heap record, and its
fields are read through its getters at the call. Sending the whole call
to the forwarder instead would make the calling core rebuild an
unpacked argument. A call with no unpacked argument calls `f`.

### Record dispatch liveness

Explosion does not retire a record shape's dispatch: the forwarder and
any other boxed use still read through it. When no call reaches the
forwarder, harvest (`ir/harvest.zena`, `-O1` and up) deletes it, and the
dispatch's getters and vtable with it if nothing else uses them.

## Verification

- `zena/test/zir-backend_test.zena`:
  - "a record literal argument is passed as its fields": at `-O1`, the
    caller allocates nothing and calls `f.core`, and the core has no
    `call_ref` and no allocation. Before this change the caller
    allocated four times.
  - "a record value argument goes through the forwarder": a caller
    passing a record it holds calls `f`, and `f` calls the core.
  - "a record passed on whole stays as its fields": a literal passed to
    `outer`, which passes it to `inner`, is never built, and
    `outer.core` calls `inner.core` with its fields.
- `tests/language/execution/records/across-calls/`: plain execution
  tests that pass with or without explosion, each aimed at a seam the
  pass creates, so a wrong core or forwarder shows up as a wrong
  result. Literal, value, wider-record and function-value calls of one
  function agreeing; records forwarded through chains, recursion,
  mutual recursion, and into a function that keeps them; mixed literal
  and heap arguments; presence through exploded fields (explicit zero,
  omitted, defaults, `??`, a reference-typed optional field);
  evaluation order across arguments and inside literals with spreads;
  escaping parameters that must stay boxed; two record parameters with
  a plain one between; results returned, merged from arms, held in
  `var`s, bound, and passed straight on; methods, statics and
  overridden methods; unnamed, named and generic constructors, and
  `super(...)` records at every level of a chain; generic functions and
  methods per instantiation. `npm run test:execution -w
@zena-lang/zena-compiler -- across-calls` runs exactly this set. The
  WAT tests above are what show the optimization happens.
- Stage-2 byte parity, as always.

## Alternatives considered

**Rewrite the original function's signature.** The first version of
this design exploded the function in place and listed every consumer
that derives from its signature as an exclusion: value-taken functions
(closure wrappers), exports (component adapters), namespace members,
tagged templates, synthesized callers. Missing one would miscompile. A
separate core leaves all of them untouched, at the cost of one extra
function per exploded function that has boxed callers.

**Explode only destructured parameters.** Keying explosion to the
parameter being destructured in the signature would make the trigger
visible in source, but `({timeout = 30}: Opts) => …` and
`(opts: Opts) => opts.timeout ?? 30` are the same program. Tying the
representation to the spelling would mean a style refactor silently
changes the cost. The escape check keys on what both spellings share:
the callee consumes fields, never the record.

**A profitability heuristic** (field-count cap). With the forwarder
there is no case left for a heuristic to protect, and a cap is a cliff:
the seventeenth field silently changing a function's calling convention
is the kind of illegible cost model this project avoids.

**A hint to enable explosion.** Automatic-where-legal needs no opt-in.
The useful explicit form is the opposite polarity, a _guarantee_,
below.

### The `inline` parameter guarantee

The escape check makes explosion automatic but also silent in both
directions: adding `this.lastOpts = opts;` deep in a callee re-boxes
every call site and nothing reports it. `inline` on a record parameter
(the same word, and the same meaning, as `inline` tuples: a
representation guarantee, not a request) would assert the parameter
explodes and turn any escaping use into a compile error. It is deferred
only because it is syntax; the check is the escape check's existing
verdict.

## Results

A top-level function returning a record can return the record's fields
as wasm results instead, when some call only reads them:

```zena
let step = (p: V): V => ({x: p.x + 1, y: p.y});

let {x, y} = step(v);   // step.core returns (x, y); no record is built
```

It is the same core and forwarder: `ExplosionSpec.result` is the
record's dispatch, the core's results are its fields in
`dispatch.fields` order, and the forwarder calls the core and builds the
record for every caller that needs it whole. One core can take fields,
return fields, or both.

The two facts run the other way from parameters:

- **Demand**, from the caller. Reachability records every direct call
  whose result is a record (`recordResultCalls`). A call's result is
  only read for its fields when the call is `f().field`, the source of
  `let {...} = f()`, an argument for a fields-only parameter of the same
  record type (`g(f())`), or the initializer of a `let` whose every use
  reads a field, destructures it, or passes it to such a parameter. A call returned from another function or
  method, as its `return` operand, expression body or value block's
  tail, counts when that function's result is demanded.
- **Availability**, from the callee. Some return produces the fields
  without the record: a record literal, an exploded parameter of the
  same record type, a call to a function or a direct call to a method
  whose result explodes, or an `if` or `match` with such an arm (through
  nested ones and value blocks' tails).

A result explodes when it is both. `return g(...)` in `f` ties the two
functions together in opposite directions: `g` is demanded when `f` is,
and `f` produces the fields when `g` does. So the pass settles demand
first, growing it from "nothing is demanded", and then grows
availability among the demanded functions until nothing changes. Growing
both at once, as the pass first did, never starts a chain whose only
demand is at its head: in `let {x, y} = f()` with `f` returning
`g(...)`, `f` could not produce until `g` exploded, and `g` was not
demanded until `f` exploded. The split is consistent: when `g` explodes
because `f` is demanded, `f` returns `g(...)` and so produces too.

A method's return counts toward its own result by the method's
candidate key. A method of a generic class is one function per
instantiation, and a recorded call in its body does not say which, so a
call returned from one does not count.

A result passed on to a fields-only parameter, straight or through a
`let`, makes that parameter available unpacked when the call's result
explodes, as a held var does: the lowering holds the result as its
fields (`explodedRecords`), and the call it is passed to takes them. A
marked call among a call's arguments sends that call to the core
(`#passesUnpackedArg`), and the argument's lowered value, held, passes
its fields (`#lowerExplodedArgs`).

Measured on `acc = acc ^ use(bump(make(i)))` in a loop, three
functions each taking or returning a record, two million iterations:

| build | before         | after          |
| ----- | -------------- | -------------- |
| `-O1` | 113 ms, 8.2 KB | 2.3 ms, 8.0 KB |
| `-O2` | 2.2 ms, 7.1 KB | 2.2 ms, 7.1 KB |

The compiler's own module grows by 318 bytes (2,252,249 to 2,252,567).

Measured on a loop destructuring `wrap(g, i)`, a function returning
`g.shift({x: n, y: 1}, 2)`, a method of a class with no subclass, two
million iterations (wall time, including process start):

| build | before | after  |
| ----- | ------ | ------ |
| `-O1` | 57 ms  | 2.2 ms |
| `-O2` | 2.0 ms | 2.0 ms |

Before, neither `wrap` nor `shift` exploded, since each waited on the
other. At `-O2` the inliner already brought both into the loop. The
compiler's own module grows by 582 bytes (2,251,667 to 2,252,249).

A parameter returned whole ties a parameter's verdict to its own
function's result: returning it is a fields-only use when the result
explodes, and an exploded parameter returned is the result's fields on
hand. Demand assumes such a return keeps the parameter fields-only. When
the results are settled, a parameter that would explode while its
function's result does not needs the record after all, so the pass
marks it and runs demand, availability and results again. Each round
only takes parameters away, so it ends. `(v: V): V => v` called with a
literal and destructured then passes the fields through without a
record on either side. It then marks the calls whose results
lowering holds as fields (`wasm.fieldsOnlyResultCalls`, by node id).

**Lowering.** In a core with an exploded result, every return site
(`return`, an expression body, a value block's tail) goes through
`#returnFields`: a record literal lowers straight to fields, a record
held as fields passes them, and any other record is read field by field.
Returns inside `finally` regions park the values like inline-tuple
returns do.

A returned `if` or `match` merges its arms' fields instead of their
records: `#returnFields` hands the expression the dispatch
(`LoweringContext.resultFields`), its merge takes one block parameter
per field (`MergeState.fields`), and each arm passes its record's
fields. An arm that is a record literal of the exact shape lowers
straight to its fields, a nested `if` or `match` arm merges fields the
same way, and any other arm (a heap record, a call, a value block) has
its fields read. After the merge the record is rebuilt from the
parameters and held as them, so the return takes the parameters and the
rebuilt record dies. Without this, each literal arm built its record
for the merge, and the core read the fields back.

On a loop calling a function that returns an `if` of two literals,
destructured, two million iterations (wall time, including process
start):

| build | before | after |
| ----- | ------ | ----- |
| `-O1` | 60 ms  | 5 ms  |
| `-O2` | 25 ms  | 5 ms  |

At a marked call, `#lowerDirectCallTo` calls the core, takes its
results, and holds them as the record (`explodedRecords`), so field
reads, destructuring and further fields-only uses read the values and
the record built from them dies.

Excluded: functions with a `tail return`, whose call the core could not
turn into fields, and records with no fields.

Measured on a loop calling an out-of-line function that returns a
two-field record literal, destructured, bound and read, and returned on
through a second function, two million iterations:

| build | before | after |
| ----- | ------ | ----- |
| `-O1` | 127 ms | 15 ms |
| `-O2` | 24 ms  | 15 ms |

Before, at `-O2`, the callee was specialized and devirtualized but still
allocated its result at every call.

### Held vars

A `var` local of a record type is _held as its fields_ when every use
reads a field, destructures it, is the target of a plain `=`, or passes
it to a fields-only parameter of the same record type, and every value
written to it (the initializer and each assignment) is a record literal,
a call to a function or a direct call to a method whose result
explodes, or another held var:

```zena
var pos: V = {x: 0, y: 1};
for (var i = 0; i < n; i += 1) {
  pos = step(pos);   // step.core takes and returns the fields
}
return pos.x;
```

`pos = step(pos)` makes the var and the result depend on each other: the
var is held only if the result explodes, and the result is demanded only
if the var is held. So held vars start optimistic. Each round, the
results are recomputed from "nothing explodes" given the current held
vars, and any var with a write that lacks its fields is dropped, until
none is. A held var passed to a fields-only parameter makes that
parameter available unpacked, like an exploded parameter does.

In lowering, a held var's initializer and assignments produce a held
record (`#lowerHeldWrite`). At every join, `addParams` gives a held var
one block parameter per field, `envValues` passes its fields, and
`applyParams` rebuilds the record from the field parameters and holds
it, so field reads read the parameters and the record dies. That needs
the join block to be current when `applyParams` runs, which every join
site now ensures.

Measured on `pos = step(pos)` in a loop, two million iterations:

| build | before       | after       |
| ----- | ------------ | ----------- |
| `-O1` | 47 ms, 305 B | 3 ms, 121 B |
| `-O2` | 7 ms, 231 B  | 2 ms, 92 B  |

Not yet covered:

- A var captured by a closure, which needs a cell holding the record.
- A `var` written an `if` or `match` with literal arms: only returns
  merge an expression's arms as fields.

## Later phases

- Async functions and generators.
- The `inline` parameter guarantee above.
- Teaching spread and `==` to consume exploded bindings.
- Weighting call sites, for example by loop depth, for a function with
  few unpacked and many heap callers, whose heap callers each pay the
  forwarder's up-front field reads.
- A literal whose type differs from the parameter's (a wider literal,
  or one the checker adapts) passed as fields, instead of through the
  forwarder.
- Calls with injected defaults, once a default can read an exploded
  parameter's fields.
