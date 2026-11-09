---
title: 'Contracts'
description: 'Language reference for Zena contract clauses: requires, ensures, invariant, result, old(), narrowing, runtime checks, and current restrictions.'
status: In progress
statusType: warning
---

::: warning In Progress Feature

`requires`, `ensures`, and `invariant` clauses, with the `debug` and `static`
modifiers, are checked. Unmarked and `debug` clauses compile to runtime
assertions; `static` clauses are specifications that are never run. The compiler
rejects clauses in positions that are not yet supported (such as methods without
a body) rather than ignoring them. Static verification is planned.

:::

A contract clause attaches a boolean condition to a callable declaration, arrow
expression, or loop statement. Unmarked clauses run in every build; clauses
prefixed with `debug` run in `zena test` and `--debug` (`-g`) builds and are
omitted from ordinary builds. When an active clause's condition evaluates to
`false`, it throws a `ContractError`.

## Clause syntax and placement

### Grammar

```ebnf
FunctionContracts := (RequiresClause | EnsuresClause)*
Modifier          := 'debug' | 'static'
RequiresClause    := Modifier? 'requires' '(' Expression ')'
EnsuresClause     := Modifier? 'ensures' '(' Expression ')'

LoopContracts     := InvariantClause*
InvariantClause   := Modifier? 'invariant' '(' Expression ')'
```

### Callable positions

On functions, arrow functions, methods, and constructors, `requires` and
`ensures` clauses appear after the parameter list and optional return type
annotation, and before the body, `=>`, or constructor initializer list:

```zena
import {div} from 'zena:math';

// Top-level function declaration
function exactHalf(n: i32): i32
  requires (n % 2 == 0)
  ensures (result * 2 == n)
{
  return div(n, 2);
}

// Arrow function (clauses precede `=>`)
let abs = (x: i32): i32 ensures (result >= 0) => if (x >= 0) x else -x;

class Counter {
  var count: i32;

  // Constructor (clauses precede `: initializerList` and body)
  new(start: i32)
    requires (start >= 0)
    ensures (this.count == start)
    : count = start {}

  // Instance method
  add(delta: i32): i32
    requires (delta > 0)
    ensures (this.count == old(this.count) + delta)
    ensures (result == this.count)
  {
    this.count += delta;
    return this.count;
  }
}
```

A function may carry any number of `requires` and `ensures` clauses in any order.
Clauses are not accepted on `declare function` declarations, getters or setters,
or interface constructors.

### Contextual keywords

`requires`, `ensures`, `invariant`, and `debug` are contextual keywords:

- In signature position (after `)` or a return type), `requires`, `ensures`,
  `debug requires`, and `debug ensures` begin contract clauses. Everywhere else
  they remain ordinary identifiers.
- After a `while`, `for`, or `for-in` header, `invariant (...)` or
  `debug invariant (...)` begins a loop contract clause only when followed by `{`
  or another loop clause. A statement like `while (ready) invariant(x);` parses
  as a loop whose single-statement body calls a function named `invariant`.
  Consequently, any loop with `invariant` clauses must use a `{ ... }` block
  body.
- `static` is a keyword everywhere. Directly before `requires`, `ensures`, or
  `invariant` in the positions above it is a clause's modifier; a `static`
  member declared after a method with clauses is still a member.

```zena
// Contextual keywords remain usable as variable and function names:
let requires = 1;
let ensures = 2;
let debug = 3;
let invariant = requires + ensures + debug;
```

## Preconditions (requires)

A `requires` clause specifies a precondition checked on every call after
parameter defaults and bindings are evaluated and before the callable does any
other work. Multiple `requires` clauses evaluate in source order; the first
clause to return `false` throws `ContractError` immediately.

### Scope in `requires`

- **Functions and closures**: Parameters and bindings from enclosing lexical
  scopes are in scope. Variables declared inside the function body are not yet in
  scope. If an arrow function's `requires` clause references an outer variable,
  the closure captures that variable even if the body itself does not mention it.
- **Methods**: Parameters, `this`, and enclosing module bindings are in scope.
- **Constructors**: Parameters and enclosing bindings are in scope. `this` is
  **not** in scope because preconditions run before field initializers,
  initializer lists, and `super(...)` calls allocate the instance:

```zena
class BoxedPositive {
  value: i32;

  new(v: i32) requires (this.value > 0) : value = v {}
  // @error: A constructor's 'requires' condition cannot use 'this': it runs before the object exists.
}
```

In a subclass constructor, the subclass's own `requires` clauses run first,
followed by its field initializers, and then the superclass constructor's
`requires` clauses.

- **`async` functions**: Preconditions run synchronously when the `async`
  function is called, in the eager prefix before the first `await`. A failed
  `requires` clause rejects the returned `Future<T>` with `ContractError`, just
  like an exception thrown before the first `await`.
- **Generators** (`gen` and `async gen`): A generator's body does not start at
  the call, which only creates the iterator. Preconditions run at the first
  step, as the first thing the body does, so a call with arguments that break
  one returns an iterator, and the first `next()`, or the `for`-in driving it,
  throws.

## Postconditions (ensures)

An `ensures` clause specifies a postcondition checked in source order on every
normal return from the callable.

### Scope and `result`

An `ensures` condition sees everything `requires` sees on entry, plus:

- **`this` in constructors**: Unlike `requires`, a constructor's `ensures` clause
  runs after the constructor body completes, so the newly initialized instance is
  in scope as `this`. When constructing a subclass, the superclass constructor's
  `ensures` clauses run after the superclass body and before the subclass body.
- **`result`**: In any value-returning function, closure, or method, `result` is
  implicitly bound inside each `ensures` scope to the value being returned.
  `result` has the function's declared or inferred return type.

`result` is subject to three static rules:

1. **`result` is scoped strictly to `ensures` clauses**: Body locals may freely
   be named `result` without conflict, and `requires` clauses cannot reference
   `result`.
2. **`void` functions and constructors have no `result`**: Referencing `result`
   when the return type is `void` (or in a constructor) is a compile-time error:

```zena
function reset(): void ensures (result) {}
// @error: 'result' has no value here: the function returns nothing.
```

3. **No parameter named `result` when `ensures` is present**: Because `result` in
   `ensures` would shadow a parameter of the same name, declaring both is
   rejected:

```zena
function echo(result: i32): i32 ensures (result > 0) {
// @error: A parameter named 'result' cannot be read in an 'ensures' condition
  return result;
}
```

### Exit paths and exceptions

- **All normal returns check `ensures`**: Explicit `return expr;` statements,
  tail-expression values of blocks and arrow functions, and returns replayed
  after a `finally` block all pass through the function's postcondition checks.
- **`finally` ordering**: Postconditions run _after_ any `finally` blocks in the
  function have finished executing.
- **Thrown exceptions skip `ensures`**: When a function exits abnormally via
  `throw`, postconditions are not evaluated.
- **Uncaught by internal `try`**: If an `ensures` clause itself fails, the
  resulting `ContractError` is thrown outside the function's own `try`/`catch`
  handlers so the function cannot accidentally swallow its own broken
  postcondition.
- **`async` functions**: Postconditions run when the body returns, just before
  the future completes, and `result` is the value it completes with. A failure
  completes the future with the `ContractError`. Such a function cannot return
  another future for its caller to wait on in place of a value, since `result`
  is not known at that return; it can `await` it.
- **Generators**: Postconditions run when the body returns, which is when the
  iteration ends: the step that would report the end throws instead. A
  generator has no `result`. A loop that leaves early disposes the generator
  without returning from its body, so nothing is checked.

## Entry values with old()

Inside an `ensures` condition, `old(e)` evaluates expression `e` on function
entry—immediately after all `requires` clauses succeed—and yields that saved
value when the postcondition runs at return. `old(e)` has the static type of `e`.

```zena
class Ledger {
  var total: i32 = 0;

  record(amount: i32): void
    requires (amount != 0)
    ensures (this.total == old(this.total) + amount)
  {
    this.total += amount;
  }
}
```

### Rules for `old()`

- **Direct `ensures` context only**: `old` acts as the entry-value operator only
  when called directly inside an `ensures` expression (where it shadows any
  user-defined function named `old`). Inside a nested arrow function written
  within an `ensures` condition, `old` resolves as a normal identifier because the
  closure's own parameters do not exist at function entry.
- **Single argument, no nesting, no `result`**: `old(e)` takes exactly one
  argument, cannot contain another `old(...)`, and cannot reference `result`:

```zena
class Counter {
  var count: i32 = 0;

  badNested(): void ensures (old(old(this.count)) == 0) {}
  // @error: 'old' cannot be used inside another 'old'.

  badResult(): i32 ensures (old(result) == 0) {
  // @error: 'result' cannot be used inside 'old'
    return this.count;
  }
}
```

- **Shallow capture**: `old(e)` saves the value produced by `e` at entry; it does
  not deep-clone reference objects. If `this.items` is a `GrowableArray<i32>`,
  `old(this.items.length)` captures the `i32` length before mutation, while
  `old(this.items)` retains a reference to the same array object.

## Loop invariants (invariant)

An `invariant` clause on a `while`, `for`, or `for-in` loop is checked at the
loop header immediately before the loop's continuation check:

1. Before the first iteration begins.
2. After the body finishes each normal iteration (in a `for` loop, after the
   update clause runs).
3. After a `continue` jumps to the next cycle (again after the `for` update
   clause).

If the loop exits via `break`, `return`, or `throw`, the invariant is not
re-checked on exit.

```zena
function sumFirstN(n: i32): i32
  requires (n >= 0)
  ensures (result >= 0)
{
  var total = 0;
  for (var i = 0; i <= n; i += 1)
    invariant (0 <= i && i <= n + 1)
    invariant (total >= 0)
  {
    total += i;
  }
  return total;
}
```

### Scope in `invariant`

An `invariant` condition sees the bindings visible in the loop's test condition:

- **`while (cond)`**: Enclosing scope bindings; variables bound by `while (let ...)`
  are _not_ in scope because the invariant runs before pattern matching.
- **`for (init; cond; update)`**: Enclosing scope bindings _plus_ any variables
  declared in `init` (such as `var i = 0`).
- **`for (let item in iterable)`**: Enclosing scope bindings only. The loop
  element `item` is bound after the header check advances the iterator, so `item`
  is not in scope inside `invariant`:

```zena
function countTrue(flags: FixedArray<boolean>): i32 {
  var count = 0;
  for (let flag in flags) invariant (flag) {
  // @error: Variable 'flag' not found.
    if (flag) { count += 1; }
  }
  return count;
}
```

## Debug clauses (debug)

Prefixing a clause with `debug` restricts its runtime evaluation to test and
debug builds, for conditions whose cost exceeds the code they guard:

```zena
function search(items: FixedArray<i32>, target: i32): i32
  requires (items.length > 0)
  debug requires (isSorted(items))
  debug ensures (result >= -1 && result < items.length)
{
  var lo = 0;
  var hi = items.length;
  while (lo < hi) debug invariant (isSorted(items)) {
    // ...
  }
  return -1;
}
```

- **When `debug` clauses run**: Under `zena test` (the test runner) and in builds
  compiled or run with `--debug` / `-g` (`zena -g build`, `zena -g run`).
- **When `debug` clauses are omitted**: Every build without `--debug` / `-g`
  outside `zena test` emits nothing for `debug` clauses—no condition evaluation,
  no `$contractFailed` call, and no message string. Reachability analysis skips
  omitted `debug` clauses too, so helper functions called only inside `debug`
  conditions are not linked into ordinary builds.
- **Unconditional type-checking**: The checker validates `debug` clauses in
  _every_ build (boolean type, scoping, no assignments, no `await`).
- **No narrowing**: `debug requires` does **not** narrow types in subsequent
  clauses, `ensures`, or the body, since the body runs without the check in
  ordinary builds.
- **Error message**: When a `debug` clause fails, `ContractError.message`
  includes the `debug` prefix: `debug requires (isSorted(items)) does not hold`.

## Static clauses (static)

Prefixing a clause with `static` makes it a condition the compiler is to prove
at compile time instead of checking at run time. It is for a condition that is
meant to be proved rather than run, or that could not run at all. The compiler
does not prove anything yet: today a `static` clause is type-checked in every
build and never checked, and once the compiler can prove some, a `static` clause
it cannot prove becomes an error.

```zena
function search(items: FixedArray<i32>, target: i32): i32
  requires (items.length > 0)
  static requires (isSorted(items))
  static ensures (result < 0 || items[result] == target)
{
  // ...
}
```

- **Never emitted**: No build evaluates a `static` clause, calls
  `$contractFailed` for it, or carries its message. Reachability skips it, so a
  function called only in a `static` condition is not linked in.
- **Type-checked**: Its names must resolve and its condition must be a boolean,
  by the rules every clause follows, so it cannot rot.
- **No narrowing**: A `static requires` narrows nothing, for the reason a `debug`
  one does not.
- **One modifier per clause**: `debug` or `static`, not both. A `static` clause
  is left out of every build, so `debug` would add nothing.
- **Why `static`**: `static_assert` is the precedent for `static` meaning "at
  compile time"; the position keeps it apart from a member's `static`.

Until a static verifier exists, a `static` clause is documentation the compiler
keeps honest about names and types. Quantifiers and specification-only
functions arrive with the verifier.

## Type checking and narrowing

### Pure-control condition rules

Every `requires`, `ensures`, and `invariant` condition must have type `boolean`
(no truthy coercion) and cannot contain assignment expressions (`=`, `+=`, etc.)
or `await` expressions:

```zena
var counter = 0;

function impure(x: i32): i32 requires ((counter += 1) > 0) {
// @error: A 'requires' condition cannot assign.
  return x;
}
```

### Precondition narrowing

Because an unmarked `requires` clause executes on every call in every build and
throws if `false`, type narrowing from an unmarked `requires` condition
propagates:

1. Into subsequent clauses on the same declaration.
2. Throughout the callable's body.
3. For immutable parameter bindings, into the callable's `ensures` clauses.

```zena
class Cat {
  purrs(): boolean { return true; }
  meow(): String { return 'meow'; }
}

class Dog {
  bark(): String { return 'woof'; }
}

function makeCatSpeak(pet: Cat | Dog): String
  requires (pet is Cat)
  requires (pet.purrs()) // `pet` is already narrowed to `Cat`
  ensures (result == pet.meow()) // parameter narrowing carries into `ensures`
{
  return pet.meow();
}
```

A `debug requires` clause is omitted in non-debug builds, so it never narrows
types in later clauses, `ensures`, or the body:

```zena
function unsafeLength(text: String | null): i32
  debug requires (text != null)
{
  return text.length;
  // @error: Object may be null when accessing 'length'.
}
```

### Postcondition entry typing

Inside a function body, early returns can narrow a nullable parameter along later
paths (for example, `if (text == null) return 0;` narrows `text` to `String` for
the rest of the body). An `ensures` clause must hold for _every_ return path—including
the early return taken when `text` was `null`—so `ensures` conditions are
type-checked against entry types (plus parameter narrowings from `requires`), not
path-specific body narrowings:

```zena
function stringLength(text: String | null): i32
  ensures (result == text.length)
  //                 ^^^^ error: Object may be null
{
  if (text == null) {
    return 0;
  }
  return text.length;
}
```

Guard the nullable value inside the `ensures` expression itself when needed:
`ensures (text == null || result == text.length)`.

## Runtime evaluation and ContractError

Each compiled clause lowers to a boolean branch that calls `$contractFailed` in
`zena:core` on the `false` path, throwing a `ContractError`:

```zena
// Standard prelude class (exported from zena:core):
class ContractError extends Error { ... }
```

The `message` of `ContractError` is the exact source text of the violated clause
followed by `" does not hold"`, for example:

- `requires (amount > 0) does not hold`
- `debug requires (isSorted(items)) does not hold`
- `ensures (this.count == old(this.count) + by) does not hold`
- `invariant (0 <= lo && lo <= hi) does not hold`

### Binary size and reachability

- A function with contracts pays a conditional branch and a call to
  `$contractFailed` per clause, plus one string constant for the clause text.
- A function with `ensures` clauses disables record-result scalar explosion on
  that function so `result` remains addressable as a whole record value.
- Programs without reachable contract clauses omit `$contractFailed`,
  `ContractError`, and all contract message strings during dead-code elimination.

## Unsupported positions and restrictions

### `tail return` and postconditions

A function with one or more `ensures` clauses cannot use `tail return`. This is a
permanent semantic rule: WebAssembly's `return_call` discards the caller's stack
frame before invoking the callee, leaving nowhere to run the caller's
postconditions afterward.

```zena
function countdown(n: i32): i32 ensures (result == 0) {
  if (n == 0) { return 0; }
  tail return countdown(n - 1);
  // @error: 'tail return' is not allowed in a function with 'ensures' clauses: the frame it would discard still owes the postconditions.
}
```

(`requires` clauses are allowed with `tail return`, since preconditions finish
before the body runs.)

### Constructs not yet supported

The checker rejects clauses in the following positions until their lowering or
inheritance designs are completed:

| Position                                                    | Status                                                             |
| :---------------------------------------------------------- | :----------------------------------------------------------------- |
| Methods without a body (`interface`, `abstract`, `declare`) | `requires` and `ensures` rejected                                  |
| Functions returning an `inline` record                      | `requires` supported; `ensures` rejected                           |
| `old(...)` of an `inline` value                             | rejected                                                           |
| Extension class constructors                                | `requires` supported; `ensures` rejected                           |
| Constructor `ensures` clauses                               | `this` supported; `old(...)` inside constructor `ensures` rejected |

## Planned static verification

Unmarked clauses run in every build, `debug` clauses run under `zena test` and
`--debug` (`-g`), and `static` clauses never run. Future work extends the same
contract surface with compile-time verification (see
[Contracts Design](/development/design/contracts/)):

- **Opt-in static verification (`@verify`)**: Discharging `requires`, `ensures`,
  and `invariant` clauses statically via SMT solvers so proven postconditions and
  invariants hold for all inputs.
- **Specification vocabulary in `static` clauses**: Universal quantifiers
  (`forall`, `exists`) and specification-only functions, which cannot run and so
  belong only in clauses that are never emitted.
