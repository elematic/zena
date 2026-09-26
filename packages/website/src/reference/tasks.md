---
title: 'Tasks'
description: 'Observable asynchronous operations in Zena: lifecycle states, supersession, operations, and combinators.'
---

::: warning Active Development
Concurrency and asynchronous APIs in Zena are under active development.
Specifications, runtime behaviors, and standard library interfaces described on
this page are incomplete and evolving.
:::

A `Future<T>` represents a single execution that is already underway. `Task<T>`
from `zena:task` represents an operation's observable lifecycle across multiple
runs. A task models the standing of an operation—unstarted, in flight, completed
with a value, or failed with an error—and manages latest-wins supersession when
runs overlap.

## The Task class

The `Task<T>` class wraps a startable operation (`Op<T>`) and exposes its
current state.

```zena
import { Task, Complete } from 'zena:task';

let profileTask = new Task(async () => await api.getProfile());
profileTask.run();

let profile: Profile = await profileTask.completed;

match (profileTask.state) {
  case Complete {value}: render(value)
  case _ => {}
};
```

### Construction

The constructor takes an operation and an optional state-change callback:

```zena
new(op: Op<T>, onChange: (() => void)? = null)
```

- **`op`**: The operation to run. An `Op<T>` is a function returning `Future<T>`
  (`type Op<T> = () => Future<T>`). Passing a function rather than an existing
  future allows the task to start fresh attempts on demand.
- **`onChange`**: An optional callback invoked whenever the task transitions
  state. The callback is scheduled on the microtask queue so it does not execute
  synchronously within the caller's stack frame.

The operation is specified at construction so that its operational policies
(such as timeouts and retry limits) are fixed. Parameterized runs supply inputs
by closing over variables or reading external state before calling `run()`.

## Task states

The standing of a task is represented by the `TaskState<T>` sealed class
hierarchy:

```zena
export sealed class TaskState<T> {
  case Initial, Pending, Complete, Errored
}
```

```zena
export final class Initial<T> extends TaskState<T> {}
export final class Pending<T> extends TaskState<T> {}
export final class Complete<T>(value: T) extends TaskState<T>
export final class Errored<T>(error: Error) extends TaskState<T>
```

A task always holds one of four states:

1. **`Initial<T>`**: No run has settled yet. This is the starting state of every
   newly constructed task.
2. **`Pending<T>`**: An operation is currently executing. `Pending` carries no
   future reference; callers cannot hold or await an in-flight future that might
   be superseded.
3. **`Complete<T>`**: The latest run finished successfully, holding the
   result in its `value` field.
4. **`Errored<T>`**: The latest run terminated with an error, holding the
   failure in its `error` field.

### Cancellation restoration

Cancellation is not a member of `TaskState<T>`. When an in-flight run is
cancelled, it neither returned a value nor threw an unhandled exception. The task
restores the settled state it held prior to that run: `Initial` if the task had
never settled, or the previous `Complete` or `Errored` state.

### Inspecting state

The current state is read through the `task.state` getter and matched
exhaustively:

```zena
let render = (task: Task<Profile>) => match (task.state) {
  case Initial: renderPlaceholder()
  case Pending: renderSpinner()
  case Complete {value}: renderDetails(value)
  case Errored {error}: renderError(error.message)
};
```

## Running and supersession

A run is started by calling `task.run()`.

```zena
let future = task.run();
```

Each invocation of `run()` executes the operation as the one member of a new
`TaskGroup`, whose scope is a child of the current one. The returned `Future<T>`
resolves with the result of that specific run.

### Supersession

If `run()` is called while a previous run is still pending, the task cancels the
previous run immediately:

1. The cancellation scope of the previous run is cancelled, terminating its
   timers, pending I/O, and child tasks.
2. The outcome of the previous run is discarded.
3. The task remains in `Pending` while executing the newly requested run.

Supersession enforces latest-wins semantics. Outdated responses cannot overwrite
newer state or trigger obsolete updates.

### Manual cancellation

Calling `task.cancel()` cancels the currently pending run:

```zena
task.cancel();
```

If a run is in flight, its cancellation scope is cancelled and the task restores
its previous settled state. If no run is in flight, `task.cancel()` does nothing.

### Eventual completion

The `task.completed` getter returns a `Future<T>` that resolves when the active
operation settles:

```zena
let profile = await task.completed;
```

Unlike the future returned by `run()`, `task.completed` carries across
supersession:

- If a pending run is superseded by another run, `completed` does not resolve
  for the superseded run. It remains pending and resolves when the superseding
  run settles.
- If the task is already in `Complete` or `Errored`, `completed` returns an
  already-settled future. Starting a new `run()` after settling mints a fresh
  completer for the new cycle.

## Operations and combinators

An `Op<T>` is a zero-argument function returning a future:

```zena
export type Op<T> = () => Future<T>;
```

Because an `Op<T>` is a function rather than an existing future, combinators can
re-invoke it to execute additional attempts.

The `zena:task` module provides combinators that transform an `Op<T>` into a
new `Op<T>` with added resilience policies.

### timeout

`timeout` bounds each attempt to a maximum wall-clock duration:

```zena
import { timeout } from 'zena:task';
import { milliseconds } from 'zena:time';

let boundedOp = timeout(milliseconds(500), fetchProfile);
```

The operation races the duration using `TaskGroup.race`. If the budget expires
first, the attempt is cancelled and fails with a `TimeoutError`.

### deadline

`deadline` bounds an operation against an absolute point on the monotonic clock:

```zena
import { deadline } from 'zena:task';
import { monotonic, seconds } from 'zena:time';

let target = monotonic() + seconds(5);
let boundedOp = deadline(target, fetchProfile);
```

All attempts share the same absolute deadline. An attempt initiated after the
deadline expires fails immediately without calling the underlying operation.

### retry

`retry` re-executes a failing operation up to a specified number of attempts:

```zena
import { retry } from 'zena:task';
import { milliseconds } from 'zena:time';

let resilientOp = retry(3, fetchProfile, milliseconds(100));
```

- **`attempts`**: The maximum number of attempts allowed. Must be at least 1.
- **`firstDelay`**: The optional initial wait duration between attempts. When
  positive, the delay doubles after each failed attempt (exponential backoff).

If all attempts fail, the error from the final attempt is propagated.

### fallback

`fallback` supplies an alternative operation if the primary operation fails:

```zena
import { fallback } from 'zena:task';

let safeOp = fallback(fetchPrimary, fetchBackup);
```

If `fetchPrimary` fails with an `Error`, its error is caught and `fetchBackup`
is executed.

### hedge

`hedge` launches a speculative second attempt if the first attempt does not
settle within a given delay:

```zena
import { hedge } from 'zena:task';
import { milliseconds } from 'zena:time';

let hedgedOp = hedge(milliseconds(50), fetchProfile);
```

Whichever attempt finishes first determines the result, and the slower attempt is
cancelled.

### Combinator composition

Combinators compose by wrapping operations. The order of composition determines
policy scope:

```zena
// Each of the 3 retry attempts has its own 200ms timeout budget.
let perAttemptTimeout = retry(3, timeout(milliseconds(200), fetchProfile));

// All attempts combined must finish within a single 500ms budget.
let globalTimeout = timeout(milliseconds(500), retry(3, fetchProfile));
```

### Cancellation transparency

Combinators act strictly on errors (`catch (e: Error)`). They do not catch or
retry cancellation directives:

- A cancelled attempt unwinds through the combinator hierarchy immediately.
- Combinators like `retry` and `fallback` do not intercept cancellation.
- Racing combinators (`timeout`, `hedge`) cancel loser branches using structured
  task groups.

## Observing state changes

`Task<T>` provides three mechanisms for observing state transitions:

1. **`onChange`**: The constructor callback, used to trigger UI re-renders.
2. **`completed`**: A future resolving to the latest settled value.
3. **`changed()`**: A wakeup future resolving on the next transition.

### The changed method

`task.changed()` returns a `Future<void>` that settles when the task next
changes state. Waiters share a single completer per transition round:

```zena
let watchTask = async (task: Task<Profile>): Future<void> => {
  while (true) {
    render(task.state);
    await task.changed();
  }
};
```

This pattern provides conflated updates. If multiple transitions occur while
the consumer is busy executing downstream work, the consumer resumes on the
next turn and reads the latest `task.state`. Intermediate transient states that
occurred while the consumer was unready are skipped.

### Streaming state transitions

`Task` does not expose a `Stream<TaskState<T>>` directly because streams impose
rendezvous backpressure where producers suspend until consumers read. A task
never suspends its state machine on an observer's consumption rate.

To expose transitions as a stream, an explicit forwarder loop can be written
using `changed()`:

```zena
import { Stream, StreamWriter } from 'zena:stream';
import { Task, TaskState } from 'zena:task';

let streamTask = <T>(task: Task<T>): Stream<TaskState<T>> => {
  return Stream.fromWriter(async (w: StreamWriter<TaskState<T>>) => {
    while (true) {
      await w.write(task.state);
      await task.changed();
    }
  });
};
```
