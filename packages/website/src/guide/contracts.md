---
title: 'Contracts'
description: 'Preconditions, postconditions, and loop invariants in Zena: runtime checks, type narrowing, AI-assisted specifications, and future static verification.'
status: In progress
statusType: warning
---

::: warning In Progress Feature

`requires()`, `ensures()`, and `invariant()` clauses—along with the `debug`
modifier for test and `--debug` (`-g`) builds—are implemented for functions,
closures, methods, constructors, and loops. Clauses on generators, methods
without a body, and `ensures()` on `async` functions and `inline` returns are
still being worked through, along with future static verification.

:::

A **contract** states a condition on a function or loop that the program must
maintain:

- **`requires (condition)`** — a precondition that must hold whenever a function,
  method, or constructor is called.
- **`ensures (condition)`** — a postcondition that must hold whenever a function,
  method, or constructor returns normally.
- **`invariant (condition)`** — a loop invariant that must hold before a loop's
  first iteration and after each iteration.

```zena
class Account {
  var balance: i32;

  new(this.balance) requires (balance >= 0);

  withdraw(amount: i32): i32
    requires (amount > 0)
    requires (this.balance >= amount)
    ensures (this.balance == old(this.balance) - amount)
    ensures (result == this.balance)
  {
    this.balance -= amount;
    return this.balance;
  }
}
```

Contracts sit between static types and unit tests. Types describe the shapes of
values (`amount: i32`), while contracts state domain relationships that plain
types do not express (`amount > 0`, `this.balance >= amount`). Because clauses
belong to the function signature, callers and human reviewers can read what a
function expects and guarantees without tracing its implementation, and coding
agents get immediate, actionable feedback (`ContractError`) when an assumption
fails.

## Preconditions with requires

A `requires` clause comes after a function's parameter list and return type, and
before its body (or before `=>` on an arrow function). Multiple `requires`
clauses run in order at the start of every call, before the body executes:

```zena
import {div} from 'zena:math';

function half(n: i32): i32 requires (n % 2 == 0) {
  return div(n, 2);
}

let clampPositive = (value: i32, max: i32): i32
  requires (max > 0)
=> if (value < 1) 1 else if (value > max) max else value;
```

On a constructor, `requires` clauses appear before the `: ...` initializer list
and run before field initializers or `super(...)` arguments evaluate. Because the
instance has not been allocated yet, a constructor's `requires` clause can inspect
parameters and enclosing bindings, and cannot reference `this`:

```zena
class BoundedBuffer<T> {
  #items: FixedArray<T>;

  new(capacity: i32, fill: T)
    requires (capacity > 0)
    : #items = new FixedArray<T>(capacity, fill) {}
}
```

## Postconditions with ensures

An `ensures` clause is written alongside `requires` and runs on every normal
return from the function—including early `return` statements, the final
expression of a block or arrow body, and returns passing through `finally`
blocks. If the function exits by throwing an error, its postconditions do not
run.

### Naming the return value with `result`

Inside an `ensures` condition, `result` refers to the value being returned and
has the function's declared or inferred return type:

```zena
function abs(x: i32): i32 ensures (result >= 0) {
  return if (x >= 0) x else -x;
}

let nonEmpty = (label: String, fallback: String): String
  requires (fallback.length > 0)
  ensures (result.length > 0)
=> if (label.length > 0) label else fallback;
```

`result` is bound only inside `ensures` clauses, so the function body is free to
declare its own local variable named `result`. Functions returning `void` and
constructors have no `result`; in a constructor's `ensures` clause, inspect the
constructed instance through `this`:

```zena
class Range {
  low: i32;
  high: i32;

  new(this.low, this.high) ensures (this.low <= this.high) {}
}
```

### Comparing against entry state with `old()`

Mutating methods often need to relate an object's state on return to the state it
had when the call began. Inside an `ensures` condition, `old(expr)` evaluates
`expr` on entry (after all `requires` clauses succeed) and keeps that value until
the postcondition runs:

```zena
class Stack<T> {
  #items = new GrowableArray<T>();

  length(): i32 {
    return this.#items.length;
  }

  push(item: T): void
    ensures (this.length() == old(this.length()) + 1)
  {
    this.#items.push(item);
  }

  pop(): T
    requires (this.length() > 0)
    ensures (this.length() == old(this.length()) - 1)
  {
    return this.#items.pop();
  }
}
```

`old(expr)` captures the value of `expr` without cloning heap objects. Capturing
`old(this.#items.length)` records the `i32` length at entry, whereas
`old(this.#items)` holds a reference to the same array instance that the method
subsequently mutates.

## Loop invariants with invariant

An `invariant` clause attaches to a `while`, `for`, or `for-in` loop, between the
loop header and its `{ ... }` block body. It runs at the loop header every time
the loop is about to test whether to continue: before the first iteration, after
each completed iteration, and after a `continue` (following the update step in a
`for` loop).

```zena
import {div} from 'zena:math';

function binarySearch(items: FixedArray<i32>, target: i32): i32 {
  var lo = 0;
  var hi = items.length;

  while (lo < hi)
    invariant (0 <= lo && lo <= hi)
    invariant (hi <= items.length)
  {
    let mid = lo + div(hi - lo, 2);
    let current = items[mid];
    if (current == target) {
      return mid;
    }
    if (current < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return -1;
}
```

In a C-style `for` loop, variables declared in the loop header are in scope inside
`invariant`. In a `for-in` loop, the element variable is bound only when an
iteration starts, so the `invariant` condition sees the enclosing scope rather
than the element variable:

```zena
function sumNonNegative(items: FixedArray<i32>): i32
  ensures (result >= 0)
{
  var total = 0;
  for (let item in items) invariant (total >= 0) {
    if (item > 0) {
      total += item;
    }
  }
  return total;
}
```

## Type narrowing from preconditions

Because an unmarked `requires` clause runs on every call and halts before the
body if the check fails, any type refinement established by its condition holds
in later clauses and throughout the function body:

```zena
sealed class Animal {
  case Cat(name: String)
  case Dog(name: String)
  case Fish
}

function greetMammal(pet: Animal): String
  requires (pet is Cat || pet is Dog)
{
  // `pet` has type `Cat | Dog` here; `Fish` is ruled out.
  return match (pet) {
    case Cat {name}: `Meow, ${name}`
    case Dog {name}: `Woof, ${name}`
  };
}

let trimmedLength = (text: String | null): i32
  requires (text != null)
=> text.trim().length;
```

Narrowing in `requires` uses the same flow engine as `if`: immutable bindings,
parameters, and member paths through immutable fields narrow, while mutable `var`
fields do not. Parameter narrowings from `requires` also carry forward into the
function's `ensures` clauses.

Clauses marked `debug requires` (covered next) do **not** narrow types, because
the function body runs without those checks in ordinary builds.

## Test and debug clauses with debug

Unmarked clauses run in every build, just like array bounds checks and checked
`as` casts. Some conditions, however, cost more than the operation they guard—for
example, verifying in `O(n)` time that an array is sorted before an `O(log n)`
binary search.

Prefixing `requires`, `ensures`, or `invariant` with `debug` enables the check
only when running tests (`zena test`) or when compiling/running in debug mode
with `--debug` / `-g` (`zena -g build`, `zena -g run`):

```zena
import {div} from 'zena:math';

function isSorted(items: FixedArray<i32>): boolean {
  for (var i = 1; i < items.length; i += 1) {
    if (items[i - 1] > items[i]) {
      return false;
    }
  }
  return true;
}

function findSorted(items: FixedArray<i32>, target: i32): i32
  requires (items.length > 0)
  debug requires (isSorted(items))
  debug ensures (result == -1 || items[result] == target)
{
  var lo = 0;
  var hi = items.length;
  while (lo < hi)
    invariant (0 <= lo && lo <= hi && hi <= items.length)
    debug invariant (isSorted(items))
  {
    let mid = lo + div(hi - lo, 2);
    if (items[mid] == target) {
      return mid;
    }
    if (items[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return -1;
}
```

Key properties of `debug` clauses:

- **Zero overhead in ordinary builds**: When compiled without `-g` / `--debug`
  outside `zena test`, Zena emits no code, calls, or message strings for `debug`
  clauses. Helper functions referenced only from `debug` clauses (like `isSorted`
  above if unused elsewhere) are stripped by reachability analysis too.
- **Always type-checked**: The compiler type-checks `debug` clauses in _every_
  build using the same rules as unmarked clauses, so `debug` assertions never
  drift out of sync with surrounding code.
- **No type narrowing**: Because ordinary builds skip `debug requires`, neither
  the body nor subsequent clauses can rely on narrowings from a `debug requires`
  condition (for instance, `debug requires (text != null)` leaves `text` typed as
  `String | null`).

## Runtime checks and ContractError

Unmarked clauses run in all builds, and `debug` clauses run under `zena test` and
`--debug` / `-g`. When an active condition evaluates to `false`, Zena throws a
`ContractError` (a subclass of `Error` in the standard prelude) whose message
repeats the failed clause, including `debug` when present:

```zena
function withdraw(balance: i32, amount: i32): i32
  requires (amount > 0)
  requires (balance >= amount)
{
  return balance - amount;
}

export function main(): void {
  try {
    withdraw(100, 0);
  } catch (e) {
    if (e is ContractError) {
      console.log(e.message);
      // -> requires (amount > 0) does not hold
    }
  }
}
```

Programs that use no contracts pay zero binary-size or runtime cost: the compiler
only links the failure helper and clause strings when reachability encounters a
contract clause.

Contract conditions must be `boolean` expressions and cannot perform assignments
(`=`, `+=`) or `await` futures, ensuring that evaluating a contract does not
suspend execution or mutate local bindings. `requires`, `ensures`, `invariant`,
and `debug` are contextual keywords, so existing variables and functions with
those names remain valid.

## Current limitations and roadmap

Contracts are expanding along two remaining tracks:

### Language coverage in progress

Where the compiler cannot yet lower a clause, it reports a compile-time error
so that no contract is ever silently ignored:

- **Generators (`gen`)**: Neither `requires` nor `ensures` is supported on
  generator functions or methods yet, while semantics for eager vs. first-step
  preconditions and per-yield postconditions are finalized.
- **Async postconditions**: `requires` clauses on `async` functions work today
  (rejecting the returned `Future` if violated before the first `await`), whereas
  `ensures` on `async` functions is not yet supported across state-machine
  splitting.
- **Methods without bodies**: Clauses on `interface`, `abstract`, and `declare`
  methods are rejected until contract inheritance rules on overrides are
  settled.
- **Inline returns and constructor edge cases**: `ensures` on functions returning
  unboxed `inline` types, `ensures` on extension class constructors, and `old()`
  inside constructor `ensures` clauses are not yet compiled.
- **Tail calls**: A function with `ensures` clauses cannot use `tail return`,
  because a tail call discards the stack frame needed to check postconditions
  after the callee returns.

### Static verification (planned)

Contracts are the runtime foundation for Zena's formal verification story (see
[Correctness and Safety](/guide/correctness/) and
[Working with AI Agents](/guide/ai-agents/)). Future milestones plan to integrate
SMT-backed verification (`@verify`) to prove contracts at compile time for all
inputs, alongside specification-only `ghost` clauses and quantifiers that carry
zero runtime overhead.

## Next

- [Contracts Reference](/reference/contracts/) — complete syntax, scoping, narrowing, and diagnostic rules
- [Correctness and Safety](/guide/correctness/) — how sound types, contracts, and proofs fit together
- [Working with AI Agents](/guide/ai-agents/) — using contracts in agentic coding workflows
- [Contracts Design](/development/design/contracts/) — syntax choices, lowering, and verification roadmap
