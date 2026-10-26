# Futures and streams that hold owners

## Status

Draft, revised 2026-10-26. Part of elematic/zena#284: switching
`wasi:http` and `zena-cli:host/http-server` to resource classes needs it,
and so does the open "lifted `future<T>` ownership" item there.

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
releases it zero times (`semantics/ownership/future-owner-consumed.zena`
and `execution/ownership/future-owner-abandoned.zena` record both). The
same two holes exist for streams: `Stream.stop()` drops elements it has
not delivered without releasing them, and the pump that lifts a typed
WIT stream abandons elements it lifted but could not deliver.

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
- `FutureClaim<T>` (`zena:async`, cancellation.md) is a future plus a
  counted claim on the work producing it. `split()` adds a holder;
  releasing the last claim cancels the work one queue turn later.
- The checker records a move for `await` only on scoped operands.
  `typeCarriesOwner` does not look into class types, so a binding of
  type `Future<Own<R>>` is not affine and may be copied, stored and
  captured.
- The type-argument checks (#379) run where user code writes `new` or
  calls a generic. The future of an async function, `Completer`'s
  `new Future<T>()`, and the generic bodies of `zena:async` specialized
  at an owner never pass through them.

## Affine instantiations

**A `Future`, `Completer`, `DeferredFuture`, `Stream` or `FutureClaim`
instantiated at a type that carries an owner is affine.** "Carries an
owner" is the containment walk the tuple rule already uses
(`typeCarriesOwner`), extended into these classes' type arguments, so
`Future<Own<R>>`, `Future<Result<Own<R>, E>>` and
`Stream<(Own<A>, Own<B>)>` all qualify. A first-class instantiation,
`Future<i32>` say, is unchanged: copyable, awaitable any number of
times.

The classes are polymorphic in affineness: one source serves both kinds
of instantiation. They say so on the type parameter (§"Declaring the
classes"), which is also what admits an owner argument past the #379
check.

An affine future binding is move-checked like an `Own<R>` binding:

- **`await f` consumes `f`.** The awaiting frame is the one consumer:
  the future is moved into the await, and its value moves out when the
  frame resumes.
- Passing it to an owning or `scoped` parameter, returning it, storing
  it, or capturing it moves it. A use after any of these is the
  use-after-move error, so the second `await` in `twice` above is
  rejected.
- A binding that nothing moves is released at scope exit
  (§"Releasing what nobody took").

A future of an owner therefore has at most one waiter. Members that hand
the value to anyone but that one waiter are not available on an affine
instantiation: `then`, and the combinators `all`, `race` and `any`,
whose type parameters stay unrestricted and so already reject an owner
argument under #379. `Future.allSettled<scoped T>` awaits each input
once and is available. `runFuture<T>` reads once but is unrestricted
today; it can opt in when a program needs it.

## Runtime state

Static tracking covers the program's bindings. It does not reach every
place a future travels: the executor's queues, the waiter list, adoption
chains, combinator waiters, and standard-library bodies specialized at
an owner without being checked again. Resources already have a backstop
for the place their static tracking stops. `Resource` keeps a runtime
`#state`, and `adopt` throws `ResourceStateError` on a resource that was
not disowned. An affine container gets the same kind of check: a second
consumer throws instead of releasing the value twice.

A container needs no new field for this when its own contents can say
"taken". `Future`'s can. For an owner instantiation, the read that
resumes the waiter takes the value and clears `#value`, and the existing
fields encode every state:

| `#state` | waiters and box | meaning for an owner future | a further await or read |
| -------- | --------------- | --------------------------- | ----------------------- |
| pending  | no waiter       | unclaimed                   | becomes the one waiter  |
| pending  | one waiter      | claimed                     | throws: a second claim  |
| settled  | box full        | available                   | takes the value         |
| settled  | box empty       | taken                       | throws: already taken   |

Both columns are needed. A future awaited after it settles never
registers a waiter, since `[subscribe]` schedules the frame at once, so
the box is the only mark that its value has gone.

A class whose `T` field is non-null has no empty value to leave behind
after a take. If such a class became affine at owner instantiations and
needed this check, it would need a hidden flag per object, the analogue
of `Resource`'s `#state`. The rule is the same either way: an affine
container carries a runtime check where values leave static tracking,
and uses its own fields as the state when they can show "taken".

## Specialization

The two kinds of instantiation need different behavior from one source:
`Future<Own<R>>` must take rather than copy and refuse a second claim,
while `Future<i32>` must keep its several awaits. Zena compiles each
specialization of a generic class separately, so the source can branch
on a question the compiler answers per specialization, and the branch
folds away. Two intrinsics carry it:

- **`carriesOwner<T>(): boolean`**, a constant in each specialization:
  `true` for `Future<Own<R>>`, `false` for `Future<i32>`.
- **`releaseValue<T>(value: T): void`**, which lowers to `T`'s drop plan
  (a resource's dispose, a tuple's per-element releases) and to nothing
  at a first-class `T`. A container body calls it wherever it drops a
  `T`, so the release is written down where it happens.

With them, `Future`'s read becomes:

```zena
[valueOrThrow](): T {
  // ... rejected, cancelled and pending, as today ...
  let stored = this.#value as Box<T>;
  if (carriesOwner<T>()) {
    this.#value = null;     // taken: a later read throws
  }
  return stored.value;
}
```

and `tryComplete` releases a value that lost the race:

```zena
[tryComplete](value: T): boolean {
  if (!(this.#state == FutureState.Pending)) {
    releaseValue(value);    // nowhere to go
    return false;
  }
  // ... as today ...
}
```

`[subscribe]` throws on a second waiter when `carriesOwner<T>()`, and
`[adoptFrom]` moves the box when it is, clearing the source. The checks
in the table are these branches.

## Releasing what nobody took

An affine future released unconsumed still owns its value, which may
not exist yet. The release glue, a `DropPlan` like a tuple's, registers
a **releasing waiter** in the one waiter slot. When the future settles,
or at once if it already has, the waiter takes the value and calls
`releaseValue`. A future that settles with an error, or is cancelled,
leaves it nothing to do. The producing frame keeps running: a `Future`
cannot cancel the work behind it, since that work may have started
other work or had other effects. Cancelling it is what a `FutureClaim`
is for (below).

`DeferredFuture` handles the waiter differently:

- **Never subscribed:** drop the host's readable end
  (`future.drop-readable`). A value the host wrote is never transferred,
  so there is nothing on the guest side to release. This is what its
  `[Disposable.dispose]` does today, now called by the glue rather than
  by hand.
- **Read in flight:** behave as a pending `Future`. The lifted value is
  released when the read completes.

## Completer

A `Completer<T>` holds no value; its future does. Two things change at
an owner `T`:

- **The future is handed out once.** `c.future` read twice would give
  two handles to one affine future. At an owner `T` the field is not
  readable; the pair is created together instead, by a static
  `Completer.create<T>(): (Completer<T>, Future<T>)` whose result is an
  affine tuple. The completer half stays copyable, since several writers
  racing to settle is a supported pattern.
- **A value that loses the race is released**, by `tryComplete`'s
  `releaseValue` above. `complete` goes through `tryComplete` and then
  throws.

## Streams

A `Stream<T>` at an owner `T` is affine: it has one reader, and moving
the stream moves that reader. Elements reach the reader in two ways:

- `readOne()` returns an affine `Future<Option<T>>`, consumed by its
  await.
- `for await (let x in stream)` binds each element to `x`, an owner
  released at the end of the iteration unless the body moves it.

`read(buf)`, the bulk copy into a caller's `FixedArray<T>`, needs an
array of owners, which #379 rejects; it is not available at an owner
`T`.

A stream released unconsumed releases its pending read through a
releasing waiter, and the undelivered part of the writer's slice
through `releaseValue`. `stop()` releases them the same way. The typed
WIT stream pump releases what it lifted but could not deliver, and
drops the readable end so the host releases what it never sent.

## FutureClaim

`split()` exists so several holders can await one result. With an owner
each of them would receive it, so at an owner `T` a `FutureClaim` is
single-holder: `split()` is unavailable. Releasing it releases the last
claim, which cancels the work, and its future is released like any
other: if a value arrives anyway, the releasing waiter releases it.

## Declaring the classes

ownership.md's `scoped T` admits owners too, but it checks the body at
the strictest discipline (every `T` consumed exactly once per path, and
no `T` in a field), which `Future`'s body cannot pass: it stores the
value in a field and copies it for each waiter of a first-class
instantiation. What these classes need is narrower, so they declare a
modifier of their own on the type parameter, proposed as `affine T`:

- an owner argument is admitted (#379's rejection does not apply), and
  so is any first-class argument; borrowed and scoped arguments are
  still rejected, since they need `scoped T`;
- an instantiation whose argument carries an owner is affine (§"Affine
  instantiations");
- the body may store `T` in fields, and uses `carriesOwner<T>()` and
  `releaseValue` where the two kinds of instantiation differ.

The body's handling of `T` is not checked statically; the runtime state
above is what makes an owner specialization safe. Checking it is a
later step: the checker could treat `T` as first-class inside a branch
on `carriesOwner<T>()` being false, and require a take everywhere else.

ownership.md had reserved the word `affine T` for an at-most-once
variant that the fold into `scoped T` made unnecessary. This is a
different meaning, and ownership.md §"Affine type arguments" points
here.

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

## What the `wasi:http` switch builds on this

With futures and streams of owners in place, #284's switch makes the
`wasi:http` and `zena-cli:host/http-server` bindings resource classes,
and with them:

- `zena:fetch`'s `Response`, which holds the wire response: a resource
  class whose body readers consume it (`text(this: Own<this>)`).
- `zena:http`'s `Request` and `Server`, resource classes. A handler owns
  the request: middleware moves it down the chain with `next(req)`, so
  calling `next` twice is a use-after-move error rather than the runtime
  "next() called more than once", and code after `next` reads what it
  needs from the request before handing it on. Whoever holds the request
  last consumes or releases its body.
- `zena:http`'s server `Response` holds no handle (its body is text,
  bytes or a `Stream<u8>`), so it stays an ordinary class.

## Staging

1. **Affinity and consumption (checker).** The containment walk looks
   inside `affine T` classes, the modifier admits owner arguments, and
   `await` and the moves above consume an affine future. A second use is
   the use-after-move error, and the members that hand out the value
   twice are rejected on affine instantiations. `twice` becomes a
   compile error.
2. **The two intrinsics** and the owner paths in `Future`: the take, the
   second-claim and taken checks, adoption moving the box, and
   `tryComplete`'s release.
3. **Release glue.** Drop plans for affine futures and streams that
   register the releasing waiter, everywhere implicit drop already
   runs: locals, parameters, fields, tuple elements, discarded results.
   `never` releases its resource. `DeferredFuture`'s readable-end drop
   moves into the glue.
4. **`Completer.create`, streams, and `FutureClaim`** at owner types,
   with loop-variable release for `for await`.
5. **WIT.** Tuple members as `Own`; the manual disposal in `zena:http`,
   `zena:fetch` and the protobuf transports removed.

Then the `wasi:http` switch above.

## Open questions

1. **The spelling `affine T`**, and whether user code may declare it or
   only `zena:async` and `zena:stream` may. Its safety comes from the
   runtime checks, which the declaring class has to write, so a user
   class that declares it and forgets them is unsound in the way a
   wrong `@external` signature is.
2. **Checking the bodies statically** (§"Declaring the classes"). Not
   needed for the five classes, whose owner paths are short and
   reviewed, but needed before user code declares the modifier.
