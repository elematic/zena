# ZIR: the wasm backend (`codegen/ir/`)

ZIR is a CFG+SSA mid-level IR. It is the compiler's **only** backend:
every reached function compiles AST → ZIR → wasm bytes. A lowering
bail (`ZirUnsupported`) is a compiler bug and fails the compile — never
a silent fallback.

Design doc: [`docs/design/ir.md`](../../../../../../docs/design/ir.md)
(section numbers below refer to it). Upstream of this directory,
[`../reachability/`](../reachability/CONTEXT.md) (RTA) decides _what
exists_ — reached functions, generic instantiations, vtables — and
populates the `WasmModule` model; ZIR only compiles what RTA reached.

## Per-function pipeline

Driven by `module-generator.zena` for each `wasm.functions` entry:

```
lowerFunction(wasm, func)   → IrBody        (lowering.zena)
runSimplify(body)                           (simplify.zena)
runBlockCleanup(body)                       (blockmerge.zena)
runGvn(body, new IrCfg(body))               (gvn.zena, cfg.zena)
runDce(body)                                (dce.zena)
verifyIr(body)              → throws on any error (verifier.zena)
emitZirFunction(...)        → wasm bytes    (emit.zena)
```

Simplify may strand blocks (branch folding), which block cleanup then
removes — the verifier rejects unreachable blocks, so those two are a
pair. DCE runs last to sweep what folding and GVN left unused.

The module pass is two-phase: every body is lowered, optimized, and
verified (and retained) before any is emitted. Between the phases, at
`-O2`, the module loop runs: an inline sweep (inline.zena), a
devirtualization sweep (devirt.zena), then constant propagation
(sccp.zena) per round, to a fixpoint with a round cap, re-cleaning
every changed body — inlining exposes the provenance devirtualization
reads, and the direct calls it makes are the next round's inline
sites. `-O0`
skips the cleanup passes; GVN runs at every level (emission quality
and the narrowing cast-dedup contract depend on it). The level arrives
as `ZENA_OPT_LEVEL` / `-O<n>` (docs/design/optimization-pipeline.md);
`build:self-hosted` and the fixpoint gate run `-O2`, so byte parity
polices the loop.

## File map

| File                    | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir.zena`               | Instruction set (`IrOp`), `IrBody` flat-array encoding, operand decoding. `appendValueOperands` and `rewriteValueOperands` are branch-for-branch mirrors — **keep them in sync** when adding ops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `builder.zena`          | `IrBuilder`: append-only construction API used by all lowering code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cfg.zena`              | CFG + dominator tree (RPO) over an `IrBody`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lowering.zena`         | `FunctionLowerer` — the core: SSA environment, expression/statement dispatch, calls, member access, constructors. Ends with the exported **recursion seams** (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lowering-context.zena` | `LoweringContext` (`cx`) — the one shared state object every lowering module receives. `cx.host` is the `FunctionLowerer` coordinating the current function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `control-flow.zena`     | if/while/for/for-in/try/match statement shapes, let-conditions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `patterns.zena`         | Pattern test/bind machinery (tuples, records, or-patterns, destructuring).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `operators.zena`        | Binary/unary/compound operators, operator-method dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `equality.zena`         | `==`/`hashCode`: case-class synthesizers, erased eq diamond, eq/hash intrinsics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `templates.zena`        | Template literals and tagged templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `intrinsics.zena`       | One function per `@intrinsic`; `lowerIntrinsic` is a pure router.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scaffold.zena`         | Helpers synthesized without an AST (string creation/hashing, wasi write).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `generators.zena`       | The generator split pass (generators.md §5): presplit-lowers `gen` bodies, synthesizes frame structs + `next()` + `Iterator<T>` vtable globals between RTA and layout, rewrites bodies into dispatcher-loop state machines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `async.zena`            | The async split pass (async.md §3): the same treatment for `async` bodies — frame structs + `step()` + `Resumable` vtable globals, an eager ramp, a `try_br` failure-capture region, and the async-`main` export wrapper. Shares generators.zena's raw-IrBody helpers, liveness, edge rerouting, and try-region analysis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `simplify.zena`         | Peephole pass, before GVN: constant folding (trap-preserving, NaN-guarded), algebraic identities, power-of-two strength reduction, constant-condition branch folding, static-subtype cast folds, and allocation forwarding (an immutable-field read off a `struct_new`, or an `iface_pack`'s unpack, becomes the operand — the immutable tier of scalar replacement; DCE then deletes the unused allocation). One id-order forward pass plus a final canonicalization sweep (inlining breaks id order).                                                                                                                                                                                                                                                                                                                                      |
| `fold.zena`             | The one table of compile-time evaluation, shared by simplify and SCCP: `evalBinary`/`evalUnary` (integer division and remainder never fold; float arithmetic folds only to a non-NaN), `constOf`, `foldInstTo`, and `castOutcome` — what a type test against a static type answers (1/0/-1; "never passes" rests on struct subtyping being a single chain and is withheld for nullable targets and abstract types).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `blockmerge.zena`       | CFG cleanup: physically removes blocks unreachable after branch folding (compacts the block list, renumbers successor targets and tryJoin; skips a function whose try-join block would die), and deletes block parameters every incoming edge passes the same value for — uses become the value, the argument leaves every branch record. Also forwards edges through a block whose only instruction is a `br` (arguments substituted for its parameters) and fuses a block into its sole predecessor when that predecessor just jumps to it; both keep loop exits where the emitter's fast exit placement can see them. Runs before and after simplify in the cleanup sequence.                                                                                                                                                             |
| `dce.zena`              | Use-count DCE, one reverse-id pass (dead chains collapse because operand ids precede uses). Effects/trap table decides removability; loads need a non-null receiver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `inline.zena`           | -O2 inliner via IrBody.copyFrom: single-block callees splice in place; multi-block callees become new caller blocks with every `ret` a `br` to a continuation that takes the call's value and the rest of the call's block. Ids are pre-assigned before copying (within-block order need not match id order). Budgets: 12 real instructions straight-line; 16 with control flow, and then only for a callee with one call site (its body moves) or ≤6 instructions — at 48 for everything the self-compile was 2.5× the -O1 size for no speed. Per-caller growth and per-callee caps per sweep. A multi-value callee gets one continuation parameter per result and its `mv_get` projections become those; a multi-value tail call copies as the call, its projections, and the branch. Callees with `try_br` or `tail return` never inline. |
| `escape.zena`           | Per-parameter escape summaries, recomputed each -O2 round: a parameter escapes when the body stores, returns, throws, packs, identity-compares it, or passes it to an unknown callee or to a known one whose parameter escapes; casts and block params it flows into are followed. The inliner's argument rule reads them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `licm.zena`             | -O2, after the loop's rounds: moves pure, trap-free, non-allocating instructions whose operands are defined outside a natural loop to just before its header's immediate dominator's terminator. Immutable field loads, array lengths, fat-pointer unpacks, immutable globals, arithmetic, tests. Casts and allocations stay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sroa.zena`             | -O2, each round after the devirtualization sweep: an allocation whose every use is a field read or write through it is deleted and each field becomes an SSA value — one parameter per field on every block the allocation's block strictly dominates, current values passed on every branch into them, reads replaced, writes dropped; block cleanup then deletes the parameters every edge agrees on. The mutable tier of scalar replacement (the immutable tier is simplify's forwarding); the iterator object's index becomes a loop-carried parameter.                                                                                                                                                                                                                                                                                  |
| `thread.zena`           | -O2, after scalar replacement: jump threading through a block whose only instruction is a `br_if` on its own parameter — an inlined `next()`'s continuation branching on the done flag. Each predecessor passing a constant for the flag jumps straight to the arm it selects; an arm that reads the continuation's parameters gets parameters of its own and every edge into it passes the values. Block cleanup then removes the emptied continuation and the trivial parameters.                                                                                                                                                                                                                                                                                                                                                          |
| `specialize.zena`       | -O2, each round after the cleanup that follows devirtualization: a function every direct call site hands a fat pointer packed around the same class gets a clone whose parameter is the instance, re-packed once at entry (simplify then forwards every unpack and cast against that pack); the sites pass the instance and name the clone; the original survives only as a value (vtable install, export, `ref_func`) or harvest deletes it. The clone's signature is appended to the laid-out type section by `WasmModule.getSignatureLate`. Single-class regime only.                                                                                                                                                                                                                                                                     |
| `sccp.zena`             | -O2, each round after the devirtualization sweep: sparse conditional constant propagation over the block-parameter SSA — values start unknown, edges start unexecuted, and a parameter meets only the arguments arriving on executed edges, so a branch whose condition is constant only because the arm that would change it is dead still folds. Rewrites constants in place, replaces constant parameters with a head-of-block constant, and turns one-live-edge branches into `br`; block cleanup removes the rest.                                                                                                                                                                                                                                                                                                                      |
| `harvest.zena`          | After the loop, before any section is emitted: deletes functions and globals unreachable from the exports and the start function, following calls, `ref_func`, and global reads/writes/packs (a live vtable global keeps its installs, a live singleton its class vtable); rebinds indices the way layout does and recomputes the element segment. Fewer vtable globals means fewer devirtualization candidates, so the driver re-runs a round and harvests again while globals keep dying. Types are `typeprune.zena`'s.                                                                                                                                                                                                                                                                                                                        |
| `typeprune.zena`        | After harvest, before the type section is emitted: deletes the types nothing names any more, rooted from surviving signatures (functions, imports, tags), global types and initializers, and every body's type table, variable types and struct-naming refs; a live struct keeps its supertype and field types, an array its element, a signature its params and results. Keeps layout's order and rec groups (an emptied group disappears) and rebinds indices; a dead type gets index -1 so a missed reference fails loudly in the emitter. |
| `devirt.zena`           | -O2: `call_ref` → `call` when the slot resolves — by provenance (vtable global read, `iface_pack`, `<vtable>` of a `struct_new`) or because every vtable global whose struct is the slot's owner or extends it installs the same function (closed-world single implementation, from the module's globals). Signatures must match exactly; multi-value slots rewrite like the rest.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `gvn.zena`              | Dominator-scoped value numbering; string keys + id-order walk keep it deterministic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `verifier.zena`         | Structural/type checks on `IrBody`; failures are loud compile errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `emit.zena`             | SSA destruction: stack scheduling (`#pushValue` discipline), block-param copy coalescing, domtree stackifier, terminator streaming, init-discipline non-null local typing (live validator replay + removable asserts, ir.md §12.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `printer.zena`          | ZIR-as-WAT-comments dump for debugging and snapshots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## The import cycle (deliberate)

This directory is a real module cycle: the per-construct modules import
`lowerExpr`/`lowerExprRaw`/`lowerStmt`/`varDecl`/`throwStmt`/
`multiSource`/`optionalHit` as top-level fully-annotated functions from
`lowering.zena` (the "Recursion seams" section at the end of that
file), and `lowering-context.zena` imports `FunctionLowerer` back. The
language's cycle rules (`docs/design/import-cycles.md`) allow this:
nominal types and fully-annotated functions cross back edges freely;
module-level **values** do not. When adding a new emission module,
follow the same pattern — import the seams, take `cx` as the first
parameter.

## Invariants that bite

- **SSA via block params, not phis.** The environment maps each
  variable symbol to its current value id; joins introduce block
  parameters for variables assigned in the joined regions; loop headers
  carry params for everything assigned anywhere in the loop (pre-scan).
- **One non-SSA construct: mutable variables** (`var_get`/`var_set`,
  ir.md §5.1.1), each pinned to its own wasm local. They exist because
  a handler edge leaves from anywhere in a protected region and so can
  carry only entry-live values, which is not enough for locals the
  `try` body assigns. Every site that stores a new SSA value for a
  symbol into `env` must call `noteVarWrite` — a missed one leaves the
  handler reading a stale value, and nothing else will catch it.
- **A pair built around a null instance is not a null pair.** An
  interface value is a two-field struct and `I | null` is a nullable
  reference to it, so `x == null` tests the POINTER. Packing a null
  through `iface_pack` produces a non-null value that answers `!= null`
  and then traps at the dispatch. A source the checker typed `C | null`
  packs under a null guard instead (`#packInterfaceNullable`) — the one
  path where a conversion, `as` or implicit, introduces control flow.
  The checker sets `InterfaceAdaptation.sourceNullable`; lowering must
  not re-derive it from the value's valtype, since a non-null-typed
  expression can sit in a nullable slot and the extra guard would be
  emission churn.
- **A `finally` is emitted once, and outside its own region.** Every
  way out of the protected part — normal completion, the handler edge,
  `return`/`break`/`continue` — parks an exit code in a variable and
  branches to one dispatch block, which runs the finalizer and then
  replays that exit (exceptions.md, "Finally Compilation"). The
  dispatch lands outside the region because the `try_br`'s handler edge
  is one of its predecessors and the emitter streams that past the
  `end` of the `try_table`. Emitting a copy per exit edge instead is
  not merely fatter: the copy on the normal path would sit INSIDE the
  region and re-enter itself if it threw. `cx.finallyScopes` is what
  routes the early exits, and truncating it at each dispatch is what
  makes nested finalizers run inside-out.
  **`using` is the region's second client**, through the same
  `lowerFinallyRegion` — it supplies the rest of the block as the
  protected part and the `dispose` call as the finalizer, with no
  `TryExpression` synthesized and no AST rewriting. So a change here
  moves resource release too, and the reverse: `try`/`finally`'s
  snapshot plus the "emitted exactly once" WAT invariant are what say
  the shared region still emits what it did.
- **A split pass must re-enter try regions at _every_ dispatch target.**
  Both suspension passes route every edge into a dispatch target through
  a dispatcher that sits outside all user regions, so a target inside a
  `try` is entered unprotected unless the dispatcher branches to a fresh
  `try_br` carrying that region's handler (async.md §6). Resume blocks
  are not the whole set: a suspending loop's header is a dispatch target
  too. **This fails silently** — the success path is byte-for-byte
  plausible and only the throwing path skips the handler — so any change
  here needs a test that throws, on both sides of the suspension.
- **Determinism is a hard gate.** Stage-2 byte parity (below) fails on
  any iteration-order- or identity-dependent output. No wall-clock, no
  randomness, no hash-order-dependent emission.
  - It only gates output as a function of _input_, though: both stages
    are separate processes, each compiling one module, so it cannot see
    output that depends on what the **process** did earlier. `WasmType`
    and `WasmFunction` hash by a uid from a counter, so that counter
    ordered every hash container keyed by one — and left running across
    modules it made the fourth module in a process compile differently
    from the first, and often fail outright. `ModuleGenerator.compile`
    restarts it per module; `multi-entrypoint-codegen_test.zena` guards
    it. Any new process-global in codegen needs the same treatment, and
    a `^var ` at module scope under `codegen/` is the smell.
- **Every operand load in emit goes through `#pushValue`** (except the
  copy-semantics `#copyArgs`). It enforces the stack schedule and
  throws on violations — those asserts catch real bugs; don't bypass
  them with raw `emitLocalGet`.
- **Bail messages name their pool.** Keep the `[in <function>]` suffix
  and the reason wording stable; `ZENA_ZIR_STATS=1` prints a histogram
  of bail reasons, and diagnosis relies on tagging a bail with the
  function/type names, rerunning, then reverting the tag.

## Verification workflow

Run from `packages/zena-compiler/`. When editing anything under
`zena/`, wireit's staleness tracking and zena-cli's compile cache can
both serve stale results: `rm -rf .wireit ../../.zena/cache` first.

```bash
npm test                       # unit + syntax + semantics + execution + interop + fixpoint
npm run test:execution -- classes            # filter one category
ZENA_ZIR_STATS=1 npm run build:self-hosted   # self-compile; expect 0 bails
UPDATE_SNAPSHOTS=1 npm run test:unit         # regenerate zir WAT snapshots
```

Snapshot tests fail on _any_ emission change — regenerate and eyeball
the diff rather than fighting them.

**That is exactly why a snapshot alone cannot guard a property.** The
regression and the innocent reformat produce the same failure, and
regenerating accepts both. When emission has to keep a property —
"this function does not allocate", "this shape still compiles to a
protected region" — assert the property too, with
`zena/test/wat-invariants.zena`:

```zena
assertNoAllocation(wat, '$main', 'a try-assigned local is mirrored into a wasm local');
assertFunctionUses(wat, '$main', usesTry, 'the fixture should compile a try region');
assertFunctionOmits(wat, '$name', ops, why);
```

They scope to one function (a module-wide `contains` proves close to
nothing, since reachability drags in the stdlib) and name the property
in the failure. Pair them with a snapshot: the snapshot shows you what
changed, the invariant tells you whether it mattered. Write the
invariant so you have SEEN it fail — force the old lowering back, watch
the message, revert.

The final gate for backend changes is **stage-2 byte parity**: the
compiler compiled by itself must byte-match the compiler that compiled
it:

```bash
npm run build:self-hosted   # writes zena/out/cli-self.wasm
ZENA_GC_RESERVE_MB=1536 ZENA_COMPILER_WASM=zena/out/cli-self.wasm \
  ../../target/release/zena-cli build zena/cli/main.zena -o zena/out/cli-self2.wasm
cmp zena/out/cli-self.wasm zena/out/cli-self2.wasm
```

Note: compiler-source refactors change the self-compile _input_, so
self-compile output is not a parity signal for them — byte-compare a
fixed input program instead.

## Debugging traps

- `ZENA_EMIT_WAT=1` writes a `.wat` dump next to the output (huge; a
  second full generator pass — leave off otherwise).
- Build with `-g` (`npm run zena -w @zena-lang/zena-cli -- -g build ...`)
  for a name section; then map a trap PC with `wasm-tools print
--print-offsets` and read the surrounding WAT against the source.
- Suspected miscompile in the self-compile: add a temporary index-range
  env filter in module-generator's function loop and bisect — a culprit
  function falls out in ~15 iterations.
- Standalone lib-module builds (`zena-cli build zena/lib/X.zena`) are a
  fast trap probe — they exercise imports.
- `ZENA_TEST_PARALLELISM=N` caps execution-test wasmtime fan-out (the
  default can exhaust machine memory).

## Zena-authoring gotchas (recur constantly in this directory)

- `new X(args).method()` does not parse — bind to a local first.
- i32 `/` promotes to f64; use `>> 1` / `& 31` for integer halving and
  masking.
- A trailing `this.#bail(...)` in an i32-returning function fails the
  missing-return check — write `return this.#bailValue(...)`.
- The ~30-arm `Expression` match trips Z2022 exhaustiveness false
  positives when several arms are added at once — the dispatch wildcard
  uses an if-chain for this reason.
- Enums cast with `as i32` when emitting bytes (`Opcode.return_ as i32`).
