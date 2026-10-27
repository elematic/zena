# Template ZIR

Status: **In progress.** Tracks #410. Expands [ir.md](ir.md) §8
("Generics: specialize the IR, not the AST") with measurements and a
design that lands in steps. The first step, methods of generic classes
copied from templates learned from two representatives, is implemented
in `codegen/ir/template.zena`.

## Overview

The compiler monomorphizes generic code. Reachability (RTA) decides which
instantiations exist, and every instantiation gets its own
`WasmFunction`: `GrowableArray<String>.push` and
`GrowableArray<Diagnostic>.push` are two functions, and lowering walks
the same `push` AST once for each, under that instantiation's
substitution.

Template ZIR lowers a generic source function once and makes each
instantiation's body by copying the instruction arrays and substituting
the body's two indirection tables, `typeTable` and `refTable` (ir.md §4).

ir.md gave compile time as the reason, and it is no longer a large one
(Measurements, below). The reasons that remain are architectural:

- **Per-file caching** (ir.md §13). A per-file artifact cannot hold a
  monomorphized body, because the type arguments are only known for the
  whole program. It can hold a template.
- **Discovery from IR** (ir.md §2.2). An instantiation's dependencies
  are its template's references pushed through the substitution, so
  discovery could read templates instead of walking the AST again for
  each instantiation. RTA discovery is 39% of a self-compile today.
- **One optimization of a generic body.** Cleanup that does not depend
  on the type arguments runs once per template.
- **A test oracle.** A specialized body and a directly lowered body of
  the same instantiation must be equal. Comparing them checks both.

## Measurements

`ZENA_ZIR_STATS=1` reports these (`codegen/template-stats.zena`). The
numbers are from an idle machine with `ZENA_GC_RESERVE_MB=1536`. The
bodies lowered from one source function in one role form a **group**;
its bodies after the first are **repeats**.

| workload                                             | compile | repeat lowering + cleanup |
| ---------------------------------------------------- | ------- | ------------------------- |
| `packages/stdlib/tests/assert/assert_test.zena`      | 0.46 s  | 4 ms                      |
| `packages/zena-compiler/zena/test/checker_test.zena` | 2.7 s   | 0.22 s                    |
| compiler self-compile, `-O1`                         | 13.1 s  | 0.86 s                    |

ir.md §14 gave a 47 s cold compile of `assert_test.zena` as the reason
for this milestone; that case is gone. Without the GC reserve,
`checker_test.zena` takes 8.4 s, so garbage collection is the larger
lever for that file.

Of the 17,809 repeat bodies in the self-compile, 16,426 (92%) have the
same opcodes, operands, type ids and ref indices as the first body of
their group. Only the contents of the two tables differ. The rest first
part from their group's first body at one of a few operations:

| where the streams part                                             | count | example                                                                         |
| ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------- |
| `call` → `ref.is_null`, `ref.eq`, `i32.eq`, `i32.and`, `array.len` | ~520  | `HashMap<String, X>` hashes and compares keys by call, `HashMap<i32, X>` inline |
| `ref.as_non_null` → `array.set`, `ret`, `struct.get`               | ~410  | a reference element read from nullable storage is asserted, an `i32` is not     |
| `ref.null` → `const.i32`                                           | 62    | the zero value of `T`                                                           |
| `struct.get` → `param`                                             | 4     | `Completer<void>` has no value to store                                         |
| `array.get` → `array.get_u`                                        | 7     | a `u8` element is packed                                                        |

Discovery repeats more than lowering does. RTA's queue walks one item
per referrer, a member node or a symbol under one specialization's
substitution. In the self-compile (13.7 s, measured with temporary
timers around each item), items walking a node or symbol already walked
for another specialization took 1.97 s, against 3.16 s for first walks.
Of the 1.97 s, 1.27 s is the walk of the node itself
(`registerInstantiations`, or `discoverNodeTypes` for a body without a
dependency record), which a template's references could replace; 0.35 s
is the traversal of the checker's dependency records. Lowering and
discovery together repeat about 2.1 s of the compile, of which a
template can save the part that is walking rather than registering what
the walk finds.

## What lowering decides from the type arguments

Lowering decides three kinds of things from the substitution.

1. **The representation of a type argument.** A number kind (and, in
   storage, the packed width), a reference to a class struct, an
   interface fat pointer, a record or tuple struct, zero width (`void`),
   nullability. These change opcodes, arity, null assertions and zero
   values.
2. **Operations dispatched on a type argument's class.** Equality,
   hashing, string conversion, `is` and `as`.
3. **Facts about the specialization in the module.** A private field's
   name carries the key of the specialization's class
   (`GrowableArray_s3141_Diagnostic_s9392::#length`). Whether a read of
   a public field is a `struct.get` or a virtual getter call depends on
   whether some subclass of that specialization overrides the accessor
   (`accessorOverriddenBySubclass`). Whether a call is direct or through
   the vtable depends likewise (`memberProvidedBySubclass`). Both walk
   the transitive subclasses RTA registered for that specialization:
   `this.size` is a field read in `HashMap<i32, Node>` and a virtual
   getter in `HashMap<String, Type>`, which `OrderedHashMap` extends.

The third kind is why a template cannot simply be "the body lowered with
symbolic types": lowering consults RTA's per-specialization results, and
those differ between instantiations of the same body. Each such decision
is either checked for the instantiation being specialized or deferred to
specialization time.

## Design

### Families

A **candidate** is a non-static method or constructor of a generic
class or extension class specialization, written in the class, that is
not a generator or async function, a closure, an explosion core or
forwarder, a mixin method, or one of the roles lowering synthesizes
(`notCandidate`). A constructor's phases are candidates too: the value
phase `<ctor-init>`, which returns the class's field values for a
subclass to allocate with, and the written body `<ctor-body>`. Each
lowers as its phase on the template path as it does directly
(`ctorPhaseOf`). A **family** is the candidates lowered from one method
node, with one method name, whose type arguments agree on their
**pins**:

| type argument                                       | pin                               | varies within a family? |
| --------------------------------------------------- | --------------------------------- | ----------------------- |
| a class type (not `String`, not an extension class) | `C`                               | yes                     |
| an interface type                                   | `I`                               | yes                     |
| a union, record or tuple whose value is a reference | `R` and the key of that reference | yes                     |
| anything else (numbers, `void`, `String`, ...)      | the argument's specialization key | no                      |

So `GrowableArray<Diagnostic>` and `GrowableArray<Node>` share a family,
and so do the 517 `Future<Some<X> | None>` that lower `Some<X> | None`
to the same reference type; `GrowableArray<i32>` is a family of its own.
A family with fewer than three members is lowered directly.

### Learning a template from two representatives

A family's first two members, its **representatives**, are lowered in
template mode, and their bodies are used as they are. In template mode
the builder appends one type-table entry per `internType` call instead
of interning, so both bodies name their types by call order and their
tables line up entry for entry.

The two bodies must agree in everything but their tables' contents:
opcodes, operands, blocks, constants, try regions, and the answers to
the per-specialization queries (below). When they do not, the family
has no template (`representatives differ: <op> vs <op>` in the stats).

Then, position by position:

- An entry that is the same in both is the same in every member.
- An entry that differs is learned as a **recipe**: what kind of thing
  it is (a class struct, a class or interface vtable struct, an
  interface struct, an array or signature or anonymous struct over
  other types, a method by class key and name, a vtable or singleton
  or class-interface global, a field by owner and name), and the
  specialization keys that name it, generalized into **key patterns**.

Specialization keys join their type arguments' keys with `_`
(`GrowableArray_s3141_Diagnostic_s9392`), so a key derived from a type
argument contains that argument's key. A pattern is the first
representative's key with a hole wherever the argument's key appears,
checked by filling the holes with the second representative's keys and
getting its key back. A key the body names literally that happens to
contain the first representative's argument is told apart by the
second, whose argument differs there. Arguments the two representatives
share never become holes, and a later member must share them too.

Both representatives must resolve every recipe back to their own entry
before the template is kept.

### Recorded decisions

Template mode records the decisions lowering makes from the class a type
argument is, or from a specialization's place in the module, with the
answer each got:

| decision                                      | where                                          |
| --------------------------------------------- | ---------------------------------------------- |
| does a subclass override this accessor        | `LoweringContext.accessorOverriddenBySubclass` |
| does a subclass provide this method           | `LoweringContext.memberProvidedBySubclass`     |
| does the vtable have this slot                | `LoweringContext.vtableSlotIndex`              |
| which class in the chain provides this method | `LoweringContext.resolveDevirtualizedMethod`   |
| is `==` on this class identity                | `lowerClassEquality`                           |
| does a cast's operand already conform         | `lowerAs`                                      |

The two representatives must agree on the answers; their class keys are
generalized like the tables' keys, and a conformance decision's two
value types are learned like table entries. A later member re-runs each
decision for itself and is lowered directly when an answer differs. So
`hash(k)` in a `HashMap<K, V>` method copies only into members whose key
class finds `hashCode` where the representatives' did, and `==` on a key
copies only into members whose key class compares by identity. A
representative whose class has its own `==` abandons the template, as
does a `hash` that has to dispatch through the vtable.

### The gate

Template mode abandons a family where lowering dispatches on a type
argument's class in ways the recorded decisions do not cover: a type
test involving a type parameter, a cast to anything but a class, a
`match` on one, a template literal interpolating one, and a call to an
intrinsic other than `eq` and `hash` whose types mention one. The family
is then lowered directly (`families without a template` in the stats).
Calls to other generic functions need no gate: a callee that differs
between the representatives is not a class method, cannot be learned,
and stops the family.

### Specialization

For a later member of a family with a template:

1. Re-run the queries; a different answer declines.
2. Resolve the recipes with the member's argument keys, looking entities
   up in RTA's tables (`classInfos`, `classMethodMap`,
   `classInterfaceVTables`, and `WasmModule.findArray`, `findSignature`
   and `findStruct`, which never create a type after layout); a missing
   one declines.
3. Copy the instruction arrays, blocks and side tables, replay the type
   log through value interning, and install the resolved refs.
4. Run the same per-function cleanup as on a lowered body.

A declined member is lowered directly.

### Exactness

A specialized body equals the body direct lowering produces for the
same function, array for array and entry for entry, so the emitted
module is byte-identical with templates on or off (`ZENA_TEMPLATES=0`
turns them off).

The type table needs care. The builder interns `ValType`s by value, so
when `T` is `String` and the body also names `String`, both land at one
index; for `T = Node` they are two. Replaying the type log interns each
resolved entry in call order, as the builder does while lowering, and
rewrites every type operand (`typeId`, `ref_test`/`ref_cast` targets,
`br_on_cast` targets) to the resulting index. `refTable` is not interned,
so its indices are the same in every member.

### What checks it

- **Both representatives** must lower to the same arrays and decision
  answers, and resolve every recipe to their own entries.
- **Check mode** (`ZENA_TEMPLATE_CHECK=1`) lowers every specialized
  member directly too and fails the compile on any difference.
  `build:self-hosted`, which the fixpoint gate builds, sets it, and so
  does the portable execution runner, so the compiler's own 9,000
  specialized bodies and every execution test check each change.

What these cannot catch is a decision outside the gate and the recorded
decisions that depends on a type argument, gets the same answer for both
representatives, and a different one for a later member that nothing in
the test corpus specializes. The pins keep the representation fixed
within a family, which is where the measured divergences came from.

### Toward templates without a representative

Caching templates per file and discovering from IR need a template that
exists before any instantiation is known. The recipes are already
symbolic: key patterns over the type arguments. Two things still need
representatives:

- **Learning which entries vary.** Lowering with symbolic type
  arguments would record each entry's derivation as it makes it.
- **Decisions.** The recorded decisions and the gated constructs become
  IR operations that specialization resolves: a member read that is a
  field read or a virtual getter call, equality, hashing and casts on a
  type parameter. This is ir.md §8's `generic.op`; each one is also a
  gate removed.

The addendum below revises the discovery half: discovery runs before
layout, so it cannot read a ZIR template, and gets a summary of its own
walk instead.

### Interprocedural type propagation (#421)

Independent of this design. Propagation runs per instantiation either
way, and its precision comes from monomorphization, which templates
keep. A flow graph or escape summary per template would only cover
bodies before simplify and inlining make them diverge, and saves a
linear graph-building step. Sharing one emitted body across reference
instantiations (#428) would merge their class sets and make #421 more
valuable.

## Results

Compiler self-compile at `-O1`, three runs each, idle machine:

| templates | lowering and per-function cleanup | whole compile | module                          |
| --------- | --------------------------------- | ------------- | ------------------------------- |
| off       | 2.68 s                            | 14.71 s       |                                 |
| on        | 2.30 s                            | 14.33 s       | byte-identical, `-O1` and `-O2` |

123 templates; 9,224 bodies specialized from them, in 79 ms; 34 members
declined by a recorded decision. Of the self-compile's repeats, 10,903
belong to candidate families. The rest are not candidates: methods of
extension classes such as `FixedArray<T>` (2,516), constructors
(2,769), closures (1,219) and other functions (965).

With extension classes' methods and constructors as candidates, on a
later revision: 158 templates, 13,452 bodies specialized from them, 39
members declined by a recorded decision, and the module still
byte-identical at `-O1` and `-O2`. Lowering and per-function cleanup
took 2,457 ms with templates and 2,631 ms without (medians of seven
alternating runs, on a machine other work was loading, so the 174 ms
difference is approximate). The repeats left are mixin methods (765),
closures (1,257), other functions (997), roles lowering synthesizes
(1,146), and functions with no class (302).

What stops the remaining families: a representative whose key class
declares `==` (7, among them `GrowableArray<Diagnostic>.contains`, 178
members), `match` on a type parameter (6, the map iterators),
representatives that disagree (5, `HashMap<i32, Node>`, where only some
specializations have an `OrderedHashMap` subclass), and keys the learner
cannot generalize (5).

## Addendum: the rest of #410

Written after step 3 above. What the plan below still lists:
deferring decisions to specialization, classes with their own `==`,
the remaining candidates, templates without representatives, and
discovery from templates. This section takes them in the order their
value and their dependencies suggest, and changes the design of the
last one.

### Discovery's place in the compile

A compile runs discovery, then layout, then lowering. Lowering, and so
a ZIR template, reads what layout decides: struct field lists, vtable
slots, signatures. Even a template without representatives names
concrete types besides its type parameters, the standard library
classes it calls and the signatures it uses, and those are laid out
only after discovery. So no ZIR template can exist while discovery
runs, and "discovery from templates" needs a template of the discovery
walk itself rather than of lowering.

### Repeated discovery walks

RTA walks a node once per **referrer**: the node under one
specialization's substitution. A body with a dependency record gets
`registerLiterals` and `registerInstantiations`; one without gets
`discoverNodeTypes`. Measured on the self-compile at `-O1`, with
temporary timers around each walk and around each `resolveType` call
inside a repeat walk (two runs on an idle machine, revision 95086941):

| walk                                                | walks  | time   |
| --------------------------------------------------- | ------ | ------ |
| a node's first walk                                 | 6,456  | 1.6 s  |
| a node walked again under another specialization    | 28,132 | 1.9 s  |
| of the repeat walks: `resolveType`                  |        | ~0.2 s |
| discovery in all, with registration and the linkers |        | 6.5 s  |

A repeat walk calls `resolveType` 12 times on average, 344,524 times in
all, but only 68,064 of those calls are on a type the same walk had
not already resolved. The rest of a repeat walk's 1.9 s is the
traversal, the side-table lookups of each node's type, the tests of
each node's kind, and the calls into the analysis; the measurement does
not separate them.

### Discovery summaries

Both walks visit every node under their root, in an order that does
not depend on the substitution: `walkEnter` with a callback that never
prunes. What depends on the substitution is what each node's handler
does with the types it resolves: whether a receiver is an interface,
which class a `new` instantiates, which equality an `==` needs. So
each handler splits in two:

- **Extraction**, which does not resolve anything: which node, which
  kind of handler, and the unresolved types it would resolve (the
  node's type from the checker, a type annotation, explicit type
  arguments). A **summary** is the ordered list of these entries for
  one root.
- **Replay**, which resolves the entry's types under one referrer's
  substitution and makes the handler's calls into the analysis:
  `discoverType`, `instantiateClassType`, `noteInterfaceDispatch`,
  `noteTypeTestSites`, `registerTemplateLiteral` and the rest.

A root is extracted on its first walk and its summary kept. Every
referrer then replays it, the first one included, so there is one
path. Replay memoizes `resolveType` per referrer, which takes the
344,524 resolutions to 68,064, and calls the analysis in the walk's
order. A call a replay makes again for a type it already registered is
dropped only where the analysis treats it as a no-op; any other call is
replayed per entry, so the analysis sees the same calls in the same
order and the module stays byte-identical.

What checks it:

- **Byte identity.** The module with summaries on equals the module
  with them off, over the test corpus and the self-compile, as for
  templates.
- **A check mode** (`ZENA_DISCOVERY_CHECK=1`) walks and replays each
  referrer against a pass that records its calls, and fails on any
  difference. `build:self-hosted` and the execution runner would set
  it, as they set the template check.

What it costs is memory: a summary entry per node a handler acts on,
for every root walked. The entries hold references to nodes and types
the checker already keeps, so the cost is the list itself.

What it leaves: the traversal of the checker's dependency records (0.35
s in the earlier measurement), which is symbol-level and already
substitution-free, and the first walks, which extraction makes slightly
slower.

The saving is bounded by the 1.9 s of repeat walks, about 12% of the
self-compile, less what replay keeps: the calls into the analysis and
the 68,064 resolutions. The first step separates those from the
traversal, so the bound is known before the analysis depends on
summaries.

A summary depends only on a file's AST and its checker results, not on
which specializations the program has, so a per-file cache could hold
summaries as it would hold templates (ir.md §13).

### Templates without representatives

With constructors and extension classes in, templates make 13,452
bodies, and the repeats lowered directly because they are not
candidates take about 75 ms of the self-compile (Results). A template
without representatives no longer has a compile-time case.
What it would still buy is per-file caching of lowered code. That
needs a cache design first: what an artifact holds, what keys it, and
what invalidates it. Until that exists, lowering with symbolic type
arguments would trade a working design, two representatives and a
check mode that compares every made body against direct lowering, for
one with no user.

If per-file caching comes, a template without representatives needs:

- **A symbolic type table.** Lowering with a type parameter's pin
  rather than a type argument, recording each entry's derivation (the
  key patterns the learner now infers) as it makes the entry.
- **Generic operations** for the six recorded decisions and the gated
  constructs: a member read that is a field read or a virtual getter, a
  call that is direct or through the vtable, equality, hashing, casts
  and type tests on a type parameter. This is ir.md §8's `generic.op`.
  Specialization resolves each one against the member's class.
- **The generic class's own layout.** A template reads its class's
  struct and vtable, which layout builds per specialization. The
  struct's fields come in the same order in every member of a family,
  so the template can name the member's struct by recipe, as the
  learner does now. The vtable's slots can differ, since discovery
  prunes the slots nothing dispatches through per specialization; that
  is already a recorded decision (does the vtable have this slot) and
  would become a generic operation like the rest.

### Smaller items

- **Classes with their own `==`** (7 families; `GrowableArray<Diagnostic>.contains`
  alone has 178 members). Equality on a type parameter whose class
  declares `==` calls that method. A recorded decision naming the class
  that provides `==`, like the method-owner decision, would let these
  families have templates.
- **`match` on a type parameter** (6 families, the map iterators): a
  recorded decision per case pattern, answered from the member's class.
- **The remaining candidates**: mixin methods (765 repeats), closures
  (1,257), other functions (997) and synthesized roles (1,146), each
  tens of milliseconds. Worth taking only where one family turns out
  large.

## Plan

1. Methods of generic classes, learned from two representatives, with
   the gate and the three per-specialization queries. Done.
2. Equality, hashing, casts to a class and method lookup on a type
   parameter's class, as recorded decisions. Done. Deferring them to
   specialization instead, and covering classes with their own `==`,
   remain.
3. More candidates. Extension classes' methods and constructors, with
   their phases: done. Closures, mixin methods, and generic functions
   and methods remain.
4. Discovery summaries (Addendum): extraction and replay of RTA's
   walks, behind a check mode, measured against the 1.9 s of repeat
   walks before anything depends on them.
5. Equality on classes with their own `==`, and `match` on a type
   parameter, as recorded decisions.
6. Templates without representatives, once per-file caching has a
   design that needs them.
