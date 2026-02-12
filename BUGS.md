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

### Nested generic type parameter resolution in codegen

- **Found**: 2025-01-XX
- **Severity**: medium
- **Workaround**: Avoid calling generic functions from within generic class methods where the inner generic uses the outer type parameter
- **Details**: When a generic class method calls a generic function (like `some<T>(value)`) where `T` is resolved to the outer class's type parameter `V`, the codegen fails with "Unresolved type parameter: V, currentTypeArguments keys: [T]". This happens because the inner function's type context doesn't have visibility into the outer class's type arguments.
- **Example**: `Map<K,V>.find()` calling `some<V>(entry.value)` fails at codegen.
- **Impact**: The `Option<T>` pattern with `find()` methods cannot currently be implemented. Use multi-return `(T, boolean)` pattern as alternative.

## Fixed Bugs

### Nullable type in exported type alias causes WASM validation error

- **Found**: 2026-02-11
- **Fixed**: 2026-02-11
- **Fix**: Widen record/tuple literals to match function return types, not just variable declarations
