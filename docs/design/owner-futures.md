# Futures and streams that hold owners

## Status

Draft, revised 2026-10-27 (third revision). Part of elematic/zena#284: switching
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

Run on 2026-10-25, `twice` released the resource twice and `never`
released it zero times. Since #613 `twice` is a compile error
(`semantics/ownership/future-owner-consumed.zena`); `never` still
releases nothing (`execution/ownership/future-owner-abandoned.zena`). The
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

## Restricted instantiations

The containers declare `scoped T`, ownership.md's one opt-in for
restricted type arguments, and this note defines the half of it that
classes need (§"The class half of `scoped T`"). An instantiation carries
the restriction of its argument, decided by the containment walk the
tuple rule and the scoped-container rule already use
(`typeCarriesOwner`, `typeContainsSecondClass`), now extended into these
classes' type arguments:

- **At an owner** (`Future<Own<R>>`, `Future<Result<Own<R>, E>>`,
  `Stream<(Own<A>, Own<B>)>`), the instantiation is affine: moved, not
  copied, and released if nothing consumes it.
- **At a must-consume value** (`Future<Scoped<F>>`), it is
  must-consume itself, as a scoped container already is: consumed
  exactly once, never dropped.
- **At a borrow**, it is second-class, as any container of a borrow is.
- **At a first-class type** (`Future<i32>`), nothing changes: copyable,
  awaitable any number of times.

A restricted future binding is move-checked like an `Own<R>` binding:

- **`await f` consumes `f`.** The awaiting frame is the one consumer:
  the future is moved into the await, and its value moves out when the
  frame resumes.
- Passing it to an owning or `scoped` parameter, returning it, storing
  it, or capturing it moves it. A use after any of these is the
  use-after-move error, so the second `await` in `twice` above is
  rejected.
- A binding that nothing moves is released at scope exit
  (§"Releasing what nobody took"). A must-consume future gets no such
  release: leaving it unconsumed is the error ownership.md's
  required-consumption rule already reports.

A restricted future therefore has at most one waiter. Members that hand
the value to anyone but that one waiter are not available on a
restricted instantiation: `then`, and the combinators `all`, `race` and
`any`, whose type parameters stay unrestricted and so already reject a
restricted argument. `Future.allSettled<scoped T>` awaits each input
once and is available. `runFuture<T>` reads once but is unrestricted
today; it can opt in when a program needs it.

## Runtime state

Static tracking covers the program's bindings. It does not reach every
place a future travels: the executor's queues, the waiter list, adoption
chains, combinator waiters, and standard-library bodies specialized at
an owner without being checked again. Resources already have a backstop
for the place their static tracking stops. `Resource` keeps a runtime
`#state`, and `adopt` throws `ResourceStateError` on a resource that was
not disowned. A restricted container gets the same kind of check: a
second consumer throws instead of releasing the value twice.

A container needs no new field for this when its own contents can say
"taken". `Future`'s can. For a restricted instantiation, the read that
resumes the waiter takes the value and clears the value slot (§"The
value slot"), and the existing fields encode every state:

| `#state` | waiters and slot | meaning for an owner future | a further await or read |
| -------- | ---------------- | --------------------------- | ----------------------- |
| pending  | no waiter        | unclaimed                   | becomes the one waiter  |
| pending  | one waiter       | claimed                     | throws: a second claim  |
| settled  | slot full        | available                   | takes the value         |
| settled  | slot empty       | taken                       | throws: already taken   |

Both columns are needed. A future awaited after it settles never
registers a waiter, since `[subscribe]` schedules the frame at once, so
the slot is the only mark that its value has gone.

Every `scoped T` class has such an empty state. The body rules
(§"The class half of `scoped T`") let a field whose type carries `T` be
read at a restricted instantiation only as a take, which needs a
nullable field, so a taken value always leaves a null behind for the
check to find. No class needs a hidden flag, the analogue of
`Resource`'s `#state`, beside its own fields.

## Specialization

The two kinds of instantiation need different behavior from one source:
`Future<Own<R>>` must take rather than copy and refuse a second claim,
while `Future<i32>` must keep its several awaits. Zena compiles each
specialization of a generic class separately, so the source can branch
on a question the compiler answers per specialization, and the branch
folds away. One intrinsic carries it:

- **`isFirstClass<T>(): boolean`**, a constant in each specialization:
  `true` for `Future<i32>`, `false` for `Future<Own<R>>`,
  `Future<Borrow<R>>` and `Future<Scoped<F>>`.

`Future`'s read becomes:

```zena
[valueOrThrow](): T {
  // ... rejected, cancelled and pending, as today ...
  let value = this.#value;              // WithDefault<T>
  if (!isFirstClass<T>()) {
    this.#value = defaultValue<T>();    // a take: null at a restricted T
  }
  return value as T;    // at a non-null restricted T, a taken slot fails here
}
```

`[subscribe]` refuses a second waiter:

```zena
if (!isFirstClass<T>() && this.#waiters != null) {
  throw new Error('a future of a restricted value has one waiter');
}
```

and `[adoptFrom]` takes the source's value instead of sharing it. In
`Future<i32>`, `isFirstClass` is the constant `true`, so the take and
the waiter check fold away, and `as T` is the identity.

The body never drops a `T`. The one place it did, `tryComplete`'s losing
path, hands the value back instead, as tokio's `oneshot::Sender::send`
returns `Err(value)`:

```zena
[tryComplete](value: T): inline (true, _) | inline (false, T) {
  if (!(this.#state == FutureState.Pending)) {
    return (false, value);     // the caller decides
  }
  this.#state = FutureState.Resolved;
  this.#value = value;
  // ... as today ...
  return (true, _);
}
```

The caller holds the losing value under its own rules. An owner is
released by the existing release of a discarded owner result, or kept;
a must-consume value has to be consumed, so racing writers with one is
an error where the race is written. The callers in `zena:async` that
test the boolean today (`race` and `any` waiters, `TaskGroup`) match on
the tag instead.

## The value slot

`Future` keeps its value in `#value: Box<T> | null` today, so that a
settled future with a null value can be told from a pending one. The
`Box` costs an allocation per settle, and `#state` already makes that
distinction. The slot becomes `var #value: WithDefault<T>`, the type
operator type-operators.md plans for exactly this ("De-boxes
`Future`'s value slot"): `T` at a primitive, `T | null` at a reference.

That is enough for the take because **every restricted type is a
reference**: an owner, a borrow, a scoped future, and a `Result` that
holds an owner, which as a type argument is the boxed tuple
(core/result.zena: "stored in a variable, field or collection, it is a
boxed tuple"). So at every instantiation that takes, the slot is
nullable, and `defaultValue<T>()`, the operator's companion intrinsic,
is null there. A primitive is always first-class and never takes, so it
never needs an empty state.

The take is checked by the cast in `valueOrThrow`: at a non-null
restricted `T`, a slot that was already taken holds null, and `as T`
fails. At a nullable restricted `T` (`Future<Own<R> | null>`), null is a
legitimate value, so a second read returns null instead of failing.
Nothing is duplicated, since null owns nothing; only the error message
is lost.

## Releasing what nobody took

Dropping a restricted future is decided at the use site, never in the
container's body. Where the drop is legal, at an owner instantiation,
the future's drop plan (a `DropPlan`, like a tuple's) registers a
**releasing waiter** in the one waiter slot. When the future settles, or
at once if it already has, the waiter takes the value and releases it.
A future that settles with an error, or is cancelled, leaves it nothing
to do. At a must-consume instantiation no drop plan exists, because the
drop it would serve is already an error.

The producing frame keeps running: a `Future` cannot cancel the work
behind it, since that work may have started other work or had other
effects. Cancelling it is what a `FutureClaim` is for (below).

`DeferredFuture` handles the waiter differently:

- **Never subscribed:** drop the host's readable end
  (`future.drop-readable`). A value the host wrote is never transferred,
  so there is nothing on the guest side to release. This is what its
  `[Disposable.dispose]` does today, now called by the glue rather than
  by hand.
- **Read in flight:** behave as a pending `Future`. The lifted value is
  released when the read completes.

## Completer

A `Completer<T>` holds no value; its future does. At a restricted `T`:

- **The future is handed out once.** `c.future` read twice would give
  two handles to one restricted future. At a restricted `T` the field is
  not readable; the pair is created together instead, by a static
  `Completer.create<T>(): (Completer<T>, Future<T>)` whose result is a
  restricted tuple. The completer half stays copyable, since several
  writers racing to settle is a supported pattern.
- **A value that loses the race comes back** from `tryComplete`, above.
  `complete(v)` on a settled future still throws while it holds `v`.
  That is a programming error, and it falls in the gap ownership.md
  already records for an exception raised while a must-consume value is
  live (§"Required consumption").

## Streams

A `Stream<T>` at a restricted `T` has one reader, and moving the stream
moves that reader. Elements reach the reader in two ways:

- `readOne()` returns a restricted `Future<Option<T>>`, consumed by its
  await.
- `for await (let x in stream)` binds each element to `x`, consumed or
  released by the iteration's body as any binding is.

`read(buf)`, the bulk copy into a caller's `FixedArray<T>`, needs an
array of restricted values, which #379 rejects; it is not available at a
restricted `T`.

The stream's body does not drop elements either. `stop()` at a restricted
`T` returns the elements it has not delivered, as `tryComplete` returns
its loser. Dropping a whole `Stream<Own<R>>` is use-site glue again: its
drop plan releases the pending read through a releasing waiter and the
undelivered elements one by one. A stream of must-consume values is
must-consume itself, so it has to be read to the end. The typed WIT
stream pump releases what it lifted but could not deliver, and drops the
readable end so the host releases what it never sent.

## FutureClaim

`split()` exists so several holders can await one result. With a
restricted value each of them would receive it, so at a restricted `T`
a `FutureClaim` is single-holder: `split()` is unavailable. At an owner,
releasing the claim releases the last claim, which cancels the work, and
its future is dropped like any other: if a value arrives anyway, the
releasing waiter releases it. At a must-consume `T` the claim's future
must be awaited, so the claim cannot be released early.

## The class half of `scoped T`

ownership.md (§"Scoped type arguments") makes `scoped T` the one
modifier for restricted type arguments, and says it applies to class
type parameters: "Fields typed in `T` are legal inside such a class;
they are the container's substance, and the instantiated container type
is what carries the restriction out." It leaves that half unimplemented.
This note defines it, with one addition, the `isFirstClass<T>()` branch:

- **Fields:** `T` may be stored in fields. The instance carries its
  argument's restriction (§"Restricted instantiations").
- **The first-class branch:** where `isFirstClass<T>()` is known `true`,
  `T` is unrestricted, so copies and repeated reads are fine. A
  first-class instantiation's behavior, such as several awaits of one
  `Future<i32>`, is written there.
- **Exactly once elsewhere:** outside that branch, the body is checked at
  ownership.md's strictest discipline. Each `T` value is consumed
  exactly once per path: stored in a field, returned, passed to an
  owning or `scoped` parameter, or moved into a binding. A second use is
  the use-after-move error, and a path that leaves a `T` unconsumed is
  the required-consumption error. A value with nowhere to go is handed
  back to the caller, as `tryComplete` and `stop()` do.
- **Field reads are takes.** Outside the first-class branch, a read of
  a field whose type carries `T` is a take: the field must be a `var`
  that is nullable at every restricted `T`, and the read leaves null.
  A `WithDefault<T>` field qualifies, since every restricted type is a
  reference (§"The value slot"). This is the rule #563 gave owner
  fields, and it is why `valueOrThrow` casts with `as T`: the taken
  check in the runtime state table is required by the types.

One runtime check is not required by these rules: the second waiter in
`[subscribe]`. Two subscriptions can only come from callers the checker
does not see, the executor and the combinators among them, so it guards
those.

No second modifier is needed. Dropping a restricted value, which an
at-most-once variant (ownership.md's reserved `affine T`) would have
permitted, happens only at use sites, where each kind of value already
has a rule: an owner is released by glue, and a must-consume value
cannot be dropped at all.

## The WIT bindings

The synthesizer changes in three places:

- **Lifted futures and streams** become restricted instantiations
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

1. **Restricted instantiations (checker).** #613 did the owner case for
   `Future`: `await` and the moves above consume a future of an owner, a
   second use is the use-after-move error, `then` is rejected on it, and
   so is binding it to an unrestricted type parameter, including through
   an array or map literal. `twice` is a compile error. What remains is
   the class half of `scoped T`, which admits restricted arguments to
   classes and makes the containment walks look inside `scoped T`
   classes, replacing #613's check that names `Future`.
2. **The body rules:** `isFirstClass<T>()` and its branch, exactly-once
   use of `T` elsewhere, and field reads as takes; the `WithDefault<T>`
   operator and `defaultValue<T>()`, with `Future`'s slot de-boxed onto
   them. Then `Future`'s
   restricted paths written under them: the take, the second-waiter
   check, adoption taking the value, and `tryComplete` returning its loser
   (with `zena:async`'s callers matching on it).
3. **Release glue.** Drop plans for owner futures and streams that
   register the releasing waiter, everywhere implicit drop already
   runs: locals, parameters, fields, tuple elements, discarded results.
   `never` releases its resource. `DeferredFuture`'s readable-end drop
   moves into the glue.
4. **`Completer.create`, streams (`stop()` returning what it has not
   delivered), and `FutureClaim`** at restricted types, with
   loop-variable release for `for await`.
5. **WIT.** Tuple members as `Own`; the manual disposal in `zena:http`,
   `zena:fetch` and the protobuf transports removed.

Then the `wasi:http` switch above.
