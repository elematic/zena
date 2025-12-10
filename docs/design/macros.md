# Macros in Zena

This document outlines a preliminary design for a Macro system in Zena. Macros allow code generation at compile-time, enabling features like zero-copy data structure construction (`mat[...]`) and domain-specific languages (DSLs).

## 1. The Challenge

Macros are powerful but dangerous. They run arbitrary code during compilation.
-   **Security**: A malicious macro could read files, access the network, or crash the compiler.
-   **Stability**: Macros must be deterministic.
-   **Performance**: Running macros shouldn't slow down compilation to a crawl.

## 2. Architecture: WASM Sandboxing

To address security and stability, Zena macros will be compiled to **WebAssembly** and executed in a sandboxed environment within the compiler.

### 2.1 The Model

1.  **Definition**: A macro is a Zena function annotated with `@macro`.
2.  **Compilation**: The compiler compiles the macro code to a standalone WASM module *before* compiling the main program.
3.  **Execution**: When the compiler encounters a macro invocation (e.g., `mat[...]`), it:
    -   Instantiates the macro's WASM module.
    -   Serializes the relevant AST nodes (the arguments).
    -   Calls the macro function in the sandbox.
    -   Deserializes the returned AST nodes.
    -   Replaces the invocation with the returned AST.

### 2.2 Isolation

The macro WASM module is instantiated with a **restricted import set**.
-   **Allowed**: Standard library pure functions (math, string manipulation), AST builder functions.
-   **Denied**: File I/O, Network, System calls.

This guarantees that a macro cannot steal secrets or modify the system, satisfying the safety requirement.

## 3. Data Transfer (ASTs)

The bottleneck is passing complex AST data between the Compiler (Host) and the Macro (Guest).

### 3.1 AST Serialization

Since the Compiler and the Macro might be running in different memory spaces (or even different languages if the compiler is self-hosted vs bootstrapped), we need a stable serialization format for the AST.

-   **Binary Protocol**: A compact binary format representing Zena AST nodes.
-   **Shared Memory (Advanced)**: If the compiler is also running in WASM (self-hosted), we might be able to share memory pages or use Interface Types (Component Model) to pass high-level objects efficiently.

### 3.2 The `MacroContext` API

The macro receives a context object to interact with the compiler.

```zena
// In the macro definition
import { MacroContext, Expression } from 'zena/compiler/macros';

@macro
export func mat(ctx: MacroContext, args: Expression[]): Expression {
  // 1. Analyze 'args' (the literal tuple)
  // 2. Generate code to allocate memory
  // 3. Generate code to store values
  
### 3.3 Quasiquoting (`q{...}`)

The syntax `q{ ... }` is an example of a **Tagged Record/Block Literal**, as proposed in the Scientific Computing design.

-   **`q`**: A built-in macro or tag for "Quasiquote".
-   **`{ ... }`**: A block of Zena code.

The `q` macro takes the code block and, instead of executing it, returns its **AST** (Abstract Syntax Tree). This allows macro authors to write code templates naturally rather than manually constructing AST nodes (e.g., `new BinaryExpression(op, left, right)`).

```zena
// Without Quasiquote (Manual AST construction)
return new CallExpression(
  new Identifier("print"),
  [new StringLiteral("Hello")]
);

// With Quasiquote
return q{ print("Hello") };
```

### 3.4 Interpolation (Unquoting)

To inject dynamic values (AST nodes) into the quasiquote, we need an "unquote" mechanism.

**Syntax**: `$(expression)`
Since `$` is a valid identifier character in Zena, `$` can be treated as a special function within the quasiquote context. Inside a `q{...}` block, `$(...)` is interpreted as "insert the AST returned by this expression here".

```zena
let val = new Literal(42);
return q{
  let x = $(val); // Becomes: let x = 42;
};
```

### 3.5 Comparison: Tagged Blocks vs. Template Literals

You might ask: *Why not use tagged template literals like `zena`...`?*

While tagged template literals are a valid option (and used successfully in languages like JS with `lit-html` or `sql` tags), Zena prefers **Tagged Blocks** (`q{...}`) for code generation for the following reasons:

1.  **Parsing Efficiency**:
    -   `q{ ... }`: The content is parsed by the main compiler during the initial pass. The macro receives a pre-built AST.
    -   `` zena`...` ``: The content is parsed as a string. The macro (or the compiler's intrinsic handler) must invoke the parser *again* to convert the string to an AST.

2.  **Structural Validity**:
    -   `q{ ... }`: Enforces that the template is syntactically valid Zena code (mostly). This catches syntax errors early.
    -   `` zena`...` ``: Allows arbitrary text, which might be useful for non-Zena DSLs (like SQL), but for generating Zena code, it delays syntax errors until macro expansion time.

3.  **Interpolation**:
    -   `q{ ... }`: Uses `$(...)` which integrates with the AST structure.
    -   `` zena`...` ``: Uses string interpolation `${...}`, which operates on text, not AST nodes.

**Decision**: Use **Tagged Blocks** (`q{...}`) for structural macros to leverage the compiler's parser. Use **Template Literals** only when the DSL syntax is completely different from Zena (e.g., `sql`SELECT...``).

### 3.6 Type Information

A common question is: *Does the AST passed to the macro contain type information?* (e.g., can I check if `x` is a `Matrix`?)

**Design Decision**: **No.** Zena macros are **Syntactic Macros**.
-   **Timing**: Macros run *after* parsing but *before* type checking.
-   **Reasoning**:
    1.  **Performance**: Running the type checker before macro expansion is expensive.
    2.  **Cyclic Dependencies**: Macros generate code that affects types. If macros also depended on types, we would need a complex multi-pass compiler.
    3.  **Simplicity**: Syntactic macros are easier to understand and implement.

**How to handle type-dependent logic?**
If a macro needs to behave differently based on types, it should generate code that defers the decision to the type checker (e.g., via function overloading or traits).

*Example*: `mat[a, b]`
The macro doesn't know if `a` is a scalar or a matrix.
-   *Bad*: Macro tries to check `typeof(a)` (Impossible).
-   *Good*: Macro generates `MatrixBuilder.add(a)`. The `MatrixBuilder.add` function is overloaded to handle both scalars and matrices efficiently.

## 4. Advanced Macro Features

### 4.1 Hygiene

Zena macros are **hygienic by default**. This means:
1.  **No Variable Capture**: Variables declared inside a macro do not accidentally shadow variables in the user's code.
2.  **Safe References**: Identifiers used in the macro (like `Matrix`) refer to the binding at the definition site, not the call site.

**Mechanism**: The compiler automatically renames variables declared within `q{...}` to unique names (gensyms) during expansion, unless they are explicitly marked to escape hygiene.

### 4.2 Scope & Side-Effects

Macros primarily return an AST node to replace their invocation. However, they often need to affect the surrounding scope.

-   **Imports**: A macro can request to add imports to the module.
    ```zena
    ctx.addImport("std/math", "sin");
    ```
-   **Top-Level Declarations**: A macro might need to hoist a helper function or a static table.
    ```zena
    ctx.addTopLevel(q{ const _table = ... });
    ```

### 4.3 Error Reporting

Macros need to report errors intelligently.

1.  **Input Errors**: If the user passes invalid arguments to the macro (e.g., a matrix literal with uneven rows), the macro can report a diagnostic attached to the specific AST node.
    ```zena
    if (row.length != firstRow.length) {
      ctx.reportError(row, "Row length mismatch");
    }
    ```
2.  **Generated Code Errors**: If the generated code contains a type error, the compiler should attempt to map the error back to the macro invocation site, while providing a "macro expansion trace" to help debug the issue.

### 4.4 Composition

Macros **compose**.
-   A macro can call another macro.
-   Macro arguments can contain macro invocations.
-   **Expansion Order**: Macros are typically expanded "outside-in" or "inside-out" depending on the strategy, but the result is that all macros are expanded until only core Zena code remains.

## 5. Roadmap

1.  **Built-in Intrinsics (Phase 1)**: Implement `mat`, `wat`, and others as hard-coded logic inside the compiler. This avoids the complexity of the macro system initially.
2.  **Macro Prototype (Phase 2)**: Experiment with running a simple WASM function that accepts/returns a byte array (serialized AST).
3.  **Full System (Phase 3)**: Define the stable AST schema and the `MacroContext` API.
