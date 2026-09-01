---
title: 'Functions'
description: 'Top-level functions, arrow functions, closures, parameters, multi-value returns, overloading, and async functions in Zena.'
---

Zena provides two primary ways to define functions: top-level **`function`
declarations** (which are never closures and compile to direct machine calls)
and **arrow functions** (which are expressions and can capture their surrounding
lexical scope).

## Top-level functions and arrow functions

Zena separates non-capturing module functions from heap-allocated closures.

### Top-level `function` declarations

A `function` declaration binds a name at the top level of a module. It is a
statement with a block body:

```zena
function add(a: i32, b: i32): i32 {
  return a + b;
}

export function main(): i32 {
  return add(20, 22);
}
```

Top-level `function` declarations are immutable bindings and cannot be
reassigned.

#### No closure environment

A `function` declaration **can never be a closure**. Its body can access only its
own parameters, its own local variables, and module-level declarations (globals,
imports, classes, and other functions).

#### Hoisting and recursion

Top-level `function` declarations are hoisted across the module. They can be
referenced before their declaration and support direct and mutual recursion:

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

#### Passing top-level functions as values

Referencing a top-level function by name produces a first-class function value
that can be passed as an argument, stored in variables, or returned:

```zena
function double(x: i32): i32 { return x * 2; }

function apply(f: (v: i32) => i32, val: i32): i32 {
  return f(val);
}

let result = apply(double, 21); // 42
```

::: note Performance: Direct calls vs. functions as values
Direct calls to top-level `function` declarations compile to static WebAssembly
calls with zero runtime wrapper allocation. When a top-level function is passed
as a first-class value, it is wrapped in a uniform function object with a `null`
captured environment so it can be called interchangeably with closures.
:::

### Arrow functions

Arrow functions are expressions. They can be defined anywhere and can capture
variables from their enclosing scope:

```zena
// Expression body
let square = (x: i32): i32 => x * x;

// Block body
let logAndSquare = (x: i32): i32 => {
  console.log(x);
  return x * x;
};
```

When an arrow function accesses variables from an outer function, the compiler
captures those variables in a heap-allocated context:

```zena
let createMultiplier = (factor: i32) => {
  return (x: i32): i32 => x * factor; // Captures 'factor'
};

let triple = createMultiplier(3);
let value = triple(10); // 30
```

## Parameters and arguments

Function parameters define the inputs accepted by a function.

### Parameter annotations and contextual typing

Parameters require explicit type annotations when their types cannot be inferred:

```zena
let multiply = (a: i32, b: i32): i32 => a * b;
```

When an arrow function is passed as a callback to a function with a known
signature, parameter types are inferred from context and can be omitted:

```zena
let numbers = [1, 2, 3, 4];

// Parameter 'x' is inferred as i32 from Array<i32>.map
let doubled = numbers.map(x => x * 2);
```

### Default parameters

Parameters can specify default values evaluated when the argument is omitted:

```zena
let increment = (x: i32, amount: i32 = 1): i32 => x + amount;

increment(10);    // 11 (uses default amount = 1)
increment(10, 5); // 15 (explicit amount)
```

Default parameters follow these rules:

- **Argument-count based**: Defaults are selected at compile time based on the
  number of arguments supplied at the call site.
- **Fresh evaluation**: Default value expressions are evaluated fresh on every
  call that omits the argument.
- **`null` does not trigger defaults**: Explicitly passing `null` to a nullable
  parameter passes `null` rather than triggering the default expression:
  ```zena
  let greet = (name: String? = 'World') => `Hello, ${name}`;
  greet();     // "Hello, World" (default used)
  greet(null); // "Hello, null" (null passed explicitly)
  ```

### Optional parameters

A parameter marked with `?` is optional and must follow all required parameters.
Its type becomes nullable (`T?`):

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
optional parameters must have a default value** or be explicitly boxed with
`Box<T>`:

```zena
let scale = (value: f64, factor: f64 = 1.0): f64 => value * factor; // OK
// let invalid = (value: f64, factor?: f64) => ...; // Error: primitive cannot be optional without default
```

### Destructured parameters

Function parameters can unpack records and tuples directly in the signature:

```zena
// Record destructuring with inline types
let getDistance = ({x: f64, y: f64}): f64 => (x * x + y * y);

// With property renaming using 'as'
let getArea = ({width as w: f64, height as h: f64}): f64 => w * h;

// Tuple destructuring
let sumPair = ((a, b): (i32, i32)): i32 => a + b;
```

### Parameter arity adaptation

When passing a callback to a higher-order function, you can provide a function
that accepts fewer arguments than the expected signature. The compiler
automatically generates an adapter that discards the extra arguments:

```zena
let items = ['a', 'b', 'c'];

// Array.forEach passes (item: String, index: i32, array: Array<String>)
// The callback only takes 1 argument; extra arguments are safely ignored:
items.forEach(item => {
  console.log(item);
});
```

## Return types and multi-value returns

### Return type inference

The compiler infers a function's return type from the `return` expressions in
its body, or `void` if there are no return expressions:

```zena
let add = (a: i32, b: i32) => a + b; // Inferred return type: i32
let log = (msg: String) => { console.log(msg); }; // Inferred return type: void
```

### When return types are required

Explicit return type annotations are mandatory in the following cases:

1. **Recursive functions**: Any function that calls itself directly or
   participates in a mutual recursion cycle requires an explicit return type
   annotation.
2. **Import cycle boundaries**: Functions referenced across circular module
   imports must annotate all parameters and their return type.
3. **Generators and async functions**: Functions using `gen` must explicitly
   annotate `Iterator<T>`, and functions using `async` must explicitly annotate
   `Future<T>`.

### Multi-value returns (`inline` tuples)

Zena supports returning multiple values without heap allocation using `inline`
tuples. Unlike regular boxed tuples `(i32, i32)`, inline tuples compile directly
to WebAssembly multi-value function returns:

```zena
let divide = (a: i32, b: i32): inline (i32, i32) => {
  return (a / b, a % b); // quotient and remainder
};

// Destructure immediately at the call site:
let (quot, rem) = divide(17, 5);
// quot = 3, rem = 2
```

Inline tuples exist only in return positions and must be destructured
immediately. They cannot be stored in variables or passed into functions as
arguments.

## Function types and compatibility

Function types describe callable signatures and are written with named
parameters:

```zena
type Predicate<T> = (value: T) => boolean;
type BinaryOp = (a: i32, b: i32) => i32;
```

Parameter names are required in function type signatures to distinguish them
from tuple types (`(i32, i32)` is a tuple type; `(a: i32, b: i32) => i32` is a
function type).

### Structural compatibility

Function types are structural. A function value is assignable to a function type
if:

- Its parameter count is less than or equal to the target signature (arity
  adaptation).
- Each parameter type is contravariant (accepts the target parameter type or a
  supertype).
- Its return type is covariant (produces the target return type or a subtype).

### Calling union function types

When a variable is typed as a union of functions (even with different arities),
calling the variable dispatches dynamically to the active function and discards
excess arguments:

```zena
type Fn1 = (a: i32) => i32;
type Fn2 = (a: i32, b: i32) => i32;

let call = (fn: Fn1 | Fn2): i32 => {
  return fn(10, 20); // Dispatches with (10) if fn is Fn1, or (10, 20) if fn is Fn2
};
```

## Function and method overloading

External function declarations (`declare function`) and class methods support
overloading with multiple signatures under the same name:

```zena
declare function printValue(val: i32): void;
declare function printValue(val: String): void;

printValue(42);      // Calls printValue(i32)
printValue('hello'); // Calls printValue(String)
```

The compiler performs overload resolution at compile time by selecting the most
specific matching signature for the argument types at the call site.

## Generators and async functions

Functions can produce lazy sequences or manage asynchronous execution using
dedicated modifiers.

### Generator functions (`gen`)

Generator functions use the `gen` keyword and yield values over time. They return
an `Iterator<T>`:

```zena
gen function range(start: i32, end: i32): Iterator<i32> {
  var current = start;
  while (current < end) {
    yield current;
    current += 1;
  }
}

for (let n in range(0, 5)) {
  console.log(n);
}
```

### Async functions (`async`)

Async functions use the `async` keyword and suspend on futures with `await`.
They return a `Future<T>`:

```zena
async function fetchUser(id: i32): Future<String> {
  let response = await fetch(`https://api.example.com/users/${id}`);
  return response.text();
}
```

## Next

- [Classes](/guide/classes/) — class declarations, constructors, methods, and interfaces
- [Control Flow](/guide/control-flow/) — pattern matching, expressions, and loops
- [Types](/guide/types/) — primitive types, nominal types, unions, and generics
