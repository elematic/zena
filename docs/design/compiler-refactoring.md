# Compiler Architecture Refactoring

## Overview

This document outlines a comprehensive refactoring of the Zena compiler
architecture to address fundamental design issues:

1. **AST mutation during bundling** - Declaration names are rewritten (`String`
   → `m0_String`), causing cascading type identity problems
2. **Name-based type comparison fallbacks** - Types lose identity through
   renaming, requiring fragile name-based recovery
3. **Suffix-based lookups in codegen** - Type annotations are mapped to struct
   indices by scanning for name suffixes
4. **Multiple type-checker passes** - Bundler renames, then type-checker
   re-checks with new names
5. **Declaration registration disorder** - Types registered by kind (classes,
   then interfaces) instead of module dependency order

## Root Cause Analysis

### The Bundler Problem

The current compiler treats "bundling" as a separate, optional phase:

- `bundler.ts` (in
  [packages/compiler/src/lib/bundler.ts](../../../packages/compiler/src/lib/bundler.ts))
  renames declarations to avoid collisions
- Names are mutated in the AST itself
- Type checker runs _after_ bundling, seeing renamed declarations
- Codegen must reconstruct type identities from the renamed names

**Key realization:** Unlike JavaScript, Zena modules are _always_ part of a
single compilation unit. There is no "load Module A independently" scenario.
Modules are inherently ordered by import dependencies. The concept of "bundling"
conflates two separate concerns:

- **Resolving imports** - Finding modules and reading their source
- **Assigning unique names for binary layout** - Needed only if we emit WAT (for
  readability) or in edge cases

### The Renaming Cascade

When we rename AST nodes:

1. Generic instantiation creates type copies with the renamed declaration names
2. When types are compared later, object identity doesn't match
3. We fall back to name comparison (`classTypesEqual` in
   [packages/compiler/src/lib/checker/types.ts](../../../packages/compiler/src/lib/checker/types.ts))
4. But names might differ due to rebundling, so we add `genericSource` chains
   and suffix-based lookups
5. Type-checking might happen twice (initial + re-check), requiring `_checked`
   flags

This creates a brittle house of cards.

### The Semantic Metadata Problem

The current AST is mutable:

- Parser produces AST
- Type checker mutates it with `inferredType`, `resolvedType`, `_checked` flags
- This makes the AST tightly coupled to a single type-checking pass
- Impossible to reuse AST for incremental compilation (e.g., LSP servers)

## Proposed Architecture

### High-Level Flow

```
entry.zena
    ↓
ModuleLoader (resolve imports, read files)
    ↓
Parser (produces immutable AST)
    ↓
TypeChecker (single pass, topologically ordered)
    ├─ Recursively type-check imported modules first
    ├─ Register types/classes/interfaces as encountered
    ├─ Build SemanticContext (metadata map)
    └─ All types tracked by object identity
    ↓
Codegen
    ├─ Query SemanticContext for metadata
    ├─ Assign struct indices during traversal
    └─ Emit WASM binary directly (no WAT needed)
```

### Key Design Principles

1. **Immutable AST** - Syntax information stays immutable; semantic info lives
   in SemanticContext
2. **Object identity** - Types, symbols, and classes are compared by reference,
   never by name
3. **Single pass** - Type-checker processes the entire program once, in
   dependency order
4. **No renaming** - Declarations keep their source names; binary layout uses
   indices
5. **Separation of concerns** - Parser, type-checker, and codegen each have
   clear responsibilities

## Detailed Components

### 1. SemanticContext

**Location:** New file `packages/compiler/src/lib/checker/semantic-context.ts`

Replaces scattered AST mutations with a single metadata store:

```typescript
export class SemanticContext {
  // Map AST nodes to their inferred types
  readonly nodeTypes = new Map<Node, Type>();

  // Map identifiers/members to their resolved symbols
  readonly nodeSymbols = new Map<Node, Symbol>();

  // Map class/interface types to their struct indices (assigned during codegen)
  readonly typeStructIndices = new Map<ClassType | InterfaceType, number>();

  // Module-level declarations (types, functions, classes, interfaces)
  readonly moduleDeclarations = new Map<string, Map<string, Declaration>>();

  // Cache of already-checked modules (by module path)
  readonly checkedModules = new Set<string>();

  // Reverse mapping: which module exports which declaration
  readonly declarationOrigin = new Map<Declaration, string>();

  setNodeType(node: Node, type: Type): void { ... }
  getNodeType(node: Node): Type | undefined { ... }

  setTypeStructIndex(type: ClassType | InterfaceType, index: number): void { ... }
  getTypeStructIndex(type: ClassType | InterfaceType): number | undefined { ... }

  // ... other accessors
}
```

**Benefits:**

- Multiple type-checking passes can reuse the same immutable AST
- Incremental compilation becomes feasible (invalidate only affected modules)
- Codegen works with explicit metadata, not implicit AST mutations
- LSP servers can maintain AST + SemanticContext for incremental edits

### 2. ModuleLoader

**Location:** New file `packages/compiler/src/lib/loader/module-loader.ts`

Encapsulates module resolution and loading:

```typescript
export interface ModuleLoader {
  /**
   * Resolve an import specifier (e.g., 'zena:string', './local-module')
   * to a canonical module path and its source code.
   */
  resolveModule(
    specifier: string,
    fromModule?: string,
  ): Promise<{
    path: string;
    source: string;
  }>;

  /**
   * Get all modules reachable from entry points, in topological order.
   */
  getModuleGraph(entryPoints: string[]): Promise<string[]>;
}
```

Current bundler logic in
[packages/compiler/src/lib/bundler.ts](../../../packages/compiler/src/lib/bundler.ts):

- Extract module resolution into `ModuleLoader`
- Remove name-renaming logic
- Keep dependency graph construction

**Files affected:**

- `packages/compiler/src/lib/bundler.ts` - Extract to ModuleLoader, deprecate
- `packages/compiler/src/lib/compiler.ts` - Use ModuleLoader instead of Bundler

### 3. TypeChecker Refactoring

**Location:**
[packages/compiler/src/lib/checker/context.ts](../../../packages/compiler/src/lib/checker/context.ts)

**Current design:**

- `CheckerContext` is local to a single module
- `checkModule` is called separately for each module
- Bundler pre-renames, then type-checker runs
- No natural ordering

**New design:**

```typescript
export class CheckerContext {
  constructor(
    moduleLoader: ModuleLoader,
    semanticContext: SemanticContext,
    entryModules: string[],
  ) { ... }

  /**
   * Type-check the entire program starting from entry modules.
   * Recursively type-checks imported modules first (topological order).
   * Returns true if successful, false if errors occurred.
   */
  async checkProgram(): Promise<boolean> { ... }

  /**
   * Type-check a single module (may recursively check imports).
   * Returns true if already checked (cached).
   */
  private async checkModule(modulePath: string): Promise<boolean> { ... }

  /**
   * Register a class, interface, or function in the current module's scope.
   * Called during parsing or semantic analysis.
   */
  registerDeclaration(name: string, declaration: Declaration): void { ... }

  /**
   * Resolve a type by name within the current module context.
   * Checks current scope, then imports, respecting visibility rules.
   */
  resolveType(name: string): Type | undefined { ... }
}
```

**Key changes:**

1. Remove the `_checked` flag from types - rely on
   `semanticContext.checkedModules` instead
2. Remove `preludeExports` and `wellKnownTypes` maps - use explicit ModuleLoader
   for stdlib
3. Make type registration topological:
   - When type-checking module A, if it imports B, check B first
   - Register B's exports in the namespace
   - Then register A's types
4. Store all registered types in SemanticContext
5. Single pass through the entire program

**Files affected:**

- `packages/compiler/src/lib/checker/context.ts` - Major refactor
- `packages/compiler/src/lib/checker/index.ts` - Update public API

### 4. Type Identity by Object Reference

**Location:**
[packages/compiler/src/lib/checker/types.ts](../../../packages/compiler/src/lib/checker/types.ts)

**Current problems:**

- `classTypesEqual()` falls back to name comparison
- `typesEqual()` for interfaces does the same
- `typeToTypeAnnotation()` scans for suffix matches

**New approach:**

```typescript
/**
 * Compare two types by identity.
 * - For primitive types: compare by kind
 * - For class/interface types: compare by object reference (identity)
 * - For generic types: compare base + type arguments recursively
 */
export function classTypesEqual(t1: ClassType, t2: ClassType): boolean {
  // Direct object identity - types from same source are same object
  if (t1 === t2) return true;

  // For generic instantiations:
  // - If both have genericSource, they're the same generic
  // - Compare their type arguments
  if (t1.genericSource && t2.genericSource) {
    if (t1.genericSource !== t2.genericSource) return false;
    if (!t1.typeArguments || !t2.typeArguments) return false;
    return (
      t1.typeArguments.length === t2.typeArguments.length &&
      t1.typeArguments.every((ta, i) => typesEqual(ta, t2.typeArguments![i]))
    );
  }

  return false;
}
```

**Remove these:**

- `_checked` flag from types (use SemanticContext.checkedModules)
- `genericSource` workaround (types from same source are same object)
- Name-based comparison fallback (not needed if types maintain identity)

**Add these:**

- Module-scoped type registry (SemanticContext.moduleDeclarations)
- Type canonicalization during instantiation (reuse existing instances)

**Files affected:**

- `packages/compiler/src/lib/checker/types.ts` - Simplify type comparison
- `packages/compiler/src/lib/codegen/classes.ts` - Remove suffix-based lookups

### 5. Codegen Struct Index Assignment

**Location:**
[packages/compiler/src/lib/codegen/index.ts](../../../packages/compiler/src/lib/codegen/index.ts)

**Current problem:**

- `mapType()` in
  [packages/compiler/src/lib/codegen/classes.ts](../../../packages/compiler/src/lib/codegen/classes.ts)
  uses suffix matching to find struct indices
- This breaks if module names are not unique prefixes

**New approach:**

```typescript
export class Codegen {
  private typeStructIndex = new Map<ClassType | InterfaceType, number>();
  private nextStructIndex = 0;

  /**
   * During codegen, assign struct indices to types as they're encountered.
   * Store in SemanticContext for later reference.
   */
  private assignStructIndex(type: ClassType | InterfaceType): number {
    if (this.typeStructIndex.has(type)) {
      return this.typeStructIndex.get(type)!;
    }

    const index = this.nextStructIndex++;
    this.typeStructIndex.set(type, index);
    this.semanticContext.setTypeStructIndex(type, index);
    return index;
  }

  /**
   * Look up a type's struct index - no string matching needed.
   */
  private getStructIndex(type: ClassType | InterfaceType): number {
    const index = this.typeStructIndex.get(type);
    if (index === undefined) {
      throw new Error(`Type ${type.name} has no struct index assigned`);
    }
    return index;
  }
}
```

**Files affected:**

- `packages/compiler/src/lib/codegen/index.ts` - Accept SemanticContext
- `packages/compiler/src/lib/codegen/classes.ts` - Remove `mapType()`, use
  struct indices
- `packages/compiler/src/lib/emitter.ts` - Use struct indices directly

### 6. AST Immutability

**Location:** All AST node files in
[packages/compiler/src/lib/ast.ts](../../../packages/compiler/src/lib/ast.ts)

**Current mutable fields:**

- `Expression.inferredType`
- `ClassType._checked`
- `Declaration.resolvedType` (if present)

**New approach:**

- Mark all syntax fields as `readonly`
- Remove semantic fields from AST
- Query SemanticContext for metadata during codegen/analysis

**Example migration:**

```typescript
// Before
class Expression {
  readonly type: NodeType;
  inferredType?: Type; // ← mutable semantic field
}

// After
interface Expression {
  readonly type: NodeType;
  // semantic info lives in SemanticContext
}
```

**Gradual approach:**

- Phase 1: Add `readonly` to safe fields
- Phase 2: Move semantic fields to SemanticContext
- Phase 3: Update codegen to use SemanticContext
- Phase 4: Remove mutable fields from AST

### 7. Handling of Well-Known Types

**Current state:**

- `getWellKnownType()` in
  [packages/compiler/src/lib/checker/context.ts](../../../packages/compiler/src/lib/checker/context.ts)
  has hard-coded lookup table

**New approach:**

- Stdlib is just another module (`zena:string`, `zena:array`, etc.)
- ModuleLoader resolves these standard specifiers
- No special well-known type logic needed
- String type is registered during stdlib module type-checking

**Files affected:**

- `packages/compiler/src/lib/checker/context.ts` - Remove getWellKnownType
- `packages/compiler/src/lib/loader/module-loader.ts` - Built-in support for
  `zena:*` specifiers

## Implementation Plan

### Round 1: Foundation (Establish SemanticContext)

**Goal:** Introduce SemanticContext without removing existing functionality

1. Create `SemanticContext` class
2. Wire it through Codegen as optional metadata store
3. Store type→struct index mappings in context
4. Remove suffix-based `mapType()` lookups, use context instead
5. All tests should pass (no semantic changes)

**Important:** Preserve recent type system improvements:
- Never type support in codegen (maps to empty results)
- Literal type support (LiteralTypeAnnotation)
- Union-of-literals detection for enum backing types
- Type parameter erasure to `anyref` (not `i32`) for unbound generics
- NO silent fallback to `i32` for unknown types (should error instead)

**Affected files:**

- Create: `packages/compiler/src/lib/checker/semantic-context.ts`
- Update: `packages/compiler/src/lib/codegen/index.ts` (accept context)
- Update: `packages/compiler/src/lib/codegen/classes.ts` (use context instead of
  mapType)
- Update: `packages/compiler/src/lib/compiler.ts` (create and pass context)
- Update: Tests in `packages/compiler/src/test/`

**Effort:** 2-3 hours

### Round 2: Single Pass Type Checking

**Goal:** Eliminate bundler renaming and multiple type-check passes

1. Create `ModuleLoader` interface
2. Extract module resolution from Bundler
3. Refactor CheckerContext to accept ModuleLoader
4. Implement topological import-driven type-checking
5. Remove Bundler entirely
6. Remove `_checked` flags from types

**Affected files:**

- Create: `packages/compiler/src/lib/loader/module-loader.ts`
- Update: `packages/compiler/src/lib/bundler.ts` (extract to ModuleLoader)
- Update: `packages/compiler/src/lib/checker/context.ts` (major refactor)
- Update: `packages/compiler/src/lib/compiler.ts` (use ModuleLoader)
- Update: `packages/compiler/src/lib/checker/types.ts` (remove `_checked`)
- Update: Tests

**Effort:** 4-5 hours

**Note:** The current bundler's enum type renaming logic will be eliminated entirely. Enums will keep their source names, and the checker's `inferredType` on EnumDeclaration nodes will move to SemanticContext.

### Round 3: Type Identity Simplification

**Goal:** Remove name-based type comparison fallbacks

1. Ensure all type comparisons use object identity
2. Remove `genericSource` workarounds
3. Implement canonical type instance registry in SemanticContext
4. Update type comparison functions
5. Remove name-based fallbacks from `classTypesEqual` and `typesEqual`

**Affected files:**

- Update: `packages/compiler/src/lib/checker/types.ts` (simplify comparison)
- Update: `packages/compiler/src/lib/checker/context.ts` (type registry)
- Update: Tests

**Effort:** 2 hours

### Round 4: AST Immutability

**Goal:** Separate semantic metadata from syntax

1. Mark all AST syntax fields as `readonly`
2. Create wrapper types if needed to maintain API
3. Update type-checker to populate SemanticContext instead of AST
4. Update codegen to query SemanticContext
5. Remove mutable semantic fields from AST

**Affected files:**

- Update: `packages/compiler/src/lib/ast.ts` (mark readonly)
- Update: `packages/compiler/src/lib/checker/expressions.ts`, `statements.ts`,
  `classes.ts` (populate context)
- Update: `packages/compiler/src/lib/codegen/**/*.ts` (query context)
- Update: Tests

**Effort:** 3-4 hours

### Round 5: Incremental Compilation Support (Optional)

**Goal:** Foundation for LSP/watch mode

1. Add invalidation API to SemanticContext
2. Track module dependencies explicitly
3. Support re-checking single modules with unchanged imports
4. Add caching of parse results

**Affected files:**

- Update: `packages/compiler/src/lib/checker/semantic-context.ts`
- Create: `packages/compiler/src/lib/loader/module-cache.ts` (optional)
- Update: Tests

**Effort:** 2-3 hours (optional, can defer)

## Migration Path & Testing

### Compatibility

The refactoring is mostly internal:

- Public compiler API stays the same: `compile(source) → Result`
- All existing tests should pass during each phase
- End-to-end codegen tests validate correctness

### Testing Strategy

1. **Phase 1 (SemanticContext):**
   - Add unit tests for SemanticContext
   - Verify struct index mapping works
   - All existing tests pass

2. **Phase 2 (Single pass):**
   - Add tests for topological ordering
   - Test circular imports (if applicable)
   - Test module re-registration
   - All existing tests pass

3. **Phase 3 (Type identity):**
   - Add tests for generic type instance reuse
   - Test type comparison correctness
   - All existing tests pass

4. **Phase 4 (AST immutability):**
   - Add readonly check to TypeScript compiler
   - Incremental migration of code to use context
   - All existing tests pass

### Rollback Strategy

Each phase is somewhat independent:

- If Phase 2 encounters issues, revert to Phase 1 + fix specific issue
- Each phase's changes are in separate commit(s)
- No phase creates breaking API changes until Phase 4

## Files Summary

### New Files to Create

- `packages/compiler/src/lib/checker/semantic-context.ts`
- `packages/compiler/src/lib/loader/module-loader.ts`
- Possibly: `packages/compiler/src/lib/loader/builtin-loader.ts` (for stdlib)

### Major Files to Update

| File                                               | Changes                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| `packages/compiler/src/lib/bundler.ts`             | Extract ModuleLoader, deprecate                 |
| `packages/compiler/src/lib/compiler.ts`            | Use ModuleLoader instead of Bundler             |
| `packages/compiler/src/lib/checker/context.ts`     | Refactor for single-pass + topological ordering |
| `packages/compiler/src/lib/checker/types.ts`       | Simplify type comparison                        |
| `packages/compiler/src/lib/checker/expressions.ts` | Populate SemanticContext                        |
| `packages/compiler/src/lib/checker/statements.ts`  | Populate SemanticContext                        |
| `packages/compiler/src/lib/checker/classes.ts`     | Populate SemanticContext                        |
| `packages/compiler/src/lib/codegen/index.ts`       | Accept SemanticContext, use struct indices      |
| `packages/compiler/src/lib/codegen/classes.ts`     | Remove mapType(), use struct indices            |
| `packages/compiler/src/lib/ast.ts`                 | Mark fields readonly (gradual)                  |

### Test Files to Update

- `packages/compiler/src/test/checker/**` - Update for SemanticContext
- `packages/compiler/src/test/codegen/**` - Verify struct indices
- `packages/compiler/src/test/**` - Ensure all phases pass

## Success Criteria

### After Round 1

- [ ] SemanticContext class exists and works
- [ ] Codegen uses struct indices from context
- [ ] All existing tests pass
- [ ] No suffix-based type lookups
- [ ] Never and Literal types continue to work correctly
- [ ] Unknown types throw errors instead of silently falling back to i32

### After Round 2

- [ ] Bundler is deprecated (or removed)
- [ ] ModuleLoader exists and works
- [ ] Type-checking is single-pass
- [ ] Types are registered in dependency order
- [ ] All existing tests pass
- [ ] No `_checked` flags on types

### After Round 3

- [ ] No name-based type comparison fallbacks
- [ ] Type identity is by object reference only
- [ ] All existing tests pass
- [ ] No `genericSource` workarounds needed

### After Round 4

- [ ] AST is mostly immutable
- [ ] SemanticContext holds all semantic information
- [ ] All existing tests pass
- [ ] Codegen queries context, not AST

### After Round 5 (Optional)

- [ ] Modules can be re-checked independently
- [ ] Invalidation works correctly
- [ ] LSP integration possible

## Notes for Future Agents

1. **Start with Phase 1:** SemanticContext is the foundation for everything else
2. **Reference architecture:** The TypeScript compiler's `Program` and
   `TypeChecker` separation is a good model
3. **Test as you go:** Each phase should maintain passing tests
4. **Avoid big bang:** Migrate gradually; don't rewrite codegen all at once
5. **Document changes:** Update `packages/compiler/src/lib/README.md` with new
   architecture as you go
6. **Type parameter erasure:** Unbound generic type parameters should map to `anyref`, not `i32` or error - this is the correct approach for type erasure
7. **Error handling:** Never silently fall back to `i32` for unknown types - this masks bugs. Always throw an error instead.
8. **Preserve test coverage:** The generic function instantiation tests in `generic-function-value_test.ts` are valuable regression tests regardless of architecture

## Open Questions

1. Should we support truly independent module checking (e.g., for LSP hover on
   hover on an imported type), or is full-program checking acceptable?
2. Do we need WAT emit for debugging? If so, the stable qualified names strategy
   handles it well.
3. Should AST parsing also be lazy (only parse modules needed for the program),
   or always parse eagerly?
4. How should we handle stdlib imports? A hardcoded builtin loader or virtual
   filesystem?

## References

- [Current Compiler Architecture](./compiler-architecture.md)
- [TypeScript Design: Program &
  TypeChecker](https://github.com/microsoft/TypeScript/wiki/Architectural-Overview)
- [Rust Compiler: Parallel Query
  System](https://rustc-dev-guide.rust-lang.org/query.html)
