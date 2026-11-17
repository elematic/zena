# Contracts in Zena (`requires`, `ensures`, `invariant`)

## Overview and Modifiers

Contract clauses attach machine-checked boolean specifications to functions, arrow functions, methods, constructors, and loops. When an active runtime clause evaluates to `false`, it throws `ContractError` (`zena:core`) whose message includes the exact clause text (for example, `requires (parts > 0) does not hold`).

Each clause accepts an optional modifier:

| Form                                                                  | When Checked                                                        | Emitted in Release Builds                  | Narrows Types in Body |
| :-------------------------------------------------------------------- | :------------------------------------------------------------------ | :----------------------------------------- | :-------------------- |
| `requires (c)` / `ensures (c)` / `invariant (c)`                      | Every execution                                                     | Yes                                        | Yes (from `requires`) |
| `debug requires (c)` / `debug ensures (c)` / `debug invariant (c)`    | `zena test`, `zena -g build`, `zena -g run`                         | **No** (dead-code eliminated with helpers) | **No**                |
| `static requires (c)` / `static ensures (c)` / `static invariant (c)` | Type- and purity-checked at compile time (SMT verification planned) | **No**                                     | **No**                |

Use unmarked clauses for cheap boundary checks and `debug` clauses for `O(n)` structural checks (such as `debug requires (isSorted(items))` or `debug ensures (isValidHeap(this.#nodes))`) that catch algorithmic bugs during `zena test` at zero production cost.

## Placement and Syntax

Clauses appear after the parameter list and optional return type, and before `{`, `=>`, or a constructor's `: initList`:

```zena
import {div} from 'zena:math';

function binarySearch(items: FixedArray<i32>, target: i32): i32
  requires (items.length >= 0)
  debug requires (isSorted(items))
  ensures (result == -1 || (0 <= result && result < items.length && items[result] == target))
{
  var lo = 0;
  var hi = items.length;
  while (lo < hi)
    invariant (0 <= lo && lo <= hi && hi <= items.length)
  {
    let mid = lo + div(hi - lo, 2);
    if (items[mid] == target) {
      return mid;
    } else if (items[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return -1;
}

// Arrow function: clauses precede `=>`
let clamp = (x: i32, lo: i32, hi: i32): i32
  requires (lo <= hi)
  ensures (lo <= result && result <= hi)
=> if (x < lo) lo else if (x > hi) hi else x;
```

`requires`, `ensures`, `invariant`, and `debug` are contextual keywords and remain usable as ordinary variable or function names. Loops carrying `invariant` clauses must use a `{ ... }` block body.

## Scoping Rules (`this`, `result`, `old()`)

### Constructors (`this` timing)

- **`requires` runs before object allocation**: Constructor parameters are in scope (for `new(this.balance)`, refer to `balance`), whereas **`this` is not in scope** (`requires (this.balance >= 0)` is a compile error).
- **`ensures` runs after the constructor body**: `this` is in scope (`ensures (this.balance >= 0)`). Constructors have no `result` and do not support `old(...)`.

### Postconditions (`result` and exit paths)

- **`result`**: Bound inside `ensures` on any non-`void` function, closure, or method (`void` functions and constructors reject `result`, and parameters cannot be named `result` when `ensures` is present).
- **Execution order**: `ensures` runs on every normal return (`return expr;` and trailing block/arrow expressions) _after_ any `finally` blocks complete. Throwing an `Error` skips `ensures`. A `ContractError` from `ensures` bypasses the function's own `try`/`catch` blocks.
- **Async and generators**: On `async` functions, `requires` runs synchronously on call (rejecting the returned `Future<T>` on failure) and `ensures` checks the resolved value when the body returns. On `gen` functions, `requires` runs on the first iteration step and `ensures` runs when iteration finishes normally (no `result`).

### Entry snapshots with `old(expr)`

Inside `ensures` (directly, outside nested closures), `old(expr)` evaluates `expr` once on function entry after all `requires` clauses pass and provides that saved value at return:

```zena
class Account {
  var balance: i32;
  new(this.balance) requires (balance >= 0);

  withdraw(amount: i32): i32
    requires (amount > 0 && this.balance >= amount)
    ensures (this.balance == old(this.balance) - amount)
    ensures (result == this.balance)
  {
    this.balance -= amount;
    return this.balance;
  }
}
```

`old(expr)` performs a **shallow** capture: `old(this.items.length)` saves the entry `i32` length, whereas `old(this.items)` saves the reference to the same array. `old(...)` takes one effect-free argument and cannot nest or reference `result`.

### Loop `invariant` scope

`invariant` checks immediately before each loop condition test (before iteration 0, after each normal body + `for` update, and after `continue`; skipped on `break`, `return`, or `throw`). It sees the loop test's scope: `for (var i = 0; ...)` initializers are in scope, whereas `while (let P = x)` pattern bindings and `for (let item in xs)` element variables are **not** in scope inside `invariant`.

## Narrowing and Purity Restrictions

- **Flow narrowing**: Unmarked `requires` conditions narrow nullable types and unions in subsequent clauses, throughout the body, and (for immutable parameters) in `ensures`. Neither `debug requires` nor `static requires` narrows types.
- **Entry typing in `ensures`**: `ensures` must hold across _all_ return paths (including early returns), so parameters have their entry types (plus `requires` narrowings) rather than path-local body narrowings (`ensures (text == null || result == text.length)`).
- **Pure boolean conditions**: All contract expressions must have type `boolean` and cannot contain assignments (`=`, `+=`), `await`, or `yield`.
- **Effect checking on `static` clauses and `old()`**: Functions called inside `static` clauses or `old(...)` are checked from their bodies to ensure they mutate no pre-existing state (fresh local allocations like a temporary `GrowableArray` are allowed; indirect calls through closures, interfaces, `HashMap`/`HashSet`, non-array/range `for-in`, and `declare function` are rejected).
- **Current compiler restrictions**: `tail return` cannot appear in a function with `ensures`. Clauses are currently rejected on bodyless declarations (`interface`, `abstract`, `declare`), `ensures` on `inline` record returns, and `ensures` on `extension class` constructors.
