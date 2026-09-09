# Async iteration: one protocol, sync or async by the consumer

Two designs already touch this. [generators.md](generators.md) §8.2
sets `AsyncIterator<T>` as `next(): Future<Option<T>>` — the
fully-async protocol, JS's shape. §8.3 answers function coloring with
the specializer: a maybe-async body compiles to a sync instantiation
(a genuine suspension is a compile error) and an async one, the
caller's context choosing. This document fills the gap between them:
iteration whose color is **runtime data**, not a static property of
the call graph — the Lit SSR case, which neither the always-async
protocol nor compile-time monomorphization covers, and which §8.3
left as "a pattern, not a blessed API."

## The case the other two answers miss

Lit SSR renders a template to a sequence of chunks. The template's
structure is known synchronously — Lit walks its parts without
waiting. But a bound value may be a `Promise`, an async iterable, or a
plain string, decided by the *data* rendered, not by the template's
type. So one template instance is sometimes fully synchronous and
sometimes not, and the consumer's context decides what to do about it:

- A React-style consumer writes the whole render into a string field
  synchronously. It cannot await; if a chunk is not ready, that is an
  error the application must fix (don't put a Promise here).
- A Koa-style consumer streams to a socket and can await each chunk.

Neither existing answer fits. `Future<Option<T>>` forces the React
consumer async — it must await `next()` even to learn the sequence is
over, though the structure was synchronous all along. Compile-time
monomorphization forces the choice at compile time — but a sync
consumer of a template that *turns out* to contain a Promise is a
runtime condition, so the sync instantiation's "genuine suspension is
a compile error" fires nowhere useful; the Promise is application
data, not a static suspension point.

## Two things async iteration can defer

- **The value.** There is a next item; producing it is async.
- **The structure.** Whether there is a next item — done or not — is
  itself async. A socket read does not know if the stream continues
  until data or EOF arrives.

`Future<Option<T>>` defers both: you await even to learn `done`.
Lit's hand-rolled sync-iterator-of-promises defers only the value —
the iterator is synchronous, the *values* may be promises — which is
why it is sync-consumable, and why it cannot express a socket.

This is why the shapes proposed in passing do not work.
`inline (boolean, V) | Future<inline (boolean, V)>` cannot be
awaited-collapsed: the union-await machinery distinguishes arms by a
runtime type test on a single reference, and an inline multi-value is
not a single testable value — the two arms have incompatible
representations (stacked values versus one heap reference). And
`inline (boolean, V | Future<V>)` keeps `done` synchronous while
letting the value defer — Lit's shape exactly — but it *cannot*
express deferred structure: the `boolean` is eager, so "I don't yet
know whether I'm done" has nowhere to live. That is the worry about
"waiting to see if we have a value," and it is real. The fix is to
stop trying to keep `done` synchronous, and fold it into the async
arm.

## The Step protocol

`next()` is a synchronous call. Its result is an inline multi-value
that travels in stack slots and allocates nothing — a tagged union of
three arms, one per disposition:

```zena
type Step<V> =
    inline (0, _, _)                    // Done: no more items
  | inline (1, V, _)                    // Ready: a value, available now
  | inline (2, _, Future<Option<V>>);   // Pending: a value or the end,
                                        //   coming; await the future
```

The first lane is the discriminant, the value lane is set only by
Ready, the future lane only by Pending; the other lanes are holes.
Because it is an inline multi-value, `Step` is return-position only:
`next()` returns it and the caller reads it at once, and Done and
Ready allocate nothing.

Each arm's payload is honestly typed: the value lane is `V | _` across
the union — real in Ready, a hole elsewhere — so it is inaccessible
until a `match` arm narrows it to the arm it belongs to. This is what
makes the three-arm form sound where a two-arm boolean encoding
(`inline (true, V, Future<Option<V>>?) | inline (false, _, _)`, Ready
as a null future and Pending as a set one) is not: there the value
lane is a real `V` in the shared `true` arm, so it reads as accessible
while holding a placeholder in Pending — the type would permit reading
a value that is not there. The three-arm form binds `v` only in the
Ready arm.

The verbosity of matching three arms by hand is not a cost the common
code pays, because `for` and `for await` are the usual consumers and
they are lowered directly: the loop reads the discriminant lane as an
`i32` and branches on it in the backend (as today's two-arm loop reads
its done flag), never routing through a surface `match`. A producer —
an `async gen` state machine — constructs the arms against the known
`Step<V>` type for the same reason. Direct lowering of both is what
the `for await` desugar and the `async gen` return lowering need, and
neither depends on surface `match`.

A surface `match` over `Step` is what a program writes only when it
drives `next()` itself, which is rare (see "Hand-written consumption"
below). That path relies on a `match` over an inline-tuple union
narrowing an arm's payload by its discriminant literal (`case (1, v, _)`
binds `v: V`, not `V | _`). It is worth having on its own — defining
`Option`/`Result` over inline tuples gains the same narrowing — and it
is not on the loop's critical path. The full three-arm shape, including
the all-hole `Done` arm, constructs and narrow-consumes as written.

`Step` shares Option's and Result's inline-union shape but is not one
of them, and the optionality operators — `??` and the rest — stay
nominal to `Option`/`Result`. A mixed `Step` is consumed by `for`,
`for await`, or an explicit `next()` match, where Pending is handled
rather than hidden. (A synchronous single-step accessor that throws
on Pending could be added later; it would be a Step-specific operator,
not the Option `??`. Defining `Option`/`Result` themselves in terms of
inline tuples, with `??`, is separate future work.)

The Pending future carries `Option<V>`, not another `Step`: an inline
`Step` cannot be a `Future`'s type argument, and `Option<V>`
(`Some<V> | None`) is the storable form that still says whether the
awaited item is a value or the end. That is where deferred structure
lives — the socket case, where whether an item exists is not known
until the future settles. This future and its `Some` box are the only
allocations, and they occur on the path that already suspends; the
synchronous path allocates nothing.

The caller always learns the disposition synchronously, from the
discriminant. It waits, in the Pending case, only for the eventual
item, and for whether there turns out to be one.

One type covers the range:

- A synchronous iterator returns only Done and Ready. It is
  consumable by `for`, and a `for await` over it never awaits.
- Lit SSR returns Done and Ready, and Pending where a bound value is a
  promise. It is consumable by `for` until a Pending arrives.
- A socket returns Pending from the start: even done-ness waits.

## Consuming: `for` and `for await`

The two loops differ only in the Pending arm — `for` throws, `for
await` awaits. The shape below is the semantics; the backend lowers it
directly, reading the discriminant lane as an `i32` and branching,
rather than emitting a surface `match` (`next()`'s inline multi-value
has no home in a local, so it is consumed at the call either way):

```zena
// for (x in it) body            // for await (x in it) body
while (true) {
  match (it.next()) {
    case (0, _, _): break;                    // Done
    case (1, value, _): { let x = value; body; }   // Ready
    case (2, _, pending): {                   // Pending
      throw new AsyncInSyncIteration();        // for
      if (let Some {value} = await pending) {  // for await
        let x = value;
        body;
      } else {
        break;
      }
    }
  }
}
```

The same iterator serves both. A `for` consumer throws the moment a
value is genuinely asynchronous; a `for await` consumer handles it.
The consumer chooses whether to be synchronous; the producer is
written once. This is Lit's property directly, and it is the runtime
counterpart to §8.3's compile-time monomorphization: use `for` when a
synchronous consumer is a runtime assertion that no value will defer,
and the specializer when the choice is a static fact about a whole
subsystem.

A `for await` suspends only in the Pending case, so a loop over a
mostly-synchronous iterator suspends rarely, and cancellation is
delivered at each await, keeping suspension points visible (async.md
§2). Leaving the loop early disposes the iterator through the existing
generator-disposal path (generators.md §6).

## Hand-written consumption

Driving `next()` by hand — a surface `match` over `Step`, the verbose
case — is rare, because `for`/`for await` cover iteration and are
lowered without it. The remaining reason to reach for `next()` is a
peek: does the iterator have a next element, often just whether it has
any element at all. That is better served by a named accessor than by
matching the protocol:

- `isEmpty` / `first(): Option<V>` for the sync-only case, and their
  awaiting counterparts where a value may defer;
- array spread (`[...it]`) or a `collect` combinator to drain an
  iterator into a container.

These are ordinary library functions over `next()`; a program written
against them never spells out the three arms. So the protocol's
three-arm shape stays inside the compiler's loop lowering and a small
set of combinators, and the surface `match` narrowing — worth building
for `Option`/`Result` regardless — is not what iteration or the
common peek depends on.

## Producing: `gen` and `async gen`

A producer declares whether it can defer, the way a function declares
`async`. A plain `gen` may not `await` — `await` in its body is a
compile error — so its `next()` returns only `Done` and `Ready`, and
it carries no async machinery. This is today's generator, unchanged.

An `async gen` may `await`. Its `next()` returns `Ready` when it
produces a value without suspending and `Pending` when it suspends
before the next yield; the two split passes already share machinery
(generators.md §6), and an await-then-yield body runs both at once —
driving the frame synchronously as far as it goes, then handing back a
`Pending` over the frame's future when it parks. Its type is the mixed
arm set, so a `for` over it compiles and throws only if a `Pending`
arrives at runtime, and a `for await` handles it. Requiring the
keyword is what keeps the arm set — and so the sync-or-async contract
a caller reads off the signature — a declared property rather than a
whole-body inference over where `await` happens to appear; the same
reason `async` on a function is explicit.

So Lit SSR is an `async gen` that yields its synchronous chunks
directly and yields a promise, or `yield await`s, for the deferred
ones. No driver, no thunks, no convention. The interim pattern
generators.md §8.3 declined to bless becomes one protocol because the
protocol carries the sync/async distinction, not the consumer.

An iterator whose `next()` is async-only — where a sync `for` is a
compile error rather than a possible runtime throw — comes from a
declared iterator type such as a `Stream` adapter, not from a
generator: a generator cannot promise statically that it always awaits
before yielding.

## Representation and cost

`Step` is the inline multi-value union above, not a heap type — so
the synchronous path never pays JS's per-item allocation. Its mixed
form lowers to three wasm results — an `i32` discriminant, a value
lane, and a `(ref null Future<Option<T>>)` lane null on every
synchronous step. Today's protocol is already an inline-tuple union,
`inline (true, T) | inline (false, _)`, whose `false` arm holes the
value lane, so that lane is *already* `(ref null T)` for reference
`T`, and its `ref.as_non_null` on each value read is a cost the
synchronous protocol already pays. The mixed form does not add it.
The genuine marginal cost over today is therefore only the extra
`(ref null Future<Option<T>>)` result — one nullref moved across the
call, register-cheap and dwarfed by call overhead — and one branch on
whether it is null. Both are noise: no memory traffic, nothing
per-element that a loop body doing real work would notice.

Three tiers erase it:

- **Fusion — zero cost, the common case.** `for`-in over arrays,
  ranges, and known containers lowers to an index loop and never
  calls `next()`; the future-lane cost exists only for iteration over a
  genuine custom iterator (streams.md, "the seam is where the
  compiler earns its keep").
- **Concrete-type erasure.** When the loop's iterator type is known
  and its producer is synchronous, the `Pending` arm is dead — its
  `next()` constructs only tags 0/1. Inlining `next()` lets
  branch-folding (this session's DCE/branch-fold passes) drop the
  arm, collapsing to the two-result loop with the nullref lane and
  null-assert gone; best-effort, gated on the inliner accepting the
  state-machine function.
- **GVN/simplify** common the constant nullref lane and fold the
  comparisons against it.

The full three-lane form survives only for a **virtual** `next()` —
an iterator held abstractly, where the producer's arms are not
visible — which is the cost of iterator polymorphism.

The unboxed-sealed-variant thread (the #335 review's "in-place sealed
variants") is the other route to a zero-allocation `Step` that is not
return-position-bound; if it lands, `Step` uses it and the inline
union becomes an implementation detail of `next()`.

## The arm set is part of the type

`next()`'s return type composes by ordinary union subtyping, keeping
the future lane out of loops that do not need it:

- sync-only — `inline (0, _, _) | inline (1, T, _)`, no `Pending` arm.
  This is exactly today's `Iterator<T>`: a `gen` with no `await`
  produces the existing protocol unchanged.
- async-only — `inline (0, _, _) | inline (2, _, Future<Option<T>>)`,
  no `Ready` arm; every item defers.
- mixed — all three arms, the Lit case.

A `gen` with no `await` produces the sync-only shape, so `for`/`for
await` over it never touch a future lane — the loop today's protocol
produces. A sync `for` over an async-only iterator is *statically* a
guaranteed throw and so a compile error ("always async; use `for
await`"), while a sync `for` over a mixed iterator compiles and
throws only if a Pending arrives at runtime — the runtime-versus-
static color distinction, enforced by the type rather than by two
separate protocol types.

Behind the `Iterator<V>` interface a single vtable slot needs one
signature, the mixed three-lane form; a sync-only implementation
stored there sets the future lane null and a consumer holding only
`Iterator<V>` runs the three-lane loop. So the future lane's cost —
a nullref result and one branch on it, noise — falls on abstractly-
held iterators, where iterator polymorphism is actually used, and a
concrete sync-only iterator pays nothing.

What the arm set changes is the *consumer loop*, not the call: a loop
over a sync-only iterator omits the `Pending` branch (and its throw
or await), because the discriminant provably never reaches it; a loop
over a mixed iterator carries all three. So the third arm's code
appears exactly where an iterator can actually produce it, and the
static checks — sync `for` over an always-async iterator is an error,
over a mixed one compiles and may throw — read straight off the
discriminant range. This supersedes the "one type or two" question:
one type family, one representation, refined by which discriminants
occur.

## Where `Stream` fits

`Stream<T>` (streams.md) stays the resource layer: batched reads,
backpressure, the WIT boundary. `Step` is the element-wise protocol
over it — `for`/`for await` consume a `Step` iterator; a `Stream`
adapts to one for ergonomic consumption, its `read` batching under the
`Pending` arm. The two are the "resource versus protocol" split
streams.md already draws; this document only says what the protocol's
`next()` returns.

## Fairness and cancellation on synchronous runs

A `for await` over a run of `Ready` values does not await, because the
Ready case is synchronous, so it schedules no microtask per iteration.
JS does the opposite: `for await` awaits every iteration, so a
synchronously-resolving async iterable fills the microtask queue and
starves timers and I/O. Here a long synchronous run holds the thread
for as long as a plain `for` over an array would, and no longer;
`for await` does not yield more often than `for`.

That leaves cancellation. A synchronous run has no
suspension point, so without help a cancellation would not be
delivered until the next `Pending` or the loop's end. The fix is a
synchronous `checkCancellation()` (async.md's opt-in checkpoint) at
the loop head, covering both arms: an `isCancelled` load and a
branch, raising on the cancellation channel when set. It is not a
microtask, so a synchronous turn stays synchronous while remaining
cancellable. (Polling every turn is cheap; a counter could poll every
N to trade latency for even less, but per-turn is the default.)

A microtask per turn is *not* needed for correctness. The always-async
rule (async.md §2) governs future callbacks — deterministic
observation order — and a `Ready` turn runs no callback; it processes
a value, the way an async function runs to its next `await`. Only a
`Pending` turn hops, and that hop must stay.

The tempting `isMicrotaskQueued`-style optimization — skip a hop when
the queue is empty — has no place here and is a hazard where it might.
On `Ready` turns there is already no hop to skip. On `Pending` turns
the hop is the always-async guarantee: skipping it when the queue
happens to be empty is exactly the "sometimes synchronous, sometimes
not" nondeterminism the rule exists to remove, since identical code
would then behave differently by queue contents. A queue-state flag
would only gate an *optional* fairness-yield on synchronous turns, and
this design does not add one by default.

## Open questions

- **Three arms or four.** With `Pending(Future<Option<V>>)`, Lit's
  producer wraps a value-future as `f.map(Some)`. A fourth arm —
  `Async(Future<V>)`, "a value is coming and there is one," separate
  from `Pending`, "even done-ness waits" — removes the wrap and
  matches Lit's shape directly, at one more case in every consumer
  loop. Recommendation: ship three, add the fourth only if the wrap
  shows up in a profile. A related question: if inline unions gained a
  storable boxed form as a `Future` type argument, the Pending future
  could carry `Step<V>` directly and the `Option` intermediary would
  go away.
- **Naming.** `Step`/`Ready`/`Pending` — `Pending` collides with
  `Task`'s state. `Done`/`Value`/`Later`? Bikeshed deferred.
- **Relationship to §8.3 monomorphization.** These are complementary
  (runtime color versus static), and both can exist. Whether a
  maybe-async `gen` can *also* be monomorphized — a sync instantiation
  whose `Pending` arm is statically dead — is a later optimization,
  not a v1 question.
