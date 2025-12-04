# Exceptions Design

## Status

- **Status**: Proposed
- **Date**: 2025-12-03

## Problem

Currently, Zena handles runtime errors (like array out-of-bounds) by trapping. This is fatal and unrecoverable. The current implementation of out-of-bounds checks relies on a "hack" where we intentionally access an out-of-bounds index on the underlying WASM array to trigger a trap.

Users coming from high-level languages (TypeScript, Java, C#) expect a structured way to handle errors and recover from them.

## Goals

1.  **Recoverable Errors**: Allow programs to catch and handle errors without crashing.
2.  **Familiar Syntax**: Use standard `try`, `catch`, `throw`, `finally` syntax.
3.  **Expression-Oriented**: `throw` and `try/catch` should be expressions to support immutable bindings and functional patterns.
4.  **Performance**: Zero-cost on the happy path (no overhead if no exception is thrown).
5.  **Interoperability**: Integrate with WebAssembly Exception Handling (WASM EH).

## Proposal

Adopt the **WebAssembly Exception Handling** proposal and treat control flow constructs as expressions where possible.

### Syntax & Semantics

#### Throw Expression

`throw` is an expression, not just a statement. It evaluates to the bottom type (`never`), allowing it to be used in any context where a value is expected.

```typescript
// Used in a ternary (or future if-expression)
let x = isValid ? getValue() : throw new Error("Invalid");

// Used in null coalescing (future)
let y = maybeNull ?? throw new Error("Missing value");
```

#### Try/Catch Expression

`try/catch` is an expression. This allows initializing immutable variables with the result of a potentially failing operation, avoiding the need for mutable `var` declarations and "dummy" initial values.

```typescript
// Immutable binding with error handling
let content = try {
  readFile("data.txt")
} catch (e) {
  "default content"
};
```

**Semantics**:

- **Type**: The type of the `try/catch` expression is the union (or least upper bound) of the types of the `try` block and the `catch` block.
- **Evaluation**:
  1.  The `try` block is executed. If it completes successfully, its result is the value of the expression.
  2.  If an exception is thrown, the `catch` block is executed. Its result becomes the value of the expression.

#### Finally

`finally` blocks are supported for cleanup.

```typescript
let resource = acquire();
let result = try {
  process(resource)
} catch (e) {
  handleError(e)
} finally {
  resource.release();
};
```

**Semantics**:

- The `finally` block is **always** executed after the `try` block (and `catch` block, if triggered) completes.
- **Value**: The `finally` block **does not** contribute to the value of the expression. It is executed purely for side effects.
  - If `try` succeeds, the result is the `try` value.
  - If `catch` executes, the result is the `catch` value.
  - If `finally` throws or returns (if allowed), it overrides the previous completion (standard JS/Java behavior).

### Expression-Oriented Control Flow

Zena supports `if/else` as expressions (like Rust), replacing the need for a ternary operator and allowing for more functional coding styles.

```typescript
// if expression syntax
let x = if (cond) { 1 } else { 2 };

// Chained else-if
let sign = if (n < 0) -1 else if (n == 0) 0 else 1;
```

### Standard Library

We need a standard `Error` class.

```typescript
class Error {
  message: string;
  #new(message: string) {
    this.message = message;
  }
}
```

### Implementation Strategy

We will target the **WebAssembly Exception Handling** proposal.

1.  **Tags**: Define a WASM `tag` `$zena_exception` (param `(ref $Object)`).
2.  **Throw**: Compile `throw expr` to `throw $zena_exception`.
3.  **Try/Catch**: Compile to WASM `try_table`.
    - The `try_table` instruction allows specifying a block type (return type), which maps naturally to the expression result type.
    - Handlers catch `$zena_exception`.
4.  **Finally**:
    - WASM `try_table` doesn't have a direct `finally`. It is typically implemented by:
      1.  Executing the `try` body.
      2.  If successful, branch to a label after the `catch` blocks, execute `finally` code, then continue.
      3.  If an exception occurs, catch it, execute `finally` code, then rethrow (or handle if caught).
    - Since `try/catch` is an expression, we need to ensure the result value is preserved across the `finally` block execution (e.g., stored in a local).

### Immediate Fix: `unreachable`

Before implementing full exceptions, we should replace the "array OOB hack" with a proper `unreachable` instruction.

1.  Add an intrinsic `@intrinsic('unreachable') declare function unreachable(): never;`.
2.  Update `Array` implementation to call `unreachable()` instead of the OOB hack.

## Open Questions

1.  **Checked Exceptions**: Do we want checked exceptions?
    - _Proposal_: No. Like TypeScript/C#, exceptions are unchecked.
2.  **JS Interop**: How do we handle JS exceptions?
    - WASM EH allows catching JS exceptions if they are thrown as `externref`. We might need a way to distinguish Zena exceptions from JS exceptions.

## Plan

1.  **Phase 1**: Implement `unreachable` intrinsic and fix Array OOB.
2.  **Phase 2**: Implement `throw` expression and `Error` class.
3.  **Phase 3**: Implement `try`/`catch`/`finally` expressions.
