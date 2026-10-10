---
title: 'Async Functions'
description: 'Asynchronous functions, await expressions, execution model, microtask loop, and futures in Zena.'
---

::: warning Active Development
Concurrency and asynchronous APIs in Zena are under active development.
Specifications, runtime behaviors, and standard library interfaces described on
this page are incomplete and evolving.
:::

Zena provides native asynchronous programming with `async` functions, `await`
expressions, and the `Future<T>` type. Concurrency in Zena is cooperative,
deterministic, and built on top of a runtime microtask loop without preemptive
threads or shared-memory data races.

## async functions

An asynchronous function is declared using the `async` modifier before the
parameter list (on arrow functions) or before the `function` keyword (on
top-level functions and methods).

```zena
let fetchScore = async (userId: i32): Future<i32> => {
  let user = await loadUser(userId);
  return user.score;
};

export async function processQueue(): Future<void> {
  let item = await queue.next();
  handleItem(item);
}
```

### Return types and inference

An `async` function always produces a `Future<T>`:

- **Explicit annotations**: When an explicit return type is written, it must be
  the full `Future<T>` type. A return statement `return e;` in the body must
  provide a value of type `T`.
- **Inference on arrow functions**: When the return type of an `async` arrow
  function is omitted, `T` is inferred from the return statements, producing
  `Future<inferred>`.
- **Prelude type**: `Future` is available from the standard prelude without an
  explicit import.

```zena
// Method declaration with required Future<T> return type:
class Service {
  async loadConfig(): Future<Config> {
    let raw = await http.get('/config.json');
    return parseConfig(raw);
  }
}
```

## await expressions

The `await` keyword is a unary expression that pauses execution of the enclosing
`async` function until a target future settles.

`await` is valid only inside the immediate body of an `async` function.
Non-`async` nested closures inside an async function cannot use `await`.

```zena
let response = await client.send(request);
```

### Awaiting futures and union types

An `await` expression accepts a `Future<T>` or a union containing future types:

- **`Future<T>`**: `await future` evaluates directly to `T`.
- **Maybe-async unions (`T | Future<T>`)**: Awaiting `T | Future<T>` unifies to
  `T`. If the value is already `T`, execution yields through one microtask hop
  and evaluates to the value; if it is a future, execution suspends until the
  future resolves.
- **Multi-arm future unions**: Awaiting `Future<A> | Future<B>` evaluates to
  `A | B`.

### Expression position

`await` is an ordinary expression and can be nested inside sub-expressions,
arguments, and initializers:

```zena
let total = calculate(await fetchBase(), await fetchModifier());
```

Sub-expressions evaluated prior to suspension are preserved in the lowered
state-machine frame across the pause.

### Error propagation with try and catch

If an awaited future fails, the failure is re-thrown at the `await` site as an
exception. You can catch and handle it using standard `try`/`catch` expressions:

```zena
let data = try {
  await fetchRemoteData()
} catch (e: Error) {
  fallbackData
};
```

Cancellation is not caught by `catch (e: Error)` blocks; see
[Cancellation](/reference/cancellation/) for how cancelled tasks unwind.

### Async iteration (for await)

::: note In Progress
Async iteration (`for await`, `async gen`, and the `Step<T>` protocol) is an
unfinished feature under active development on the Zena roadmap (see `PLAN.md`).
:::

Inside `async` functions, the `await` keyword can also be applied to loop
headers to iterate over asynchronous streams and sequences:

```zena
for await (let item in stream) {
  processItem(item);
}
```

The loop pauses execution when waiting for the next element to arrive, but
processes consecutive ready elements synchronously without extra microtask
hops. See [for await in Loops](/reference/loops/#for-await) for complete details
on syntax, pattern destructuring, the `Step<T>` protocol, and early termination.

## Execution model and eager start

Zena's async execution model is **eager**, **single-threaded**, and
**run-to-completion**:

### Eager synchronous start

Calling an `async` function starts executing its body **synchronously** in the
caller's turn up until the first unresolved `await`.

```zena
let runTask = async (): Future<void> => {
  println('1. Started synchronously');
  await sleep(milliseconds(50));
  println('3. Resumed asynchronously');
};

println('0. Before call');
let task = runTask();
println('2. After call returned pending future');
await task;
```

Output:

```text
0. Before call
1. Started synchronously
2. After call returned pending future
3. Resumed asynchronously
```

Only when an `await` encounters an unsettled future does the function allocate
its state frame, return a pending `Future<T>` to the caller, and register its
continuation.

### Run-to-completion between awaits

Between suspension points, execution runs without preemption on a single
thread. Shared state cannot be interrupted or modified by another task during
synchronous execution blocks, eliminating data races within a single turn.

### Concurrent orchestration

Because async functions start eagerly upon invocation, initiating multiple
operations before awaiting them runs them concurrently:

```zena
// Both network requests start immediately in the current turn:
let userFuture = fetchUser(userId);
let ordersFuture = fetchOrders(userId);

// Await their results concurrently:
let user = await userFuture;
let orders = await ordersFuture;
```

### Zero-allocation await invariant

The compiler's split pass turns each async function into a frame struct that
implements `Waiter`. When a frame awaits an unsettled future, the future registers
the frame directly. No intermediate promise listener objects or closures are
allocated per `await`.

## The microtask loop

Zena maintains an in-module FIFO microtask queue that sequences all asynchronous
continuations.

### Deterministic FIFO scheduling

When a future settles, all registered waiters are moved to the microtask queue.
The queue processes items strictly in first-in, first-out order. This provides
deterministic execution ordering across asynchronous steps.

### The always-async rule

Awaiting a future that has **already settled** still yields to the microtask queue
for one turn:

```zena
let resolved = Future.of(42);

// Even though 'resolved' is already completed, the await yields one microtask hop:
let value = await resolved;
```

This guarantees that `await` always introduces an asynchronous boundary,
preventing re-entrancy bugs and ensuring consistent control flow regardless of
whether data is cached synchronously or retrieved asynchronously.

### Queue drainage and the Parker hook

The microtask loop runs via `drainMicrotasks()` from `zena:async`:

```zena
import { drainMicrotasks } from 'zena:async';

// Runs queued tasks until the queue is empty:
drainMicrotasks();
```

When the microtask queue empties, external event drivers (such as timers or host
I/O) can wake the executor through the `Parker` interface:

1. The executor drains all runnable microtasks.
2. When the queue is empty and an external parker is registered, the executor
   calls `parker.park()`, which waits until the next external completion is
   ready (on WASI 0.3, by arming a `wasi:clocks` `wait-for` and letting the
   host re-enter the component when it fires).
3. Newly scheduled microtasks are drained, repeating until all work completes.

## Future and Completer

Asynchronous operations communicate through two distinct capability roles:
`Future<T>` for reading outcomes, and `Completer<T>` for settling them.

### Future<T> (Read capability)

A `Future<T>` represents a value or failure that will become available later.
Consumers observe a future by awaiting it or chaining continuations:

```zena
let f: Future<String> = loadData();

// Inspecting status:
if (f.isCompleted) {
  println('Future has settled');
}
```

Direct settlement methods on `Future` are private to the runtime. External code
cannot resolve or reject a future directly through a `Future` reference.

### Completer<T> (Write capability)

`Completer<T>` (from `zena:async`) provides the write capability for completing
a future. It is used at integration boundaries with external I/O, callbacks, and
event listeners:

```zena
import { Completer, Future } from 'zena:async';

let completer = new Completer<String>();
let future: Future<String> = completer.future;

// Settle with a value:
completer.complete('Success');

// Or settle with an error:
// completer.fail(new Error('Operation failed'));
```

For racing producers where multiple callers might attempt settlement, `tryComplete`
and `tryFail` return `true` if the call won the race, or `false` if the future was
already settled:

```zena
if (completer.tryComplete('First')) {
  println('Won settlement race');
}
```

### Future combinators

`Future` provides static methods for combining and coordinating multiple futures:

- **`Future.of<T>(value: T): Future<T>`**: Creates an already-resolved future.
- **`Future.failed<T>(error: Error): Future<T>`**: Creates an already-failed future.
- **`Future.all<T>(futures: Array<Future<T>>): Future<Array<T>>`**: Returns a
  future that completes with an array of values when every input resolves, or
  fails immediately upon the first failure.
- **`Future.race<T>(futures: Array<Future<T>>): Future<T>`**: Returns a future
  that settles with the outcome (value or failure) of the first future to finish.
  Note that `Future.race` does not cancel losers; see [Task Groups](/reference/task-groups/)
  for loser-cancelling races.
- **`Future.allSettled<T>(futures: Array<Future<T>>): Future<Array<Outcome<T, Error>>>`**:
  Waits for all inputs to settle and produces an array of `Outcome` results,
  recording successes (`Ok`) and failures (`Err`).
- **`Future.any<T>(futures: Array<Future<T>>): Future<T>`**: Returns the first
  input that settles with a value. If all inputs fail, it fails with an
  `AggregateError` containing all failures.

```zena
let results = await Future.all([
  fetchProfile(id),
  fetchSettings(id),
]);
```

## Async main

Zena supports asynchronous module entry points:

```zena
export async function main(): Future<i32> {
  let status = await runApplication();
  return status;
}
```

### Host execution contract

When `main` is asynchronous:

1. The runtime host calls `main()`.
2. The initial synchronous statements execute immediately up to the first
   `await`.
3. The host enters the microtask loop, draining microtasks and parking on
   external events until the future returned by `main()` resolves or rejects.
4. When `main` finishes, its integer return value serves as the program exit code.

### Deadlock detection

If the microtask queue empties while the future returned by `main` (or any awaited
future) is still pending, and no external `Parker` is registered to provide future
events, the program cannot make progress. The runtime detects this condition and
terminates with an error:

```text
Error: Deadlock: the microtask queue is empty but this future is still pending,
and no external completion source exists
```
