---
title: 'Exceptions'
description: 'Exception handling in Zena: the Error class, throw, try/catch, finally, try expressions, and WebAssembly representation.'
---

Exceptions in Zena represent unexpected or unrecoverable failures that propagate
automatically along the call stack.

Unlike languages that allow throwing arbitrary values (such as strings, numbers,
or records), Zena enforces strict type safety: only instances of the `Error`
class (or its subclasses) can be thrown.

## The Error class

The standard error class is provided by `zena:core`:

```zena
import { Error } from 'zena:core';

let err = new Error('Configuration file not found');
```

### Creating custom error classes

Custom application errors are defined by extending `Error`:

```zena
import { Error } from 'zena:core';

class ValidationError extends Error {
  field: String;

  new(this.field, message: String) : super(message) {}
}

class NetworkError extends Error {
  statusCode: i32;

  new(this.statusCode, message: String) : super(message) {}
}
```

### Error properties and causes

Every `Error` instance exposes:

- `message: String`: A human-readable description of the error.
- `cause?: Error`: An optional reference to an underlying error that triggered
  this failure, enabling error chaining.

### Built-in Error subclasses

The standard prelude also exports specialized `Error` subclasses from `zena:core`,
such as `ContractError`, which is thrown at runtime whenever a
[`requires`, `ensures`, or `invariant`](/reference/contracts/) contract clause
evaluates to `false`.

## throw

The `throw` statement raises an exception and halts sequential execution:

```zena
function parsePort(text: String): i32 {
  let port = parseInt(text);
  if (port < 1 || port > 65535) {
    throw new Error('Port number out of range: ' + text);
  }
  return port;
}
```

### Strict type requirement

The operand to `throw` must evaluate to an instance of `Error`. Attempting to
throw an arbitrary primitive or non-Error object is a compile-time error:

```zena
throw 'Something went wrong'; // Error: Thrown value must be an instance of Error.
throw 404;                     // Error: Thrown value must be an instance of Error.
```

### The never type in expressions

The `throw` expression has static type `never` (the bottom type). Because `never | T`
simplifies directly to `T`, throwing can be embedded directly in expression arms:

```zena
let port = if (rawPort > 0) rawPort else throw new Error('Invalid port');
```

## try/catch

The `try/catch` statement intercepts exceptions thrown during the execution of a
block:

```zena
try {
  let data = loadFile('config.json');
  process(data);
} catch (e) {
  println('Failed to load configuration: ' + e.message);
}
```

### Catch parameter typing

The error binding in a `catch` clause is automatically typed as `Error`:

```zena
try {
  riskyOperation();
} catch (e) {
  // 'e' is statically typed as Error
  println(e.message);
}
```

If the specific error details are not needed, the catch parameter can be omitted
entirely:

```zena
try {
  cleanup();
} catch {
  // Silently ignore failures
}
```

### Differentiating error types

To handle specific error subclasses, use [`is` type checks](/reference/type-testing/) or
[`match` expressions](/reference/pattern-matching/) within the catch block:

```zena
try {
  sendRequest();
} catch (e) {
  if (e is NetworkError) {
    retry(e.statusCode);
  } else {
    throw e; // Re-throw unhandled errors
  }
}
```

## finally

The `finally` block executes unconditionally when control leaves a `try` or
`catch` block, regardless of whether execution completed normally, returned
early, threw an exception, or was [cancelled](/reference/cancellation/) (see
[Blocks and Exits](/reference/blocks-and-exits/)):

```zena
var socket: Socket? = null;

try {
  socket = openSocket();
  socket.send('PING');
} finally {
  // Always runs:
  if (socket != null) {
    socket.close();
  }
}
```

::: tip Prefer using for resources

For managing disposable resources like files, sockets, and memory buffers,
prefer the [`using` statement](/reference/blocks-and-exits/) (see
[Ownership and Resources](/reference/ownership/)) over manual `try/finally` blocks.
`using` guarantees cleanup with less boilerplate and composes automatically with
reverse cleanup ordering.

:::

## try as an expression

Zena allows `try/catch` blocks to be used as value-producing expressions. This
provides a clean idiom for supplying fallback defaults when operations fail:

```zena
let port = try {
  parseInt(env['PORT'])
} catch {
  8080 // Default port if parsing throws
};
```

Both the `try` block and the `catch` block must evaluate to compatible types;
the resulting type is the union of their branch types.

## Representation

Zena compiles exceptions directly to the **WebAssembly Exception Handling (EH)**
standard:

- Every Zena module imports or declares a native WebAssembly `tag` representing
  the Zena error envelope.
- `throw` compiles directly to the Wasm `throw` instruction, passing a reference
  to the `Error` instance (`ref null $Error`).
- `try/catch` compiles to native WebAssembly `try_table` and `catch` instructions.
- Stack unwinding is handled natively by the WebAssembly runtime engine (such as
  Wasmtime or V8) with zero runtime interpretation overhead on non-throwing code
  paths.
