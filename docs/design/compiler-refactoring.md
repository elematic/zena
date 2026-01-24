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

### Round 2: Single Pass Type Checking ✅ COMPLETED

**Goal:** Eliminate bundler renaming and multiple type-check passes

**Status:** ✅ COMPLETED (2026-01-23) - Bundler has been deleted. Codegen uses
identity-based lookups via `resolveClassByName()` and `getTypeKeyWithContext()`.

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
4. ✅ Added `#classInfoByType` WeakMap: `ClassType -> ClassInfo` (identity-based)
5. ✅ Added accessor methods for the new maps
6. ✅ ~~`#genericSpecializations` map~~ - REMOVED (replaced by `#classInfoByType`)

##### Step 2.5.2: Register Identity Mappings ✅ COMPLETED

Populated identity maps during class registration:

1. ✅ In `preRegisterClassStruct`: Register bundled name and generic templates
2. ✅ In `instantiateClass`: Register ClassInfo by type identity (`registerClassInfoByType`)

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

**Status:** PARTIALLY COMPLETE - `mapCheckerTypeToWasmType()` works for most cases.
Removing `#classBundledNames`/`#interfaceBundledNames` is blocked until `instantiateClass`
can register by type identity.

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

**Progress (2026-01-22):**

`mapCheckerTypeToWasmType()` in `codegen/classes.ts` now handles:

- ✅ Non-generic ClassType via identity-based lookup (`resolveClassInfo`)
- ✅ Non-generic InterfaceType via identity-based lookup (`resolveInterfaceStructIndex`)
- ✅ Extension classes for non-generic lookups (returns `onType`)
- ✅ Generic classes via identity-based WeakMap lookup (`#classInfoByType`)
- ✅ Generic extension classes (e.g., `FixedArray<T>`) via `onTypeAnnotation` recomputation

**Implementation details:**

1. `resolveClassInfo()` uses identity lookup via `#classInfoByType` WeakMap, then
   follows `genericSource` chain to find registered ClassInfo.
2. `instantiateClass()` registers ClassInfo by type identity during instantiation.
3. `resolveExtensionClassInfo()` handles extension classes by recomputing `onType`
   from the stored `onTypeAnnotation` + current type arguments.

**Key insight (onType vs onTypeAnnotation):**

Extension classes like `FixedArray<T> on array<T>` have two related concepts:

- `onTypeAnnotation` (Zena TypeAnnotation): The type from the AST (`array<T>`),
  stored once when the class is registered.
- `onType` (WASM bytes): The WASM array type, which depends on the element type.

Previously, `onType` was computed once during instantiation. But WASM array types
are canonicalized by element type - `array<i32>` and `array<String>` get different
type indices depending on order of creation. This caused mismatches when a
specialization was registered in one context but used in another.

The fix: Store `onTypeAnnotation` alongside `onType`, and recompute `onType` at
each use site using `mapType(ctx, onTypeAnnotation, typeContext)`. This ensures
the correct WASM array type index for the current context.

**Tasks:**

1. ✅ Implement `mapCheckerTypeToWasmType()` for non-generic classes/interfaces
2. ✅ Add `resolveClassInfo()` helper that follows `genericSource` chain
3. ✅ ~~Add `computeSpecializationKey()` to look up generic specializations~~ REMOVED
4. ✅ ~~Add `containsTypeParameter()` to skip lookups with unresolved type params~~ REMOVED
5. ✅ Add `onTypeAnnotation` to ClassInfo for extension classes
6. ✅ Add `resolveExtensionClassInfo()` to recompute `onType` at each use site
7. ✅ Remove string-based lookup infrastructure:
   - Removed `getCheckerTypeKey()` (~120 lines)
   - Removed `computeSpecializationKey()` (~45 lines)
   - Removed `containsTypeParameter()` (~30 lines)
   - Removed `#genericSpecializations` Map from CodegenContext
   - Removed `registerGenericSpecialization()` and `findGenericSpecialization()`
8. Audit all `typeToTypeAnnotation` call sites - DEFERRED
9. Replace calls that have checker types available - DEFERRED
10. Remove `#classBundledNames`, `#interfaceBundledNames` - BLOCKED (see below)

**Progress (2026-01-22) - instantiateClass checker type registration:**

Added infrastructure to pass checker types through `instantiateClass` for registration:

1. ✅ Added optional `checkerType?: ClassType` parameter to `instantiateClass()`
2. ✅ When provided, registers ClassInfo via `ctx.registerClassInfoByType()`
3. ✅ Added `ctx.getGenericDeclByType()` - identity-based lookup for generic declarations
4. ✅ Updated `mapCheckerTypeToWasmType()` to use identity-based declaration lookup
   and pass checker type through to `instantiateClass()`
5. ✅ Updated `resolveClassInfo()` to not return templates for specialized types
   (returns undefined instead, triggering proper instantiation)

**Remaining limitation:** The name-based lookup in `generateMemberExpression` is
still needed because method registration is deferred (`pendingMethodGenerations`).
When `mapCheckerTypeToWasmType` triggers `instantiateClass`, the ClassInfo is
registered by checker type immediately, but methods aren't populated yet. The
name-based lookup via `ctx.classes.get(specializedName)` works because the methods
are populated before codegen uses them (during the pending method generation phase).

**Attempted simplification that failed:**

Tried to simplify `generateMemberExpression` to use identity-based lookup
(`getClassInfoByCheckerType`) instead of building specialized names. This
correctly found the ClassInfo, but methods weren't populated yet (empty map)
because `registerMethods()` is deferred. The name-based path works because it
looks up the same ClassInfo object which gets populated later.

**To complete the removal of bundled names, we would need to:**

1. ~~Pass checker types through `instantiateClass()` instead of TypeAnnotations~~ ✅ DONE
2. Ensure type interning so the same specialized ClassType is used everywhere ✅ DONE (in checker)
3. ~~Register generic templates' ClassInfo even though they don't have WASM structs~~ N/A
4. **NEW: Ensure methods are registered before identity-based lookups are used**
   - Either run `registerMethods()` synchronously during `instantiateClass()`, OR
   - Accept that identity-based lookup is only reliable after method generation

~~This is tracked as future work under "Late Type Lowering".~~

##### Root Cause Discovery (2026-01-22): Per-Module Type Interning

**Status:** ROOT CAUSE IDENTIFIED - Name-based lookups are needed because type
interning is per-module, not per-program.

**Investigation:** Attempted to remove name-based lookups from `generateMemberExpression`
in favor of identity-based lookup via `getClassInfoByCheckerType()`. This failed for:

1. **Mixin synthetic types** (`M_This`) - Fixed with `ctx.currentClass` check for `this` expressions
2. **Extension classes across modules** (e.g., `ArrayExt<i32>` from stdlib) - Identity lookup fails

**Root cause analysis:**

When codegen calls `mapCheckerTypeToWasmType()` with a ClassType from an expression's
`inferredType`, the type was interned in a **different** `CheckerContext` than the
one that registered the class during type checking. This happens because:

1. `Compiler.#checkModules()` creates a **new TypeChecker** for each module (line ~161)
2. `TypeChecker.check()` creates a **new CheckerContext** each time (line ~36)
3. Type interning happens in `CheckerContext` via `#internedTypes` Map
4. Each module's types are interned independently

**Concrete example:**

```
Module A (stdlib): ArrayExt<i32> interned as object X
Module B (user):   ArrayExt<i32> interned as object Y (different object!)
```

Both `X` and `Y` have the same structure (`name: 'ArrayExt', typeArguments: [I32]`),
but they're different JavaScript objects. The `#classInfoByType` WeakMap in
codegen was keyed by object `X` (from when the class was registered), but codegen
receives object `Y` (from the user module's type checking). Identity lookup fails.

**Current workaround:** Hybrid lookup in `generateMemberExpression`:

```typescript
// Try identity-based lookup first
let classInfo = ctx.getClassInfoByCheckerType(classType);

// Fall back to name-based lookup
if (!classInfo) {
  const specializedName = getSpecializedName(classType, ctx);
  classInfo = ctx.classes.get(specializedName);
}
```

All 1142 tests pass with this hybrid approach.

**Architectural flaw identified:**

The fundamental issue isn't in codegen—it's that **each module gets its own type
interning cache**. This defeats the purpose of type interning, which is to ensure
identical types share the same object reference across the entire compilation.

The current architecture treats modules too independently:

- Each module gets a fresh `CheckerContext`
- The `Bundler` flattens modules by renaming symbols (`m0_String`, `m1_Array`)
- This is a workaround for not having proper module-qualified names

**Correct architecture:**

A `Program` should be _composed_ of libraries, not flattened. One `CheckerContext`
should span the entire compilation:

1. **One CheckerContext** for the whole compilation
2. **Libraries are namespaces** within that context
3. **Type interning is global** - `ArrayExt<i32>` is the same object everywhere
4. **No bundler renaming** - types are looked up by identity, not by name

See **Step 2.6: Unified CheckerContext** for the implementation plan.

##### Future: Migrate from `onType` to `onTypeAnnotation`

**Status:** PLANNED - Not blocking Step 2.5.6 completion.

Currently, `ClassInfo` has both `onType` (WASM bytes, computed) and `onTypeAnnotation`
(Zena TypeAnnotation, stored from AST). The intent is to migrate to only
`onTypeAnnotation` over time for cleaner architecture.

**Current state:**

- `onTypeAnnotation` is set from `ClassDeclaration.onType` (AST) during codegen
  in `preRegisterClassStruct` and `instantiateClass`
- `onType` is computed via `mapType(ctx, decl.onType, context)` during codegen
- ~30 call sites read `classInfo.onType` directly

**Migration plan:**

1. Add `getOnType(ctx, classInfo, typeContext?)` helper that computes WASM bytes
   lazily from `onTypeAnnotation`
2. Update all ~30 call sites in `codegen/classes.ts`, `codegen/functions.ts` to
   use `getOnType()` instead of direct `classInfo.onType` access
3. Remove `onType` field from `ClassInfo` interface

**Benefits:**

- Single source of truth (`onTypeAnnotation`)
- Correct computation at each use site (no stale cached values)
- Cleaner separation between AST-level types and WASM-level types

##### Expanding mapCheckerTypeToWasmType ✅ COMPLETED (2026-01-22)

**Goal:** Add direct handling for Array, Record, Tuple, Function, TypeParameter,
TypeAlias types to reduce reliance on the annotation-based fallback path.

**Result:** SUCCESS - All types now handled directly.

**The key insight:** Handle `TypeParameter` FIRST by looking it up in
`ctx.currentTypeContext`. This ensures type parameters (T, K, V) are resolved
to concrete types before we try to handle nested types recursively.

```typescript
// Handle TypeParameter FIRST - resolve via context
if (type.kind === TypeKind.TypeParameter) {
  const typeParam = type as TypeParameterType;
  if (ctx.currentTypeContext?.has(typeParam.name)) {
    const resolved = ctx.currentTypeContext.get(typeParam.name)!;
    return mapType(ctx, resolved, ctx.currentTypeContext);
  }
  // Unresolved type parameter - erase to anyref
  return [ValType.anyref];
}
```

**What `mapCheckerTypeToWasmType` now handles directly:**

| Type Kind        | Handling                                                     |
| ---------------- | ------------------------------------------------------------ |
| TypeParameter    | Resolved via `ctx.currentTypeContext`, else erased to anyref |
| Number, Boolean  | Maps to ValType.i32/i64/f32/f64                              |
| Void, Never      | Maps to empty results `[]`                                   |
| Null             | Maps to `ref null none`                                      |
| ClassType        | Identity-based lookup via `resolveClassInfo()`               |
| InterfaceType    | Identity-based lookup via `resolveInterfaceStructIndex()`    |
| Array            | Recursively maps element type, gets array type index         |
| Record           | Recursively maps property types, gets record type index      |
| Tuple            | Recursively maps element types, gets tuple type index        |
| Function         | Recursively maps param/return types, gets closure type index |
| TypeAlias        | Resolves to target type recursively                          |
| Union (T\|null)  | Delegates to non-null type                                   |
| Union (literals) | Uses base type (for enums)                                   |
| Literal          | Maps to base type (i32 for numbers/booleans)                 |

**Remaining fallback:** Only truly unknown types fall through to the annotation
path. In practice, this is rarely hit since all common type kinds are handled.

**Impact:** This significantly reduces reliance on `typeToTypeAnnotation()` and
the bundled name infrastructure. Most type mappings now work via identity-based
lookups and recursive WASM type construction.

#### Step 2.6: Unified CheckerContext ✅ COMPLETED (2026-01-22)

**Goal:** Make type interning global across the entire compilation, eliminating
the root cause of identity-based lookup failures.

**Status:** COMPLETED - All 1142 tests pass with unified CheckerContext.

**Problem statement:**

The previous architecture created a new `CheckerContext` for each module:

```typescript
// OLD: In Compiler.#checkModules()
const checker = new TypeChecker(module.ast, this, module);
checker.check(); // Created new CheckerContext internally

// OLD: In TypeChecker.check()
const ctx = new CheckerContext(...); // Fresh context per module!
```

This meant:

- `ArrayExt<i32>` in the stdlib was interned as object X
- `ArrayExt<i32>` in user code was interned as object Y
- X !== Y, so identity-based lookups failed

**Solution implemented:**

Created ONE `CheckerContext` that spans all modules in the compilation:

```typescript
// NEW: In Compiler
class Compiler {
  #checkerContext: CheckerContext; // Shared across all modules

  constructor() {
    this.#checkerContext = new CheckerContext(this);
  }

  #checkModules() {
    for (const module of this.#modules) {
      // Pass shared context, switch to module's scope
      this.#checkerContext.setCurrentLibrary(module);
      const checker = new TypeChecker(module.ast, this.#checkerContext);
      checker.check();
    }
  }
}
```

**Key changes implemented:**

1. **`CheckerContext` split into per-library and global state:**
   - Global state: `#internedTypes`, `#typeIdCounter`, `#typeIds`, `preludeExports`
   - Per-library state (via `LibraryState`): `scopes`, `diagnostics`, `narrowedTypes`,
     `classStack`, `currentModule`, `currentClass`

2. **Added `setCurrentLibrary(module)` method:**
   - Switches the context's per-library state
   - Creates new `LibraryState` for each library (scopes, diagnostics, etc.)
   - Type interning remains global

3. **`TypeChecker` receives context as constructor parameter:**
   - Added `static forProgram(program, options?)` factory for standalone testing
   - Supports optional `{path?, isStdlib?}` options for test flexibility
   - `check()` uses the provided context instead of creating a new one

4. **Fixed extension class lookup for bundled ASTs:**
   - Register generic classes by original name (from `inferredType`) in addition to bundled name
   - Added specialized name lookup when identity lookup fails (for bundler name mismatch)

**Implementation steps completed:**

1. [x] Move `CheckerContext` creation from `TypeChecker.check()` to `Compiler` constructor
2. [x] Add `setCurrentLibrary(module: Module)` to `CheckerContext`
3. [x] Extract library-local state (scopes, imports) into switchable `LibraryState` interface
4. [x] Update `TypeChecker` to take `CheckerContext` as constructor parameter
5. [x] Add `TypeChecker.forProgram()` factory for standalone testing
6. [x] Update `Compiler.#checkModules()` to reuse the shared context
7. [x] Verify type interning works globally (same `ArrayExt<i32>` object everywhere)
8. [x] Remove name-based fallback from `generateMemberExpression`
9. [x] Fix extension class lookup via specialized name when identity fails

**Bundler name mismatch issue:**

The bundler preserves `inferredType` references when cloning AST nodes, but these
types have original (pre-bundled) names like `ArrayExt`, while class declarations
are renamed to `m12_ArrayExt`. This caused identity lookup to fail even with
unified type interning.

**Fix:** Two changes:

1. In `preRegisterClassStruct`: Register generic classes by their original name
   (from `templateType.name`) in addition to the bundled name
2. In `generateMemberExpression`: After `mapCheckerTypeToWasmType`, if identity
   lookup still fails, look up by specialized name using the original name to
   find the generic declaration

**Files changed:**

- `packages/compiler/src/lib/compiler.ts` - Create shared `#checkerContext`
- `packages/compiler/src/lib/checker/context.ts` - Add `LibraryState`, `setCurrentLibrary()`
- `packages/compiler/src/lib/checker/index.ts` - Take context as param, add `forProgram()`
- `packages/compiler/src/lib/codegen/classes.ts` - Register by original name
- `packages/compiler/src/lib/codegen/expressions.ts` - Add specialized name lookup fallback
- Multiple test files - Update to use `TypeChecker.forProgram()` API

#### Step 2.6b: Identity-Based Superclass Lookups

**Goal:** Enable identity-based lookups for superclass chain traversal.

**Status:** ✅ COMPLETED

**Background:**
With unified type interning (Step 2.6), we now have the foundation for identity-based
lookups. The next step toward removing the bundler is converting name-based lookups
to identity-based ones. We started with superclass lookups because:

1. They're a common pattern (~9 locations in classes.ts, 3 in expressions.ts)
2. The checker already computes `ClassType.superType`
3. Superclass chain traversal is critical for inheritance features

**Changes:**

1. **Added `superClassType` field to `ClassInfo`** (`types.ts`)
   - Stores the checker's `ClassType` for the superclass
   - Enables identity-based lookup via `ctx.getClassInfoByCheckerType(superClassType)`

2. **Updated `defineClassStruct`** (`classes.ts`)
   - Gets `classType.superType` from `decl.inferredType`
   - Tries identity-based lookup first via `ctx.getClassInfoByCheckerType()`
   - Falls back to name-based lookup for backward compatibility
   - Sets `classInfo.superClassType` for downstream use

3. **Updated `registerClassStruct` (deprecated)** (`classes.ts`)
   - Same pattern: identity-first, name-fallback
   - Sets `superClassType` in ClassInfo

4. **Updated `instantiateClass`** (`classes.ts`)
   - Gets `superClassType` from `checkerType?.superType`
   - Tries identity-based lookup first
   - Passes `superClassType` to recursive instantiation
   - Sets `superClassType` in ClassInfo

5. **Updated super call codegen** (`expressions.ts`)
   - 3 locations where `ctx.classes.get(ctx.currentClass.superClass)` was used
   - Now try `ctx.getClassInfoByCheckerType(ctx.currentClass.superClassType)` first
   - Fall back to name-based lookup for compatibility

**Validation:**

- All 1142 tests pass
- No changes to test code required

**Benefits:**

1. Superclass lookups now work without relying on bundled names
2. Foundation for removing more name-based lookups
3. Improved performance (O(1) WeakMap lookup vs string Map lookup)

**Additional changes (2026-01-22):**

6. **Updated `preRegisterClassStruct` mixin superclass lookup** (`classes.ts`)
   - In the mixin pre-registration section, try identity-based lookup via
     `classType.superType` before computing superclass name from AST
   - Falls back to name-based lookup for compatibility

**Next candidates for identity-based conversion:**

1. `ctx.classes.get(superClassName)` - Other superclass lookups (~6 remaining)
2. `ctx.genericClasses.get(baseSuperName)` - Generic class template lookups (~5)
3. `ctx.mixins.get(mixinName)` - Mixin lookups (~4)

#### Step 2.6d: Convert Generic Class and Mixin Lookups to Identity-Based

**Goal:** Convert remaining `ctx.genericClasses.get()` and `ctx.mixins.get()` calls to use
identity-based lookups via `ctx.getGenericDeclByType()` and `ctx.getMixinDeclByType()`.

**Status:** ✅ COMPLETED

**Background:**

Name-based lookups like `ctx.genericClasses.get(name)` are fragile when the bundler renames
declarations. Identity-based lookups via checker types are robust because the interned type
objects are shared regardless of naming.

**Changes:**

1. **Mixin identity infrastructure** (`context.ts`, `index.ts`):
   - Added `#mixinDeclByType: WeakMap<MixinType, MixinDeclaration>`
   - Added `setMixinDeclByType()` and `getMixinDeclByType()` methods
   - Register mixins by type at declaration processing time

2. **Generic superclass lookups in `preRegisterClassStruct`** (`classes.ts`):
   - Try `ctx.getGenericDeclByType(classType.superType)` first
   - Fall back to `ctx.genericClasses.get(baseSuperName)` for edge cases

3. **Generic superclass lookups in `defineClassStruct`** (`classes.ts`):
   - Same pattern: identity-based first, name-based fallback

4. **Generic superclass lookups in `instantiateClass`** (`classes.ts`):
   - Same pattern: identity-based first, name-based fallback

5. **Generic class lookups in `generateMemberExpression`** (`expressions.ts`):
   - Try `ctx.getGenericDeclByType(genericSource)` first
   - Fall back to name-based for bundler edge cases

**Not converted (acceptable):**

- `ctx.genericClasses.get(TypeNames.FixedArray)` in `resolveFixedArrayClass` - FixedArray is a
  well-known stdlib type, already has O(1) lookup via `wellKnownTypes.FixedArray`
- `ctx.genericClasses.has/get(className)` in `generateNewExpression` fallback path - This path
  only executes when we don't have a checker type available (edge case)
- `ctx.mixins.get(mixinName)` in classes.ts - Mixin annotations in AST don't have checker types;
  the MixinDeclaration is found by name, then identity infrastructure is available for future use

**Validation:**

- All 1142 tests pass
- No changes to test code required

#### Step 2.6c: Migrate mapType Callers to mapCheckerTypeToWasmType

**Goal:** Where AST nodes have `inferredType`, use `mapCheckerTypeToWasmType` instead
of `mapType(ctx, annotation, context)`. This enables identity-based type resolution.

**Status:** ✅ COMPLETED

**Background:**
Two functions convert types to WASM bytes:

1. `mapType(ctx, TypeAnnotation, context?)` - AST-based, name lookups, triggers instantiations
2. `mapCheckerTypeToWasmType(ctx, Type)` - Checker-type-based, identity lookups

Where AST nodes have `inferredType` from the checker, we should prefer the identity-based
path for correctness and to enable future bundler removal.

**Changes:**

1. **Field type mapping in `defineClassStruct`** (`classes.ts`)
   - Use `mapCheckerTypeToWasmType(ctx, checkerFieldType)` when `classType.fields` has the type
   - Falls back to AST-based `mapType` for compatibility

2. **Field type mapping in `registerClassStruct`** (deprecated) (`classes.ts`)
   - Same pattern: checker type first, AST fallback

3. **Method param/return types in `registerClassMethods`** (`classes.ts`)
   - Gets `checkerMethodType` from `classType.methods.get(methodName)`
   - Uses checker types for parameters and return type when available

4. **Accessor types in `registerClassMethods`** (`classes.ts`)
   - Uses checker getter type for getter return type
   - Falls back to AST annotation

5. **Extension class `onType`** (`classes.ts`)
   - Uses `mapCheckerTypeToWasmType(ctx, classType.onType)` when available
   - Falls back to AST-based path

6. **Function param/return types in `registerFunction`** (`functions.ts`)
   - Gets `FunctionType` from `decl.inferredType`
   - Uses checker types for parameters and return type

7. **Declared function types in `registerDeclaredFunction`** (`functions.ts`)
   - Same pattern: uses checker's FunctionType when available

8. **Superclass instantiation in `preRegisterClassStruct`** (`classes.ts`)
   - Passes `classType?.superType` to `instantiateClass` for identity-based registration

**`instantiateClass` calls with checker type (identity-based):**

| Location                    | Checker Type Passed    |
| --------------------------- | ---------------------- |
| `preRegisterClassStruct`    | `classType?.superType` |
| `defineClassStruct`         | `superClassType`       |
| `instantiateClass` (nested) | `superClassType`       |
| `mapCheckerTypeToWasmType`  | `classType`            |

**`instantiateClass` calls without checker type (known limitations):**

| Location                 | Reason                                     |
| ------------------------ | ------------------------------------------ |
| `mapType` (internal)     | AST-based, no checker context available    |
| `generateIsExpression`   | Box for `is` expression - codegen-internal |
| `unboxPrimitive`         | Box for unboxing - uses WASM types only    |
| `boxPrimitive`           | Box for boxing - uses WASM types only      |
| `resolveFixedArrayClass` | FixedArray wrapper - codegen-internal      |

**Why these limitations are acceptable:**

1. **Box/FixedArray are well-known types** with consistent naming across all modules
2. **Name-based lookup works correctly** for these cases (no bundler renaming conflicts)
3. **These are codegen-internal operations** that create runtime support types

**Validation:**

- All 1142 tests pass
- No changes to test code required

#### Phase 2 Status Summary (2026-01-23)

**Goal:** Migrate codegen from AST-based type mapping (`mapType`) to checker-type-based
mapping (`mapCheckerTypeToWasmType`) where possible, enabling identity-based lookups.

**Completed migrations:**

| Location         | Function                      | Change                                                        |
| ---------------- | ----------------------------- | ------------------------------------------------------------- |
| `expressions.ts` | `generateAsExpression`        | Uses `expr.inferredType` for target type of `as` casts        |
| `expressions.ts` | `generateFunctionExpression`  | Uses `expr.inferredType` (FunctionType) for params and return |
| `functions.ts`   | `inferReturnTypeFromBlock`    | Uses `decl.inferredType` for variable declarations            |
| `statements.ts`  | `generateVariableDeclaration` | Uses `decl.inferredType` for variable type                    |
| `classes.ts`     | Field/method/accessor types   | Uses checker types from `classType.fields/methods`            |
| `classes.ts`     | Extension class `onType`      | Uses `classType.onType` when available                        |
| `functions.ts`   | Function param/return types   | Uses checker's FunctionType when available                    |

**Remaining `mapType` usages (~40 calls):**

1. **Inside `mapTypeInternal` itself** - This IS the AST-based path, cannot use checker types
2. **Interface method registration** - Works with raw AST declarations
3. **Generic instantiation** (`instantiateClass`) - Uses AST-level type parameter substitution
4. **Box/unbox operations** - Codegen-internal, construct TypeAnnotation from WASM types

**Why `mapType` cannot be fully removed:**

1. **AST-only contexts:** Some codegen paths only have `TypeAnnotation` available (e.g., interface
   declarations from AST, generic type parameter substitution via `context` map)

2. **Side effects:** `mapType` triggers generic class instantiation when encountering
   `ClassName<TypeArgs>`. This is needed for AST-driven compilation paths.

3. **Codegen-internal types:** Box/unbox operations construct `TypeAnnotation` on-the-fly from
   WASM primitive types. These don't have corresponding checker types.

**`instantiateClass` checker type coverage:**

| Call Site                                 | Has checkerType? | Notes                               |
| ----------------------------------------- | ---------------- | ----------------------------------- |
| `preRegisterClassStruct` (superclass)     | ✅               | Passes `classType?.superType`       |
| `defineClassStruct` (superclass)          | ✅               | Passes `superClassType`             |
| `instantiateClass` (recursive superclass) | ✅               | Passes `superClassType`             |
| `mapCheckerTypeToWasmType`                | ✅               | Passes `classType`                  |
| `mapTypeInternal`                         | ❌               | AST path, no checker type available |
| `generateIsExpression` (Box)              | ❌               | Codegen-internal boxing             |
| `unboxPrimitive`                          | ❌               | Codegen-internal                    |
| `boxPrimitive`                            | ❌               | Codegen-internal                    |
| `resolveFixedArrayClass`                  | ❌               | Has ArrayType, not ClassType        |

**Phase assessment:**

Phase 2 is **effectively complete**. All call sites that CAN pass checker types DO pass them.
The remaining sites are architecturally constrained:

1. **AST-only paths** have no checker types by design (`mapTypeInternal`)
2. **Codegen-internal** operations work with WASM types, not checker types
3. **Type mismatch** - `FixedArray<T>` codegen receives `ArrayType`, not `ClassType`

**Next steps:**

1. **Phase 3 (optional):** Reduce AST-only paths by ensuring more codegen entry points have
   checker types. This would require architectural changes to how `FixedArray` is represented.

2. ~~**Step 2.7:** Remove the bundler.~~ **COMPLETED** (2026-01-23)

#### Step 2.7: Remove Bundler Entirely ✅ COMPLETED

**Goal:** Delete `bundler.ts` completely. All its responsibilities are handled elsewhere.

**Status:** ✅ COMPLETED (2026-01-23)

**What the Bundler currently does:**

| Responsibility                        | Replacement                              |
| ------------------------------------- | ---------------------------------------- |
| Topological sort                      | `LibraryLoader.computeGraph()` ✅        |
| Assign module prefixes (`m0_`, `m1_`) | Not needed - identity-based lookups      |
| Collect global symbols                | Not needed - CheckerContext tracks types |
| Rename identifiers                    | Not needed - identity-based lookups      |
| Flatten ASTs into single Program      | Codegen iterates over libraries directly |
| Resolve wellKnownTypes                | CheckerContext tracks these by identity  |

**Key insight:** The Bundler exists to work around the lack of proper scoping.
Once CheckerContext is unified and types are tracked by identity, there's no
need to rename symbols or flatten ASTs. Codegen can work with the original
libraries directly.

**Implementation steps:**

1. [x] Update codegen to accept `Library[]` instead of single `Program`
2. [x] Move wellKnownTypes tracking to CheckerContext (by type identity)
3. [x] Update `Compiler.compile()` to skip bundling
4. [x] Delete `bundler.ts`
5. [x] Update tests that depend on bundled names

**Implementation details:**

- Added `resolveClassByName()` to `CodegenContext` - resolves class names using the
  current module's context (local declarations and imports)
- Added `getTypeKeyWithContext()` to `classes.ts` - generates unique specialization
  keys by looking up bundled names through module-aware resolution
- Fixed `getSpecializedName()` to use identity-based lookups when `inferredType` is
  unavailable on TypeAnnotations
- `Compiler.bundle()` method removed (was dead code)
- `bundler.ts` deleted (760 lines)

**Validation:**

- All 1132+ tests pass without bundler ✅
- Codegen produces identical WASM output ✅
- Symbol names in error messages match source names ✅

**Benefits:**

1. **Simplicity:** ~760 lines of complex renaming logic removed
2. **Correctness:** No more name-based identity issues
3. **Debuggability:** Error messages use original source names
4. **Performance:** No AST rewriting pass

**Effort:** ~~2-3 hours (after Step 2.6 is complete)~~ **Completed**

**Files affected:**

- ~~Delete: `packages/compiler/src/lib/bundler.ts`~~ ✅ DELETED
- ~~Update: `packages/compiler/src/lib/compiler.ts` - Skip bundling~~ ✅ Removed `bundle()` method
- Update: `packages/compiler/src/lib/codegen/index.ts` - Accept Library[] ✅ (already done)
- Update: `packages/compiler/src/lib/checker/context.ts` - Track wellKnownTypes ✅ (already done)
- ~~Update: Tests that assert on bundled names~~ Not needed - identity-based lookups handle this

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

| File                                               | Changes                                                   |
| -------------------------------------------------- | --------------------------------------------------------- |
| ~~`packages/compiler/src/lib/bundler.ts`~~         | ✅ **DELETED** (2026-01-23)                               |
| `packages/compiler/src/lib/compiler.ts`            | ✅ Removed `bundle()` method, uses `compile()` only       |
| `packages/compiler/src/lib/checker/context.ts`     | Refactor for single-pass + topological ordering           |
| `packages/compiler/src/lib/checker/types.ts`       | Simplify type comparison                                  |
| `packages/compiler/src/lib/checker/expressions.ts` | Populate SemanticContext                                  |
| `packages/compiler/src/lib/checker/statements.ts`  | Populate SemanticContext                                  |
| `packages/compiler/src/lib/checker/classes.ts`     | Populate SemanticContext                                  |
| `packages/compiler/src/lib/codegen/index.ts`       | ✅ Accepts `Module[]`, uses struct indices                |
| `packages/compiler/src/lib/codegen/context.ts`     | ✅ Added `resolveClassByName()` for module-aware lookups  |
| `packages/compiler/src/lib/codegen/classes.ts`     | ✅ Added `getTypeKeyWithContext()` for identity-based keys|
| `packages/compiler/src/lib/ast.ts`                 | Mark fields readonly (gradual)                            |

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

- [ ] **Bundler is deleted** - not deprecated, fully removed
- [x] LibraryLoader exists and works ✅
- [x] Type-checking is single-pass _(topological ordering already implemented)_
- [ ] Types are registered in dependency order
- [x] All existing tests pass ✅
- [ ] No `_checked` flags on types
- [x] **Unified CheckerContext** - one context per compilation, not per module ✅
- [x] **Type interning is global** - same type object everywhere ✅
- [x] **No name-based lookup fallbacks in generateMemberExpression** ✅ (specialized name lookup still needed for bundler name mismatch)
- [ ] **Codegen works on Library[]** - no flattened Program AST

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
9. **Root cause of name-based lookups:** Each module gets its own `CheckerContext`
   with separate type interning caches. This is why `ArrayExt<i32>` from stdlib
   is a different object than `ArrayExt<i32>` from user code. The fix is to use
   ONE `CheckerContext` for the entire compilation (Step 2.6).
10. **Libraries are namespaces:** A Program should be _composed_ of libraries,
    not flattened by a bundler. The bundler's symbol renaming (`m0_String`) is a
    workaround for not having proper scoping. With unified CheckerContext and
    identity-based lookups, the bundler becomes unnecessary.
11. **Delete the bundler:** The goal is to remove `bundler.ts` entirely (Step 2.7),
    not just disable parts of it. Once types are tracked by identity, there's
    nothing left for the bundler to do.

## Type Interning (Implemented - Per-Module)

### Problem

The specialization registry for generic types used string keys (e.g.,
`"Box|i32"`) instead of identity-based lookups. This was because the checker
created **new** `ClassType` objects for each generic instantiation site:

```typescript
// These WERE different ClassType objects in the checker
const x: Box<i32> = ...;  // Creates ClassType { name: 'Box', typeArguments: [I32] }
const y: Box<i32> = ...;  // Creates a NEW ClassType { name: 'Box', typeArguments: [I32] }
```

Both should map to the same WASM struct type, but since they were different
objects, we couldn't use identity-based lookups. Instead, we computed string keys
via `getCheckerTypeKey()` and used those for registry lookups.

### Solution: Type Interning in CheckerContext

**Implementation:** Identical type instantiations now share the same object reference.

**Key changes:**

1. Added interning cache to `CheckerContext`:

   ```typescript
   class CheckerContext {
     // Cache for interned generic instantiations
     #internedTypes = new Map<string, Type>();

     // Unique IDs for types (for computing interning keys)
     #typeIdCounter = 0;
     #typeIds = new WeakMap<Type, number>();
   }
   ```

2. Generic instantiation now checks the cache first:

   ```typescript
   function instantiateGenericClass(
     template: ClassType,
     args: Type[],
     ctx: CheckerContext,
   ): ClassType {
     // Check cache first
     const cached = ctx.getInternedClass(template, args);
     if (cached) return cached;

     // Create new instance
     const instance = createInstance(template, args);

     // Store in cache
     ctx.internClass(template, args, instance);
     return instance;
   }
   ```

3. The interning key uses type IDs (not names) for stable identity:

   ```typescript
   computeInstantiationKey('C', genericSource, typeArguments);
   // Returns: "C:123<N:i32>" where 123 is the type ID of Box
   ```

**Files changed:**

- `packages/compiler/src/lib/checker/context.ts` - Added interning cache and helper methods
- `packages/compiler/src/lib/checker/types.ts` - Updated `instantiateGenericClass/Interface/Mixin`
- `packages/compiler/src/lib/types.ts` - Added `genericSource` to `MixinType`

### Limitation: Per-Module Scope

**IMPORTANT:** Type interning currently only works **within a single module**.
Each module gets its own `CheckerContext`, so types interned in module A are
different objects from types interned in module B:

```
Module A (stdlib): Box<i32> → interned as object X in A's CheckerContext
Module B (user):   Box<i32> → interned as object Y in B's CheckerContext
X !== Y (different objects!)
```

This is why identity-based lookups fail in codegen for cross-module types.
The fix is to use a **unified CheckerContext** for the entire compilation
(see Step 2.6).

### Codegen Migration ✅ COMPLETED

With type interning in place, codegen now uses identity-based lookups:

```typescript
// Old: string key lookup (REMOVED)
// const key = getCheckerTypeKey(classType, ctx);
// const classInfo = ctx.findGenericSpecialization(key);

// New: identity lookup using WeakMap
const classInfo = ctx.getClassInfoByCheckerType(classType);
```

**Removed infrastructure:**

- ~~`getCheckerTypeKey()` in `classes.ts`~~ - String key generation for checker types
- ~~`computeSpecializationKey()` in `classes.ts`~~ - Built registry keys
- ~~`containsTypeParameter()` in `classes.ts`~~ - Helper for type parameter detection
- ~~`#genericSpecializations` Map in `context.ts`~~ - String-keyed registry
- ~~`registerGenericSpecialization()` / `findGenericSpecialization()`~~ - String-based methods

**Current infrastructure:**

- `#classInfoByType = new WeakMap<ClassType, ClassInfo>()` - Identity-based lookup
- `registerClassInfoByType()` / `getClassInfoByCheckerType()` - Identity-based methods
- `resolveClassInfo()` - Follows `genericSource` chain for identity lookup

**Benefits achieved:**

- Eliminates fragile string-based type identity
- Reduces memory (shared type objects via interning)
- Simple O(1) WeakMap lookups in codegen
- ~200 lines of code removed
- Aligns with how mature compilers (TypeScript, Rust) handle type identity

## Future Direction: Late Type Lowering

### Problem: Early Conversion to WASM Bytes

Currently, codegen converts checker types to WASM byte encodings (`number[]`)
early in the pipeline via `mapType()`. These byte arrays are then passed around
and stored in `ClassInfo`, `InterfaceInfo`, method signatures, etc.

This creates a problem: when we need to know _which_ type a WASM encoding
represents (e.g., for return type boxing in trampolines), we must reverse-lookup
from struct index to type via `getInterfaceFromTypeIndex()` or similar.

**Example:** In `generateTrampoline`, we have `interfaceResults[0]` (WASM bytes
for a return type). To box the return value into an interface fat pointer, we
need to find the `InterfaceInfo`. But we only have bytes, so we decode the
struct index and iterate through all interfaces to find a match.

### Proposed Solution: Keep Checker Types Through Codegen

Instead of converting to WASM bytes early, keep checker `Type` objects through
the codegen pipeline and only convert at emit time:

**Current (early lowering):**

```
Checker Type → mapType() → number[] → stored/passed → emit
```

**Proposed (late lowering):**

```
Checker Type → stored/passed → emit time: Type → WASM bytes
```

### What Would Change

1. **Type storage:** `ClassInfo`, `InterfaceInfo` method/field types would store
   `Type` instead of `number[]`
2. **`mapType()` moves to emit:** Becomes `emitType(type: Type): number[]` called
   only when writing WASM output
3. **Locals and params:** Would reference `Type` objects, not byte arrays
4. **Emitter interface:** Would need `typeToWasm(type: Type): number[]`

### Benefits

1. **Identity preserved:** No need for `getInterfaceFromTypeIndex()` - we always
   have the `Type` object
2. **Multiple backends:** WAT emitter, debug output, or other targets could
   reuse the same codegen with different `typeToWasm` implementations
3. **Simpler reasoning:** Types are first-class throughout, not encoded bytes
4. **Better error messages:** We know what type something is, not just its encoding
5. **No information loss:** Generic type arguments, names, etc. all preserved

### Challenges

1. **Large refactor:** Touches most of codegen - `ClassInfo`, `InterfaceInfo`,
   method registration, local declarations, etc.
2. **Synthetic types:** Some types are created during codegen (e.g., closure
   contexts). Need to decide if these become `Type` objects too.
3. **WASM-specific layout:** Struct field offsets still need early computation,
   but this can be separate from type encoding.

### Enabling WAT Emit

A WAT emitter could implement `typeToWat(type: Type): string` and reuse all
codegen logic. Currently, a WAT emitter would need to either decode `number[]`
back to understand types, or duplicate all mapping logic.

### Implementation Sketch

```typescript
// In ClassInfo (proposed)
interface ClassInfo {
  name: string;
  structTypeIndex: number;
  fields: Map<string, {index: number; type: Type}>; // Type, not number[]
  methods: Map<
    string,
    {
      index: number;
      returnType: Type; // Type, not number[]
      paramTypes: Type[]; // Type[], not number[][]
    }
  >;
}

// In emitter (proposed)
function emitType(ctx: EmitContext, type: Type): number[] {
  if (type.kind === TypeKind.Class) {
    const structIndex = ctx.getClassStructIndex(type as ClassType);
    return [ValType.ref_null, ...encodeSignedLEB128(structIndex)];
  }
  // ... handle other type kinds
}
```

### Status

This is tracked as a future direction. The current identity-based lookup
infrastructure (WeakMaps keyed by checker types) is a step toward this goal -
it establishes the pattern of using checker types as keys. The remaining work
would be to stop converting to `number[]` early and instead preserve `Type`
objects through the pipeline.

## Open Questions

1. ~~Should we support truly independent module checking (e.g., for LSP hover on
   hover on an imported type), or is full-program checking acceptable?~~
   **RESOLVED:** Full-program checking with unified CheckerContext. LSP can
   still work by caching the checked state and only re-checking changed files.
2. Do we need WAT emit for debugging? If so, we can add qualified name generation
   at emit time without bundler renaming (e.g., `zena_string_String` for WAT readability).
3. Should AST parsing also be lazy (only parse modules needed for the program),
   or always parse eagerly?
4. How should we handle stdlib imports? A hardcoded builtin loader or virtual
   filesystem?
5. ~~**After Step 2.6:** Once CheckerContext is unified, should we remove the
   bundler entirely, or keep it for WAT emit / debugging output?~~
   **RESOLVED:** Remove bundler entirely. WAT emit (if needed) can generate
   qualified names at emit time without AST mutation.

## References

- [Current Compiler Architecture](./compiler-architecture.md)
- [TypeScript Design: Program &
  TypeChecker](https://github.com/microsoft/TypeScript/wiki/Architectural-Overview)
- [Rust Compiler: Parallel Query
  System](https://rustc-dev-guide.rust-lang.org/query.html)
