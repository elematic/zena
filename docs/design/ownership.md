# Ownership & Resource Management

## Status

- **Status**: Adopted as **Track O** in
  [implementation-plan.md](./implementation-plan.md). Sequencing **decided
  (2026-08-04): ownership first**, rather than shipping `using` as an interim
  mechanism. Remaining open questions marked **DECIDE**.
- **Reconciliation owed**: [concurrency.md](./concurrency.md) predates this
  document and uses an overlapping but different ownership vocabulary. See
  layer 4.
- **Date**: 2026-08-04, revised 2026-08-06.

### 2026-08-06 revision

Design review resolved six things and corrected two claims this document made.
New material: §"Three universes", §"Returning owned values", §"The branch-join
rule", §"Affine type arguments are opt-in", and §"Disowning and adopting".

Corrections, recorded because both were load-bearing in the earlier text:

- The old §"Two universes" was wrong. `Borrow<T>` is neither unrestricted nor
  affine; there are three, not two.
- An earlier draft of this revision claimed affine values in generics would
  force a broad stdlib migration, citing `Result.unwrap`/`Result.map`. **Those
  methods do not exist** — `Result<T, E>` is a type alias over an inline
  multi-value union (`result.zena`), so it has no generic body to check and
  `Result<Own<T>, E>` costs nothing. A scan of the whole generic stdlib surface
  found exactly **one** site that duplicates a `T`: `FixedArray.new(length,
  value)`, which lowers to `array.new`. The real cross-cutting issue is
  narrower and different in kind — see §"Affine type arguments are opt-in".

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

### The vocabulary, decided

Names are settled here so the rest of the document and the implementation agree.
Alternatives considered are recorded because several were close calls.

| Concept | Spelling | Rejected, and why |
| --- | --- | --- |
| A class whose instances hold a non-GC resource | `resource class Descriptor` | `affine class` — see §"Resource-ness and affineness are different properties": the modifier does not declare affineness, so naming it `affine` would be wrong, not merely less WIT-aligned. A `Resource` marker *interface* is rejected there too. |
| Affine handle: one owner, implicit drop | `Own<T>` | unchanged — WIT's `own` |
| Restricted alias: cannot outlive the owner | `Borrow<T>` | unchanged — WIT's `borrow` |
| Manually-managed handle: aliasable, never implicitly dropped | `Unmanaged<T>` | `Raw<T>` (suggests a pointer); `Unowned<T>` (Swift already uses this for a non-owning *weak* reference — the opposite hazard) |
| `Own<T>` → `Unmanaged<T>` | `disown(x)` | `release(x)` — the fatal one. In every other resource API `release` means *dispose*, so `release` would name the operation that specifically does **not** release. |
| `Unmanaged<T>` → `Own<T>` | `adopt(x)` | `repossess` (longer, odd register); `manage`; `reclaim` (suggests reclaiming memory) |
| Type parameter may accept affine arguments | `affine T` | `<T extends Movable>` — `extends` narrows everywhere else in the language and this widens; `<T extends ?Copyable>` — new sigil for one feature |
| Bound meaning "may be duplicated" | `Copyable` | `Unrestricted` (precise, but needs the substructural literature to parse); `Aliasable` (wrong for `i32`, which you copy rather than alias) |

`Own<T>`, `Borrow<T>`, `Unmanaged<T>`, `Copyable`, `Disposable`, `disown` and
`adopt` are declared in a new stdlib module `zena:ownership` and are
compiler-known, following the `Iterable`/`zena:iterator` precedent.

`resource class` is what brings a class into this regime. For a resource class
`R`, bare `R` is **not a spellable type** — every mention is `Own<R>`,
`Borrow<R>` or `Unmanaged<R>`, so which regime a signature is in is always
visible. Ordinary classes are unaffected, including ordinary classes that
implement `Disposable`: a lock guard or a tracing span stays unrestricted,
stays spellable bare, and is released by `using`. That preserves the
two-population decision in §"`using` stays" while giving the wrapper types a
clean domain.

### Resource-ness and affineness are different properties

**Decided (2026-08-06).** The class modifier and the type wrapper declare two
different things, and conflating them is what made `resource` vs `affine` look
like a choice between synonyms:

| | Declares | Spelled |
| --- | --- | --- |
| Class modifier | **Resource-ness** — this class has no unwrapped form, and carries a disposal obligation | `resource class Descriptor` |
| Type wrapper | **Affineness** — this reference is the owning one | `Own<T>` |

Two consequences follow, and both are load-bearing.

**Why the marker must be at the declaration, not the use site.** `Own<Descriptor>`
claims "this is *the* owning reference". That claim holds only if no unwrapped
`Descriptor` alias can exist. Making bare `Descriptor` unspellable is exactly
the premise that supports it — so the marker has to be a property of the class,
uniform across every mention. A use-site modifier could not do that job: one
reference could be annotated affine and another not, both naming the same
object.

**Why `affine class` would be the wrong name.** Layer 4's `isolated<T>` wants
affineness for an ordinary GC data structure with no OS handle behind it, where
`resource class Tree` reads absurd — and under this split it needs no class
modifier at all. Affineness comes from `Own<Tree>`; `Tree` stays an ordinary
class. Had the modifier been called `affine`, layer 4 would have had to either
misuse it or invent a second mechanism.

#### `Own<T>` over a non-resource class

Allowing that is what gives layer 4 its vocabulary, but it needs one extra
premise, because a GC language has ambient aliasing: `Own<Tree>` and a bare
`Tree` could otherwise name the same object and the exclusivity claim would be
a lie. §"Containers" already settled the rule for `Resource<C>`, and it
generalizes:

- **`Own<R>` for `resource class R`** — always available. There is no
  unwrapped form to alias.
- **`Own<C>` for an ordinary class `C`** — available only from a **provably
  exclusive source**: a fresh allocation, or an `Own<T>` moved in.

Same wrapper, same checking, one extra premise in the second case. O0
implements only the first; the second is O4's. The rule is recorded now so the
two do not diverge the way concurrency.md and this document did.

#### Rejected: `Resource` as a marker interface

The tempting alternative is no modifier at all — declare an interface
`Resource extends Disposable`, and let a class opt in by implementing it. It
does not work, because **affineness would enter the subtype lattice**, which is
the axis §"Three universes" exists to keep it out of:

```zena
class Descriptor implements Resource { … }   // Resource extends Disposable

let d: Own<Descriptor> = fs.open(path);
let x: Disposable = d;    // Descriptor <: Resource <: Disposable — a legal upcast
```

That upcast launders the affineness away. `Disposable` is deliberately *not*
affine (§"`using` stays"), so an affine value now sits in an unrestricted static
type, freely aliasable, with nothing tracking it. Closing the hole means banning
upcasts from a resource class to any non-affine supertype — at which point
`Resource` no longer behaves like the language's other interfaces, and the
modifier has been reinvented with extra machinery and a surprising subtyping
rule.

`Hashable` is not a counterexample. It *is* a real interface with a special
satisfaction rule in the checker (`checker.zena` matches on interface name plus
`sourcePath`), but what it does is **constrain type arguments** — `K extends
Hashable`. It does not change the structural rules governing values of the type.
An interface is the right shape for "this type supports an operation" and the
wrong shape for "this type may not be duplicated".

---

## Layer 0: the drop protocol

One interface, many implementations, in `zena:ownership`. `dispose` is
**symbol-keyed**, following the existing `Iterable` precedent in the language
reference:

```zena
import { Disposable } from 'zena:ownership';

export interface Disposable {
  static symbol dispose;
  :dispose(): void;
}

class Descriptor implements Disposable {
  :Disposable.dispose(): void { __wasi_descriptor_drop(this.#handle); }
}
```

Two obligations on implementors, both load-bearing:

- **Idempotent.** `dispose()` may be called on an already-disposed value and
  must not release twice. Before O2 nothing statically prevents a double call,
  so the wrapper's state flag is what makes the second one a no-op.
- **Must not throw.** `dispose()` runs on exception-unwind paths, where a second
  exception would displace the one being propagated.

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

### Three universes

An earlier draft said two. That was wrong, and the error mattered: it made
`Borrow<T>`'s restrictions look like consequences of affineness, which in turn
made returning an `Own<T>` look forbidden. `Borrow<T>` is neither unrestricted
nor affine. The two properties are independent:

| Universe | Members | Duplicate? | Escape the frame? | Dropped? |
| --- | --- | --- | --- | --- |
| **Unrestricted** | primitives, `String`, ordinary GC classes, `Unmanaged<R>` | yes | yes | never implicitly |
| **Affine** | `Own<R>`, and types containing one | **no** | **yes** | at scope exit, unmoved |
| **Second-class** | `Borrow<R>` | yes | **no** | never — it is not an owner |

Affineness governs *duplication*. Second-class-ness governs *escape*. Rules 1–4
below constrain `Borrow<T>` only.

### Returning owned values

**A function may return an `Own<T>`.** This needs saying explicitly, because the
second-class rules sit next to it and have been misread as covering owns.

```zena
export function open(path: String, flags: Flags): Result<Own<Descriptor>, Error>
```

A `return f` where `f: Own<T>` is a **move**: the callee's release obligation
transfers to the caller. Both sides are checkable from the signature alone —
there is no lifetime to name, nothing derived from an argument, and no
non-local analysis. This is the same reason returning `T` by value is easy in
Rust while returning `&'a T` is not.

Two consequences worth stating:

- The **loan pattern is not forced.** `fs.open()` can hand a descriptor back
  rather than requiring `withFile(path, cb)`.
- The affine property survives. A return is the value's one permitted use, and
  implicit drop keeps the discipline *affine* (at most once) rather than
  *linear* (exactly once) from the programmer's side — you never have to
  consume explicitly.

`Result<Own<T>, E>` in particular costs nothing extra: `Result` is a type alias
over an inline multi-value union, so an owned handle simply rides in lane 2 of a
multi-value return and is destructured at the call site.

```zena
if (let (true, f, _) = fs.open(path, Flags.Read)) {
  // f : Own<Descriptor> — moved out of the return, live from here
}
```

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

### The branch-join rule — decided

**Decision (2026-08-06):** at a join, the move state is the **meet**, and each
predecessor edge carries *compensating drops* to reach it. A resource live on
one incoming edge and dead on another is dropped on the edge where it is live,
so it is uniformly dead at the merge.

```
                  [ Entry: live = {f} ]
             ┌─────────────┴─────────────┐
             ▼                           ▼
      [ then: close(f) ]           [ else: no use ]
        f consumed                 f still live
             │                           │
             │                    « compiler drops f »
             └─────────────┬─────────────┘
                           ▼
                  [ Merge: live = {} ]
```

What this buys, and it is the reason to take it: **no runtime drop flags.**
Drop points are statically known, so code size is predictable — which matters
for a wasm target that tracks it. Rust carries runtime drop flags precisely
because it declines to make this trade.

Three things must be said plainly, because a sketch of this rule elides them.

**1. It is not an alternative to dataflow — it is a choice of join.** The rule
was proposed as a way to avoid building a flow graph and stay strictly O(N).
That does not follow: it needs exactly the same graph, and only removes the
*iteration*. Every structured split is a join, and that includes `&&`, `||`,
`?:`, `?.`, `match` arms and `if (let …)` — written syntactically, that is the
same join logic reimplemented eight times. Build it once on the O1 flow graph.

The performance worry behind the proposal is also misdirected. What is
expensive in Rust is NLL region inference over *lifetime variables*, which this
design does not have. Move/initialisation checking is plain forward bitset
dataflow over a reducible CFG; on a 6.5s self-compile with per-function bitsets
it will not be measurable.

**2. It rejects sound programs.** Move on one arm, fall through, keep using:

```zena
let f = fs.open(path);
if (handOff) { pool.give(f); }   // moved here
f.read();                         // ERROR: f was released at the end of `else`
```

Mitigating fact: the *common* conditional-handoff shape diverges — `if (x) {
pool.give(f); return; }` — so the moving branch never reaches the merge and `f`
stays live. What is actually rejected is the non-diverging form above, which is
usually a bug. Accepted, with a diagnostic requirement: the checker must retain
**where** the collapse happened, so the message reads "`f` was moved on the
`then` branch at line N and released at the end of the `else` branch", never
"`f` is not live".

**3. It changes release *timing*, not just checking.** In the non-consuming
branch the resource is released at that branch's `}`, earlier than scope exit.
If no later use exists, no error fires and the resource simply closed sooner
than RAII would suggest. Observable when `dispose()` has effects. This is a
semantics decision, not an implementation detail, and belongs in the language
reference.

### Where the join rule runs out

Three cases the rule does not cover on its own.

- **Loops.** A forward walk accepts `while (c) { consume(f); }` — `f` is live
  when the line is reached, and only the back edge makes it wrong. Rule: compare
  the body's out-state to its in-state and **error** if a resource declared
  outside the loop was consumed without being reinitialized on every path to the
  back edge. Sound, one pass, no fixpoint — but note this is still a dataflow
  rule, with "error" substituted for "iterate".
- **`try`/`catch`/`finally`.** The state at a `catch` entry is the meet over
  *every* program point in the `try` body, since any call may throw. There is no
  syntactic edge to hang a compensating drop on, and "was `f` initialized when we
  unwound?" is genuinely dynamic. Either a runtime flag returns here, or the try
  region is split at each acquisition. **DECIDE.** This is the one place the
  no-drop-flags claim does not hold, and it is the same problem layer 3 item 1
  names.
- **Suspension.** After the generator split, locals live across a yield become
  frame fields, and a suspended frame may be dropped without ever being resumed.
  "Which owns are live in state *k*" is a per-state table, not a lexical list —
  see §"What Track G already built".

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
  `checker.zena` — the `definitelyExits`/`branchDefinitelyExits` recursion,
  immutable-path checks — into one mechanism

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

### What Track G already built, and the seam it implies

Track G's split pass is not the checking half of this feature, and the ZIR it
produces cannot become it: ZIR runs post-check and post-RTA (so it is
per-instantiation, and does not exist at all for code RTA drops, while checking
must cover unreached code), and it carries **zero source spans** — `ir.zena` has
no span field. It cannot report "used after move" at a line.

But `codegen/ir/generators.zena` did build a real piece of layer 3. It computes
liveness across suspension points and demotes every value live across a yield to
a frame field. That is precisely the input to a **per-state drop table**: for
each suspend state, the owned frame fields live in it; the frame's `dispose()`
walks the table for its current `$state`. That is the answer to open question 5
("who drops a cancelled task's resources"), and it is mostly mechanical. Write
it while that pass is still fresh.

**The seam.** The checker decides *legality* and records drop obligations into
`SemanticModel` as a side table — node or edge → the symbols to release there.
ZIR lowering *materializes* them, because that is where unwind edges and the
generator split already live. Diagnostics stay span-faithful; drop placement
stays in the one component that already understands landing pads and
suspension. Neither side grows a second notion of control flow it has to keep
in sync with the other.

### Narrowing mutable fields: necessary but not sufficient

Narrowing a mutable class field is refused outright today — the immutable-path
check requires every field in the path to be declared immutable, so
`var #x: Foo | null` can never narrow. (This document originally cited
`isExpressionPathImmutable` in `checker/statements.ts`; that was the bootstrap
compiler, retired 2026-08-06. The rule now lives in `checker.zena`.) That is
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

### Affine type arguments are opt-in

A generic body is checked **once**, before it knows what `T` will be, so it must
be checked against the worst case its bound permits. If `T` may be affine, the
body may not duplicate a `T`:

```zena
let duplicate = <T>(x: T): (T, T) => (x, x);
```

Sound for `T = i32`; for `T = Own<Descriptor>` it creates two owners of one
handle and two drops of it. So a body that may see an affine `T` must move each
`T`-typed value **at most once per path** — borrowing stays unlimited.

**Decision (2026-08-06):** type parameters are **unrestricted by default**, and
accepting affine arguments is opt-in per parameter:

```zena
class Pool<affine T> { … }          // T may be affine
class Array<T> { … }                // unchanged: an affine argument is rejected
let discard = <affine T>(x: T) => {};   // fine for Own<R> and for i32
```

`affine T` is shorthand for *dropping* the implicit `T extends Copyable` bound.
Widening what a parameter accepts narrows what its body may do — that is the
whole trade, and it is Rust's `?Sized` shape with the default inverted.

Three things that look like they would need the opt-in and do not, because they
are the common cases:

- **Not using a `T` is fine.** `<affine T>(x: T): void => {}` needs no bound;
  implicit drop releases `x`, and monomorphization emits that glue only for
  instantiations where `T` is actually affine.
- **Using it once per *path* is fine**, across branches. `HashMap.[]=` moves
  `key` and `value` at most once on each path; on the key-already-present path
  `key` is never consumed and the compiler drops it — which is a bug fix, since
  today a duplicate affine key would leak.
- **Generic fields are fine.** `class Box<affine T> { var value: T }` — dropping
  the box drops the `T` through derived glue.

#### `Borrow<T>` is the identity at unrestricted instantiations

Borrowing an unrestricted value is a no-op, so `Borrow<i32> ≡ i32` and
`Borrow<String> ≡ String`. This is what keeps the opt-in from forking the
container API: element accessors are written in borrow form **once** and read
exactly as they do today at every existing instantiation.

```zena
operator [](key: K): Borrow<V>      // ≡ V for HashMap<String, i32>
```

The second-class restrictions on `Borrow<T>` exist to stop a borrow outliving an
owner. An unrestricted `T` has no owner to outlive, so at those instantiations
they do not apply. Inside an opted-in generic body they *do*, because the body
is checked against the worst case — which is sound, and callers see the
instantiated form.

#### What this costs in the stdlib

Measured, not estimated. Across `result`, `option`, `box`, `sequence`,
`iterator`, `iterable-utils`, `growable-array`, `fixed-array`,
`immutable-array`, `map` and `set`, exactly **one** site moves a `T` twice:

```zena
// fixed-array.zena — array.new fills N slots from one value
new(length: i32, value: T) : super(__array_new(length, value));
```

Under `FixedArray<affine T>` that constructor is unsound and must become
conditionally available, which is what **member-level `where` bounds** are for:

```zena
new(length: i32, value: T) where T extends Copyable : super(__array_new(length, value));
```

That mechanism is not new machinery for ownership — it is
[equality.md](./equality.md) D4, already planned as part of Track A's A0 bounds
work for `contains where T extends Equatable`. Track O consumes it rather than
inventing it. (`T extends X` bounds already work; the `where` half does not
exist yet — the parser has no `where` token.)

The genuinely pervasive issue is different in kind, and it is a *signature*
question rather than a body question: containers hand out elements by value
(`operator [](key): V`, `Iterator.next(): (true, T)`, `map`'s callback), and for
an affine element every one of those is a move out of a slot the container still
owns. Those become `Borrow<V>` under the identity above, and `Iterable<T>` needs
a borrowing iterator alongside the draining one so `contains`/`find`/`all` do not
consume the collection.

#### Declared, not inferred

Whole-program compilation would let the opt-in be inferred from bodies. Rejected:
errors would land inside stdlib bodies at call sites the user did not write, a
signature would stop being the contract, and adding a second move to a stdlib
method would silently break distant callers. With the language service as an
early deliverable, declared wins.

**The stdlib opts in lazily, one class at a time, when a real client needs it.**
Nothing in `fs.open()` or WIT resource bindings needs any of it.

### Disowning and adopting

The two populations in §"`using` stays" — statically-safe affine `Own<T>` and
aliasable non-affine `Disposable` — have never had a way to move *between* them.
`disown` and `adopt` are those two arrows, and the disowned state is
`Unmanaged<T>`.

```zena
let raw: Unmanaged<Descriptor> = disown(f);   // f : Own<Descriptor>, consumed
// … alias it, store it in a field, put it in an ordinary Array …
let f2: Own<Descriptor> = adopt(raw);         // back under implicit drop
```

**This is checked, not `unsafe`.** The generated wrapper already carries the
`owned | moved | dropped` state flag that component-model.md Part 6 mandates and
that §"`using` stays" keeps permanently. Add one state:

- `disown(f)` requires `owned`, sets `disowned`, returns the same object typed
  `Unmanaged<T>`.
- `adopt(r)` requires `disowned`; on `owned` (someone else adopted it first) or
  `dropped` it **throws**. It is a programming error, not an expected condition,
  so throwing is right; add `tryAdopt(): Result<Own<T>, …>` only when a real
  client wants the branch.

So two racing adopters do not double-free — the loser gets a clean Zena error.
What is given up is precisely **leak-freedom** and *compile-time* detection of
use-after-dispose, the latter degrading to a loud runtime error. Type soundness
and memory safety are untouched. No `unsafe` keyword is required, and open
question 3 stays confined to raw linear memory where it belongs.

**It is not only an escape hatch — the canonical ABI requires it.** An exported
function returning WIT `own<T>` must hand the raw handle index to the host and
stop tracking it; an imported one receives an index and must start. Those are
`disown` and `adopt` on the handle-table state, so bindgen needs both whether or
not users ever see them. Exposing them is mostly a matter of not hiding
machinery that had to exist.

**It unblocks resource-holding containers during the whole opt-in period.**
`Unmanaged<T>` is unrestricted, so `new Array<Unmanaged<Conn>>()` needs no
generic-affinity machinery at all. A connection pool can be built while
`Array`/`FixedArray` have not opted in, paying manual disposal, and migrate to
`Array<Own<Conn>>` later without the resource type changing.

`using` composes directly, since `Unmanaged<T>` is `Disposable`:

```zena
using let raw = disown(f);   // deterministic release at scope exit
```

Four things to pin down:

1. **`disown` consumes its argument** — `Own<T>` by value, not borrow.
   Otherwise an `Own` that will implicitly drop coexists with an `Unmanaged`
   alias to the same handle. Falls out of move checking.
2. **`adopt` cannot retract aliases**, and the asymmetry is worth recording:
   §"Containers" answers exactly this objection for `Resource<C>` by *requiring
   exclusivity at construction*. Here that is impossible — aliasability is the
   point of the disowned state — so the flag is the fallback. Same problem,
   different answer, deliberately.
3. **WIT child-before-parent ordering is unenforceable across a disown.** A
   disowned `request-options` can outlive its parent `request`. Documented
   hazard of the disowned regime; nothing static will catch it.
4. **No implicit coercion back.** `adopt` is always explicit and always
   fallible; a silent re-entry into the affine system with aliases outstanding
   is the one thing that would make the flag useless.

**Build cost is near zero and needs no flow analysis.** `disown` is a move
(free once O2 exists; caught by the flag before then), `adopt` is a flag check
plus a type change, and `Unmanaged<T>` needs the member forwarding that `Own<T>`
and `Borrow<T>` already require. The whole lattice can therefore ship *before*
O1/O2 with runtime-only enforcement, and O2 later upgrades `Own<T>` from runtime
to compile-time detection **without any signature changing**.

## Layer 3: implicit drop

Inserting `dispose()` automatically when an owned value leaves scope unmoved is
what turns affine (*at most* once) into leak-free. It is also the expensive
half, and it needs four things that are easy to leave out of a sketch:

1. **Unwind paths.** Every scope holding a live resource needs cleanup on
   exception propagation. `finally` makes this expressible; it is still real
   codegen, and it has code-size cost in a project that tracks code size.
2. **Drop flags.** ~~A value moved in one branch of an `if` and not the other
   cannot be resolved statically.~~ **Resolved (2026-08-06)** by §"The
   branch-join rule": the meet-plus-edge-drops join makes such a value uniformly
   dead at the merge, so no runtime drop flag is needed for conditional moves.
   The residue is `try`/`catch`, where there is no syntactic edge to compensate
   on — see §"Where the join rule runs out". The `owned | moved | dropped` flag
   remains, but for the non-affine population and for `adopt`, not for this.
3. **Child-before-parent ordering.** WIT requires that a `request-options`
   obtained from a `request` be dropped *before* its parent. Reverse-declaration
   order does not automatically satisfy parent/child relationships that were
   established by a call, so the wrapper must record its parent.
4. **Async cancellation.** A resource live across a suspension point is stored
   in the state-machine struct built by Track G's split pass. If the task is
   cancelled and never resumed, something must still drop it. This is the one
   place ownership genuinely does interact with Track G — and it is a real
   problem with or without affine types. **Mostly answered (2026-08-06):**
   `generators.zena` already computes the liveness this needs; the remaining
   work is a per-state drop table. See §"What Track G already built".

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
This work is **Track O**, adopted into the plan of record on 2026-08-06. It
competes with none of the existing tracks for infrastructure: G and B are
ZIR/M-track work, V and A are the records/equality arc, while O is checker-side
plus a small amount of surface syntax.

| | Work | Needs | Independent of |
| --- | --- | --- | --- |
| **O0** | `resource class`, `zena:ownership` (`Own`/`Borrow`/`Unmanaged`/`Disposable`), `disown`/`adopt`, drop glue | nothing | everything |
| **O0.5** | `using` + scope-exit cleanup lowering | O0 | everything |
| **O1** | Checker flow graph | nothing | everything |
| **O2** | Affine move checking on the flow graph (layer 2) | O0, O1 | G, V, A |
| **O3** | Implicit drop (layer 3) | O2; G1 for the cancellation table | V, A |
| **O3.5** | `affine T` type parameters + container opt-in | O2, A0's `where` | G, V |
| **O4** | `isolated<T>`/`frozen<T>`/regions (layer 4) | O2 | V, A |

**O0 is the milestone that unblocks the most.** The whole three-point type
lattice ships there with runtime-only enforcement, which means the *signatures*
freeze immediately — `fs.open(): Result<Own<Descriptor>, Error>` and the WIT
resource wrappers are written once and never churn, because O2 upgrades
detection from runtime to compile time without changing a single type. That is
what makes it safe for Track W's bindgen (Part 8 stage 3) to proceed after O0
rather than waiting for O2.

O1 is independently justified and commits us to nothing about ownership: it
fixes the live narrowing soundness bug filed in BUGS.md, generalizes the
hand-rolled `definitelyExits` recursion in `checker.zena`, and is the
prerequisite for any improvement to mutable-field narrowing.

O3.5 is deliberately last of the checker work and lands **lazily, one container
at a time**, when a real client needs it — `Array<Unmanaged<Conn>>` covers the
interim. It is the only Track O item with a cross-track dependency: it needs
member-level `where` bounds from Track A's A0.

O4 *is* concurrency.md's ownership types, which want the G-track in place
anyway.

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

**Revised 2026-08-06.** The 2026-08-04 order put O1 first because affine types
were thought to need the flow graph before they could exist at all. They do not:
the *type lattice* is pure type checking, and enforcement can start at runtime
on the state flag and be upgraded in place. Freezing the signatures early is
worth more than checking them early, because signatures are what other tracks
build against.

1. **O0 — the type lattice, no flow analysis.** `resource class`;
   `zena:ownership` with `Own<T>`/`Borrow<T>`/`Unmanaged<T>`/`Disposable`;
   `disown`/`adopt`; the `owned | disowned | moved | dropped` flag; drop glue.
   The purely local rules land here too — owns are returnable and movable;
   borrows are second-class (a syntactic rejection on field store, array store,
   closure capture, and return-without-a-single-borrow-source); implicit
   `Own → Borrow` at borrow-typed parameters. Enforcement of *move* discipline
   is runtime-only at this stage.
2. **O0.5 — `using` + the scope-exit cleanup lowering.** `try`/`finally` on all
   exit paths. Surfaced as `using` for the non-affine population, and reused
   unchanged by implicit drop in step 5.
3. **O1 — the checker flow graph.** Independently justified: fixes the narrowing
   soundness bug in BUGS.md and generalizes the hand-rolled narrowing special
   cases. Commits us to nothing about ownership.
4. **O2 — affine move checking** on the O1 flow graph, with the meet-plus-edge-
   drops join rule. Upgrades O0's runtime detection to compile time. **No
   signature changes** — this is the point of the ordering.
5. **O3 — implicit drop**, once its sub-problems have answers: unwind paths,
   the `try`/`catch` residue of the join rule, child-before-parent ordering, and
   the cancellation drop table.
6. **O3.5 — `affine T`** and container opt-in, lazily, after A0's `where`.
7. **O4 — `isolated<T>`/`frozen<T>`/regions**, reusing O2.

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

**Sharpened 2026-08-06:** the dependency is on **O0**, not O2. O0 freezes the
type lattice and therefore the generated signatures; O2 changes only where the
errors are reported. Bindgen no longer waits for move checking. Stage 4's
resource tables and stage 3's wrappers both want `disown`/`adopt` regardless,
since those *are* the handle-table transitions.

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
5. ~~Who drops resources held in a cancelled task's state machine?~~ —
   **mostly answered**: a per-state drop table derived from the liveness
   `generators.zena` already computes. Residual: who *calls* the frame's
   `dispose()` when a task is abandoned rather than cancelled.
6. ~~Flow graph as an AST side table vs. a pre-check HIR (layer 2)~~ —
   **decided**: side table. ZIR cannot serve (post-check, post-RTA, no spans),
   and an HIR would be a third IR plus a permanent bidirectional source map owed
   to the language service.
7. Multi-borrow returns: reject, or name the source parameter (layer 2,
   "Returning derived borrows")?
8. Reconciling concurrency.md's `isolated`/`frozen`/`borrow` vocabulary with
   `Own`/`Borrow` (layer 4) — naming should be settled before either is built.
9. Mutable-field narrowing: stay sound and restrictive, adopt TypeScript's
   deliberate unsoundness, or use whole-program reachability to narrow
   `#private` fields soundly (layer 2).
10. **`try`/`catch` and the join rule** (§"Where the join rule runs out"):
    reintroduce a runtime drop flag inside `try` bodies, or split the try region
    at each acquisition? This is the only surviving case where the
    no-drop-flags claim does not hold.
11. **Naming**, held open deliberately: `disown`/`adopt` and `Unmanaged<T>` are
    the current picks with alternatives recorded in §"The vocabulary, decided".
    Cheap to change until `zena:ownership` has clients.
12. **Does `resource class` need a `Disposable` implementation, or is `dispose`
    implicit?** A WIT wrapper's release is always "call the imported drop
    function with `this.#handle`", which bindgen could synthesize. Hand-written
    resource classes still need to write one.

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
