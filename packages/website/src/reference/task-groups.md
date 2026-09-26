---
title: 'Task Groups'
description: 'Structured concurrency with TaskGroup in Zena: spawning tasks, joining, loser-cancelling races, and error propagation.'
---

::: warning Active Development
Concurrency and asynchronous APIs in Zena are under active development.
Specifications, runtime behaviors, and standard library interfaces described on
this page are incomplete and evolving.
:::

Structured concurrency ensures that concurrent operations have bounded lifetimes
tied to the lexical structure of the program. In Zena, concurrent tasks are
coordinated using `TaskGroup` from `zena:async`.

## TaskGroup

A `TaskGroup` manages a dynamic collection of concurrently executing child
tasks.

```zena
import { TaskGroup } from 'zena:async';

let group = new TaskGroup();
```

### Scope inheritance

When a `TaskGroup` is instantiated:

1. It creates an internal `CancelScope` parented to whichever cancellation scope
   is currently ambient (`currentScope()`). `TaskGroup.detached()` creates a
   group whose scope has no parent instead.
2. If an ancestor scope cancels, the cancellation automatically cascades down to
   the task group and all tasks executing within it.
3. The group can be explicitly cancelled at any time by calling `group.cancel()`.
   The group is the only holder of that capability: work running inside it sees
   its scope read-only through `currentScope()` and cannot cancel it.
4. Its status can be checked via the `group.isCancelled` getter.

## Spawning tasks

Tasks are added to a group using `group.spawn()`:

```zena
let group = new TaskGroup();

let futureA = group.spawn(async (): Future<String> => {
  return await fetchResourceA();
});

let futureB = group.spawn(async (): Future<i32> => {
  return await fetchResourceB();
});
```

### The spawn contract

- **Factory lambda**: `spawn` takes a zero-argument function that returns a
  `Future<T>` (`() => Future<T>`).
- **Scope installation**: When `spawn` invokes the lambda, it installs the group's
  internal cancellation scope as the ambient scope for the duration of the
  initial synchronous ramp. The newly created async frame binds to this scope.
- **Eager execution**: As with any async function call, execution starts
  synchronously in the caller's turn up to the first unsettled `await`.
- **Returned future**: `spawn` returns the child's `Future<T>`. Callers can await
  it directly to consume individual return values, while the group tracks its
  overall completion.

## join and race

A task group provides two coordination patterns: waiting for all tasks to finish
with `join()`, or racing tasks with automatic loser cancellation using
`TaskGroup.race()`.

### Waiting for tasks with join()

The `join()` method returns a `Future<void>` that settles when every task
spawned in the group has finished:

```zena
let group = new TaskGroup();

for (let id in itemIds) {
  group.spawn(async (): Future<void> => {
    await processItem(id);
  });
}

// Wait for all spawned tasks to complete:
await group.join();
```

- If all tasks succeed, `join()` completes successfully.
- If one or more tasks fail, `join()` rejects with the first error encountered.
- Multiple calls to `join()` while tasks are outstanding share the same future.
- If a group goes idle, subsequent tasks can be spawned into it and joined again.

### Loser-cancelling races with TaskGroup.race

While `Future.race()` takes pre-existing, running futures and leaves losers
running in the background, `TaskGroup.race()` takes task factory closures and
**cancels all losers** as soon as the first candidate settles:

```zena
let fastestResult = await TaskGroup.race([
  () => fetchFromPrimaryServer(),
  () => fetchFromBackupServer(),
]);
```

1. Each candidate lambda is spawned as a child task in a new, dedicated `TaskGroup`.
2. The first task to complete—either with a value or an error—wins the race.
3. The group immediately cancels all other candidate tasks, terminating their
   in-flight network requests or computations at their next `await` checkpoint.
4. If an external cancellation arrives from an ancestor scope before any candidate
   finishes, the race future completes as cancelled.

## Error propagation

`TaskGroup` enforces fail-fast error handling across all concurrent children:

```zena
let group = new TaskGroup();

group.spawn(async (): Future<void> => {
  await sleep(milliseconds(100));
  throw new Error('Something went wrong');
});

group.spawn(async (): Future<void> => {
  // Runs until the sibling fails, then cancels at the next await:
  while (true) {
    await doWork();
  }
});

try {
  await group.join();
} catch (e: Error) {
  println('Group failed: ' + e.message);
}
```

### Sibling cancellation on failure

When any task spawned within a group fails with an unhandled exception:

1. **Error capture**: The group records the first error that occurred.
2. **Immediate sibling cancellation**: The group immediately cancels its internal
   `CancelScope`.
3. **Cooperative termination**: All sibling tasks in the group are interrupted at
   their next checkpoint (`await`) and unwind without executing remaining statements.
4. **Surface at join**: When `await group.join()` is called, the captured error
   is re-thrown.
5. **Suppression of secondary errors**: If additional siblings fail while
   unwinding, their errors are ignored so the initial root cause is preserved.

## Structured concurrency invariants

By using `TaskGroup`, asynchronous programs adhere to three fundamental
structural invariants:

1. **Lifetime bounding**: A concurrent child task never outlives the scope of the
   `TaskGroup` that spawned it. Code does not proceed past `await group.join()`
   until all background work has concluded.
2. **No orphaned tasks**: If an operation fails, all associated background work is
   promptly cancelled rather than left running invisibly, preventing resource
   exhaustion and memory leaks.
3. **Hierarchical cancellation trees**: Cancel scopes and task groups form a
   strict tree. Cancelling any branch propagates down to all child groups and
   tasks while leaving unrelated parent or sibling branches unaffected.
