# Name Resolution

## Overview

This document describes the name resolution architecture for the Zena compiler.
Name resolution is the process of determining what declaration a name refers to
at each usage site.

## Current State (Problems)

The current compiler has fragmented name resolution:

1. **Checker resolves types**: `ctx.resolveValue()` and `ctx.resolveType()` look
   up names and return semantic `Type` objects.

2. **Codegen re-resolves by name**: `ctx.resolveFunction()`, `ctx.getLocal()`,
   `ctx.resolveGlobal()` do separate name-based lookups to find WASM indices.

3. **No connection between usage and declaration**: When codegen sees an
   Identifier node, it only has the name string and inferred type—not a
   reference to the declaration.

### Problems with this approach:

1. **Semantic confusion**: Looking up a "function by name" is different from
   "resolving a name that happens to be a function." The latter respects
   shadowing and namespace rules.

2. **Duplicated logic**: Import resolution is duplicated in codegen's
   `resolveFunction()` and `resolveGlobal()`.

3. **No cross-reference**: To find the function index for a call, codegen must
   search through registered functions by name, not by declaration identity.

## Proposed Architecture

### Two Namespaces

Zena has two namespaces:

1. **Value namespace**: Variables, functions, classes (as constructors), enum
   values
2. **Type namespace**: Classes (as types), interfaces, type aliases, enums (as
   types), type parameters

A single name can exist in both namespaces (e.g., a class `Point` is both a
type and a constructor value).

### Resolution Phase

Name resolution should happen during type checking, before code generation.
For each name usage, the checker stores a binding in `SemanticContext`:

```typescript
// In SemanticContext
setResolvedBinding(node: Identifier | MemberExpression, binding: ResolvedBinding): void;
getResolvedBinding(node: Identifier | MemberExpression): ResolvedBinding | undefined;
```

### ResolvedBinding Types

A `ResolvedBinding` is a discriminated union describing what a name resolves to:

```typescript
type ResolvedBinding =
  | LocalBinding // Local variable or parameter
  | GlobalBinding // Module-level variable (const/let/var)
  | FunctionBinding // Named function
  | ClassBinding // Class (in value position = constructor)
  | InterfaceBinding // Interface (rarely used in value position)
  | EnumBinding // Enum
  | EnumMemberBinding // Enum member (e.g., Color.Red)
  | ImportBinding // Re-exported to original declaration
  | TypeParameterBinding; // Type parameter

interface LocalBinding {
  kind: 'local';
  name: string;
  declaration: Parameter | VariableDeclaration; // AST node
  type: Type;
}

interface GlobalBinding {
  kind: 'global';
  name: string;
  declaration: VariableDeclaration;
  modulePath: string; // Which module it's from
  type: Type;
}

interface FunctionBinding {
  kind: 'function';
  name: string;
  declaration: FunctionExpression | DeclareFunction;
  modulePath: string;
  type: FunctionType;
  overloads?: FunctionBinding[]; // For overloaded functions
}

interface ClassBinding {
  kind: 'class';
  name: string;
  declaration: ClassDeclaration;
  modulePath: string;
  type: ClassType;
}

interface ImportBinding {
  kind: 'import';
  localName: string;
  importDeclaration: ImportDeclaration;
  target: ResolvedBinding; // What it resolves to
}
```

### Codegen Usage

With resolved bindings, codegen no longer does name lookups. Instead:

```typescript
// Before (name-based lookup)
function generateIdentifier(
  ctx: CodegenContext,
  expr: Identifier,
  body: number[],
) {
  const local = ctx.getLocal(expr.name);
  if (local) {
    body.push(Opcode.local_get, local.index);
    return;
  }
  const global = ctx.resolveGlobal(expr.name);
  if (global) {
    body.push(Opcode.global_get, global.index);
    return;
  }
  throw new Error(`Unknown identifier: ${expr.name}`);
}

// After (binding-based lookup)
function generateIdentifier(
  ctx: CodegenContext,
  expr: Identifier,
  body: number[],
) {
  const binding = ctx.semanticContext.getResolvedBinding(expr);
  if (!binding) {
    throw new Error(`Unresolved identifier: ${expr.name}`);
  }

  switch (binding.kind) {
    case 'local': {
      const index = ctx.getLocalIndex(binding.declaration);
      body.push(Opcode.local_get, index);
      break;
    }
    case 'global': {
      const index = ctx.getGlobalIndex(binding.declaration);
      body.push(Opcode.global_get, index);
      break;
    }
    case 'function': {
      // Function reference (not a call)
      const index = ctx.getFunctionIndex(binding.declaration);
      body.push(Opcode.ref_func, index);
      break;
    }
    case 'class': {
      // Class in value position = constructor reference
      // Might need special handling
      break;
    }
    case 'import': {
      // Follow import to target
      return generateBindingRef(ctx, binding.target, body);
    }
  }
}
```

### Declaration Registration

Codegen maintains mappings from declarations to WASM indices:

```typescript
// In CodegenContext
#localIndices = new WeakMap<Parameter | VariableDeclaration, number>();
#globalIndices = new WeakMap<VariableDeclaration, number>();
#functionIndices = new WeakMap<FunctionExpression | DeclareFunction, number>();

registerLocal(decl: Parameter | VariableDeclaration, index: number): void;
getLocalIndex(decl: Parameter | VariableDeclaration): number | undefined;

registerGlobal(decl: VariableDeclaration, index: number): void;
getGlobalIndex(decl: VariableDeclaration): number | undefined;

registerFunction(decl: FunctionExpression | DeclareFunction, index: number): void;
getFunctionIndex(decl: FunctionExpression | DeclareFunction): number | undefined;
```

Using `WeakMap` with AST nodes as keys enables identity-based lookup.

## Implementation Plan

### Phase 1: Add Infrastructure ✅

1. Define `ResolvedBinding` types in a new file
   `packages/compiler/src/lib/bindings.ts`
2. Add `setResolvedBinding()` / `getResolvedBinding()` to `SemanticContext`
3. Add declaration → index maps to `CodegenContext`

### Phase 2: Populate Bindings in Checker ✅

1. In `checkIdentifier()` (checker/expressions.ts), after resolving, store the
   binding
2. Handle all binding kinds: local, global, function, class, etc.
3. Resolve imports to their targets

### Phase 3: Use Bindings in Codegen ✅

1. Update `generateIdentifier()` to use resolved bindings
2. Update `generateCallExpression()` to get function index from binding
3. Update `generateAssignmentExpression()` to use binding-based global lookup
4. Update `generateTaggedTemplateExpression()` to use binding-based tag lookup

### Phase 4: Clean Up ✅

1. Remove `resolveFunction()` and `resolveGlobal()` from `CodegenContext`
2. Pass `semanticContext` to `CodeGenerator` in CLI for binding access

## Current Status

**Implemented (January 2026):**

- `bindings.ts` with `ResolvedBinding` types and helper functions
- `SemanticContext.setResolvedBinding()` / `getResolvedBinding()`
- `SymbolInfo` extended with `declaration` and `modulePath` fields
- `CheckerContext.resolveValueInfo()` for creating bindings
- `CodegenContext` declaration → index WeakMaps and registration methods
- `generateIdentifier()` uses resolved bindings
- All `defineParam()` and `declareLocal()` calls pass declaration nodes

**Design Decision: Name-based lookup for locals**

Declaration-based lookup for locals (via `#localIndices` WeakMap) doesn't work
reliably when the same AST is processed multiple times with different local
indices. This happens with generic method instantiation - the WeakMap retains
stale entries from previous instantiations, causing incorrect codegen.

The solution: `generateFromBinding()` uses **name-based lookup for locals**
(via `ctx.getLocal(name)`) instead of declaration-based lookup. This is correct
because:

- Each function has its own scope stack with name→index mappings
- Shadowing is handled by the scope chain
- The checker already validated all identifier references

Declaration-based lookup is retained for **globals** (where name collisions
across modules are possible) and provides the foundation for LSP features.

**Completed (Phase 7):**

- Removed `resolveFunction()` and `resolveGlobal()` from CodegenContext
- Updated `generateCallExpression()` to use binding-based function lookup
- Updated `generateAssignmentExpression()` to use binding-based global lookup
- Updated `generateTaggedTemplateExpression()` to use binding-based tag lookup
- CLI passes `compiler.semanticContext` to `CodeGenerator` for binding access

**Completed (January 2026) - MemberExpression Bindings:**

- Added `FieldBinding`, `GetterBinding`, `MethodBinding`, `RecordFieldBinding` types
- Checker stores resolved bindings for all member access expressions
- `generateMemberExpression()` uses bindings as primary lookup path
- `generateMemberFromBinding()` handles field, getter, method, and record field cases
- Mixin synthetic `This` types handled via `isSyntheticMixinThis` flag
- Fallback code verified as dead (throws if hit) and can be removed

## Next Steps: Codegen Simplification

With bindings working for Identifiers and MemberExpressions, the next phases
focus on removing remaining fallback code and preparing for alternative backends.

### Phase 5: Remove Dead Fallback Code (Low Effort, High Impact)

The fallback paths in `generateMemberExpression` now throw if reached. This
phase removes that dead code and adds similar verification to other areas.

1. Remove the dead fallback code after binding checks in `generateMemberExpression`
2. Add throws to other fallback paths to verify they're not hit
3. Gradually remove verified-dead fallback code throughout codegen

### Phase 6: Move Interface Resolution to Checker

Interface member access still has complex codegen logic (vtable slot computation).

1. Add `InterfaceMethodBinding` and `InterfaceFieldBinding` with vtable slot info
2. Have checker compute vtable slot indices during type checking
3. Codegen reads pre-computed slot from binding, emits vtable access

### Phase 7: Centralize Type Instantiation in Checker

Generic instantiation is currently duplicated between checker and codegen.

1. Have checker instantiate all needed specializations during type-checking
2. Store specialized types in SemanticContext
3. Codegen only instantiates WASM types, not doing semantic type work

### Phase 8: Abstract Emitter Interface (WAT Backend Preparation)

To support a WAT backend alongside binary WASM:

1. Create an IR layer - emit structured instructions instead of raw bytes
2. Abstract `mapCheckerTypeToWasmType` into a shared type mapping layer
3. Create `WasmEmitter` interface that both binary and WAT backends implement

See [compiler-refactoring.md](./compiler-refactoring.md) "Late Type Lowering"
section for the detailed design of keeping `Type` objects through the pipeline.

## Benefits

1. **Correct semantics**: Name resolution respects shadowing and scope rules
2. **Single source of truth**: Resolution happens once in the checker
3. **Simpler codegen**: No name lookups, just index lookups by declaration
4. **Foundation for LSP**: Resolved bindings enable "Go to Definition"
5. **Better error messages**: Can report "defined here" locations

## Open Questions

1. **Overloaded functions**: A call to an overloaded function should resolve to
   the specific overload chosen by the type checker.

2. **Closures**: Captured variables need special handling - they're locals in
   the enclosing function but context fields in the closure.

## Resolved Questions

1. **Generic instantiations**: Declaration-based lookup doesn't work for locals
   in generic method bodies because the same AST is reused with different local
   indices. Solution: Use name-based lookup for locals, which correctly uses
   the current function scope's mappings.

2. **MemberExpression resolution**: ✅ RESOLVED - We now resolve `obj.method`,
   `obj.field`, and `obj.getter` to bindings. The checker stores `MethodBinding`,
   `FieldBinding`, or `GetterBinding` which codegen uses for direct lookup.
