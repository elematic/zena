# Known Bugs

This file tracks known bugs as a lightweight alternative to GitHub issues.
When you encounter a bug during development, add it here rather than
immediately trying to fix it (which can pollute the current task's context).

## Format

```
### [Short description]
- **Found**: [Date]
- **Severity**: [low/medium/high/blocking]
- **Workaround**: [if any]
- **Details**: [description of the bug and how to reproduce]
```

## Active Bugs

### Local class declaration doesn't shadow built-in `Symbol` type

- **Found**: 2026-02-14
- **Severity**: medium
- **Workaround**: Rename the class to avoid collision (e.g., `SymbolEntry` instead of `Symbol`)
- **Details**: When you declare `class Symbol` in a module, it should shadow the built-in `Symbol` type within that module's scope. Instead, references to `Symbol` still resolve to the built-in type, causing errors like "Property 'name' does not exist on type 'Symbol'". This affects any class name that collides with built-in types.

## Fixed Bugs

### Stack overflow in emitter for large WASM output

- **Found**: 2026-02-15
- **Fixed**: 2026-02-16
- **Severity**: high
- **Fix**: Changed `buffer.push(...content)` to a for loop in `#writeSection` to avoid spread operator stack overflow.
- **Details**: The `#writeSection` method in emitter.ts used `buffer.push(...content)` which expands large arrays into individual function arguments. For ~140KB WASM files, this meant ~140,000 arguments on the call stack, causing stack overflow. The fix uses a for loop instead.

### WASM validation error: eqref vs specific ref type in closure wrappers

- **Found**: 2026-02-12
- **Fixed**: 2026-02-13
- **Severity**: high
- **Details**: Closure wrappers taking `eqref` weren't casting to specific ref types before calling the wrapped function.

### Nested generic type parameter resolution in codegen

- **Found**: 2025-01-XX
- **Fixed**: 2026-02-12
- **Severity**: medium
- **Fix**: Resolve type arguments through the enclosing context's type arguments before instantiating a generic function. This handles the case where a generic function is called from within a generic class method.
- **Details**: When a generic class method calls a generic function (like `some<T>(value)`) where `T` is resolved to the outer class's type parameter `V`, the codegen failed with "Unresolved type parameter: V, currentTypeArguments keys: [T]". This happened because the inner function's type context didn't have visibility into the outer class's type arguments.

### Nullable type in exported type alias causes WASM validation error

- **Found**: 2026-02-11
- **Fixed**: 2026-02-11
- **Fix**: Widen record/tuple literals to match function return types, not just variable declarations
