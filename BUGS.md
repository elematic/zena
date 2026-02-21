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

### Function references passed as arguments fail with "Unknown identifier"

- **Found**: 2026-02-17
- **Severity**: medium
- **Workaround**: Inline the tests instead of using shared test utilities
- **Details**: When a module-level function is passed as an argument to another function (especially across module boundaries), codegen fails with "Unknown identifier: functionName". The issue is in `generateFromBinding()` in `expressions.ts` - the `'function'` case returns `false` without generating code. The fix requires:
  1. Use `ref.func` opcode to create a function reference
  2. Call `ctx.module.declareFunction(funcIndex)` to add it to the element section (required by WASM for `ref.func` to work)
  
  Reproduction:
  ```zena
  // module-a.zena
  export let callFactory = (factory: () => i32): i32 => factory();
  
  // module-b.zena
  import { callFactory } from './module-a.zena';
  let myFactory = (): i32 => 42;
  export let main = (): i32 => callFactory(myFactory);  // Error: Unknown identifier: myFactory
  ```
  
  This blocks using `iterable_shared.zena` which takes a factory function to create test collections.

### Self-referential single-parameter generic class causes recursive type substitution

- **Found**: 2026-02-16
- **Severity**: medium
- **Workaround**: Use a wrapper class (e.g., `Set<T>` wrapping `Map<T, Unit>` instead of having its own `SetEntry<E>` class)
- **Details**: When a generic class with a single type parameter has a field referencing itself (e.g., `SetEntry<E>` with `next: SetEntry<E> | null`), and this class is used from another generic class (e.g., `Set<T>` using `SetEntry<T>`), the type checker incorrectly performs recursive type substitution. The error message shows nested types like `SetEntry<SetEntry<SetEntry<T> | null> | null> | null` instead of the correct `SetEntry<T> | null`. This bug does not occur with multi-parameter generics (e.g., Map's `Entry<K, V>` works fine).

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
