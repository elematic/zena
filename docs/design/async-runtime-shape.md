# Async runtime shape: `Future`'s allocations and public surface

Status: **Proposal** (2026-08). A review of `zena:async` as implemented
([async.md](async.md) §2, A0–A3 landed) against the cost and API
questions [async.md](async.md) §8.6 raises but does not settle.

The organizing claim: **`Future<T>`'s allocation profile and its
awkward public surface have one shared cause** — the notification
protocol pushes settled values to waiters instead of letting waiters
read them. Fixing that direction retires four types, every per-settle
allocation, and the reason `Future` needs a throwing accessor. The
remaining items — the boxed value, the eagerly allocated waiter
arrays, the parking machinery — are small once that is done.

Nothing here changes observable async semantics. Eager start,
run-to-completion, FIFO microtasks, always-async delivery, one-level
adoption, and the host contract all stand exactly as
[async.md](async.md) describes them.

## Status

Landed with this document: the pull protocol (one `Task`, four types
deleted, no per-settle allocation), inline-first waiter storage,
`tryComplete`/`tryFail`, combinators rewritten to read their inputs, and
the symbol-keyed reads.

Landed since, REVERSING a plan item: the settle side is symbol-keyed
too, so a reference to a `Future` is read-only and `Completer` is the
write capability — see "`Completer<T>` is the write capability" below,
which replaces this document's original removal plan.

Not landed, in the order the plan below gives them: hole-initialized
fields (so `#value` is still a `Box<T>`), the intrusive queue, removing
`state`/`isCompleted`, the `Parker` hook, and the multi-value ramp.

Line references below are to `ea7837e3`, the commit before this change,
since the point of most of them is what the code looked like going in.

### What the implementation settled

The sketch below is now the shipped shape. It was not, at first: four
compiler bugs stood between them, all filed from this work and all fixed
by `86e63185` and the statics commits `869b6218`..`e4ea8a51`. What the
detours cost is worth recording, because each one had produced a piece
of API that looked like a design decision:

- **A library waiter could not hold a `Future<T>`.** Constructor
  parameter, nullable field, closure capture and handing over `this` all
  failed, so waiters reached their future through an `i32` index or a
  one-element `Array<Future<T>>` filled after construction. One cause: a
  forward-referenced generic class silently dropped its type arguments.
  Waiters now take the future directly, which also lets `Future.race`
  drop the input list it kept solely so its waiters could find their
  input — an `Array` plus its backing store per race.
- **`onComplete` is a method**, as sketched. It was a free function
  taking the future as an argument, because `this` inside `Future<T>`'s
  own method checks as the raw template `Future`. That part is still
  true, but `this as Future<T>` now lowers, so the cast is the whole
  cost ([#110](https://github.com/elematic/zena/issues/110), "Inside a
  generic class, `this` and generic-typed field reads check as the raw
  template type" — still open, downgraded).
- **The combinators are statics**: `Future.all`, `Future.race`,
  `Future.of`, `Future.failed`, the names [async.md](async.md) §2 asked
  for. They were free functions because a generic static's body could
  reach no generic construct — the first real use of statics-on-a-generic
  -class hit it.
- **`[failure]()` exists beside `[result]()`.** A zero-width `T` does not
  lower in an inline-tuple lane, so `Future<void>.result()` bails
  ("method result type"), and `Future<void>` is what `sleep` returns.
  The library's waiters therefore read the tag and the value separately.
  That is exactly the separable-tag shape this document argues against —
  tolerable only because both members are private to the module. It
  retires when void lanes lower. **This is the one that is still open**,
  and the only place the shipped code diverges from the sketch.
- **`runFuture(f)` is the public way to get a value out.** Drain, then
  unwrap. It cannot answer before the queue has run, so it gives
  synchronous code a value without giving it a way to observe _when_
  something settled. The async tests use it where they previously called
  `valueOrThrow`.

The general lesson is the one worth keeping: every one of these produced
a plausible-sounding justification for a worse API. "A pulling waiter
has to hold its future, and an argument is the only way to receive one"
reads like a design constraint. It was a bug, and it had already been
written into three doc comments as though it were permanent.

`state` and `isCompleted` are still public. Retiring them is the
remaining half of the argument below, and it is separable: the ordering
tests currently assert "not settled yet" by polling, and would need
rewriting to trace-based assertions first.

## Allocation accounting

`let x = await g()`, where `g` is an async function that suspends once,
allocated eight objects before this change:

| #   | Object                                   | Source                        |
| --- | ---------------------------------------- | ----------------------------- |
| 1   | the async frame                          | synthesized by the split pass |
| 2   | `Future<T>`                              | `Future`'s own allocation     |
| 3   | `#listeners` `Array`                     | `async.zena:221`, eager       |
| 4   | its `FixedArray` backing, **capacity 8** | `growable-array.zena:12`      |
| 5   | `#resumables` `Array`                    | `async.zena:222`, eager       |
| 6   | its `FixedArray` backing, capacity 8     | `growable-array.zena:12`      |
| 7   | `Box<T>` for the settled value           | `async.zena:311`              |
| 8   | `ResumeDelivery`                         | `async.zena:277`              |

Sixteen reference slots of backing storage stand ready for two lists
that hold one entry between them, and rows 7 and 8 recur on every
settle. Under WASM GC there is no stack allocation to fall back on:
scalar replacement is the only mechanism
([optimizations.md](optimizations.md)), so each row is a real heap
object until something deletes it outright.

The target is two objects — the frame and the future — with the
multi-value ramp below taking it to one, and frame sinking to zero.

## The settled value in the future

`#value: Box<T> | null` (`async.zena:219`) exists because a `T | null`
field cannot represent "resolved with null", and an unbounded `T` has no
null to begin with. The box is not needed: the compiler already
allocates structs whose fields of arbitrary spilled type start at a
default value, and does it on the async path specifically.

Frame structs are built with `struct.new_default`
(`codegen/ir/generators.zena:689`), which requires every field to be
defaultable, so the pass first weakens each ref-typed frame field to
nullable (`weakenToNullable`, `codegen/ir/generators.zena:666`). Spilled
values of arbitrary type already live in default-initialized fields;
`Future`'s value slot is the same shape.

What is missing is only a surface spelling. The hole literal already
carries exactly this meaning — refs become `null`, primitives become
zero ([multi-return-values.md](multi-return-values.md), "The Hole
Literal") — and already parses to `HoleType`
(`checker.zena:6893`); it is restricted to inline-tuple slots. Extending
it to field initializers gives:

```zena
var #value: T = _;
```

Lowering: weaken the slot to nullable, emit `ref.as_non_null` on read
when `T` is a non-null reference type. A read before the store traps,
which is the right failure for an invariant the class controls.

At `T = void` the zero-width rule ([async.md](async.md) §8 question 1)
deletes the field entirely, so `Future<void>` — which `sleep` depends
on — gets smaller rather than needing a special case.

## Push versus pull

`zena:async` has two notification protocols because it has two kinds of
waiter:

- `FutureListener<A>` (`async.zena:155`) is **push**. It is generic in
  the payload and the value is handed to `onValue(value)`.
- `Resumable` (`async.zena:184`) is **pull**. It carries no type
  parameter, and the frame reads the settled value back out with
  `valueOrThrow()`.

They cannot share a list because one is generic and one is not, which is
why `Future` carries two of them. Every remaining wart is downstream of
the push half:

- A pushed value must be carried across the queue hop, so delivery needs
  an object holding it: `ValueDelivery<A>` and `ErrorDelivery<A>`
  (`async.zena:198`, `:208`), allocated once per waiter per settle.
- A push listener is an interface implementation, so a bare pair of
  callbacks needs a wrapper: `CallbackListener<A>` (`async.zena:161`),
  on top of two closures that are already heap objects.
- Two protocols need an adapter into the queue's own: `ResumeDelivery`
  (`async.zena:189`).

**Make every waiter pull.** The notification protocol then has no type
parameter, and `Microtask`, `Resumable`, and `FutureListener<A>` become
one type:

```zena
export class Task {
  run(): void
}
```

`ValueDelivery`, `ErrorDelivery`, `ResumeDelivery`, and
`CallbackListener` all disappear, and with them every allocation that
happens at settle time. Settling becomes moving the waiter list onto the
run queue.

Pull is also what makes the frame's waiter implementation
type-independent, which the current design already relies on and states:
one `Resumable` implementation "serves every await site in a function,
whatever it awaits" (`async.zena:180`). A pushed value would make the
waiter interface generic in the awaited type, so a frame awaiting both a
`Future<i32>` and a `Future<String>` would need two implementations.
That constraint is what forces the direction, and it is a good one.

The cost is that a pull-waiter holds the future it waits on. The frame
already does — the awaited future is an ordinary value live across the
suspension, spilled to a frame field ([async.md](async.md) §5, A1). A
combinator listener gains one field and loses one allocation per settle.

### Combinators get smaller too

`AllState` keeps `slots: Array<Box<T> | null>` and allocates a `Box` per
input (`async.zena:452`, `:499`) because pushed values arrive with
nowhere to go. Under pull the inputs already hold their own values, in
input order, so `Future.all` counts down and reads the inputs on the last
settle. The slots array and the N boxes go away.

This is a place where Zena can be cheaper than JS rather than merely as
cheap: `Promise.all` must keep its own results array precisely because a
`Promise` has no readable settled value.

### Push-only, considered

Push does not _inherently_ cost an allocation, and the reason is worth
recording because it is the one argument that could overturn the
direction above. The value is produced at settle time and consumed one
queue hop later, so it has to live somewhere in between; `ValueDelivery`
is one answer, but a **preallocated typed slot on the waiter** is
another, and it allocates nothing. That is what [async.md](async.md) §3
originally specified — a `$resume` frame field "written by the completion
path" — before A1 replaced it with pull.

So an allocation-free push-only design exists. Its costs are elsewhere:

- **The waiter interface goes generic again.** Writing a typed value into
  the waiter needs a typed call, so a frame needs one implementation and
  one vtable per _distinct awaited type_ in the function. Given that
  duplicated generic instantiations are where Zena's binary size actually
  goes ([binary-size.md](binary-size.md)), that is the real bill.
- **It reintroduces a per-frame error slot.** Under pull a rejected future
  re-throws at the resume point and unwinds into the existing
  failure-capture region; [async.md](async.md) §5 notes this made failure
  propagation free and that await-in-try "needed no change to the error
  path at all — a per-frame error slot would have". Push must stash the
  error for `step()` to rethrow.
- **It does not remove `#value` from the future.** `let a = g(); …;
await a;` subscribes to an already-settled future, so the value must be
  retained for late subscribers regardless. Push removes the public
  accessor, not the storage — and symbol-keying removes the public
  accessor at no cost at all.
- **Combinators get worse**, per the section above: a pushed value arrives
  with nowhere to go, so `AllState` keeps its slots array and its boxes.

Worth noting V8 does push and does allocate for it — a `PromiseReaction`
per handler plus a reaction job task carrying the argument. The
preallocated-slot trick is unavailable there because JS handlers are
arbitrary closures rather than compiler-synthesized frames. Zena has the
frames and could take it; the generic waiter interface is what makes it
not worth taking.

## Waiter storage

With one untyped waiter type, storage has two workable shapes.

**Inline the first waiter.** No compiler dependency, and it covers the
common case exactly:

```zena
var #waiter: Task | null = null;      // the single-waiter case
var #more: Array<Task> | null = null; // allocated only for two or more
```

Zero allocations at construction and zero for the first waiter, which
deletes rows 3–6 of the accounting table.

**Intrusive list.** `Task` carries `var next: Task | null`, so a future's
waiter list and the run queue are the same list. Settling splices the
whole chain onto the queue tail in O(1) with no per-waiter work, and
`MicrotaskQueue`'s `Array`, head index, and backlog-release loop
(`async.zena:57`–`79`) go away with it.

Two constraints on the intrusive version, both real:

1. It needs `Task` to be a base class rather than an interface, so the
   frame must extend it. A1 rejected subclassing for `Future<T>` because
   inheriting a _specialized generic_ class's vtable and layout through
   RTA is substantial machinery ([async.md](async.md) §5). `Task` is
   non-generic with one field and one virtual method, which is a much
   smaller ask — but it is the one item here that should be prototyped
   before it is committed to. The transform binds to `Resumable`
   reflectively off `subscribeResumable`'s signature
   (`codegen/ir/async.zena:160`), so that lookup changes either way.
2. `Future.race` subscribed **one shared listener** to every input
   (`async.zena:573`), and a node can belong to only one intrusive list.
   Resolved on the way in: race now allocates a waiter per input, as
   `Future.all` already did.

Recommendation: ship the inline-first shape, which is unconditional, and
treat the intrusive list as a follow-up gated on the subclassing
prototype.

## `Task` as a nominal type

A function type — `() => void` — would be the smaller-looking choice and
is the wrong one. A frame subscribing itself as a closure allocates a
closure object holding a funcref and the captured frame, once per await.
That is the `ResumeDelivery` cost relocated into the closure
representation rather than removed. With a nominal type the frame _is_
the waiter and `subscribe(this)` allocates nothing, which is the property
`Resumable` already has and which should survive.

Dispatch cost does not decide it: a closure call is `call_ref` through a
struct field, an interface call is an itable lookup plus `call_ref`, a
class virtual call is a vtable lookup plus `call_ref`.

Interface versus class is decided by `next` alone. Without the intrusive
list, `Task` should be an interface.

## `Future`'s public surface

Pull needs a read of the settled value. It does not need a _public_ one,
and the difference turns out to be the whole API question.

```zena
/** Not exported: keys the runtime's own read of a settled future. */
symbol result;

export class Future<T> {
  /** The settled result. Traps if this future is still pending —
   *  unreachable by construction, since the only way to reach this is to
   *  be a task the future itself scheduled. */
  [result](): inline (true, T, _) | inline (false, _, Error);

  /** `t.run()` from the microtask queue once this future settles. */
  subscribe(t: Task): void;

  /** Settle, or report that someone else already did. */
  tryComplete(value: T): boolean;
  tryFail(error: Error): boolean;

  /** The callback bridge for non-async code. */
  onComplete(onValue: (value: T) => void, onError: (error: Error) => void): void;

  /** Constructors and combinators. Each declares its own `A`: a static
   *  is outside its class's generic scope. */
  static of<A>(value: A): Future<A>;
  static failed<A>(error: Error): Future<A>;
  static all<A>(futures: Array<Future<A>>): Future<Array<A>>;
  static race<A>(futures: Array<Future<A>>): Future<A>;
}
```

`[result]()` is keyed by a symbol `zena:async` does not export, so no
other module can name it. That is the same device `zena:map` uses for
`MapEntry`'s link field and `zena:ownership` uses for its lifecycle
accessors, and it costs nothing: a top-level symbol keying a method on a
concrete class is an ordinary direct call, not an interface dispatch
(the vtable-index language in [classes.md](classes.md) §9.4 is about
interface protocol methods). The compiler is inside the boundary
trivially — the transform already resolves members by string, so
`'valueOrThrow'` becomes `'[result]'`.

**This is what makes the surface JS-shaped without paying for it.** With
the read hidden, user code cannot observe a settled value synchronously
and cannot ask whether a future has settled — the properties
[§Completion state](#why-hiding-completion-state-is-worth-it) argues for
— while the runtime keeps zero-allocation pull delivery. A public `Task`
would be useless to user code, since a user-written waiter could read
nothing, so `subscribe` and `Task` are effectively internal too and the
public surface is `onComplete` plus the constructors and combinators.
That is close to the minimum, and it is reversible in the safe
direction: exporting the symbol later is one word, retracting it is not.

**This rests on symbol identity, which now holds.** When the design was
written it did not: symbol-keyed members resolved by the symbol's source
_name_, with no comparison of the declaring symbol's identity, so any
module could reach `[result]()` by declaring a symbol of the same name.
That was filed from this work and fixed in `86e63185`; access now
compares identity, and
`tests/language/semantics/async/private-settled-read.zena` pins it for
these three members specifically — a module declaring its own `symbol
valueOrThrow` gets "different symbol" on all of them.

Four further changes get to the shape above:

**A tagged inline union rather than an accessor pair.** The tag has to be
inseparable from the payload, which is exactly the argument
[result-option.md](result-option.md) makes for keeping `Result`'s boolean:
holes are only observable in reference slots, so separate `value: T` and
`error: Error | null` fields would let an unset numeric `T` read as a
silent `0`. Three lanes, not two, for the same reason that document
gives — lane merging assigns one wasm valtype per lane, and `T` and
`Error` share one only if they share a representation. This is precisely
the `Result<T, Error>` shape, and `[result]()` should be spelled as that
alias once `type Result<T, E> = inline …` is legal (it is not yet:
"inline tuple types can only appear in function return types").

**No `isCompleted` on the read side.** Branching on pending-ness is the
affordance that produces schedule-dependent behavior. The combinators'
"have I settled already" guard belongs to the write side as
`tryComplete`/`tryFail`, which is what `Future.race` actually wants; that also
retires `AllState.settled`, `RaceState.settled`, and the double-settle
throw.

**No throw in `[result]()`, and no completion query for the drain.**
Deadlock is a property of the executor — queue empty, nothing
outstanding, root future still pending — not of any individual future.
Detecting it in the drain loop rather than in `valueOrThrow`
(`async.zena:288`) puts it where the information is, makes it one check
with one message instead of a check per resume point, and removes a
generic `Error` construction from every `Future<T>` instantiation. The
drain needs no read at all: the entry wrapper subscribes a one-field
sentinel `Task` to the root future, and deadlock is "nothing left to do
and the sentinel never ran".

**No `complete`/`fail` on `Future`.** See below.

The throwing behavior `await` needs does not disappear; it moves to the
resume point, emitted by the transform as a compare-and-branch into one
shared non-generic helper. That is strictly smaller than today, where
`valueOrThrow` is a generic class method monomorphized per instantiation
even though nothing it does depends on `T`.

### Why hiding completion state is worth it

The hazard JS avoids is narrower than "reading the value": it is
_branching on completion_. Given a way to ask, `if (f.isCompleted) fast()
else await f` becomes writable — two code paths where one runs only under
a scheduling accident, and where making something settle a tick earlier
silently switches which. Promises pay the always-async cost precisely to
guarantee one path, and an observable completion state hands that
guarantee back at the observation site after buying it at the callback
site. JS also has a second reason that does not apply here: without
blocking, a synchronous read is only usable when you already know the
promise settled, which you can only know by having awaited it.

Reading the payload, by contrast, is useful and is not the hazard — Rust
exposes it (`Poll::Ready(v)`), C# exposes `.Status`/`.Result`, Java
exposes `isDone()`/`getNow()`. JS and Dart are the outliers. Symbol-keying
the read takes the benefit (zero-allocation pull, combinators with no
storage of their own) and declines the hazard, rather than trading one
for the other.

### Typestate, and why ownership is not the tool

The stricter thing to want is that `value` be unreachable _until_ the
future settles, checked statically. That is typestate, and `Own<T>` is
not it: affine types encode "at most once", not "only in this state". A
consuming `take(this: Own<this>): Result<T, Error>` would enforce
read-once, which is wrong here — multiple awaiters are legal and late
subscribers must still read. And WasmGC cannot change an object's runtime
type, so `Pending<T>` → `Settled<T>` cannot be a narrowing of the same
reference; the transition would have to produce a new value, which is a
different object model.

What the language does have is pattern narrowing over tagged inline
unions, which is typestate encoded in a _value_ rather than in an object:
the payload is unreachable without matching the tag, and the compiler
enforces that much. The symbol closes the remaining gap — not by making a
premature read ill-typed, but by making it unwritable outside the module
that cannot perform one.

## `Completer<T>` is the write capability

This section originally planned the opposite — deleting `Completer` and
folding the settle side into `Future`, on the observation that
`Future.complete`/`fail` were public anyway, so the wrapper enforced no
split. Review reversed the direction: a reference to a `Future` should
be read-only, so instead of removing the wrapper the hole is closed.
`complete`, `fail`, `tryComplete` and `tryFail` are keyed by the same
unexported symbols as the settled reads, which makes the split
identity-enforced rather than conventional: user code with a future can
only await or subscribe, and `Completer` — which forwards through the
symbols from inside `zena:async` — is the one way to settle from
outside the module. That makes async.md §2's claim ("everything
external completes futures through it; there is no other way in") true
rather than aspirational, and it is the withResolvers shape collapsed
to one object: `new Completer<T>()` is the `{resolve, reject}` bundle,
and `.future` is the promise.

The wrapper's cost — one extra allocation and one class per externally
settled operation, plus the `AnyCompleter` base — is the price of the
capability, paid only where a capability is actually handed out: the
split pass's frames, the statics, and the combinators settle through
the symbols directly and allocate no completer.

## Callback combinators

`then`, `catch`, and `finally` are the API a JS developer reaches for
first, and they should exist. They should not be the primitive.

**Blocking is structurally unavailable.** `CompletableFuture.get()`,
C#'s `.Result`, and Rust's `block_on` all need a thread that can sleep
while other work progresses. Zena is single-threaded with stackless
coroutines: no second stack to switch to, no thread to park. The WASI
parker resembles blocking but works only at the top of the drain —
inside a task it would re-enter the executor and break
run-to-completion. So the design space is non-blocking APIs only.

Four families:

| Family                | Examples                                                                 | Per-await cost                                       |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Callback/continuation | JS `Promise`, Dart `Future`, Java `CompletableFuture`, C# `ContinueWith` | a new future plus closures per `then`                |
| Poll/waker            | Rust `Future`                                                            | none — composition flattens into one state machine   |
| Suspend-only          | Kotlin `suspend`, Swift `async`                                          | none; a future type appears only to hand work around |
| Channels              | Go                                                                       | needs cheap stacks                                   |

Zena is eager like JS, stackless like Rust, and `await`-primary like
Kotlin and Swift. Structurally it is closest to the poll/waker family
already: `Task` is a waker and `result()` is `poll` minus the
registration. The difference is eagerness, chosen deliberately in
[async.md](async.md) §1.1.

Three consequences for the callback layer:

- **`await` must not lower to `then`.** Through `subscribe(frame)` an
  await allocates nothing; through `then` it would allocate a closure and
  a future per suspension. Making the familiar API the primitive taxes
  the path that is actually hot.
- **`onComplete` and `then` are different operations.** A one-shot
  terminal callback mints no future; chaining does. `zena:async` has the
  former; `then`/`map`/`flatMap` are the ones that need the allocation,
  and they remain blocked on closures created inside generic code
  ([async.md](async.md) §2).
- **`catch` and `finally` are the weakest of the three.** Inside an async
  body they are `try`/`catch` and `try`/`finally` around the await, both
  of which work now that await-in-try has landed
  ([async.md](async.md) §6). JS has them because promises predated
  `await` by six years. `.finally()` in particular carries semantics that
  are easy to get subtly wrong — pass the value or error through, ignore
  the callback's return unless it throws — and `try`/`finally` supplies
  the same behavior with no new rules. ZIR does not lower `finally` yet
  ([async.md](async.md) §6), so the ordering is: lower `finally`, and the
  future case follows.

Layering, stated once: `subscribe(Task)` is the primitive;
`onComplete`/`then`/`catch` are library sugar over it; `await` bypasses
the sugar entirely.

## Parking

The parker blocks; it does not poll. `poll_oneoff` is a real sleep
(`time/wasi.zena:63`) despite the name, and nothing in this design polls
futures.

### Blocking is sound where it happens, and unmarked everywhere else

Blocking at the top of the drain is correct by construction:
`drainMicrotasks` runs the queue to empty _before_ it parks
(`async.zena:139`–`148`), and `TimerQueue.park` is reached only from
there. When the module blocks, nothing is runnable, so nothing is
starved.

Blocking anywhere else stops the world, and nothing marks it. `zena:fs`
imports `fd_read`, `fd_write` and `path_open` — ordinary synchronous WASI
p1 calls, callable from inside an async function, during which no frame
runs, no timer fires and no completion is processed. This is not unsound,
but it is the point at which "async" stops meaning anything, and the
cause is the stackless choice: with stackful coroutines a single task can
block, while with stackless frames blocking is always global. A function
that suspends and a function that blocks the world are indistinguishable
at the call site, and the language has no way to say which is which.
Naming that distinction is a separate design question; it is recorded
here because parking is where it surfaces.

**One live footgun.** `setParker` replaces any previous parker
(`async.zena:115`–`118`), and `zena:time` registers on first use.
[async.md](async.md) §4 argues for a single slot deliberately — waiting on
several sources means waiting on whichever is ready _first_, which a loop
over independent parkers gets wrong — and that reasoning is right, but
the mechanism does not enforce its own premise. The second module to
register silently disables the first, and the symptom is a timer that
never fires or a completion that never arrives. Only one caller exists
today, so it is latent; WASI sockets would make it real. `poll_oneoff`
takes an array of subscriptions, so the shape that matches the argument is
one WASI parker other modules _contribute subscriptions to_. Failing
that, `setParker` should throw on a second registration rather than
overwrite.

Under p3 none of this arises: blocking would serialize concurrent
component tasks the host could otherwise interleave, and returning WAIT
costs nothing.

It exists because the executor needs a way to say "nothing to run, but
not done". That can end three ways: the host re-enters through
`__zena_drain`, the module blocks, or nothing happens and the program has
deadlocked. Parking is the second, and it is the only one available under
`wasmtime --invoke main`, which is where the Level-0 and Level-1 tests
run ([async.md](async.md) §4). It cannot simply be deleted.

It is, however, smaller than [async.md](async.md) §4 reads, and there is
dead weight in it.

**Already WASI-only.** A3 made timers ordinary host-async on JS:
`time/host.zena` installs no `Clock`, registers no `Parker`, and never
imports `time/queue.zena`. `installClock` and `setParker` have exactly
one caller each, both under `time/wasi.zena`. On the size-sensitive
target none of it links.

**One protocol arm currently has no implementation.** `Clock.waitNs`
returns a boolean so that a host unable to block can report "I scheduled
a wake instead; unwind the drain", and `queue.zena:118` implements that
arm. The only `Clock` in the tree is `WasiClock`, whose `waitNs` returns
`true` unconditionally (`time/wasi.zena:91`), and the JS target no longer
reaches the queue at all. The arm should be **kept** — it is exactly what
a p3 clock wants, and
[component-emission.md](component-emission.md) plans a p3 timer as a
third `Clock` on that path — but both documents describe it as the JS
story, which A3 made stale.

**Shrink `Parker` to a hook.** An exported interface, `setParker`, a
module-level `var parker`, and a nested second drain loop
(`async.zena:97`–`148`) can be one nullable field on the queue and one
loop. Same behavior, three fewer exported names from `zena:async`.

**Move deadlock detection into the drain loop**, per the surface section
above. These are the same change.

**Do not generalize it.** Under a WASI p3 component the clock does not
block: the export returns WAIT and the host drives re-entry through the
callback ABI, which is the JS shape
([component-emission.md](component-emission.md)). `Parker` is a p1-era
artifact whose successor is the component backend, so multiple sources,
priorities, and fairness are all investment in the wrong place.

## The multi-value ramp

[async.md](async.md) §8.6 asks whether the future can be elided when it
is never observed, and leaves two obstacles standing. One of them
resolves cleanly.

**The queue hop is not elidable; the allocation is.** §8.6 hedges that
the hop "must survive even if the future does not" and that adjacency has
to be proven. The stronger statement is available: eliding the hop is
observable whenever anything else is queued.

```zena
let p = other();     // queues work
let x = await g();   // g completes synchronously
```

If the hop is skipped, `x`'s continuation runs ahead of whatever
`other()` queued. That is a reordering of the microtask queue, not a
timing subtlety, and it holds even in the adjacent-`await` shape. So the
rule is unconditional: **elide the allocation, always keep the hop.**
That makes the remaining work far smaller than the escape analysis §8.6
frames it as.

An async ramp returns `Future<T>` unconditionally, so a call that never
suspends allocates one anyway. Multi-value returns remove that:

```
inline (true, T, _) | inline (false, _, Future<T>)
```

The await site destructures. On the settled arm it stores the value into
its own frame and schedules that frame; only the suspending arm mints a
`Future`. Because the frame is itself the `Task` under the design above,
the preserved hop costs no allocation. `let x = await g()` for a
synchronously-completing `g` goes from eight objects to one.

Beyond that, **sinking the frame allocation past the first suspension
point** takes it to zero: run the entry segment on locals and materialize
the frame only when an `await` actually suspends. The entry segment is
entered exactly once and only from the ramp, so specializing it to locals
is well-founded, but it needs a real look at how much of the segment
would have to be duplicated. Named here as the endpoint, not as a plan.

## Order of work

Each step is independently shippable, and each shrinks the surface the
next one works against.

1. **Hole-initialized fields.** Compiler. Unblocks `#value: T`; the
   lowering already exists for frames.
2. **One pulling `Task`.** Stdlib plus the transform's `Resumable`
   binding. Deletes four types and every per-settle allocation.
3. **Inline the first waiter.** Stdlib only. Deletes the two eager
   arrays and their backing.
4. **`[result]()` adoption and deadlock detection in the drain.**
   Stdlib plus the transform's resume-point emission. (This step
   originally included deleting `Completer`; that reversed — see
   "`Completer<T>` is the write capability".)
5. **`Parker` to a hook.** Stdlib only.
6. **Multi-value ramp.** Compiler.

Steps 2, 3, and 5 need no compiler changes and account for most of the
allocation reduction.

One prerequisite sits outside this list and is not on its critical path:
hole-initialized fields, which step 1 needs and every other step lands
without — the `Box` simply survives until they do. Symbol identity was
the other, and it landed in `86e63185`, so `[result]()`'s privacy is real
rather than conventional.

## Risks

- **`Task` as a base class the frame extends** is the one item that could
  fail outright. Prototype before committing; the inline-first waiter
  shape is the fallback and loses only the allocation-free queue.
- **`_` as a field initializer** interacts with the checker's
  type-parameter cast rules (`checker.zena:4195`), which exist to stop an
  arbitrary `T` being minted from an unrelated representation. A hole is
  a zero value rather than a laundered one, so it should be admissible,
  but the rule needs reading before the syntax is added.
- **`Future.race`'s shared listener** had to become one node per input
  before the intrusive list could land. Done: race subscribes a
  `RaceWaiter` per input, each holding the input it reads.

## Open

- Whether frame sinking is worth the entry-segment duplication. Wants a
  measurement on a real async workload, which does not exist yet — the
  same gap [async.md](async.md) §8.6 notes.
- Whether the language should distinguish "suspends this frame" from
  "blocks the whole module" at the type level, per §Parking. Out of scope
  here; it becomes urgent when WASI I/O grows beyond timers.
