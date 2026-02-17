# Separate Compilation and Zena IR

This document describes a design for separate compilation in Zena, enabling
parallel builds, package caching, and cross-version compatibility.

## Goals

1. **Parallel Compilation**: Compile independent packages concurrently.
2. **Package Caching**: Reuse compilation work across builds and projects.
3. **Cross-Version Compatibility**: Libraries compiled with newer Zena syntax
   can be used by projects with older toolchains (within IR compatibility).

## Non-Goals

- Incremental compilation within a single file (out of scope for now)
- Hot code reloading
- Source-level compatibility across Zena versions (syntax can change)

## Current Model

Today, Zena compiles everything in a single pass:

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  pkg-a.zena │   │  pkg-b.zena │   │  main.zena  │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────────────┬┴─────────────────┘
                        ▼
                 ┌─────────────┐
                 │   Compiler  │  (sequential: parse → check → codegen)
                 └──────┬──────┘
                        ▼
                 ┌─────────────┐
                 │ output.wasm │
                 └─────────────┘
```

**Problems**:
- Re-parses and re-checks all dependencies every build
- No parallelism across packages
- Standard library checked repeatedly across projects

## Proposed Model

Split compilation into two phases:

```
Phase 1: Compile (parallelizable, cacheable)
┌─────────────┐        ┌─────────────┐        ┌─────────────┐
│  pkg-a.zena │        │  pkg-b.zena │        │  main.zena  │
└──────┬──────┘        └──────┬──────┘        └──────┬──────┘
       │                      │                      │
       ▼                      ▼                      ▼
┌─────────────┐        ┌─────────────┐        ┌─────────────┐
│ Parse+Check │        │ Parse+Check │        │ Parse+Check │
└──────┬──────┘        └──────┬──────┘        └──────┬──────┘
       │   (parallel)         │   (parallel)         │
       ▼                      ▼                      ▼
┌─────────────┐        ┌─────────────┐        ┌─────────────┐
│  pkg-a.zir  │        │  pkg-b.zir  │        │  main.zir   │
└──────┬──────┘        └──────┬──────┘        └──────┬──────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              ▼
Phase 2: Link (whole-program optimization)
                       ┌─────────────┐
                       │   Linker    │
                       └──────┬──────┘
                              ▼
                       ┌─────────────┐
                       │ output.wasm │
                       └─────────────┘
```

## Zena IR Format (`.zir`)

### Overview

The `.zir` file is a binary format containing:
1. **Checked AST**: Type-annotated syntax tree
2. **Type Definitions**: All types defined in this module
3. **Module Summary**: Exports, imports, class hierarchy (enables link-time WPO)

### File Structure

```
┌────────────────────────────────────────┐
│ Header                                 │
│   magic: "ZIR\0"                       │
│   ir_version: u16                      │
│   zena_version: string (informational) │
│   source_hash: [u8; 32]                │
│   flags: u32                           │
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│ Module Summary (for fast linking)      │
│   exports: [ExportEntry]               │
│   imports: [ImportEntry]               │
│   class_summaries: [ClassSummary]      │
│   interface_impls: [ImplSummary]       │
│   generic_defs: [GenericSummary]       │
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│ Type Section                           │
│   type_defs: [TypeDef]                 │
│   type_refs: [TypeRef]                 │
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│ Declaration Section                    │
│   declarations: [IRDeclaration]        │
│   (classes, functions, variables)      │
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│ Body Section                           │
│   function_bodies: [IRBody]            │
│   (executable code, post-desugar)      │
└────────────────────────────────────────┘
```

### Module Summary

The summary enables whole-program optimization without re-parsing:

```typescript
interface ModuleSummary {
  // Exported declarations with their types
  exports: ExportEntry[];
  
  // Imported modules and what's used from each
  imports: ImportEntry[];
  
  // Class hierarchy info (for devirtualization)
  classes: ClassSummary[];
  
  // Which classes implement which interfaces (for sealing)
  interfaceImpls: ImplSummary[];
  
  // Generic definitions (for cross-module monomorphization)
  generics: GenericSummary[];
}

interface ClassSummary {
  name: string;
  superClass: string | null;
  interfaces: string[];
  isFinal: boolean;
  methods: MethodSummary[];
}

interface MethodSummary {
  name: string;
  signature: TypeRef;
  isFinal: boolean;
  isOverride: boolean;
}
```

### Type Representation

Types are represented symbolically to enable cross-module references:

```typescript
// Types are identified by path, not index
type TypeRef = 
  | { kind: 'primitive', name: 'i32' | 'f32' | 'bool' | 'string' | ... }
  | { kind: 'class', module: string, name: string, typeArgs?: TypeRef[] }
  | { kind: 'interface', module: string, name: string, typeArgs?: TypeRef[] }
  | { kind: 'function', params: TypeRef[], returns: TypeRef }
  | { kind: 'array', element: TypeRef }
  | { kind: 'tuple', elements: TypeRef[] }
  | { kind: 'union', members: TypeRef[] }
  | { kind: 'typeParam', name: string, bound?: TypeRef };
```

### IR Declarations

Declarations are stored in a normalized form:

```typescript
interface IRClassDecl {
  kind: 'class';
  name: string;
  typeParams: TypeParamDef[];
  superClass: TypeRef | null;
  interfaces: TypeRef[];
  fields: IRFieldDef[];
  methods: IRMethodDef[];
  isFinal: boolean;
  isExported: boolean;
}

interface IRFunctionDecl {
  kind: 'function';
  name: string;
  typeParams: TypeParamDef[];
  params: IRParam[];
  returnType: TypeRef;
  body: IRBody;
  isExported: boolean;
}
```

### IR Body (Expressions)

Function bodies use a simplified IR that's lower-level than surface syntax:

```typescript
type IRExpr =
  | { kind: 'const', type: TypeRef, value: number | string | boolean }
  | { kind: 'local.get', index: number }
  | { kind: 'local.set', index: number, value: IRExpr }
  | { kind: 'call', target: IRExpr, args: IRExpr[] }
  | { kind: 'static_call', module: string, name: string, args: IRExpr[] }
  | { kind: 'method_call', receiver: IRExpr, method: string, args: IRExpr[] }
  | { kind: 'field_get', receiver: IRExpr, field: string }
  | { kind: 'field_set', receiver: IRExpr, field: string, value: IRExpr }
  | { kind: 'new', class: TypeRef, args: IRExpr[] }
  | { kind: 'if', cond: IRExpr, then: IRExpr, else: IRExpr }
  | { kind: 'block', stmts: IRExpr[], result: IRExpr }
  | { kind: 'loop', body: IRExpr }
  | { kind: 'break', label?: string }
  | { kind: 'return', value?: IRExpr }
  | { kind: 'cast', value: IRExpr, targetType: TypeRef }
  | { kind: 'instanceof', value: IRExpr, testType: TypeRef };
```

Key simplifications from surface syntax:
- No operator overloading (resolved to method calls)
- No pattern matching (lowered to if/cast chains)
- No for-in loops (lowered to iterator protocol calls)
- No string interpolation (lowered to concatenation)
- Explicit casts where needed

## IR Version Compatibility

### Version Numbering

```
IR_VERSION = MAJOR.MINOR

MAJOR: Breaking changes (old linkers cannot read new IR)
MINOR: Backward-compatible additions (old linkers skip unknown sections)
```

### Compatibility Rules

1. **Same MAJOR, any MINOR**: Always compatible
2. **Different MAJOR**: Linker must support both versions explicitly

### What Changes Break Compatibility

**Breaking (MAJOR bump)**:
- Changing existing IR node structure
- Removing IR node types
- Changing type representation
- Changing serialization format

**Non-breaking (MINOR bump)**:
- Adding new IR node types
- Adding optional fields to existing nodes
- Adding new sections (old linkers skip them)
- New optimization hints

### Forward Compatibility Strategy

New features that require IR changes:
1. Add behind a flag initially (doesn't affect IR)
2. When stabilized, add to IR as MINOR bump
3. If fundamentally incompatible, schedule for next MAJOR

Example: Adding a new `match` expression could first be lowered to if/cast
chains in IR. Later, a native `match` IR node could be added (MINOR) for
better optimization, while still accepting the lowered form.

## Compilation Pipeline

### Phase 1: Source → IR

Each package compiles independently. Dependencies only need their `.zir` summary.

```typescript
async function compilePackage(
  sourcePath: string,
  dependencies: Map<string, ZirSummary>,
): Promise<ZirFile> {
  // 1. Parse source
  const ast = parse(readFile(sourcePath));
  
  // 2. Resolve imports using dependency summaries
  const resolved = resolveImports(ast, dependencies);
  
  // 3. Type check
  const checked = typeCheck(resolved);
  
  // 4. Lower to IR
  const ir = lowerToIR(checked);
  
  // 5. Generate summary
  const summary = extractSummary(ir);
  
  return { ir, summary };
}
```

**Parallelization**: Packages with no interdependencies compile in parallel.
The dependency graph determines the schedule:

```
stdlib (no deps)     ─┐
                      ├─→ pkg-a (imports stdlib)  ─┐
                      ├─→ pkg-b (imports stdlib)  ─┼─→ main (imports a, b)
                      └─→ pkg-c (imports stdlib)  ─┘
```

### Phase 2: IR → WASM (Linking)

The linker performs whole-program optimization:

```typescript
function link(
  entryPoint: ZirFile,
  dependencies: Map<string, ZirFile>,
  options: LinkOptions,
): Uint8Array {
  // 1. Build full program IR
  const program = merge(entryPoint, dependencies);
  
  // 2. Whole-program analysis (using summaries)
  const analysis = analyzeProgram(program);
  
  // 3. Optimizations
  if (options.dce) program = eliminateDeadCode(program, analysis);
  if (options.devirtualize) program = devirtualize(program, analysis);
  if (options.inline) program = inlineFunctions(program, analysis);
  
  // 4. Monomorphize generics
  program = monomorphize(program);
  
  // 5. Generate WASM
  return generateWasm(program);
}
```

### Link-Time Optimizations Enabled by Summaries

**Dead Code Elimination**:
```
From summaries:
  main imports: [foo] from pkg-a
  pkg-a exports: [foo, bar, baz]

→ bar, baz are dead → eliminate from output
```

**Devirtualization**:
```
From summaries:
  Animal.speak() overridden by: [Dog, Cat]
  Dog: isFinal = true
  Cat: only in pkg-c (not linked)

→ If only pkg-a used: Animal.speak() has single impl → devirtualize
```

**Cross-Module Inlining**:
```
From IR bodies:
  pkg-a defines: add(a, b) => a + b  (small, pure)
  main calls: add(x, y)

→ Inline add() at call site
```

## Caching Strategy

### Cache Location

```
~/.zena/cache/
  ir/
    v1/                          # IR version
      stdlib@0.1.0/              # Package + version
        abc123.zir               # Hash of source
        abc123.meta              # Build metadata
      my-pkg@0.2.0/
        def456.zir
```

### Cache Key Computation

```typescript
function cacheKey(pkg: Package): string {
  return hash([
    pkg.sourceHash,      // Hash of all source files
    IR_VERSION,          // IR format version
    pkg.zenaVersion,     // Compiler version (for major changes)
    pkg.dependencies,    // Hashes of direct dependencies
  ]);
}
```

### Cache Invalidation

A cached `.zir` is valid if:
1. Source hash matches
2. IR version is compatible
3. All dependency cache keys match (transitive)

### Shared System Cache

The standard library can be cached system-wide:

```bash
# Pre-compile stdlib on install
zena cache warm-stdlib

# Creates:
# ~/.zena/cache/ir/v1/stdlib@0.1.0/...
```

Projects automatically use the cached stdlib.

## CLI Interface

### New Commands

```bash
# Compile to IR without linking
zena compile src/lib.zena -o lib.zir

# Link IR files to WASM
zena link main.zir pkg-a.zir pkg-b.zir -o output.wasm

# Full build (compile + link, uses cache)
zena build src/main.zena -o output.wasm

# Show cache status
zena cache status

# Clear cache
zena cache clear

# Warm cache for dependencies
zena cache warm
```

### Build with Parallelism

```bash
# Parallel compilation (default: CPU count)
zena build src/main.zena -o out.wasm --parallel

# Limit parallelism
zena build src/main.zena -o out.wasm --parallel=4

# Sequential (for debugging)
zena build src/main.zena -o out.wasm --parallel=1
```

## Implementation Plan

### Phase 1: IR Format Definition
- [ ] Define IR data structures
- [ ] Implement serialization/deserialization
- [ ] Add `zena compile --emit-ir` flag
- [ ] Add `zena link` command (single-threaded)

### Phase 2: Summary-Based Checking
- [ ] Generate module summaries during compilation
- [ ] Use summaries for dependency type checking
- [ ] Validate summary-only builds match full builds

### Phase 3: Caching
- [ ] Implement cache key computation
- [ ] Add cache storage/retrieval
- [ ] Cache invalidation logic
- [ ] CLI cache commands

### Phase 4: Parallelization
- [ ] Dependency graph analysis
- [ ] Worker pool for compilation
- [ ] Progress reporting

### Phase 5: Link-Time Optimizations
- [ ] DCE using summaries
- [ ] Devirtualization using class summaries
- [ ] Cross-module inlining

## Open Questions

1. **IR Stability Timeline**: When do we commit to IR v1.0? After language
   stabilizes?

2. **Generic Monomorphization**: Should monomorphized instances be cached
   separately? (e.g., `Box<i32>` used by many packages)

3. **Source Maps**: Should IR include source locations for debugging? How does
   this interact with caching?

4. **Incremental Within Package**: Can we extend this to file-level caching
   within a large package?

5. **Distributed Caching**: Support for shared caches in CI/CD? (like Cargo's
   sccache)

## Alternatives Considered

### Alternative A: Use WASM as IR

Store partially-linked WASM modules with sidecar metadata.

**Pros**: Reuses existing format, WASM tools work on it.
**Cons**: WASM loses high-level info (generics, types), harder to optimize.

### Alternative B: Textual IR

Human-readable IR format (like LLVM IR text format).

**Pros**: Debuggable, diffable.
**Cons**: Slower to parse, larger files.

### Alternative C: Delta Compilation

Store diffs from a baseline instead of full IR.

**Pros**: Smaller cache for minor changes.
**Cons**: Complex, baseline management issues.

## References

- [Rust's Incremental Compilation](https://blog.rust-lang.org/2016/09/08/incremental-compilation.html)
- [Go Build Cache](https://go.dev/doc/go1.10#build)
- [Swift's Module Stability](https://www.swift.org/blog/library-evolution/)
- [LLVM Bitcode](https://llvm.org/docs/BitCodeFormat.html)
