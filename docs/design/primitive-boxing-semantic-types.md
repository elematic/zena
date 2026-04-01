# Primitive Boxing: Semantic Type Preservation

## Problem Statement

When boxing primitives for the `any` type, WASM cannot distinguish between
`boolean` and `i32` because both map to `ValType.i32`. This causes incorrect
behavior:

```zena
let x: any = true;  // Boxes as Box<i32> instead of Box<boolean>
x is boolean;       // Returns false (should be true)
x is i32;           // Returns true (should be false)
```

## Root Cause

The `boxPrimitive()` and `unboxPrimitive()` functions originally only accepted
WASM types:

```typescript
function boxPrimitive(
  ctx: CodegenContext,
  sourceType: number[],
  body: number[],
);
```

When only given `[ValType.i32]`, there's no way to know if the original semantic
type was `boolean` or `i32`. The fallback `wasmTypeToCheckerType()` always
returns `Types.I32` for `ValType.i32`.

## Solution

Added an optional `semanticType` parameter to preserve the checker's type
information:

```typescript
function boxPrimitive(
  ctx: CodegenContext,
  sourceType: number[],
  body: number[],
  semanticType?: Type, // Pass when available to distinguish boolean from i32
);
```

When `semanticType` is provided, it's used directly. Otherwise, the function
falls back to `wasmTypeToCheckerType()`.

## Current Status

### Call Sites WITH Semantic Type (Fixed)

These call sites now pass the semantic type:

| Location         | Context                               | Semantic Type Source                                      |
| ---------------- | ------------------------------------- | --------------------------------------------------------- |
| `statements.ts`  | Variable declaration with `any` type  | `decl.init.inferredType`                                  |
| `expressions.ts` | `as` expression unboxing              | `targetCheckerType`                                       |
| `expressions.ts` | Interface method call return unboxing | `expr.inferredType`                                       |
| `expressions.ts` | Indexer assignment index/value boxing | `indexExpr.index.inferredType`, `expr.value.inferredType` |
| `expressions.ts` | Field assignment boxing               | `expr.value.inferredType`                                 |
| `expressions.ts` | Local/global assignment boxing        | `expr.value.inferredType`                                 |
| `expressions.ts` | Argument adaptation boxing            | `arg.inferredType`                                        |
| `expressions.ts` | Interface getter unboxing             | `expectedType` (checker Type)                             |

### Call Sites WITHOUT Semantic Type (Need Refactoring)

These call sites only have WASM types and use the fallback:

#### 1. Interface Trampolines (`classes.ts`)

**Context**: Trampoline functions adapt interface method calls to class method
implementations.

```typescript
// In generateTrampoline()
unboxPrimitive(ctx, classParamType, body); // Parameter adaptation
boxPrimitive(ctx, classReturnType, body); // Return type adaptation
```

**Why no semantic type**: Trampolines are generated from WASM type indices
stored in `MethodInfo`. The `MethodInfo` type only stores WASM types
(`paramTypes: number[][]`, `returnType: number[]`), not checker Types.

**Fix Required**:

1. Add `paramCheckerTypes?: Type[]` and `returnCheckerType?: Type` to method
   info structures
2. Populate during class registration when checker types are available
3. Pass through `generateTrampoline()` signature
4. Use for `boxPrimitive`/`unboxPrimitive` calls

#### 2. Closure Capture Boxing (`expressions.ts`)

**Context**: When a mutable variable is captured by a closure, it must be boxed
so mutations are visible across closure invocations.

```typescript
// In generateFunctionExpression()
const checkerType = wasmTypeToCheckerType(local.type); // Only has WASM type
boxPrimitive(ctx, local.type, body);
```

**Why no semantic type**: `LocalInfo` only stores WASM types (`type: number[]`),
not the original checker Type from the variable declaration.

**Fix Required**:

1. Add `checkerType?: Type` to `LocalInfo`
2. Populate in `ctx.declareLocal()` calls where checker type is available
3. Use in closure capture boxing

## Impact of Not Fixing

The unfixed call sites affect specific scenarios:

1. **Trampoline boxing**: If a class method returns `boolean` through an
   interface with `any` return type, the value will be boxed as `Box<i32>`.
   Later `is boolean` checks will fail.

2. **Closure capture boxing**: If a `boolean` variable is captured mutably by a
   closure, it will be boxed as `Box<i32>`. Type checks on the captured value
   may be incorrect.

These are relatively rare edge cases - most boxing happens at expression
boundaries where we have `inferredType` available.

## Critical Invariant: Boxing/Unboxing Symmetry

**The boxing and unboxing sites must use the same type.**

If a value is boxed using the WASM-type fallback (e.g., `Box<i32>`), it MUST be
unboxed using the same fallback. If we box as `Box<i32>` but try to unbox as
`Box<boolean>`, the `ref.cast` instruction will fail at runtime.

This means:

- For interface method returns: trampoline boxes without semantic type → we must
  unbox without semantic type
- For direct expression boxing: we box with semantic type → we can unbox with
  semantic type

The code includes comments like:

```typescript
// NOTE: Do NOT pass semantic type here. The value was boxed by a trampoline
// which only has WASM types (no semantic type). We must unbox using the same
// type the trampoline used for boxing.
```

## Implementation Priority

1. **Done**: Pass semantic types where available (covers ~90% of use cases)
2. **Medium priority**: Fix `LocalInfo` to track checker types (enables closure
   fix)
3. **Lower priority**: Fix `MethodInfo` to track checker types (enables
   trampoline fix)

## Testing

The fix is verified by tests in `primitive-boxing_test.ts`:

```typescript
test('boolean boxed to any preserves type identity', async () => {
  const result = await compileAndRun(`
    export const main = (): i32 => {
      let x: any = true;
      if (x is boolean) { return 1; }
      return 0;
    };
  `);
  assert.strictEqual(result, 1);
});
```

## Related Issues

- Original issue: `42 is boolean` returned `true` because both used `Box<i32>`
- Type narrowing issue: `x as i32` after `x is i32` check used narrowed type
  instead of WASM type

## When Auto-Boxing Happens

Auto-boxing occurs when a primitive value must be represented as a reference
type. Here are all the cases:

### 1. Assignment to `any` Type

The most common case. When assigning a primitive to a variable, field, or
parameter of type `any`:

```zena
let x: any = 42;         // i32 → Box<i32>
let y: any = true;       // boolean → Box<boolean>
obj.anyField = 3.14;     // f64 → Box<f64>
```

### 2. Nullable Primitives from Optional Chaining

When optional chaining (`?.`, `?[`, `?()`) accesses a primitive value, the
result type is `T | null`. Since WASM primitives cannot be null, the value must
be boxed:

```zena
class Point { x: i32 = 0; }
let p: Point | null = null;
let x = p?.x;  // Type: i32 | null → Represented as Box<i32> | null

let arr: FixedArray<i32> | null = null;
let elem = arr?[0];  // Type: i32 | null → Represented as Box<i32> | null
```

**Optimization**: When optional chaining is immediately followed by nullish
coalescing (`??`) with a primitive fallback, boxing can be avoided entirely.
This works for both member access (`?.`) and index access (`?[]`):

```zena
let x = p?.x ?? 0;       // No boxing - result is raw i32
let y = arr?[0] ?? -1;   // No boxing - result is raw i32
```

This fusion optimization detects the `optionalExpr ?? fallback` pattern and
generates a single conditional that returns either the accessed value or the
fallback directly, skipping the box/unbox cycle.

### 3. Interface Method Returns/Parameters

When a class method's parameter or return type is more specific than the
interface's:

```zena
interface Numbered { getValue(): any; }
class Counter implements Numbered {
  count: i32 = 0;
  getValue(): i32 { return this.count; }  // i32 boxed to satisfy 'any' return
}
```

### 4. Union Types with Primitives and References (Banned)

Unions that mix primitives with reference types are **prohibited** by the type
checker to avoid requiring auto-boxing:

```zena
let x: i32 | String = ...;  // ERROR: Cannot mix primitives with reference types
```

This is intentional - allowing such unions would require boxing the primitive to
create a uniform representation, which conflicts with Zena's goal of minimal
runtime overhead.

## Boxing Avoidance Strategies

To minimize boxing overhead:

1. **Use concrete types**: Avoid `any` when the type is known
2. **Use `??` with optional chaining**: `p?.x ?? 0` avoids boxing via fusion
3. **Check null before accessing**: Instead of `match (p?.x)` (boxes the
   primitive), check `p == null` first then access `p.x` directly

**Note**: `match` expressions on optional chaining (`match (p?.x)`) still
require boxing because the scrutinee must be stored in a temp variable for
pattern matching.
