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

| Design                                     | The resource               | Release action         |
| ------------------------------------------ | -------------------------- | ---------------------- |
| [component-model.md](./component-model.md) | WIT `own<T>` handles       | host `resource.drop`   |
| [linear-memory.md](./linear-memory.md)     | `Allocator.alloc` pointers | `Allocator.free`       |
| [filesystem.md](./filesystem.md)           | WASI descriptors           | descriptor drop        |
| FFI (a peer language in the same binary)   | foreign allocations        | the peer's deallocator |

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

Resource-ness is a property of a _class_, declared with the `resource` modifier:

```zena
resource class Descriptor {
  #handle: i32;
  new(handle: i32) : #handle = handle;
  [Disposable.dispose](this: Own<this>): void { __wasi_descriptor_drop(this.#handle); }
}
```

`resource class` carries three obligations:

1. **It must provide a release action**, with a consuming receiver:
   `[Disposable.dispose](this: Own<this>): void`. No `implements Disposable`
   clause is written — the `resource` modifier carries the requirement — and the
   consuming receiver is part of the resource-class contract rather than of the
   `Disposable` interface, which cannot express it for both populations. See
   [Release consumes its receiver](#release-consumes-its-receiver). This is what
   makes the class a resource rather than merely a class you must not copy; a
   class that needs uniqueness but has nothing to release is not a resource (see
   [Uniqueness without a resource](#uniqueness-without-a-resource)).
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
  [dispose](): void;
}
```

`dispose` is **symbol-keyed**. It is a common enough method name that a class
may already have one meaning something unrelated, and this is a protocol the
language invokes implicitly, so a silent collision would release something at
the wrong time. Call it as `value.[Disposable.dispose]()`.

Two obligations on implementors:

- **Idempotent.** `dispose()` may be called on an already-disposed value and
  must not release twice.
- **Must not throw.** It runs on exception-unwind paths, where a second
  exception would displace the one being propagated.

Implementations are ordinary Zena code — a WIT wrapper calls the imported drop
function, a linear-memory allocation calls `Allocator.free`, an FFI handle calls
the peer's deallocator. Encoding release as an interface rather than a built-in
is what lets one system cover all of them: a pointer owned by a peer's allocator
must be released by _that_ allocator, not by `resource.drop`.

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

|                                   | Released by                 | Guarantee                                               |
| --------------------------------- | --------------------------- | ------------------------------------------------------- |
| `Own<R>` for a resource class `R` | implicit drop at scope exit | static — cannot be forgotten, cannot be used after move |
| An ordinary `Disposable`          | explicit `using`            | deterministic, but not statically checked               |

### Affine types

A type is **affine** when a value of that type may be used _at most_ once. This
is standard substructural terminology: an unrestricted type permits both
duplication and discarding, an affine type drops duplication, a linear type
drops both.

Zena implements true affineness for `Own<T>`, not a variant of it. A value of
type `Own<T>` may be moved to exactly one destination — passed to a function
that takes ownership, returned, stored in a field — after which the original
binding is dead. It may not be duplicated.

Discarding _is_ permitted, and that is what keeps this affine rather than linear:
a program never has to consume an `Own<T>` explicitly. Anything left unmoved when
its scope ends is released by the compiler. Note the consequence — in the
_compiled_ program every path consumes each owned value exactly once, either by
a move the programmer wrote or by a drop the compiler inserted. That is an
implementation property, not an obligation the programmer carries.

Affineness is a property of a _type_, and it is orthogonal to subtyping. It is
not expressible as an interface; see
[Alternatives considered](#alternatives-considered).

### Handles

Every reference to a resource is one of three **handle kinds**, all declared in
`zena:ownership`:

| Handle         | Meaning                                 | Duplicate? | Outlive its extent?                   | Releases?                         |
| -------------- | --------------------------------------- | ---------- | ------------------------------------- | --------------------------------- |
| `Own<R>`       | the owning reference                    | **no**     | — an owner carries its extent with it | yes, when it leaves scope unmoved |
| `Borrow<R>`    | temporary access, no ownership          | yes        | **no**                                | never                             |
| `Unmanaged<R>` | ownership handed back to the programmer | yes        | —                                     | **never implicitly**              |

The three are exhaustive: a resource class has no unwrapped form, so a value of
one is always behind exactly one of them. A fourth type,
[`Scoped<T>`](#scopedt-the-fourth-corner), is not a handle — it applies to any
value, not just resources — but belongs to the same lattice and is introduced
with the async rules that motivate it.

They differ along two independent axes, and keeping the axes separate is what
makes the system tractable:

- **Affineness** governs duplication. Only `Own<R>` is affine.
- **Second-class-ness** governs extent. Only `Borrow<R>` is second-class — and
  "extent" rather than "frame" is load-bearing; see the note under the universe
  table below.

Which yields three universes over all Zena types:

| Universe     | Members                                                | Duplicate? | Outlive its extent?                   | Released?              |
| ------------ | ------------------------------------------------------ | ---------- | ------------------------------------- | ---------------------- |
| Unrestricted | primitives, `String`, ordinary classes, `Unmanaged<R>` | yes        | — extent is the whole program         | never implicitly       |
| Affine       | `Own<R>`, and types containing one                     | **no**     | — an owner carries its extent with it | at scope exit, unmoved |
| Second-class | `Borrow<R>`                                            | yes        | **no**                                | never                  |
| Scoped       | `Scoped<T>`, and types containing one                  | **no**     | **no**                                | at scope exit          |

The two properties are independent, so these are four corners of one lattice
rather than a list: **affineness** governs duplication, **second-class-ness**
governs extent, and `Scoped<T>` is the corner where both bind.

**"Outlive its extent", not "cross a frame boundary".** The restriction on
`Borrow<R>` and `Scoped<T>` is that the value may not be stored in the heap — no
field, array element, or closure capture — and may not be returned _except_ to
the caller that supplied the source it derives from. A value that derives from
nothing has the defining frame as its extent, so for it the two readings
coincide; that is why the shorter phrasing is usually harmless.

The exception is not a loophole, it is what makes the derived cases work at all:

```zena
let name = (f: Borrow<File>): Borrow<String> => f.name;
async function read(f: Borrow<File>): Scoped<Future<String>> { … }
```

Both return a second-class value, and neither escapes: each derives from `f`,
whose extent is the _caller's_ borrow scope — wider than the callee's frame — so
returning hands the value back into a region where it was already valid. What
stays illegal is leaving that region:

```zena
var cache: Borrow<File>;                      // rejected — a field outlives any extent
let leak = (): Scoped<Future<String>> => …;   // rejected — no borrow parameter to derive from
```

For `Scoped<T>` the two axes are satisfied separately and neither conflicts with
returning: a return is a **move**, which is how `Own<T>` returns legally too, and
the derivation rule is what keeps the moved-to location inside the extent.

#### Handles have no runtime representation

The three are **`distinct type` aliases over the resource**:

```zena
export distinct type Own<T> = T;
export distinct type Borrow<T> = T;
export distinct type Unmanaged<T> = T;
```

A `distinct type` is nominally distinct to the checker — `Own<Descriptor>`,
`Borrow<Descriptor>` and `Unmanaged<Descriptor>` are three different types —
while sharing its target's representation. So a handle costs no allocation and
no indirection, and all three lower to the same wasm type: a reference to the
resource. This is what makes `Borrow<i32>` and `i32` the same thing rather than
a special case, and what lets `disown` re-type an object without allocating a
new one.

It is also forced. As real classes the handles broke codegen outright: a
constructor typed `Own<Counter>` is a _different class_ from `Counter`, with a
different constructor arity.

#### Handles are not forgeable

Casting _into_ a `distinct type` is otherwise legal in Zena, which would make
the handles forgeable and the whole static guarantee decorative:

```zena
let forge = (b: Borrow<D>): Own<D> => b as Own<D>;      // two owners, so two drops
let promote = (u: Unmanaged<D>): Own<D> => u as Own<D>; // skips adopt()'s flag check
```

The first creates a second owner, so once implicit drop lands the resource is
released twice. The second bypasses the state-flag check that is the unmanaged
regime's only guard. Both defeat the guarantee outright rather than degrading to
a loud runtime error, which is the worse failure mode.

So **a cast to or from `Own`, `Borrow`, `Unmanaged` or `Scoped` is rejected
outside the `zena:ownership` library**, where `disown` and `adopt` live. Nothing legitimate
needs one: construction produces an `Own<R>`, `disown`/`adopt` change regime, and
`Own → Borrow` at a call site is an implicit coercion rather than a cast.

This is a special case of a general gap — see
[Blessed producers](#blessed-producers).

#### Where the runtime state lives

Because handles are erased, they have nowhere to store anything. Three
different things could be called "state", and only one of them is stored:

|                                                                  | Where                                                         | Notes                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Move state** — is this binding live or moved-from?             | **nowhere; compile time only**                                | This is what §"The branch-join rule" buys: a conditionally-moved value is uniformly dead at the merge, so no runtime drop flag is needed. A local holding an `Own<T>` is an ordinary wasm local holding a reference. |
| **The lifecycle flag** — `owned \| disowned \| moved \| dropped` | **a private field of the resource object**                    | It must be shared by every reference to that resource: an `Unmanaged<R>` alias and a later `adopt` have to observe the same flag, which only works if it lives on the object rather than on a handle.                |
| **The reference itself**                                         | a local, or a **frame field** after the generator/async split | A resource live across a suspension is stored in the state-machine frame; that is the reference moving, not new state.                                                                                               |

So a resource class carries its own state, and the ownership system adds no
per-handle storage anywhere. The one place per-frame runtime state may still be
needed is the `try`/`catch` case in §"Where the join rule does not reach", where
"was this initialized when we unwound?" is genuinely dynamic.

### Resource-ness and affineness are separate

`resource class` declares resource-ness. `Own<T>` declares affineness. They are
different properties and the distinction is load-bearing in two places.

**It determines where the declaration goes.** `Own<Descriptor>` claims to be
_the_ owning reference. That claim holds only because no unwrapped `Descriptor`
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
- **`Own<C>` where `C` is an ordinary class** — available only from a _provably
  exclusive source_: a fresh allocation, or an `Own<T>` moved in. Ambient
  aliasing means `Own<C>` and a bare `C` could otherwise name the same object,
  and the exclusivity claim would be false.

Same wrapper, same checking, one extra premise in the second case. This is what
[Parallelism](#parallelism) is built on.

<a id="resource-ness-is-inherited"></a>

### Resource-ness is inherited

A resource class's supertype chain is entirely resource classes. Both
directions of a mismatch are unsound, and in opposite ways.

**An ordinary subclass of a resource** has a spellable bare type. `class Sub
extends Descriptor` could be named, aliased and stored freely while naming an
object with a release obligation — the unwrapped form the resource rule exists
to prevent, reintroduced under a different name. Declare it `resource class
Sub` instead; that is the only difference the rule asks for.

**An ordinary superclass of a resource** is the subtler one, and the reason
this is a rule about the whole chain rather than about the subclass. Inside its
own methods, an ordinary class sees `this` as itself, and that type _is_
spellable:

```zena
class Plain { self(): Plain { return this; } }
resource class OnPlain extends Plain { … }

let r = new OnPlain();          // Own<OnPlain>
let leaked: Plain = r.self();   // bare, freely aliasable
```

The handle's nominal distinctness cannot help here. `Own<OnPlain>` is
assignable to nothing, but the leak does not go through the handle at all — it
happens inside `Plain`, below it, where the static type is an ordinary class
that knows nothing about resources. There is no local fix in `Plain`, which is
why the constraint has to be on the chain.

The same reasoning is why a `Resource` supertype is safe where an arbitrary one
is not: it declares no method that returns `this`, so there is nothing to leak
through. Code reuse that would otherwise want an ordinary base class goes
through composition, or through a mixin whose `on` clause admits resources —
where `this` is a borrow and the second-class rules apply.

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
same reason it is easy in Rust; it is returning a _borrow_ that is hard.

Consequently the loan pattern is not forced: `fs.open()` hands a descriptor back
rather than requiring `withFile(path, cb)`.

**The result need not be bound.** Discarding is permitted — that is what makes
this affine rather than linear — so `fs.open(path);` as a statement opens a
descriptor and releases it at the end of that statement, the temporary's extent.
That is safe but almost always a mistake, so an unused `Own<…>` result is a
**warning**, not an error. Making it an error would impose linearity at the
value level, which §"Affine types" rejects.

`Result<Own<T>, E>` costs nothing extra. `Result` is a type alias over an inline
multi-value union, so an owned handle rides in one lane of a multi-value return
and is destructured at the call site:

```zena
if (let (true, f, _) = fs.open(path, Flags.Read)) {
  // f : Own<Descriptor> — moved out of the return, live from here
}
```

### Borrowing

Borrows are bound to an extent and may not outlive it:

1. Legal only as parameter types and local bindings.
2. A function may return a borrow only when it derives from exactly one of its
   borrow parameters (see below).
3. A borrow may not be stored in an object, array, field, or closure capture.
4. Borrowing at a call site is implicit — `read(file)`, not `read(&file)`.

This is what removes the need for lifetime variables. It is a principled
position rather than a shortcut — see Osvald et al., _"Gentrification Gone Too
Far? Affordable 2nd-Class Values for Fun and (Co-)Effect"_ (OOPSLA 2016).

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

#### Borrows and suspension

An `async` or `gen` function's frame is a heap object that outlives the call,
so rule 3 already forbids a borrow reaching one. The precise rule is about
liveness rather than storage, because a borrow spilled into a frame and never
read again is harmless, while a borrow _read after_ a suspension is not — the
owner's scope may have ended and released the resource in between:

> **A `Borrow<T>` may not be live across a suspension point.**

That lands differently on the two constructs, because their ramps differ:

- **A generator may not take a borrow parameter at all.** Its ramp is lazy: it
  allocates the frame, spills the arguments and returns the `Iterator<T>`
  without running any body code. Every use of a borrow parameter therefore
  happens after the caller has taken the iterator, so there is no prefix in
  which the borrow is safe.
- **An async function may use a borrow parameter up to its first `await`.** Its
  ramp is _eager_: the body runs synchronously until the first suspension, and
  that prefix executes inside the caller's dynamic extent, where the owner is
  provably still alive.

Enforcement is on the checker flow graph. `await` and `yield` record a
`FlowSuspend` node; each read of a second-class binding in a suspending body
is collected and decided when the body's graph is complete (loop back edges
included): a suspension on any backward path from the read to the binding's
declaration — a parameter's extent begins at the body start — is the error,
and an assignment to the binding ends a path cleanly, exactly as in move
checking. The generator parameter ban is a flat signature check. The split
pass separately computes which values are live across suspensions to decide
frame fields; wiring that in as a cross-check remains open.

**Awaiting the call is not by itself sufficient.** `await read(file)` looks safe
— the caller suspends until the callee finishes, so the borrow's extent appears
to nest inside the owner's — but `let fut = read(file);` without awaiting hands
the caller a heap value that owns the borrow, and nothing stops it outliving
`file`.

#### Lifting the restriction: borrow-derived futures and iterators

The mechanism is **second-class-ness, not affineness**. `Own<Future<T>>` does
not help: owns are first-class and may be returned, stored in a field or moved
into a container, so an owned future still escapes the borrow's extent. What is
needed is that the future cannot outlive the borrow's extent.

§"Derived borrows" already provides it. A function with exactly one borrow
parameter may return a value derived from it, with extent equal to the caller's
borrow scope, and "a borrow of a place reachable from a borrowed value derives
from that value". A `Future` or `Iterator` holding a borrow _is_ a value
reachable from a borrowed value, so it inherits second-class-ness by the
existing rule:

```zena
async function read(f: Borrow<File>): Future<String>     // future derives from f

function lines(f: Borrow<File>): Iterator<String> {      // iterator derives from f
  return lineGen(f);
}

for (let line in lines(file)) { … }   // legal: the loop is inside f's extent
```

This is Rust's `impl Future + 'a` without the lifetime variable. It also
supplies most of the cancellation guarantee for free: a future that cannot
escape is dropped at the end of the borrow's extent, _before_ the owner's scope
ends, so the nesting is enforced structurally rather than by a cancellation
protocol. The residual is narrower than "settle cancellation first" — it is
whatever paths abandon a frame other than by scope exit (open question 4).

##### `Scoped<T>`: the fourth corner

Leaving the restriction implicit is not acceptable: if `Future<String>` is
escapable or not depending on whether the callee happened to take a borrow, a
reader cannot tell from the signature, and `let fut = read(file)` has no way to
carry the restriction to the checker.

**`Borrow<Future<String>>` is the wrong spelling**, on two counts. Nothing else
owns that future — it was created by the callee, while `Borrow<T>` means
temporary access to something another party owns. And a borrow _never releases_
what it points at, whereas a borrow-derived future must be dropped: releasing
its frame at the end of the extent is exactly what makes the nesting argument
work.

The reason no good spelling existed is that the universe table has four corners
and only three were named. A borrow-derived future or iterator owns a frame — so
it cannot be duplicated and must be dropped — _and_ cannot outlive its extent:

|              | Duplicate? | Outlive its extent? | Released?     |                        |
| ------------ | ---------- | ------------------- | ------------- | ---------------------- |
| Unrestricted | yes        | —                   | never         | ordinary values        |
| `Own<R>`     | **no**     | —                   | at scope exit | affine                 |
| `Borrow<R>`  | yes        | **no**              | never         | second-class           |
| `Scoped<T>`  | **no**     | **no**              | at scope exit | a borrow-derived frame |

`Scoped<T>` is returnable for the same reason `Borrow<T>` is: returning is a
move, and the derivation rule keeps the result inside the caller's borrow scope,
which is the extent it already belonged to. See §Handles.

So the signature is spelled:

```zena
async function read(f: Borrow<File>): Scoped<Future<String>>
```

Like the handles, `Scoped<T>` is a `distinct type` alias — erased, carrying
permissions rather than data — and gets the same one-directional coercion as
`Own<R>` → `Borrow<R>`: a first-class `Future<T>` is usable where a
`Scoped<Future<T>>` is expected, since dropping capability is safe, but never
the reverse.

**Naming risk.** `Borrow<R>` is also scoped — it occupies the other
no-escape corner — so `Scoped<T>` names the _axis_ rather than the corner it
occupies, and a reader may reasonably ask why `Borrow` is not spelled `Scoped`.
The two are genuinely different (one borrows another party's resource, one owns
a frame), but this should be renamed before `zena:ownership` has clients if it
reads badly.

##### Combinators: scopedness derives, and generics opt in

Naming the corner is not by itself enough to make `Future.all` work. Passing
`Scoped<Future<String>>` values means putting scoped values into an `Array`,
and storing a second-class value in a container is what escape _means_. Two
rules close it, both mirroring machinery this document already has:

**Scopedness derives structurally**, exactly as affineness does. Affine is
"`Own<R>`, and types containing one"; scoped is "`Scoped<T>`, and types
containing one". So `Array<Scoped<Future<T>>>` is itself scoped, with no
annotation — which makes storing a scoped value in it harmless, because the
container cannot escape either. This is the standard second-class relaxation:
second-class values may be stored in second-class structures.

**The combinator opts in**, exactly as containers opt into affine elements:

```zena
Future.all<scoped T>(futures: Array<T>): Future<Array<T>>
```

With `T = Scoped<Future<String>>`, `Array<T>` derives scoped and the returned
`Future<Array<T>>` derives scoped, so neither needs an annotation.

##### The two axes, side by side

`scoped T` is the escape-axis twin of [`affine T`](#affine-type-arguments):

| Axis            | Default      | Opt-in     | What the body gives up               |
| --------------- | ------------ | ---------- | ------------------------------------ |
| **Duplication** | unrestricted | `affine T` | may move a `T` at most once per path |
| **Extent**      | first-class  | `scoped T` | may not let a `T` outlive its extent |

Identical in shape: widening what a parameter accepts narrows what its body may
do, both derive structurally through containing types, and both default to the
permissive case so existing code is unaffected. They compose — `<affine scoped
T>` for a fully restricted parameter — and the motivating case needs the
combination, since a `Scoped<Future<T>>` is both affine (it owns a frame) and
scoped.

Costs, so this does not read as free:

- **Vocabulary growth.** A fourth type constructor and a second type-parameter
  modifier, in a design that had settled on three handles and one modifier.
- **Every combinator that should accept scoped values needs `<scoped T>`** —
  `Future.all`, and the iterator adapters `map`/`filter`/`take`. One modifier
  each, but it is a real audit.
- **Two borrow parameters** hit the ambiguity in §"Derived borrows" — the same
  decision, not a new one.
- **The rule must survive the split pass**, since the future or iterator _is_
  the frame: "derives from a borrow" has to propagate into frame typing.

Ship the liveness rule first; this relaxation is the natural follow-on.

#### Value types, containers, and slot references

Data-oriented layouts — a `MultiList` holding values struct-of-arrays, an
arena-backed buffer — raise a case the garbage collector cannot help with: a
"reference" to an element that is not itself a GC object, but whose backing
storage must outlive it.

Second-class borrows are the answer, and they are a better one than GC tracking
here. **An element reference is a borrow derived from the container**, per the
projection rule in §"Derived borrows", and its safety comes from the static
extent rather than from reachability: it cannot outlive the container because it
cannot escape the scope that borrowed the container. No tracing, no fat pointer,
no pinning. The alternative — making an element reference a GC reference to the
backing array plus an index — reintroduces exactly the per-element cost that a
struct-of-arrays layout exists to remove.

**Arenas are the same shape**, which is why §"Linear memory and FFI" recommends
the region rather than the pointer as the unit of ownership. An arena is never
freed per allocation; it is freed as a unit. So per-object ownership is the
wrong granularity: one `Own<Arena>`, N borrows into it, and every borrow is
statically dead before the arena drops. That is also why arena allocation is
fast — no per-object bookkeeping and no per-object drop.

Whether the container needs ownership at all depends on what backs it:

| Container                              | Ownership                               | Element references                 |
| -------------------------------------- | --------------------------------------- | ---------------------------------- |
| GC-backed (`MultiList` over GC arrays) | none needed                             | borrows derived from the container |
| Arena- or linear-memory-backed         | `Own<Arena>`, released by implicit drop | borrows derived from the container |

**The guarantee is the inverse of "keep alive while referenced".** A second-class
borrow cannot outlive its container; it does not extend the container's life.
Container lifetime is declared by a scope and references are forced to fit inside
it. Reachability semantics — keep the backing alive as long as anything points
at it — is refcounting or a GC-tracked fat reference, and costs per element what
this layout is trying to save.

**Open — a wrinkle in the identity rule below.** `Borrow<T> ≡ T` at unrestricted
instantiations is justified by "an unrestricted `T` has no owner to outlive". A
`MultiList` element breaks that: `Point` is unrestricted, but a reference to the
_slot_ very much has an owner to outlive. Two different things are being called a
borrow:

|                                                                               | Outlives the container?   | Second-class?                         |
| ----------------------------------------------------------------------------- | ------------------------- | ------------------------------------- |
| Reading an element **by value** (a copy)                                      | irrelevant — it is a copy | no; the identity rule holds           |
| A reference to the **slot** — mutate in place, or avoid copying a large value | must not                  | **yes**, whether or not `T` is affine |

So second-class-ness attaches to the _derivation_, not to whether `T` is affine
— which is what §"Derived borrows" already says, and what the identity rule
below contradicts for place references. Resolving it needs either a separate
spelling for a slot reference or a qualification on the identity rule.

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

Inside a generic body the restrictions _do_ apply, because the body is checked
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

The flag is an ordinary private field on `Resource`, the root class every
resource class extends, read and written through symbol-keyed accessors on an
unexported interface — so no code outside `zena:ownership` can name them, and
in particular nothing else can move a resource between regimes. It has to live
on the object rather than the handle because the handles are erased — see
§"Where the runtime state lives".

Both functions are bounded — `disown<T extends Resource>` — so their domain is
exactly the classes that inherit the field. Moving between the two regimes is
only meaningful for something carrying a release obligation, so the bound also
says something true: an ordinary class under `Own<C>` has no disposal duty to
hand over. See §"`Resource` as a marker interface" for why this is a bound as
well as a supertype.

Two racing adopters therefore do not double-free — the loser gets a clear error.
What entering `Unmanaged<T>` gives up is **leak-freedom** and _compile-time_
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
using raw = disown(f);   // deterministic release at scope exit
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
return, `break`/`continue`, and exception unwind — exactly what a
`try`/`finally` wrapping the rest of the block would do. It compiles to the
same protected region `finally` compiles to; there is no source-level rewrite,
so the AST a `using` produces is a `using`.

**`using` declares the binding itself** — there is no `let` or `var` in front
of the name. It could not declare a mutable one: the release targets the value
bound at the declaration, so a rebound name would release a stale value and
leak the new one. Every language with the construct lands in the same place —
C#'s using variable is read-only, Java's try-with-resources resource is
implicitly final, JavaScript's `using` binding cannot be assigned to. With no
mutability to choose, `let` would be a keyword that never varies, so both
`using let x = …` and `using var x = …` are rejected rather than accepted as
synonyms.

A binding is optional. `using _ = foo()` is a workaround for a syntax gap in
other languages and should not be inherited; `using` is a keyword, so a bare
expression form is unambiguous — a name followed by `=` or `:` binds, anything
else is the expression form:

```zena
using acquire(lock);        // scope-bound, nothing to name
using file = open(path);    // bound
```

It composes with refutable pattern conditions as a binding modifier. The `let`
is back here, and is not an inconsistency: in the statement form `using` IS the
declaration keyword, while here it modifies the `let`-condition the language
already has, which is what supplies the pattern.

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

#### Nullable operands

`using` accepts a `T | null` operand — the shape every fallible acquire
returns — by requiring `[Disposable.dispose]` of the non-null member and skipping
the release when the value is null at scope exit, the rule TC39's
`using` established. The skip is a runtime `ref.is_null` guard around
the one dispose in the shared finally region, and it also guards every
value carried in an abstract reference (`eqref`/`anyref`), which admits
null whatever the static type says. A statically null initializer is
rejected outright — a `using` that can never release anything is a
mistake, not a degenerate case.

#### Union operands

Same-handle unions normalize at union creation: `Own<A> | Own<B>` IS
`Own<A | B>` — the handles are erased, so the two spellings denote the
same values carrying the same single release obligation, and one
canonical form keeps release, drop candidacy and assignability
single-path. The union spelling is legal directly (`Own<A | B>`: the
members are named inside a handle, so the bare-mention rule admits
them), a narrower owner widens into the union owner, and `using` and
implicit drop both release one by testing each member class in turn
and dispatching to the dynamic member's `[Disposable.dispose]` — overridden
disposes still dispatch virtually inside each arm. A union of plain
`Disposable` classes releases the same way.

The restriction that remains is the honest one: handles of different
names never merge (`Own<A> | Borrow<B>` arms carry different
obligations, and such a union has no single release path), and a
`Borrow` union is second-class when ANY member restricts — `Borrow<A> |
Borrow<String>` normalizes to `Borrow<A | String>` and the `A` arm's
restriction survives the merge. The same distributivity is NOT sound
for nominal generics: `Future<i32> | Future<String>` are different
monomorphized structs with identity, and `Array` adds the covariant
mutable-container problem — so normalization is handle-only, not a
general algebra.

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
must retain _where_ the collapse happened, so the message reads "`f` was moved on
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
  resumed. "Which owns are live in state _k_" is a per-state table, not a
  lexical list. Borrows have the mirror-image problem — see
  [Borrows and suspension](#borrows-and-suspension).

#### Landed: moves on the flow graph

Move checking for local bindings is implemented on the checker flow graph.
A move appends a flow node the same way an assignment does, at four sites:
an identifier argument handed to an `Own` parameter (which is also what
makes `disown` consume), an initializer or assignment whose target type is
an `Own` handle (rebinding, field stores, `using`), and an access that
reaches a `this: Own<this>` method through an owned binding. A use of an
owned binding walks backward over every path: a live move is the error, an
assignment to the binding revives it, and a moving branch that diverges
never reaches the join — the branch-join rule above, in detection form.
Compensating drops are still implicit drop's (O3). The loop rule is
implemented as specified: at loop exit, a move of a binding declared
outside the loop that is not reinitialized on every path to the back edge
is reported, with no fixpoint. Moves inside a `try` body feed the catch
entry, so a `catch` that uses a maybe-moved binding errors — the meet over
the body, conservatively.

The checker follows local bindings only. Not tracked: an `Own` reached
through a field or an aggregate ("types containing one" affine-ness is
future work) and a captured binding moved inside a closure. The runtime
lifecycle flag remains the guard on those routes —
`execution/ownership/lifecycle-flag.zena` reaches its double `disown`
through a field for exactly this reason. Super-initializer arguments are
checked against the superclass constructor's parameter types like any
other call, and an `Own` parameter there moves its argument; the
constructor prologue is checked in evaluation order (initializer list,
then super, then body) so the flow graph sees the move where it happens.

### Implicit drop

Inserting `dispose()` when an owned value leaves scope unmoved is what turns
affine (_at most_ once) into leak-free. Four parts:

**Landed: the scope-exit half, and the branch-join rule for `if`.** A
simple-`let` `Own<resource>` binding that nothing moves, reassigns,
captures or escapes is released at its block's exit — normal completion,
`return`, `break`/`continue`, and unwind — through the same shared finally
region `using` compiles to, in reverse declaration order via the regions'
nesting. `Own<resource> | null` qualifies too, with the same null-skipping
guard as nullable `using` (except a binding initialized to literal null,
which can never hold anything to release). The checker decides per declaration (`exitOwnScope`; a use
position must be affirmatively classified as a borrow, so anything
unrecognized leaves the binding alone and leaks as before) and records the
verdict in `SemanticModel.scopeExitDrops`; lowering routes a flagged
declaration into `lowerScopeDropRegion`, `using`'s twin.

The branch-join rule is implemented for `if`/`else` and for `match`: a
candidate moved on some arms and kept on others gets a compensating drop
at the end of each reachable arm that kept it — a plain call on that
edge, no region — recorded in `SemanticModel.edgeDrops` (an if's entries
name a side, a match's the case index) and decided when the enclosing
scope closes, where the capture and escape facts are complete. The
arm-end flow nodes recorded per `if` and per `match` are what let the
decision ask, per binding, on which arms a move lies; nesting composes
because an inner construct's compensation makes the binding definitely
dead at its own merge. A diverging arm needs no compensation, which is
what keeps the conditional-handoff shape working — in both constructs.

**Owned parameters release too.** A function's `Own<resource>`
parameter that the body never moves, captures or escapes is released
at function exit — the function received ownership, so the function
releases; this is the callee's half of a move, and what makes
`consume(r)` leak-free without the callee writing anything. The same
verdict machinery decides (a parameter is a candidate in the body's
own scope, branch-join compensation included), and lowering wraps the
whole body in the shared finally regions, first parameter outermost so
release order is the reverse of declaration. An expression body is
spelled as a one-statement list first — a `return` when the function
produces a value, so the value computes inside the region, before the
release; a body that returns the parameter itself is a use the
classifier does not affirm, so ownership flows out unreleased, to the
caller. Excluded: constructors (their owned parameters feed fields and
the super call, which are checked outside the body block), suspending
bodies, the receiver, and `this.x` field parameters.

**Value-producing blocks release too.** A `using` or implicit-drop
binding in a `match` or `if` arm whose tail supplies the arm's value
scopes the rest of the block, tail included: the value computes inside
the release region and rides the region's result variable out through
the dispatch — the same carriage a valued `try`/`finally` uses — so
the release runs after the value is read and on every early exit and
unwind.

**Async bodies release too.** The release regions spill their state
into the frame and catch the cancel tag as well as the error tag, so an
owned local or parameter in an `async` body releases across
suspensions, on a failure surfacing at a resume point, on early
returns, and on cancellation — lifting the gate needed no lowering
work, only the checker's candidacy. Async expression bodies stay out
(their lowering completes the frame's future before the parameter
regions exist).

**Generator bodies release too**, now that disposal exists
(cancellation.md §"Abandonment and generator disposal"): a full run
releases at scope exit like any body, and a consumer that stops early
disposes the iterator, which cancels the frame at its suspended yield
and unwinds through the same regions. With that, the release story is
complete: every body form — blocks, value blocks, expression bodies,
async, generators — releases owned locals and parameters.
`execution/ownership/implicit-drop.zena`, `match-arm-drops.zena`,
`param-drops.zena`, `param-drops-expr.zena`, `value-block-release.zena`,
`async-implicit-drop.zena` and `gen-implicit-drop.zena` pin the
behavior; the release-timing note now lives in the language reference.

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

<a id="affine-fields"></a>

### Affine fields

Storing an `Own<T>` in a field is one of the moves §Affine types lists, and
the universe table already places "types containing one" in the affine
universe. This section pins what that containment means for the class that
declares the field, for reads and writes of it, and for release. None of it
is enforced today: an `Own` field in a plain class is silently legal, the
object aliases freely, and the only guard on the loose obligation is the
runtime lifecycle flag.

**Containment is an obligation, so the container is a resource.** A class
value is a reference, and duplicating the reference does not duplicate the
field's obligation — the hazard is aliasing: two references to the object,
each positioned to move the field out, or one outliving the release. An
object's affineness is enforceable only if every reference to it is
governed, and that is exactly what resource-ness provides — and, per
§"Resource-ness and affineness are separate", it can only be provided at the
class, uniformly across every mention. So the rule:

> **A concrete field of affine type is legal only in a `resource class`.**

"Affine type" is decided by **containment, not spelling**: the check walks
every union member and pierces distinct aliases, so `Own<R> | String` and
`distinct type Token = Own<R>` are caught carrying an owner exactly as
`Own<R>` is. Detection being general is what keeps the rule independent of
how the formation rules for owner-containing types loosen later — a new way
to build such a type does not need a matching update here. Support is
narrower than detection, deliberately: the shapes reads and glue handle are
`Own<R>` and `Own<R> | null`, and a field carrying an owner in any other
shape is an error naming those, rather than a silently loose obligation. A
plain class declaring any owner-carrying field is an error that names the
fix. There is no affine-but-not-resource category for such a class: it has
something to release — the field — so resource-ness is the honest
description, and every piece of existing machinery applies transitively.
Construction yields `Own<C>`, mentions go through handles, implicit drop
and `using` release the object, and releasing the object releases its
fields (glue below).

**Borrow fields stay rejected, and that is forced rather than
provisional.** A field lives in the heap and outlives any extent, so a
borrow in one has outlived its lender — the second-class storage rule fires
on every field, resource class or not. The derived-borrow _object_ — a view
holding a borrow plus derived state, built by a function that maps one
borrow to another — is real, and it is the scoped-class future rather than
an exception here: scopedness derives structurally exactly as affineness
does, so a class containing second-class members would itself be
second-class, its constructor's result deriving its extent from its borrow
arguments the way a returned borrow derives from a borrow parameter today.
Nothing in this section forecloses that; it arrives with `scoped T`
(§"The two axes, side by side").

**Extent is transitive; no scope is declared.** An owner carries its extent
with it, so ownership forms a tree — field to object, object to whichever
handle holds it — and every path is grounded in a binding the release
machinery already covers: a local, a parameter, a frame slot of a suspended
body, or another resource's field. `disown` remains the deliberate exit into
the unmanaged regime. A module-level `Own` binding is legal and never
implicitly released: its extent is the whole program, and teardown has
nothing to run.

**Reads borrow; consuming methods move out.** A read of an affine field
(`r.file`, `this.file`) yields `Borrow<R>` — a read must not mint a second
owner. This is §"Derived borrows" field projection applied to the receiver.
Inside a consuming method (`this: Own<this>`, `[Disposable.dispose]` above
all) a field
may instead be moved out, at most once per field per path, checked by the
same flow machinery that move-checks locals — the `this.file` path keys
exist. A `var` affine field may be overwritten, and the store releases the
previous value first; a `let` affine field is set once, in construction.

**Release is glue after `[Disposable.dispose]`, and the dispose itself may
be implicit.** A class whose only release action is its fields writes no
dispose at all: the compiler synthesizes one whose whole body is the
field glue, which is what satisfies the resource contract — the fields
ARE the release action, so holding owners costs no ceremony. A written
dispose runs first, and the compiler appends releases for every affine
field it did not move out, in reverse declaration order — the same
compensation shape implicit drop applies to locals. A dispose that needs
a different order moves the fields out and releases them itself, and the
glue then has nothing left to do. The one case that still requires
writing something is a subclass with owner fields under an _inherited_
dispose: an override does not chain to the superclass's automatically,
so how the two compose is the subclass's decision, and the override
(possibly empty) is where it is written down.

**Structural types reject affine members.** A record or tuple member of
affine type is an error: structural values convert by adaptation,
adaptation copies, and a copy would duplicate the obligation — and there is
no dispose slot to hang glue on. This is the affine twin of the
second-class storage rule: borrows are rejected from structural types for
extent reasons, owns for duplication reasons.

**Generic fields are the other half, and defer to `affine T`.**
`class Box<affine T> { var value: T }` stays an ordinary class; the
_instantiation_ `Box<Own<File>>` is affine by "types containing one" and is
held from a provably exclusive source under `Resource<T>` (§Containers),
with glue derived per instantiation by monomorphization. A concrete field
needs the class-level rule because its affineness is unconditional; a
generic field earns it per instantiation. Whether `Resource<T>` and
`Own<T>` are one type spelled two ways is the open question §Containers
records, and nothing here forecloses it.

Implementation stages, in order: the field rule with reads-as-borrows and
dispose glue; consuming-method move-out with per-field path checking; then
`affine T` and the container work, which waits on member-level `where`
bounds (equality.md D4).

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

`affine T` governs the duplication axis. Its twin on the escape axis is `scoped
T` — see §"The two axes, side by side". They compose: `<affine scoped T>` is a
parameter that may be both.

Three things that need no opt-in, because they are the common cases:

- **Not using a `T`.** `<affine T>(x: T): void => {}` needs no bound; implicit
  drop releases `x`, and monomorphization emits that glue only for instantiations
  where `T` is actually affine.
- **Using it once per _path_**, across branches. `HashMap.[]=` moves `key` and
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

| Code                         | Needs                                                                                           | Opaque `Ptr<T>` sufficient?                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Canonical ABI marshaling     | load/store at statically known offsets; element `i` of a known stride                           | **Yes** — typed accessors, `p.loadU32(offset)`, `p.elem(i)`, not arithmetic |
| Foreign struct walking (FFI) | offsets from a foreign layout                                                                   | **Yes**, given a declared layout to generate accessors from                 |
| The allocator itself         | genuine arithmetic — `FreeListAllocator` threads free-list `next` pointers through freed blocks | **No**                                                                      |

So arbitrary pointer arithmetic is needed to _implement_ the allocator, not to
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

| concurrency.md                      | Here                    | Note                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolated<T>`                       | `Own<T>`                | Unique, transferable, move-on-transfer — the same type. `isolated` is a thread-specific name for a general property.                                                                                            |
| `borrow child` (scoped, exclusive)  | `BorrowMut<T>`          | The same exclusive borrow; `parallel.scope` is a second-class borrow with a wider frame.                                                                                                                        |
| `share treeRef` (scoped, read-only) | `Borrow<T>`             | Shared immutable borrow.                                                                                                                                                                                        |
| `frozen<T>`                         | _no equivalent_         | Genuinely additional: deep immutability is about transitive reachability, not uniqueness, and is what makes a value safely _shareable_ rather than merely borrowable. Keep it, defined against this vocabulary. |
| regions                             | region-as-affine-handle | The same idea as linear memory's regions, above.                                                                                                                                                                |

This is the main consumer of `Own<C>` over ordinary classes: a data structure
handed to another thread has nothing to release, but must not be aliased once
transferred.

---

<a id="the-checker-flow-graph"></a>

## The checker flow graph

Move checking is flow-sensitive with merges and loops. Before the graph
landed (see §Landed below) that analysis did not exist: the checker had a
lexically-scoped narrowing stack and ad-hoc `definitelyExits` recursion,
and nothing invalidated a narrowing on assignment. Building it is the real
cost of move checking, and it is reusable well beyond ownership.

**A flow graph, not a new IR.** TypeScript — the language Zena is shaped like —
does full flow-sensitive narrowing with joins and loops and no IR: its binder
attaches _flow nodes_ to AST nodes (labels with antecedents for joins, condition
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
lexically-scoped stack, and before the graph nothing invalidated an entry
on assignment, which was unsound:

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

`zena check` reported nothing; running it failed with `dereferencing a
null pointer`. The assignment-aware flow graph rejects it — the class of
bug is structurally impossible rather than patched case by case.
`semantics/type-narrowing/assignment_invalidates_narrowing.zena` carries
this example and its variants.

### Landed: the graph, and narrowing on it

The checker builds the graph as it walks. `analysis/flow.zena` holds the
nodes — start, assignment, join, unreachable — and the checker advances a
current-flow pointer at each construct: assignments append, branches fork
and join, loops get a header whose back edge is wired after the body,
`break`/`continue` edge to the loop's exit and header, `match` arms fork
from the discriminant, `&&`/`||`/`??` join their conditional operand with
the skip path, and a `try` body's assignments feed the catch entry. Each
body gets a fresh start node, saved and restored around nested functions
the way return context is.

Narrowing is assignment-aware by construction: an assignment on any
path re-types the binding to what it stored, so a narrowing an
assignment no longer satisfies is simply not the type the walk
computes. A member-path narrowing dies with any assignment to its root
binding. Because a loop body is checked before its back edge exists,
entering a loop pre-scans it for assigned symbols and records them at
the header as unknown-type stores; the guard's own narrowing sits after
the header, so `while (x != null)` still narrows its body while a
narrowing carried in from outside dies where it should.

Condition narrowing is computed on the graph. The lexical
narrowing stack is gone: each branch entry attaches a node carrying the
maps the condition engine produced for it, and a reference's type is the
declared type refined by a backward walk — the nearest narrowing that
mentions the binding or path, an assignment's stored type, unions at
joins. That one change is what made these uniform:

- The if-expression narrows exactly as the if-statement does, `&&`
  chains included; the duplicated single-guard logic it carried is
  deleted.
- `while` and `for` conditions narrow through the full engine (compound
  conditions included), and leaving a loop normally applies the
  condition's inverse — `while (x == null) { … }` proves `x` non-null
  after.
- An assignment narrows to what it stored, which subsumes the
  hand-rolled `if (x == null) { x = value; }` analysis. Structural
  types are the exception: a record is stored adapted, so it keeps the
  declared type.
- A branch that cannot complete — `return`, `throw`, a call typed
  `never` — drops out of the join, so inverse narrowing after an
  early exit needs no special case.

Two deliberate meets at joins: a result is clamped to the declared type
(a statically-false `x == null` arm would otherwise widen a
non-nullable binding to `T | null` through the union), and two distinct
narrowings meeting (an `is A` arm and an `is B` arm whose `else`
diverged) merge to the declared type, because member lookup cannot see
through a union of subclasses.

Still hand-rolled: `definitelyExits` and unreachable-code reporting.
Not covered: a `var` captured and assigned by a closure
([#111](https://github.com/elematic/zena/issues/111)).

### Narrowing mutable fields

Narrowing a mutable class field is refused outright today: the immutable-path
check requires every field in the path to be declared immutable, so `var #x: Foo
| null` can never narrow. That is a deliberate soundness choice given that
nothing currently invalidates a narrowing.

A flow graph is **necessary** to lift it, since lifting it means knowing where
the path is assigned. It is **not sufficient**: the hard part is not assignment
but _reachable_ assignment, because any call between the guard and the use might
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

The checker decides _legality_ and records drop obligations into `SemanticModel`
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

|          | Work                                                                                                      | Needs                             | Independent of |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| **O0**   | `resource class`, `zena:ownership` (`Own`/`Borrow`/`Unmanaged`/`Disposable`), `disown`/`adopt`, drop glue | nothing                           | everything     |
| **O0.1** | Receiver types (`this: Own<this>`), so release can consume                                                | O0                                | everything     |
| **O0.5** | `using` + scope-exit cleanup lowering                                                                     | O0                                | everything     |
| **O1**   | Checker flow graph                                                                                        | nothing                           | everything     |
| **O2**   | Move checking on the flow graph                                                                           | O0, O1                            | G, V, A        |
| **O3**   | Implicit drop                                                                                             | O2; G1 for the cancellation table | V, A           |
| **O3.2** | Affine fields: the resource-class rule, reads borrow, dispose glue                                        | O3                                | V, A           |
| **O3.5** | `affine T` type parameters + container opt-in                                                             | O2, A0's `where` bounds           | G, V           |
| **O4**   | `isolated<T>`/`frozen<T>`/regions                                                                         | O2                                | V, A           |

Implementation currently trails this document in three known places:
`Scoped<T>` is design-only, the
`dropped` state is declared but never set — the implicit-drop and `using`
release glue calls `[Disposable.dispose]()` without touching the flag, so
adopting an
already-released resource is not the clean error it is specified to be —
and the liveness rule in §"Borrows and suspension" is unenforced, so a
borrow may still be held across an `await` and a generator may still take a
borrow parameter.

**`using` is implemented, and it is where the scope-exit lowering lives.**
Both forms parse, the checker requires the value to carry
`[Disposable.dispose]()` — by member key rather than by nominal conformance,
so a `using` needs no import —
and lowering releases on every path out of the enclosing block: falling off the
end, `return`, `break`/`continue`, and exception unwind. Several bindings in one
block nest, which gives reverse declaration order without a list to reverse, and
a returned value is computed before anything is released.

**The release IS a `finally`, and shares its lowering.** The sharing is at
lowering, not in the source: `lowerTryFinally` is split into a reusable region
and a thin `try` wrapper, and `using` supplies the other two pieces — the
protected part is the rest of the block, the finalizer is the dispose call. No
`TryExpression` is synthesized and nothing rewrites the AST, so the tree a
`using` produces is a `using`, and diagnostics and the language service see
what was written.

That is deliberate rather than incidental. A synthesized `try`/`finally` would
have to name `Disposable` to spell the release, and `zena:ownership` is out of
the prelude, so it would make every `using` import-dependent — the same reason
the checker matches `[Disposable.dispose]()` by member key.

The region both reach: the release is emitted **once**, in a dispatch block
outside the region, and normal completion, the handler edge, and each
`return`/`break`/`continue` leaving the region park an exit code and branch
there, to be replayed after the release has run.

One copy outside the region is a correctness requirement, not a size choice.
A copy on the normal path would sit _inside_ the region, so a `dispose` that
threw would land in its own handler and release a second time.
[`Disposable`](#disposable) says implementations must not throw, but nothing
enforces that, and the shape does not depend on it —
`execution/ownership/using.zena` pins the throwing case.

Sharing the mechanism is also what makes nesting work without new rules: an
exit replayed at one dispatch re-enters the scope list truncated, so nested
releases run inside-out, and a `using` and a `try`/`finally` nest through each
other for free.

That is the machinery O3 reuses. What O3 adds is not new codegen but new
_obligations_: the releases an implicit drop contributes come from move
checking rather than from a `using` the programmer wrote.

A `using` (or an implicit-drop binding) inside a value-producing block — a
`match` or `if` arm whose tail expression supplies the arm's value — opens
the same region with the region's result variable carrying the tail's value
out through the dispatch, exactly as a valued `try`/`finally` does: the
value computes inside the region, before the release. A function body's
value tail takes the other spelling, lowering where a `return` would go.

**Second-class-ness is enforced.** A `Borrow<R>` may not be captured by a
closure, may not be a field's type, a container's element type, a record
field or a tuple element, and may not be returned unless it derives from
exactly one borrow the function was handed. The two-or-more case in
§"Derived borrows" is rejected rather than resolved; naming the source
positionally is still open.

**`this` inside a resource's methods is a `Borrow<R>` unless the method says
otherwise**, which is what points those rules at the receiver. It has to be
_some_ handle — a resource has no
unwrapped form, so a bare `this` is a reference the handle regime cannot see
— and `Own<R>` would be wrong, since the method did not receive ownership and
must not release or move its receiver. So a method's receiver is the one
borrow it was handed: `self(): Borrow<R> { return this; }` derives from it and
is legal, while capturing `this` in a closure, storing it in a container, or
passing it where an `Own<R>` is expected are all rejected. Capture needed its
own check, because `this` is captured as a receiver rather than as a captured
symbol and the symbol-keyed rule cannot see it.

**Saying otherwise is what O0.1 adds.** A method may declare its receiver as
its first parameter — `intoFd(this: Own<this>, scale: i32): i32` — and `this`
in its body is then the owner, free to be moved on to something that takes
ownership. The declaration is not a parameter: the receiver is implicit in
every method already, so it is kept out of the parameter list rather than
shifting every argument's position, and it lowers to nothing, since the
handles are erased.

Only `Own<this>` and `Borrow<this>` are receivers, and only on a resource
class's instance method. `this` rather than the class written out is
load-bearing under inheritance, as §"Release consumes its receiver" gives it;
an ordinary class has no owning handle a caller could produce, so a receiver
declared there could never be satisfied; and `Unmanaged<this>` is excluded for
the reason `Unmanaged<R>` has no user-callable dispose — it is not an owner. A
receiver is a class-member form, so an interface signature cannot declare one,
which is the parse-level half of one interface signature not serving both
populations.

What the declaration buys is enforced at the call: **a consuming method is
reachable only through an `Own<R>`**. Calling `dispose` on a `Borrow<R>` or an
`Unmanaged<R>` is an error, and so is a borrowing method releasing its own
receiver, since its `this` is a borrow like any other. That check holds
before move checking does — the call is rejected on the handle's type, not on
what a flow graph knows about it. An override may not change the receiver it
inherits in either direction: a call through the base type must do the same
thing to the object whichever override it reaches.

A resource class's release action must therefore be the consuming form, which
is the contract §Resource states. The caller's side is move checking's: after
`d.[Disposable.dispose]()` the binding `d` is moved-from, and a later use is
an error — the same rule that makes `disown` consume its argument. See
§"Landed: moves on the flow graph".

The rules follow §"`Borrow<T>` is the identity at unrestricted
instantiations": they apply to a borrow of a resource or of a bare type
parameter, and not at all to `Borrow<i32>`. Storage is checked on the
_type_ rather than on each assignment — once `Borrow<R>` cannot be a field's
type or an element type there is no location left to hold one, so the stores
that never name the type, like `xs.push(f)`, need no flow analysis to find.

One gap remains, and it is the one §"Combinators: scopedness derives, and
generics opt in" already describes: a generic container reaches that storage
without naming a borrow, since `box<T>(x: T): FixedArray<T>` is checked with
`T` unbound and the call binds `T` to a borrow afterwards. Closing it is the
`scoped T` opt-in, deferred there by name;
`semantics/ownership/borrow-is-not-stored.zena` carries it as a
`@missing-error` so implementing the opt-in retires the marker.

The lifecycle flag itself is landed, so `adopt` does reject a second adopter
and `disown` a second disowner. It is a private `i32` on `Resource`, the root
every resource class extends, reached through symbol-keyed accessors that are
not exported.

That shape is what removed the machinery an earlier version needed. When
`Resource` was a marker interface the flag had to be a struct field codegen
injected, reached from `disown`/`adopt` through two intrinsics — a generic
body cannot name a member only some instantiations have. A bound can: with
`T extends Resource` the member is nameable in the generic body, so the
intrinsics, the injection pass and the constant-fold for a flagless `T` all
went away, and the set of classes carrying a flag is the set the bound admits
by construction rather than by coincidence.

One wrinkle survives, and it is not specific to ownership: RTA emits an
erased `anyref` specialization of an exported generic, and a method call on a
type parameter cannot lower there. So the state accessors are reached through
small **non-generic** helpers over `Borrow<Resource>` rather than called
directly on `T`. The same constraint is why an exported generic function
cannot call `hash`/`==` on its type parameter today.

**O0 unblocks the most.** The whole handle lattice ships there with runtime-only
enforcement of move discipline, which freezes the _signatures_ immediately:
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

Two different proposals travel under this name, and they have opposite answers.

**As a bound, it is right — and it ends up being a base class.** `Resource`
is the root every `resource class` extends, and `disown`/`adopt` take a
`T extends Resource`. A base class beats an interface here for two reasons
that only became clear once the flag needed a home. It gives the flag an
ordinary in-language field instead of one codegen injects, and the accessors
ordinary methods instead of intrinsics. And single inheritance makes
§"Resource-ness is inherited" structural rather than a check: a resource
already has a root, so it cannot also extend an ordinary class.

The thing an interface would have offered — anyone can implement it — is
exactly what is not wanted. `resource` stays the only door in.

**As a replacement for the modifier, it does not work.** `resource` is not
only a claim about a class's members; it changes how construction types its
result. `new Descriptor(…)` yields an `Own<Descriptor>`, and the bare class
name is not a spellable type at all. Neither follows from having a supertype:
inheriting does not change what `new` gives you, and a spellable type does not
stop being spellable because it gained a base class. The modifier is a
declaration-site rule about construction; the supertype is a claim about
membership in a set. Only the second is something a bound needs — which is
why `Resource` is both, and why the compiler inserts it rather than asking
authors to write `extends Resource` themselves.

This section previously argued the stronger claim that a `Resource` interface
would let affineness leak out through an upcast — `let x: Disposable = d`
where `d: Own<Descriptor>`. **That argument is wrong**, and it is worth
recording why, because the mistake is instructive.

The upcast does not typecheck, and never did. `Own<T>` is a distinct type
alias, and a distinct alias is assignable only to the same-named distinct
alias — not to its own target, and so not to any supertype of that target. To
launder, you would first need a value of type `Descriptor`, which the
resource-class rule makes unspellable. Neither step involves interfaces.

More generally, an interface is not a special channel. Every reference type
has supertypes; `let x: anyref = d` is the same escape with none of the
machinery. What prevents all of them at once is the handle's nominal
distinctness, and later the move rules that assignment of an `Own` must obey
in any case. A design that closes the interface route and leaves the others
open has not closed anything.

The bound also never touches this question, because it constrains `T` rather
than `Own<T>`. In `disown<T extends Resource>(value: Own<T>)` the inferred `T`
is the bare class — a type the checker names internally and the user cannot
write. The interface is never a target of assignment, and in fact nothing is
assignable to it: `Resource` is inhabited by no expression.

`Hashable` is the precedent, not a counterexample. It is a real interface with
a special satisfaction rule in the checker, constraining _type arguments_
without changing the rules governing values of the type — which is exactly the
job here. `resource` conforming to `Resource` without an `implements` clause
is the same arrangement as a case class conforming to `Hashable`.

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

If an HIR later proves necessary, the more natural move is to push ZIR _earlier_
— making the checked representation and the optimizer's representation the same
thing — rather than adding a third IR.

---

<a id="should-release-consume-its-receiver"></a>

### Release consumes its receiver

A resource's release action ends the object's life, so it is declared with a
consuming receiver:

```zena
resource class Descriptor {
  [Disposable.dispose](this: Own<this>): void { __wasi_descriptor_drop(this.#handle); }
}
```

`this` is already a type in Zena — `Array.map` takes `seq: this` — and
`Own<this>` is what makes the receiver correct under inheritance: on a subclass
it means `Own<Subclass>`, which a written-out `Own<Descriptor>` would not give.

The payoff is concrete. With a _borrowing_ receiver, an explicit `d.dispose()`
leaves `d` live, so the compiler still inserts a drop at scope exit and release
runs twice — idempotence makes that safe, but it is a wasted call and "I
released early" is not something the type system knows. With a consuming
receiver the call moves `d`: no drop is inserted, and any later use is a compile
error rather than a runtime flag check.

**There is no legitimate dispose-then-use.** After release the resource is dead,
and catching that is the point. A caller who genuinely needs a reference to
survive release can `disown` first: the resulting `Unmanaged<R>` stays valid as
a reference, its flag reads `dropped`, and later uses are runtime errors. That
is exactly the trade of entering the unmanaged regime, so it needs no special
provision.

**`Unmanaged<R>` has no user-callable dispose.** It cannot call the consuming
form — it is not an owner — and giving it a second, borrowing form would mean
overloading on the receiver. Instead, once disowned a resource is either scoped
with `using` or adopted back:

```zena
using raw = disown(f);   // released at scope exit
let f2 = adopt(raw);         // or take it back; drops normally
```

`using` performs the release internally against the state flag, which it must do
for ordinary disposables anyway.

**This splits `Disposable` into two contracts.** The receivers genuinely differ:

|                          | Receiver          | Why                                                          |
| ------------------------ | ----------------- | ------------------------------------------------------------ |
| `resource class R`       | `this: Own<this>` | consuming — release ends its life                            |
| An ordinary `Disposable` | borrowing         | aliasable, released by `using`; there is no owner to consume |

A class cannot _strengthen_ an inherited borrowing receiver to a consuming one
without breaking interface dispatch, so one interface signature cannot serve
both. The `dispose` **symbol** is shared; the consuming receiver is part of the
**`resource class` contract** rather than of the `Disposable` interface. That
replaces the nominal `Disposable` conformance described under §Resource.

### Disposing groups

A collection of resources released together is a `Resource<Array<Own<R>>>` held
as a field — dropping the container drops each element through derived glue
(§Containers). **`using` does not cover this case**: it is lexically scoped,
whereas a registry of subscriptions built during setup and released at teardown
is bound to an _object's_ lifetime and deliberately outlives the function that
filled it.

JavaScript's `DisposableStack` adds ergonomics over that container rather than
new capability — `use(x)` returning `x` for inline registration, `move()` for
the adopt-on-success pattern, and error aggregation across failed disposals.
Those belong in the stdlib if they earn their keep, not in the language. The one
piece not expressible over a container is `defer(fn)` for arbitrary cleanup that
is not a resource, since a closure is not `Disposable`.

<a id="blessed-producers"></a>

### Blessed producers and `opaque type`

The handle rule above is a special case of something the language does not yet
express: **a type only certain locations may create.** `distinct type` gives
nominal distinctness but not producer control, since anything may cast into it.
That is right for units of measure — `distinct type Meters = i32` wants `5 as
Meters` to be convenient — and wrong for capabilities, handles, and
`distinct type Ptr<T> = i32`, where only the allocator should mint a value.

Every language that solves this uses a file/library boundary as the unit of
blessing: ML abstract types in signatures, Haskell's unexported newtype
constructor, Rust's newtype with a private field, Java's private constructor
plus factory.

#### Specification

**`opaque` replaces `distinct`, it does not compose with it.** Opacity implies
nominal distinctness — an opaque _transparent_ alias would be meaningless, since
if `X` and `Y` are the same type there is nothing to hide. Three levels in one
keyword slot:

```zena
type Feet = i32;              // transparent — the same type
distinct type Meters = i32;   // nominal; `5 as Meters` is allowed
opaque type Ptr<T> = i32;     // nominal; only the declaring library converts
```

1. **The boundary is the declaring library** — one file — not the package.
   ("Library" rather than "module" throughout: _module_ is reserved for Wasm
   modules.) That is the boundary Zena already has, since a library is what
   `export` scopes, and opacity's value scales inversely with the size of the
   trusted set: "anything in the stdlib may mint a `Ptr`" is a far weaker
   guarantee than "only `zena:memory` may". A package whose producers genuinely
   span files has one library own the conversion and export a blessed
   constructor to its siblings, which keeps the trusted set small and
   greppable.
2. **The name is public; the representation is private.** Other libraries may
   name the type in signatures, bind it, pass it and store it. They may not
   convert.
   This is what lets `Own<T>` appear in every user signature while remaining
   unforgeable.
3. **Both directions are restricted.** Casting _out_ is what leaks the
   representation, and for `Own<T>` casting out is exactly the
   ownership-stripping hole. A library that needs the underlying value exports
   an accessor.
4. **`is` checks are a compile error.** Opaque types are erased, so `x is
Ptr<T>` cannot be answered at runtime; it should be rejected rather than
   silently always true.
5. **Representation and codegen are unchanged** — the same erasure `distinct
type` already has.

Residual: an `@external` declaration can still claim to return an opaque type,
since the FFI boundary is trusted by construction. That is the same class as a
wrong `@external` signature, already accepted under §"Linear memory and FFI".

Until this exists, the handles are special-cased by name and `sourcePath` in the
checker, the same way `Hashable` is. Adopting `opaque` should fold that special
case into the general rule and re-declare the handles as
`opaque type Own<T> = T` and so on.

## Open questions

1. Multi-borrow returns: reject, or name the source parameter?
2. `try`/`catch` and the branch-join rule: a runtime drop flag inside `try`
   bodies, or split the try region at each acquisition?
3. Child-before-parent drop ordering: recorded on the wrapper, or inferred?
4. Who drops a resource in an _abandoned_ task's frame? (Cancellation itself is
   answered by the per-state drop table.) This is the residual gate on
   §"Lifting the restriction": second-class futures make the common case nest
   structurally, leaving only the paths that abandon a frame without a scope
   exit.
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
11. ~~Should a resource's release consume its receiver?~~ — **decided**: yes,
    `[Disposable.dispose](this: Own<this>): void`. It does split `Disposable`
    into two contracts sharing one symbol; see
    [Release consumes its receiver](#release-consumes-its-receiver).
12. ~~How is a borrow-derived future or iterator spelled?~~ — **decided**:
    `Scoped<T>`, the fourth corner of the universe table, with `scoped T` as
    the type-parameter opt-in. Follow-on: `Borrow<R>` is also scoped, so
    `Scoped` names the axis rather than its corner — rename before
    `zena:ownership` has clients if that reads badly.
13. Adopt `opaque type` and fold in the handle cast ban? Specified under
    [Blessed producers](#blessed-producers); the open part is scheduling, not
    design.
14. Slot references: does `Borrow<T> ≡ T` need qualifying, or does a reference
    into a container slot need its own spelling? See §"Value types, containers,
    and slot references".
15. How should the checker resolve `Own` when wrapping `new R(…)`? It must not
    depend on the user having imported it, and putting `zena:ownership` in the
    prelude puts the module in every program's graph — measurably, since the
    WatGenerator import-count tests change for programs with no resources.

## Related

- [component-model.md](./component-model.md) — WIT resources, the motivating case
- [linear-memory.md](./linear-memory.md) — allocators
- [filesystem.md](./filesystem.md) — WASI descriptors
- [concurrency.md](./concurrency.md) — parallelism; the vocabulary to reconcile
- [equality.md](./equality.md) — member-level `where` bounds, which O3.5 uses
- [exceptions.md](./exceptions.md) — `try`/`finally`, whose region `using` shares
- [self-hosted-compiler.md](./self-hosted-compiler.md) — `SemanticModel` side tables
- [ir.md](./ir.md) — ZIR, the post-type CFG+SSA IR
- [implementation-plan.md](./implementation-plan.md) — plan of record
