# Method Overloading Design

This document extends `function-overloading.md` to specifically address **Class
Method Overloading**, including inheritance, virtual dispatch, and the creation
of dynamic dispatch capabilities for efficient execution.

## 1. Goals

1.  **Alignment**: Match the "Single Implementation" strategy for user code
    (similar to TypeScript) to minimize binary size and complexity.
2.  **Interop**: Support "Multi-Implementation" overloading for host bindings
    (`declare class`) and potentially for performance-critical internal code in
    the future.
3.  **Safety**: Ensure type safety during dispatch.
4.  **Tear-offs**: Support method tear-offs (creating closures from methods)
    even when methods are overloaded.

## 2. User-Defined Methods

Zena supports two strategies for overloading methods: **Single Implementation** (Pattern Matching) and **Multi-Implementation** (Specialization).

### 2.1 Strategy A: Single Implementation (Preferred for Logic)

For standard Zena classes, we typically follow the TypeScript model. A method can have multiple _signatures_ but only one _implementation_. This is preferred when the logic is unified.

```zena
class Converter {
  // Signatures
  process(item: string): string;
  process(item: i32): string;

  // Implementation
  process(item: string | i32): string {
    if (item is string) {
      return `String: ${item}`;
    } else {
      return `Number: ${item}`;
    }
  }
}
```

### 2.2 Strategy B: Multi-Implementation (Required for Performance)

When overloads involve disparate types—especially **Primitives vs Objects**—separate implementations are required to avoid boxing. The compiler generates effectively distinct methods (mangled names) for these.

```zena
class FixedArray<T> {
  // Fast path: No boxing of i32
  operator [](index: i32): T { ... }

  // Object path: Takes a struct
  operator [](range: Range): FixedArray<T> { ... }
}
```

## 3. Native & Interop Methods: Multi-Implementation

For `declare class` (host interop) or future `@overload` supported methods, we
may have distinct underlying implementation functions.

```zena
@external("env", "glDrawArrays")
declare class WebGL {
  draw(mode: i32, count: i32): void;
  draw(mode: i32, offset: i32, count: i32): void;
}
```

Here, `draw` maps to two different host functions (or one host function with
optional args, but let's assume distinct logic).

### 3.1 Static Resolution

When the arguments are known at compile time, the compiler selects the specific
function index.

```zena
let gl = new WebGL();
gl.draw(1, 2);    // Resolves to signature 1
gl.draw(1, 0, 2); // Resolves to signature 2
```

### 3.2 Dynamic Resolution (The Problem)

Reference: _"how to support overloads efficiently when we don't know the exact
overload to pick at compile time"_

If we have arguments that match multiple overloads via unions, or if we perform
a tear-off without a specific target signature, we face ambiguity.

```zena
let gl = new WebGL();
let args: [i32, i32] | [i32, i32, i32] = ...;
// gl.draw(...args); // How to dispatch?

let myDraw = gl.draw; // Which function?
```

## 4. The Dispatcher Strategy

To support dynamic resolution and "universal" tear-offs for Multi-Implementation
methods, we can generate **Dispatcher Thunks**.

### 4.1 On-Demand Wrapper Generation

When the compiler encounters a tear-off or a dynamic call site that it cannot
resolve statically, it can generate a synthetic wrapper function.

**Concept:**

```zena
// Synthetic generated function for `gl.draw` tear-off
func $dispatcher_WebGL_draw($this: WebGL, arg1: any, arg2?: any, arg3?: any) {
  if (args.length == 2 && arg1 is i32 && arg2 is i32) {
    return $WebGL_draw_2($this, arg1, arg2);
  }
  if (args.length == 3 && arg1 is i32 ... ) {
    return $WebGL_draw_3($this, arg1, arg2, arg3);
  }
  throw new TypeError("No matching overload found");
}
```

### 4.2 Implementation Details

1.  **Naming**: The dispatcher needs a stable internal name.
2.  **Signature**: The dispatcher's signature must be the _common supertype_ of
    all overloads (often taking `any`/`eqref` or a Union of all possible
    inputs).
3.  **Runtime Type Checks**: We utilize `ref.test` (WASM GC) or Zena's `is`
    operator logic to branch to the correct concrete implementation.
4.  **Cost**: This incurs runtime overhead. It should only be generated/used
    when static resolution fails.

### 4.3 Tear-off Semantics

```zena
// User Code
let f = gl.draw;
f(1, 2);
```

**Compilation:**

1.  Compiler sees `gl.draw` accessed as a value.
2.  `gl.draw` is an overload set.
3.  Context is inferred as "Any compatible signature".
4.  Compiler emits a closure pointing to the **Dispatcher Thunk** for
    `WebGL.draw`, binding `gl` as `this`.

## 5. Compile-Time vs Runtime Choice

To remain efficient, we prioritize:

1.  **Exact Match**: Arguments match a specific signature exact types. -> Direct
    Static Call.
2.  **Union Match (Inline)**: Arguments are unions, but small enough to unroll.
    ```zena
    // gl.draw(a: i32 | f32)
    // -> emit:
    if (a is i32) call draw_i32(a)
    else call draw_f32(a)
    ```
3.  **Dispatcher Call**: Complex cases or tear-offs used in unknown contexts.

## 6. Inheritance & Virtual Tables

If a class allows overriding methods that are overloaded:

```zena
class Base {
  foo(x: i32) { ... } // A
  foo(x: f32) { ... } // B
}

class Child extends Base {
  foo(x: i32) { ... } // Overrides A
  // Inherits B
}
```

### 6.1 Virtual Dispatch + Overloading

Method names in the VTable should likely be mangled by signature to allowing
independent overriding.

- Entry `foo(i32)` -> `$Base_foo_i32`
- Entry `foo(f32)` -> `$Base_foo_f32`

`Child` updates the slot for `foo(i32)` but keeps `foo(f32)`.

### 6.2 Dispatched Overrides?

If a user writes the "Single Implementation" style in a subclass:

```zena
class Child extends Base {
  foo(x: i32 | f32) { ... }
}
```

This subclass implementation technically overrides **both** `foo(i32)` and
`foo(f32)` from the base perspective. The compiler must generate **Bridge
Methods** to plug into the separate vtable slots.

**Bridge Generation:**

- Slot `foo(i32)` -> calls `Child.foo(x cast i32)`
- Slot `foo(f32)` -> calls `Child.foo(x cast f32)`

## 7. Future: `dynamic` keyword?

If we introduce `dynamic` or `any`, all method calls on such objects must go
through a lookup mechanism.

- We can attach the **Dispatcher Thunk** to the class metadata (or a secondary
  "dynamic vtable").
- `dynamic_call(obj, "draw", args)` -> looks up "draw" in dynamic vtable ->
  finds Dispatcher -> executes.
