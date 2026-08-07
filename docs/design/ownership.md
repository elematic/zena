# Ownership & Resource Management

## Overview

Zena is garbage-collected, but not everything a Zena program holds is memory the
collector can reclaim. A WASI file descriptor, a WebAssembly Component Model
handle, a linear-memory allocation, a pointer owned by a peer language's
allocator — each must be released by a specific action at a specific time, and
WebAssembly GC has no finalizers to hang that action on.

This document defines the language mechanism for those values: what they are,
how they are declared, and the rules that make sure each one is released exactly
once and never used after release.

Four other designs need it:

| Design | The resource | Release action |
| --- | --- | --- |
| [component-model.md](./component-model.md) | WIT `own<T>` handles | host `resource.drop` |
| [linear-memory.md](./linear-memory.md) | `Allocator.alloc` pointers | `Allocator.free` |
| [filesystem.md](./filesystem.md) | WASI descriptors | descriptor drop |
| FFI (a peer language in the same binary) | foreign allocations | the peer's deallocator |

[concurrency.md](./concurrency.md) needs the same machinery from a different
direction: a value safe to hand to another thread is one this document would
call uniquely owned. See [Parallelism](#parallelism).

Two design constraints shape everything below:

1. **No lifetime variables.** Zena is TypeScript-shaped; `'a` is not on the
   table.
2. **Align with WIT's vocabulary.** `own` and `borrow` mean here what they mean
   in the Component Model, so that when it gains GC lowering only the lowering
   moves, not the surface.

---

## Concepts

### Resource

A **resource** is a value that holds something the garbage collector cannot
reclaim, and that therefore has a release action.

Resource-ness is a property of a *class*, declared with the `resource` modifier:

```zena
resource class Descriptor {
  #handle: i32;
  new(handle: i32) : #handle = handle;
  :Disposable.dispose(): void { __wasi_descriptor_drop(this.#handle); }
}
```

`resource class` carries three obligations:

1. **It must provide a release action.** A resource class nominally implements
   [`Disposable`](#disposable) and must define `:Disposable.dispose()`. No
   `implements Disposable` clause is written — the `resource` modifier is the
   conformance, following the way case classes nominally implement `Hashable`.
   This is what makes the class a resource rather than merely a class you must
   not copy; a class that needs uniqueness but has nothing to release is not a
   resource (see [Uniqueness without a resource](#uniqueness-without-a-resource)).
2. **It has no unwrapped form.** Bare `Descriptor` is not a spellable type.
   Every mention in a type position is `Own<Descriptor>`, `Borrow<Descriptor>`
   or `Unmanaged<Descriptor>`, so which regime a signature is in is always
   visible at the signature.
3. **It cannot be an extension class.** An extension class re-presents an
   existing representation such as a primitive or an array; a resource class is
   defined by having no unwrapped representation to re-present.

Ordinary classes are unaffected by any of this, including ordinary classes that
release something — see [`Disposable`](#disposable) below.

### `Disposable`

`Disposable` is the release protocol, declared in `zena:ownership`. One
interface serves every kind of resource, so that a WIT handle, an allocation and
a foreign pointer all release through the same mechanism:

```zena
export interface Disposable {
  static symbol dispose;
  :dispose(): void;
}
```

`dispose` is **symbol-keyed**. It is a common enough method name that a class
may already have one meaning something unrelated, and this is a protocol the
language invokes implicitly, so a silent collision would release something at
the wrong time. Call it as `value.:Disposable.dispose()`.

Two obligations on implementors:

- **Idempotent.** `dispose()` may be called on an already-disposed value and
  must not release twice.
- **Must not throw.** It runs on exception-unwind paths, where a second
  exception would displace the one being propagated.

Implementations are ordinary Zena code — a WIT wrapper calls the imported drop
function, a linear-memory allocation calls `Allocator.free`, an FFI handle calls
the peer's deallocator. Encoding release as an interface rather than a built-in
is what lets one system cover all of them: a pointer owned by a peer's allocator
must be released by *that* allocator, not by `resource.drop`.

At the core-wasm level, dropping a WIT resource is an ordinary imported function
call rather than an instruction, verified against `wasm-tools` 1.252.0:

```wat
(import "cm32p2|test:brw/i" "sock_drop" (func (;3;) (type 3)))
```

So no new codegen primitive is needed; the existing `@external` path covers it.

**`Disposable` does not imply resource-ness.** Plenty of values want scope-bound
cleanup without the rest of the machinery — a lock guard, a tracing span, a
transaction, a subscription, an arena reset. Those are ordinary classes that
implement `Disposable`, stay freely aliasable, stay spellable bare, and are
released by [`using`](#using). The two populations share the protocol and
nothing else:

| | Released by | Guarantee |
| --- | --- | --- |
| `Own<R>` for a resource class `R` | implicit drop at scope exit | static — cannot be forgotten, cannot be used after move |
| An ordinary `Disposable` | explicit `using` | deterministic, but not statically checked |

### Affine types

A type is **affine** when a value of that type may be used *at most* once. This
is standard substructural terminology: an unrestricted type permits both
duplication and discarding, an affine type drops duplication, a linear type
drops both.

Zena implements true affineness for `Own<T>`, not a variant of it. A value of
type `Own<T>` may be moved to exactly one destination — passed to a function
that takes ownership, returned, stored in a field — after which the original
binding is dead. It may not be duplicated.

Discarding *is* permitted, and that is what keeps this affine rather than linear:
a program never has to consume an `Own<T>` explicitly. Anything left unmoved when
its scope ends is released by the compiler. Note the consequence — in the
*compiled* program every path consumes each owned value exactly once, either by
a move the programmer wrote or by a drop the compiler inserted. That is an
implementation property, not an obligation the programmer carries.

Affineness is a property of a *type*, and it is orthogonal to subtyping. It is
not expressible as an interface; see
[Alternatives considered](#alternatives-considered).

### Handles

Every reference to a resource is one of three **handle kinds**, all declared in
`zena:ownership`:

| Handle | Meaning | Duplicate? | Escape the frame? | Releases? |
| --- | --- | --- | --- | --- |
| `Own<R>` | the owning reference | **no** | yes | yes, when it leaves scope unmoved |
| `Borrow<R>` | temporary access, no ownership | yes | **no** | never |
| `Unmanaged<R>` | ownership handed back to the programmer | yes | yes | **never implicitly** |

The three are exhaustive: a resource class has no unwrapped form, so a value of
one is always behind exactly one of them.

They differ along two independent axes, and keeping the axes separate is what
makes the system tractable:

- **Affineness** governs duplication. Only `Own<R>` is affine.
- **Second-class-ness** governs escape. Only `Borrow<R>` is second-class.

Which yields three universes over all Zena types:

| Universe | Members | Duplicate? | Escape? | Released? |
| --- | --- | --- | --- | --- |
| Unrestricted | primitives, `String`, ordinary classes, `Unmanaged<R>` | yes | yes | never implicitly |
| Affine | `Own<R>`, and types containing one | **no** | yes | at scope exit, unmoved |
| Second-class | `Borrow<R>` | yes | **no** | never |

### Resource-ness and affineness are separate

`resource class` declares resource-ness. `Own<T>` declares affineness. They are
different properties and the distinction is load-bearing in two places.

**It determines where the declaration goes.** `Own<Descriptor>` claims to be
*the* owning reference. That claim holds only because no unwrapped `Descriptor`
alias can exist — which is a property of the class, uniform across every mention
of it, and so must be declared at the class. A per-use annotation could not
support the claim: one reference could be annotated owning and another not, both
naming the same object.

<a id="uniqueness-without-a-resource"></a>
**It leaves room for uniqueness without release.** Some values want to be unique
without being resources — a data structure being transferred between threads, for
instance, has nothing to release but must not be aliased once handed over. Those
are ordinary classes wrapped in `Own<T>`:

- **`Own<R>` where `R` is a resource class** — always available, because there
  is no unwrapped form to alias.
- **`Own<C>` where `C` is an ordinary class** — available only from a *provably
  exclusive source*: a fresh allocation, or an `Own<T>` moved in. Ambient
  aliasing means `Own<C>` and a bare `C` could otherwise name the same object,
  and the exclusivity claim would be false.

Same wrapper, same checking, one extra premise in the second case. This is what
[Parallelism](#parallelism) is built on.

---

## Specification

### Owning

A function may **return** an `Own<T>`:

```zena
export function open(path: String, flags: Flags): Result<Own<Descriptor>, Error>
```

A `return f` where `f: Own<T>` is a move — the release obligation transfers to
the caller. Both sides are checkable from the signature alone: there is no
lifetime to name and nothing derived from an argument, so this needs no
whole-program or interprocedural analysis. Returning by value is easy for the
same reason it is easy in Rust; it is returning a *borrow* that is hard.

Consequently the loan pattern is not forced: `fs.open()` hands a descriptor back
rather than requiring `withFile(path, cb)`.

`Result<Own<T>, E>` costs nothing extra. `Result` is a type alias over an inline
multi-value union, so an owned handle rides in one lane of a multi-value return
and is destructured at the call site:

```zena
if (let (true, f, _) = fs.open(path, Flags.Read)) {
  // f : Own<Descriptor> — moved out of the return, live from here
}
```

### Borrowing

Borrows are stack-bound and may not escape:

1. Legal only as parameter types and local bindings.
2. A function may return a borrow only when it derives from exactly one of its
   borrow parameters (see below).
3. A borrow may not be stored in an object, array, field, or closure capture.
4. Borrowing at a call site is implicit — `read(file)`, not `read(&file)`.

This is what removes the need for lifetime variables. It is a principled
position rather than a shortcut — see Osvald et al., *"Gentrification Gone Too
Far? Affordable 2nd-Class Values for Fun and (Co-)Effect"* (OOPSLA 2016).

WIT independently forbids returning a borrow, verified against `wasm-tools`
1.252.0:

```
error: function `give-back` returns a type which contains a `borrow<T>`
       which is not supported
```

That constrains the **component ABI boundary** — functions a world imports or
exports — and nothing else. Ordinary Zena functions that never cross that
boundary are governed by rule 2 above, which is weaker.

#### Derived borrows

A blanket ban on returning borrows is too strong for internal code. The cases it
wrongly rejects are the common ones:

```zena
let first = (xs: Borrow<Array<Own<File>>>): Borrow<File> => xs[0];
let name  = (f: Borrow<File>): Borrow<String> => f.name;   // field projection
```

Field projection especially is not optional: if `f.name` on a borrowed `f`
cannot itself be a borrow, borrows are unusable.

The fix is **elision**:

- With exactly **one** borrow parameter, a returned borrow derives from it. The
  caller treats the result as borrowing the argument it passed, so the borrow's
  extent is the caller's existing borrow scope.
- With **zero** borrow parameters, returning a borrow is illegal — there is
  nothing for it to derive from.
- With **two or more**, the derivation is ambiguous. Either reject, or name the
  source parameter positionally at the signature, e.g. `-> Borrow<T> from xs`.
  **Open.**

Projections through fields and indices follow the same rule: a borrow of a place
reachable from a borrowed value derives from that value.

This does reintroduce a weak form of lifetime reasoning. Pure second-class-ness
says a borrow never outlives the frame that made it; elision relaxes that to "a
borrow may travel out one frame, to the caller that supplied its source". That
is far less than full lifetimes — no lifetime variables, no variance, no
`outlives` constraints, no annotations in the common case — but it is not
nothing.

#### `Borrow<T>` is the identity at unrestricted instantiations

Borrowing an unrestricted value is a no-op, so `Borrow<i32>` is `i32` and
`Borrow<String>` is `String`. The second-class restrictions exist to stop a
borrow outliving an owner; an unrestricted type has no owner to outlive, so at
those instantiations they do not apply.

This is what lets generic container APIs be written in borrow form once and read
unchanged at every existing instantiation:

```zena
operator [](key: K): Borrow<V>      // is exactly V for HashMap<String, i32>
```

Inside a generic body the restrictions *do* apply, because the body is checked
against the worst case its bound permits.

### Disowning and adopting

`disown` and `adopt` move a resource between the affine regime and the
manually-managed one:

```zena
let raw: Unmanaged<Descriptor> = disown(f);   // f : Own<Descriptor>, consumed
// … alias it, store it in a field, put it in an ordinary Array …
let f2: Own<Descriptor> = adopt(raw);         // back under implicit drop
```

This is checked, not unsafe. Every resource carries an
`owned | disowned | moved | dropped` state flag:

- `disown(f)` requires `owned`, sets `disowned`, returns the same object typed
  `Unmanaged<T>`. It consumes its argument — otherwise an `Own` that will
  implicitly drop would coexist with an `Unmanaged` alias to the same handle.
- `adopt(r)` requires `disowned`. On `owned` (something else adopted it first)
  or `dropped` it **throws**. That is a programming error rather than an
  expected condition, so throwing is right; a `tryAdopt(): Result<Own<T>, …>`
  can be added if a caller wants the branch.

Two racing adopters therefore do not double-free — the loser gets a clear error.
What entering `Unmanaged<T>` gives up is **leak-freedom** and *compile-time*
detection of use-after-dispose, the latter degrading to a runtime error. Type
soundness and memory safety are unaffected.

`adopt` cannot retract aliases. Aliasability is the point of the disowned state,
so unlike [`Resource<C>`](#containers) — which requires exclusivity at
construction — the state flag is the only defence here.

Three uses:

- **The canonical ABI requires it.** An exported function returning WIT `own<T>`
  must hand the raw handle index to the host and stop tracking it; an imported
  one receives an index and must start. Those are `disown` and `adopt` on the
  handle table, so bindgen needs both regardless of whether users see them.
- **Resource-holding containers before generic containers support them.**
  `Unmanaged<T>` is unrestricted, so `new Array<Unmanaged<Conn>>()` works with no
  affine-generics machinery at all.
- **Release points that are not lexical**, including the WIT requirement that a
  `request-options` be dropped before its parent `request` — an ordering nothing
  static will check across a disown.

`using` composes directly, since `Unmanaged<T>` is `Disposable`:

```zena
using let raw = disown(f);   // deterministic release at scope exit
```

<a id="using"></a>
### `using`

`using` gives deterministic release to any `Disposable`, and is the mechanism for
the non-affine population:

```zena
using file = openConfig(path);
// … use file …
// dispose() runs on every exit path, including exceptions
```

Semantics: reverse declaration order at scope exit; runs on normal exit, early
return, `break`/`continue`, and exception unwind. It desugars to `try`/`finally`.

It composes with refutable pattern conditions as a binding modifier:

```zena
if (using let Ok(file) = openConfig(path)) {
  file.readString();
}   // disposed here, on every exit path
```

Disposal is scoped to the branch, not the enclosing function, and if the pattern
does not match nothing was bound and nothing is disposed.

An `Own<R>` bound by `if (let …)` is already released by implicit drop at branch
exit, so `using` is redundant there. The construct earns its keep on ordinary
`Disposable` values.

### Move checking

Each local of affine type has a state: `Unborrowed → SharedBorrow |
ExclusiveBorrowed | Moved`, with use-after-`Moved` a compile error and borrow
states scoped to the call expression.

The analysis is flow-sensitive: move state must merge at join points, and a move
inside a loop body is a use-after-move on the second iteration, which no single
AST walk can see. See [The checker flow graph](#the-checker-flow-graph).

#### The branch-join rule

At a join, the move state is the **meet**, and each predecessor edge carries
compensating drops to reach it. A resource live on one incoming edge and dead on
another is dropped on the edge where it is live, so it is uniformly dead at the
merge.

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

This buys away **runtime drop flags**: drop points are statically known, so code
size is predictable. Rust carries runtime drop flags precisely because it
declines this trade.

It costs two things, both deliberate.

**It rejects some sound programs.** Move on one arm, fall through, keep using:

```zena
let f = fs.open(path);
if (handOff) { pool.give(f); }   // moved here
f.read();                         // error: f was released at the end of `else`
```

The common conditional-handoff shape diverges — `if (x) { pool.give(f); return; }`
— so the moving branch never reaches the merge and `f` stays live. What is
rejected is the non-diverging form above, which is usually a bug. The checker
must retain *where* the collapse happened, so the message reads "`f` was moved on
the `then` branch at line N and released at the end of the `else` branch", not
"`f` is not live".

**It changes release timing.** In the non-consuming branch the resource is
released at that branch's `}`, earlier than scope exit. If no later use exists,
no error fires and the resource simply closed sooner than lexical scoping would
suggest. This is observable when `dispose()` has effects, and belongs in the
language reference.

#### Where the join rule does not reach

- **Loops.** A forward walk accepts `while (c) { consume(f); }`, since `f` is
  live when the line is reached and only the back edge makes it wrong. Rule:
  compare the loop body's out-state to its in-state and **error** if a resource
  declared outside the loop was consumed without being reinitialized on every
  path to the back edge. Sound, one pass, no fixpoint.
- **`try`/`catch`/`finally`.** The state at a `catch` entry is the meet over
  every program point in the `try` body, since any call may throw. There is no
  syntactic edge to hang a compensating drop on, and "was `f` initialized when we
  unwound?" is genuinely dynamic. Either a runtime flag returns here, or the try
  region is split at each acquisition. **Open** — this is the one case where the
  no-drop-flags property does not hold.
- **Suspension.** After the generator split pass, locals live across a yield
  become frame fields, and a suspended frame may be dropped without being
  resumed. "Which owns are live in state *k*" is a per-state table, not a
  lexical list.

### Implicit drop

Inserting `dispose()` when an owned value leaves scope unmoved is what turns
affine (*at most* once) into leak-free. Four parts:

1. **Unwind paths.** Every scope holding a live resource needs cleanup on
   exception propagation. `finally` makes this expressible; it is still real
   codegen with code-size cost.
2. **Conditional moves** are handled by the branch-join rule above, with
   `try`/`catch` the open residue. The `owned | disowned | moved | dropped` flag
   remains, but for the non-affine population and for `adopt` — not for this.
3. **Child-before-parent ordering.** WIT requires a `request-options` obtained
   from a `request` to be dropped before its parent. Reverse-declaration order
   does not automatically satisfy relationships established by a call, so the
   wrapper must record its parent. **Open**: recorded, or inferred?
4. **Cancellation.** A resource live across a suspension point lives in the
   state-machine frame. If the task is cancelled and never resumed, something
   must still drop it. The generator split pass already computes the liveness
   this needs; the remaining work is a per-state drop table that the frame's
   `dispose()` walks for its current `$state`. **Open**: who calls it when a
   task is abandoned rather than cancelled?

### Affine type arguments

A generic body is checked once, before it knows what `T` will be, so it must be
checked against the worst case its bound permits. If `T` may be affine, the body
may not duplicate a `T`:

```zena
let duplicate = <T>(x: T): (T, T) => (x, x);
```

Sound for `T = i32`; for `T = Own<Descriptor>` it creates two owners of one
handle and two drops of it.

Type parameters are therefore **unrestricted by default**, and accepting affine
arguments is opt-in per parameter:

```zena
class Pool<affine T> { … }              // T may be affine
class Array<T> { … }                    // an affine argument is rejected
let discard = <affine T>(x: T) => {};   // fine for Own<R> and for i32
```

`affine T` drops the implicit `T extends Copyable` bound. Widening what a
parameter accepts narrows what its body may do: inside such a body, each
`T`-typed value may be moved at most once per path. Borrowing stays unlimited.

Three things that need no opt-in, because they are the common cases:

- **Not using a `T`.** `<affine T>(x: T): void => {}` needs no bound; implicit
  drop releases `x`, and monomorphization emits that glue only for instantiations
  where `T` is actually affine.
- **Using it once per *path***, across branches. `HashMap.[]=` moves `key` and
  `value` at most once on each path; on the key-already-present path `key` is
  never consumed and the compiler drops it.
- **Generic fields.** `class Box<affine T> { var value: T }` — dropping the box
  drops the `T` through derived glue.

The opt-in is **declared, not inferred**. Whole-program compilation would allow
inferring it from bodies, but then errors land inside stdlib bodies at call sites
the user did not write, a signature stops being the contract, and adding a second
move to a stdlib method silently breaks distant callers.

#### Cost in the stdlib

Across `result`, `option`, `box`, `sequence`, `iterator`, `iterable-utils`,
`growable-array`, `fixed-array`, `immutable-array`, `map` and `set`, exactly one
site moves a `T` twice:

```zena
// fixed-array.zena — array.new fills N slots from one value
new(length: i32, value: T) : super(__array_new(length, value));
```

Under `FixedArray<affine T>` that constructor is unsound and must become
conditionally available, which is what member-level `where` bounds are for:

```zena
new(length: i32, value: T) where T extends Copyable : super(__array_new(length, value));
```

That mechanism is not specific to ownership — it is [equality.md](./equality.md)
D4, planned as part of Track A's bounds work for `contains where T extends
Equatable`.

The broader cost is a signature question rather than a body question: containers
hand out elements by value (`operator [](key): V`, `Iterator.next(): (true, T)`,
`map`'s callback), and for an affine element each of those is a move out of a
slot the container still owns. Those become `Borrow<V>`, and `Iterable<T>` needs
a borrowing iterator alongside the draining one so `contains`/`find`/`all` do
not consume the collection.

The stdlib opts in lazily, one class at a time, as real clients need it. Nothing
in `fs.open()` or WIT resource bindings needs any of it.

<a id="containers"></a>
### Containers

`Resource<C>` wraps a container `C` and makes it affine:

```zena
let a: Resource<Array<Foo>> = new Array<Foo>();   // OK — provably unaliased
let b: Resource<Array<Foo>> = existingArray;      // rejected — not provably exclusive
```

- Legal sources are a fresh allocation or an `Own<T>` moved in, both of which
  the affine layer can already prove, so with the restriction there are no prior
  aliases to retract.
- The wrapper is affine: assigning it moves, and dropping it releases the
  contents transitively.
- **Disposal is derived, not written.** Dropping a `Resource<Array<Own<File>>>`
  drops the array, which drops each element; the compiler generates that glue.
  Monomorphization makes it precise — `Array<Own<File>>` is already a distinct
  specialization, so glue is generated only for instantiations that contain
  affine elements. No `disposeAll()`, no resource-aware variant of every
  collection.
- Indexing a borrowed `Resource<Array<T>>` yields `Borrow<T>`; moving an element
  out needs an explicit `take`/`swap`/`pop`, since the container must not be left
  with a hole it would later try to drop.

**Open**: `Own<T>` is arguably `Resource<T>` for a single value. Whether these
are one type spelled two ways or two concepts should be settled alongside the
[parallelism](#parallelism) vocabulary.

### Linear memory and FFI

Two points specific to non-WIT resources.

**Pointers need a nominal type before they can be affine.** `Allocator.alloc`
returns a bare `i32`, and a primitive has no identity and nowhere to carry
state. `distinct type Ptr<T> = i32` is a prerequisite, and is worth adding on
its own merits: `(ptr: i32, len: i32)` signatures in `fs.zena` and `cli.zena` can
currently be transposed silently.

**How opaque can an address be?** Opaque enough to avoid a general `unsafe`:

| Code | Needs | Opaque `Ptr<T>` sufficient? |
| --- | --- | --- |
| Canonical ABI marshaling | load/store at statically known offsets; element `i` of a known stride | **Yes** — typed accessors, `p.loadU32(offset)`, `p.elem(i)`, not arithmetic |
| Foreign struct walking (FFI) | offsets from a foreign layout | **Yes**, given a declared layout to generate accessors from |
| The allocator itself | genuine arithmetic — `FreeListAllocator` threads free-list `next` pointers through freed blocks | **No** |

So arbitrary pointer arithmetic is needed to *implement* the allocator, not to
read and write WASI data. That is a much smaller surface than a general escape
hatch: a single privileged module with raw access rather than an `unsafe` keyword
available everywhere. Residual unsoundness is confined to that module plus any
hand-declared foreign layout being wrong, which is the same class of bug as a
wrong `@external` signature today. **Open**: privileged module, or general
`unsafe`?

The unit of ownership for linear memory is the **region, not the pointer** — an
affine arena handle, `using`-scoped, released as a unit. That covers the dominant
case, the canonical ABI's transient allocate/copy/call/free, without per-pointer
dataflow.

<a id="parallelism"></a>
### Parallelism

[concurrency.md](./concurrency.md) designs `isolated<T>`, `frozen<T>` and scoped
`borrow`/`share` from the parallelism side. That is this document's machinery
specialised to threads, and the two vocabularies should be reconciled to one
before either is built, or Zena ends up with two ownership systems and two borrow
checkers:

| concurrency.md | Here | Note |
| --- | --- | --- |
| `isolated<T>` | `Own<T>` | Unique, transferable, move-on-transfer — the same type. `isolated` is a thread-specific name for a general property. |
| `borrow child` (scoped, exclusive) | `BorrowMut<T>` | The same exclusive borrow; `parallel.scope` is a second-class borrow with a wider frame. |
| `share treeRef` (scoped, read-only) | `Borrow<T>` | Shared immutable borrow. |
| `frozen<T>` | *no equivalent* | Genuinely additional: deep immutability is about transitive reachability, not uniqueness, and is what makes a value safely *shareable* rather than merely borrowable. Keep it, defined against this vocabulary. |
| regions | region-as-affine-handle | The same idea as linear memory's regions, above. |

This is the main consumer of `Own<C>` over ordinary classes: a data structure
handed to another thread has nothing to release, but must not be aliased once
transferred.

---

<a id="the-checker-flow-graph"></a>
## The checker flow graph

Move checking is flow-sensitive with merges and loops. That analysis does not
exist today: the checker has a lexically-scoped narrowing stack and ad-hoc
`definitelyExits` recursion, and nothing invalidates a narrowing on assignment.
Building it is the real cost of move checking, and it is reusable well beyond
ownership.

**A flow graph, not a new IR.** TypeScript — the language Zena is shaped like —
does full flow-sensitive narrowing with joins and loops and no IR: its binder
attaches *flow nodes* to AST nodes (labels with antecedents for joins, condition
and assignment nodes, loop labels), and narrowing walks that graph backwards with
caching. For Zena a flow graph keyed by node ID is one more side table, exactly
like `SemanticModel`.

ZIR cannot serve. It runs post-check and post-RTA, so it is per-instantiation and
does not exist at all for code RTA drops — while checking must cover unreached
code — and it carries no source spans, so it cannot report "used after move" at a
line.

One pass serves several consumers:

- move checking
- definite assignment
- unreachable-code detection
- `using` scope analysis, which wants to know the exit paths
- the narrowing special cases currently hand-rolled in `checker.zena`

**It pays for itself before ownership does.** Narrowing is stored in a
lexically-scoped stack that nothing invalidates on assignment, which is unsound
today:

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
pointer`. An assignment-aware flow graph makes this class of bug structurally
impossible rather than patched case by case.

### Narrowing mutable fields

Narrowing a mutable class field is refused outright today: the immutable-path
check requires every field in the path to be declared immutable, so `var #x: Foo
| null` can never narrow. That is a deliberate soundness choice given that
nothing currently invalidates a narrowing.

A flow graph is **necessary** to lift it, since lifting it means knowing where
the path is assigned. It is **not sufficient**: the hard part is not assignment
but *reachable* assignment, because any call between the guard and the use might
reassign the field, and any alias of the object might too. That is an
escape/effect question, not a control-flow one. Three positions:

1. **Status quo** — immutable paths only. Sound, restrictive, the current source
   of pain.
2. **TypeScript's rule** — narrow mutable fields, invalidate on assignments
   visible in the flow graph, accept that an intervening call or alias can
   silently invalidate. Ergonomic and deliberately unsound. Zena advertises sound
   typing and prefers loud failures, so this would be a real character change.
3. **Sound, and more achievable here than in TypeScript** — narrow over a region
   containing no assignment to that path and no call that could reach one.
   TypeScript cannot compute that because any module may be patched at runtime;
   Zena has whole-program information and `#private` fields whose assignments are
   confined to one class body, so "can this call reassign `#x`?" is answerable.
   Scoping it to `#private` fields first covers most real cases at a fraction of
   the cost.

**Open.**

### The checker/lowering seam

The checker decides *legality* and records drop obligations into `SemanticModel`
as a side table — node or edge → the symbols to release there. ZIR lowering
materializes them, because that is where unwind edges and the generator split
already live. Diagnostics stay span-faithful, drop placement stays in the one
component that already understands landing pads and suspension, and neither side
grows a second notion of control flow to keep in sync.

---

## Implementation plan

This is **Track O** in [implementation-plan.md](./implementation-plan.md). It
competes with no other track for infrastructure: G and B are ZIR/M-track work, V
and A are the records/equality arc, while O is checker-side plus a small amount
of surface syntax.

| | Work | Needs | Independent of |
| --- | --- | --- | --- |
| **O0** | `resource class`, `zena:ownership` (`Own`/`Borrow`/`Unmanaged`/`Disposable`), `disown`/`adopt`, drop glue | nothing | everything |
| **O0.5** | `using` + scope-exit cleanup lowering | O0 | everything |
| **O1** | Checker flow graph | nothing | everything |
| **O2** | Move checking on the flow graph | O0, O1 | G, V, A |
| **O3** | Implicit drop | O2; G1 for the cancellation table | V, A |
| **O3.5** | `affine T` type parameters + container opt-in | O2, A0's `where` bounds | G, V |
| **O4** | `isolated<T>`/`frozen<T>`/regions | O2 | V, A |

**O0 unblocks the most.** The whole handle lattice ships there with runtime-only
enforcement of move discipline, which freezes the *signatures* immediately:
`fs.open(): Result<Own<Descriptor>, Error>` and the WIT resource wrappers are
written once and never churn, because O2 upgrades detection from runtime to
compile time without changing a single type. That is what lets Track W's bindgen
(component-model.md Part 8 stage 3) proceed after O0 rather than waiting for O2.

**O1 commits us to nothing about ownership** and is independently justified: it
fixes the narrowing soundness bug above, generalizes the hand-rolled
`definitelyExits` recursion, and is the prerequisite for any improvement to
mutable-field narrowing.

**O3.5 lands lazily**, one container at a time, as real clients appear;
`Array<Unmanaged<Conn>>` covers the interim. It is the only Track O item with a
cross-track dependency, on Track A's member-level `where` bounds.

Ordering note: O0 precedes O1 because the handle lattice is pure type checking
and can enforce move discipline at runtime on the state flag. Freezing
signatures early is worth more than checking them early, since signatures are
what other tracks build against.

---

## Alternatives considered

Only the two that look like obvious directions and need arguing against.

### `Resource` as a marker interface

Instead of a class modifier, declare `interface Resource extends Disposable` and
let a class opt in by implementing it. This does not work, because affineness
would enter the subtype lattice:

```zena
class Descriptor implements Resource { … }   // Resource extends Disposable

let d: Own<Descriptor> = fs.open(path);
let x: Disposable = d;    // Descriptor <: Resource <: Disposable — a legal upcast
```

That upcast launders the affineness away. `Disposable` is deliberately not
affine, so an affine value would then sit in an unrestricted static type, freely
aliasable, with nothing tracking it. Closing the hole means banning upcasts from
a resource class to any non-affine supertype — at which point `Resource` no
longer behaves like the language's other interfaces, and the modifier has been
reinvented with extra machinery and a surprising subtyping rule.

`Hashable` is not a counterexample. It is a real interface with a special
satisfaction rule in the checker, but what it does is constrain *type arguments*
(`K extends Hashable`); it does not change the structural rules governing values
of the type. An interface is the right shape for "this type supports an
operation" and the wrong shape for "this type may not be duplicated".

### A pre-check HIR

Move checking needs flow sensitivity, and one way to get it is to lower to an IR
before checking. Rejected: type-directed lowering cannot run before checking, and
Zena leans on types heavily at lowering time (monomorphization, vtables, record
shapes, devirtualization), so a pre-check IR could not do that work and ZIR would
still be needed afterwards. That is why Rust has HIR → THIR → MIR — a coherent
design, and a third IR for a compiler that has just finished landing its second.

The costs that bite hardest here:

- **The language service is a first-class deliverable.** Checking a desugared HIR
  means maintaining a bidirectional mapping back to source forever, for hover,
  completion and go-to-definition. This is the stated reason TypeScript refuses
  an IR.
- **Diagnostics** must name what the user wrote, not what it desugared to.
- **Parallelism is the weakest argument for it.** Checking is inherently
  cross-module, so the parallelizable part is parsing and lowering, which is
  already the cheap half.

If an HIR later proves necessary, the more natural move is to push ZIR *earlier*
— making the checked representation and the optimizer's representation the same
thing — rather than adding a third IR.

---

## Open questions

1. Multi-borrow returns: reject, or name the source parameter?
2. `try`/`catch` and the branch-join rule: a runtime drop flag inside `try`
   bodies, or split the try region at each acquisition?
3. Child-before-parent drop ordering: recorded on the wrapper, or inferred?
4. Who drops a resource in an *abandoned* task's frame? (Cancellation itself is
   answered by the per-state drop table.)
5. Raw linear-memory access: privileged allocator module, or a general `unsafe`?
6. Mutable-field narrowing: stay restrictive, adopt TypeScript's unsoundness, or
   use whole-program reachability for `#private` fields?
7. Reconciling concurrency.md's `isolated`/`frozen`/`borrow` vocabulary with
   `Own`/`Borrow`.
8. Are `Resource<C>` and `Own<T>` one type or two?
9. Should bindgen synthesize `dispose()` for generated WIT wrappers? The release
   is always "call the imported drop function with `this.#handle`", so it can;
   hand-written resource classes still write their own.
10. Naming: `disown`/`adopt`, `Unmanaged<T>`, `affine T`. Cheap to change until
    `zena:ownership` has clients.

## Related

- [component-model.md](./component-model.md) — WIT resources, the motivating case
- [linear-memory.md](./linear-memory.md) — allocators
- [filesystem.md](./filesystem.md) — WASI descriptors
- [concurrency.md](./concurrency.md) — parallelism; the vocabulary to reconcile
- [equality.md](./equality.md) — member-level `where` bounds, which O3.5 uses
- [exceptions.md](./exceptions.md) — `try`/`finally`, the desugaring target
- [self-hosted-compiler.md](./self-hosted-compiler.md) — `SemanticModel` side tables
- [ir.md](./ir.md) — ZIR, the post-type CFG+SSA IR
- [implementation-plan.md](./implementation-plan.md) — plan of record
