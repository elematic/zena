# Tasks: an operation's observable lifecycle

`zena:task` holds the algebra over startable operations — `Op<T> = ()
=> Future<T>` and the combinators from `Op<T>` to `Op<T>` (`timeout`,
`deadline`, `retry`, `fallback`, `hedge`). This document designs the
type the module is named for: `Task<T>`, an object that runs an `Op`
and exposes where the run stands, in the style of
[@lit/task](https://github.com/lit/lit/tree/main/packages/task).

A future answers "what did this one start produce". A task answers a
question UIs and long-lived services actually ask: "what is the
current standing of this operation" — never started, in flight,
finished with a value, or finished with an error — across however many
runs, with a newer run superseding an older one. Holding a bare future
cannot express "not started yet" or "restarted"; a task's whole job is
to be that mutable cell, safely.

## The state, as data

```zena
export sealed class TaskState<T> {
  case Initial, Pending, Complete, Errored
}
export final class Initial<T> extends TaskState<T> {}
export final class Pending<T> extends TaskState<T> {}
export final class Complete<T>(value: T) extends TaskState<T>
export final class Errored<T>(error: Error) extends TaskState<T>
```

Four states, matching @lit/task. `Pending` deliberately carries no
future: handing out the in-flight future would let a caller await a
run that a later `run()` supersedes, and the task's contract is that
only the LATEST run's outcome ever becomes the state.

Cancellation is not a state. A run that completes cancelled was
neither answered nor failed — the task returns to the state it held
before that run (`Initial` if never settled, else the previous
`Complete`/`Errored`). This is the same stance `Outcome` and the
combinators take: cancellation propagates as an unwind, not as data,
and a resilience policy or a state cell that recorded it would be
recording the absence of an answer.

The hidden-state rule for futures (async-runtime-shape.md, "Why hiding
completion state is worth it") does not apply here, on purpose. A
future's state is hidden so a result channel cannot branch on
scheduling; a task IS the branch-on-standing affordance, built for
code whose job is to render or route on it. The two answer different
questions, which is why `Task` is not a method on `Future`.

## The class

```zena
export class Task<T> {
  new(op: Op<T>, onChange: (() => void) | null = null);

  /** Where the latest run stands. */
  state: TaskState<T> { get }

  /** Starts a run. A pending previous run is cancelled — its scope
   * is exited and its outcome is discarded, superseded before it
   * arrived. Returns this run's future, which settles the way the
   * run does even if superseded. */
  run(): Future<T>;

  /** Cancels a pending run and restores the previous settled state.
   * A task with no run pending is unchanged. */
  cancel(): void;

  /** The latest run's eventual answer: settles with the value or
   * failure of whichever run is current when one settles —
   * supersession carries it forward to the new run rather than
   * settling it. Already settled while the task holds `Complete` or
   * `Errored`; a run started after that mints a fresh one. */
  completed: Future<T> { get }

  /** Settles at the next state transition after the call. */
  changed(): Future<void>;
}
```

The observer is a constructor parameter, not a settable field: an
observer is part of what the task is for its whole life, and a
settable slot would let a second observer silently disconnect the
first.

The `Op` is given at construction, not per `run()`: an op is the
operation *with its policies already composed* —
`new Task(retry(3, timeout(100, fetchUser)))` — and a task that could
run a different op each time would be a cell of cells, with no way to
say what the task is a task *of*. Parameterizing a run ("fetch user
N") is closing over the parameter and building a new task, or making
the op read its argument from where the caller put it — the same
answer @lit/task gives with its `args` callback, minus the reactive
host that makes an implicit-args protocol pay for itself.

Each run starts its op inside a child `CancelScope`. That is what
makes supersession real: `run()` while pending cancels the previous
attempt's whole subtree — timers, spawned children — rather than
letting it race the new run for the state cell (the abandoned-promise
problem JS task helpers can only paper over). It is also what `cancel`
means; there is no second cancellation mechanism.

## Observation

Three surfaces, from cheapest to richest, each pull-shaped (read
`state` back for the payload, the shape `Waiter` set):

- **`onChange`**, the constructor callback: "schedule a re-render",
  for the render loop that is this type's bootstrap consumer. It runs
  after every transition, inside the microtask that settled the run —
  never inside `run()` itself (entering `Pending` is a transition
  like any other, but the notification arrives from the queue, after
  `run()` returns). The always-async rule holds: no user callback
  runs inside another's frame.
- **`completed`**, the latest run's eventual answer, lit's
  `taskComplete`: `await task.completed` is "give me the value when
  the dust settles", with supersession folded in — the future is
  carried forward to the superseding run instead of settling for the
  superseded one.
- **`changed()`**, the conflating wakeup: a future settling at the
  next transition. A consumer loop `while (true) { render(task.state);
  await task.changed(); }` sees every state it is fast enough to see
  and the latest one when it is not — which is the correct degradation
  for a type whose essence is latest-wins.

A `Stream<TaskState<T>>` of transitions is deliberately NOT a member.
`zena:stream` is a rendezvous with backpressure: a write completes
when the reader consumes it, and only one write may be pending — so a
task writing its own transitions would either suspend its progress on
its observer's consumption rate or throw on the second transition
while the reader lags. The stream view is instead five lines the
consumer owns, built on `changed()`:

```zena
let feed = async <T>(task: Task<T>, w: StreamWriter<TaskState<T>>): Future<void> => {
  while (true) {
    await w.write(task.state);   // backpressure: waits for the reader
    await task.changed();        // conflation: skips missed states
  }
};
```

Owning the loop is what answers whose child the forwarder is — the
consumer's scope — which a lazily-spawned member could only answer
with a detached scope. `changed()` itself costs one completer per
waiting round, allocates nothing when nobody calls it, and an
unreached method reaches no machinery at all.

Broadcast — several observers of one producer, each reading an
ordinary `Stream<T>` — is the `share` adapter streams.md names and
does not yet design: one reader fanning out to N subscriber channels,
each subscription choosing its policy (conflate, bounded buffer, or
block the producer) explicitly, because the implicit alternative is
the web `tee`'s unbounded buffering cliff. `changed()` is the
single-subscriber conflating case of that design, small enough to
ship without it.

## Boundaries

- **Re-running is the owner's job.** Auto-run needs something to
  observe the op's inputs, and the op deliberately has none — inputs
  are closed over. When signals land, the signal-aware layer
  (`AsyncComputed` in lit's terms) is a type that OWNS a task and
  decides when to call `run()`; the task stays the mechanism, the
  reactive layer stays the policy, and neither needs the other
  changed.
- **Caching is keyed by inputs, so it cannot live here.** A
  TanStack-style query cache is a map from key to task —
  `cache.task(userId)` handing back the same `Task` for the same
  key — a separate library built FROM tasks. A keyless memo ("do not
  re-run within 5s") is an `Op` combinator, and belongs with the
  others.
- **`Task` is a final class, not an interface.** The extension points
  are the op (compose policies in) and ownership (wrap a task, hold
  tasks in a cache); substituting a different implementation under
  the same name has no motivating consumer, and an interface can be
  extracted later without breaking either extension point. Code with
  TanStack-sized needs gets a separate library with its own name,
  built on this one.
- Not a job queue: a task runs one op, latest-wins. Fan-out belongs to
  `TaskGroup`.

## Implementation notes

`Task.run` is ordinary library code over `CancelScope.run`,
completers for `completed` and the `changed()` rounds, and the state
cell; no compiler support. The
supersession test — run, run again before the first settles, assert
the first attempt's `cancel` clause fired and the state took the
second's value — is the load-bearing one. The state classes reuse the
distributed-variant shape `Outcome` uses, including the zero-width
case field at `Complete<void>` that the case-constructor fix made
compile.
