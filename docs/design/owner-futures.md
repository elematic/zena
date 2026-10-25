# Futures and streams that hold owners

## Status

Draft, 2026-10-25. Part of elematic/zena#284: switching `wasi:http` and
`zena-cli:host/http-server` to resource classes needs it, and so does the
open "lifted `future<T>` ownership" item there. Builds on ownership.md
§"Scoped type arguments", which already anticipates the class half of
`scoped T` (`class Channel<scoped T>`, "Fields typed in `T` are legal
inside such a class") but leaves it unimplemented.

## Overview

A `Future<Own<R>>` already compiles and runs. `zena:fs`'s `openAt`
returns `Future<Result<Own<Descriptor>, ErrorCode>>`, and an async
function declared `: Future<Own<Res>>` returns an owner the caller
awaits into a local (`execution/ownership/future-returns-owner.zena`).
The ownership rules stop at the future, though, so two programs that
should be rejected run instead:

```zena
async function make(): Future<Own<Res>> {
  return new Res();
}

async function twice(): Future<void> {
  let f = make();
  let a = await f;
  let b = await f;   // a second owner of the same resource
}                    // released twice

async function never(): Future<void> {
  let f = make();    // never awaited
}                    // the resource is never released
```

Run on 2026-10-25, `twice` releases the resource twice and `never`
releases it zero times. The same two holes exist for streams:
`Stream.stop()` drops elements it has not delivered without releasing
them, and the pump that lifts a typed WIT stream abandons elements it
lifted but could not deliver.

Nothing in the tree depends on either hole yet, but the next step of
#284 does. `zena-cli:host/http-server`'s `listen` yields a
`stream<tuple<request, response-writer>>`. `wasi:http`'s `consume-body`
returns trailers as a `future<result<option<trailers>, error-code>>`,
and `client.send` returns its response through an async result. Once
those resources are resource classes, every one of these is a future or
stream of owners. Today the HTTP code releases them by hand
(`disposeDeferred`, `drainFuture`, explicit `[Disposable.dispose]()`
calls in `zena:http`, `zena:fetch` and the protobuf transports).

## How the containers behave today

From a survey of `zena:async`, `zena:stream` and the synthesizer
(2026-10-25):

- `Future<T>` keeps a settled value in `#value: Box<T> | null` and
  never clears it. Every read hands out the same value: each `await`
  (`[valueOrThrow]` after resuming), each `then` callback, each
  combinator waiter. Several awaits of one future are legal by design
  (async-runtime-shape.md, "Typestate"), and
  `execution/async/deferred_future.zena` awaits one future twice.
- Adoption (`[adoptFrom]`, a `tail return` chain) copies the `Box`
  reference, so the source future and its adopter both stay readable.
- `Completer<T>` exposes its `future` as a field anyone can read any
  number of times. `tryComplete` on a settled future returns false and
  drops its argument.
- `DeferredFuture<T>` is a lifted WIT future. It holds two closures over
  the host's readable end: one that starts the read on the first
  subscription, one that drops the end if nothing ever subscribed. Its
  `[Disposable.dispose]` is called by hand.
- `Stream<T>` delivers each element once through its cursor, but holds
  the writer's buffer, not its own. `stop()` discards the undelivered
  part of that buffer.
- The checker records a move for `await` only on scoped operands.
  `typeCarriesOwner` does not look into class types, so a binding of
  type `Future<Own<R>>` is not affine and may be copied, stored and
  captured.
- The type-argument checks (#379) run where user code writes `new` or
  calls a generic. The future of an async function, `Completer`'s
  `new Future<T>()`, and the generic bodies of `zena:async` specialized
  at an owner never pass through them.

## The rule

**A `Future`, `Completer`, `DeferredFuture` or `Stream` instantiated at
a type that carries an owner is affine.** "Carries an owner" is the
containment walk the tuple rule already uses (`typeCarriesOwner`), so
`Future<Own<R>>`, `Future<Result<Own<R>, E>>` and
`Stream<(Own<A>, Own<B>)>` all qualify. The walk now looks inside these
four classes' type arguments. A first-class instantiation,
`Future<i32>` say, is unchanged: copyable, awaitable any number of
times.

These classes declare their parameter `scoped T`, which is what admits
an owner argument past the #379 check. That is the class half of the
modifier ownership.md describes; how their bodies are checked is under
"Checking the container bodies" below.

An affine future binding is move-checked like an `Own<R>` binding:

- **`await f` consumes `f`.** The awaiting frame is the one consumer,
  and the value it receives is an owner like any other.
- Passing it to an owning or `scoped` parameter, returning it, storing
  it, or capturing it moves it. A use after any of these is the
  use-after-move error, so the second `await` in `twice` above is
  rejected.
- A binding that nothing moves is released at scope exit
  (§"Releasing what nobody took").

Members that read the value without consuming the future are not
available on an affine instantiation: `then`, and the combinators
`all`, `race` and `any`, whose type parameters stay unrestricted and so
already reject an owner argument under #379. `Future.allSettled<scoped T>`
awaits each input once and is available. `runFuture<T>` reads once but
is unrestricted today; it can opt in when a program needs it.

### Completer

A `Completer<T>` holds no value; its future does. Two things change at
an owner `T`:

- **The future is handed out once.** `c.future` read twice would give
  two handles to one affine future. At an owner `T` the field is not
  readable; the pair is created together instead, by a static
  `Completer.create<T>(): (Completer<T>, Future<T>)` whose result is an
  affine tuple. The completer half stays copyable, since several
  writers racing to settle is a supported pattern.
- **A value that loses the race is released.** `complete(v)` moves `v`
  in. When the future is already settled, `tryComplete` releases `v`
  before returning false; `complete` goes through `tryComplete`, then
  throws. `Future`'s generic code cannot release a `T` by itself, so the
  release function comes from where `T` is concrete: the
  `Completer.create<T>()` call, which the compiler gives the same
  synthesized callback `[abandon]` takes (below). Open question 3.

### Streams

A `Stream<T>` at an owner `T` is affine: it has one reader, and moving
the stream moves that reader. Elements reach the reader in two ways:

- `readOne()` returns an affine `Future<Option<T>>`, consumed by its
  await.
- `for await (let x in stream)` binds each element to `x`, an owner
  released at the end of the iteration unless the body moves it.

`read(buf)`, the bulk copy into a caller's `FixedArray<T>`, needs an
array of owners, which #379 rejects; it is not available at an owner
`T`.

## Releasing what nobody took

An affine future released unconsumed has to release its value, and the
value may not exist yet. The release glue (a `DropPlan`, like a tuple's)
calls one new member of `Future`:

```zena
[abandon](release: (value: T) => void): void
```

It records that nothing will read the future again:

- **Settled with a value:** `release(value)` runs at once, and the box
  is cleared.
- **Settled with an error, or cancelled:** nothing to release.
- **Pending:** the callback is stored. The settle path (`tryComplete`)
  sees it and calls `release(value)` in place of storing the value, so
  nothing ever reads it. The producing frame keeps running; abandoning
  a first-class future does not cancel its producer.

The callback is synthesized at the release site, where `T` is concrete:
it applies `T`'s drop plan to the value, as the tuple glue does. That
keeps `Future`'s own code generic and leaves per-instantiation glue
where the compiler already generates it.

`DeferredFuture` overrides `[abandon]`:

- **Never subscribed:** drop the host's readable end
  (`future.drop-readable`). A value the host wrote is never transferred,
  so there is nothing on the guest side to release. This is what its
  `[Disposable.dispose]` does today, now called by the glue rather than
  by hand.
- **Read in flight:** behave as a pending `Future`. The lifted value is
  released when the read completes.

A `Stream` released unconsumed calls the same member on its pending
read, if there is one, and releases the undelivered part of the
writer's slice through a `release` callback of its own. `stop()` takes
that callback so an explicit stop releases them too. The typed WIT
stream pump releases what it lifted but could not deliver, and drops
the readable end so the host releases what it never sent.

## Checking the container bodies

ownership.md checks a `scoped T` body at the strictest discipline: every
`T` value consumed exactly once per path. `Future`'s body cannot pass
that check as written, because it reads `#value` once per waiter. For
an affine instantiation that body is still correct, because the affine
binding guarantees one consumer and so at most one read. But that
argument rests on use sites, which the body's checker cannot see.

Two ways to resolve it:

- **Trust the four classes.** A class-level marker, valid only in
  `zena:async` and `zena:stream`, exempts
  their bodies from the discipline while their instantiations follow
  the rule above. Soundness then rests on reviewed library code, the
  way intrinsics already do.
- **Restructure the bodies to pass.** Separate first-class and affine
  read paths, with the affine path consuming the box on its one read.
  This is checkable, but it duplicates `Future`'s read path, and it
  needs member-level conditions ("available only when `T` is
  first-class") that do not exist yet. Member-level `where` bounds
  (equality.md) are the planned mechanism.

The trusted marker is the proposal: four classes, all in the standard
library, each with a single read per consumer that is easy to audit,
and the restructuring can replace it once member-level bounds exist.

## The WIT bindings

The synthesizer changes in three places:

- **Lifted futures and streams** become affine instantiations
  automatically, through the containment walk. The `readFuture` helper
  lifts the payload once and hands it to the one consumer. The stream
  pump releases undelivered elements as above.
- **Tuple members carry owners.** `inAggregate` renders an owned
  resource inside a tuple as `Unmanaged<R>`, from before tuples could
  hold owners (#495). Tuple members now render `Own<R>`, so `listen`
  yields `Stream<(Own<Request>, Own<ResponseWriter>)>`. List elements
  and record fields keep `Unmanaged`, since an array or a record still
  cannot hold an owner.
- **Async results** (`openAt`) need nothing new: the wrapper's frame
  future becomes affine, so the caller's `await` consumes it.

`disposeDeferred` and `drainFuture` in `zena:http`, and their uses in
`zena:fetch` and the protobuf transports, go away. A trailers future
nobody reads is released by the glue.

## Staging

1. **Affinity and consumption (checker).** The containment walk looks
   inside the four classes. `await` and the moves above consume an
   affine future, a second use is the use-after-move error, and the
   value-reading members are rejected on affine instantiations. `twice`
   becomes a compile error.
2. **Release glue.** `[abandon]` in `Future`, `DeferredFuture` and
   `Stream`, and drop plans for affine futures and streams, everywhere
   implicit drop already runs: locals, parameters, fields, tuple
   elements, discarded results. `never` releases its resource.
3. **`Completer` at an owner `T`.** `Completer.create`, and release of a
   value that loses the race.
4. **Loop-variable release** for `for await` over a stream of owners.
5. **WIT.** Tuple members as `Own`; the manual disposal in `zena:http`,
   `zena:fetch` and the protobuf transports removed.

Then #284's `wasi:http` switch: the bindings, `zena:http`'s `Request`
and `Server`, and `zena:fetch`'s `Response`, as resource classes.

## Open questions

1. **The trust marker or the restructured bodies** (above). The proposal
   is the marker.
2. **Abandoning a pending future.** The proposal releases the value when
   it arrives and lets the producer run. Cancelling the producer as well
   is the other choice; for a scoped future ownership.md records
   cancel-plus-detach as a direction, not adopted, and for a first-class
   one the producer may have side effects the program still wants.
3. **How a losing `complete` gets its release function.** The proposal
   is an argument the compiler supplies at `Completer.create<T>()` when
   `T` carries an owner, the same callback `[abandon]` takes. The
   alternative is a member only an owner instantiation has
   (`tryComplete` returning the value it could not store), which waits
   on member-level conditions.
4. **The server's `Request` body (for #284, not this note).** A handler
   receives the request as a borrow, since middleware shares it, while
   reading the body consumes the wire request, which needs its owner.
   Either the server consumes the body when the request arrives and the
   `Request` holds the resulting stream, or handlers take ownership.
   The first keeps today's middleware shape.
