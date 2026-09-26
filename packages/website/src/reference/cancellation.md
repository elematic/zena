---
title: 'Cancellation'
description: 'Structured cancellation in Zena: the cancellation channel, cancel scopes, checkpoints, and cleanup.'
---

::: warning Active Development
Concurrency and asynchronous APIs in Zena are under active development.
Specifications, runtime behaviors, and standard library interfaces described on
this page are incomplete and evolving.
:::

Cancellation terminates in-flight asynchronous operations when their results
are no longer needed.

Zena treats cancellation as a distinct channel from normal returns and thrown
exceptions. Cancellation is scoped to task hierarchies, delivered at suspension
checkpoints, and does not trigger `catch (e: Error)` blocks.

## The cancellation channel

Program outcomes follow three separate paths:

1. **Return values**: Results produced for the caller, including expected domain
   failures returned in signatures.
2. **Exceptions (`Error`)**: Failures that unwind the stack until caught by a
   matching `catch` block (see [Exceptions](/reference/exceptions/)).
3. **Cancellation**: Directives from an ancestor scope signaling that an operation
   is no longer needed. Intermediate frames run their cleanups and continue unwinding.

### Separation from exceptions

A `catch (e: Error)` block catches exceptions, but does not catch cancellation.
When an operation is cancelled, the stack unwinds through `catch` blocks without
invoking them, preventing code intended for error recovery from intercepting the
cancellation directive.

## Cancel scopes and task groups

Cancellation in Zena is managed through two classes from `zena:async`:

- `TaskGroup` creates a cancel scope, starts work inside it with `spawn`, and
  holds the `cancel()` for it. The group is the cancel capability: code can
  cancel the group's work only if the group's creator passed it the group.
- `CancelScope` is the read-only view of a scope that the work inside it sees.
  Its only public member is `isCancelled`. Code obtains the current scope with
  `currentScope()`, and nothing on it can cancel anything.

### Hierarchical scope trees

Scopes form a hierarchy mirroring the call tree:

- A cancel scope maintains a cancelled flag and a reference to its parent scope.
- Cancelling a group marks its scope and all descendant scopes as cancelled.
- Async tasks created within a scope inherit that scope as their parent, and a
  `TaskGroup` created inside a scope makes its own scope a child of it.

```zena
import { TaskGroup } from 'zena:async';

let group = new TaskGroup();
let result = group.spawn(() => fetchReport());

// Cancelling the group cancels every task started inside it:
group.cancel();
```

### Scope binding and frame storage

Async functions inherit their cancellation scope without signature annotations:

- **Captured at frame creation**: When an `async` function is called, its initial
  synchronous statements (the ramp up to the first `await`) run immediately in
  the caller's turn. During this ramp, the runtime captures the ambient scope
  from `currentScope()` and stores it in a private field on the async frame struct.
- **Direct checkpoint reads**: After frame creation, the frame does not query
  ambient state for cancellation checks. Each checkpoint evaluates the stored
  scope field directly on its own frame.
- **Executor restoration**: When a suspended task is dequeued to run on the
  microtask queue, the runtime executor sets `currentScope` to that task's scope
  for the duration of the turn, restoring the previous scope upon completion.
- **Stored callbacks**: Synchronous callbacks do not carry or track a cancellation
  scope. When an asynchronous callback is stored in a container (such as an
  event listener collection, cache, or queue) and executed later, it captures
  the scope that is ambient at the call site when invoked.

### Level-triggered state

Cancellation is **level-triggered**: once a scope is marked as cancelled, it
remains cancelled. Any subsequent checkpoint within that scope detects the
cancelled state and initiates unwinding.

### Delivery at checkpoints

Cancellation is delivered at **checkpoints** (points of asynchronous suspension
and resumption):

- **Entering `await`**: Before parking on an unsettled future, the runtime checks
  whether the scope is already cancelled. If so, it raises cancellation
  immediately, avoiding unnecessary subscription and allocation overhead.
- **Resuming from `await`**: When an awaited future settles (or when cancelling a
  scope actively wakes parked frames), the scope is checked immediately upon
  waking before any subsequent synchronous statements in the frame execute.

Synchronous code between `await` expressions executes without interruption.

### Detached groups

`new TaskGroup()` parents the group's scope to the ambient scope
(`currentScope()`). If an ancestor scope cancels, that cancellation cascades
downward to the group and its tasks.

To run work that must outlive its caller—such as shared cache fills or telemetry
daemons—use `TaskGroup.detached()`. A detached group's scope has no parent link:
cancelling an outer caller scope will not affect it, and only calling `.cancel()`
on the detached group itself will terminate its work.

To associate async tasks with a detached group, start them with `spawn`:

```zena
import { TaskGroup } from 'zena:async';

let cacheGroup = TaskGroup.detached();

function populateCache(key: String): void {
  // Binds the async task to cacheGroup's scope instead of the caller's
  cacheGroup.spawn(() => fetchAndCacheData(key));
}
```

### Explicit checkpoints: checkCancellation

Long-running CPU-bound synchronous code has no natural `await` suspension points.
To allow such loops to observe cancellation and unwind promptly, use
`checkCancellation()` from `zena:async`:

```zena
import { checkCancellation } from 'zena:async';

function processLargeDataset(items: Array<Item>): void {
  for (let item in items) {
    checkCancellation(); // Raises on cancellation channel if cancelled
    process(item);
  }
}
```

If the ambient scope is cancelled, `checkCancellation()` initiates cancellation
unwinding, triggering `finally` blocks and `using` disposals exactly like an
`await` checkpoint. If the scope is not cancelled, it performs a single boolean
check.

`currentScope().isCancelled` allows passive polling of cancellation status
without unwinding.

Cancellation is delivered at exactly three sites: entering an `await`, resuming
from one, and `checkCancellation()`. Each raises only if the current scope has
been cancelled through some group's `cancel()`. There is no way to raise a
cancellation directly, so a task cannot cancel its own awaiters.

## Cleanup on cancellation

When cancellation unwinds an execution frame (see [Blocks and Exits](/reference/blocks-and-exits/)),
active cleanups execute:

- Active [`using` resource statements](/reference/blocks-and-exits/) invoke
  `[Disposable.dispose]()` (see [Ownership and Resources](/reference/ownership/)).
- Active [`finally` blocks](/reference/exceptions/) execute.

```zena
async function fetchResource(url: String): Future<String> {
  using connection = openConnection(url);

  try {
    return await connection.readData();
  } finally {
    println('Runs on return, exception, or cancellation');
  }
}
```

### Shielded cleanup sections

Because a cancelled scope remains cancelled, subsequent `await` expressions
inside a cleanup handler would also trigger cancellation immediately.

When cleanup must perform asynchronous operations (such as closing a network
connection or flushing a buffer), execute the cleanup in a **`shielded` block**,
inside which checkpoints do not deliver cancellation:

```zena
try {
  await performTask();
} finally {
  shielded {
    await socket.flush();
    await socket.closeAsync();
  }
}
```

## Structured concurrency

`TaskGroup` also implements **structured concurrency**, where concurrent tasks
are bounded by lexical scope.

### Task group rules

1. **Bounded lifetime**: A task group does not complete until all of its child
   tasks have finished.
2. **Error propagation**: If a child task fails with an unhandled exception,
   remaining tasks in the group are cancelled, and the error propagates to the
   caller of `join()`.
3. **Cascade cancellation**: Cancelling a parent scope cancels all child tasks in
   its task groups.

```zena
import { TaskGroup } from 'zena:async';

async function fetchDashboard(): Future<DashboardData> {
  let group = new TaskGroup();

  let userTask = group.spawn(async () => fetchUser());
  let statsTask = group.spawn(async () => fetchStats());

  // Await all tasks; if one fails, the other is cancelled
  await group.join();

  return new DashboardData(await userTask, await statsTask);
}
```
