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

### Record with optional properties causes WASM type mismatch when used as function parameter

- **Found**: 2026-02-15
- **Severity**: medium
- **Workaround**: Don't use optional properties in record parameters with width subtyping
- **Details**: When a function takes `{foo: i32, bar?: i32}` and is called with `{foo: 42}`, the WASM emitter produces invalid code. The error is "type mismatch: expected (ref null $type), found (ref $type)". This is a fat pointer / vtable type issue where the concrete type and declared type have incompatible WASM representations.
- **Reproduce**:
  ```zena
  let go = (opts: {foo: i32, bar?: i32}): i32 => opts.foo;
  export let main = (): i32 => go({foo: 42});
  ```

## Fixed Bugs

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
