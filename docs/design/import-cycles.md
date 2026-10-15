# Import Cycles

Zena allows cyclic imports between modules, JS-style: the module graph
may contain cycles; what is rejected is the narrower set of _uses_ that
a cycle cannot support. This document defines the semantics and the
implementation in both compilers.

## Semantics

1. **Import cycles are legal.** `a.zena` may import from `b.zena` while
   `b.zena` imports from `a.zena`, directly or through any chain of
   imports and re-exports.

2. **Evaluation order** (module-level initializers, i.e. `__start`):
   depth-first post-order over the import graph from the entry module —
   a module's dependencies initialize before it, except that a
   dependency reached through a cycle's back edge does not re-enter.
   This matches the ECMAScript module evaluation order, and it is the
   order both loaders already produce.

3. **Back edges and origins.** An import edge is a _back edge_ when the
   exporting module runs later in evaluation order than the importer.
   Rules classify each imported name by the module its declaration
   _originates_ in, looking through re-export hops. Two properties
   matter:
   - the origin runs **later** in evaluation order → its module-level
     initializers have not run when the importer initializes;
   - the origin is **re-checked** (it sits inside a cycle, see
     Implementation) → anything derived from checking it — inferred
     signatures, transparent alias targets, mixin member copies — is
     computed twice and can differ between passes. Nominal type
     _identity_ is exempt: it is pinned per declaration, not per pass.

4. **What may cross.** Per imported name:
   - **Values** (module-level `let`/`var` bindings): rejected whenever
     the origin runs later — a read would observe the wasm default
     (null/zero) before the initializer runs, a soundness hole for
     non-null types and the class of bug JS answers with TDZ
     exceptions. This includes namespace imports (`import * as ns`),
     whose record is materialized eagerly in `__start`.
   - **Functions**: fine, if fully annotated (every parameter and the
     return type written out, or a function-typed binding annotation) —
     a call site needs only the signature, and an explicit signature is
     order-independent. An _unannotated_ function is rejected when its
     origin is re-checked: its inferred type differs between checking
     passes.
   - **Type declarations** — classes, interfaces, mixins, sealed
     variants, type aliases (transparent, distinct and opaque) and
     enums: fine, anywhere. Every kind crosses the same way. Each
     declaration has exactly one canonical type object, created on
     first demand (as an empty shell when an importer across a back edge
     asks first) and filled in by the declaring module's own
     registration; identity is pinned per declaration, so a shell and
     its filled form are one object. What a shell holds is the
     declaration's name and type parameters, which the AST alone
     determines. What the kinds differ in is what registration fills:
     - A class, interface or mixin gets its members, supertypes and
       constructor. Mutually recursive classes across two modules are
       the canonical use.
     - A type alias gets its body (`registerTypeAliasDeclaration`). An
       importer holds the shell without expanding it, since the body
       may name types only the origin's scope can resolve. The
       `Iterator<T>.next(): Step<T>` protocol, where `Step` is an inline
       alias whose async arm names `Future` from a module that imports
       the collections back, is the canonical use.
     - An enum has two faces, `Color` the type and `Color` the value
       whose fields are its members; the type is the canonical object
       and carries the value (`TypeAliasType.enumValue`), both built from
       the declaration's member list, and registration supplies the
       backing type. `zena:core`'s `Encoding` and `zena:async`'s
       `FutureState` are used by modules on the same cycle as their
       declaring modules.
     - A mixin's members are _copied_ into a host at application time,
       so a host that applied the shell holds a stale copy until the
       cycle registers again; the application's intermediate class is
       cached for its identity only and its members are rebuilt on
       every registration (`getOrCreateMixinApplication`), so the second
       registration copies from the filled mixin. `zena:core`'s
       `IterableUtils`, applied by `FixedArray` and `Range`, can sit on
       a stdlib cycle this way.

5. **Initializer hazard, accepted.** A module-level initializer may
   _call_ a legally-imported function that transitively reads globals
   which are not yet initialized. This is the same hazard JS accepts;
   the static value rule covers the direct case, and chasing it through
   call graphs is undecidable. Don't do work in module initializers.

## Implementation: registration before bodies

No type is ever materialized from an unchecked module's AST. Checking
a module has two halves — registering its declarations' signatures
(`beginModule`), then checking its bodies (`finishModule`) — and an
import cycle is checked by registering every member before any
member's bodies are checked. Bodies, where nearly all the checking
happens, are checked once.

- **Cycle members** are the strongly connected components of the import
  graph with more than one module (`ImportComponents`, Tarjan's
  algorithm). The files are in evaluation order, which is a post-order
  of the import graph, so every member of a cycle precedes every module
  outside it that imports from it. Walking the files in order: a member
  registers when reached; when the cycle's last member has registered,
  every member registers once more, in order, and then every member's
  bodies are checked, in order. A module outside every cycle registers
  and checks in one step, as before, and everything acyclic and
  upstream — the stdlib in particular — costs what it always did.
- **Why registration runs twice.** The first registration of an early
  member sees the later members' types as empty shells — identity-stable
  canonical objects, materialized from the origin's AST and filled in
  (never replaced) by the origin's own registration. Identity is enough
  for a signature to name a type, but an instantiation of a generic
  type copies structure when it is made (a substituted interface copies
  its parents list, a class instantiation its interfaces), and a
  member registration copies a superclass's or a parent interface's
  members. Those copies, made from a shell, stay stale after the shell
  fills. Registering again, once every shell is filled, rebuilds them;
  registration is signatures only, so it is cheap, and the first
  registration's context and diagnostics are discarded.
- **What bodies need** is then available. A function crossing a back
  edge has a full signature (rule 4), which the origin's context
  resolves from the annotations on demand: an importer asks the origin
  through `SharedCheckerState.inProgressModules` — at import time when
  the origin has registered, otherwise at the function's first use
  (`CheckerContext.resolveInProgressFunction`). A type is answered
  from its canonical object (`CheckerContext.canonicalTypeOf`) as soon
  as any module has materialized it. A
  field declared without a type gets it from its initializer, normally
  when the declaring class's bodies are checked; a member checking its
  bodies earlier reads the field through `FieldInfo.pendingInit`, which
  runs that inference on demand, once, in the declaring module's
  context. The cycle rules are enforced during registration, keyed by
  two sets threaded into the checker: modules later in evaluation
  order, and the cycle's members.
- **Incremental hosts** (a `previous` check result): a cycle member
  carries its previous result forward like any other module, under one
  rule that now applies to every module: the result was checked against
  the same scope tree (`ProgramCheckResult.scopes`). Bindings are keyed
  by Symbol id, and the loader rebuilds the scope tree of every file
  that imports an invalidated file, so a carried result of such a file
  could not answer for the fresh Symbols. Outside a cycle nobody asks
  it to; inside one, its cycle partner does
  (`cycle-incremental_test.zena` pins the case). A shell is only
  materialized for an import whose origin lies across a back edge of
  the _current_ compilation; any other model miss is stale incremental
  state, and minting a shell there would give the declaration a second
  nominal identity.

An earlier design checked every cycle member twice, bodies included,
and re-checked the whole closure of modules importing from a cycle,
transitively — which made a cycle in the standard library re-check
every program (the prelude reaches everything) at three times the
compile time. The component computation is what remains of it.

### Self-hosted compiler

- **Loader** (`lib/library-loader.zena`): unchanged — it already loads
  cyclic graphs (records are cached before their imports resolve) and
  produces the evaluation order. The `hasCycle` flag stays (it gates
  all cycle bookkeeping to zero cost for acyclic programs) but no
  longer aborts compilation; the `"Dependency cycle detected"` exit in
  `cli/main.zena` is gone.
- **Scope wiring** (`compiler.zena`): scope trees for all files are
  built first, each inside a prelude scope whose bindings become the
  file's implicit imports when read (see "`core` and the prelude" in
  stdlib-organization.md), then import
  wiring runs as a fixpoint: each pass rebuilds a file's
  export map from a snapshot of its local declarations plus its
  re-export statements in order (last writer wins, as before), until no
  export map changes. Unresolved names are recorded once, after the
  fixpoint settles.
- **Checking** (`compiler.zena checkCompilation` + `checker.zena`): the
  two-pass scheme above. The scope builder stamps module-level bindings
  with their shape (`Symbol.isFunctionBinding` / `hasFullSignature`) so
  the checker's import handler can classify by the origin symbol
  (`resolveTarget().modulePath`) without touching the origin's AST.
  Every declaration exports its own symbol (`ScopeBuilder.#predeclare`),
  so an importer's `resolveTarget()` reaches the declaring symbol and
  both sides key the same entry. Type identity lives in
  `SharedCheckerState.declaredNominalTypes`, keyed by that symbol, for
  every kind `isIdentityDeclaration` names; `#materializeFromSymbol` is
  the single funnel that consults and populates it, and every lookup
  that wants a type — the import handler, `resolveInProgressType`,
  `materializeCyclicImport` — asks it first through `canonicalTypeOf`,
  ahead of any binding, because a binding is the value face (for an
  enum, the member record). So no pass ever mints a second type object
  for one declaration. Class and mixin registration reset what they
  rebuild (members, implements, mixins, constructor) instead of
  layering over the previous pass's state.
- **Codegen**: unchanged. `__start` already emits per-unit initializers
  in `Program.units` order (= evaluation order); cross-module calls
  resolve by symbol, not by unit order.

### Bootstrap compiler

Same rules, so any cycle the self-hosted compiler's own source uses
compiles identically at stage 0/1. Checking runs in evaluation order
(the old dependency-first recursion is gone — under a cycle it checked
importers before their dependencies and baked unresolved-import types
into member signatures); when cycles are present, a predeclare pre-pass
registers every module's type names first, which is the bootstrap's
native form of identity-stable shells (`predeclareClass` reuses
`decl.inferredType`). The second pass re-checks the closure, resetting
each module's exports, diagnostics, checked-flags, and the synthetic
prelude imports injected after pass one. Re-export handling stamps
`SymbolInfo.origin` when copying entries so classification looks
through hops, like the self-hosted `Symbol.resolveTarget()` chain.

## Diagnostics

- `Cyclic import of value 'x': module-level bindings cannot cross an
import cycle (the exporting module's initializers have not run)`
- `Cyclic import of 'f': a function crossing an import cycle needs an
explicit signature (annotate every parameter and the return type)`
- `Cyclic namespace import: 'x' originates in a module that has not
initialized yet`

All spans point at the import specifier. Note the diagnostics land in
the cycle member that evaluates _first_ (its imports are the back
edges) — never the entry module; both portable-semantics harnesses
aggregate diagnostics across every user module of the compilation for
this reason.

## Tests

- `tests/language/execution/imports/`: `cycle_pingpong` (mutual
  recursion across a two-module cycle), `cycle_three` (three-module
  cycle), `cycle_mutual_classes` (classes referencing each other across
  the cycle in fields and signatures), `cycle_mixin` (a class applying a
  mixin from later in the cycle).
- `tests/language/semantics/modules/`: `@error` fixtures for the value
  and unannotated-function rules; `cyclic_functions_ok`,
  `cyclic_mutual_classes`, `cyclic_alias` and `cyclic_mixin` pin the
  legal cases; the `reexport_cycle_*` fixtures run un-skipped on both
  compilers.
