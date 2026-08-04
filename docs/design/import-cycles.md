# Import Cycles

Zena allows cyclic imports between modules, JS-style: the module graph
may contain cycles; what is rejected is the narrower set of *uses* that
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

3. **Back edges and origins.** An import edge is a *back edge* when the
   exporting module runs later in evaluation order than the importer.
   Rules classify each imported name by the module its declaration
   *originates* in, looking through re-export hops. Two properties
   matter:

   - the origin runs **later** in evaluation order → its module-level
     initializers have not run when the importer initializes;
   - the origin is **re-checked** (it sits inside a cycle, see
     Implementation) → anything derived from checking it — inferred
     signatures, transparent alias targets, mixin member copies — is
     computed twice and can differ between passes. Nominal type
     *identity* is exempt: it is pinned per declaration, not per pass.

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
     order-independent. An *unannotated* function is rejected when its
     origin is re-checked: its inferred type differs between checking
     passes.
   - **Classes, interfaces, and sealed variants**: fine, anywhere.
     Nominal types are identity-stable across checking passes: each
     declaration has exactly one canonical type object, created on
     first demand (possibly as an empty shell by an importer across a
     back edge) and filled in by the declaring module's own
     registration. Mutually recursive classes across two modules are
     the canonical use.
   - **Mixins, enums, and type aliases**: rejected across a back edge
     when the origin is re-checked. Mixin members are *copied* into
     hosts at application time (a copy from a not-yet-filled shell
     would go stale), and enum/alias resolution is transparent and
     pass-dependent rather than identity-bearing. These can be lifted
     later if a real program needs them.

5. **Initializer hazard, accepted.** A module-level initializer may
   *call* a legally-imported function that transitively reads globals
   which are not yet initialized. This is the same hazard JS accepts;
   the static value rule covers the direct case, and chasing it through
   call graphs is undecidable. Don't do work in module initializers.

## Implementation: two-pass checking

Both compilers use the same architecture; no type is ever materialized
from an unchecked module's AST.

- **Pass one** checks every module once, in evaluation order. A
  back-edge import of a *nominal* type resolves to the declaration's
  canonical object — materialized as a shell from the origin's AST if
  the origin has not been checked yet, and later filled in (never
  replaced) by the origin's own registration. Value bindings and
  function signatures cannot resolve until the exporter has a model;
  those uses re-check in pass two.
- **The re-check closure** is computed up front from the import graph:
  a module with a back-edge import, or one importing any re-checked
  module, re-checks. Everything acyclic and upstream — the stdlib in
  particular — is checked exactly once, and modules outside the closure
  keep their pass-one results and diagnostics untouched.
- **Pass two** re-checks exactly the closure, in evaluation order. By
  then every module has a model, so back-edge imports resolve through
  the normal path; each re-checked module's diagnostics wholesale
  replace its first-pass ones (which were computed against missing
  imports). The cycle rules above are enforced during this pass, keyed
  by two sets threaded into the checker: modules later in evaluation
  order, and the re-check closure.
- **Incremental hosts** (a `previous` check result): closure members
  never carry a previous result forward — their first-pass results are
  order-dependent by design, and pass two consults closure models
  before replacing them. Symmetrically, a shell is only materialized
  for an import whose origin lies across a back edge of the *current*
  compilation; any other model miss is stale incremental state (a
  re-loaded module's rebuilt scope has fresh Symbols the old model
  cannot resolve), and minting a shell there would give the
  declaration a second nominal identity.

### Self-hosted compiler

- **Loader** (`lib/library-loader.zena`): unchanged — it already loads
  cyclic graphs (records are cached before their imports resolve) and
  produces the evaluation order. The `hasCycle` flag stays (it gates
  all cycle bookkeeping to zero cost for acyclic programs) but no
  longer aborts compilation; the `"Dependency cycle detected"` exit in
  `cli/main.zena` is gone.
- **Scope wiring** (`compiler.zena`): scope trees for all files are
  built first (stdlib, then — after the prelude scope — user files),
  then import wiring runs as a fixpoint: each pass rebuilds a file's
  export map from a snapshot of its local declarations plus its
  re-export statements in order (last writer wins, as before), until no
  export map changes. Unresolved names are recorded once, after the
  fixpoint settles.
- **Checking** (`compiler.zena checkCompilation` + `checker.zena`): the
  two-pass scheme above. The scope builder stamps module-level bindings
  with their shape (`Symbol.isFunctionBinding` / `hasFullSignature`) so
  the checker's import handler can classify by the origin symbol
  (`resolveTarget().modulePath`) without touching the origin's AST.
  Nominal identity lives in `SharedCheckerState.declaredNominalTypes`,
  keyed by declaring symbol; `#materializeFromSymbol` is the single
  funnel that consults and populates it, so no pass ever mints a second
  type object for one declaration. Class registration resets what it
  rebuilds (members, implements, mixins, constructor) instead of
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
- `Cyclic import of mixin 'M': mixins cannot cross an import cycle
  (mixin members are copied at application time)`
- `Cyclic import of enum 'E': enums cannot cross an import cycle`
- `Cyclic import of type alias 'A': type aliases cannot cross an import
  cycle`
- `Cyclic import of 'f': a function crossing an import cycle needs an
  explicit signature (annotate every parameter and the return type)`
- `Cyclic namespace import: 'x' originates in a module that has not
  initialized yet`

All spans point at the import specifier. Note the diagnostics land in
the cycle member that evaluates *first* (its imports are the back
edges) — never the entry module; both portable-semantics harnesses
aggregate diagnostics across every user module of the compilation for
this reason.

## Tests

- `tests/language/execution/imports/`: `cycle_pingpong` (mutual
  recursion across a two-module cycle), `cycle_three` (three-module
  cycle), `cycle_mutual_classes` (classes referencing each other across
  the cycle in fields and signatures).
- `tests/language/semantics/modules/`: `@error` fixtures for the value,
  alias, and unannotated-function rules; `cyclic_functions_ok` and
  `cyclic_mutual_classes` pin the legal cases; the `reexport_cycle_*`
  fixtures run un-skipped on both compilers.
