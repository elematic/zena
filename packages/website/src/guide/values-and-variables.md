---
title: 'Values and Variables'
description: 'Variable declarations, mutability, scope, type inference, and destructuring in Zena.'
---

Variables in Zena are declared using `let` or `var`. `let` creates an immutable
binding, while `var` creates a mutable variable.

## let and var

`let` creates an immutable binding. Once initialized, the binding cannot be
reassigned:

```zena
let x = 42;
x = 43; // Compile error: Cannot reassign immutable variable 'x'
```

`var` creates a mutable variable that can be reassigned with the assignment
operator `=` or compound assignment operators:

```zena
var count = 0;
count = 10;
```

## Local and module variables

Zena distinguishes between local variables declared inside functions or blocks
and module-level variables declared at the top level of a file.

### Local variables

Variables declared inside function bodies, blocks (`{ ... }`), `if` expressions,
and loops are local variables:

```zena
let calculate = (a: i32, b: i32): i32 => {
  let sum = a + b;
  return sum * 2;
};
```

Local variables are compiled to Wasm locals, unless there are captured by a
closure, in which case they're compiled to a closure context object that lives
on the heap.

### Module-level variables

Variables declared at the top level of a `.zena` file are module-level
variables:

```zena
let maxRetries = 3;
var currentSessionId = 0;

export let defaultTimeout = 5000;
export var activeConnections = 0;

function getMaxRetries(): i32 {
  return maxRetries;
}
```

Module-level variables are compiled to WebAssembly globals and initialized in
declaration order during module startup. Because module-level variables reside
in Wasm globals, top-level `function` declarations can reference them directly
without creating closures or capturing environments.

Top-level variables can be exported using the `export` keyword so other modules
can import them.

::: note Potential change
Module-level initializers currently execute during module startup, though future
versions of Zena may restrict them to WebAssembly-compatible constant global
initializers. See [elematic/zena#125](https://github.com/elematic/zena/issues/125).
:::

### Scoping and shadowing

Variables in Zena are lexically scoped to the block in which they are declared.
A variable declared in an inner block can shadow a variable of the same name in
an outer block:

```zena
let limit = 100;

if (limit > 50) {
  let limit = 10; // Shadows the outer 'limit' within this block
  console.log(limit); // 10
}

console.log(limit); // 100
```

Declaring two variables with the same name in the same lexical scope is a
compile-time error.

## Type annotations and inference

Variables can include an explicit type annotation after the identifier:

```zena
let count: i32 = 42;
var rate: f64 = 3.5;
let name: String = 'Zena';
```

When an annotation is omitted, the compiler infers the variable's type from its
initializing expression:

```zena
let count = 42;     // Inferred as i32
let rate = 3.5;     // Inferred as f64
let message = 'hi'; // Inferred as String
let isReady = true; // Inferred as true (literal type)
```

### Literal types and type widening

Numeric and string literals default to their base types (`i32`, `f64`, `String`)
unless given an explicit literal type annotation (such as `let x: 42 = 42;`) or
contextual typing from a union.

Boolean literals (`true`, `false`) are literal types by default:

- **Immutable bindings (`let`)** preserve boolean literal types:
  ```zena
  let isEnabled = true; // Type: true
  ```
- **Mutable bindings (`var`)** widen literal types to their base types (`boolean`)
  so the variable can be reassigned:
  ```zena
  var isEnabled = true; // Type: boolean (widened from true)
  isEnabled = false;    // OK
  ```

If a mutable variable requires a specific literal or union type, supply an
explicit type annotation:

```zena
var mode: 'read' | 'write' = 'read';
mode = 'write'; // OK
mode = 'exec';  // Compile error: Type '"exec"' is not assignable to '"read" | "write"'
```

## Destructuring

Variable declarations support destructuring patterns to unpack values from
records, tuples, arrays, and classes directly into bindings.

### Record destructuring

Record fields are extracted by matching field names inside `{}`:

```zena
let user = { id: 1, name: 'Alice', role: 'admin' };

let { id, name } = user;
```

To bind a field to a different variable name, use the `as` keyword:

```zena
let { id as userId, name as userName } = user;
```

### Tuple destructuring

Tuple elements are extracted by position using parentheses `()`:

```zena
let point = (10.0, 20.0);
let (x, y) = point;

// Elements can be skipped with commas:
let triple = (1, 2, 3);
let (first, , third) = triple;
```

Tuple destructuring is commonly used with multi-value returns from standard
library functions:

```zena
let scores = {'Alice' => 95, 'Bob' => 87};
let (found, score) = scores.get('Alice');
```

### Array destructuring

Arrays (`FixedArray`, `GrowableArray`, and the `Array` interface) are unpacked
using bracket syntax `[]`:

```zena
let numbers = [10, 20, 30, 40];

let [first, second] = numbers;
let [a, , c] = numbers; // Skipping elements

// Rest patterns bind remaining elements as a FixedArray:
let [head, ...tail] = numbers;
```

### Class destructuring

Class instances can be destructured using field patterns:

```zena
class Point {
  x: f64;
  y: f64;
  new(this.x, this.y);
}

let p = new Point(1.0, 2.0);
let { x, y } = p;
let { x as px, y as py } = p;
```

### Nested patterns and mutability

Destructuring patterns can be nested to unpack complex data structures in a
single declaration:

```zena
let config = {
  server: { host: 'localhost', port: 8080 },
  retries: 3,
};

let { server: { host, port }, retries } = config;
```

Destructuring declarations can also use `var` to create mutable bindings for each
unpacked variable:

```zena
var (currentX, currentY) = (0.0, 0.0);
currentX += 5.0;
```

## Next

- [Types](/guide/types/) — primitive types, references, unions, and aliases
- [Functions](/guide/functions/) — arrow functions, parameters, and closures
- [Control Flow](/guide/control-flow/) — `if`, `match`, loops, and expression orientation
