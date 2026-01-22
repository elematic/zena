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
LibraryLoader (resolve imports, read files)
    ↓
Parser (produces immutable AST)
    ↓
TypeChecker (single pass, topologically ordered)
    ├─ Recursively type-check imported libraries first
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

Stores semantic metadata separately from the AST. This keeps the AST immutable
and enables incremental compilation.

```typescript
export class SemanticContext {
  // Map AST nodes to their inferred types
  readonly nodeTypes = new Map<Node, Type>();

  // Map identifiers/members to their resolved symbols
  readonly nodeSymbols = new Map<Node, Symbol>();

  // Module-level declarations (types, functions, classes, interfaces)
  readonly moduleDeclarations = new Map<string, Map<string, Declaration>>();

  // Cache of already-checked modules (by module path)
  readonly checkedModules = new Set<string>();

  // Reverse mapping: which module exports which declaration
  readonly declarationOrigin = new Map<Declaration, string>();

  setNodeType(node: Node, type: Type): void { ... }
  getNodeType(node: Node): Type | undefined { ... }

  // ... other accessors
}
```

**Note:** WASM struct indices are stored in `CodegenContext`, not here. This
keeps SemanticContext output-format agnostic—the same semantic info can be used
for different backends (WASM, debugging, LSP hover info, etc.).

**Benefits:**

- Multiple type-checking passes can reuse the same immutable AST
- Incremental compilation becomes feasible (invalidate only affected modules)
- Codegen works with explicit metadata, not implicit AST mutations
- LSP servers can maintain AST + SemanticContext for incremental edits

### 2. LibraryLoader

**Location:** New file `packages/compiler/src/lib/loader/library-loader.ts`

Encapsulates library resolution and loading:

```typescript
export interface LibraryLoader {
  /**
   * Resolve an import specifier (e.g., 'zena:string', './local-library')
   * to a canonical library path and its source code.
   */
  resolveLibrary(
    specifier: string,
    fromLibrary?: string,
  ): Promise<{
    path: string;
    source: string;
  }>;

  /**
   * Get all libraries reachable from entry points, in topological order.
   */
  getLibraryGraph(entryPoints: string[]): Promise<string[]>;
}
```

Current bundler logic in
[packages/compiler/src/lib/bundler.ts](../../../packages/compiler/src/lib/bundler.ts):

- Extract library resolution into `LibraryLoader`
- Remove name-renaming logic
- Keep dependency graph construction

**Files affected:**

- `packages/compiler/src/lib/bundler.ts` - Extract to LibraryLoader, deprecate
- `packages/compiler/src/lib/compiler.ts` - Use LibraryLoader instead of Bundler

### 3. TypeChecker Refactoring

**Location:**
[packages/compiler/src/lib/checker/context.ts](../../../packages/compiler/src/lib/checker/context.ts)

**Current design:**

- `CheckerContext` is local to a single library
- `checkModule` is called separately for each library
- Bundler pre-renames, then type-checker runs
- No natural ordering

**New design:**

```typescript
export class CheckerContext {
  constructor(
    libraryLoader: LibraryLoader,
    semanticContext: SemanticContext,
    entryLibraries: string[],
  ) { ... }

  /**
   * Type-check the entire program starting from entry libraries.
   * Recursively type-checks imported libraries first (topological order).
   * Returns true if successful, false if errors occurred.
   */
  async checkProgram(): Promise<boolean> { ... }

  /**
   * Type-check a single library (may recursively check imports).
   * Returns true if already checked (cached).
   */
  private async checkLibrary(libraryPath: string): Promise<boolean> { ... }

  /**
   * Register a class, interface, or function in the current library's scope.
   * Called during parsing or semantic analysis.
   */
  registerDeclaration(name: string, declaration: Declaration): void { ... }

  /**
   * Resolve a type by name within the current library context.
   * Checks current scope, then imports, respecting visibility rules.
   */
  resolveType(name: string): Type | undefined { ... }
}
```

**Key changes:**

1. Remove the `_checked` flag from types - rely on
   `semanticContext.checkedLibraries` instead
2. Remove `preludeExports` and `wellKnownTypes` maps - use explicit LibraryLoader
   for stdlib
3. Make type registration topological:
   - When type-checking library A, if it imports B, check B first
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

Struct indices are stored in `CodegenContext` (the emitter layer), not
`SemanticContext`. This keeps semantic info separate from output-format-specific
details:

```typescript
// In CodegenContext (WASM emitter state)
export class CodegenContext {
  // Type → WASM struct index mappings (keyed by checker types)
  readonly #classStructIndices = new Map<ClassType, number>();
  readonly #interfaceStructIndices = new Map<InterfaceType, number>();
  readonly #structIndexToClass = new Map<number, ClassType>();
  readonly #structIndexToInterface = new Map<number, InterfaceType>();

  /**
   * Register a class type's WASM struct index.
   * Called during code generation when a class struct is created.
   */
  setClassStructIndex(classType: ClassType, structIndex: number): void {
    this.#classStructIndices.set(classType, structIndex);
    this.#structIndexToClass.set(structIndex, classType);
  }

  /**
   * Get the WASM struct index for a class type.
   */
  getClassStructIndex(classType: ClassType): number | undefined {
    return this.#classStructIndices.get(classType);
  }

  // Similar methods for interfaces...
}
```

**Key insight:** Using checker types (ClassType, InterfaceType) as map keys
enables identity-based lookups. Even if declaration names are renamed during
bundling, the ClassType object remains the same, so lookups work correctly.

**Files affected:**

- `packages/compiler/src/lib/codegen/context.ts` - Store type→struct index maps
- `packages/compiler/src/lib/codegen/classes.ts` - Use identity-based lookups
  instead of `mapType()` suffix matching

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

- Stdlib is just another library (`zena:string`, `zena:array`, etc.)
- LibraryLoader resolves these standard specifiers
- No special well-known type logic needed
- String type is registered during stdlib library type-checking

**Files affected:**

- `packages/compiler/src/lib/checker/context.ts` - Remove getWellKnownType
- `packages/compiler/src/lib/loader/library-loader.ts` - Built-in support for
  `zena:*` specifiers

## Implementation Plan

### Round 1: Foundation (Establish SemanticContext) ✅ COMPLETED

**Goal:** Introduce SemanticContext without removing existing functionality

1. ✅ Create `SemanticContext` class
2. ✅ Wire it through Codegen as optional metadata store
3. ✅ Store type→struct index mappings in `CodegenContext` (emitter layer)
4. ✅ Add identity-based lookup methods (`getClassInfoByType`, `getInterfaceInfoByType`)
5. All tests pass (no semantic changes)

**Architecture note:** Struct indices are stored in `CodegenContext`, not
`SemanticContext`. This keeps semantic info output-format agnostic. The same
SemanticContext could be used for different backends (WASM, debugging, etc.).

**Important:** Preserve recent type system improvements:

- Never type support in codegen (maps to empty results)
- Literal type support (LiteralTypeAnnotation)
- Union-of-literals detection for enum backing types
- Type parameter erasure to `anyref` (not `i32`) for unbound generics
- NO silent fallback to `i32` for unknown types (should error instead)

**Files completed:**

- Created: `packages/compiler/src/lib/checker/semantic-context.ts`
- Updated: `packages/compiler/src/lib/codegen/context.ts` (type→struct index maps)
- Updated: `packages/compiler/src/lib/codegen/classes.ts` (register types during preRegister)
- Updated: `packages/compiler/src/lib/codegen/index.ts` (pass SemanticContext to CodegenContext)

**Effort:** 2-3 hours

### Investigation: mapType Suffix-Based Lookups

**Problem:** `mapType()` in `codegen/classes.ts` uses suffix matching like
`name.endsWith('_' + typeName)` to resolve bundled class names. This is fragile.

**Locations of suffix-based lookups:**

- Line ~2454: Type alias suffix lookup
- Line ~2558: Generic class suffix lookup
- Line ~2608: Class suffix lookup
- Line ~2630: Interface suffix lookup

**Finding: Suffix matching IS required for some code paths.**

Attempted to remove suffix lookups (2026-01-21) but discovered they are still
needed. Debug logging showed the `map` test (using `Map<K,V>` from stdlib)
fails without suffix lookups.

**Root cause:**

When the Map class uses its internal `Entry<K, V>` type, some TypeAnnotation
nodes contain the unbundled name `Entry` instead of the bundled name `m2_Entry`.
This happens because:

1. The bundler renames declaration names and most type annotations
2. But some type annotations are created during codegen (e.g., for generic
   instantiation type contexts) using unbundled names
3. Example: `typeToTypeAnnotation()` can create TypeAnnotations from checker
   types, and if the checker type's name wasn't updated, the annotation has
   the unbundled name

**Concrete example from debugging:**

```
typeName='Entry'  (unbundled - looking for this)
ctx.classes keys: m2_Entry<m4_String,m3_Box<i32>>, m2_Entry<K,V>  (bundled)
```

The suffix lookup `'m2_Entry<K,V>'.endsWith('_Entry')` succeeds and finds the
generic template.

**Why previous "dead code" evidence was incorrect:**

Initial testing with debug logging showed no suffix lookups triggered for most
tests. However, this was misleading:

1. Test caching (Wireit) skipped re-running tests after adding logging
2. The Map test was the key case that triggers suffix lookups
3. Simpler tests (user-defined classes in same module) don't need suffix lookups

**Why suffix lookups are problematic:**

1. Couples codegen to bundler naming conventions (fragile if conventions change)
2. The fallback returns the FIRST match from Map iteration - non-deterministic
   if two modules define classes ending with the same suffix
3. Relies on naming convention (`m{N}_Name`) that could change

**Resolution path:**

To remove suffix lookups, we need to ensure `typeToTypeAnnotation()` always
produces bundled names. This requires either:

1. Updating checker types with bundled names (Step 2.5.4 approach - but this
   creates identity issues for generic instantiations)
2. Using identity-based lookups that bypass names entirely (Round 3 approach)
3. Ensuring all TypeAnnotation creation uses bundled names from context

This turned out to be incorrect - the bundler does update type annotations in
generic class bodies correctly. The suffix matching was defensive coding that
became unnecessary.

### Round 2: Single Pass Type Checking (IN PROGRESS)

**Goal:** Eliminate bundler renaming and multiple type-check passes

> **Terminology Note:** We use "library" to refer to individual `.zena` files,
> reserving "module" for WASM modules. This avoids confusion since the compiler
> produces WASM modules from multiple Zena libraries.

#### Step 2.1: LibraryLoader Interface ✅ COMPLETED

Created a `LibraryLoader` class that handles library resolution, loading, parsing, and caching:

1. ✅ Create `LibraryLoader` class with `resolve()`, `load()`, `has()`, `get()`, `libraries()`, `computeGraph()` methods
2. ✅ Create `LibraryRecord` type to represent loaded libraries with identity
3. ✅ Implement topological sorting via `computeGraph()`
4. ✅ Handle circular imports gracefully (add to cache before recursing)
5. ✅ Add tests for library loading, caching, cycle detection, and identity

**Files created:**

- `packages/compiler/src/lib/loader/library-loader.ts` - LibraryLoader class
- `packages/compiler/src/lib/loader/index.ts` - Public exports
- `packages/compiler/src/test/loader/library-loader_test.ts` - Tests

**Key design decisions:**

- `LibraryRecord` is cached by path - same path always returns same object (identity)
- Circular imports don't cause infinite recursion - library added to cache before loading deps
- Uses `CompilerHost` for file system access (no separate `LibraryLoaderHost` - that would duplicate `CompilerHost`)
- `computeGraph()` returns topological order with cycle detection
- **No `loadPrelude()` method** - Prelude handling is a _compilation policy_, not a loader concern.
  The Compiler is responsible for:
  1. Parsing the prelude source to extract stdlib specifiers
  2. Calling `loader.load()` for each stdlib path
  3. Passing prelude libraries to the type checker
     This keeps LibraryLoader focused on its core job: loading, parsing, and caching libraries.

#### Step 2.2: Refactor Compiler to use LibraryLoader ✅ COMPLETED

Refactored the `Compiler` class to use `LibraryLoader` internally for all library loading:

1. ✅ Added `#loader: LibraryLoader` field to Compiler
2. ✅ Updated `compile()` to use `loader.load()` and convert libraries to modules
3. ✅ Updated `#loadPrelude()` to load via LibraryLoader and convert ALL transitive dependencies to modules
4. ✅ Created `#libraryToModule()` to convert `LibraryRecord` to `Module` (adding checker-specific fields)
5. ✅ All tests pass

**Key insight:** When prelude imports from `zena:array` (a re-export module), the LibraryLoader
loads all transitive dependencies (`zena:fixed-array`, `zena:sequence`, etc.). The fix ensures
ALL loaded libraries are converted to Modules and added to `#modules`, not just the directly
imported ones. This allows the Bundler to see re-exported symbols like `zena:array:FixedArray`.

**Files updated:**

- `packages/compiler/src/lib/compiler.ts` - Uses LibraryLoader, simplified module loading

#### Step 2.3: Topological Type-Checking Order

**Goal:** Ensure libraries are type-checked in dependency order so that imported types are fully resolved before use.

Currently, the `Compiler.#checkModules()` method already handles this:

- It calls `checkModule()` for each dependency before checking the current module
- Prelude modules are checked before user modules

**Status:** This is already implemented in `Compiler.#checkModules()`. The topological ordering is handled there.

**Remaining work for this step:**

1. Verify that prelude modules are checked in the correct order (dependencies first)
2. Consider moving the topological logic to use `LibraryLoader.computeGraph()` for consistency

#### Step 2.4: Remove `_checked` Flags from Types

**Goal:** Eliminate the `_checked` flag on ClassType/InterfaceType/MixinType.

**Status:** BLOCKED - Requires eliminating double type-checking first.

**Finding:** The `_checked` flag must persist across CheckerContext instances because
the current compilation flow runs the type checker twice:

1. First in `compiler.bundle()` via `#checkModules()`
2. Second explicitly in test utilities (e.g., `runZenaTestFile`) to "ensure types have correct bundled names"

The `_checked` flag is stored on the type object itself (not in CheckerContext) so it
survives across multiple TypeChecker instantiations. If we move it to `ctx.checkedTypes`,
the second type-check pass fails with "Duplicate constructor/field/method" errors.

**Prerequisite:** Step 2.5 (Remove Bundler Renaming) must be completed first.
Once we eliminate bundler renaming and the need for a second type-check pass, we can:

1. Move `_checked` tracking to SemanticContext (shared across checker instances)
2. Or simply remove the second type-check pass entirely

**Tasks (deferred):**

1. Add `checkedTypes: Set<Type>` to SemanticContext (not CheckerContext)
2. Replace `type._checked = true` with `semanticContext.checkedTypes.add(type)`
3. Replace `if (type._checked)` with `if (semanticContext.checkedTypes.has(type))`
4. Remove `_checked` property from ClassType, InterfaceType, MixinType

#### Step 2.5: Remove Bundler Renaming (Incremental Approach)

**Goal:** Remove bundler's type name mutation and use identity-based lookups.

**Status:** IN PROGRESS - Using incremental approach to avoid breaking changes.

**Background:** A previous attempt to remove bundler renaming in one step caused
10 closure type mismatch failures. The incremental approach adds infrastructure
first, then switches over gradually.

##### Step 2.5.1: Infrastructure Only ✅ COMPLETED

Added identity-based lookup infrastructure without changing behavior:

1. ✅ Added `structDefined` guard field to `ClassInfo` interface
2. ✅ Added `#classBundledNames` map: `ClassType -> bundledName`
3. ✅ Added `#genericTemplates` map: `name -> ClassType`
4. ✅ Added `#genericSpecializations` map: `key -> ClassInfo`
5. ✅ Added accessor methods for the new maps

##### Step 2.5.2: Register Identity Mappings ✅ COMPLETED

Populated identity maps during class registration (but not using them yet):

1. ✅ In `preRegisterClassStruct`: Register bundled name and generic templates
2. ✅ In `instantiateClass`: Register generic specializations

##### Step 2.5.3: Add Guards ✅ COMPLETED

Added guards to prevent duplicate class definitions:

1. ✅ `defineClassStruct`: Early return if `classInfo.structDefined` is true
2. ✅ `instantiateClass`: Early return if existing `ClassInfo.structDefined` is true
3. ✅ Set `structDefined = true` after completing struct definition

##### Step 2.5.4: Stop Type Name Mutation ✅ COMPLETED

**Status:** COMPLETED - Type object names are no longer mutated.

The bundler no longer mutates `typeObj.name`. This was already done:

- Comment in `bundler.ts` line ~226 confirms: "Type object names are NO LONGER mutated here"
- `typeToTypeAnnotation` already uses `ctx.getClassBundledName()` for identity-based lookup
- Bundled names are registered during `preRegisterClassStruct` for declarations

**Remaining concern:** When `getClassBundledName()` fails (returns undefined),
the code falls back to `classType.name`. This can happen for:

1. Generic instantiations where the ClassType object differs from the registered one
2. Types from expressions that weren't directly registered

This is acceptable because the suffix-based lookups in `mapType` handle these cases.

##### Step 2.5.5: Use Identity Lookups and Remove Suffix Lookups ✅ COMPLETED

**Status:** COMPLETED

**Investigation (2026-01-21):**

Initial attempts to remove suffix-based lookups failed because `Entry<K, V>`
types in the Map stdlib had no `genericSource` chain leading to a registered
bundled name.

**Root cause:** In `substituteType()` (checker/types.ts), identity-substituted
generic types (where type arguments match type parameters, like `Entry<K, V>`)
did not set `genericSource`. This broke the `genericSource` chain lookup in
`typeToTypeAnnotation`.

**Fix:** Added `genericSource` to the identity-substitution case in
`substituteType()`:

```typescript
// In checker/types.ts substituteType() for identity substitution:
return {
  ...source,
  typeArguments: newTypeArguments,
  genericSource:
    source.genericSource || (source.typeParameters ? source : undefined),
} as ClassType;
```

**Result:** All 4 suffix-based lookups removed from `mapTypeInternal`:

- Type alias suffix lookup
- Generic class suffix lookup
- Class suffix lookup
- Interface suffix lookup

All 1118 tests pass.

##### Step 2.5.6: Remove Bundled Name Bridge Infrastructure (OPTIONAL)

**Status:** READY - Can proceed now that suffix lookups are removed.

**Background:** The `#classBundledNames` and `#interfaceBundledNames` maps in
`CodegenContext` exist as a bridge solution. They allow `typeToTypeAnnotation`
to convert checker types back to TypeAnnotation AST nodes with the correct
(bundled) names.

**Problem with TypeAnnotations:** TypeAnnotations are just names, but names are
only meaningful within a scope. When we create a TypeAnnotation with a name like
`"Array"`, that name could refer to different types depending on scope. The
checker resolves names within their scope, but by the time we're in codegen,
we've lost that scope context. The bundled name workaround ensures uniqueness
across modules, but it's fragile.

**Proper solution:** When we already have a checker type (ClassType, InterfaceType),
we shouldn't round-trip through TypeAnnotation at all. Instead:

1. Add `mapCheckerType(type: Type): number[]` to codegen that:
   - For ClassType: Use `getClassStructIndex()` directly
   - For InterfaceType: Use `getInterfaceStructIndex()` directly
   - For primitives: Return the appropriate ValType
2. Update callers of `typeToTypeAnnotation` to use `mapCheckerType` when they
   already have a checker type
3. Remove the bundled name maps once no longer needed

**Tasks:**

1. Implement `mapCheckerType()` in codegen/classes.ts
2. Audit all `typeToTypeAnnotation` call sites
3. Replace calls that have checker types available with `mapCheckerType`
4. Remove `#classBundledNames`, `#interfaceBundledNames` and their accessors
5. Remove `setClassBundledName`, `getClassBundledName`, etc.

#### Step 2.5 (Original): Remove Bundler Renaming

1. Remove Bundler entirely (or just the renaming logic)
2. Update tests to work with original symbol names
3. Remove suffix-based lookups from codegen (now safe to delete)

**Affected files:**

- ✅ Created: `packages/compiler/src/lib/loader/module-loader.ts`
- ✅ Created: `packages/compiler/src/lib/loader/index.ts`
- Update: `packages/compiler/src/lib/bundler.ts` (extract to ModuleLoader)
- Update: `packages/compiler/src/lib/checker/context.ts` (major refactor)
- Update: `packages/compiler/src/lib/compiler.ts` (use ModuleLoader)
- Update: `packages/compiler/src/lib/checker/types.ts` (remove `_checked`)
- Update: Tests

**Effort:** 4-5 hours total (Step 2.1 done, ~3 hours remaining)

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

### Suggested Failing Tests (Add Before Fix)

These tests expose latent bugs caused by name-based lookups. They should fail
with the current implementation and pass after the refactoring is complete.

#### 1. Cross-Module Generic with Same Class Name

**File:** `packages/compiler/src/test/codegen/cross-module-generic-collision_test.ts`

**Problem:** Two modules define different classes with the same name. When both
are used as type arguments to a generic, the suffix-based lookup in `mapType()`
may resolve to the wrong class.

```zena
// Module A (zena:test/module-a)
export class Item { value: i32; #new(v: i32) { this.value = v; } }

// Module B (zena:test/module-b)
export class Item { name: string; #new(n: string) { this.name = n; } }

// Main module
import { Item as ItemA } from 'zena:test/module-a';
import { Item as ItemB } from 'zena:test/module-b';

class Box<T> { contents: T; #new(c: T) { this.contents = c; } }

const boxA = new Box<ItemA>(new ItemA(42));
const boxB = new Box<ItemB>(new ItemB('hello'));

// Should access the correct field for each type
export const test = () => boxA.contents.value + boxB.contents.name.length;
```

**Expected:** Returns `42 + 5 = 47`  
**Current risk:** `mapType()` might resolve `ItemA` to `ItemB`'s struct if
suffix matching is ambiguous.

#### 2. Generic Instantiation After Bundler Rename

**File:** `packages/compiler/src/test/codegen/generic-rename-lookup_test.ts`

**Problem:** `getSpecializedName()` produces names like `Box_m0_String` after
bundling. If the checker's ClassType still has the original name, identity-based
lookup fails and we fall back to suffix matching.

```zena
// Stdlib provides String (renamed to m0_String after bundling)
class Box<T> {
  value: T;
  #new(v: T) { this.value = v; }
}

const strBox = new Box<string>('test');

// Later, use the Box<string> type in a function signature
const getLength = (b: Box<string>) => b.value.length;

export const test = () => getLength(strBox);
```

**Expected:** Returns `4`  
**Current risk:** The `Box<string>` in `getLength`'s signature may create a
different specialized name than the one created for `strBox`, causing a type
mismatch or wrong struct index.

#### 3. Record Type with Class-Typed Field After Rename

**File:** `packages/compiler/src/test/codegen/record-class-field-rename_test.ts`

**Problem:** Record type canonical keys include field types. If a class is
renamed, two records with the "same" structure may get different canonical keys.

```zena
class Point { x: i32; y: i32; #new(x: i32, y: i32) { this.x = x; this.y = y; } }

const makeRecord = () => { point: new Point(1, 2) };
const useRecord = (r: { point: Point }) => r.point.x + r.point.y;

export const test = () => useRecord(makeRecord());
```

**Expected:** Returns `3`  
**Current risk:** If `makeRecord`'s return type is computed before bundler
rename and `useRecord`'s parameter type is computed after, the record types
may have different canonical keys.

#### 4. Closure Type with Generic Callback

**File:** `packages/compiler/src/test/codegen/closure-generic-callback_test.ts`

**Problem:** Closure types are keyed by WASM type bytes, which derive from
struct indices. If a generic class instantiation's struct index lookup fails,
the closure signature may be wrong.

```zena
class Container<T> {
  items: array<T>;
  #new() { this.items = #[]; }

  forEach(callback: (item: T) => void): void {
    // iterate and call callback
  }
}

const container = new Container<i32>();
var sum = 0;
container.forEach((x) => { sum = sum + x; });

export const test = () => sum;
```

**Expected:** Compiles and runs  
**Current risk:** The closure type for `(item: T) => void` may resolve `T`
incorrectly if the generic instantiation lookup fails.

#### 5. Interface Implementation Across Modules

**File:** `packages/compiler/src/test/codegen/interface-cross-module_test.ts`

**Problem:** Interface names are used as keys in `classInfo.implements` map.
After renaming, the interface name may not match.

```zena
// Module A
export interface Printable { print(): string; }

// Module B
import { Printable } from 'zena:test/module-a';

export class Item implements Printable {
  name: string;
  #new(n: string) { this.name = n; }
  print(): string { return this.name; }
}

// Main
import { Printable } from 'zena:test/module-a';
import { Item } from 'zena:test/module-b';

const printIt = (p: Printable) => p.print();

export const test = () => printIt(new Item('hello'));
```

**Expected:** Returns `"hello"`  
**Current risk:** `Item`'s implements map may use a different name for
`Printable` than what `printIt` expects.

### Test Implementation Notes

- These tests require multi-module compilation support in the test harness
- Some may already pass if the current implementation handles the edge case
- If a test passes unexpectedly, investigate why—either the bug was fixed or
  the test doesn't exercise the intended code path
- After refactoring, these tests serve as regression tests

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
