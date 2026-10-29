# Futures and streams that hold owners

## Status

Draft, revised 2026-10-29 (sixth revision). Part of elematic/zena#284: switching
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

For a restricted instantiation the read that resumes the waiter takes
the value and empties the value slot (§"The value slot"), so a read
after it fails. That alone would catch a second consumer only once it
reads. `Future` refuses the second consumer when it arrives, with one
boolean, `#claimed`: the first waiter, or the first future adopting this
one (`tail return`), sets it, and the next throws.

The waiter list cannot carry this. A settle hands the waiters to the
queue and empties the list before the first one runs, so between the
settle and that read nothing in `#waiters` or the slot says the value
is spoken for. Only a restricted specialization writes `#claimed`,
behind `isFirstClass<T>()`, so in a first-class one the field is never
written and dead-field elimination removes it. The object is 48 bytes
either way.

| `#state` | `#claimed` and slot | meaning for an owner future | a further await or adoption |
| -------- | ------------------- | --------------------------- | --------------------------- |
| pending  | unclaimed           | unclaimed                   | claims it                   |
| pending  | claimed             | claimed                     | throws: a second consumer   |
| settled  | claimed, slot full  | not yet read                | throws: a second consumer   |
| settled  | claimed, slot empty | taken                       | throws: a second consumer   |

Every `scoped T` class has an empty state for its takes. The body rules
(§"The class half of `scoped T`") let a field whose type carries `T` be
moved out at a restricted instantiation only as a take, which needs a
field that can be empty, so a taken value always leaves an empty slot
behind.

## Specialization

The two kinds of instantiation need different behavior from one source:
`Future<Own<R>>` must take rather than copy and refuse a second claim,
while `Future<i32>` must keep its several awaits. Zena compiles each
specialization of a generic class separately, so the source can branch
on a question the compiler answers per specialization, and the branch
folds away.

A specialization is keyed by representation, though, and a handle
erases to its resource class. `Future<Own<R>>`, `Future<Borrow<R>>` and
`Future<Unmanaged<R>>` share one body, and `Future<Scoped<F>>` shares
`Future<F>`'s. So the compiler answers for the body: a body whose type
arguments include a resource class serves a restricted instantiation,
and behaves as one (`representsRestricted` in types.zena, which #615's
takes already use). One intrinsic carries the answer:

- **`isFirstClass<T>(): boolean`**, a constant in each specialization:
  `true` for `Future<i32>` and `Future<Scoped<F>>`, whose restriction
  the static rules carry alone, and `false` for `Future<Own<R>>`,
  `Future<Borrow<R>>` and, since it shares their body,
  `Future<Unmanaged<R>>`.

`Future`'s read becomes a take, since a read of a field holding `T` is
one (§"The class half of `scoped T`"):

```zena
[valueOrThrow](): T {
  // ... rejected, cancelled and pending, as today ...
  return this.#value as T;   // a take; at a non-null restricted T, a
}                            // taken slot fails the cast
```

`[subscribe]` and `[adoptFrom]` both claim the value for its one
consumer (§"Runtime state"):

```zena
#claim(): void {
  if (!isFirstClass<T>()) {
    if (this.#claimed) {
      throw new Error('A future of an owner or a borrow has one consumer');
    }
    this.#claimed = true;
  }
}
```

and `[adoptFrom]` takes the source's value instead of sharing it. In
`Future<i32>`, `isFirstClass` is the constant `true`, so the waiter
check folds away. The read is a copy there, since codegen stores a
take's null only in a restricted specialization, and `as T` is the
identity.

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
the implicit drop calls the future's `[release]` where it would call a
resource's `:dispose`. `[release]` claims the value, so a later await
throws. A settled value is released at once. A pending one is marked
abandoned, and the settle releases it as it lands instead of waking
anyone: `#notify`, which every settle runs, adoption included, checks
the mark. A flag does what the one waiting consumer would, without an
object per drop. A future that settles with an error, or is cancelled,
leaves nothing to release. At a must-consume instantiation there is no
drop, because the drop it would serve is already an error.

The body cannot name a `T`'s release, so the compiler supplies it: the
`release_owned` intrinsic, `releaseOwned<T>(value)`, lowers to the
implicit drop of a `T` in each specialization. It reads ownership off
the representation, where `Own<R>`, `Borrow<R>` and `Unmanaged<R>` are
one body (§"Specialization"). That is right because only an owner's use
site calls `[release]`, and the intrinsic is private to `future.zena`
for the same reason.

The producing frame keeps running: a `Future` cannot cancel the work
behind it, since that work may have started other work or had other
effects. Cancelling it is what a `FutureClaim` is for (below).

A store into a `T` field that still holds a value would drop the old
value inside the body. At an owner the glue releases it before the
store, as a store into an owner field already does. At a must-consume
`T` the old value can be neither released nor kept, so the store
throws, a backstop like the second-waiter check. `Future` never stores
over a full slot, since it settles once.

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
is what carries the restriction out." #615 implements the fields, the
instance restriction, the takes, and returns of a `T` derived from
`this`; ownership.md lists them. This note adds the `isFirstClass<T>()`
branch:

- **Fields:** `T` may be stored in fields, bare, nullable, or as another
  `scoped` class's argument. The instance carries its argument's
  restriction (§"Restricted instantiations").
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
- **Moving a field's value out is a take.** Returning, binding or
  passing on the value of a field whose type holds `T` takes it: the
  field must be a `var` that is nullable at every restricted `T`, and
  the move leaves null. Reading it for a test such as `!= null` takes
  nothing. Codegen stores the null only in a restricted specialization,
  so at a first-class `T` the move is a copy. A `WithDefault<T>` field
  qualifies, since every restricted type is a reference (§"The value
  slot"). This is the rule #563 gave owner fields, and it is why
  `valueOrThrow` casts with `as T`: the taken check in the runtime state
  table is required by the types.

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
   an array or map literal. `twice` is a compile error. #615 did the
   class half of `scoped T`: `T` fields, instances that carry their
   argument's restriction, takes, and returns derived from `this`.
2. **The body rules and `Future`:** done in #619 (`WithDefault<T>`,
   `defaultValue<T>()`, and the rule against an unconstrained type
   parameter in a union), #624 (`isFirstClass<T>()`, without the static
   half of its branch, which no body needs yet), #635 (their
   declarations in `zena:core`), and #646: `Future` declares `scoped T`
   with a `WithDefault<T>` slot, takes it in `valueOrThrow`, `result()`
   and adoption, refuses a second consumer, and returns `tryComplete`'s
   loser. #613's check that names `Future` is gone.
3. **Release glue.** #649 releases an unconsumed future of an owner
   wherever implicit drop already runs: locals, parameters, tuple
   elements and discarded results (fields of that type are still
   rejected). `never` releases its resource. Streams follow with stage
   4. Still to do: `DeferredFuture`'s readable-end drop moving into the
   glue, once its `T` is `scoped`, and the release before a store into
   a full `T` field.
4. **`Completer.create`, streams (`stop()` returning what it has not
   delivered), and `FutureClaim`** at restricted types, with
   loop-variable release for `for await`.
5. **WIT.** Tuple members as `Own`; the manual disposal in `zena:http`,
   `zena:fetch` and the protobuf transports removed.

Then the `wasi:http` switch above.
