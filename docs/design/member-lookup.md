# Member Lookup and Overload Resolution

## Status

- **Status**: **Partially Implemented** — core overload resolution (most-specific
  selection, two-tier literal adaptation, subclass overlap restrictions,
  per-signature vtable mangling, lexical private `#` access) is fully implemented
  and tested. Namespace separation, interface overloads, contextual tear-offs,
  and cross-arm union access remain open.
- **Issue**: https://github.com/elematic/zena/issues/70
- **Gaps**: See [§9. Implementation-gap index](#9-implementation-gap-index)

This is the authoritative specification for how Zena resolves member
accesses (`recv.name`, `recv[i]`, operators) and how overloaded
callables are selected — for methods, free functions, and `declare`
interop functions alike.

Identifier resolution — which declaration a _bare name_ refers to — is
covered by `name-resolution.md`. This document picks up after that:
the receiver expression already has a static type, or the callee name
already resolved to a function (possibly an overload set).

The body text describes the **settled language semantics**. Where the
compilers have not caught up yet, the divergence appears as an
indented **Status** block; each such block is tracked in BUGS.md and
gets deleted when the implementation lands. Notes marked
_implementation note_ describe compiler strategy that is not
observable in the language and could be done differently.

## 1. Principles

1. **All lookup and selection is static.** The checker alone decides
   which member a name refers to and which overload signature a call
   uses, from static types. Codegen consumes recorded decisions; it
   never re-derives them. The only things resolved at runtime are
   _which override_ of an already-selected virtual slot runs, and
   _which implementation_ backs an interface slot.
2. **Overload-ness is a static property.** Whether a callee is
   overloaded is determined entirely by its declaration site(s) and
   the receiver's static type. For every well-typed call the checker
   selects exactly **one** declared signature. There is no runtime
   overload selection anywhere in the language (see §10 for the
   dynamic-dispatch machinery that would change this, deferred).
3. **Privacy comes from the source; dispatch comes from values.**
   Private (`#`) names resolve lexically only — see §6.

## 2. The member namespaces of a type

### 2.1 Instance members: one namespace, one map

Each class or interface has a single **instance-member namespace**: a
name denotes at most one member. Member kinds share that namespace —
fields, methods (an overloaded method is _one_ member owning a set of
signatures, §4), accessor pairs (a getter and setter for the same
name form one logical member), and operator members. Declaring one
name as two different kinds in the same class body is a **collision
error**; there is no lookup "order" among kinds because a well-formed
class never needs one.

Operator members are named by their glyph: `[]`, `[]=`, `==`, `+`,
`-`, `*`, `/`, `%`. Note `[]=` is a distinct member from `[]`, not an
arity-2 variant of it. Other operator glyphs are reserved.

> **Status.** The implementation stores members in one map with
> accessor keys mangled as `get#name` / `set#name`, and probes
> field → method → getter in that order. Cross-kind collisions are
> not yet uniformly diagnosed; the probe order acts as a de-facto
> precedence instead of an error.

### 2.2 Static members: a separate namespace

Static members form their **own namespace**, held by the class
itself: `T.foo` resolves in the static namespace, `t.foo` in the
instance namespace. The same name may exist in both without
conflict.

> **Status.** The implementation keeps statics in the same map as
> instance members with an `isStatic` flag, so a static and an
> instance member of the same name currently collide.

### 2.3 Inheritance

A class's instance-member set is the union of its own declarations
and its superclass's set, with these rules:

- Private (`#`) members are **never** inherited (§6).
- Redeclaring an inherited name must be an **override** of the same
  member kind (method signature overrides its slot per §5.3, accessor
  overrides accessor). Redeclaring an inherited name as a different
  kind is a collision error.
- Inherited generic members are seen through the subclass's type
  arguments (substitution).

_Implementation note._ Whether the compiler materializes the
inherited set eagerly (today: members are copied down into each
subclass's map at class-build time, giving flat single-probe lookup)
or walks the superclass chain with memoization is not observable in
the language. A lazy memoized walk may be worthwhile — programs look
up a small subset of members — but note the checker also enumerates
full member sets per class (conformance checking, vtable building,
case-class synthesis), which bounds the potential savings.

## 3. Member access on a receiver

Given a receiver expression of static type `T` and a property name
`p`:

1. **Privacy gate.** A `#`-prefixed name is only accessible lexically
   inside the body of the class that declares it (§6).
2. **Class/interface receivers.** Probe the instance-member namespace
   of `T` (the static namespace when the receiver is the class name
   itself). Missing member ⇒ error.
3. **Union receivers.** Member access on a union is valid iff
   **every arm** supports the member; the access's static type is the
   union of the per-arm member types. Calls select an overload
   per-arm (§5.1) and are well-typed if selection succeeds on every
   arm; the call's type is the union of the per-arm result types.
   `null` is not special: the `null` arm supports no members, so a
   plain access on `T | null` is an error exactly like any arm
   missing the member. Optional chaining `recv?.p` is sugar that
   skips the `null` arm and unions `null` back into the result type.

   > **Status.** Only the `null`-arm case is implemented (plain
   > access errors with "object may be null"; `?.` works). Valid
   > cross-arm access on non-null unions is not implemented yet —
   > the checker rejects member access on multi-arm unions, so code
   > must narrow first.

## 4. Overload sets

An **overload set** forms when multiple same-named callables are
declared in the same scope. An overloaded member is one member whose
type carries a _set_ of declared signatures; the set is semantically
**unordered** (selection is by specificity, §5.1, never by position),
and each signature has its own implementation body.

- **Methods**: multiple same-named method declarations in one class
  body. Subclasses interact with the set per-signature: overriding
  replaces one signature's implementation (§5.3); _adding_ signatures
  is constrained by the overlap restriction (§5.1).
- **Free and `declare` functions**: same mechanism. For
  `declare function` interop, each overload maps to its own host
  import — the original motivation for the feature (unboxed
  `print_i32` / `print_f32` style bindings).
- **Interfaces**: interfaces may declare overloaded methods, e.g.
  `Array` declaring both `[](i: i32)` and `[](r: Range)`.
  Conformance and dispatch are per-signature (§5.4).

  > **Status.** Interface overloads are not implemented: a second
  > same-named interface method silently overwrites the first
  > (BUGS.md). Until implemented, this must become a checker error.

> **Status.** The implementation represents an overload set as a
> "primary" `FunctionType` (the first declaration) carrying the later
> signatures in an `.overloads` array. Since the most-specific
> migration, the primary's only remaining semantic leak is the type
> of an overloaded tear-off (§7 Status); once that is fixed,
> "primary" is purely a representation detail.

## 5. Overload selection and dispatch

### 5.1 Selection: most-specific, statically

At every call-shaped site — plain calls, method calls, `recv[i]`
reads (`[]`), `recv[i] = v` writes (`[]=`), and operator uses — the
checker selects exactly one signature from the callee's overload set
(the receiver's _static_ type's set, for members):

1. **Applicability**: a candidate is applicable if the argument count
   fits (counting optional parameters) and every argument type is
   assignable to the corresponding parameter type.
2. **Specificity**: candidate `X` is _at least as specific as_ `Y`
   iff every parameter of `X` is assignable to the corresponding
   parameter of `Y`.
3. **Selection**: the selected signature is the unique applicable
   candidate that is at least as specific as every other applicable
   candidate. No applicable candidate ⇒ "no overload matches" error.
   Applicable candidates but no unique most-specific one ⇒
   **ambiguity error** (resolve with a cast or an exactly-typed
   argument). Declaration order carries no meaning.

**Applicability runs in two tiers, so literals don't blur selection.**
A bare numeric literal has no type of its own until a context supplies
one, so judging every candidate against an adapting literal at once
would make `div(10, 3)` applicable to all four of `zena:math`'s
integer signatures, and therefore ambiguous. Instead the first tier
types each argument on its own — a literal without a `.` is `i32`, one
with a `.` is `f64` — and applies rule 1 exactly as written. Only when
that tier leaves the applicable set **empty** does a second tier run,
in which an argument the caller wrote as a bare numeric literal is
judged by whether it _could_ be written at the parameter's type,
range included for the range-checked types, rather than by the type it
took on its own. That is what resolves `div(someU32, 10)` to
`(u32, u32)` instead of failing. Rules 2 and 3 then apply unchanged to
whichever tier produced the candidates, so a literal that reaches two
incomparable signatures is still an ambiguity error. Because the
second tier only ever runs on an empty applicable set, it can only
turn a call that was an error into one that compiles — it can never
move a call from one signature to another. The same two tiers apply at
the `[]` and `[]=` sites, where the adapting operand is the index —
without them `t[10]` cannot reach an `operator [](k: u32)` at all, and
before they existed such a read selected nothing, reported nothing,
and failed in ZIR lowering.

Three operand positions are deliberately excluded from the second
tier. Arguments beyond the ones the caller wrote — defaults spliced in
from the first-declared signature — do not adapt, because they are
never re-checked against the signature that wins, so adapting one
would select an overload on the strength of a _different_ overload's
default. Neither does the value operand of `[]=`: under a compound
assignment that expression is the right side of the `+=` rather than
the value being stored, and its type is already settled by the read
half.

**Union-typed arguments don't blur selection.** Assignability of a
union requires _every_ arm to be assignable, so an argument of type
`Dog | String` is applicable only to candidates whose parameter
accepts the whole union — it never makes both `f(Dog)` and
`f(String)` applicable. A call with a union argument either finds a
union-accepting candidate or is an error; narrowing chooses a
specific overload.

**Overlap restriction on subclass additions.** A subclass may not
_add_ a new overload whose parameter tuple **overlaps** an inherited
signature of the same name. Overlap is about possible runtime
values, not call-site types: two signatures overlap iff some value
tuple would be applicable to both — pointwise, each parameter pair
shares a possible common value. (Per the previous paragraph,
union-typed call sites cannot manufacture overlap.) Overlapping
alternatives must be declared at the class that introduces the
overload set, and subclasses participate by overriding per-slot
(§5.3). Adding a genuinely disjoint signature remains legal. For
class-typed parameters, overlap is subtype-comparability; for
interface-typed parameters it is "do these types share a common
subtype" — conservatively assumed when not provable, exact under
whole-program knowledge (closed world: check for a live common
subtype via RTA).

**Rationale — soundness vs coherence.** Selection over the static
type's set is always _sound_ (§5.3: the chosen slot exists, with
that exact signature, on every runtime receiver), but without the
overlap restriction it can be _incoherent_: a subclass-added
overload is invisible through supertype references, so the static
choice could differ from what selection would yield knowing the
runtime type. The restriction buys coherence loudly: silent
shadowing becomes a declaration-site overlap error or a call-site
ambiguity error. Full coherence is unattainable by receiver dispatch
alone anyway — an argument statically typed `Animal` but dynamically
a `Dog` selects `visit(Animal)` under every static rule; fixing
_that_ is multimethod dispatch on argument runtime types (§10.2,
rejected). Static argument types are the accepted boundary.

**Rejected alternatives**: (a) declaration-order first-match
repaired for coherence (in-place override, additions appended —
coherent but silently dead overloads and load-bearing order); (b)
synthesized runtime dispatch at the statically enumerable incoherent
sites (hidden dispatch cost for what is still only receiver-side
coherence).

Implemented in both compilers (2026-07-23). Parameter-equivalent
applicable candidates (identical over the call's arguments, e.g. an
exact-arity signature vs. one reached through optional parameters)
tie-break toward the exact-arity candidate. Overlap for
interface-typed and type-parameter positions is conservatively
assumed; whole-program (RTA-exact) overlap remains available as a
refinement. Pinned by `classes/overload-declaration-order.zena`
(most-specific wins regardless of order),
`classes/overload-override-reorder.zena` (selection coherent across
reference types), `classes/overload-nullability.zena` (`T` beats
`T | null`), and `semantics/classes/overload-most-specific.zena`
(ambiguity and overlap errors).

> **Status.** The index (`[]`) selection paths still consider only
> single-parameter candidates and skip optional-parameter handling.

### 5.2 Recording: the checker→codegen contract

When (and only when) the callee had an overload set, the checker
records the selected _declared_ signature on the call/index node:
`SemanticModel.setResolvedOverload(node, ft)`. Codegen must:

- reproduce the registration slot name from the record —
  `name + getSignatureKey(recordedFt)` (§5.3) — and
- treat the record as exact: when a record exists, **only** that slot
  is acceptable. Falling back to a plain-name lookup could silently
  bind a different overload; a miss is a compiler bug and must be
  loud.

Codegen never inspects argument node types to (re)choose an
overload.

### 5.3 Registration and virtual dispatch: per-signature slots

Codegen registers each overload as its own function with a mangled
name: `name + signatureKey` when the member is overloaded, the plain
`name` otherwise. Each mangled name is its own vtable slot, so
overriding is **per-signature**:

```zena
class Base {
  foo(x: i32): i32 { ... }   // slot foo$i32
  foo(x: f64): i32 { ... }   // slot foo$f64
}
class Child extends Base {
  foo(x: i32): i32 { ... }   // replaces slot foo$i32 only
}                            // foo$f64 inherited unchanged
```

**Why dynamic dispatch never picks a signature.** Every virtual call
makes two decisions at different times:

1. _Which signature_ (= which slot): static, from the receiver's
   static type's overload set (§5.1). Fixed at the call site.
2. _Which body fills that slot_: dynamic, by indexing the runtime
   receiver's vtable at the already-fixed slot.

This is sound because the slot's signature is invariant across the
hierarchy **by construction**: a subclass method only occupies an
existing slot if its parameter list is exactly equal to the
inherited signature. A same-named method with any _other_ parameter
list — even an assignable refinement like `visit(d: Dog)` under an
inherited `visit(a: Animal)` — is not an override but a **new
slot**, which supertype-typed call sites cannot name (and whose
addition the §5.1 overlap restriction constrains). Subtypes can add
slots and replace slot bodies; they can never remove a slot or
change a slot's signature. So the signature set reachable from a
call site is closed at the static type, every possible runtime
receiver honors it, and the runtime only ever chooses among bodies
sharing one identical signature.

Consequently, for polymorphic receivers: a call through a supertype
reference can only select signatures the supertype declares, and the
signature selected for a call is fixed at compile time even though
the method body that runs is not. There is no "re-selection" against
the runtime type's overload set.

### 5.4 Interface dispatch

Interface slots are keyed per-signature, exactly like class vtable
slots: an interface declaring `[](i: i32)` and `[](r: Range)` has two
slots. A conforming class binds, per slot, its method matching that
signature; a call through an interface reference statically selects
the slot (§5.1) and dynamically picks the implementing class's bound
method. There is never a signature choice at runtime.

> **Status.** Interface slots are currently keyed by bare member
> name — one slot per name — which suffices only because interface
> overloads are unimplemented (§4 Status).

### 5.5 Operator calls fold into method resolution (unification plan)

Every operator form is a method-like call on an operator member
(§2.1) and conceptually desugars to one:

| Form            | Desugars to   | Today's checker path     |
| --------------- | ------------- | ------------------------ |
| `a.m(x)`        | —             | call checking            |
| `a[i]`          | `a.[](i)`     | `resolveIndexType`       |
| `a[i] = v`      | `a.[]=(i, v)` | assignment checking      |
| `a == b`        | `a.==(b)`     | binary-operator checking |
| `a + b` etc.    | `a.+(b)` etc. | binary-operator checking |
| `a(x)` (future) | `a.<call>(x)` | — (callable classes)     |

The semantics are already uniform — member lookup (§3), most-specific
selection (§5.1), recording (§5.2), per-signature slots and dispatch
(§5.3) apply to all of them identically. The IMPLEMENTATIONS are not
yet: each form has its own checking site and its own lowering path in
each backend. This section pins the intended end state so the code
paths converge instead of accreting:

1. **One checker entry.** All method-like forms resolve through a
   single internal "resolve member call" routine: collect the
   overload set from the receiver's static type, collect applicable
   candidates, select most-specific, record the declared signature on
   the SYNTACTIC node (call node, IndexExpression for reads,
   AssignmentExpression for `[]=` writes — a compound assignment is
   one read selection plus one write selection on distinct nodes),
   and derive the expression's type from the selected signature.
   Today the selection tail is shared (`selectMostSpecificIndex`)
   but applicability collection and expected-type flow are still
   per-site; unifying them also fixes the known bug that index
   writes are typed by the `[]` READ selection (BUGS.md) — under the
   unified entry, `a[i] = v` is typed by `[]=` like any call.

2. **One lowering path per backend.** Codegen lowers every
   method-like call the same way: reproduce the recorded slot name
   (§5.2), then **devirtualize** (final class/method, no overriding
   subclass, concrete receiver) into a direct call, else dispatch
   through the vtable/itable slot. Operator forms get no bespoke
   lowering branches.

3. **Intrinsic inlining as an optimization, not a special case.**
   After devirtualization, a direct call whose callee is
   intrinsic-flagged (`array.get`, `array.set`, `array.len`, `eq`,
   `hash`, the memory ops) is replaced by the raw instruction. Under
   this shape, `FixedArray` indexing needs no dedicated index-lowering
   path at all: `a[i]` resolves to the `[]` member, devirtualizes to
   the `array.get` intrinsic, and inlines — the "array fast path"
   becomes an optimization outcome. The standalone intrinsic
   functions keep their §-noted role: real bodies only where a
   funcref slot can reach them (`array.len` via `Array.length`),
   trapping tripwires elsewhere.

4. **Callable classes (future).** A call operator member would give
   `obj(args)` the same fold: look up the call member, select the
   overload, record, dispatch. Nothing else in the pipeline changes —
   which is the point of the fold. (Closures could then be understood
   as instances of a builtin callable class; not designed here.)

**Fast paths under the unified model.** Two cases look like fast
paths but are different things. Arithmetic on primitives never
enters this pipeline at all: primitives have no members, so
`i32 + i32` is a builtin numeric operation typed directly by the
checker — it lowers to `i32.add` in every version of this design,
not as an exception but as a different semantic category (only
class-typed operands, e.g. `String.+`, resolve through §5.1).
For member-resolved forms where the static type already decides
everything (indexing a statically array-typed receiver), the fast
path SHOULD survive — but as _shared machinery run eagerly_, not as
separate lowering logic: lowering emits the resolved-call form and
immediately applies the same devirtualize/legalize transfer
functions the passes use, materializing only the simplified result
(builder-level folding, as in LLVM's IRBuilder constant folding).
One copy of the logic, two invocation points: eagerly at
construction when lowering-time facts suffice, and again in the
passes when later information (e.g. inlining revealing a concrete
receiver) creates new opportunities. What must NOT survive is
today's shape — hand-written eager branches that duplicate the
decision logic and can drift from it.

A note on the current array fast path: lowering `a[i]` straight to
`array.get` for statically array-typed receivers is not a semantic
special case but an eager fusion of steps whose outcomes are
statically total there — wasm arrays carry no vtable (virtual
dispatch on an array value is unrepresentable), `FixedArray` is an
unsubclassable extension class represented as the bare array ref,
and its `[]` resolves to exactly one intrinsic. And because
standalone intrinsic functions are trap stubs, replacing intrinsic
callees with raw ops is mandatory LEGALIZATION, not optional
optimization: some phase must do it, and with no pass pipeline yet,
that phase is lowering. Once the pipeline exists, the fusion should
retire — passes seeing pre-fused ops instead of calls would hide
exactly the devirtualization opportunities the uniform call form
exposes. (Devirtualizing an INTERFACE dispatch down to `array.get` —
proving a `Array` is always a `FixedArray` — is by contrast a
genuine future optimization no backend attempts today.)

Status: the checker shares the selection tail across all sites; the
ZIR backend shares slot-name reproduction but still has dedicated
index/eq-hash lowering branches.

## 6. Private names

Private (`#`) member resolution follows one rule: **lexical only,
never virtual, always direct**.

- `this.#x` (or `obj.#x`) resolves against the class _lexically
  enclosing the expression_ — the class whose body the source text
  sits in — never against the runtime or even static receiver
  hierarchy. This holds even where the compiler copies inherited
  method bodies into subclasses: the copy still resolves `#x` to the
  declaring class's field.
- Private names are never inherited and never shared between super-
  and subclasses. `A::#x` and `B::#x` are distinct fields even when
  `B extends A`; neither can access the other's.
- Private access is direct (field offset / direct call), never a
  vtable dispatch. Private methods cannot be overridden.
- **Generics**: specializations of one generic class share the same
  lexical class, so a method of `Box<i32>` may access `#x` of another
  `Box<T>` instance it holds — privacy is granted by the lexical
  class and is unaffected by specialization. (Pinned by
  `classes/private-fields-generic.zena`.) _Implementation note_: the
  physical struct-field name may carry either the specialization's
  key or the shared template's key;
  `WasmStruct.resolvePrivateFieldName` owns that mapping in both
  backends — frontends must not synthesize private field names by
  string convention.
- **Mixins**: each mixin _application_ produces a new class, but the
  mixin _declaration_ is one lexical scope — all applications of a
  mixin share its private names lexically, exactly like
  specializations of a generic class. (This is deliberately stronger
  than the JS mixin pattern, where every application gets fresh
  private names.)

  _Implementation note_: mixin privates are namespaced by a scope key
  equal to the MixinKey identity (declaration name + source path);
  fields are stored and named as `"<scope>::#name"`, private methods
  register per host under the scoped name, and functions compiled
  from mixin bodies carry the scope (`WasmFunction.privateScopeKey`)
  for their own private accesses. Pinned by
  `mixins/private_names.zena` and `mixins/private_methods.zena`.

  The scope is a fact about **where the source text was written**, so
  lowering derives it from the function's node (`mixinScopeOfNode`
  walks the AST to the enclosing `MixinDeclaration`) rather than from
  whichever path registered the function. Deriving it from
  registration instead left it unset on every function a mixin's
  member-collection loop does not name — a closure inside a mixin
  method, a monomorphized copy of a generic mixin method — and those
  bodies then read and wrote the HOST's same-named private. Pinned by
  `mixins/private_names_in_closure.zena`,
  `mixins/private_methods_in_closure.zena`,
  `mixins/private_accessors_in_closure.zena` and
  `mixins/private_names_generic_method.zena`.

  Reachability names them like any other member. A private name in a
  mixin body queues a referrer for the member **that mixin** declares,
  chosen by the accessing body's own scope key rather than by a
  name-only search (the CHA searches scan the host's body first and
  would find the host's same-named private, a different member). Both
  the full walk and the dependency-record walk do this, since a private
  read reaches an accessor and a private call reaches a method. Before
  that, nothing named them at all, and RTA compensated by force-reaching
  every `"::"`-named member of every instantiated class — so a mixin's
  unused privates were emitted once per host class.

  A function that has a scope resolves `#name` under that scope and
  **nowhere else**: a mixin body cannot name a host's private at all
  (pinned by `mixins/mixin-base-private-field.zena`), so a scoped miss
  is a compiler bug and lowering bails. It used to fall through to the
  unscoped lookup, where the host's same-named member was waiting —
  which is what made all four bugs above silent wrong answers instead
  of loud failures.

- **Private accessors** use the grouped form
  (`#name: T { get { ... } set(v) { ... } }`) and follow the same
  rules as private fields and methods: lexical to the declaring class
  or mixin, direct dispatch with no vtable slot, no override
  relation. Pinned by `classes/private-accessors*.zena` and
  `mixins/private_accessors.zena`.

- **Interfaces cannot declare private members.** A `#`-prefixed name
  in an interface body is a parse error in both compilers. Privates
  are a class/mixin construct.

## 7. Tear-offs of overloaded members

Accessing an overloaded method as a value (`let f = obj.method`)
needs a single signature for the resulting closure. Resolution is
**context-sensitive** against the expected type — assignability to a
function type already requires a specific signature:

```zena
let printInt: (x: i32) => void = p.print;  // picks print(i32)
run(p.print);       // picks the overload matching run's param type
let f = p.print;    // no context: error, ambiguous overload reference
```

The escape hatch is a lambda: `let f = (x: i32) => p.print(x);`.

Generating a boxed runtime dispatcher instead (accept `anyref`,
`ref.test`, branch) was considered and **rejected**: hidden boxing
and runtime checks, and context-sensitive resolution covers static
usage. See §10.2.

> **Status.** Not implemented: an overloaded tear-off today silently
> yields the first-declared signature, ignoring context (BUGS.md).

## 8. What codegen may assume

Summarizing the contract this spec creates:

1. Every call/index node whose callee had an overload set carries a
   recorded declared signature; the slot name is
   `name + getSignatureKey(recorded)` and must resolve exactly (§5.2).
2. Member identity for dispatch comes from the receiver _value's_
   struct/class info; privacy and private field naming come from the
   _lexical_ class via `resolvePrivateFieldName` (§6).
3. No signature reconstruction from argument node types anywhere.

## 9. Implementation-gap index

Every **Status** block above, in one place; all tracked in BUGS.md:

1. Interface overloads unimplemented; same-name interface methods
   silently last-win, must become an error until implemented (§4).
2. Overloaded tear-offs silently pick the first-declared signature
   instead of context-sensitive resolution (§7).
3. Cross-arm member access on non-null unions unimplemented (§3).
4. Static/instance members share one namespace in the
   implementation (§2.2).
5. Cross-kind member collisions not uniformly diagnosed; probe order
   acts as precedence (§2.1).
6. Bodyless methods in regular classes silently parse as empty-body
   overloads (BUGS.md; interacts with §4's one-member-per-name
   model).

## 10. Deferred designs

Recorded so the ideas aren't lost; none of this is committed.

1. **Single-implementation overloads** (TS-style: several signatures,
   one union-typed body, checker correlates argument to return
   types). Would trade mangled multi-implementation slots for one
   body plus per-signature bridge thunks in the vtable.
2. **Dispatcher thunks / boxed dispatchers** for call sites that
   cannot name a signature statically. Rejected for tear-offs (§7).
   The only other candidate sites — spreading a union-of-tuples into
   a call — do not exist in the language; if they ever do, a
   per-overload-set synthetic dispatcher (runtime `ref.test` chain
   over the candidates) is the shape to reach for.
3. **`dynamic` receivers** (`dynamic_call(obj, "draw", args)` via a
   name-keyed side table of dispatchers). Nothing in the current
   language needs it.

---

_History: this document superseded and replaced
`function-overloading.md` and `method-overloading.md` (2026-07-22);
their still-live ideas are folded in above, the deferred ones in
§10. The most-specific selection rule was ruled the same day._
