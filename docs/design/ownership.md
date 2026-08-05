# Ownership & Resource Management

## Status

- **Status**: Proposed — unified plan. Sequencing **decided (2026-08-04):
  ownership first**, rather than shipping `using` as an interim mechanism.
  Revised after review; remaining open questions marked **DECIDE**.
- **Reconciliation owed**: [concurrency.md](./concurrency.md) predates this
  document and uses an overlapping but different ownership vocabulary. See
  layer 4.
- **Date**: 2026-08-04

## Why one document

Four separate designs have independently arrived at the same problem — a value
that owns something the garbage collector cannot reclaim:

| Design | The resource | Release mechanism |
| --- | --- | --- |
| [component-model.md](./component-model.md) | WIT `own<T>` handles | host `resource.drop` |
| [linear-memory.md](./linear-memory.md) | `Allocator.alloc` pointers | `Allocator.free` |
| [filesystem.md](./filesystem.md) | WASI descriptors | descriptor drop |
| FFI (Rust in the same binary) | foreign allocations | the peer's deallocator |

Two of them already propose `using` with an identical `try`/`finally`
desugaring, and [concurrency.md](./concurrency.md) separately designs
`isolated<T>`/`frozen<T>`/`borrow` with move semantics and "compiler verifies
borrow exclusivity" — which is the same ownership machinery approached from the
parallelism side.

Solving this once, generally, is strictly better than four times. This document
is that plan.

## Design goals

1. **Align with WIT's vocabulary now** (`own`/`borrow`), so that when the
   Component Model gains GC lowering, the *surface* is unchanged and only the
   lowering moves.
2. **No lifetime variables.** Zena is a TypeScript-shaped language; `'a` is not
   on the table.
3. **One mechanism, many resource kinds.** WIT handles, linear-memory
   allocations, FFI pointers, and descriptors should share a release protocol.
4. **Incremental.** Each layer is useful on its own and shippable alone.

---

## The layering

| Layer | What it adds | Needs dataflow? | Blocked on |
| --- | --- | --- | --- |
| **0. Drop protocol** | `Disposable`, drop glue | no | nothing |
| **1. `using`** | deterministic release for **non-affine** `Disposable` | no | layer 0 |
| **2. Affine tracking** | `Own<T>`/`Borrow<T>`, move checking | **yes** | checker CFG |
| **3. Implicit drop** | scope-exit release for **affine** `Own<T>` | yes | layer 2 |
| **4. Parallelism** | `isolated<T>`, `frozen<T>`, regions | yes | layer 2 |

The important structural claim: **layers 0 and 1 deliver the safety property
that actually matters (release) and need no new analysis.** Layers 2–4 upgrade
*detection* from runtime to compile time and are where the cost is.

---

## Layer 0: the drop protocol

One interface, many implementations. `dispose` should be **symbol-keyed**,
following the existing `Iterable` precedent in the language reference:

```zena
interface Disposable {
  static symbol dispose;
}

class Descriptor implements Disposable {
  :Disposable.dispose(): void { __wasi_descriptor_drop(this.#handle); }
}
```

`dispose` is a common enough method name that a class may plausibly already have
one meaning something unrelated, and this is a protocol the language itself
invokes implicitly — a silent collision would be released memory at the wrong
time. Symbol keying costs nothing here and is exactly what symbols exist for
("two interfaces can define methods with the same *name* but different
*symbols*"). It is also the same reasoning behind TypeScript's `Symbol.dispose`.

- A WIT resource wrapper's `dispose()` calls the imported drop function.
- A linear-memory allocation's `dispose()` calls `Allocator.free`.
- An FFI handle's `dispose()` calls the peer's deallocator.

This is the piece that makes Rust-in-the-same-binary work. A pointer owned by
Rust's allocator must be released by *Rust's* deallocator, not by
`resource.drop`; encoding release as an interface rather than a built-in is what
lets one ownership system cover both. It is also what keeps the design portable
when WIT's own representation changes.

**Verified**: at the core-wasm level, dropping a WIT resource is an ordinary
imported function call, not an instruction:

```wat
(import "cm32p2|test:brw/i" "sock_drop" (func (;3;) (type 3)))
```

So no new codegen primitive is required — Zena's existing `@external` path
already covers it.

## Layer 1: `using`

An early step, and permanent: this is how **non-affine** `Disposable` values are
released (affine ones get implicit drop in layer 3). Deterministic, familiar,
and desugars to `try`/`finally`, which both compilers already implement:

```zena
using file = root.openAt(path, OpenFlags.Read).unwrap();
// ... use file ...
// dispose() runs on every exit path, including exceptions
```

Semantics: reverse declaration order at scope exit; runs on normal exit, early
return, `break`/`continue`, and exception unwind. Per implementation-plan.md's
rule 2, it lands self-hosted-only.

This alone closes the leak hazard for all four designs above, and it keeps
working for resources that should not be affine at all.

### `using` in pattern conditions

Zena already has refutable pattern conditions (`LetPatternCondition` — `if (let
… )` / `while (let … )`), and `using` composes with them as a **binding
modifier** rather than a separate construct:

```zena
if (using let Ok(file) = openAt(path, OpenFlags.Read)) {
  file.readString();
}   // disposed here, on every exit path
```

Two semantics to pin down:

- Disposal is scoped to the **branch**, not the enclosing function.
- If the pattern does not match, nothing was bound and nothing is disposed.

Worth noting how little this is needed in the affine case: an affine `Own<T>`
bound by `if (let …)` is already released by implicit drop at branch exit, with
no `using` at all. So this form matters specifically for **non-affine**
disposables — the same split as everywhere else in this document.

---

## Layer 2: affine tracking

### Two universes

- **Unrestricted**: primitives, `String`, ordinary GC classes. Copied and
  aliased freely.
- **Affine**: `Own<T>` and types containing it. Cannot be silently duplicated;
  must be moved, borrowed, or consumed.

### Second-class borrows

Borrows are **stack-bound** and may not escape:

1. Legal only as parameter types and local bindings.
2. A function may not return a borrow.
3. A borrow may not be stored in an object, array, field, or closure capture.
4. Borrowing at a call site is implicit — `read(file)`, not `read(&file)`.

This is the key move that removes the need for lifetime variables, and it is
principled rather than a shortcut — see Osvald et al., *"Gentrification Gone Too
Far? Affordable 2nd-Class Values for Fun and (Co-)Effect"* (OOPSLA 2016).

**A related WIT rule, stated precisely.** WIT forbids returning a borrow —
verified against `wasm-tools` 1.252.0:

```
error: function `give-back` returns a type which contains a `borrow<T>`
       which is not supported
```

That constrains the **component ABI boundary**: functions a world imports or
exports. It does *not* constrain ordinary Zena functions that never cross that
boundary, and an earlier draft of this document wrongly presented it as
validating rule 2 in general. It validates rule 2 only where Zena meets WIT.

### Returning derived borrows

Rule 2 as stated above — a function may never return a borrow — is too strong
for internal code, and would make the system unpleasant to use. The cases it
wrongly rejects are the common ones:

```zena
let first = (xs: Borrow<Array<Own<File>>>): Borrow<File> => xs[0];
let name  = (f: Borrow<File>): Borrow<String> => f.name;   // field projection
```

Field projection especially is not optional: if `f.name` on a borrowed `f`
cannot itself be a borrow, borrows are unusable.

The fix is **elision**, not lifetime variables. Rust's lifetime elision rules
cover the overwhelming majority of signatures without the programmer writing
`'a`, and the useful part transfers directly:

- If a function has exactly **one** borrow parameter, a returned borrow is taken
  to derive from it. The caller treats the result as borrowing the argument it
  passed, so the borrow's extent is the caller's existing borrow scope.
- With **zero** borrow parameters, returning a borrow stays illegal — there is
  nothing for it to derive from.
- With **two or more**, the derivation is ambiguous. Either reject (and require
  the caller to restructure) or name the source parameter at the signature —
  positional rather than a lifetime variable, e.g. `-> Borrow<T> from xs`.

Projections through fields and indices follow the same rule: a borrow of a place
reachable from a borrowed value derives from that value.

**Honest accounting:** this does reintroduce a weak form of lifetime reasoning.
The second-class rule's simplicity came precisely from "a borrow never outlives
the frame that made it"; elision relaxes that to "a borrow may travel out one
frame, to the caller that supplied its source". That is dramatically less than
full lifetimes — no lifetime variables, no variance, no `outlives` constraints,
no annotations in the common case — but it is not *nothing*, and the
multi-borrow case needs a decision. **DECIDE.**

Rule 2 therefore becomes: *a function may return a borrow only when it derives
from exactly one of its borrow parameters.* Rules 1, 3 and 4 are unchanged, and
the WIT boundary keeps the stricter no-borrow-returns form, which it must.

### State per local

`Unborrowed → SharedBorrow | ExclusiveBorrowed | Moved`, with use-after-`Moved`
a compile error, and borrow states scoped to the call expression.

### What this needs that does not exist

Move state is a lattice that must **merge at join points** and reach a
**fixpoint over loops** — a move inside a loop body is a use-after-move on the
second iteration, which no single AST walk can see. Today the checker has only
a lexically-scoped narrowing stack and ad-hoc `definitely exits` /
`definitely assigns` recursion. ZIR has a real CFG (`ir/cfg.zena`: predecessors,
RPO, Cooper–Harvey–Kennedy dominators) but carries **no source spans**, so it
cannot report "used after move" at a line without spans being threaded through
first.

**Building that dataflow framework is the true cost of layer 2**, and it is
reusable well beyond ownership.

### A flow graph, not a new IR

The analysis layer 2 needs is flow-sensitive with merges and a loop fixpoint.
That is a real requirement. It does **not** follow that the checker needs an IR.

Most of what a "lower to an IR, then check the IR" design would buy already
exists in this compiler:

| Wanted | Status |
| --- | --- |
| Scope resolution as its own pass | **Exists** — `scope/scope-builder.zena` → `ScopeResult`, already incrementally cached |
| Check results as a separate, serializable artifact | **Exists** — `SemanticModel` side tables keyed by node ID, chosen in self-hosted-compiler.md §1 explicitly "for parallelism, incrementality, and architectural cleanliness" |
| A type-directed IR after checking | **Exists** — ZIR, CFG + SSA, built from checked AST + `SemanticModel` |

So the genuinely new proposal would be inserting an **HIR between the AST and
the checker**. Before doing that, note that the flow analysis can be had far
more cheaply.

**TypeScript — the language Zena is shaped like — does full flow-sensitive
narrowing with joins and loops without any IR.** Its binder attaches *flow
nodes* to AST nodes (labels with antecedents for joins, condition and assignment
nodes, loop labels), and narrowing walks that graph backwards from a reference
with caching. That is exactly the merge-and-fixpoint structure move checking
needs, and it preserves source fidelity for diagnostics and the language
service.

For Zena this also fits the existing architecture with no new concepts: a flow
graph keyed by node ID is one more side table, exactly like `SemanticModel`.

**The flow graph pays for itself before ownership does.** Narrowing is currently
stored in a lexically-scoped stack that nothing invalidates on assignment, which
is unsound today:

```zena
class Box { var v: i32 = 42; }
let f = (b: Box | null): i32 => {
  var x = b;
  if (x !== null) {
    x = null;
    return x.v;   // accepted by the checker; traps at runtime
  }
  return 0;
};
```

`zena check` reports nothing; running it fails with `dereferencing a null
pointer`. (Filed in BUGS.md.) An assignment-aware flow graph makes this class of
bug structurally impossible rather than patched case by case.

One pass would serve several consumers:

- move / affine checking (layer 2)
- definite assignment
- unreachable-code detection
- `using` scope analysis (layer 1's desugaring wants to know the exit paths)
- generalizing the narrowing special cases already hand-rolled in
  `statements.ts` — "narrowing past definite exits", immutable-path checks —
  into one mechanism

**Why an HIR would mean three IRs.** Type-directed lowering cannot run before
checking, and Zena leans on types heavily at lowering time: monomorphization,
vtable construction, record shapes, devirtualization. A pre-check IR therefore
cannot do that work, and ZIR is still needed afterwards. That is precisely why
Rust has HIR → THIR → MIR. It is a coherent design; it is also a third IR for a
compiler that has just finished landing its second.

The costs that bite hardest here:

- **The language service is a first-class deliverable** — self-hosted-compiler.md
  §8 ships LSP *before* codegen. Checking a desugared HIR means maintaining a
  bidirectional mapping back to source, forever, for hover, completion, and
  go-to-definition. This is the stated reason TypeScript refuses an IR.
- **Diagnostics.** Errors must name what the user wrote, not what it desugared
  to. Rust carries `DesugaringKind` on HIR spans for exactly this.
- **Parallelism is the weakest argument.** Checking is inherently cross-module —
  it needs imported signatures — so the parallelizable part is parsing and
  lowering, which is already the cheap half. Self-compile is ~6.5s, and Zena has
  no threads today; concurrency.md's parallelism is a future worker-plus-
  serialization polyfill.

### Narrowing mutable fields: necessary but not sufficient

Narrowing a mutable class field is refused outright today —
`isExpressionPathImmutable` (checker/statements.ts) requires every field in the
path to be declared immutable, so `var #x: Foo | null` can never narrow. That is
a deliberate soundness choice, not an oversight, and it is the right one given
that nothing currently invalidates a narrowing.

A flow graph is **necessary** to lift it, because lifting it means knowing where
the path is assigned. It is **not sufficient**, because the hard part is not
assignment but *reachable* assignment: any call between the guard and the use
might reassign the field, and any alias of the object might too. This is an
escape/effect question, not a control-flow one.

Three positions, in increasing cost:

1. **Status quo** — immutable paths only. Sound, restrictive, and the current
   source of pain.
2. **TypeScript's rule** — narrow mutable fields, invalidate on assignments
   visible in the flow graph, and accept that an intervening call or alias can
   silently invalidate. Ergonomic and *deliberately unsound*. Zena advertises
   sound typing and prefers loud failures, so adopting TS's unsoundness here
   would be a real character change.
3. **Sound, and more achievable here than in TypeScript** — narrow a mutable
   field over a region containing no assignment to that path and no call that
   could reach one. TypeScript cannot compute that because any module may be
   patched at runtime; Zena has whole-program information (monomorphization,
   RTA, DCE) and `#private` fields whose assignments are confined to one class
   body. For a private field, "can this call reassign `#x`?" is answerable.

Option 3 is the interesting one and is genuinely enabled by the combination of
the flow graph and the reachability data the compiler already computes for DCE.
Scoping it to `#private` fields first would cover most real cases at a fraction
of the analysis cost. **DECIDE.**

**Recommendation.** Build the flow graph as a side table; do not insert an HIR
now. If an HIR later proves necessary, the more natural move is to push ZIR
*earlier* — making the checked representation and the optimizer's
representation the same thing — rather than adding a third IR in front of a
pipeline that is mid-rearchitecture, with bootstrap retirement and Track G both
in flight. **DECIDE**, but not on this feature's schedule.

### Containers

**Revised.** An earlier draft recommended an ordinary GC `Array<Own<T>>` over an
affine wrapper `Resource<Array<T>>`, on two objections. One of them does not
survive, and the other turns out to argue the other way.

The objection was that wrapping cannot retract aliases established before the
wrap — `Resource<>` claims exclusivity it cannot prove. That is answered by
**requiring the wrap to be exclusive at construction**:

```zena
let a: Resource<Array<Foo>> = new Array<Foo>();   // OK — provably unaliased
let b: Resource<Array<Foo>> = existingArray;      // rejected — not provably exclusive
```

Legal sources are a fresh allocation, or an `Own<T>` moved in. Both are already
things the affine layer can prove, so this needs no new analysis — and with the
restriction, there are no prior aliases to retract.

The second objection was that requiring every element to be unpacked and
consumed before the container is released is linear rather than affine, and
painful. That is a real cost of a *hand-written* `disposeAll()` — which is also
burdensome to specify per collection, since every container would need its own
resource-aware variant. But it is not how this has to work: **disposal should be
derived, not written.** Dropping a `Resource<Array<Own<File>>>` drops the array,
which drops each element. The compiler generates that glue.

Monomorphization makes this cheap and precise: `Array<Own<File>>` is already a
distinct specialization, so drop glue is generated for exactly the instantiations
that contain affine elements, and containers of non-affine values are entirely
unaffected. No `disposeAll()` on `Array`, no resource-aware variant of every
collection.

So the model is:

- `Resource<C>` wraps a container `C`, and may only wrap a provably exclusive
  reference.
- The wrapper is affine: assigning it moves, and dropping it releases the
  contents transitively via generated glue.
- Indexing a borrowed `Resource<Array<T>>` yields `Borrow<T>`; moving an element
  out needs an explicit `take`/`swap`/`pop`, since the container must not be left
  with a hole it would later try to drop.

**Open**: `Resource<C>` and `Own<T>` are now doing similar work — `Own<T>` is
arguably `Resource<T>` for a single value. Whether they are one type spelled two
ways, or two distinct concepts, should be settled when the vocabulary is
reconciled with concurrency.md (see layer 4). **DECIDE.**

## Layer 3: implicit drop

Inserting `dispose()` automatically when an owned value leaves scope unmoved is
what turns affine (*at most* once) into leak-free. It is also the expensive
half, and it needs four things that are easy to leave out of a sketch:

1. **Unwind paths.** Every scope holding a live resource needs cleanup on
   exception propagation. `finally` makes this expressible; it is still real
   codegen, and it has code-size cost in a project that tracks code size.
2. **Drop flags.** A value moved in one branch of an `if` and not the other
   cannot be resolved statically. Rust carries **runtime drop flags** for
   precisely this case. So the claim that a compile-time system yields *zero*
   runtime overhead is **false** in general: either conditional moves are
   forbidden (too restrictive) or a flag is carried. This is consistent with the
   `owned | moved | dropped` flag already proposed for WIT wrappers.
3. **Child-before-parent ordering.** WIT requires that a `request-options`
   obtained from a `request` be dropped *before* its parent. Reverse-declaration
   order does not automatically satisfy parent/child relationships that were
   established by a call, so the wrapper must record its parent.
4. **Async cancellation.** A resource live across a suspension point is stored
   in the state-machine struct built by Track G's split pass. If the task is
   cancelled and never resumed, something must still drop it. This is the one
   place ownership genuinely does interact with Track G — and it is a real
   problem with or without affine types.

**DECIDE**: implicit drop (Rust-style) versus explicit `using` (C#/TypeScript
style) as the *default*. They can coexist — `using` for the explicit case,
implicit drop as a backstop — but the default determines whether forgetting is
a leak or is silently handled, and that is a language-character decision.

---

## Layer 4: parallelism

[concurrency.md](./concurrency.md)'s `isolated<T>` (unique, transferable, with
`spawn move(node)` and an explicit "Error: node has been moved"), `frozen<T>`,
and scoped `borrow` with verified exclusivity are the same machinery as layers
2–3, specialised to threads: an exclusive borrow for parallel access and this
document's `BorrowMut<T>` are the same feature under two names.

**concurrency.md needs reconciling with this document.** It was written from the
parallelism side and introduces its own vocabulary — `isolated<T>`, `frozen<T>`,
`borrow`/`share`, regions — which overlaps this document's `Own<T>`/`Borrow<T>`
without matching it. Left alone, Zena ends up with two ownership systems and two
borrow checkers. The reconciliation should be one type vocabulary with
parallelism as a *use* of it:

| concurrency.md | This document | Note |
| --- | --- | --- |
| `isolated<T>` | `Own<T>` | Unique, transferable, move-on-transfer — the same type. `isolated` reads as a thread-specific name for a general property. |
| `borrow child` (scoped, exclusive) | `BorrowMut<T>` | Same exclusive borrow; concurrency.md scopes it to a `parallel.scope` block, which is a second-class borrow with a wider stack frame. |
| `share treeRef` (scoped, read-only) | `Borrow<T>` | Shared immutable borrow. |
| `frozen<T>` | *no equivalent yet* | Deep immutability is genuinely additional — it is about transitive reachability, not uniqueness, and it is what makes a value safely *shareable* rather than merely borrowable. Keep it, defined against this vocabulary. |
| regions | region-as-affine-handle | See "Linear memory and FFI" — the same idea, and the same recommended unit. |

Nothing here should be built until layer 2 exists, but the *naming* should be
settled before either document is implemented, so the two do not diverge
further. **DECIDE.**

---

## Linear memory and FFI

Two adjustments specific to non-WIT resources:

- **Pointers need a nominal type before they can be affine.** `Allocator.alloc`
  returns a bare `i32`; a primitive has no identity and nowhere to carry state.
  `distinct type Ptr<T> = i32` — using the `distinct` keyword that already
  exists in both lexers — is a prerequisite, and is worth adding on its own
  merits because `(ptr: i32, len: i32)` signatures in `fs.zena` and `cli.zena`
  can currently be transposed silently.
- **How opaque can an address be?** Enough to avoid a general `unsafe`, most
  likely. It is worth separating two populations of linear-memory code:

  | Code | Needs | Can it use an opaque `Ptr<T>`? |
  | --- | --- | --- |
  | Canonical ABI marshaling | load/store at *statically known* offsets; element `i` of a known stride | **Yes.** These are typed accessors — `p.loadU32(offset)`, `p.elem(i)` — not arithmetic. |
  | Foreign struct walking (FFI) | offsets from a foreign layout | **Yes**, given a declared layout to generate accessors from. |
  | The allocator itself | genuine arithmetic — `FreeListAllocator` threads its free-list `next` pointers *through the freed blocks* | **No.** |

  So arbitrary pointer arithmetic is not needed to read and write WASI data; it
  is needed to *implement the allocator*. That is a much smaller and more
  defensible surface than a general escape hatch: a single privileged module
  with raw access, rather than an `unsafe` keyword available everywhere.

  Residual unsoundness is then confined to that module plus any hand-declared
  foreign layout being wrong — which is an FFI declaration bug, the same class
  as a wrong `@external` signature today. **DECIDE**: privileged-module raw
  access, or a general `unsafe`?

The unit of ownership for linear memory should be the **region, not the
pointer** — an affine arena handle, `using`-scoped, released as a unit. That is
what `BumpAllocator.reset()` and concurrency.md's regions already describe, and
it covers the dominant case (the canonical ABI's transient
allocate/copy/call/free) without per-pointer dataflow.

---

## Where this sits in the plan of record

[implementation-plan.md](./implementation-plan.md) runs Track G (generators then
async, the priority track), V (equality contractions), A (rows), and B (the
post-flip harvest); its Legend section defines those labels and the ZIR M-track.
This work would be a new **Track O** — a label proposed here, not yet adopted
into the plan of record. It competes with none of the existing tracks for
infrastructure: G and B are ZIR/M-track work, V and A are the
records/equality arc, while O is checker-side plus a small amount of surface
syntax.

| | Work | Needs | Independent of |
| --- | --- | --- | --- |
| **O0** | `Disposable` + `using` (layers 0–1) | nothing | everything |
| **O1** | Checker flow graph | nothing | everything |
| **O2** | Affine `Own<T>`/`Borrow<T>` (layer 2) | O1 | G, V, A |
| **O3** | Implicit drop (layer 3) | O2, and G1 for the cancellation answer | V, A |
| **O4** | `isolated<T>`/`frozen<T>`/regions (layer 4) | O2 | V, A |

**O0 and O1 go first** — not as a substitute for the ownership system but as
its substrate (see "Sequencing" below). Both are independently justified:

- O0 is an expansion, so self-hosted-only under rule 2. It is small, and its
  scope-exit cleanup lowering is the same machinery layer 3 needs. It also
  closes filesystem.md's descriptor story and linear-memory.md's open question
  1 as a side effect.
- O1 fixes a live soundness bug (above), generalizes the narrowing special cases
  already hand-rolled in `statements.ts`, and is the prerequisite for any
  improvement to mutable-field narrowing. It would be worth building if affine
  types were never adopted.

O2–O4 are genuinely later, and the plan's principle 4 (concurrency first) still
holds: O3 depends on G1 for the "who drops a cancelled task's resources"
question, and O4 *is* concurrency.md's ownership types, which want the G-track
in place anyway.

For Track W (component-model, see component-model.md Part 8) the hard
dependency is only **O0**. Under the ownership-first decision Track W's
bindgen waits for O2 as well, so that the generated wrappers are written once
against their final API — but Part 8 stages 1, 2, 4 and 6 are independent of
all of this and proceed in parallel.

## Sequencing — decided: ownership first

**Decision (2026-08-04):** build the ownership system properly rather than
shipping `using` as an interim release mechanism. Rationale: implicit drop is
more ergonomic and safer than explicit disposal — you cannot forget it — and
getting the model right is worth more than reaching a WIT milestone sooner.

The costs enumerated under "What doing it now would actually cost" in
[component-model.md](./component-model.md) are accepted, not refuted. They are
kept on record because they name what implementation will actually run into:
principally that the checker dataflow framework must be built first, and that
the API rules will be designed with few real clients to validate against.

### What this does *not* change

Layers 0 and 1 are **substrate for layer 3, not an alternative to it**, so they
still come first — they simply stop being the deliverable:

- Layer 3 inserts calls to `dispose()`. That is layer 0; there is nothing to
  insert without it.
- Layer 3 must run cleanup on every exit path including unwind. That is exactly
  the `try`/`finally` machinery `using` desugars to. Layer 1's codegen *is*
  layer 3's codegen, reached from a different direction.

### Order

1. **O1 — the checker flow graph.** The hard prerequisite for everything below,
   and independently justified: it fixes the narrowing soundness bug filed in
   BUGS.md and generalizes the hand-rolled narrowing special cases. Commits us
   to nothing about ownership.
2. **O0 — `Disposable` and drop glue.** Needed by layer 3 regardless. Covers
   WIT handles, `Allocator.free`, descriptors, and FFI deallocators through one
   interface.
3. **`using` + the scope-exit cleanup lowering** — `try`/`finally` on all exit
   paths. Surfaced as `using` for non-affine `Disposable`, and reused unchanged
   by implicit drop in step 5.
4. **O2 — affine tracking.** `Own<T>`/`Borrow<T>`, second-class borrows, move
   checking on the O1 flow graph.
5. **O3 — implicit drop**, once its four sub-problems have answers: unwind
   paths, drop flags for conditional moves, child-before-parent ordering, and
   cancellation.
6. **O4 — `isolated<T>`/`frozen<T>`/regions**, reusing O2.

`distinct type Ptr<T>` remains worth doing early and independently; it is the
nominal hook affine tracking attaches to for linear memory.

### `using` stays — and it is what covers non-affine resources

**Decided:** keep `using` as an early step in the plan, and do **not** make
`Disposable` imply affine. The two populations are complementary:

| | Released by | Guarantee |
| --- | --- | --- |
| Affine `Own<T>` | implicit drop at scope exit | static — cannot be forgotten, cannot be used after move |
| Non-affine `Disposable` | explicit `using` | deterministic, but not statically safe |

Making everything disposable affine would have been simpler to describe and
worse to use. Plenty of things want scope-bound cleanup without the full affine
ceremony — a lock guard, a tracing span, a transaction, a subscription, an arena
reset — and those are values you may reasonably want to alias, store in a field,
or capture in a closure. Affineness would forbid all of that to buy a guarantee
those cases do not need.

Both populations share the layer 0 protocol, so this costs no extra machinery:
`using` and implicit drop are two entry points to the same `dispose()`.

**The consequence worth designing for:** a non-affine disposable can be aliased,
so `using` can release it while another reference is still live. That is
use-after-dispose, and no static analysis will catch it, because opting out of
affineness is exactly opting out of that analysis. This is the same trade C# and
TypeScript make and it is acceptable — but it is precisely where the runtime
`owned | moved | dropped` flag stays load-bearing, turning use-after-dispose
into a clear Zena error rather than a trap on a recycled handle.

So the flag is not scaffolding to be removed once affine checking lands. It is
the safety story for the non-affine half, permanently.

### What Track W can do meanwhile

Most of the component-model work is not blocked by ownership at all. Of
component-model.md Part 8's stages, ownership touches only the shape of the
generated resource wrappers (stage 3) and the release mechanism (stage 5).
Stages **1 (parser fixes + `parseWit`), 2 (`Result`), 4 (canonical ABI), and 6
(component emission)** are independent and can proceed in parallel.

There is also a real advantage to this ordering that the earlier analysis
undersold: writing bindgen *after* the ownership model exists means the
generated wrappers are written once against their final API, instead of being
written against a runtime-flag model and regenerated later.

## Open questions

1. ~~Implicit drop vs. explicit `using`; whether `Disposable` implies affine~~
   — **decided**: both. Implicit drop for affine `Own<T>`; `using` retained for
   non-affine `Disposable`, which keeps it usable for lock guards, spans and
   arenas. `Disposable` does *not* imply affine.
2. ~~Container model~~ — **revised** to `Resource<C>` with an exclusive-wrap
   requirement and derived transitive drop. Follow-on: are `Resource<C>` and
   `Own<T>` one type or two?
3. Raw linear-memory access: confined to a privileged allocator module, or a
   general `unsafe`? (Recommended: privileged module — ABI marshaling needs
   typed accessors, not arithmetic.)
4. Child-before-parent drop ordering: recorded on the wrapper, or inferred?
5. Who drops resources held in a cancelled task's state machine?
6. Flow graph as an AST side table vs. a pre-check HIR (layer 2). Recommended:
   side table; revisit only after bootstrap retirement and Track G.
7. Multi-borrow returns: reject, or name the source parameter (layer 2,
   "Returning derived borrows")?
8. Reconciling concurrency.md's `isolated`/`frozen`/`borrow` vocabulary with
   `Own`/`Borrow` (layer 4) — naming should be settled before either is built.
9. Mutable-field narrowing: stay sound and restrictive, adopt TypeScript's
   deliberate unsoundness, or use whole-program reachability to narrow
   `#private` fields soundly (layer 2).

## Related

- [component-model.md](./component-model.md) — WIT resources, the motivating case
- [linear-memory.md](./linear-memory.md) — allocators; "The Lifetime Problem"
- [filesystem.md](./filesystem.md) — the original `Disposable`/`using` sketch
- [concurrency.md](./concurrency.md) — `isolated<T>`/`frozen<T>`/regions (layer 4)
- [exceptions.md](./exceptions.md) — `try`/`finally`, the desugaring target
- [self-hosted-compiler.md](./self-hosted-compiler.md) — `SemanticModel` side
  tables, the deferred-IR seam (§7), LSP as an early deliverable (§8)
- [ir.md](./ir.md) — ZIR, the existing post-type CFG+SSA IR
- [narrowing-issues.md](./narrowing-issues.md) — current narrowing limitations
- [implementation-plan.md](./implementation-plan.md) — plan of record
