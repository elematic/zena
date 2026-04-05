# Self-Hosted Compiler Design

## Strategy: Informed Port

We're not doing a blind copy of the TypeScript compiler, and we're not starting
from scratch. We're doing an **informed port**: use the working TypeScript
implementation as a reference, but critically review each component before
porting it, cleaning up known problems and laying groundwork for a better
architecture.

This avoids second-system syndrome (we have a working compiler and a test suite)
while giving us the opportunity to fix structural issues that are expensive to
fix in the TypeScript codebase.

### Guiding Principles

1. **Port what works, redesign what's broken.** The TypeScript compiler works.
   Most of its logic is correct. Port the algorithms; improve the data
   structures.
2. **Immutable ASTs.** The parser produces ASTs that are never mutated. Semantic
   information lives in separate side tables. This enables parallelism,
   incremental compilation, and LSP reuse.
3. **Identity-based types.** Type objects are interned and compared by identity,
   never by name. This is already mostly true in the TS compiler but we make it
   a hard invariant.
4. **Prepare for parallelism.** Design data structures so that parsing and
   per-module checking can happen independently. Don't implement parallelism yet,
   but don't create structures that prevent it.
5. **Prepare for incrementality.** Version-stamp source files. Keep ASTs
   reusable across edits. Don't implement incremental recheck yet, but make sure
   the architecture doesn't preclude it.
6. **Visitors everywhere.** Every pass over the AST or type graph uses a visitor
   or structured traversal. No ad-hoc recursive walks buried in checking or
   codegen logic.
7. **Deliver value early.** Ship a formatter before a checker, and an LSP before
   codegen. Each milestone is independently useful.

---

## Architecture Overview

```
Source File (.zena)
    │
    ▼
┌──────────┐
│  Lexer   │  Token stream (per-file, parallelizable)
└────┬─────┘
     ▼
┌──────────┐
│  Parser  │  Immutable AST (per-file, parallelizable)
└────┬─────┘
     ▼
┌─────────────────────┐
│  Module Resolution  │  Import graph, topological ordering
└────┬────────────────┘
     ▼
┌─────────────────────┐
│  Checker            │  Type inference, validation, semantic model
│  ├─ Phase 1         │  File-local: scopes, imports, exports (parallelizable)
│  └─ Phase 2         │  Per-module: full type checking (DAG-parallel)
└────┬────────────────┘
     ▼
┌─────────────────────┐
│  Analysis Passes    │  Whole-program + per-function (visitor-based)
│  ├─ DCE             │  Reachability from entry point
│  ├─ Devirtualization│  Effectively-final, static dispatch
│  ├─ Capture analysis│  Closure variables, mutability
│  └─ Boxing analysis │  Interface dispatch preparation
└────┬────────────────┘
     ▼
┌─────────────────────┐
│  Codegen            │  AST + SemanticModel → WASM binary
└─────────────────────┘
```

---

## Key Architectural Decisions

### 1. Immutable AST + Semantic Side Tables

**Current TS problem:** The checker sets `inferredType` directly on AST nodes.
This mutates the parser's output, coupling the AST to a specific check pass and
preventing reuse.

**Self-hosted design:** The AST is a pure data structure produced by the parser.
The checker produces a `SemanticModel` — a separate data structure that maps AST
node IDs to their semantic information.

```
// AST nodes get a unique ID assigned by the parser
class Node {
  id: i32       // Unique within a module
  loc: SourceLoc
}

// The semantic model maps node IDs to types, bindings, etc.
class SemanticModel {
  // Per-node information
  nodeTypes: Map<i32, Type>           // node.id → inferred type
  resolvedBindings: Map<i32, Binding> // identifier.id → what it refers to

  // Per-declaration information
  classTypes: Map<i32, ClassType>     // classDecl.id → checker type
  functionTypes: Map<i32, FunctionType>

  // Diagnostics
  diagnostics: Array<Diagnostic>
}
```

**Why node IDs instead of AST node identity?** Several reasons:

- We'll eventually want to send ASTs across worker boundaries. We control our
  own serialization (it doesn't have to be JSON — it can be closer to
  structured clone, and we can even reconstruct object references across
  multiple messages with bookkeeping). But IDs make this simpler and cheaper.
- Node IDs make side tables simple arrays or maps rather than WeakMaps, which
  Zena doesn't have.
- Side tables keyed by integer IDs can be efficiently serialized to disk for
  incremental compilation caches.
- When the compiler runs in-memory (e.g., in a web-based playground), integer
  IDs avoid holding entire ASTs alive through WeakMap entries.

**Note on serialization:** We have full control over our serialization format.
We can define binary formats that reconstruct object graphs, not just trees.
So "survives serialization" isn't the only reason for IDs — they're also
simpler, faster for lookups (array indexing vs. hash lookup), and naturally
stable across compiler invocations (useful for caching).

**Trade-off:** Slightly more verbose lookups (`model.getType(expr.id)` vs
`expr.inferredType`), but the benefits for parallelism, incrementality, and
architectural cleanliness are substantial.

### 2. Consolidated Type Representation

**Current TS problem:** Class member information is scattered across ClassType
(checker), ClassInfo (codegen), ClassDeclaration (AST), and various maps in
CodegenContext. Fields alone exist in 4+ places with different representations.

**Self-hosted design:** One authoritative type representation with clear
ownership.

```zena
class ClassType {
  id: i32                    // Unique, interned
  name: String
  declaration: i32           // AST node ID (link back to source)

  // Generic info
  typeParameters: Array<TypeParameter>
  typeArguments: Array<Type> // Empty for uninstantiated
  genericSource: ClassType?  // Points to uninstantiated template

  // Hierarchy
  superType: ClassType?
  interfaces: Array<InterfaceType>
  mixins: Array<MixinType>

  // Members — all in one place
  members: Map<String, Member>

  // Flags
  isFinal: boolean
  isAbstract: boolean
  isExtension: boolean
  onType: Type?              // For extension classes
}

// A single Member type covers fields, methods, accessors
enum MemberKind { Field, Method, Getter, Setter, Constructor }

class Member {
  name: String
  kind: MemberKind
  type: Type                 // Field type or function signature
  isPrivate: boolean
  isFinal: boolean
  isAbstract: boolean
  isStatic: boolean
  isMutable: boolean         // For fields: var vs let
  vtableSlot: i32            // -1 if not in vtable (set by checker)
  declaration: i32           // AST node ID
}
```

Codegen adds its own index tables (WASM struct indices, function indices), but
these are purely codegen-local and reference back to the checker's types by
identity.

### 3. Type Interning

Same approach as the TS compiler, but cleaner:

```
class TypeContext {
  // All type creation goes through here to ensure interning
  intern(type: Type): Type

  // Factory methods that auto-intern
  makeClassType(name: String, typeParams: ...): ClassType
  instantiateClass(template: ClassType, args: Array<Type>): ClassType
  makeUnionType(members: Array<Type>): UnionType
  // ...

  // Identity check is just reference equality after interning
  // type1 === type2  iff  they represent the same type
}
```

The key insight from the TS implementation: interning makes identity-based
lookups in WeakMaps reliable. We keep this. The improvement is that _all_ type
creation goes through the `TypeContext`, not just generic instantiation.

### 4. Checker: Two-Phase Checking

**Current TS design:** A single 5-pass checker processes all modules together.
Passes 1-4 pre-declare types and functions; pass 5 does full checking.

**Self-hosted design:** Split checking into two explicit phases with
different parallelism characteristics:

**Phase 1 — File-local analysis (per-file, trivially parallelizable):**

- Parse the file (already done by this point)
- Resolve symbols to their declarations _within the file_
- Catalog what the file imports (specifiers + imported names)
- Catalog what the file exports (names + their declaration nodes)
- Build the file's scope tree (block scopes, function scopes)
- Pre-declare all type names (classes, interfaces, enums, type aliases)

This phase does NOT validate expressions or infer types beyond what's
explicitly annotated. Most expressions depend on imported types (base classes,
interface constraints, stdlib types), so real type-checking can't happen here.
The value of this phase is _preparation_: it builds the scope structure and
import/export catalog that Phase 2 needs.

**Phase 2 — Module checking (per-module, parallelizable across the DAG):**

- Runs once all of a module's transitive dependencies have been checked
- Wire up imports to their resolved types from dependency checking results
- Full type inference and expression validation
- Class hierarchy: inheritance, interface conformance, mixin application
- Generic instantiation and type argument inference
- Overload resolution, pattern exhaustiveness, type narrowing
- Produces a `ModuleSemanticModel` with per-node types and diagnostics

This is where the bulk of type-checking happens. It's parallelizable across
the module dependency DAG: if modules B and C both depend only on A, then once
A is checked, B and C can be checked in parallel. The practical parallelism
depends on how "wide" the dependency graph is — a deep chain of dependencies
is essentially sequential, but real programs tend to have some width.

The parallelism also depends on how efficiently checker results can be shared.
If A's `ModuleSemanticModel` can be sent to the workers checking B and C
(either via serialization or shared memory), this works. If not, the results
need to be available in a shared location. See the Parallelism section below
for more on this.

The checker's job ends here. It produces a complete `SemanticModel` with
resolved types, bindings, class hierarchies, and diagnostics. Everything
that follows operates on the `SemanticModel` without producing type errors.

Whole-program concerns like reachability (DCE), devirtualization, and
effectively-final analysis are _not_ part of checking — they're analysis
passes that run after all modules are checked. See section 6 below.

**Why not check expressions in Phase 1?** Almost every non-trivial expression
depends on types from other files. `new Point(1, 2)` needs to know Point's
constructor signature. `x.foo()` needs to know the type of `x`, which might
come from an import. Even `let x = bar()` needs to know `bar`'s return type.
We don't have a universal base class with known members — every class's
interface comes from its declaration. Attempting to check expressions without
import resolution would require pervasive "unknown type" placeholders that
provide little value and add complexity.

**Practical consideration:** The Phase 1 / Phase 2 split might not justify
itself in the initial implementation. We may start with Phase 1 + Phase 2
combined (like the current TS compiler), running per-module in dependency
order. The key design goal is that nothing in Phase 2 requires _all_ modules
to be loaded — only the current module's transitive dependencies. This keeps
the door open for parallelism and incremental checking later.

### 5. Visitor Infrastructure

**Currently (TS):** One AST visitor (`visitor.ts`) with a ~60-method optional
interface, a `NodeType` enum for dispatch, and a 500-line `switch` that casts
to each concrete type. A `default: break` silently swallows new node types.

**Self-hosted design:** The Zena AST is a sealed hierarchy with nested
sub-hierarchies (`Node → Expression → BinaryExpression`). This means `match`
expressions **are** the visitor dispatch — the compiler generates discriminant
tags, exhaustive checking, and safe casts. We don't need to port the TypeScript
`Visitor<T>` interface; it was a workaround for TypeScript's lack of sum types.

#### What we provide: `walk` + `walkChildren`

A thin utility module (`visitor.zena`) provides automatic tree traversal:

```zena
// Walk a node tree: enter is called pre-order, leave is called post-order.
// Return false from enter to skip children.
export let walk = (node: Node, enter: (Node) => boolean, leave: (Node) => void) => {
  if (!enter(node)) { return; }
  walkChildren(node, enter, leave);
  leave(node);
}

// Walk children only — for when you want to handle the root specially.
export let walkChildren = (node: Node, enter: (Node) => boolean, leave: (Node) => void) => {
  match (node) {
    // === Module ===
    case Module(body, _, _, _):
      for (let stmt in body) { walk(stmt, enter, leave); }

    // === Expressions ===
    case BinaryExpression(_, left, right, _): {
      walk(left, enter, leave);
      walk(right, enter, leave);
    }
    case UnaryExpression(_, argument, _, _):
      walk(argument, enter, leave);
    case CallExpression(callee, args, typeArgs, _, _): {
      walk(callee, enter, leave);
      for (let arg in args) { walk(arg, enter, leave); }
      if (let ta = typeArgs) { for (let t in ta) { walk(t, enter, leave); } }
    }
    case FunctionExpression(typeParams, params, returnType, body, _): {
      if (let tp = typeParams) { for (let t in tp) { walk(t, enter, leave); } }
      for (let p in params) { walk(p, enter, leave); }
      if (let rt = returnType) { walk(rt, enter, leave); }
      walk(body, enter, leave);
    }
    // ... every other Node variant — exhaustive
    case Identifier(_, _): {}        // leaf
    case NumberLiteral(_, _): {}     // leaf
    case BooleanLiteral(_, _): {}    // leaf
    case NullLiteral(_): {}          // leaf
    // ...
  }
}

// Convenience: walk with enter only (no leave callback).
export let walkEnter = (node: Node, fn: (Node) => void) => {
  walk(node, (n) => { fn(n); return true; }, (n) => {});
}
```

#### Why this is better than the TypeScript visitor

| TypeScript Visitor                     | Zena `match` + `walk`                  |
| -------------------------------------- | -------------------------------------- |
| ~60 optional interface methods         | Zero — callers use closures + `match`  |
| `NodeType` enum (manual discriminant)  | Sealed class **is** the discriminant   |
| 500-line `switch` with casts           | Exhaustive `match` with destructuring  |
| `visitor.visitFoo?.(node)` null checks | Pattern match — zero overhead          |
| Silent `default: break` on new nodes   | **Compile error** on unhandled variant |
| `visitChildren` reflection fallback    | Explicit children in `walkChildren`    |

The key advantage is **exhaustiveness**: when a new AST node is added, every
`match` on `Node` in the codebase produces a compile error until updated. The
TypeScript visitor silently ignores new node types via `default: break`, which
has been a recurring source of bugs.

#### Pattern 1: Simple collection (enter-only)

For simple analyses that collect information in a single pass:

```zena
// Collect all identifiers in an AST
let identifiers: Array<String> = [];
walkEnter(ast, (node) => {
  match (node) {
    case Identifier(name, _): identifiers.push(name)
    case _: {}
  }
});
```

#### Pattern 2: Scoped analysis (enter + leave)

For analyses that need scope tracking or depth:

```zena
// Capture analysis: track variables referenced inside closures
var insideClosure = false;
let captured: Array<String> = [];

walk(ast, (node) => {
  match (node) {
    case FunctionExpression(_, _, _, _, _): {
      insideClosure = true;
    }
    case Identifier(name, _): {
      if (insideClosure) { captured.push(name); }
    }
    case _: {}
  }
  return true;
}, (node) => {
  match (node) {
    case FunctionExpression(_, _, _, _, _): {
      insideClosure = false;
    }
    case _: {}
  }
});
```

#### Pattern 3: Skipping subtrees

Return `false` from `enter` to skip a node's children:

```zena
// Visit top-level declarations only, don't recurse into bodies
walk(ast, (node) => {
  match (node) {
    case Module(_, _, _, _): return true  // recurse into module body
    case ClassDeclaration(name, _, _, _, _, _, _, _, _, _, _, _, _, _, _): {
      registerClass(name);
      return false;  // don't recurse into class body
    }
    case _: return false  // skip everything else
  }
}, (n) => {});
```

#### Pattern 4: Full control (direct `match`, no walker)

Passes that need full control over recursion order — like the formatter and
codegen — don't use `walk` at all. They write recursive functions with `match`:

```zena
// Formatter: convert AST to Doc IR
let printNode = (node: Node): Doc => match (node) {
  case BinaryExpression(op, left, right, _):
    group(concat(printNode(left), text(" ${op} "), printNode(right)))
  case Identifier(name, _):
    text(name)
  case CallExpression(callee, args, _, _, _):
    group(concat(
      printNode(callee),
      text("("),
      indent(join(text(", "), args.map(printNode))),
      text(")")
    ))
  // ... exhaustive — compiler enforces all cases
}
```

This is the primary pattern for the formatter: each node type maps to a `Doc`
structure, with recursive calls to `printNode` for children. No walker needed.

#### Pattern 5: Sub-hierarchy matching

The nested sealed hierarchy (`Node → Expression`, `Node → Statement`) enables
matching at any granularity:

```zena
// Route to sub-handlers by hierarchy level
let processNode = (node: Node) => match (node) {
  case Expression: handleExpr(node)
  case Statement: handleStmt(node)
  case Pattern: handlePattern(node)
  case TypeAnnotation: handleType(node)
  case _: {}  // other direct Node variants
}

// Sub-handler gets exhaustive matching on Expression variants
let handleExpr = (expr: Expression) => match (expr) {
  case BinaryExpression(op, left, right, _): ...
  case Identifier(name, _): ...
  // exhaustive within Expression's variants
}
```

#### Type Visitor (future)

The AST walker covers Milestone 1 (formatter) and the early checker milestones.
When we build the type checker, we'll also need a **type visitor** for
traversing the `Type` graph (not the AST). This is useful for:

- Type substitution (`substituteTypeParams`)
- Type key computation (`computeTypeKey`)
- Type printing
- Finding all type parameters referenced in a type

Since `Type` will also be a sealed hierarchy (`ClassType`, `FunctionType`,
`UnionType`, `TypeParameterType`, ...), the same pattern applies: a
`walkType` function with an exhaustive `match` over `Type` variants. We'll
add this when the checker is built — it depends on the `Type` hierarchy
design.

### 6. Analysis Passes: Between Checking and Codegen

After the checker produces a complete `SemanticModel`, a series of analysis
passes prepare information that codegen needs. These are visitor-based passes
that read the AST + SemanticModel and produce `AnalysisResults`.

Some are whole-program (need all modules), some are per-function:

**Whole-program passes (sequential):**

- **Dead code elimination** — Mark reachable declarations from the entry point
- **Effectively-final analysis** — Methods never overridden can be devirtualized
- **Devirtualization** — Replace virtual dispatch with static calls where safe
- **Generic specialization** — Decide which concrete instantiations to emit
- **Cross-module exhaustiveness** — For sealed hierarchies (future)

**Per-function passes (parallelizable):**

- **Capture analysis** — Which variables each closure captures
- **Mutability analysis** — Which captured variables need cells (mutable boxes)
- **Boxing analysis** — Which values need boxing for interface dispatch
- **Escape analysis** (future) — Which allocations can be stack-allocated

The key design point: these passes don't produce type errors. The
`SemanticModel` is complete and correct. Analysis passes add optimization and
codegen-preparation information on top.

### 7. IR: Not Yet, But Structured For It

**Question:** Should we introduce an intermediate representation between the
AST and WASM codegen?

**Decision:** Not in the initial port. But structure the code so an IR can be
inserted later.

**Reasoning:**

- An IR adds significant complexity and we don't have optimization passes that
  need one yet.
- The current AST-to-WASM translation works.
- WASM itself is somewhat of an IR — it has structured control flow and a type
  system.
- The main benefit of an IR would be optimization passes (constant folding,
  inlining, escape analysis). We can add these later.

**Preparation:** Keep codegen cleanly separated from checking. The checker
produces a `SemanticModel` that is backend-agnostic. Codegen consumes the AST +
SemanticModel. If we later insert an IR, it goes between:

```
AST + SemanticModel → IR → Optimizations → WASM
```

The only code that changes is the AST→IR lowering and IR→WASM emission.
Everything before (parsing, checking) is untouched.

### 8. Formatter and LSP as Early Deliverables

A compiler that only emits WASM is useful but narrow. We can deliver value
sooner by building tools that don't require codegen:

- **Formatter:** Only needs the parser. Useful immediately.
- **LSP basics:** Needs parser + checker. Provides hover types, go-to-definition,
  error diagnostics, completion — even before codegen works.
- **Linter:** Needs parser + visitors. Add rules incrementally.

These also serve as excellent tests of the parser and checker in isolation.

---

## Milestone Plan

### Milestone 0: Parser ✅ Complete

**Status:** Complete. Tokenizer, parser, and AST produce correct output for all
Zena syntax. 389 portable syntax tests pass on both the bootstrap (TS) and
self-hosted (Zena) parsers.

**What was built:**

- `tokenizer.zena` — Full lexer with 50+ token types, string/template literal
  handling, comment support, source position tracking (28 tests)
- `parser.zena` — Complete recursive descent parser (~2000 lines) covering all
  expressions, statements, patterns, type annotations, classes, interfaces,
  mixins, enums, decorators, and import/export syntax (11+ unit tests + 389
  portable snapshot tests)
- `ast.zena` — Sealed AST node hierarchy: Module, Expression (30+ variants),
  Statement (20+ variants), Pattern, TypeAnnotation, with case classes for each
  concrete node type (~600 lines)
- `ast-json.zena` — AST→JSON serialization for debugging and portable test
  comparison (6 tests)

**Deliverable:** `parse(source: String, path: String): Module` ✅

### Milestone 1: Formatter (Not Started)

**Depends on:** Milestone 0 (parser) ✅

**Scope:** A code formatter that parses Zena source and re-emits it with
consistent style. This is:

- A great test of the parser (every valid program must round-trip)
- Immediately useful for the project itself
- Low risk (no type system complexity)

**Key decisions:**

- Print from AST, preserving comments (need to attach comments to AST nodes
  during parsing — either as node properties or in a side table)
- Configurable style (indent width, quote style) via a config record

**Deliverable:** `format(source: String): String`

### Milestone 2: Name Resolution & Module System ✅ Complete

**Depends on:** Milestone 0 ✅

**What was built:**

- `module-resolver.zena` — Import resolution supporting stdlib (`zena:*`),
  user packages, relative paths, target-conditional modules (`*.host.zena`,
  `*.wasi.zena`), and internal modules (~700 lines, 30 tests)
- `package-manifest.zena` — `zena-packages.json` parsing for package config
  with shorthand and full-form syntax, stdlib config builder (9 tests)
- `library-loader.zena` — Source loading, parsing, caching, dependency
  resolution via `CompilerHost` interface. Handles circular imports via
  cache-before-resolve. `LibraryRecord` tracks path, source, AST, resolved
  import mappings, and scope results
- `scope.zena` — Two-namespace (value + type) lexical scoping with Module,
  Function, Block, and Class scope kinds. Tracks symbol info (let/var/type,
  declaration node), module exports, reference tracking, unresolved name
  detection, and pre-declaration for hoisted classes/functions (~800 lines,
  39 tests)
- `visitor.zena` — Generic `walk()` / `walkEnter()` / `walkChildren()` tree
  traversal using exhaustive `match` (all AST node types covered, 12 tests)
- `compiler.zena` — Main orchestrator wiring the pipeline: module resolution →
  source loading/parsing → dependency graph (topological sort) → scope analysis
  → cross-module import wiring with `ExportFromDeclaration` re-export support.
  `createCompiler()` factory for clean construction (9 integration tests)

**Data structures built:**

```zena
// Scope hierarchy
class Scope { parent, bindings: HashMap<String, SymbolInfo>, kind: ScopeKind }
class SymbolInfo { name, kind: SymbolKind, declaration: Node }
class ModuleExports { #values, #types: HashMap<String, SymbolInfo> }

// Module resolution
class ModuleResolver { resolve(specifier, referrer): ResolvedModule }
class LibraryRecord { path, source, ast, imports, scopeResult }
class LibraryLoader { load(path), computeGraph(entry): LibraryGraph }
```

**Deliverable:** `compiler.compile(entryPoint): CompilationResult` with all
modules in dependency order, scopes built, imports validated ✅

### Milestone 3: Type Checker (Core) ← In Progress

**Depends on:** Milestone 2 ✅

**Scope:** Type inference and validation for the core language. Port the
checking logic from the TypeScript compiler, with three key improvements:

1. **No AST mutation** — all type info stored in `SemanticModel` side tables
2. **No string-based type lookups** — use AST node references and interned types
3. **Prelude always available** — no fallbacks for missing stdlib types

**Architecture:**

The checker uses its own type scope stack (separate from `ScopeBuilder`'s
name-resolution scopes). It maps value names → `Type` objects and type
names → `Type` objects. The `SemanticModel` records per-node types by source
offset, keyed the same way as `ReferenceMap`. The AST is read-only.

**Sub-milestones:**

**3a: Type infrastructure + primitives (✅ Foundations built)**

- `types.zena` — Sealed `Type` hierarchy with all variants
- `diagnostics.zena` — `Diagnostic`, `DiagnosticBag`, `DiagnosticCode`
- `semantic-model.zena` — `SemanticModel` (node offset → Type, ResolvedBinding)
- `checker.zena` — `CheckerContext` (type scope stack, narrowings, diagnostics)
- Resolve `NamedTypeAnnotation` → Type (i32, boolean, void, etc.)
- Resolve `UnionTypeAnnotation`, `FunctionTypeAnnotation`
- Check literal expressions (Number→i32/f32, String→String, Boolean→literal, Null→null)
- Check identifier expressions (scope lookup → return type)
- Check variable declarations (infer type, validate annotation, bind pattern)
- `var` bindings widen literal types (true → boolean)
- Check expression statements

**3b: Operators + control flow**

- Binary expressions (arithmetic, comparison, logical, bitwise)
  - Contextual typing: `0 < x` where x is i64 makes 0 → i64
  - Numeric promotion: f64 > f32 > i64 > i32
- Unary expressions (-, !)
- Assignment expressions (type compatibility check)
- `if`/`while`/`for` statements (boolean condition validation)
- `break`/`continue` (loop depth validation)
- Block scoping (`enterScope`/`exitScope`)

**3c: Functions + calls**

- Function expressions → `FunctionType`
- Contextual typing for closures (infer param types from expected type)
- Call expressions (check callee, arg count, arg types, return type)
- Return statements (validate against expected return type)
- If expressions (union of branch types)

**3d: Classes and interfaces**

- Class type creation from `ClassDeclaration`
- Case class constructors
- Field types and member resolution
- `new` expressions
- Member expressions (field access, method access)
- Interface conformance checking
- Inheritance and override validation
- Mixin application

**3e: Generics**

- Type parameter resolution and constraint checking
- Generic instantiation with interning
- Type argument inference
- `substituteTypeParams` via `TypeContext`

**3f: Advanced features**

- Pattern matching exhaustiveness
- Type narrowing (null checks, `is` expressions)
- Closure capture analysis (semantic, not codegen-specific)
- Overload resolution

**Important design note:** The checker should produce information that is
backend-agnostic. It should NOT make decisions specific to WASM (like "this
needs boxing" or "this needs a vtable"). Those belong in codegen or in a
backend-agnostic analysis layer that codegen calls.

However, the checker _should_ compute things that any backend needs:

- Resolved types for every expression
- Which methods are virtual vs final
- Vtable layouts (these are semantic, not WASM-specific)
- Which variables are captured by closures
- Exhaustiveness of match expressions

Note that generic monomorphization decisions currently happen in codegen (it
instantiates concrete WASM types when it encounters `Box<i32>`). In the
self-hosted compiler, the checker should track which instantiations exist
(it already does via interning), and codegen should consume that list rather
than discovering instantiations on its own.

**Deliverable:** `check(modules: Array<Module>): SemanticModel`

### Milestone 4: LSP Foundation

**Depends on:** Milestone 3 (at least 3a-3b)

**Scope:** A basic Language Server providing:

- Diagnostics (errors from parsing and checking)
- Hover (show inferred types)
- Go to definition
- Find references
- Document symbols / outline

This doesn't need codegen at all. It exercises the parser and checker in an
incremental context, which will flush out any design issues with immutability
and incrementality.

**Key work:**

- Wire up parser + checker to LSP protocol
- Implement incremental re-parsing (reparse only changed files)
- Implement incremental re-checking (invalidate dependents of changed modules)
- Source position mapping (AST node IDs → source locations)

**Deliverable:** A working LSP server that provides IDE features for Zena.

### Milestone 5: Analysis Passes

**Depends on:** Milestone 3

**Scope:** The visitor-based analysis passes that sit between checking and
codegen. These operate on the completed `SemanticModel` and produce
`AnalysisResults` consumed by codegen.

**Whole-program passes:**

- **Dead code elimination** — Mark reachable declarations from entry points
- **Effectively-final analysis** — Methods never overridden → devirtualization
- **Devirtualization** — Replace virtual dispatch with static calls where safe
- **Generic specialization** — Decide which concrete instantiations to emit

**Per-function passes:**

- **Capture analysis** — Determine which variables each closure captures
- **Mutability analysis** — Which captured variables need cells (mutable boxes)
- **Boxing analysis** — Which values need boxing for interface dispatch
- **Escape analysis** (future) — Which allocations can be stack-allocated

Each pass is a visitor that reads the AST + SemanticModel. None produce type
errors — the SemanticModel is already complete.

**Deliverable:** `analyze(modules, semanticModel): AnalysisResults`

### Milestone 6: Code Generation

**Depends on:** Milestone 3, Milestone 5

**Scope:** Port the WASM codegen from TypeScript. This is the largest single
milestone.

**Sub-milestones:**

**6a: WASM emitter**

- Binary encoding of WASM sections
- Type section, function section, export section, code section
- WASM-GC specific: struct types, array types, ref types

**6b: Basic codegen**

- Functions, parameters, locals
- Arithmetic, comparisons, control flow
- Variable declarations and assignments
- Function calls

**6c: Classes and objects**

- Struct allocation and field access
- Method dispatch (static and virtual via vtables)
- Constructors
- Interface fat pointers

**6d: Advanced features**

- Generics (monomorphization via checker types)
- Closures (context structs via capture analysis)
- Pattern matching
- Exceptions (WASM exception handling)
- String operations

**6e: Standard library integration**

- Wire up stdlib imports
- Host interop (`@external`, `@expose`)
- WASI support

**Deliverable:** `compile(modules, semanticModel, analysisResults): Uint8Array`
producing valid WASM-GC binaries.

### Milestone 7: Self-Hosting

**Depends on:** Milestone 6

**Scope:** The self-hosted compiler can compile itself.

- Compile the Zena compiler using the TypeScript compiler
- Run the resulting WASM compiler on its own source
- Verify the output matches (or is equivalent to) the TypeScript-compiled output

---

## Data Structure Design Details

### AST Nodes

Keep the existing class hierarchy approach (it's working well in the parser),
but ensure immutability:

```
abstract class Node {
  id: i32
  kind: NodeKind
  loc: SourceLoc
}

abstract class Expression extends Node { }
abstract class Statement extends Node { }
abstract class TypeAnnotation extends Node { }
abstract class Pattern extends Node { }

class BinaryExpression extends Expression {
  left: Expression
  op: BinaryOperator
  right: Expression
}

class ClassDeclaration extends Statement {
  name: String
  typeParameters: Array<TypeParameter>
  superClass: TypeAnnotation?
  interfaces: Array<TypeAnnotation>
  mixins: Array<TypeAnnotation>
  members: Array<ClassMember>
  // No inferredType! That goes in SemanticModel.
}
```

**Comments:** Attach comments to the nearest following AST node (leading
comments) or store them in a separate side table indexed by source position.
The formatter needs comments; the checker doesn't.

### Semantic Model

```zena
class SemanticModel {
  // Type context (interning, factory methods)
  types: TypeContext

  // Per-node semantic info
  nodeTypes: Map<i32, Type>        // expression/declaration → type
  bindings: Map<i32, Binding>      // identifier → what it resolves to

  // Per-module info
  moduleExports: Map<String, Map<String, ExportedSymbol>>

  // Global class/interface registry
  classHierarchy: ClassHierarchy

  // Diagnostics (errors, warnings)
  diagnostics: Array<Diagnostic>
}
```

### Type Context and Interning

```zena
class TypeContext {
  // All types live here; interned by structural equality
  #interned: Map<String, Type>
  #nextId: i32

  // Primitive singletons
  i32Type: NumberType
  i64Type: NumberType
  f32Type: NumberType
  f64Type: NumberType
  booleanType: BooleanType
  stringType: ClassType
  voidType: VoidType
  nullType: NullType
  neverType: NeverType

  // Create or retrieve interned types
  classType(decl: i32, name: String, ...): ClassType
  instantiate(template: ClassType, args: Array<Type>): ClassType
  union(members: Array<Type>): UnionType
  functionType(params: Array<Type>, ret: Type): FunctionType

  // Substitution (uses Type Visitor internally)
  substitute(type: Type, map: Map<TypeParameter, Type>): Type

  // Assignability
  isAssignableTo(source: Type, target: Type): boolean
}
```

### Class Hierarchy

A dedicated structure for navigating the class/interface graph:

```zena
class ClassHierarchy {
  // O(1) lookups
  superType(class: ClassType): ClassType?
  interfaces(class: ClassType): Array<InterfaceType>
  subclasses(class: ClassType): Array<ClassType>  // known direct subclasses

  // Vtable (semantic, not WASM-specific)
  vtableSlots(class: ClassType): Array<Member>
  vtableSlot(class: ClassType, method: String): i32

  // Interface conformance
  implementsInterface(class: ClassType, iface: InterfaceType): boolean
  interfaceMethodMapping(class: ClassType, iface: InterfaceType): Map<String, Member>
}
```

This consolidates vtable computation, subclass tracking, and interface
conformance into one place — rather than spreading them across ClassType,
CheckerContext, CodegenContext, and ClassInfo.

---

## What Changes From the TypeScript Compiler

### Things We Keep (port directly)

- Recursive descent parser strategy
- Token types and lexer logic
- Core type checking algorithms (assignability, inference, narrowing)
- WASM binary encoding logic (emitter)
- Expression codegen patterns (binary ops, calls, member access)
- Pattern matching compilation strategy
- Dead code elimination via reachability analysis
- Closure capture via context structs

### Things We Redesign

| Area            | Current (TS)                                 | Self-Hosted                                                        |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| AST mutation    | Checker sets `inferredType` on nodes         | Checker writes to SemanticModel side table                         |
| Class members   | Spread across ClassType, ClassInfo, AST      | Single `members` map on ClassType; codegen adds indices separately |
| Type lookup     | Mix of name-based and identity-based         | Identity-only via interning                                        |
| Visitors        | 60-method optional interface + switch/cast   | Sealed `match` + thin `walk`/`walkChildren` utility                |
| Checker passes  | 5 passes over all modules together           | 2 phases: file-local, per-module (DAG); then analysis passes       |
| Generic context | `currentTypeParamMap` stack in codegen       | Type substitution via TypeContext.substitute()                     |
| Vtable layout   | Computed in both checker and codegen         | Computed once in ClassHierarchy                                    |
| Analysis passes | Ad-hoc (DCE in visitor, captures in codegen) | Structured passes between checker and codegen                      |

### Things We Defer

- IR / SSA (add only if optimization passes need it)
- Parallel compilation (design for it, don't implement it)
- Incremental recheck (design for it, implement in LSP milestone)
- Query-based architecture (a la rust-analyzer — maybe someday)

---

## Risk Assessment

### Low Risk

- **Parser port:** Nearly complete, well-tested, straightforward.
- **Formatter:** Operates only on AST, no semantic complexity.
- **WASM emitter:** Mostly mechanical binary encoding.

### Medium Risk

- **Type checker port:** Large and complex, but we have comprehensive tests.
  The main risk is subtle semantic differences between the TS and Zena
  implementations. Mitigation: run the same test suite against both.
- **Codegen port:** Large, but again well-tested. The main risk is that the
  new data structure layout requires significant re-plumbing of how codegen
  accesses type information.

### Higher Risk

- **LSP incrementality:** We haven't built this before. Start with a simple
  "recheck everything on change" and optimize later.
- **Phase 1/2 checker split:** Hard to know exactly where to draw the lines
  until we try it. Start with Phase 1 + Phase 2 combined (like the TS compiler),
  running per-module in dependency order, and refactor into separate phases
  once the basic checker works.

### Mitigations

- **Test suite is the safety net.** Every milestone must pass the existing test
  suite (adapted for the self-hosted compiler). This is non-negotiable.
- **Incremental delivery.** Each milestone is independently testable and useful.
  If we hit a wall on one milestone, the previous milestones still have value.
- **TypeScript compiler stays alive.** We don't delete the TypeScript compiler
  until the self-hosted one passes all tests and handles all features. Both
  coexist during the transition.

---

## Incremental Compilation & LSP Considerations

Even though we defer full incremental compilation, a few design choices now
will make it much easier later:

1. **Version-stamped source files.** Each `Module` AST stores the source text
   hash or version number. When re-parsing, compare versions to know if a file
   changed.

2. **Declaration signatures are the cache key.** If a module's exported type
   signatures haven't changed, its dependents don't need re-checking. This is
   how TypeScript's `--incremental` works.

3. **AST immutability enables sharing.** An unchanged module's AST can be reused
   across compilations. Since the checker doesn't mutate it, no copying needed.

4. **Diagnostics are per-module.** Store diagnostics separately per module so
   they can be invalidated and recomputed independently.

5. **File-independent checking.** The LSP should be able to check a single
   file using only the exported signatures of its imports (not their full ASTs).
   This means Phase 2 of the checker shouldn't depend on having the full AST
   of imported modules — only their semantic summaries (exported types and
   declarations).

---

## Parallelism Considerations

The architecture is designed so the following can eventually run in parallel:

| Phase                    | Parallelism                | Notes                                                               |
| ------------------------ | -------------------------- | ------------------------------------------------------------------- |
| Lexing                   | Per-file                   | Stateless, trivially parallel                                       |
| Parsing                  | Per-file                   | Stateless, trivially parallel                                       |
| Phase 1 checking         | Per-file                   | File-local scope + import/export catalog                            |
| Phase 2 checking         | Per-module (DAG)           | Parallelizable once dependencies are checked                        |
| Analysis (whole-program) | Sequential                 | DCE, devirtualization, effectively-final                            |
| Analysis (per-function)  | Per-function               | Capture analysis, boxing, mutability                                |
| Codegen                  | Per-function (potentially) | Function bodies are independent; type/struct registration is shared |

**Data structures for parallelism:**

- Node IDs (integers) instead of object references in side tables
- `SemanticModel` per module (merged in global pass)
- No mutable shared state during parallel phases

**Isolated modules (future consideration):**
TypeScript has `isolatedModules` and `isolatedDeclarations` modes that
constrain what a file can do in order to enable parallel/independent checking.
We may want something similar for large Zena codebases:

- **Declaration summaries:** After checking a module, emit a compact summary
  of its exported types (like a `.d.ts` but for Zena). Dependents can check
  against the summary without the full source or full `ModuleSemanticModel`.
  This would dramatically improve parallelism and enable caching.
- **Isolated declaration constraint:** Require that exported declarations have
  explicit type annotations (no inference leaking across module boundaries).
  This means a module's summary can be computed from Phase 1 alone, without
  waiting for Phase 2 type inference.
- **Not needed yet.** Start without this. But design the checker so that a
  module's exports are a well-defined concept (they already are), and ensure
  checking a module only needs the _exports_ of its dependencies, not their
  internals.

---

## Open Questions

1. **Comment preservation strategy?** Store comments in AST nodes (simpler) or
   in a separate table (cleaner for the checker, more work for the formatter)?
   Leaning toward a side table: `comments: Map<i32, Array<Comment>>` keyed by
   the AST node ID that the comment is attached to.

2. **Error recovery in parser?** The TypeScript parser has minimal error
   recovery. For LSP usage, we'll want better recovery (parse partial/invalid
   syntax and still produce a useful AST). Not needed for Milestone 0, but
   factor it into the AST design.

3. **How much of the checker's backend-agnostic analysis layer do we keep?**
   The TS compiler has `analyzeBoxing()`, `analyzeMethodDispatch()`, etc. These
   are useful for multiple backends. Port them as part of Milestone 5 or fold
   them into codegen?

4. **Should `TypeContext` own the class hierarchy, or should it be separate?**
   Leaning toward separate: `TypeContext` handles interning and type creation;
   `ClassHierarchy` handles inheritance relationships. This keeps
   responsibilities clear.

5. **When to introduce a config/options system?** The TS compiler has an
   `options` bag passed everywhere. Design a clean options type early (Milestone 0) so all phases can reference it consistently.

6. **Analysis pass boundaries.** Where exactly does Phase 2 (per-module
   checking) end and analysis passes begin? Some analyses blur the line. For
   example, vtable layout needs the full class hierarchy, which is built
   incrementally across modules during Phase 2. The rule of thumb: if it
   produces type errors, it's checking. If it produces optimization or
   codegen-preparation information, it's an analysis pass.

---

## Compiler Host API

### Current Design ✅ Implemented

The self-hosted compiler has a clean host abstraction:

```zena
interface CompilerHost {
  readFile(path: String): String
}
```

Module resolution is handled separately by `ModuleResolver`, which takes a
package map and resolves specifiers to canonical paths. The `LibraryLoader`
combines both: it uses `ModuleResolver` for resolution and `CompilerHost` for
source loading. The `Compiler` class wires everything together via
`createCompiler(host, options)`.

This separation works well: CLI implements `CompilerHost` with filesystem I/O,
tests implement it with `MockHost` backed by `HashMap<String, String>`.

### What We Need for the Self-Hosted Compiler

The current interface is close to sufficient but needs a few additions for
broader use cases:

**1. Output handling.** The current compiler returns `Uint8Array` from codegen
and the caller writes it wherever they want. This is good — the compiler
should not assume it can write to a filesystem. Keep this.

**2. Diagnostic reporting.** The current compiler returns diagnostics as data
(error messages with source locations). The host decides how to display them.
Keep this.

**3. Async loading.** For web-based compilation (e.g., a playground or
in-browser IDE), module loading may need to be asynchronous (fetching files
over HTTP). The current `load` is synchronous. Options:

- Make `load` return `String | Promise<String>` — messy but pragmatic.
- Make the entire compilation async — clean but Zena doesn't have `async` yet.
- Require the host to pre-load all files and provide them synchronously —
  works for playgrounds, messy for large projects.

For now, keep synchronous loading. When we need async, the host can
pre-populate a cache. When Zena gains async support, make the API async.

**4. Module resolution strategies.** Different hosts have different resolution
rules:

- CLI: Filesystem paths, `node_modules`-style resolution, stdlib bundled
- Web playground: All files in a virtual FS, stdlib pre-loaded
- LSP: Files open in the editor override disk versions
- Testing: In-memory file maps

The current `resolve(specifier, referrer): String` is flexible enough for
all of these. The host controls the resolution logic entirely.

**5. File watching (LSP).** The LSP needs to know when files change on disk.
This is outside the compiler's scope — the LSP host watches files and tells
the compiler to re-check.

### Proposed Self-Hosted Host Interface

```
interface CompilerHost {
  // Module resolution: specifier (e.g., './math', 'zena:array') + referrer
  // → canonical path (e.g., '/project/src/math.zena', 'zena:array')
  resolve(specifier: String, referrer: String): String

  // Load source text for a canonical path
  load(path: String): String

  // Optional: check if a path exists (useful for resolution)
  exists(path: String): boolean

  // Optional: file version/hash for incremental compilation
  // Returns null if versioning is not supported
  version(path: String): String?
}
```

The `exists` method avoids the "try to load, catch error" pattern during
resolution. The `version` method enables incremental compilation — if a
file's version hasn't changed, its AST and semantic model can be reused.

### Web Playground Scenario

A web-based playground would implement `CompilerHost` with:

- A `Map<String, String>` of virtual files (editor contents)
- Pre-bundled stdlib source (loaded at page init)
- `resolve` maps `'zena:*'` to stdlib, `'./*'` to virtual files
- `load` reads from the map
- `exists` checks the map
- `version` returns a hash of the source text

The compiler runs synchronously on the pre-loaded files. No network I/O
during compilation. The host handles the async loading _before_ invoking the
compiler.

### LSP / IDE Scenario

An LSP host would implement `CompilerHost` with:

- Open editor buffers override filesystem reads
- `version` returns the editor's version number for open buffers, and
  filesystem mtime for disk files
- The LSP watches for file changes and triggers re-compilation
- For incremental checking, the compiler compares versions and skips
  unchanged modules

### Testing Scenario

Test hosts (like the current `InMemoryHost`) work as-is. Provide a
`Map<String, String>` and the compiler operates on it. No changes needed.

---

## Next Steps

1. ~~Finish the parser (Milestone 0).~~ ✅ Complete — 389 portable tests pass.
2. Start the formatter (Milestone 1) as soon as the parser is complete enough
   to parse real Zena files. This validates the AST design. **Ready to start.**
3. ~~Port name resolution (Milestone 2).~~ ✅ Complete — module resolution,
   scope building, cross-module import wiring all done.
4. Design the `SemanticModel` and `TypeContext` data structures in detail.
   Write them up with concrete Zena type definitions before implementing.
   **This is the next architectural design step.**
5. Begin type checker porting (Milestone 3a) with primitive types and
   expressions. Use the existing test suite to validate.
