# Futures and streams that hold owners

## Status

Draft, revised 2026-10-27. Part of elematic/zena#284: switching
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
of instantiation. They say so with `affine T` on the type parameter
(§"The `affine T` modifier"), which is also what admits an owner
argument past the #379 check.

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

Every `affine T` class has such an empty state. The body rules
(§"The `affine T` modifier") let a field whose type carries `T` be read
at an owner instantiation only as a take, which needs a nullable field,
so a taken value always leaves a null behind for the check to find. No
class needs a hidden flag, the analogue of `Resource`'s `#state`,
beside its own fields.

## Specialization

The two kinds of instantiation need different behavior from one source:
`Future<Own<R>>` must take rather than copy and refuse a second claim,
while `Future<i32>` must keep its several awaits. Zena compiles each
specialization of a generic class separately, so the source can branch
on a question the compiler answers per specialization, and the branch
folds away. One intrinsic carries it:

- **`isFirstClass<T>(): boolean`**, a constant in each specialization:
  `true` for `Future<i32>`, `false` for `Future<Own<R>>`.

A `T` the body drops needs no intrinsic: it is released where it goes
out of scope, as an owned parameter or local is, in the specializations
where `T` carries an owner, and nothing happens at a first-class `T`
(§"The `affine T` modifier"). With that, `Future`'s read becomes:

```zena
[valueOrThrow](): T {
  // ... rejected, cancelled and pending, as today ...
  if (isFirstClass<T>()) {
    return (this.#value as Box<T>).value;   // a copy: several awaits
  }
  let stored = this.#value;    // a take: the field is left null
  if (stored == null) {
    throw new Error('the value of this future was already taken');
  }
  return stored.value;
}
```

`tryComplete`'s losing path releases the value by not using it:

```zena
[tryComplete](value: T): boolean {
  if (!(this.#state == FutureState.Pending)) {
    return false;              // `value` is released here at an owner T
  }
  this.#state = FutureState.Resolved;
  this.#value = new Box<T>(value);   // the one use on this path
  // ... as today ...
}
```

and `[subscribe]` refuses a second waiter:

```zena
if (!isFirstClass<T>() && this.#waiters != null) {
  throw new Error('a future of an owner has one waiter');
}
```

`[adoptFrom]` takes the source's box instead of sharing it. In
`Future<i32>`, `isFirstClass` is the constant `true`, so the take, the
null test and the waiter check all fold away.

## Releasing what nobody took

An affine future released unconsumed still owns its value, which may
not exist yet. The release glue, a `DropPlan` like a tuple's, registers
a **releasing waiter** in the one waiter slot. When the future settles,
or at once if it already has, the waiter takes the value into a local
and lets it go out of scope, which releases it. A future that settles
with an error, or is cancelled, leaves it nothing to do. The producing
frame keeps running: a `Future` cannot cancel the work behind it, since
that work may have started other work or had other effects. Cancelling
it is what a `FutureClaim` is for (below).

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
- **A value that loses the race is released** at `tryComplete`'s exit,
  above. `complete` goes through `tryComplete` and then throws.

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
releasing waiter, and the undelivered part of the writer's slice by
taking each element and letting it go out of scope. `stop()` releases
them the same way. The typed WIT stream pump releases what it lifted but
could not deliver, and drops the readable end so the host releases what
it never sent.

## FutureClaim

`split()` exists so several holders can await one result. With an owner
each of them would receive it, so at an owner `T` a `FutureClaim` is
single-holder: `split()` is unavailable. Releasing it releases the last
claim, which cancels the work, and its future is released like any
other: if a value arrives anyway, the releasing waiter releases it.

## The `affine T` modifier

ownership.md (§"The two axes, side by side") folds the opt-ins for
restricted type arguments into one modifier, `scoped T`, which admits
every universe and checks the body at the strictest discipline: each
`T` consumed exactly once per path. It records what the fold costs:

> exactly-once forbids a body that deliberately does nothing with a `T`
> so implicit drop releases it. … If a generic drop-style helper is
> ever needed, an at-most-once variant admitting only droppable
> universes can be added then.

`Future` needs exactly that. It drops a value in two places, an
abandoned future and the loser of a `tryComplete` race, and a scoped
value has no release, so a `scoped T` body cannot drop one. The
classes here declare the at-most-once variant, `affine T`:

- **Admitted arguments:** first-class types and owners, the universes
  that can be dropped. Borrowed and scoped arguments are rejected; they
  need `scoped T`.
- **Instantiations:** one whose argument carries an owner is affine
  (§"Affine instantiations").

The body is checked statically:

- **Fields:** `T` may be stored in fields.
- **The first-class branch:** where `isFirstClass<T>()` is known `true`,
  `T` is unrestricted, so copies and repeated reads are fine. A
  first-class instantiation's behavior, such as several awaits of one
  `Future<i32>`, is written there.
- **At most once:** everywhere else, a `T` value is used at most once
  per path: stored in a field, returned, passed to an owning, `affine` or
  `scoped` parameter, or moved into a binding. A second use is the
  use-after-move error.
- **Unused values are released.** A `T` value a path does not use is
  released where it goes out of scope, in the specializations where `T`
  carries an owner. The checker decides this on the generic body, as it
  does for an owned parameter. Lowering emits the release only where
  `T` is concrete and carries an owner.
- **Field reads are takes.** Outside the first-class branch, a read of
  a field whose type carries `T` is a take: the field must be a nullable
  `var`, and the read leaves null. This is the rule #563 gave owner
  fields. It is why `valueOrThrow` above has to handle a null box: the
  check the runtime state table describes is required by the types.

One runtime check is not required by these rules: the second waiter in
`[subscribe]`. Two subscriptions can only come from callers the checker
does not see, the executor and the combinators among them, so it guards
those.

Since the body is checked, a user class may declare `affine T` as well.

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

1. **The `affine T` modifier and affinity (checker).** The modifier
   admits owner arguments, and the containment walk looks inside
   `affine T` classes. `await` and the moves above consume an affine
   future, a second use is the use-after-move error, and the members
   that hand out the value twice are rejected on affine instantiations.
   `twice` becomes a compile error.
2. **The body rules:** `isFirstClass<T>()` and its branch, at-most-once
   use of `T`, release of an unused `T` per specialization, and field
   reads as takes. Then `Future`'s owner paths written under them: the
   take, the second-waiter check, adoption taking the box, and
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

1. **The value slot.** A take leaves the slot empty, so the slot must
   have an empty state. Today it is `#value: Box<T> | null`. Taking the
   box is a take of a nullable field. Reading the `T` out of the taken
   box is then a move out of a box the read owns, which needs `Box` to
   declare `affine T` and a rule that moving a box's one field out
   consumes the box. The alternative is a value union in place of the
   box (`(true, T) | (false, _)`), which uses the tuple moves #495
   already has. The cost is to `Future`'s allocation-free await path,
   which should be measured before choosing.
