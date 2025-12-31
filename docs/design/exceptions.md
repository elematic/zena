# Exceptions Design

## Status

- **Status**: Implemented
- **Date**: 2025-12-30

## Overview

Zena uses the **WebAssembly Exception Handling** proposal to provide structured error handling with `try`, `catch`, `throw`, and `finally`.

### Goals

1.  **Recoverable Errors**: Allow programs to catch and handle errors without crashing.
2.  **Familiar Syntax**: Standard `try`, `catch`, `throw`, `finally` syntax.
3.  **Expression-Oriented**: `throw` and `try/catch` are expressions to support immutable bindings.
4.  **Performance**: Zero-cost on the happy path (no overhead if no exception is thrown).

## Syntax & Semantics

### Throw Expression

`throw` is an expression that evaluates to `never`, allowing it in any value context:

```zena
let x = if (isValid) { getValue() } else { throw new Error("Invalid") };
```

### Try/Catch Expression

`try/catch` is an expression, enabling immutable bindings with error handling:

```zena
let content = try {
  readFile("data.txt")
} catch (e) {
  "default content"
};
```

**Type**: The union of the `try` and `catch` block types.

### Finally

`finally` blocks execute for cleanup regardless of success or failure:

```zena
let result = try {
  process(resource)
} catch (e) {
  handleError(e)
} finally {
  resource.release();
};
```

The `finally` block does not contribute to the expression's value.

### Standard Library

```zena
class Error {
  message: string;
  #new(message: string) {
    this.message = message;
  }
}
```

## WASM Implementation

### Tag Design

We use a **single exception tag** with no parameters:

```wat
(tag $zena_exception)  ;; type () -> ()
```

The exception payload (the thrown `Error` object) is stored in a **mutable global variable**:

```wat
(global $exception_payload (mut eqref) (ref.null eq))
```

**Why not pass the payload as a tag parameter?**

The natural design would be `(tag $zena_exception (param eqref))`, passing the Error directly. However, WASM EH's `catch` clause pushes the tag's parameters onto the stack when branching to the catch target block. This creates a control flow problem:

```wat
;; If tag had (param eqref), this would be the structure:
block $catch (param eqref)  ;; catch target needs matching input arity
  try_table (catch $zena_exception $catch)
    ;; try body
  end
  br $done  ;; SUCCESS PATH: Can't enter $catch block normally!
end
```

You can't enter a block with input parameters via normal control flow—only via branch. This breaks the success path where we need to skip the catch handler.

**Solution**: Store payload in global, use void tag:

```wat
block $done
  block $catch  ;; void - no input params
    try_table (catch $zena_exception $catch)
      ;; try body - store result in local
    end
    br $done  ;; success - skip catch
  end
  ;; caught: read payload from global
  global.get $exception_payload
  ;; catch handler
end
```

### Throw Compilation

1. Evaluate the Error expression
2. Store in `$exception_payload` global
3. Execute `throw $zena_exception`

### Try/Catch Compilation

- Use WASM `try_table` with catch clauses that branch to labeled blocks
- On catch, read the payload from the global variable
- Store result values in locals to handle control flow

### Finally Compilation

1. Execute the `try` body, store result in local
2. If successful, run `finally`, then branch to done
3. If exception caught, save payload, run `finally`, then either:
   - Execute catch handler (if present)
   - Rethrow (if no catch handler)

## Alternative Designs Considered

1. **Tag with payload parameter**: `(tag (param eqref))` — Rejected due to catch target block arity issues.

2. **Multiple tags per exception type**: One tag per class. Would require knowing all exception types at compile time and complex pattern matching. Rejected in favor of single tag + runtime type checking.

3. **Using `exnref` with `catch_ref`**: Could enable rethrowing with full context. May revisit when more widely supported.

## Open Questions

1.  **JS Interop**: WASM EH can catch JS exceptions as `externref`. May need a way to distinguish Zena exceptions from JS exceptions.

## Runtime Requirements

Requires `--experimental-wasm-exnref` flag in Node.js (as of v24). The test runner passes this flag to worker subprocesses via `execArgv`.
