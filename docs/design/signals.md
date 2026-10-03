# Signals

Status: **Implemented** as `zena:signals` (`packages/stdlib/zena/signals.zena`).
The class-field lowering in [Signals as class fields](#signals-as-class-fields)
is a proposal: the library has the primitive it lowers to, and nothing
generates it yet.

## Overview

A signal is a value that records which computations read it, so that
when it changes, exactly those computations are brought up to date.

```zena
import {State, Computed, effect, batch} from 'zena:signals';

let first = new State<String>('Ada');
let last = new State<String>('Lovelace');
let full = new Computed<String>((): String => first.get() + ' ' + last.get());

effect((): void => {
  console.log(full.get());          // prints "Ada Lovelace" now
});

batch<void>((): void => {
  first.set('Grace');
  last.set('Hopper');
});                                 // prints "Grace Hopper" once
```

The semantics follow the [TC39 signals proposal][tc39]: `State`,
`Computed`, `Watcher`, `untrack`, `currentComputed`, the introspection
functions, and the `watched`/`unwatched` callbacks behave as its
algorithm section describes. The proposal leaves effects to frameworks;
this module adds `Effect`, `batch` and `onCleanup`. It also adds
`Tracker`, a signal with no value, which lets a class keep a reactive
value in an ordinary field.

[tc39]: https://github.com/tc39/proposal-signals

## The API

| Name                                                             | What it is                                                                                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `State<T>`                                                       | A value with `get()` and `set(value)`.                                                                                                                                                   |
| `Computed<T>`                                                    | A cached function of other signals, run when read after a source changed. A subclass may override `compute()` instead of passing a function.                                             |
| `Watcher`                                                        | Told synchronously, inside `set`, when a watched signal might have changed. `watch(signal)`, `watch()` to re-arm, `unwatch(signal)`, `getPending()`. A subclass may override `notify()`. |
| `Effect`                                                         | A function run now and again after any signal it read changes. `effect(fn)` is shorthand for `new Effect(fn)`; `dispose()` stops it. A subclass may override `execute()`.                |
| `Tracker`                                                        | The dependency-tracking half of a `State`: `reportRead()` and `reportChanged()`, for a value stored elsewhere.                                                                           |
| `batch(fn)`                                                      | Runs `fn`, then the effects its writes caused.                                                                                                                                           |
| `onCleanup(fn)`                                                  | Registers `fn` to run before the current effect's next run, and when it is disposed.                                                                                                     |
| `untrack(fn)`                                                    | Runs `fn` without recording its reads.                                                                                                                                                   |
| `isTracking()`, `currentComputed()`                              | Whether a computed or effect is recording reads, and which.                                                                                                                              |
| `introspectSources`, `introspectSinks`, `hasSources`, `hasSinks` | As in the proposal.                                                                                                                                                                      |
| `SignalOptions<T>`                                               | `{equals?, watched?, unwatched?}`, the second argument of `State` and `Computed`.                                                                                                        |
| `Signal<T>`                                                      | An interface with `get()`, implemented by `State` and `Computed`.                                                                                                                        |
| `ReactiveNode`                                                   | The base class of all of the above, the type the introspection functions take and return.                                                                                                |

`import * as Signal from 'zena:signals'` gives the proposal's spelling,
`Signal.State` and `Signal.Computed`.

### Differences from the proposal

- **Effects.** The proposal expects effects to be built on a `Watcher`
  and a scheduler. `Effect` is a node of its own: it subscribes to what
  it reads, the way a watched computed does, and runs when the
  outermost write, `batch`, effect run or computed read finishes.
  [Effects](#effects) has the details.
- **Callbacks do not receive the signal as `this`.** The proposal calls
  the computed's function and the watcher's notify callback with the
  signal as `this`, so that one function can serve many signals without
  a closure each. Here the same need is met by subclassing:
  `Computed.compute()`, `Watcher.notify()` and `Effect.execute()` are
  methods a subclass overrides. A `Watcher` callback receives the
  watcher as a parameter, so `new Watcher((w) => …)` can refer to
  itself.
- **Default equality is `==`.** The proposal uses `Object.is`. `==` is
  the same for references without a custom `operator ==`, and differs
  for records and tuples (compared by value), for classes that define
  `operator ==`, and for `NaN`, which is never `==` to itself, so
  setting a `State<f64>` to `NaN` twice notifies twice.
- **`watched` and `unwatched` run when the operation finishes.** The
  proposal calls them in the middle of `watch`, `unwatch` or a
  recomputation, while the graph is being relinked. Here they are queued
  and run, with signals frozen as the proposal requires, once the
  operation that caused them has finished relinking. An error from one
  is thrown from that operation after all queued callbacks ran.
- **Several errors are one `SignalErrors`.** Where the proposal throws
  an `AggregateError` (several notify callbacks failed), this throws a
  `SignalErrors` holding them in order. One error is thrown as itself.
- **`watch` and `unwatch` take one signal per call**, because Zena has
  no rest parameters. `watch()` with no argument re-arms, as in the
  proposal.
- **`getPending()` returns `ReactiveNode`s.** The proposal's caller
  calls `.get()` on each, which needs the value type; in Zena the caller
  tests for the type it watches: `if (n is Computed<void>) n.get()`.
- **An `equals` that throws in `State.set` throws from `set`**, and the
  state keeps its old value. (In `Computed`, as in the proposal, the
  error becomes the computed's value.)

## Graph representation

### Nodes

Every node is one object, except that a `Computed` also has a
one-element array for its value ([Allocation](#allocation) says why).
The graph's bookkeeping is stored in fields
keyed by symbols the module does not export, so user code cannot see or
change it.

| Class                                  | Graph fields                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ReactiveNode` (all nodes)             | `flags: i32`, `version: i64`, `subs` and `subsTail` (the live consumers that read it), `readStamp: i64` |
| `Consumer` (computed, effect, watcher) | adds `deps` and `depsTail` (what it read), `seenEpoch: i64`, `nextQueued`                               |
| `State<T>`                             | adds `value: T`, `options`                                                                              |
| `Computed<T>`                          | adds the function, `options`, the cached value, the cached error                                        |

`flags` holds the node kind and its state: `DIRTY` (a source it read
directly changed), `CHECK` (a source further up changed, so it may be
stale), `COMPUTING`, `QUEUED`, `WATCHING` (a watcher that has not been
notified since it was last armed), `DISPOSED`, `HAS_VALUE`,
`HAS_ERROR`, `HAS_HOOKS`.

`version` increases each time the node's value changes. It is 64 bits
because a consumer compares the version it saw against the current one
for equality. At a million writes a second a 32-bit counter wraps in
about 72 minutes, and a computed that nothing read during exactly that
many writes would then see an equal version and return a stale value.

### Links

A dependency edge is one `Link`:

```
dep, depComputed, sub, version, nextDep, prevSub, nextSub
```

Every link is in its consumer's `deps` list, singly linked, in the
order the consumer first read each source on its last run. A link is
also in its source's `subs` list, doubly linked so it can be removed in
place, but only while the consumer is live.

A consumer is **live** when it is an effect, a watcher, or a computed
that a live consumer reads. Only live consumers are reachable from
their sources. A computed that nothing watches is referenced by nothing
in the graph, so the program can drop it and the garbage collector
takes it, which the proposal's memory-management section asks for.
When a computed gains its first live consumer it adds its own links to
its sources' `subs` lists, and when it loses its last one it removes
them, recursively in both directions.

`depComputed` is `dep` again, typed `Consumer`, when the source is a
computed. Checking a computed's sources has to bring computed sources
up to date, and without this field it would cast each one from
`ReactiveNode` to `Consumer`. On wasmtime a cast whose target is a
superclass of the object's class is a call into the runtime (see
[Measured costs](#measured-costs)).

## Algorithms

### Recording reads

When a computed or effect runs, the global `activeConsumer` points at
it and its `depsTail` starts at null. Each read calls `track`, which
moves `depsTail` along the list left by the previous run:

1. If the source was already read in this run, nothing happens. Each run
   gets a number from a global counter, and a source records the number
   of the run that last read it in `readStamp`, so this test is one
   comparison.
2. If the next link in the old list names the same source, it is reused:
   its version is updated and `depsTail` moves onto it.
3. Otherwise a new link is inserted at `depsTail`.

When the run ends, the links after `depsTail` are the sources the run
did not read again, and they are removed. A computed that reads the
same sources in the same order every run, which is the usual case,
allocates nothing when it runs again.

A source read in a different order on the next run gets a new link and
its old link is removed at the end. That costs an allocation, and
nothing is wrong afterwards.

### Writes: marking

`State.set(value)` compares the value with `equals`. If it is
different, it stores it, increments `version` and the global `epoch`,
and walks `subs`:

- a direct consumer that was clean becomes `DIRTY`, and its own
  consumers are walked with `CHECK`;
- a consumer that was already stale is not walked again; if it was
  `CHECK` and is now a direct consumer it becomes `DIRTY`;
- an effect reached this way is appended to the effect queue;
- a watcher with `WATCHING` set loses it and is appended to the watcher
  queue.

Then each queued watcher's notify callback runs, with reads and writes
forbidden, in the order the walk reached them. Then, if this write is
the outermost operation, the queued effects run.

Both queues are linked through each consumer's `nextQueued` field, so
marking and queueing allocate nothing.

### Reads: bringing a computed up to date

`Computed.get()` calls `refresh` and then records the read:

- `DIRTY`: run the function.
- `CHECK`: walk `deps` in order. For each computed source, `refresh` it
  first. If a source's version differs from the version the link
  recorded, run the function and stop walking: a source after it might
  not be read on the next run, and refreshing it could run code that is
  no longer needed. If no source changed, clear `CHECK` without running.
- Clean and live: nothing to do. A write would have marked it.
- Clean and not live: writes do not reach it, so it compares
  `seenEpoch` with the global `epoch`. If nothing at all was written
  since it was last up to date, nothing to do. Otherwise it walks
  `deps` as for `CHECK`.

Walking sources in the order they were read, and refreshing each
computed source before looking at its version, is the proposal's rule
of recomputing the deepest, left-most dirty computed first. It is what
makes the graph glitch-free: in the example in the overview, `full`
never runs with the new first name and the old last name.

When a computed runs, the new value is compared with the old one using
`equals`. If they are equal the old value is kept and `version` does
not change, so the consumers that are `CHECK` because of this computed
find nothing changed and do not run.

A function that throws stores the error as the computed's value, and
`get` throws it until a source changes.

Reading a computed that is `COMPUTING` throws, because it is a cycle.

### Effects

An effect is a consumer that is always live. Writes mark it the same
way they mark a computed, and add it to the effect queue. The queue is
drained by `settle`, which runs at the end of the outermost operation:
a `set`, a `batch`, an effect run, or a computed's run. A nesting
counter, incremented by each of these, says which one is outermost.

An effect taken off the queue is brought up to date like a computed:
`DIRTY` runs it, `CHECK` checks its sources first. So an effect that
reads a computed whose value did not change does not run.

An effect may write signals. The write queues more effects, and the
same `settle` loop runs them. A write inside a computed's function is
allowed, as in the proposal; the effects it queues run when the
outermost computed read finishes.

An effect created while another effect runs belongs to it: the owner
keeps a list of the effects it created and disposes them before it runs
again and when it is disposed. Without this, an effect that creates an
inner effect would leave one more inner effect subscribed on every run.

If an effect's first run throws, the constructor disposes it and throws.
An error from a later run is thrown from the operation that ran it,
after every queued effect has run.

## Allocation

| Operation                                           | Allocates                                             |
| --------------------------------------------------- | ----------------------------------------------------- |
| `new State(v)`                                      | the `State`                                           |
| `new Computed(fn)`                                  | the `Computed`, and a one-element array for its value |
| `effect(fn)`                                        | the `Effect`                                          |
| first read of a source by a consumer                | one `Link`                                            |
| a run that reads the same sources in the same order | nothing                                               |
| `set`, the marking, the watcher and effect queues   | nothing                                               |
| an untracked read                                   | nothing                                               |
| `Watcher.watch(s)`                                  | one `Link`                                            |
| `getPending()`, the introspection functions         | the returned array                                    |
| `batch(fn)`, `untrack(fn)`                          | the closure the caller wrote                          |
| a `watched`/`unwatched` callback                    | nothing after the first, which creates the queue      |
| a second error from callbacks in one operation      | a list, and the `SignalErrors`                        |

The `SignalOptions` record a caller passes is kept as is; reading
options does not allocate.

The `Computed` value array exists because a field of an arbitrary type
`T` needs a value from the constructor, and a computed has none until
its function first runs. A compiler-supported field that may be unset
until first written, checked by a flag, would remove it. For a `T`
that is a reference type this is a nullable struct field read with
`ref.as_non_null`; for a number it is the zero value.

The benchmark (below) runs its steady-state loops with no garbage
collection at all: in a `perf` profile of 20 million computed reruns,
taken on a module built ahead of time so that compilation is excluded,
no sample falls in the collector.

## Measured costs

`packages/stdlib/benchmarks/signals_bench.zena`, on wasmtime 47 through
`zena-cli run`, an idle machine (load average 0.5):

| Workload                                                               | Per operation          |
| ---------------------------------------------------------------------- | ---------------------- |
| `set`, then `get` at the end of a chain of 100 computeds               | 81 ns per computed run |
| the same chain written as plain objects calling each other, no signals | 2.1 ns per call        |
| one `set` read by 100 effects                                          | 58 ns per effect run   |
| `batch` of 100 `set`s, one effect reading all 100                      | 25 ns per set and read |
| `get` outside any computed                                             | 4.9 ns                 |

Most of the gap between the first two rows is two calls into the
wasmtime runtime that every Zena virtual method call makes. A class's
method table is a struct whose fields are untyped `funcref`s, so a
virtual call loads a `funcref` (`get_interned_func_ref`, a runtime call
on wasmtime, which stores function references in the GC heap as
indices) and casts it to the method's type (`is_subtype`, another
runtime call). An overriding method also casts `this` to its own class,
which is a runtime call when the object's class is a further subclass.
A computed's run makes two virtual calls: `run`, and the function
(`compute`, or the closure call inside it). Before `depComputed` was
added there were four, and the profile showed about half the time in
these runtime calls; with it, about 30%. Typing the method-table fields
with the methods' function types would remove the cast from every
virtual call in Zena.

## Signals as class fields

### What a field decorator would generate

A class with reactive fields written the obvious way holds a `State`
per field:

```zena
class Todo {
  title = new State<String>('');
  done = new State<boolean>(false);
}
```

Each `Todo` is then three objects, and every read of `done` loads the
`State` before loading the value. A field decorator could instead keep
the value in the class and a `Tracker` beside it, created only when
something reactive reads the field:

```zena
class Todo {
  @signal var done = false;
}
```

would become

```zena
class Todo {
  var #done = false;
  var #doneTracker: Tracker | null = null;

  done: boolean {
    get {
      if (isTracking()) {
        this.#doneTracker ??= new Tracker();
        (this.#doneTracker as Tracker).reportRead();
      }
      return this.#done;
    }
    set(value) {
      if (value != this.#done) {
        this.#done = value;
        let tracker = this.#doneTracker;
        if (tracker != null) {
          tracker.reportChanged();
        }
      }
    }
  }
}
```

`packages/stdlib/tests/signals/tracker_test.zena` has this class
written out and tested.

Compared with a `State` field:

- A `Todo` that no computed or effect ever reads is one object. Its
  fields cost one value and one null reference each, and reads and
  writes touch only the `Todo`.
- Every read loads the value from the `Todo` directly. Outside a
  computed it also reads one global, to find that nothing is tracking.
- A write with no tracker yet does nothing beyond storing the value:
  if no tracker exists, no consumer has ever read this field, so there
  is nothing to mark. This is also why the tracker can be created late.
- Once a computed reads the field, the `Tracker` exists and costs the
  same as a `State` without its value field.

The `Tracker` is created on the first read inside a computed, not on
the first read anywhere, so a class used outside reactive code never
creates one.

### Full explosion

The lowering above keeps one heap object per observed field. Removing
that too means a link's source can no longer be an object of its own: a
consumer that read `todo.done` has to name the pair (the `Todo`, the
`done` field). One representation:

- the class gains one subscriber list for all its reactive fields, and
  a version per field, stored inline;
- a `Link` gains a field index;
- writing field _i_ walks the class's subscriber list and marks only
  the links whose index is _i_;
- checking whether a source changed reads the version of field _i_
  from the class, which is a virtual call through an interface the
  class implements, since the graph code does not know the class.

This costs every consumer a virtual call per source check, and a write
walks every subscriber of every field of the object. It also has to
survive the class already extending something else, so the subscriber
list cannot come from a base class. The lazy tracker gets most of the saving (nothing allocated
for objects nobody observes, no indirection on reads) without these
costs, so it is the proposed lowering.

### Computed getters

A getter could be lowered the same way, to a field holding a lazily
created `Computed` subclass whose `compute()` calls the getter's body
on the owning object. That needs no closure per instance, only the
`Computed`, and only for objects whose getter is read in a reactive
context. The subclass is generated once per class.

## Compiler work this points at

- **Field decorators** that can generate private fields and accessors,
  for `@signal` and a computed getter. Zena's decorators today are
  built into the compiler ([decorators.md](decorators.md)).
- **Fields that may be unset until first written**, to drop the
  `Computed` value array.
- **Initializers on symbol-keyed fields.** `var [flags]: i32 = 0` fails
  in the code generator ("field name shape",
  [#717](https://code.rictic.com/justin/zena/issues/717)); the library
  sets these fields in constructors instead.
- **Typed method-table slots**, to take the `funcref` cast off every
  virtual call ([#718](https://code.rictic.com/justin/zena/issues/718)).
  This is the largest single cost in the measurements above, and it
  applies to all Zena code on wasmtime.

## Alternatives considered

**Arrays of sources per consumer.** The proposal's polyfill, from
Angular, stores a consumer's sources and the versions it saw in
parallel arrays, and a source's live consumers in another array with
each consumer's index in it. A run that reads the same sources writes
the same slots, so it allocates nothing either. In Zena each growable
array is two objects (the array and its storage), so a consumer with
one source costs four objects and its storage grows by copying. One
`Link` per edge, reused in order, is one object per edge with no
copying. [alien-signals][alien] uses the same linked-list layout in
JavaScript.

**Subscribing every computed to its sources.** Linking every consumer
into its sources' lists, whether live or not, makes writes reach every
computed and removes the epoch check. It also makes every computed
reachable from its sources for as long as they live, so an unwatched
computed is never collected, which the proposal asks implementations to
avoid.

**Effects on top of `Watcher`.** The proposal's sample effect is a
`Computed` watched by a shared `Watcher`, with a microtask to run
pending computeds. Each effect is then a `Computed` and a link from the
watcher, and every write runs the notify callback to schedule work.
Making the effect a consumer itself is one object, and its queueing is
part of the marking walk. `Watcher` remains for frameworks that need
their own scheduling, such as running effects once per frame.

[alien]: https://github.com/stackblitz/alien-signals

## Open questions

- **Scheduling effects later.** Effects run synchronously at the end of
  the outermost operation. A UI that wants them once per frame can use
  a `Watcher` today; a scheduler hook on `Effect` would let effects use
  the same queue.
- **Async.** Neither the proposal nor this module has async computeds.
  A computed whose function returns a `Future` caches the future.
