# Non-Nullable WASM References

## Problem

Every reference type in codegen unconditionally uses `ref_null` (nullable
reference), even when the checker knows a value cannot be null. This means:

- `Animal` and `Animal | null` produce identical WASM types
- WASM engines can't optimize away null checks on field access / method calls
- The type mapping is less precise than the static type information allows

## Background

WASM GC distinguishes two reference encodings:

- `(ref null $T)` — nullable, can hold `ref.null` or a valid reference
- `(ref $T)` — non-nullable, guaranteed to hold a valid reference

Currently, `mapCheckerTypeToWasmType` returns `[ValType.ref_null, typeIndex]`
for all 11 reference categories (classes, interfaces, arrays, records, tuples,
functions, etc.). The `T | null` union handler unwraps to the inner type and
recurses — but since the inner type already returns `ref_null`, the unwrapping
is a no-op for reference types.

## Compiler Target Status

This optimization targets both compilers, but with different implementation scopes and phases:

- **Bootstrap Compiler (`packages/compiler`)**: Currently, the bootstrap compiler maps all reference types to `ValType.ref_null` (nullable) at the Wasm GC level by default. Transitioning to non-nullable Wasm reference types would require refactoring multiple codegen blocks (such as `try/catch` block result allocation and `match` expression branch mergers) to trace definite assignment. Thus, the bootstrap compiler retains the simpler `ref_null` model to ensure compiler stability.
- **Self-Hosted Compiler (`packages/zena-compiler`)**: The self-hosted compiler is the primary target for full non-nullable Wasm GC optimization. Since it tracks nullability semantics statically at the Zena type checker level, its code generator is designed to eventually map non-nullable types directly to Wasm `(ref $T)`. The self-hosted codegen already implements explicit `emitRefCast` (the equivalent of Wasm's non-null casting) during interface calls and record dispatch field access to handle conversions at non-nullable boundaries.

## Proposed Change

Make `mapCheckerTypeToWasmType` return `[ValType.ref, typeIndex]` (non-nullable)
for non-union reference types, and `[ValType.ref_null, typeIndex]` only when
the checker type is `T | null`.

### Before

```
Animal       → [ref_null, idx]
Animal|null  → unwrap → Animal → [ref_null, idx]   (identical)
```

### After

```
Animal       → [ref, idx]
Animal|null  → [ref_null, idx]                      (distinct)
```

## Benefits

1. **Engine optimizations** — WASM engines can elide null checks for non-nullable
   locals, parameters, fields, and return values.
2. **Truthful type mapping** — the WASM type reflects the static type.
3. **Foundation for non-null assertions** — e.g., `x!` could cast `ref_null`
   to `ref` with a trap on null.

## Scope

### Phase 1: `mapCheckerTypeToWasmType` (core change)

Change the 11 return sites in `mapCheckerTypeToWasmType` from `ref_null` to
`ref`. The `T | null` union handler currently unwraps the union and recurses
into the inner type — since that recursion would now return `ref` (non-nullable),
the handler must stop recursing and instead return `[ref_null, ...]` directly.
This transforms the union unwrapping from a no-op into the mechanism that adds
nullability:

```typescript
if (nonNullTypes.length === 1) {
  // ...primitive boxing unchanged...

  // Reference types: get the non-nullable encoding, make it nullable
  const innerWasm = mapCheckerTypeToWasmType(ctx, innerType); // [ref, idx]
  if (innerWasm[0] === ValType.ref) {
    return [ValType.ref_null, ...innerWasm.slice(1)]; // → [ref_null, idx]
  }
  return innerWasm;
}
```

**Affected categories:** Class, Interface, Array, Record, Tuple, Function/Closure,
ByteArray, String, boxed primitives (Box<T>).

The `NullType` path (`kind === TypeKind.Null`) should continue returning
`[ref_null, ...]` since a bare `null` literal needs a nullable encoding.

### Phase 2: Fix null-producing sites (~23 sites)

Every place that emits `Opcode.ref_null` creates a null value. These sites must
ensure the target local or field is typed `ref_null`, not `ref`. Key categories:

- **Default field values** — `generateDefaultValue` in classes.ts emits
  `ref.null` for reference fields. Fields allowing null must be declared
  `ref_null` in their struct type.
- **Optional parameter defaults** — when no argument is passed, codegen emits
  `ref.null`. The parameter type must be `ref_null`.
- **Null literals in expressions** — `null` returns `ref.null`. The target
  local must be nullable.
- **Conditional fallbacks** — if/match with null branches.

### Phase 3: Fix casting operations (~47 sites)

- `ref.cast_null` (42 sites) — works on nullable inputs, produces nullable
  output. Needed when source or target is nullable.
- `ref.cast` (5 sites) — works on non-nullable inputs, traps on null. Use when
  source is known non-null.
- `ref.test_null` / `ref.test` — same distinction for type tests.

Each site needs a decision: is the source expression nullable? Use the checker
type to decide:

```
source is T|null → ref.cast_null / ref.test_null
source is T      → ref.cast / ref.test
```

### Phase 4: Fix null checks (13 sites)

`ref.is_null` is only valid on nullable refs. In most cases these are already
behind an `if (x != null)` narrowing check, so the source type should be
`T | null`. But verify each site.

### Phase 5: Struct field nullability

Struct field types are declared via `defineStructType`. Currently all reference
fields use `ref_null`. After this change:

- `x: Animal` → field type `ref $Animal`
- `x: Animal | null` → field type `ref null $Animal`
- `var x: Animal` with possible null assignment → `ref null $Animal`

The checker already tracks which fields are `T | null` vs `T`.

## Risks

- **Subtle runtime traps** — assigning null to a `ref` field traps at runtime.
  Must ensure the checker's nullability analysis is sound.
- **`var` fields** — a `var` field typed `Animal` that's later assigned `null`
  would trap. The checker should prevent this (null isn't assignable to
  non-nullable types), but need to verify all paths.
- **Generic type parameters** — `T` may or may not be nullable depending on
  instantiation. May need to default to `ref_null` for generic fields.
- **Casting chains** — downcasts from `anyref` (nullable) to concrete types
  need careful null handling.

## Wasm GC Validation Requirements

### Local Variable Initialization

In WebAssembly GC, local variables of non-nullable types (like `(ref $T)`) do not have a default value. According to the Wasm specification:

- Any local variable declared with a non-nullable type must be definitely assigned (written via `local.set` or `local.tee`) before it is read (`local.get`).
- Since Zena strictly requires all local variables to be initialized upon declaration (e.g. `let x = ...`), this is naturally satisfied. However, the compiler must ensure it generates Wasm bytecode that initializes these locals immediately upon declaration to satisfy the Wasm validator.

### Constructor Field Allocation

In WebAssembly GC, a struct cannot be allocated in a partially uninitialized state if it has non-nullable fields. Crucially:

- `struct.new_default` is only valid if all struct fields are defaultable (nullable references or primitives).
- If a struct has a non-nullable field of type `(ref $T)`, `struct.new` must be called with a valid, non-null reference value.
- Since Zena enforces that all non-nullable fields must be initialized via inline initializers or constructor initializer lists (including `this.` parameter properties) before the constructor body executes, the compiler must evaluate these initializer expressions first, store them in temporary Wasm locals, and call `struct.new` to allocate the object with its fields already initialized, instead of allocating a default-initialized object and assigning fields dynamically in the constructor body.

## Checker Support (Already Exists)

The checker already has the utilities needed:

- `isNullableType(type)` — returns true for `T | null` unions
- `getNonNullableType(type)` — extracts `T` from `T | null`
- `makeNullable(type)` — creates `T | null` union
- Type narrowing already tracks null/non-null in branches

## Testing Strategy

1. Verify all existing tests pass (most should — WASM validates `ref` as
   strictly as `ref_null` for non-null values).
2. Add tests for nullable vs non-nullable parameter types.
3. Add tests that null assignment to non-nullable local fails at checker level.
4. Benchmark to measure engine optimization gains (V8, wasmtime).
