# Argument Adaptation

## Overview

Zena supports using functions with fewer arguments than expected by the target type. This is a common pattern in JavaScript/TypeScript (e.g., `array.map(x => x)` where `map` expects `(item, index, array) => T`).

This applies in two main contexts:

1.  **Function Calls**: Passing a callback with fewer arguments than the parameter expects.
2.  **Assignments**: Assigning a function to a variable (or field) typed with more arguments, or to a Union Type containing such a type.

Since Zena targets WASM, which enforces strict function signatures, we cannot simply drop arguments at the call site. Instead, the compiler performs **Argument Adaptation** by generating a wrapper function (thunk) that bridges the gap between the expected signature and the provided signature.

## Implementation Details

When the compiler encounters a function usage (argument or assignment) where:

1. The expected type is a closure (function) or a Union containing a closure.
2. The provided value is a closure.
3. The provided closure has fewer parameters than the expected closure.

It performs the following transformation:

### 1. Wrapper Generation

The compiler generates a new WASM function (the "Wrapper") that matches the **expected** signature.

**Wrapper Logic:**

1.  **Context Unpacking**: The wrapper receives the "Actual Closure" as its context (casted from `eqref`).
2.  **Inner Context Retrieval**: It extracts the original context from the Actual Closure.
3.  **Argument Selection**: It selects only the arguments required by the Actual Closure from the incoming arguments.
4.  **Delegation**: It calls the function reference stored in the Actual Closure with the inner context and the subset of arguments.

### 2. Call Site Transformation

At the point where the closure is passed:

1.  The **Actual Closure** is instantiated as normal.
2.  A **New Closure** (the "Adapted Closure") is instantiated.
    - **Function**: The generated Wrapper function.
    - **Context**: The Actual Closure instance.

This Adapted Closure is then passed to the receiver.

## Performance Implications

This feature introduces overhead compared to a direct matching call.

### 1. Allocation Overhead (Runtime)

- **Impact**: Low to Moderate.
- **Detail**: A new closure struct is allocated on the heap for the adapter. This happens every time the adaptation expression is evaluated.
  - _Example_: If `arr.map(x => x)` is called inside a loop, a new adapter struct is allocated in each iteration.

### 2. Execution Overhead (Runtime)

- **Impact**: Moderate.
- **Detail**: Invoking the adapted function involves **double indirection**.
  - **Standard Call**: `Caller` -> `Closure` (1 `call_ref`).
  - **Adapted Call**: `Caller` -> `Wrapper` -> `Target` (2 `call_ref`s).
  - There is also overhead for unpacking the context twice (once in the wrapper, once in the target).

### 3. Code Size Overhead (Compile Time)

- **Impact**: Low.
- **Detail**: A unique wrapper function is generated for each **static call site** requiring adaptation.
  - _Note_: Currently, wrappers are not deduplicated. If you have 10 places in your code adapting `(i32) -> void` to `(i32, i32) -> void`, 10 identical wrapper functions will be generated in the WASM binary.

## Optimization Advice

- **Prefer Exact Signatures**: For performance-critical loops, ensure function signatures match exactly to avoid the adapter overhead.
  - _Slow_: `arr.map(x => x)`
  - _Fast_: `arr.map((x, _i, _a) => x)`
- **Static Analysis**: This overhead **only** applies when the arity mismatch is detected statically. It does not affect dynamic dispatch or standard calls where arity matches.

## Examples

### 1. Function Call Adaptation

```zena
// Expected: (item: i32, index: i32, array: i32[]) => i32
// Provided: (item: i32) => i32
[1, 2, 3].map((x) => x * 2);
```

### 2. Variable Assignment Adaptation

```zena
type Handler = (a: i32, b: i32) => void;
// Provided: (a: i32) => void
let h: Handler = (a) => console.log(a);
```

### 3. Union Type Assignment Adaptation

```zena
type Handler2 = (a: i32, b: i32) => void;
type SimpleHandler = (a: i32) => void;

// Target is Union: Handler2 | SimpleHandler
// Provided: (a: i32) => void
// The compiler checks if the provided function adapts to ANY member of the union.
// Here, it matches SimpleHandler directly, so NO adaptation occurs.

type ComplexHandler = (a: i32, b: i32, c: i32) => void;
// Target: ComplexHandler | string
// Provided: (a: i32) => void
// Result: Adapts to ComplexHandler
let x: ComplexHandler | string = (a) => {};
```
