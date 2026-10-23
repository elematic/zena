---
title: 'Functions'
description: 'Function declarations, arrow functions, parameters, typing, closures, tail calls, and async functions in Zena.'
---

Zena provides two primary ways to define functions: top-level **`function`
declarations**, which are statements that cannot be closures and compile to
direct WebAssembly calls, and **arrow functions**, which are expressions that can
capture variables from their enclosing lexical scopes.

## Function declarations and arrow functions

### `function` declarations

A `function` declaration binds a name at the top level of a library:

```zena
function add(a: i32, b: i32): i32 {
  return a + b;
}

export function main(): i32 {
  return add(20, 22);
}
```

`function` declarations have the following characteristics:

- **Library-level statement**: `function` declarations can only appear at the top
  level of a library. They cannot be nested inside blocks, loops, or other functions:

```zena
let makeCounter = (start: i32) => {
  function bad(): i32 {
  // @error("function"): 'function' declarations may only appear at the top level of a library.
    return start;
  }
  return bad;
};
```

- **Mandatory block body**: The body of a `function` declaration must always be a
  block enclosed in `{ ... }`.
- **Immutable binding**: Like a `let` variable, the name of a `function`
  declaration cannot be reassigned:

```zena
function noop(): void {}
noop = noop;
//^^ error: Cannot assign to immutable variable 'noop'.
```

- **Hoisting and mutual recursion**: `function` declarations are hoisted across the
  library. They can be referenced before their declaration and can participate in
  direct or mutual recursion without declaration-order constraints:

```zena
export function isEven(n: i32): boolean {
  if (n == 0) { return true; }
  return isOdd(n - 1);
}

function isOdd(n: i32): boolean {
  if (n == 0) { return false; }
  return isEven(n - 1);
}
```

- **First-class values**: Referencing a `function` declaration by its name
  evaluates to a first-class function value that can be stored in variables,
  passed to functions, or returned:

```zena
function double(x: i32): i32 { return x * 2; }

function apply(f: (v: i32) => i32, val: i32): i32 {
  return f(val);
}

let result = apply(double, 21); // 42
```

### Arrow functions

Arrow functions are expressions. They can be defined in any expression context,
assigned to variables, or passed inline as callbacks:

```zena
// Expression body
let square = (x: i32): i32 => x * x;

// Block body
let logAndSquare = (x: i32): i32 => {
  console.log(x);
  return x * x;
};
```

The parameter list of an arrow function always requires parentheses, even when
declaring a single unannotated parameter: `(x) => x * 2`.

Unlike `function` declarations, arrow functions can close over variables from
their surrounding lexical environment.

### Top-level functions versus closures

The distinction between `function` declarations and arrow functions is rooted in
environment allocation and execution guarantees:

1. **Zero-allocation direct calls**: Direct calls to a `function` declaration
   compile to direct WebAssembly `call` instructions. The compiler guarantees that
   no context object or heap wrapper is allocated at the call site.
2. **Guaranteed non-capturing**: Because a `function` declaration can only appear
   at library scope, its body can only reach its own parameters, its own local
   variables, and library-level declarations (globals, imports, classes, and other
   functions). It can never accidentally capture lexical state from an outer
   scope.
3. **Uniform values**: When either a `function` declaration or an arrow function
   is passed as a first-class value, it satisfies the standard function type
   interface. For `function` declarations, the function object is created with an
   empty (`null`) environment.

## Parameters

### Parameter annotations and immutability

Function parameters require type annotations when their types cannot be inferred
from context.

Parameters are immutable bindings within the function body. Attempting to
reassign a parameter or update it with a compound assignment operator produces a
compile-time error:

```zena
let increment = (x: i32): void => {
  x += 1;
  // @error("x"): Cannot assign to immutable variable 'x'.
};
```

To modify a parameter's value locally, declare a mutable `var` initialized with
the parameter.

### Default parameters

Parameters can define default value expressions that are evaluated when the
caller omits the corresponding argument:

```zena
let increment = (x: i32, amount: i32 = 1): i32 => x + amount;

increment(10);    // 11 (uses default amount = 1)
increment(10, 5); // 15 (explicit argument supplied)
```

Default parameters follow these rules:

- **Argument-count based**: Defaults are selected at compile time based on the
  number of arguments supplied at the call site.
- **Fresh evaluation**: Default value expressions are evaluated fresh on every call
  that omits the argument. If a default expression constructs an object or array,
  each call receives a distinct instance.
- **`null` does not trigger defaults**: Explicitly passing `null` passes `null`
  rather than evaluating the default expression:

```zena
let greet = (name: String? = 'World'): String => `Hello, ${name}`;

greet();       // "Hello, World" (default evaluated)
greet(null);   // "Hello, null"  (null passed explicitly)
```

- **Access to `this` in methods**: Default value expressions in class methods can
  reference `this` and class fields, including private `#` fields:

```zena
class Cursor {
  #position: i32 = 0;

  seek(to: i32 = this.#position): i32 {
    return to;
  }
}
```

### Optional parameters

A parameter marked with `?` is optional and must follow all required parameters.
When no default value is provided, its type becomes nullable (`T?`):

```zena
let greet = (name: String, title?: String): String => {
  if (title != null) {
    return `Hello, ${title} ${name}`;
  }
  return `Hello, ${name}`;
};

greet('Alice');        // "Hello, Alice"
greet('Bob', 'Dr.');   // "Hello, Dr. Bob"
```

Because WebAssembly primitives cannot hold `null` without boxing, **primitive
optional parameters must provide a default value** or be explicitly wrapped in
`Box<T>`:

```zena
let scale = (value: f64, factor: f64 = 1.0): f64 => value * factor; // Valid
let wrap = (value: f64, factor?: Box<f64>): f64 => value;           // Valid
```

### Destructured parameters

Function parameters, like variable declarations, accept any irrefutable pattern
to unpack incoming arguments directly in the parameter list. This includes
records, tuples, arrays, and class instances.

#### Record patterns

For records, the **combined syntax** declares property names and types together,
avoiding duplication:

```zena
let getDistance = ({x: f64, y: f64}): f64 => x * x + y * y;

// With property renaming using `as`
let getArea = ({width as w: f64, height as h: f64}): f64 => w * h;

// With property defaults
let getOffset = ({x: i32 = 0, y: i32 = 0}): i32 => x + y;
```

Alternatively, the **separate syntax** places the pattern and explicit type
annotation apart:

```zena
let getDistance = ({x, y}: {x: f64, y: f64}): f64 => x * x + y * y;
```

The separate syntax also destructures class instances by field name:

```zena
class Point(x: i32, y: i32)

let getSum = ({x, y}: Point): i32 => x + y;
```

#### Tuple patterns

Tuples are unpacked using parenthesized patterns:

```zena
let sumPair = ((a, b): (i32, i32)): i32 => a + b;
```

#### Array patterns

Arrays are unpacked using bracketed patterns, optionally including rest
elements (`...`):

```zena
let sumFirstTwo = ([a, b]: Array<i32>): i32 => a + b;

// With rest pattern
let headAndTail = ([head, ...tail]: Array<i32>): i32 => head + tail.length;
```

#### Destructuring with default values

Destructured parameters can specify default values for individual fields or for
the entire parameter when omitted:

```zena
let origin = ({x: i32, y: i32} = {x: 0, y: 0}): i32 => x + y;
origin();             // 0 (parameter default used)
origin({x: 3, y: 4}); // 7 (explicit argument supplied)
```

## Types and signatures

### Return types

A function's return type is inferred from the return expressions in its body. If
the body contains no return expressions, or if control flows off the end of a
block without returning a value, the return type is inferred as `void`:

```zena
let add = (a: i32, b: i32) => a + b;              // Inferred return type: i32
let log = (msg: String) => { console.log(msg); }; // Inferred return type: void
```

An explicit return type annotation follows the parameter list after a colon:

```zena
function multiply(a: i32, b: i32): i32 {
  return a * b;
}
```

#### When return types are required

Return type annotations are optional in most cases, including exported functions
under normal conditions. However, an explicit return type is mandatory in the
following situations:

1. **Direct and mutual recursion**: When a function calls itself directly or
   participates in a mutual recursion cycle, the compiler cannot infer the return
   type from a call whose type is still unresolved:

```zena
function countdown(n: i32) {
// @error("countdown"): Recursive function requires an explicit return type annotation.
  if (n > 0) {
    countdown(n - 1);
  }
}
```

_(Non-cyclic forward references do not require return type annotations; the
compiler eagerly infers the callee's return type upon first reference)._

2. **Functions crossing an import cycle**: When two libraries import each other in
   a cycle, any function imported across the cyclic edge must provide a complete
   signature with all parameter types and the return type explicitly annotated.
3. **Functions using `tail return`**: The enclosing function must declare its
   return type so the compiler can verify at compile time that the tail call returns
   the exact same type.
4. **Generators and async functions**: Generator functions must declare
   `Iterator<T>` (or infer `T` from yields), and async functions must declare
   `Future<T>`.

### Multi-value returns (`inline` tuples)

Zena supports returning multiple values without allocating heap objects using
`inline` tuples. These compile directly to WebAssembly multi-value function
returns:

```zena
let divide = (a: i32, b: i32): inline (i32, i32) => {
  return (a / b, a % b);
};

let (quot, rem) = divide(17, 5);
// quot = 3, rem = 2
```

An inline tuple type is written only in return position. Destructuring the
result at the call site uses the values directly; storing it in a variable,
field or array, or passing it as an argument, allocates its boxed tuple.

### Contextual typing

When an arrow function is passed as an argument to a function or method with an
expected signature, the parameter types of the arrow function are inferred from
context:

```zena
let numbers = [1, 2, 3, 4];

// Parameter 'x' is inferred as i32 from Array<i32>.map
let doubled = numbers.map((x) => x * 2);
```

Contextual typing also operates with generic callees:

```zena
let sortBy = <T>(items: Array<T>, compare: (a: T, b: T) => i32): void => { ... };

// T is inferred from items, so 'a' and 'b' receive that type contextually
sortBy(items, (a, b) => a.name.length - b.name.length);
```

Explicit type annotations on closure parameters take precedence over contextual
types.

### Generic functions

Functions can declare type parameters within angle brackets before the parameter
list:

```zena
function identity<T>(value: T): T {
  return value;
}

let id = <T>(value: T): T => value;
```

Type parameters can be bounded with `extends` constraints:

```zena
interface Printable {
  toString(): String;
}

function printItem<T extends Printable>(item: T): void {
  console.log(item.toString());
}
```

Type arguments are typically inferred from arguments at the call site, but can
also be supplied explicitly:

```zena
let str = identity<String>('hello');
```

### Function types

Function types describe callable signatures. They are written with parameter
names followed by types:

```zena
type Predicate<T> = (value: T) => boolean;
type BinaryOp = (a: i32, b: i32) => i32;
```

Parameter names are required in function type signatures to distinguish them
syntactically from tuple types (`(i32, i32)` is a tuple type; `(a: i32, b: i32) =>
i32` is a function type).

Function types are structural:

- **Parameter types** are contravariant (accepting the specified type or any
  supertype).
- **Return types** are covariant (producing the specified type or any subtype).

### Function overloading

External function declarations (`declare function`) and class methods support
overloading with multiple signatures under the same name:

```zena
declare function format(value: i32): String;
declare function format(value: f64): String;

format(42);   // Calls format(i32)
format(3.14); // Calls format(f64)
```

The compiler resolves overloads at compile time by selecting the signature whose
parameter types most specifically match the call-site argument types. Regular
top-level functions do not support overloading.

## Closures

### Environment capture

Arrow functions can capture variables from their enclosing lexical scopes.
Captured variables are stored in a heap-allocated context object, allowing them to
outlive the scope in which they were created:

```zena
let makeCounter = (start: i32) => {
  var count = start;
  return () => {
    count += 1;
    return count;
  };
};

let counter = makeCounter(10);
counter(); // 11
counter(); // 12
```

When a closure captures a mutable `var` variable, modifications made through the
closure affect the original binding, and changes made by the outer scope are
observed by the closure.

### Arity adaptation

Zena supports passing callbacks that accept fewer arguments than the expected
signature. The compiler automatically synthesizes an adapter closure that discards
excess arguments:

```zena
let items = ['a', 'b', 'c'];

// Array.forEach passes (item: String, index: i32, array: Array<String>)
// The callback declares only 1 parameter; extra arguments are safely ignored:
items.forEach((item) => {
  console.log(item);
});
```

Arity adaptation also applies when calling a union of function types with
differing parameter counts:

```zena
type Fn1 = (a: i32) => i32;
type Fn2 = (a: i32, b: i32) => i32;

let call = (fn: Fn1 | Fn2): i32 => {
  return fn(10, 20); // Passes (10) if fn is Fn1, or (10, 20) if fn is Fn2
};
```

## Tail calls

`tail return f(x);` compiles the call to WebAssembly's `return_call` instruction.
The current stack frame is discarded before the callee runs, allowing recursive
functions to execute in constant stack space:

```zena
function sum(n: i32, acc: i32 = 0): i32 {
  if (n == 0) {
    return acc;
  }
  tail return sum(n - 1, acc + n);
}

sum(1000000); // Executes in constant stack space
```

### Why tail calls are explicit

Tail-call optimization in Zena requires the `tail` keyword rather than being
performed automatically:

1. **Guaranteed optimization**: A program relying on tail-call elimination to
   prevent stack overflow should not fail silently if an edit alters the call
   position.
2. **Stack trace preservation**: A tail call discards the caller's frame, removing
   it from stack traces and debugging backtraces. Requiring `tail return` ensures
   frames are erased only when intended.

`tail` is a contextual keyword: it is only recognized as a modifier immediately
preceding `return`.

### Rules and restrictions

The compiler enforces the following constraints on `tail return`:

- **Single call operand**: The operand must be a single function or method call
  (`f(x)`, `o.m(x)`, `this.#m(x)`). Expressions wrapping a call (such as
  `tail return f(x) + 1;`) or constructor invocations (`new C()`) are rejected:

```zena
function count(): i32 { return 1; }

function invalidTail(): i32 {
  tail return count() + 1;
  // @error: 'tail return' returns a call
}
```

- **Enclosing return type declaration**: The enclosing function must declare an
  explicit return type.
- **Exact return type match**: The callee must return the exact type declared by
  the enclosing function. No widening or subtyping conversions are allowed:

```zena
class Animal {}
class Dog extends Animal {}

function makeDog(): Dog { return new Dog(); }

function widen(): Animal {
  tail return makeDog();
  // @error: 'tail return' requires the call to return 'Animal'
}
```

- **Not allowed inside `try` blocks**: A `try` block owes exception handling and
  potential `finally` execution to the current frame:

```zena
function inTry(): i32 {
  try {
    tail return count();
    // @error: 'tail return' is not allowed inside a 'try'
  } catch (e) {
    return 0;
  }
}
```

- **Not allowed with live `using` bindings**: Any active resource acquired with
  `using` must have its disposer run before the frame is destroyed.
- **Not allowed in constructors or generators**: Constructors return newly
  allocated instances, and generators return lazy iterators. (Async functions
  support tail calls through future adoption, described below).
- **Multi-value returns**: `tail return` is not currently supported for functions
  returning `inline` tuples.

### Tail return in async functions (adoption)

In an asynchronous function returning `Future<T>`, writing `tail return f();`
performs **future adoption** rather than awaiting the callee:

```zena
async function countdown(n: i32): Future<i32> {
  if (n == 0) {
    tail return base();
  }
  tail return countdown(n - 1);
}
```

In an ordinary `return await f();`, when the callee settles, the event loop must
schedule a microtask to resume the caller's frame solely to transfer the result
into the caller's future.

With `tail return f();`:

- **Immediate frame retirement**: The caller frame retires immediately without
  waiting for the callee to resolve.
- **Direct settlement**: When `f()` settles, the caller's future settles
  synchronously from it without resuming the caller frame.
- **Zero-microtask chaining**: Because adoption propagates synchronously, no
  intermediate microtask hop is scheduled.
- **Operand requirement**: The operand to `tail return` in an async function must
  statically evaluate to the declared `Future<T>` itself (not the unwrapped
  value `T`):

```zena
async function getValue(): Future<i32> {
  tail return 42;
  // @error: Type mismatch: 'tail return' in an async function adopts a 'Future<i32>', got 'i32'.
}
```

## Generator functions

A generator function produces a lazy sequence of values. It is declared with the
`gen` modifier and returns an `Iterator<T>`. Both function declarations and arrow
functions can be generators:

```zena
gen function range(start: i32, end: i32): Iterator<i32> {
  var current = start;
  while (current < end) {
    yield current;
    current += 1;
  }
}

let countdown = gen (start: i32): Iterator<i32> => {
  var n = start;
  while (n > 0) {
    yield n;
    n -= 1;
  }
};
```

When called, a generator does not execute its body immediately; it returns a
suspended iterator. The body executes on demand as elements are requested by a
`for`-in loop or manual calls to `.next()`:

```zena
for (let item in range(0, 5)) {
  console.log(item.toString());
}
```

### The Iterator return type and yield

Generator functions adhere to the following typing and suspension rules:

- **Declared return type**: The declared return type must be `Iterator<T>`. When the
  return type annotation is omitted, `T` is inferred from the expressions passed to
  `yield`.
- **`yield` expressions**: The `yield value;` statement produces an element of type
  `T` and pauses execution, yielding control back to the caller until the next
  element is requested.

### Generator return restrictions

Generators complete by falling off the end of the body or via a bare `return;`.
Returning a value (`return value;`) is a compile-time error:

```zena
let g = gen (): Iterator<i32> => {
  yield 1;
  return 2;
  // @error: Generators cannot return a value
};
```

### Deterministic disposal

If consumption of an iterator terminates early — such as through a `break` or
`return` in a `for`-in loop, or because an exception was thrown — the generator is
disposed immediately. Any enclosing `finally` blocks and active `using` resource
cleanups execute deterministically at that point rather than waiting for garbage
collection.

## Async functions

An async function performs asynchronous work and returns a `Future<T>`. Async
functions can be top-level function declarations, arrow expressions, or class
methods:

```zena
import {Future} from 'zena:async';

async function fetchUser(id: i32): Future<String> {
  let response = await httpGet('https://api.example.com/users/' + id.toString());
  return response.body;
}

let loadConfig = async (): Future<String> => {
  let file = await readFile('config.json');
  return file.content;
};
```

### Async syntax and eager execution

Async functions in Zena follow an eager-start model:

- **Eager start**: When an async function is called, execution begins synchronously
  and proceeds until the first unresolved `await` expression. It then returns a
  pending `Future<T>` to the caller.
- **Concurrency without spawn primitives**: Because async functions start eagerly,
  initiating multiple operations concurrently does not require special spawning
  constructs:

```zena
let loadDashboard = async (): Future<Dashboard> => {
  // Both calls execute synchronously until their first unresolved await:
  let userFuture = fetchUser(1);
  let feedFuture = fetchFeed();

  // Both operations proceed concurrently while awaited in sequence:
  let user = await userFuture;
  let feed = await feedFuture;

  return new Dashboard(user, feed);
};
```

- **Run-to-completion**: Code between suspension points executes to completion on a
  single logical thread without preemption or data races.

### Return types and return expressions

The typing of an async function distinguishes between the return type of the function
itself and the return expressions inside its body:

- **Declared return type**: The declared return type must be `Future<T>`. If the
  annotation is omitted, the compiler infers `T` from the return expressions and
  types the function as `Future<T>`.
- **Return expressions**: Inside an async body, a `return expr;` statement expects
  an expression of type `T` (the unwrapped value type), not `Future<T>`. The runtime
  automatically wraps `expr` into the returned `Future<T>`:

```zena
async function compute(): Future<i32> {
  return 42; // Returns i32; the caller receives Future<i32>
}
```

- **Contrast with `tail return`**: Ordinary `return` returns an unwrapped value `T`.
  In contrast, `tail return callee();` inside an async function requires `callee()` to
  return the declared `Future<T>` itself, performing future adoption rather than value
  wrapping.

### Absence of implicit future flattening

In JavaScript, `Promise` objects automatically flatten nested promises. Resolving a
promise with another promise or returning a promise from a `.then()` handler collapses
nested wrappers so that a `Promise<Promise<T>>` collapses to `Promise<T>`.

In Zena, `Future<T>` is a nominal generic class. The language does not perform
implicit runtime flattening:

- **`Future<Future<T>>` is distinct and representable**: A future containing another
  future does not collapse into a single future.
- **No recursive unwrapping**: Types in Zena mean what they declare. Generic code
  instantiated with `T = Future<U>` retains `Future<Future<U>>` without ambiguous
  runtime type tests or recursive type operators.
- **Explicit unwrapping**: Unwrapping a future is always explicit through `await`.

### Awaiting futures at return

When an async function produces its result by calling another async function
`f(): Future<T>`, writing `return f();` is a compile-time type mismatch because
`return` expects `T`:

```zena
async function inner(): Future<i32> {
  return 42;
}

async function outer(): Future<i32> {
  return inner();
  // @error: Type mismatch
}
```

To forward the result of `inner()`, write `return await inner();`:

```zena
async function outer(): Future<i32> {
  return await inner(); // Awaits the Future<i32> to produce i32
}
```

Using `return await` provides the following guarantees:

1. **Type unwrapping**: `await` evaluates `Future<T>` to `T`, matching the expected
   return value type.
2. **Explicit suspension**: The suspension point remains explicit. If `inner()` fails
   or cancellation occurs, the failure is observed in the caller's frame.
3. **Deterministic cleanup**: If `return await inner();` is inside a `try` block or
   a scope with live `using` bindings, any `catch` or `finally` handlers in `outer`
   execute after `inner()` settles.

When an async function delegates entirely to another future without needing to observe
its outcome, run further cleanup, or handle its errors locally, you can use
`tail return inner();` instead. As described in [Tail calls](#tail-calls), `tail return`
adopts `inner()`'s future directly, retiring the caller frame immediately with zero
intermediate microtask hops.

### Exception propagation

Async functions handle exceptions uniformly across eager execution and subsequent
resumptions:

- **Eager exceptions**: If an exception is thrown in the eager section before the
  first `await`, it does not escape as a synchronous throw from the function call.
  Instead, the exception is caught by the async state machine, and the function
  returns a rejected `Future<T>` containing the error.
- **Continuation exceptions**: Exceptions thrown after resuming from an `await`
  similarly reject the function's `Future<T>`.
- **Awaiting a rejected future**: When an async function awaits a rejected future,
  the error resurfaces as a standard `throw` at the `await` expression:

```zena
async function risky(): Future<i32> {
  throw new Error('Something went wrong');
}

async function run(): Future<i32> {
  try {
    let value = await risky();
    return value;
  } catch (e) {
    console.log('Caught error: ' + e.message);
    return 0;
  }
}
```

### Microtask queue and execution model

Asynchronous execution in Zena is driven by a cooperative, single-threaded event
loop:

- **Deterministic FIFO queue**: Continuations scheduled by settling futures are
  placed in a first-in, first-out (FIFO) microtask queue managed by `zena:async`.
- **Always-async resumption**: Awaiting an already-completed future does not resume
  the continuation synchronously inline. Resumption is always scheduled on the
  microtask queue. This guarantees consistent ordering and prevents stack overflows
  caused by deeply recursive synchronous completions.
- **Platform execution**: On platforms without an ambient event loop (such as
  standalone WebAssembly run under `zena-cli` or `wasmtime`), the runtime drains the
  microtask queue to completion before the program exits. On JavaScript hosts and
  browsers, the queue integrates with the host microtask loop.
