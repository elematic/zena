---
title: 'Async Programming'
description: 'Asynchronous programming in Zena: async/await, Future<T>, execution semantics, async main, combinators, and structured cancellation.'
---

Zena provides built-in support for asynchronous programming using `async`
functions, `await` expressions, and the `Future<T>` type. Async execution is
cooperative and deterministic, compiling to state machines that run on a
lightweight microtask queue.

## The async/await model

An asynchronous function is marked with the `async` modifier:

```zena
async function fetchUser(id: i32): Future<String> {
  let response = await fetch(`https://api.example.com/users/${id}`);
  return response.text();
}
```

Arrow functions and class methods can also be `async`:

```zena
let loadConfig = async (path: String): Future<Config> => {
  let raw = await readFile(path);
  return parseConfig(raw);
};

class Service {
  async start(): Future<void> {
    await initializeDatabase();
  }
}
```

### Return types and Future&lt;T&gt;

The return type of an `async` function is always `Future<T>`. Inside the function
body:

- A `return expr;` statement where `expr` has type `T` completes the returned
  future with that value.
- Returning another future `Future<T>` forwards the result of that future
  without extra suspension overhead.
- If no return type is annotated, the compiler infers `Future<T>` from the
  body's `return` expressions.

`Future<T>` is available globally from the prelude without explicit imports.

### The `await` expression

The `await` operator pauses execution of the enclosing `async` function until the
awaited future settles:

- If the future resolves successfully, `await` produces the unpacked value of
  type `T`.
- If the future fails, `await` throws the underlying error, which can be caught
  with a standard `try`/`catch` block.

```zena
try {
  let user = await fetchUser(42);
  console.log(user);
} catch (e) {
  console.log(`Failed to fetch user: ${e.message}`);
}
```

`await` is valid only directly inside `async` function bodies.

::: note Explicit suspension and cancellation points
Because Zena is statically typed, the compiler knows when an expression produces
a `Future<T>` and could theoretically auto-suspend calls without `await`.
However, Zena requires explicit `await` so that suspension boundaries remain
clear and visible in source code. Every `await` is an asynchronous yielding point
and a potential **cancellation checkpoint**.
:::

## Execution model: Eager start and concurrency

Zena's async execution follows an eager-start, single-threaded cooperative
model.

### Eager execution

Calling an `async` function begins executing its body **synchronously and
immediately** until it encounters the first `await` on an unsettled future. At
that point, it suspends and returns a pending `Future<T>` to the caller.

### Concurrent execution

Because async functions start immediately upon invocation, concurrent operations
can be started simply by invoking functions before awaiting their results:

```zena
// Both network requests start immediately and run concurrently:
let futureA = fetchResource('/api/items');
let futureB = fetchResource('/api/pricing');

// Await both results when needed:
let items = await futureA;
let pricing = await futureB;
```

### Run-to-completion guarantees

Between `await` suspension points, synchronous code runs to completion without
preemption. There are no background thread context switches or shared-memory
data races within an async task.

Continuations resume in deterministic order from a FIFO microtask queue managed
by the Zena runtime.

## Async main

Zena allows the top-level `main()` entry point of a program to be `async`:

```zena
export async function main(): Future<i32> {
  console.log('Starting application...');
  let config = await loadConfig('config.json');
  await runServer(config);
  return 0;
}
```

When `main()` is asynchronous, the runtime executes the initial synchronous
segment, enters the event loop, and drains the microtask queue until all pending
tasks complete. If unhandled futures remain unsettled with no active I/O or
timers, the runtime reports a deadlock error.

## Futures and combinators

The standard library provides utilities for constructing, combining, and
bridging futures.

### Immediate futures

Create already-settled futures with `Future.of` and `Future.failed`:

```zena
let success = Future.of(42); // Future<i32> already resolved
let failure = Future.failed<String>(new Error('Not found'));
```

### Concurrent combinators

Use `Future.all` and `Future.race` to coordinate multiple futures:

- **`Future.all`**: Accepts an array of futures and returns a
  `Future<Array<T>>` that resolves when all input futures have succeeded, or
  fails immediately if any input future fails.
- **`Future.race`**: Resolves or fails with the outcome of whichever input
  future settles first.

```zena
let results = await Future.all([
  fetchEndpoint('/data/1'),
  fetchEndpoint('/data/2'),
  fetchEndpoint('/data/3'),
]);

let fastest = await Future.race([
  fetchFromPrimary(),
  fetchFromReplica(),
]);
```

### Completers

A `Completer<T>` from `zena:async` serves as a manual bridge between callback-based
APIs or external events and Zena futures:

```zena
import { Completer } from 'zena:async';

let completer = new Completer<String>();

// Pass a callback to an external system:
hostEventEmitter.once('data', (data: String) => {
  completer.complete(data);
});

hostEventEmitter.once('error', (err: Error) => {
  completer.fail(err);
});

// Await the completer's future:
let result = await completer.future;
```

### Timers and sleep

To pause execution asynchronously for a duration, use `sleep` from `zena:time`:

```zena
import { sleep } from 'zena:time';

async function retryOperation(): Future<void> {
  for (var attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await performTask();
      return;
    } catch (e) {
      console.log(`Attempt ${attempt} failed, retrying in 100ms...`);
      await sleep(100);
    }
  }
}
```

## Structured cancellation

Long-running or redundant async tasks can be cancelled cooperatively using
cancellation scopes.

### Checkpoint delivery and unwind propagation

In async functions, cancellation is delivered at **checkpoints** (suspension
points on `await`). When a task is cancelled, the cancellation propagates through
the call stack like an exception, but on a dedicated runtime channel distinct
from ordinary errors.

If a synchronous function is executing when cancellation is raised (for instance,
by a cancellation check or an explicit cancellation call), the cancellation
unwinds through all synchronous stack frames.

As cancellation unwinds through the stack:

- **`finally` blocks** execute unconditionally in both synchronous and
  asynchronous functions, ensuring acquired files, locks, and network sockets
  are closed cleanly.
- **`using` resource declarations** are automatically disposed.
- **`catch (e)` blocks** ignore cancellation entirely and will not swallow it,
  preventing tasks from accidentally resuming cancelled work.

```zena
import { CancelScope } from 'zena:async';

let scope = new CancelScope();

let worker = async (): Future<void> => {
  try {
    while (true) {
      await performStep();
    }
  } finally {
    console.log('Worker cleaned up successfully');
  }
};

// Cancel the scope to stop the worker:
scope.cancel();
```

### The `cancel` clause in `try`

In addition to `catch` and `finally`, a `try` block can define a `cancel`
clause that runs specifically when the block is unwound due to cancellation:

```zena
try {
  let rows = await db.query(queryString);
  return render(rows);
} cancel {
  metrics.increment('query_cancelled');
} catch (e) {
  return errorPage(e);
} finally {
  releaseBuffers();
}
```

The `cancel` block executes cancellation-specific rollback or logging, after
which cancellation continues unwinding the stack unconditionally. Control-flow
statements that suppress unwinding (such as `return`, `break`, or `continue`)
are disallowed inside `cancel` blocks.

### Cancellation in synchronous code

Because cancellation is delivered only at checkpoints, compute-intensive
synchronous loops between `await` expressions do not yield control or observe
cancellation automatically.

Synchronous routines that run for extended periods will be able to poll for
cancellation cooperatively:

```zena
// Planned polling mechanism for long-running synchronous loops
checkCancellation();
```

::: note Planned feature: checkCancellation()
The `checkCancellation()` function is planned for an upcoming release to allow
synchronous code to poll and unwind from its ambient `CancelScope`.
:::

## Next

- [Control Flow](/guide/control-flow/) — pattern matching, loops, and branching
- [Errors](/guide/errors/) — exception handling and error propagation
- [Functions](/guide/functions/) — top-level and arrow function declarations
