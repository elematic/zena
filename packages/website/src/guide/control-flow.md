---
title: 'Control Flow'
description: 'Expression-oriented control flow, conditionals, loops, pattern conditions, and match in Zena.'
---

Zena is an **expression-oriented language**. Key control flow
constructs—including `if` conditionals, `match` blocks, and `try` forms—can be
evaluated as expressions that produce values directly.

## Expression orientation

In Zena, conditionals and pattern matching can produce values directly for
variable initializers, function arguments, or returns:

```zena
// 'if' evaluated as an expression
let max = if (a > b) a else b;

// 'match' evaluated as an expression
let label = match (status) {
  case 200: 'OK'
  case 404: 'Not Found'
  case _: 'Error'
};
```

Within the branches of `if` expressions and `match` arms, a block `{ ... }`
evaluates to the value of its trailing expression without requiring an explicit
`return`:

```zena
let price = if (isMember) {
  let discount = 10;
  basePrice - discount // Evaluates to the result of this expression
} else {
  basePrice
};
```

## Conditionals with if and else

Conditionals in Zena can be used both as control flow statements and as
value-producing expressions.

### `if` as a statement

When used as a statement, `if` executes its body when the condition evaluates to
`true`. The `else` branch is optional:

```zena
if (score > 100) {
  print('High score!');
} else {
  print('Keep trying!');
}
```

### `if` as an expression

In languages like JavaScript, TypeScript, and Java, choosing between values
requires the ternary operator (`cond ? a : b`). In Zena, **`if` expressions
replace the ternary operator**:

```zena
let max = if (a > b) a else b;
```

When `if` is used in an expression context, the **`else` branch is mandatory**:

```zena
// Chained else-if expression
let description = if (score >= 90) {
  'Excellent'
} else if (score >= 70) {
  'Good'
} else {
  'Needs improvement'
};
```

Both branches of an `if` expression must produce compatible types. The resulting
type is the union of the branch types.

### Early exits and the `never` type

An arm of an `if` expression can contain early control-flow jumps—such as
`return`, `throw`, `break`, or `continue`.

Because an arm that returns or throws never produces a normal value, its type is
`never` (the bottom type). Because the type system simplifies `never | T`
directly to `T`, you can safely perform early returns or throw errors inline:

```zena
// If opt is null, early return 0; otherwise bind opt's value
let value: i32 = if (opt != null) opt else return 0;

// If port is invalid, throw immediately; otherwise bind port
let port: i32 = if (rawPort > 0) rawPort else throw new Error('Invalid port');
```

### Pattern conditions with `if let`

An `if let` condition tests whether an expression matches a pattern. When the
pattern matches, the bound variables are in scope only within the `if` block.

A primary example is looking up values in a `Map`. The `Map.get(key)` method
returns an inline discriminated union of tuples:

```zena
get(key: K): inline (true, V) | inline (false, _);
```

Using `if let` tests the first boolean element and extracts the second value in
a single step:

```zena
let scores = new HashMap<String, i32>();
scores['Alice'] = 95;

if (let (true, score) = scores.get('Alice')) {
  // In this branch, matching 'true' narrows the tuple union to (true, V).
  // 'score' is statically typed and narrowed to non-null i32.
  print('Alice scored: ' + score.toString());
} else {
  print('Alice was not found in the map.');
}
```

Because `Map.get` returns an `inline` tuple (compiled to WebAssembly multi-value
returns), this combined lookup, presence check, and narrowing involves zero heap
allocations.

`if let` is also commonly used with sealed class hierarchies (such as
`Option<T>`):

```zena
let maybeUser: Option<User> = findUser();

if (let Some { value: user } = maybeUser) {
  print('Found user: ' + user.name);
}
```

::: note Nullable Values vs. Patterns

Variable binding patterns like `let x` match any value unconditionally
(including `null`). To check and narrow a nullable reference type (`T?`), use a
standard null check like `if (val != null)` or type check `if (val is T)`.

:::

## Loops and iteration

Zena provides three loop constructs: `for-in` loops for collections, C-style
`for` loops for indexed iteration, and `while` loops.

### `for-in` loops

The `for-in` loop iterates over any object implementing the `Iterable<T>`
interface (such as `Array`, `Map`, `Set`, or custom collections):

```zena
let numbers = [10, 20, 30];
var sum = 0;

for (let n in numbers) {
  sum += n;
}
```

The loop variable is declared with `let` and is locally scoped to each
iteration. Destructuring patterns can be used directly in the loop header:

```zena
let entries = [('apple', 1), ('banana', 2)];

for (let (fruit, count) in entries) {
  print(fruit + ': ' + count.toString());
}
```

### C-style `for` loops

For numeric iteration or manual loop stepping, Zena supports standard
three-clause `for` loops. The loop index must be declared with `var` because it
is mutated:

```zena
for (var i = 0; i < 10; i += 1) {
  print('Index: ' + i.toString());
}
```

All three clauses (`init`, `test`, `update`) are optional:

```zena
// Infinite loop
for (;;) {
  if (shouldStop()) break;
}
```

### `while` loops

`while` loops repeat execution as long as the condition evaluates to `true`:

```zena
var remaining = 5;
while (remaining > 0) {
  print('Countdown: ' + remaining.toString());
  remaining -= 1;
}
```

### `while let` loops

A `while let` loop executes repeatedly as long as the expression continues to
match the pattern. This is particularly useful for iterating over low-level
iterators:

```zena
let iterator = collection.iterator();

// Low-level iterator returns inline (true, element) | inline (false, _)
while (let (true, item) = iterator.next()) {
  processItem(item);
}
```

### `break` and `continue`

Loops support `break` to exit the loop immediately and `continue` to advance to
the next iteration:

```zena
for (var i = 0; i < 10; i += 1) {
  if (i % 2 == 0) {
    continue; // Skip even numbers
  }
  if (i > 7) {
    break; // Stop loop when index exceeds 7
  }
  print(i.toString()); // Prints 1, 3, 5, 7
}
```

## Multi-branch selection with match

The `match` expression replaces traditional `switch` statements found in C,
Java, and JavaScript with a safer, expression-oriented construct:

```zena
let label = match (statusCode) {
  case 200: 'OK'
  case 400: 'Bad Request'
  case 404: 'Not Found'
  case 500: 'Internal Server Error'
  case _: 'Unknown Status'
};
```

`match` improves upon `switch` in several key ways:

- **Expression-oriented**: `match` returns a value directly, eliminating the
  need for mutable variables assigned within branches.
- **No fallthrough**: Each `case` is self-contained; no `break` statements are
  required, preventing accidental fallthrough bugs.
- **Structural matching**: Matches not just primitive values, but records,
  tuples, class instances, and sealed hierarchies.

### Exhaustiveness checking

`match` expressions are **strictly checked for exhaustiveness** at compile time.
The compiler verifies that every possible value of the discriminant type is
handled by at least one arm:

- When matching an **enum** or a **literal union type** (`200 | 404 | 500`), all
  variants must be covered.
- When matching a **sealed class hierarchy**, every subclass must be handled.
- If any possibility is omitted, the compiler reports an error.

### The wildcard pattern (`_`)

When you only need to handle specific values and want a catch-all fallback for
the remainder of a type, use the wildcard pattern `_`:

```zena
let category = match (httpStatus) {
  case 200 | 201 | 204: 'Success'
  case 400 | 401 | 403 | 404: 'Client Error'
  case 500 | 502 | 503: 'Server Error'
  case _: 'Other' // Catches all other integers
};
```

For a comprehensive guide to pattern types, destructuring, and pattern guards,
see [Pattern Matching](/guide/pattern-matching/).

## Jump statements and unwinding

Zena provides several jump statements to control execution flow:

- **`return`**: Exits the current function and optionally produces a return
  value (`return result;`).
- **`throw`**: Throws an exception or error, initiating stack unwinding (see
  [Errors](/guide/errors/)).
- **`using`**: Declares a scope-bound resource that is automatically disposed on
  every exit path, including returns, breaks, throws, and async cancellation
  (see [Resources and Ownership](/guide/resources/)).

## Next

- [Pattern Matching](/guide/pattern-matching/) — irrefutable patterns, match
  arms, and exhaustiveness
- [Collections](/guide/collections/) — arrays, maps, sets, and iterators
- [Errors](/guide/errors/) — exception handling and error types
