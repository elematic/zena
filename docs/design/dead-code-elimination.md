# Dead Code Elimination

This document describes the design for dead code elimination (DCE) in the Zena
compiler.

**Status**: ✅ Implemented (declaration-level DCE)

> ⚠️ The sizes below were measured on the TypeScript bootstrap compiler,
> which has since been deleted, and its `CodegenOptions`-based API no
> longer exists. On the self-hosted compiler the same minimal program is
> two orders of magnitude larger, for reasons that are not DCE's:
> see [binary-size.md](binary-size.md) for the current measurements and
> the reachability leaks behind them.

## Goals

1. **Minimal Binary Size**: The emitted WASM should only include code that is
   actually used. A minimal program like `export let main = () => 42;` should
   not include any standard library code.

2. **Eliminate Unused Declarations**: Remove functions, classes, interfaces,
   mixins, and variables that are never referenced.

3. **Method-Level DCE**: Eventually eliminate individual class methods that are
   never called (more aggressive optimization).

4. **Foundation for Linting**: The usage analysis infrastructure supports
   linting features like "unused variable" warnings.

5. **Foundation for LSP**: The same analysis enables "find all references" and
   "find all call sites" in the language server.

## Results

With DCE enabled, binary sizes are dramatically reduced:

| Program                            | Without DCE | With DCE  | Reduction |
| ---------------------------------- | ----------- | --------- | --------- |
| `export let main = () => 42;`      | 1957 bytes  | 175 bytes | 91%       |
| `export let main = () => "hello";` | 1971 bytes  | 235 bytes | 88%       |
| Program with unused function       | 1970 bytes  | 175 bytes | 91%       |
| Program with unused class          | 2095 bytes  | 175 bytes | 92%       |

## Usage

DCE is controlled by the `dce` option in `CodegenOptions`:

```typescript
const generator = new CodeGenerator(
  modules,
  entryPoint,
  semanticContext,
  checkerContext,
  {dce: true}, // Enable dead code elimination
);
const wasm = generator.generate();
```

## Design Principles

### Side Effect Handling

Zena already doesn't have top-level statements (only declarations), which
simplifies DCE. However, side effects can occur in:

1. **Variable Initializers**: `let x = someFunction();` - the initializer might
   have side effects
2. **Static Field Initializers**: Similar to variable initializers
3. **Future: Top-level Statements**: If we add "script mode" with top-level
   statements

For the standard library, we can guarantee no side effects in initializers. We
can mark modules or declarations as "pure" (no side effects) to enable
aggressive DCE:

```zena
@pure  // Module-level decorator (future)
export class String { ... }
```

For now, we treat all stdlib modules as pure by default.

### Scope of Analysis

DCE operates at different granularities:

| Scope   | What can be eliminated             | Analysis complexity   |
| ------- | ---------------------------------- | --------------------- |
| Local   | Unused local variables             | Within function scope |
| Module  | Unexported private functions       | Within module         |
| Program | Unreferenced exported declarations | Whole program         |
| Method  | Unused class methods               | Requires call graph   |

We start with module and program-level DCE, which provides the biggest wins for
binary size.

## Architecture

### Usage Analysis Pass

The core of DCE is a **usage analysis pass** that determines which declarations
are "live" (reachable from the entry point).

```
┌─────────────────┐
│   Entry Point   │
│   Exports       │
└────────┬────────┘
         │ mark as used
         ▼
┌─────────────────┐
│  Usage Analyzer │◄──── AST Visitor
│   (worklist)    │
└────────┬────────┘
         │ propagate
         ▼
┌─────────────────┐
│ UsageInfo Map   │ Declaration → {isUsed, references}
└─────────────────┘
```

The analysis is a **worklist algorithm**:

1. Start with entry point exports (these are roots)
2. For each used declaration, find what it references
3. Mark those references as used (add to worklist if newly marked)
4. Repeat until worklist is empty

### AST Visitor Infrastructure

We need a general-purpose AST visitor to traverse the tree. This is useful for:

- Usage analysis (DCE)
- Capture analysis (closures)
- Linting passes
- Code transformations

```typescript
// packages/compiler/src/lib/visitor.ts

export interface Visitor<T = void> {
  // Statements
  visitVariableDeclaration?(node: VariableDeclaration, context: T): void;
  visitClassDeclaration?(node: ClassDeclaration, context: T): void;
  visitInterfaceDeclaration?(node: InterfaceDeclaration, context: T): void;
  visitMixinDeclaration?(node: MixinDeclaration, context: T): void;
  visitFunctionExpression?(node: FunctionExpression, context: T): void;
  // ... etc

  // Expressions
  visitIdentifier?(node: Identifier, context: T): void;
  visitCallExpression?(node: CallExpression, context: T): void;
  visitNewExpression?(node: NewExpression, context: T): void;
  visitMemberExpression?(node: MemberExpression, context: T): void;
  // ... etc
}

export function visit<T>(node: Node, visitor: Visitor<T>, context: T): void;
export function visitChildren<T>(
  node: Node,
  visitor: Visitor<T>,
  context: T,
): void;
```

### Usage Information Storage

We store usage information in the `SemanticContext` (shared between checker and
codegen):

```typescript
interface UsageInfo {
  /** The declaration is reachable from entry point exports */
  isUsed: boolean;

  /** All sites that reference this declaration (optional, for LSP) */
  references?: Set<Node>;
}

// In SemanticContext
usageInfo: WeakMap<Declaration, UsageInfo>;
```

Using a `WeakMap` keyed by declaration node allows O(1) lookup and doesn't
prevent GC.

### Query-Based Architecture (Future)

For LSP features, we want queries like:

1. **hasAnyReferences(decl)**: Does this declaration have any uses? (for
   DCE/linting)
2. **findAllReferences(decl)**: Return all usage sites (for LSP "find
   references")

These can share implementation:

```typescript
// Streaming query that can abort early
function* findReferences(decl: Declaration, program: Program): Generator<Node> {
  for (const module of program.modules.values()) {
    for (const ref of findReferencesInModule(decl, module)) {
      yield ref;
    }
  }
}

// DCE query - aborts after first reference
function hasAnyReferences(decl: Declaration, program: Program): boolean {
  for (const _ of findReferences(decl, program)) {
    return true; // Found at least one
  }
  return false;
}

// LSP query - collects all
function findAllReferences(decl: Declaration, program: Program): Node[] {
  return [...findReferences(decl, program)];
}
```

For the batch usage analysis pass (whole-program DCE), we still prefer a single
traversal that marks all declarations at once, rather than per-declaration
queries.

## Syntax-Implied Usages

Some types are implicitly used when certain syntax appears:

| Syntax                 | Implies usage of                 |
| ---------------------- | -------------------------------- |
| `"hello"` or `'hello'` | `String` class                   |
| `\`template ${x}\``    | `String`, `TemplateStringsArray` |
| `[1, 2, 3]`            | `FixedArray` class               |
| `[1, 2]`               | Tuple type (no class)            |
| `{x: 1}`               | Record type (no class)           |
| `1..4`                 | `BoundedRange` class             |
| `1..`                  | `FromRange` class                |
| `..4`                  | `ToRange` class                  |
| `..`                   | `FullRange` class                |
| `throw e`              | `Error` class                    |

The usage analyzer must mark these types as used when their corresponding syntax
is encountered.

## Implementation Plan

### Phase 1: AST Visitor Infrastructure ✅

Create a generic visitor that can traverse the AST. This replaces ad-hoc
traversals like in `captures.ts`.

**Implemented in**: `packages/compiler/src/lib/visitor.ts`

### Phase 2: Declaration Usage Analysis ✅

Implement the worklist-based usage analyzer:

1. Collect all declarations from the program
2. Mark entry point exports as roots
3. Traverse each root to find references
4. Mark referenced declarations as used
5. Add newly-used declarations to worklist

**Implemented in**: `packages/compiler/src/lib/analysis/usage.ts`

Key implementation details:

- Uses `SemanticContext.getResolvedBinding()` for accurate identifier resolution
- Maps `FunctionExpression` back to parent `VariableDeclaration` for correct
  function declaration tracking
- Pre-marks all indexed declarations as unused, then marks used ones via
  worklist
- Supports stdlib implicit dependencies via `ImplicitStdlibTypes` handling

### Phase 3: Codegen Integration ✅

Modify the code generator to skip declarations marked as unused:

```typescript
// In codegen/index.ts
for (const statement of statements) {
  // Skip unused declarations
  if (!this.#isUsed(statement as Declaration)) {
    continue;
  }
  // ... generate code
}
```

**Implemented in**: `packages/compiler/src/lib/codegen/index.ts`

The `#isUsed()` method returns `true` if:

- DCE is disabled (`options.dce === false`)
- The declaration is marked as used by the usage analysis

### Class Usage Analysis & Static VTables (Future)

The usage analyzer will categorize how a class is referenced to ensure we emit
zero overhead for advanced features like "Classes as Values", categorizing them
into three tiers:

1. **Tier 1: Used as a Type**
   - _Usage_: `let x: Array<i32>;`
   - _Effect_: No runtime code emitted. The class is purely used for static type
     checking.
2. **Tier 2: Used as a Namespace (Direct Static Call)**
   - _Usage_: `Array.create(10)`
   - _Effect_: Marks only `Array.create` as a used function. Call sites
     statically dispatch to it. **No Static VTable is emitted.**
3. **Tier 3: Used as a Value**
   - _Usage_: `let factory: ArrayBuilder = Array;`
   - _Effect_: The class is used in an expression position. The compiler will
     evaluate required interfaces and emit a **Static VTable** (a global Wasm
     struct containing function references for its static methods).

### Phase 4: Method-Level DCE & Global VTable Pruning (Future)

More aggressive optimization that eliminates individual methods and prunes
VTables system-wide:

1. **Precise Call Graph Tracking**: Build a call graph tracking exact virtual
   and static interface method invocations (e.g., tracking
   `InterfaceMethodCall(ArrayBuilder::create)`).
2. **Global VTable Pruning**: Generate VTables (both instance VTables and Static
   VTables) containing _only_ the methods actually invoked in the program.
3. **Eliminates Dead Abstractions**: If a class implements an interface with 10
   static methods, but the entire program only ever invokes `create()` via
   interface dispatch, the compiler will shrink the `ArrayBuilder` interface
   definition and the resulting Wasm Static VTable struct to contain just
   `create()`. The uncalled static methods will be completely omitted.

## Escape Analysis Considerations

Functions in Zena are first-class values (closures). A function reference can
be:

1. Called directly: `foo()`
2. Passed as callback: `arr.map(foo)`
3. Stored in data structure: `let fns = [foo, bar]`
4. Returned from function: `const makeFn = () => foo`

For sound DCE without escape analysis, we must treat **any reference** to a
function as a use. This is conservative but correct.

With escape analysis, we could determine if a function reference escapes its
immediate context. This would enable more aggressive elimination but adds
complexity.

For constructors, the same applies: `new Foo()` uses `Foo`, but `const C = Foo;
new C()` also uses `Foo`.

## Interaction with Generics

Generic declarations are templates, not actual runtime code. The usage analysis
should:

1. Track usage of the generic template (e.g., `class Box<T>`)
2. Track usage of each instantiation (e.g., `Box<i32>`, `Box<String>`)
3. Only emit instantiations that are actually used

This aligns with how codegen already handles generics - only instantiated types
generate WASM code.

## Diagnostics

The usage analysis enables new diagnostic messages:

| Code | Message                   | Severity |
| ---- | ------------------------- | -------- |
| W001 | Unused variable '{name}'  | Warning  |
| W002 | Unused function '{name}'  | Warning  |
| W003 | Unused class '{name}'     | Warning  |
| W004 | Unused parameter '{name}' | Warning  |
| W005 | Unused import '{name}'    | Warning  |

These can be reported during type checking once usage analysis is integrated.

## Testing Strategy ✅

**Test files**:

- `packages/compiler/src/test/analysis/usage_test.ts` - 13 unit tests for usage
  analysis
- `packages/compiler/src/test/codegen/binary-size_test.ts` - 8 integration tests
  for DCE

1. **Unit tests for visitor**: Ensure all node types are visited correctly
2. **Unit tests for usage analysis**: Test marking logic for various patterns
3. **Integration tests**: Compile programs and verify unused code is eliminated
4. **Binary size tests**: Compare output size with/without DCE

Key test cases:

```zena
// Test 1: Minimal program should have no stdlib
export function main(): i32 { return 42; }

// Test 2: Using String should include String class
export function main(): i32 { return "hello".length; }

// Test 3: Unused local function should be eliminated
let unused = () => 1;
export function main(): i32 { return 2; }

// Test 4: Transitively used function should be kept
let helper = () => 1;
let used = () => helper();
export function main(): i32 { return used(); }

// Test 5: Unused class should be eliminated
class Unused {}
export function main(): i32 { return 42; }

// Test 6: Class used via new expression should be kept
class Used { x: i32; new(this.x); }
export function main(): i32 { return new Used(1).x; }
```

## Related Work

- **Tree shaking** in bundlers (Rollup, Webpack): Module/export-level
  elimination
- **ProGuard** for Java: Class and method shrinking
- **LLVM**: Function-level DCE after inlining
- **Closure Compiler**: Advanced property/method elimination

Zena has an advantage over JavaScript bundlers because the type system provides
precise information about what is referenced.
