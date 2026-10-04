# Async iteration: one step shape, synchronous by default

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
plain string, decided by the _data_ rendered, not by the template's
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
consumer of a template that _turns out_ to contain a Promise is a
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
the iterator is synchronous, the _values_ may be promises — which is
why it is sync-consumable, and why it cannot express a socket.

This is why the shapes proposed in passing do not work.
`inline (boolean, V) | Future<inline (boolean, V)>` cannot be
awaited-collapsed: the union-await machinery distinguishes arms by a
runtime type test on a single reference, and an inline multi-value is
not a single testable value — the two arms have incompatible
representations (stacked values versus one heap reference). And
`inline (boolean, V | Future<V>)` keeps `done` synchronous while
letting the value defer — Lit's shape exactly — but it _cannot_
express deferred structure: the `boolean` is eager, so "I don't yet
know whether I'm done" has nowhere to live. That is the worry about
"waiting to see if we have a value," and it is real. The fix is to
stop trying to keep `done` synchronous, and fold it into the async
arm.

## The Step protocol

`next()` is a synchronous call. Its result is an inline multi-value
that travels in stack slots and allocates nothing — a tagged union
with one arm per disposition. The asynchronous form has three:

```zena
type AsyncStep<V> =
    inline (0, _, _)                    // Done: no more items
  | inline (1, V, _)                    // Ready: a value, available now
  | inline (2, _, Future<Option<V>>);   // Pending: a value or the end,
                                        //   coming; await the future
```

and the synchronous form is its first two arms:

```zena
type Step<V> =
    inline (0, _, _)    // Done
  | inline (1, V, _);   // Ready
```

`Step<V>` keeps the third position, always a hole, so that it is a
subtype of `AsyncStep<V>` by ordinary union subtyping: a synchronous
`next()` can stand wherever an asynchronous one is expected. Both are
structural aliases; nothing is nominal about a step.

The first lane is the discriminant, the value lane is set only by
Ready, the future lane only by Pending; the other lanes are holes.
Because it is an inline multi-value, a step is return-position only:
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
`i32` and branches on it in the backend (as the two-arm loop it replaced
read its done flag), never routing through a surface `match`. A producer —
an `async gen` state machine — constructs the arms against the known
`AsyncStep<V>` type for the same reason. Direct lowering of both is what
the `for await` desugar and the `async gen` return lowering need, and
neither depends on surface `match`.

A surface `match` over a step is what a program writes only when it
drives `next()` itself, which is rare (see "Hand-written consumption"
below). That path relies on a `match` over an inline-tuple union
narrowing an arm's payload by its discriminant literal (`case (1, v, _)`
binds `v: V`, not `V | _`). It is worth having on its own — defining
`Option`/`Result` over inline tuples gains the same narrowing — and it
is not on the loop's critical path. The full three-arm shape, including
the all-hole `Done` arm, constructs and narrow-consumes as written.

A step shares Option's and Result's inline-union shape but is not one
of them, and the optionality operators — `??` and the rest — stay
nominal to `Option`/`Result`. An `AsyncStep` is consumed by `for
await`, or an explicit `next()` match, where Pending is handled rather
than hidden. (Defining `Option`/`Result` themselves in terms of inline
tuples, with `??`, is separate future work.)

The Pending future carries `Option<V>`, not another step: an inline
step cannot be a `Future`'s type argument, and `Option<V>`
(`Some<V> | None`) is the storable form that still says whether the
awaited item is a value or the end. That is where deferred structure
lives — the socket case, where whether an item exists is not known
until the future settles. This future and its `Some` box are the only
allocations, and they occur on the path that already suspends; the
synchronous path allocates nothing.

The caller always learns the disposition synchronously, from the
discriminant. It waits, in the Pending case, only for the eventual
item, and for whether there turns out to be one.

Two interfaces carry the two forms, and the synchronous one is a
subtype of the asynchronous one:

```zena
interface AsyncIterator<T> { next(): AsyncStep<T>; }
interface Iterator<T> extends AsyncIterator<T> { next(): Step<T>; }

interface Iterable<T> {
  static symbol iterator;
  [Iterable.iterator](): Iterator<T>;
  ...
}
interface AsyncIterable<T> {
  static symbol asyncIterator;
  [AsyncIterable.asyncIterator](): AsyncIterator<T>;
}
```

`Iterator<T>` and `Iterable<T>` live in `zena:core` and the prelude;
`AsyncStep`, `AsyncIterator` and `AsyncIterable` in `zena:async`,
since only they name `Future`. The two iterables are unrelated types
with their own symbols, as in JS: a class that is both implements both
methods.

One shape covers the range:

- A synchronous iterator returns only Done and Ready, and says so in
  its type. It is consumable by `for`, and a `for await` over it never
  awaits.
- Lit SSR returns Done and Ready, and Pending where a bound value is a
  promise. It is an `AsyncIterator`, consumable by `for await`, and by
  `for` through `requireSync` until a Pending arrives.
- A socket returns Pending from the start: even done-ness waits.

## Consuming: `for` and `for await`

A plain `for` accepts the synchronous protocol — arrays, `Iterator<T>`,
`Iterable<T>` — and nothing else. Its loop reads the discriminant as a
boolean: Done leaves, Ready binds and runs the body. A `for` over an
`AsyncIterator<T>` or `AsyncIterable<T>` is a compile error, since the
loop never waits and a value that is still coming would have nowhere to
go:

```
Type 'AsyncIterator<i32>' is an asynchronous iterable, and a `for` never
waits. Use `for await`, or `requireSync` to throw if a value is not
available yet.
```

A `for await` accepts both protocols. Over the synchronous one it lowers
exactly as a `for` does. Over the asynchronous one it adds the Pending
arm — the shape below is the semantics; the backend lowers it directly,
reading the discriminant lane as an `i32` and branching, rather than
emitting a surface `match` (`next()`'s inline multi-value has no home in
a local, so it is consumed at the call either way):

```zena
// for await (x in it) body
while (true) {
  match (it.next()) {
    case (0, _, _): break;                       // Done
    case (1, value, _): { let x = value; body; } // Ready
    case (2, _, pending): {                      // Pending
      if (let Some {value} = await pending) {
        let x = value;
        body;
      } else {
        break;
      }
    }
  }
}
```

A synchronous consumer of an asynchronous source opts in to the runtime
condition with a library function, `requireSync` over an
`AsyncIterable<T>` (giving an `Iterable<T>`) or `requireSyncIterator`
over an `AsyncIterator<T>` (giving an `Iterator<T>`). The adapter
forwards Ready and Done, and throws `AsyncInSyncIteration` on a Pending
step. It never reads the future, even one that has already settled:
a synchronous consumer that reads values out of futures would be
sometimes synchronous and sometimes not, by whether a future happened to
be done, and the throw is what keeps the condition visible.

```zena
for (let chunk in requireSync(template.render(data))) {
  out.append(chunk);   // throws AsyncInSyncIteration if a chunk defers
}
```

So the same producer serves both consumers. A `for await` consumer
handles a deferred value; a `for` consumer says, in its source, that it
has asserted none will defer, and the assertion is checked at runtime.
This is Lit's property, and it is the runtime counterpart to §8.3's
compile-time monomorphization: use `requireSync` when a synchronous
consumer is a runtime assertion that no value will defer, and the
specializer when the choice is a static fact about a whole subsystem.
What the split adds over a single protocol is that the assertion is
spelled out where it is made, rather than implied by which loop keyword
was used, and that a `for` over an ordinary collection compiles to a
loop with no Pending branch to elide.

A `for await` suspends only in the Pending case, so a loop over a
mostly-synchronous iterator suspends rarely, and cancellation is
delivered at each await, keeping suspension points visible (async.md
§2). Leaving the loop early disposes the iterator through the existing
generator-disposal path (generators.md §6).

## Hand-written consumption

Driving `next()` by hand — a surface `match` over a step, the verbose
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
compile error — so it is an `Iterator<T>`: its `next()` returns only
`Done` and `Ready`, and it carries no async machinery. This is today's
generator, unchanged.

An `async gen` may `await`, and is an `AsyncIterator<T>`. Its `next()`
returns `Ready` when it produces a value without suspending and
`Pending` when it suspends before the next yield; the two split passes
already share machinery (generators.md §6), and an await-then-yield
body runs both at once — driving the frame synchronously as far as it
goes, then handing back a `Pending` over the frame's future when it
parks. A `for await` handles it; a `for` over it is the compile error
above, and `requireSync` makes it a loop that throws only if a
`Pending` arrives at runtime. Requiring the keyword is what keeps the
arm set — and so the sync-or-async contract a caller reads off the
signature — a declared property rather than a whole-body inference over
where `await` happens to appear; the same reason `async` on a function
is explicit.

So Lit SSR is an `async gen` that yields its synchronous chunks
directly and yields a promise, or `yield await`s, for the deferred
ones. No driver, no thunks, no convention. The interim pattern
generators.md §8.3 declined to bless becomes one protocol because the
protocol carries the sync/async distinction, not the consumer.

## Representation and cost

A step is the inline multi-value union above, not a heap type — so
the synchronous path never pays JS's per-item allocation. `AsyncStep`
lowers to three wasm results — an `i32` discriminant, a value
lane, and a `(ref null Future<Option<T>>)` lane null on every
synchronous step. The protocol it replaced was already an inline-tuple
union, `inline (true, T) | inline (false, _)`, whose `false` arm holed
the value lane, so that lane was _already_ `(ref null T)` for reference
`T`, and its `ref.as_non_null` on each value read was a cost the
synchronous protocol already paid. The mixed form does not add it.
The genuine marginal cost over the boolean tuple is therefore only the extra
`(ref null Future<Option<T>>)` result — one nullref moved across the
call, register-cheap and dwarfed by call overhead — and one branch on
whether it is null. Both are noise: no memory traffic, nothing
per-element that a loop body doing real work would notice.

`Step` lowers to the same three results, with the third a `nullref`:
a lane no arm ever fills is `(ref null none)`, the bottom of the
reference hierarchy, which is a subtype of every nullable reference and
so of the `(ref null Future<Option<T>>)` lane an `AsyncIterator` slot
declares. That is what lets a synchronous `next()` forward through an
`AsyncIterator<T>` vtable slot with no adaptation on the way back —
the interface trampoline tail-calls the implementation, as it does for
every other member. The lane costs one `ref.null none` per step and
nothing else, and a `for` never reads it.

Three tiers erase what remains:

- **Fusion — zero cost, the common case.** `for`-in over arrays,
  ranges, and known containers lowers to an index loop and never
  calls `next()`; the future-lane cost exists only for iteration over a
  genuine custom iterator (streams.md, "the seam is where the
  compiler earns its keep").
- **Static elision.** A `for`, and a `for await` over a synchronous
  iterator, has no Pending branch at all: the type says the
  discriminant is 0 or 1, and the loop tests it as a boolean. Only a
  `for await` over an `AsyncIterator` carries the second test and the
  suspension.
- **GVN/simplify** common the constant nullref lane and fold the
  comparisons against it; at -O2, inlining a concrete `next()` folds
  the branches its arms never take.

The full three-lane form survives only for a **virtual** `next()` —
an iterator held abstractly, where the producer's arms are not
visible — which is the cost of iterator polymorphism.

The unboxed-sealed-variant thread (the #335 review's "in-place sealed
variants") is the other route to a zero-allocation step that is not
return-position-bound; if it lands, `Step` uses it and the inline
union becomes an implementation detail of `next()`.

## Compile-time cost of the Step protocol

The stdlib's iterators return `Step<T>` (#595), and compiling with them
costs no more than it did with the boolean tuple. Running the whole
execution-test suite (694 programs, each compiled and then run) took about
115 seconds of CPU with `Step` iterators, against 147 to 158 seconds just
before the change, on one machine with warm caches.

It was not always so. Before the flip landed, the same suite (657
programs then) took 1,095s to compile with `Step` iterators against 9.0s
with the boolean tuple, about 120 times slower, and that result held the
flip back. A benchmark showed the cost was not per site.
`test-files/benchmarks/iter-*.zena` (generated by
`gen-iteration-benchmarks.mjs`; time one with
`zena-cli build <file> -o out.wasm --time --no-cache`) compiles
single programs with many independent iteration sites: 150
distinct-type `Step` sites compile in about 2.3s against 1.4s for the
boolean form. So the slowdown came from the suite's batches, where many
entry points share one compiler.

What removed it was not isolated. Between that measurement and the flip,
`main` changed how import cycles are checked (registering every member of
a cycle before any bodies are checked), and the prelude became ordinary
imports (#667), so the stdlib's own modules, which the flip puts on one
cycle, are checked in import order. The slowdown did not reproduce on the
flip rebased onto those changes. The `iter-*` benchmarks stay as the
per-site check.

## The arm set is part of the type

`next()`'s return type composes by ordinary union subtyping, keeping
the future lane out of loops that do not need it:

- sync-only — `Step<T>`, `inline (0, _, _) | inline (1, T, _)`, no
  `Pending` arm. This is `Iterator<T>`; it carries what the boolean
  tuple did, and a `gen` with no `await` produces it.
- mixed — `AsyncStep<T>`, all three arms, the Lit case. This is
  `AsyncIterator<T>`, and what an `async gen` produces.
- async-only — `inline (0, _, _) | inline (2, _, Future<Option<T>>)`,
  no `Ready` arm; every item defers. A producer may declare it, and it
  is an `AsyncIterator<T>` like the mixed form; nothing reads the
  missing arm off the type today.

Which loop accepts which is read straight off the interfaces rather
than the discriminant range: a `for` takes `Iterator`/`Iterable`, a
`for await` takes those and `AsyncIterator`/`AsyncIterable`, and
`requireSync` is the explicit bridge. The runtime-versus-static
distinction is still there — a `for await` over a mixed iterator
awaits only when a Pending arrives — but a synchronous consumer of a
maybe-asynchronous source says so at the loop, instead of a `for`
over any iterator quietly carrying a throw that only the type could
have said was reachable.

Behind an `AsyncIterator<V>` slot a single vtable entry needs one
signature, the three-lane form, and `Iterator<V> extends
AsyncIterator<V>` puts every synchronous implementation there too. The
future lane of a synchronous `next()` is `nullref` (see "Representation
and cost"), a subtype of the slot's `(ref null Future<Option<V>>)`, so
the trampoline forwards without converting on the way back. A consumer
holding only `AsyncIterator<V>` runs the three-lane loop; the future
lane's cost — a nullref result and one branch on it, noise — falls on
abstractly-held asynchronous iterators, where that polymorphism is
actually used, and a `for` over an `Iterator<V>` pays nothing.

What the arm set changes is the _consumer loop_, not the call: a loop
over a synchronous iterator omits the `Pending` branch, because the
discriminant provably never reaches it; a `for await` over an
asynchronous one carries all three. So the third arm's code appears
exactly where an iterator can actually produce it. This supersedes the
"one type or two" question: one shape, one representation, refined by
which arms a type admits.

## Where `Stream` fits

`Stream<T>` (streams.md) stays the resource layer: batched reads,
backpressure, the WIT boundary. `AsyncStep` is the element-wise
protocol over it — a `for await` consumes an `AsyncIterator`; a
`Stream` is an `AsyncIterable` for ergonomic consumption, its `read`
batching under the `Pending` arm. The two are the "resource versus protocol" split
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

A microtask per turn is _not_ needed for correctness. The always-async
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
would only gate an _optional_ fairness-yield on synchronous turns, and
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
  could carry `AsyncStep<V>` directly and the `Option` intermediary
  would go away.
- **Naming.** `Step`/`Ready`/`Pending` — `Pending` collides with
  `Task`'s state. `Done`/`Value`/`Later`? Bikeshed deferred.
- **Relationship to §8.3 monomorphization.** These are complementary
  (runtime color versus static), and both can exist. Whether a
  maybe-async `gen` can _also_ be monomorphized — a sync instantiation
  whose `Pending` arm is statically dead — is a later optimization,
  not a v1 question.
