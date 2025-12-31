# Macros in Zena

This document outlines a preliminary design for a Macro system in Zena. Macros allow code generation at compile-time, enabling features like zero-copy data structure construction (`mat[...]`) and domain-specific languages (DSLs).

## 1. The Challenge

Macros are powerful but need careful design. They run code during compilation.

- **Security**: A malicious macro should not be able to read files, access the network, or exfiltrate data.
- **Stability**: A buggy macro can crash or slow down the compiler, but this should only affect the current compilation.
- **Performance**: Running macros shouldn't slow down compilation significantly.

## 2. Security Model

### 2.1 The Key Insight

The security boundary is between **WASM and the host OS**, not between macros and the compiler.

```
┌─────────────────────────────────────────┐
│              Host OS                    │
│  (filesystem, network, secrets)         │
└─────────────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │ Security boundary │  ← This is what matters
         └─────────┬─────────┘
                   │
┌─────────────────────────────────────────┐
│           WASM Runtime                  │
│  ┌───────────────────────────────────┐  │
│  │ Compiler + Macros (same instance) │  │
│  │                                   │  │
│  │ Macros are just function calls.   │  │
│  │ No separate sandbox needed.       │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

Once the Zena compiler is self-hosted (compiled to WASM), macros are simply Zena functions that the compiler calls. They run in the same WASM instance with no special isolation.

A malicious or buggy macro **can**:

- Crash the compiler (annoying, not dangerous)
- Slow down compilation (DoS—handled at the runtime level)
- Produce incorrect output (breaks this compile, not a security issue)

A malicious macro **cannot**:

- Read files (SSH keys, environment variables, source code)
- Access the network (exfiltrate data)
- Modify the filesystem
- Affect anything outside the current compilation

This is because WASM has no ambient capabilities—file I/O, network, etc. only exist if the host explicitly provides imports for them. The compiler simply doesn't import these capabilities.

### 2.2 Resource Limits

For online compilers or untrusted inputs, resource limits are applied to the **entire compilation**, not per-macro:

- **Fuel**: Limit total instructions executed
- **Memory**: Cap heap size
- **Time**: Wall-clock timeout

If compilation exceeds limits, the host kills the WASM instance. No per-macro accounting needed.

### 2.3 Bootstrap vs Self-Hosted

During bootstrap (TypeScript compiler), we need to compile macros to WASM and instantiate them separately, with AST serialization at the boundary. This is a temporary cost.

Once self-hosted:

- Macros are just functions
- No serialization overhead
- No separate instantiation
- The "sandbox" is just WASM's natural isolation from the host

### 2.4 Macro Module Restrictions

While the WASM boundary protects against host-level access, the self-hosted
compiler itself has capabilities (file I/O, etc.) that macros should not access.

**Solution**: Macro modules have restricted imports.

A module containing macros can only import:

- Other macro modules
- Pure standard library modules (`zena:macro`, `zena:string`, `zena:array`, etc.)
- Cannot import effectful modules (`zena:fs`, `zena:net`, etc.)

```zena
// my-macros.zena

import { Expr, q } from 'zena:macro';  // OK: pure AST utilities
import { Map } from 'zena:map';        // OK: pure data structures
import { readFile } from 'zena:fs';    // ERROR: macro modules cannot import zena:fs
```

The compiler statically enforces these restrictions. A macro cannot accidentally
(or maliciously) gain access to file I/O even when running in the same WASM
instance as the compiler.

### 2.5 Toward Capabilities and Isolated Libraries

This security model points toward more general language features:

1. **Pure Functions**: Functions that provably have no side effects. Macros are
   an early use case—they're effectively pure functions over ASTs.

2. **Capability-Based I/O**: Rather than importing `zena:fs` for ambient
   filesystem access, programs would receive explicit capability objects:

   ```zena
   // Instead of:
   import { readFile } from 'zena:fs';
   readFile('config.json');

   // Capabilities as values:
   let loadConfig = (fs: FileSystem) => fs.read('config.json');
   ```

   This enables selective propagation—pass full access, read-only access, or
   nothing at all to different parts of the program.

3. **Library Instantiation**: Libraries could declare their required capabilities
   as parameters, making dependencies explicit and controllable:

   ```zena
   library(fs: FileSystem) {
     export let processFile = (path: string) => fs.read(path);
   }
   ```

4. **Static Import Allow-Lists**: Modules could declare what imports they permit,
   enabling compile-time verification of capability boundaries.

These features would solve both security (selective propagation to dependencies)
and abstraction (interface over implementation) problems that plague existing
ecosystems.

**See also**: `docs/design/capabilities.md` (planned) for the full design of
capability-based I/O and isolated libraries.

## 3. Data Transfer (ASTs)

During the bootstrap phase (before self-hosting), we need to pass AST data
between the TypeScript compiler and WASM macro modules.

### 3.1 AST Serialization

- **Binary Protocol**: A compact binary format representing Zena AST nodes.
- **Shared Memory (Advanced)**: Once self-hosted, the compiler and macros share the same address space—no serialization needed.

### 3.2 The `MacroContext` API

The macro receives a context object to interact with the compiler.

````zena
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
````

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

You might ask: _Why not use tagged template literals like `zena`...`?_

While tagged template literals are a valid option (and used successfully in languages like JS with `lit-html` or `sql` tags), Zena prefers **Tagged Blocks** (`q{...}`) for code generation for the following reasons:

1.  **Parsing Efficiency**:
    - `q{ ... }`: The content is parsed by the main compiler during the initial pass. The macro receives a pre-built AST.
    - `` zena`...` ``: The content is parsed as a string. The macro (or the compiler's intrinsic handler) must invoke the parser _again_ to convert the string to an AST.

2.  **Structural Validity**:
    - `q{ ... }`: Enforces that the template is syntactically valid Zena code (mostly). This catches syntax errors early.
    - `` zena`...` ``: Allows arbitrary text, which might be useful for non-Zena DSLs (like SQL), but for generating Zena code, it delays syntax errors until macro expansion time.

3.  **Interpolation**:
    - `q{ ... }`: Uses `$(...)` which integrates with the AST structure.
    - `` zena`...` ``: Uses string interpolation `${...}`, which operates on text, not AST nodes.

**Decision**: Use **Tagged Blocks** (`q{...}`) for structural macros to leverage the compiler's parser. Use **Template Literals** only when the DSL syntax is completely different from Zena (e.g., `sql`SELECT...``).

### 3.6 Type Information

A common question is: _Does the AST passed to the macro contain type information?_ (e.g., can I check if `x` is a `Matrix`?)

**Design Decision**: **No.** Zena macros are **Syntactic Macros**.

- **Timing**: Macros run _after_ parsing but _before_ type checking.
- **Reasoning**:
  1.  **Performance**: Running the type checker before macro expansion is expensive.
  2.  **Cyclic Dependencies**: Macros generate code that affects types. If macros also depended on types, we would need a complex multi-pass compiler.
  3.  **Simplicity**: Syntactic macros are easier to understand and implement.

**How to handle type-dependent logic?**
If a macro needs to behave differently based on types, it should generate code that defers the decision to the type checker (e.g., via function overloading or traits).

_Example_: `mat[a, b]`
The macro doesn't know if `a` is a scalar or a matrix.

- _Bad_: Macro tries to check `typeof(a)` (Impossible).
- _Good_: Macro generates `MatrixBuilder.add(a)`. The `MatrixBuilder.add` function is overloaded to handle both scalars and matrices efficiently.

## 4. Advanced Macro Features

### 4.1 Hygiene

Zena macros are **hygienic by default**. This means:

1.  **No Variable Capture**: Variables declared inside a macro do not accidentally shadow variables in the user's code.
2.  **Safe References**: Identifiers used in the macro (like `Matrix`) refer to the binding at the definition site, not the call site.

**Mechanism**: The compiler automatically renames variables declared within `q{...}` to unique names (gensyms) during expansion, unless they are explicitly marked to escape hygiene.

### 4.2 Scope & Side-Effects

Macros primarily return an AST node to replace their invocation. However, they often need to affect the surrounding scope.

- **Imports**: A macro can request to add imports to the module.
  ```zena
  ctx.addImport("std/math", "sin");
  ```
- **Top-Level Declarations**: A macro might need to hoist a helper function or a static table.
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

- A macro can call another macro.
- Macro arguments can contain macro invocations.
- **Expansion Order**: Macros are typically expanded "outside-in" or "inside-out" depending on the strategy, but the result is that all macros are expanded until only core Zena code remains.

## 5. Macro Tiers: Declarative vs Procedural

A key design question is whether macros should be visually distinguishable from
function calls. The concern: a macro can behave very differently from a function
(e.g., not evaluating arguments, evaluating them multiple times, capturing AST).

### 5.1 The Two-Tier System

Zena distinguishes between two kinds of macros based on their **caller-facing
evaluation semantics**:

| Tier            | Sigil | Evaluation Semantics         | Power                                    |
| --------------- | ----- | ---------------------------- | ---------------------------------------- |
| **Declarative** | None  | All args once, left-to-right | AST introspection, restructuring         |
| **Procedural**  | `!`   | Anything goes                | Lazy, repeat, skip, compile-time effects |

**Important**: Both tiers benefit from the WASM security model (Section 2). The
tier distinction is purely about **caller-facing evaluation semantics**, not
security. Neither can access files, network, or system resources—that's
guaranteed by the WASM boundary.

**Declarative macros** look and behave like function calls from the caller's
perspective. They guarantee:

1. All expression arguments evaluate **exactly once**
2. Evaluation order is **left-to-right** (same as functions)
3. No new bindings escape into the caller's scope
4. Output is a **pure quasi-quote expansion**

Because of these guarantees, no sigil is required—the caller experiences
function-call semantics.

**Procedural macros** (`!`) have full power and can violate normal evaluation
rules. The `!` sigil signals "this is not a normal call."

### 5.2 Motivating Example: `assert`

The `assert` function is a perfect use case for declarative macros.

**The Problem**: How do you get good error messages from assertions?

```zena
// Option 1: Simple function - poor error messages
assert(foo == bar);  // "Assertion failed" - what were the values?

// Option 2: Separate assertion functions - verbose API
equal(foo, bar);     // "Values not equal: left=42, right=43"
notEqual(a, b);
same(x, y);
isNull(z);
// ... need a function for every operator

// Option 3: Declarative macro - best of both worlds
assert(foo == bar);  // "Assertion failed: foo == bar (left=42, right=43)"
```

**How it works**: The `assert` macro:

1. Receives the AST of `foo == bar` at compile time
2. Destructures it to extract: operator (`==`), left expr (`foo`), right expr (`bar`)
3. Generates code that evaluates each operand once and produces a rich error

```zena
// User writes:
assert(foo == bar);

// Macro expands to:
{
  let __left = foo;
  let __right = bar;
  if (!(__left == __right)) {
    throw new AssertionError(
      "Assertion failed: foo == bar",
      __left,
      __right,
      "=="
    );
  }
}
```

Each sub-expression evaluates exactly once, left-to-right—just like a function
call. But the error message includes:

- The original source text (`foo == bar`)
- The actual values (42 and 43)
- The operator (`==`)

### 5.3 Declarative Macro Definition

A declarative macro uses `@macro` and returns a quasi-quote:

```zena
@macro
let assert = (expr: Expression<bool>, message?: string): Statement => {
  match expr.ast {
    case BinaryExpr { left, op, right } => q{
      {
        let __left = $(left);
        let __right = $(right);
        if (!(__left $(op) __right)) {
          throw new AssertionError(
            $(message ?? `Assertion failed: ${expr.source}`),
            __left,
            __right,
            $(op.toString())
          );
        }
      }
    }
    case _ => q{
      if (!$(expr)) {
        throw new AssertionError(
          $(message ?? `Assertion failed: ${expr.source}`)
        );
      }
    }
  }
};
```

The macro can **read** the AST structure but cannot cause multiple evaluations—
`$(left)` and `$(right)` each appear once in the output.

### 5.4 Enforcing Declarative Constraints

How does the compiler ensure a declarative macro upholds its guarantees?

1. **WASM Sandbox** (same as procedural): The macro code runs in an isolated
   environment with no file I/O, network, or system access. It can only receive
   AST and return AST.

2. **Linear Use Analysis**: The compiler statically verifies that each
   `Expression` argument is spliced into the output quasi-quote **exactly once**.
   If a macro tries to use `$(left)` twice, it's a compile-time error.

3. **No Escape**: The macro cannot return code that introduces bindings into the
   caller's scope (hygiene) or references internal macro state.

If a macro needs to violate linear use (e.g., evaluate something zero times or
multiple times), it must be marked as procedural with `!`.

### 5.5 When You Need `!`

Procedural macros require the `!` sigil because they break normal evaluation:

```zena
// Lazy evaluation - argument may never execute
log!(expensive_computation());

// Short-circuit - second arg only evaluates if first is true
and!(check_permissions(), do_action());

// Repeat evaluation - runs the block multiple times
retry!(3, fetch_data());

// Compile-time code execution
include!("./generated.zena");
```

These should look different because they **are** different.

### 5.6 Explicit Quoting for Lazy Arguments

If a declarative macro (or regular function) needs to receive an unevaluated
expression, the caller uses explicit quoting:

```zena
// #(...) captures expression as a Quote<T> object
lazyLog(#(expensive_computation()));
```

The "weird behavior" marker is on the **argument** (`#(...)`), not the call
site. This keeps the weirdness explicit and local.

The function signature would accept `Quote<T>`:

```zena
let lazyLog = (expr: Quote<string>): void => {
  if (logLevel >= DEBUG) {
    console.log(expr.eval());  // Only evaluates if needed
  }
};
```

### 5.7 Summary

| Want to...                                 | Use                          |
| ------------------------------------------ | ---------------------------- |
| Introspect AST, restructure, better errors | Declarative macro (no sigil) |
| Skip/repeat/lazy evaluation                | Procedural macro (`!`)       |
| Pass unevaluated expr to function          | Quote syntax `#(...)`        |

This design keeps most macros "invisible" because they behave predictably,
while truly unusual ones announce themselves.

## 6. Roadmap

1.  **Built-in Intrinsics (Phase 1)**: Implement `mat`, `wat`, and others as hard-coded logic inside the compiler. This avoids the complexity of the macro system initially.
2.  **Macro Prototype (Phase 2)**: Experiment with running a simple WASM function that accepts/returns a byte array (serialized AST).
3.  **Full System (Phase 3)**: Define the stable AST schema and the `MacroContext` API.
