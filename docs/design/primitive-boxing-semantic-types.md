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
