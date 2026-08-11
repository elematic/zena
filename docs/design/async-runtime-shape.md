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

## Allocation accounting

`let x = await g()`, where `g` is an async function that suspends once,
allocates eight objects on today's `main`:

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
input order, so `allOf` counts down and reads the inputs on the last
settle. The slots array and the N boxes go away.

This is a place where Zena can be cheaper than JS rather than merely as
cheap: `Promise.all` must keep its own results array precisely because a
`Promise` has no readable settled value.

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
2. `raceOf` subscribes **one shared listener** to every input
   (`async.zena:573`). A node can belong to one intrusive list, so race
   needs one node per input, as `allOf` already has.

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

The read that pull requires is the one part of `Future` that cannot be
removed. Everything that makes it _read_ as an implementation API can be.

```zena
export class Future<T> {
  /** The settled result. Resolved: (Resolved, value, null).
   *  Rejected: (Rejected, _, error). Pending: (Pending, _, null). */
  result(): inline (FutureState, T, Error | null);

  /** `t.run()` from the microtask queue once this future settles. */
  subscribe(t: Task): void;
}
```

Two methods, replacing `state`, `isCompleted`, `valueOrThrow`,
`onComplete`, `subscribe`, `subscribeResumable`, `complete`, and `fail`.
Four changes get there:

**Multi-value result rather than an accessor pair.** Three wasm stack
slots, no allocation, and the value cannot be obtained without its tag.
`if (let (Resolved, v, _) = f.result())` makes the guard structural — the
same discipline `Iterator.next()` already establishes, including the
"unspecified when the tag says otherwise" convention
([multi-return-values.md](multi-return-values.md)). A two-slot variant,
`inline (true, T) | inline (false, Error | null)` with a null error
meaning pending, is tighter and conflates two cases that are never
distinguished at a resume point; either is defensible.

**No `isCompleted` on the read side.** Branching on pending-ness is the
affordance that produces schedule-dependent behavior, and nothing needs
it. The combinators' "have I settled already" guard belongs to the write
side as `tryComplete(): boolean` / `tryFail(): boolean`, which is what
`raceOf` actually wants; that also retires `AllState.settled`,
`RaceState.settled`, and the double-settle throw.

**No throw in `result()`.** Deadlock is a property of the executor —
queue empty, nothing outstanding, root future still pending — not of any
individual future. Detecting it in the drain loop rather than in
`valueOrThrow` (`async.zena:288`) puts it where the information is, makes
it one check with one message instead of a check per resume point, and
removes a generic `Error` construction from every `Future<T>`
instantiation. Pending at a resume point is then unreachable by
construction, so `result()` traps there rather than throwing.

**No `complete`/`fail` on `Future`.** See below.

The throwing behavior `await` needs does not disappear; it moves to the
resume point, emitted by the transform as a compare-and-branch into one
shared non-generic helper. That is strictly smaller than today, where
`valueOrThrow` is a generic class method monomorphized per instantiation
even though nothing it does depends on `T`.

## `Completer<T>`'s removal

`Future.complete` and `Future.fail` are public today (`async.zena:306`,
`:324`), so `Completer<T>` enforces no read/write split — it is one extra
allocation and one extra class on every host-async operation and every
combinator, plus the `AnyCompleter` base and its vtable
(`async.zena:386`). Folding the write side into `Future` and renaming
`AnyCompleter` to `AnyFuture` leaves `zena:host-async`'s registry
unchanged in shape and removes an object from every asynchronous
operation in the language.

An enforced split is worth wanting, and a wrapper class is not how to get
it: [opaque-types.md](opaque-types.md) or the ownership work are the
tools, and either can be applied later without changing the runtime
shape.

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
4. **`result()`, `tryComplete`, deadlock detection in the drain, delete
   `Completer`.** Stdlib plus the transform's resume-point emission.
5. **`Parker` to a hook.** Stdlib only.
6. **Multi-value ramp.** Compiler.

Steps 2, 3, and 5 need no compiler changes and account for most of the
allocation reduction.

## Risks

- **`Task` as a base class the frame extends** is the one item that could
  fail outright. Prototype before committing; the inline-first waiter
  shape is the fallback and loses only the allocation-free queue.
- **`_` as a field initializer** interacts with the checker's
  type-parameter cast rules (`checker.zena:4195`), which exist to stop an
  arbitrary `T` being minted from an unrelated representation. A hole is
  a zero value rather than a laundered one, so it should be admissible,
  but the rule needs reading before the syntax is added.
- **Deleting `Completer`** is a stdlib API break for any code holding
  one, including `zena:host-async` and `@zena-lang/runtime`'s fixtures.
  Small today; larger the longer it waits.
- **`raceOf`'s shared listener** must become one node per input before
  the intrusive list can land.

## Open

- Whether `result()` returns three slots or the two-slot tagged union.
- Whether an enforced read/write split is wanted once `Completer` is
  gone, and whether `opaque type` or ownership is the tool.
- Whether frame sinking is worth the entry-segment duplication. Wants a
  measurement on a real async workload, which does not exist yet — the
  same gap [async.md](async.md) §8.6 notes.
