# Function Overloading Design

## 1. Overview

Function overloading allows multiple functions to share the same name but differ in their parameter lists (arity or types). This is particularly useful for:

1.  **Host Interop**: Mapping a single logical operation (e.g., `print`) to multiple specialized WASM imports (e.g., `print_i32`, `print_f32`) without boxing.
2.  **Developer Experience**: Providing a unified API for operations that work across different types.

## 2. Syntax

Overloads are declared by providing multiple function signatures for the same name in the same scope.

### 2.1 Declare Function (Interop)

```zena
@external("env", "print_i32")
declare function print(val: i32): void;

@external("env", "print_f32")
declare function print(val: f32): void;
```

### 2.2 Regular Functions (User-Defined)

For regular Zena functions, we prefer a **Single Implementation** strategy similar to TypeScript. The author defines multiple _signatures_ but only one _implementation_ that handles all cases using Union Types and pattern matching.

**Key Advantage: Type Correlation**
This approach allows the type checker to correlate input types with output types, which is not possible with simple Union Types alone.

```zena
let format:
    // Signatures (Overloads)
    // If called with one arg, returns string
    (val: i32) =? string |
    // If called with two args, returns array
    (val: i32, width: i32) =? string[]
  // Implementation
  = (val: i32, width?: i32): string | string[] => {
    if (width == null) {
      return val.toString();
    } else {
      // ... return array ...
    }
  }
```

This avoids the complexity of name mangling and static dispatch for user code, while keeping the runtime behavior explicit and predictable.

_Initial scope is limited to `declare function` for interop._

## 3. Implementation Strategy

### 3.1 Type Checker

1.  **Symbol Table**: The symbol table (`CheckerContext`) currently maps a name to a single `SymbolInfo`. This needs to be updated to support a list of `FunctionType`s (an "Overload Set").
2.  **Resolution**: When a function call is checked (`checkCallExpression`):
    - Retrieve the Overload Set for the function name.
    - Iterate through the candidates.
    - Select the first candidate where the argument types are assignable to the parameter types.
    - If no match is found, report a "No overload matches" error.
    - **Ambiguity**: For now, we can use "first match wins" or "most specific match". Given Zena's strict typing, "first match" is likely sufficient and predictable.

### 3.2 AST & IR

The AST `CallExpression` currently just points to an identifier. The Type Checker needs to annotate this node with the _specific_ `FunctionType` (and thus the specific underlying function index) that was resolved.

Since AST nodes are often immutable or simple data structures, we may need a side table in the `CheckerContext` or `CodegenContext` to map `CallExpression` nodes to their resolved `FunctionType` / `FunctionIndex`.

### 3.3 Code Generation

1.  **Registration**: When registering declared functions, the codegen must register each overload as a distinct WASM import/function.
2.  **Call Site**: When generating a call:
    - Use the resolved `FunctionType` from the Checker to look up the correct function index.
    - Emit the `call` instruction for that specific index.

## 4. Constraints & Edge Cases

- **Return Types**: Overloads can have different return types. The return type of the call expression is determined by the selected overload.
- **Ambiguity**: `any` or `unknown` types (if added) could cause ambiguity.
- **Generic Overloads**: Interaction with generics needs careful consideration (e.g., `print<T>(val: T)` vs `print(val: i32)`).

## 5. Roadmap

1.  **Phase 1**: Support overloading for `declare function` (Interop).
2.  **Phase 2**: Support overloading for class methods.
3.  **Phase 3**: Support overloading for regular exported functions (requires name mangling scheme).

## 6. Interaction with Method Tear-offs

A "tear-off" occurs when a method is accessed as a value without calling it immediately (e.g., `let f = obj.method`). This creates a function reference (closure).

### 6.1 The Ambiguity Problem

If `obj.method` is overloaded (e.g., has signatures `(i32) => void` and `(f32) => void`), the expression `obj.method` is ambiguous. Which underlying function index should be referenced?

### 6.2 Proposed Solution: Context-Sensitive Resolution

Since Zena is statically typed, we can use the **expected type** of the expression to resolve the ambiguity.

```zena
// Overloads
class Printer {
  print(x: i32): void { ... }
  print(x: f32): void { ... }
}

let p = new Printer();

// Case A: Explicit Type Annotation
// The compiler sees expected type (i32) => void, selects the i32 overload.
let printInt: (x: i32) => void = p.print;

// Case B: Function Argument
// The compiler sees expected parameter type (f32) => void, selects the f32 overload.
let run = (callback: (x: f32) => void) => { ... }
run(p.print);

// Case C: Untyped / Ambiguous (Error)
// let f = p.print; // Error: Ambiguous overload reference.
```

### 6.3 Alternative: Lambda Wrappers

If the context is insufficient, the user can always resolve ambiguity by wrapping the call in a lambda. This is the "escape hatch".

```zena
let f = (x: i32) => p.print(x); // Explicitly calls the i32 version
```

### 6.4 Alternative: Boxed Dispatchers (Not Planned)

One could imagine generating a "dispatcher" function that accepts a boxed type (e.g., `anyref` or a union), checks the type at runtime, and calls the correct overload.

```zena
// Hypothetical generated dispatcher
let print_dispatcher = (val: anyref) => {
  if (val is i32) print_i32(val as i32);
  else if (val is f32) print_f32(val as f32);
}
```

**Decision**: We will **avoid** this approach for now because:

1.  It incurs hidden performance costs (boxing, runtime checks).
2.  It requires a unified "Boxed" type system which Zena tries to minimize.
3.  Context-sensitive resolution covers 99% of static usage patterns.
