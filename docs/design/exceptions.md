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
  message: String;
  new(message: String) {
    this.message = message;
  }
}
```

## WASM Implementation

### Tag Design

We use a **single exception tag** with no parameters for every user
`throw`:

```wat
(tag $zena_exception)  ;; type () -> ()
```

(Cancellation raises on a second, payload-free tag that user `catch`
does not lower against — see
[cancellation.md](cancellation.md). "Single tag" here means one tag
for the error channel, not one tag per module.)

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

The finalizer is emitted **once**. Every way out of the protected part
parks what it was doing in an exit-code local and branches to one
dispatch block, which runs the finalizer and then replays that exit
(`lowerTryFinally`, `codegen/ir/control-flow.zena`):

```
protector:  try_br(tag, protectedB, ehB)
protectedB: [inner try_br(tag, bodyB, catchB) when there is a catch]
            body/handler; completing normally parks the value and the
            NORMAL code; return/break/continue park theirs
ehB:        payloadVar = <payload global>; park THROW
dispatch:   <the finalizer>, then replay the code — fall through, ret,
            br to the loop's exit or continue target, or restore the
            payload global and rethrow
```

Three things fall out of that shape:

- **The dispatch sits outside the region.** `ehB` is the `try_br`'s
  handler edge, which the emitter streams past the `end` of the
  `try_table`, so a block it branches to is never inside. A finalizer
  that throws therefore leaves rather than re-entering itself. This is
  also why there is one copy and not one per exit edge — a copy on the
  normal path would sit inside the region.
- **A `catch` handler nests inside the region**, in its own `try_br`,
  so a handler that throws still runs the finalizer.
- **The payload rides a local, not the global.** The finalizer may
  itself throw and catch, which overwrites the global before the
  rethrow would read it.

`return`, `break` and `continue` reach the dispatch because lowering
keeps a stack of open finalizers (`cx.finallyScopes`); an exit replayed
at one dispatch re-enters that stack truncated, so nested finalizers
run inside-out with no duplicated code. A `break`/`continue` whose loop
was opened _inside_ the region does not leave it and owes nothing,
which `FinallyScope.loopDepth` is what distinguishes.

An `await` or `yield` inside a `finally`-protected region is
supported. The dispatch rides wasm locals, and a local does not
survive a suspension — so the split passes move every mutable variable
into the suspension frame (`rewriteVarsToFrame` in generators.zena),
one nullable-weakened field per variable, with `var_get`/`var_set`
rewritten to frame reads and writes. Field defaults match the local
defaults the variables had. This lifted the former loud bails
(`suspension inside a try with a finalizer`, `suspension inside a
using region`).

## Alternative Designs Considered

1. **Tag with payload parameter**: `(tag (param eqref))` — Rejected due to catch target block arity issues.

2. **Multiple tags per exception type**: One tag per class. Would require knowing all exception types at compile time and complex pattern matching. Rejected in favor of single tag + runtime type checking. (The cancellation tag is not this: it is a second _channel_ with different catchability, not a per-type discriminator.)

3. **Using `exnref` with `catch_ref`**: Could enable rethrowing with full context. May revisit when more widely supported.

## Open Questions

1.  **JS Interop**: WASM EH can catch JS exceptions as `externref`. May need a way to distinguish Zena exceptions from JS exceptions.

2.  **Try/Catch Statement Form**: Resolved. `never` type handling was improved so `throw` unifies with `void` (and other types).

    ```zena
    // Now works as expected:
    try {
      fn();
      throw new AssertionError(message, 'throws');
    } catch (e) {
      // success - swallow the exception
    };
    ```

    The type of the above expression is `void` (union of `never` and `void`).

## Runtime Requirements

Requires `--experimental-wasm-exnref` flag in Node.js (as of v24). The test runner passes this flag to worker subprocesses via `execArgv`.
