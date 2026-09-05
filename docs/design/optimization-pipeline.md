# Optimization Pipeline: Implementation Plan

**Status: Proposed**

[ir.md](ir.md) §9–10 designed an optimization loop over ZIR and left it
as the open half of milestone M3. This document expands that sketch
into an implementation plan: a per-pass design grounded in the ZIR that
exists today, the driver that runs the passes, and the order to build
them in. Tracking issue:
[#126](https://github.com/elematic/zena/issues/126).

What exists today, per function: lowering → GVN → verify → emit. GVN
(`gvn.zena`) is dominator-scoped value numbering over pure ops — most
of the common-subexpression elimination from the issue's list. Its one
gap is loads: it commons constants, arithmetic, casts and tests, and
immutable `global_get`, and no loads at all
([array-mutability.md](array-mutability.md), "Required optimizations").
The extension below closes the immutable-load half; a load that
executes once per loop iteration is LICM's territory regardless, since
value numbering can only merge an instruction with a dominating
duplicate. Emission does stack scheduling, local coalescing, and
init-discipline local typing. Above the function level, RTA does
declaration-, method-, and vtable-level dead-code elimination before
lowering. Everything else in the issue — inlining, devirtualization,
LICM, PRE, escape analysis / scalar replacement, argument explosion —
is unimplemented.

## Pipeline restructuring

The passes cannot be built on the pipeline as it stands. Today
`ModuleGenerator` is fully streaming: `layout()` binds all indices, the
type/global/vtable sections are emitted, and then each function is
lowered, GVN'd, verified, and emitted inside the code-section loop
(`module-generator.zena`). Two properties of that shape block the loop:

- **No function can see another's body.** Inlining, callgraph
  construction, and signature specialization all need every reached
  body in memory at once.
- **Everything already has a number by the time bodies exist.** The
  harvest pass (ir.md §10) wants to drop functions, types, and vtable
  slots the loop killed, which means indices must bind *after*
  optimization.

The restructure splits compilation into three stages:

1. **Lower.** Lower every reached function to `IrBody`, run the
   per-function cleanup passes, keep the bodies.
2. **Optimize.** Run the module loop (below) over the retained bodies.
3. **Layout and emit.** Bind indices, then emit all sections.

`IrRef` entries are already symbolic — `IrRefFunc` holds a
`WasmFunction`, `IrRefField` a struct plus field name — and emission
reads numeric indices off the target objects at emit time, so moving
layout after the loop is a scheduling change, not a representation
change. The eager vtable *contents* RTA builds (which slots exist,
which globals initialize them) stay as they are in the first stages;
deferring slot layout itself is a later stage (see Harvest below).

The cost of stage 1 is holding all bodies in memory. `IrBody` is flat
parallel `i32` arrays, roughly 30 bytes per instruction plus the
interned tables, so the self-compile should sit in the low hundreds of
megabytes; the restructure PR measures it before anything depends on
it.

The generator and async split passes run before the loop, where they
run now. By the time the optimizer sees a body it is ordinary code — a
`yield_` or `await_` op reaching an optimization pass is a bug, and the
verifier already rejects them post-split.

## Pass inventory

### Cleanup set

Four cheap per-function passes that every other pass depends on for
visible effect. They run interleaved to a local fixpoint (each enables
the others; two or three iterations settle in practice) and rerun after
every semantic pass below.

**`simplify` — peephole and constant folding.** Table-driven off the
wasm opcodes ZIR carries 1:1: fold numeric ops over constant operands,
algebraic identities (`x+0`, `x*1`, `x^x`, double `eqz` feeding a
branch), strength reduction (multiply/divide/modulo by a power-of-two
constant to shifts and masks), and reference folds (`ref_is_null` of a
`struct_new` is false; `ref_cast`/`ref_test` to a type the operand's
static type already satisfies folds away). Branch folding: `br_if` on a
constant becomes `br`, `br_table` on a constant becomes its arm,
`br_on_cast` with a provable outcome becomes `br`. Trap discipline:
never fold or reorder an op that can trap unless the outcome is proven
— `i32_div_s` by constant zero stays a division, a cast that might fail
stays a cast.

**`dce` — use-count worklist.** Deletes pure instructions with no uses,
transitively. Purity comes from a per-op effects table: calls, stores,
`var_set`/`global_set`, throws, and potentially-trapping ops are kept;
allocations (`struct_new`, `array_new*`) are removable when unused
since allocation alone is unobservable. A trapping `ref_cast` is *not*
removable even when unused — it either folds in `simplify` when proven
safe or stays.

**`blockmerge` — CFG cleanup.** Deletes blocks unreachable after branch
folding, merges single-predecessor/single-successor pairs, removes
empty forwarding blocks, and drops block parameters whose every
predecessor passes the same value. Also the home for preheader
insertion when LICM needs it.

**`gvn` — extend what exists.** Two additions to `gvnKey`: `struct_get`
of a wasm-immutable field (`let` fields have been immutable at the wasm
level since single-shot construction landed) and `array_len`.
Both are pure and both recur — narrowed-field reads and loop bounds.
This is a small early win independent of everything else.

### Inlining

The highest-leverage pass: it removes call overhead directly (the
benchmark data in
[optimization-strategy.md](optimization-strategy.md) — wasmtime runs a
trivial-call loop at 12.41ms where V8, which inlines, runs the same
logic at 3–5ms), and it is what turns the other passes on, by making
receiver provenance, fat-pointer uses, and closure environments local
to one body.

Structure: build the direct callgraph in one scan over every body's
`refTable` (`call` sites with `IrRefFunc`), condense SCCs, process
bottom-up so callees are already optimized when callers consider them.

Two tiers of heuristic:

- **Always inline:** synthesized accessors (getter/setter bodies),
  adapters and thunks (single-`call` bodies, argument-adaptation
  wrappers, closure-wrapper trampolines), and any function with exactly
  one call site and no address taken (`isReferenceTaken` false, no
  vtable slot) — its body moves rather than duplicates, and harvest
  deletes the original.
- **Budgeted:** everything else by callee instruction count against a
  budget scaled by `-O2`/`-Os`, with a per-caller growth cap and an SCC
  cutoff so recursion terminates.

Mechanics are pure IR surgery: splice the callee's blocks with ids
remapped, merge `refTable`/`typeTable` entries by interning, rewrite
`param` uses to argument values, turn each `ret` into a `br` to a
continuation block whose parameter is the call's result (`ret_multi`
becomes multiple parameters), give callee `var` slots fresh variable
ids. A callee's own `try_br` regions splice intact. The open risk from
ir.md §15 is inlining a body *containing* protected regions into a
protected region — the emitter's region nesting reconstruction must
handle the nesting. If it fights back, v1 declines that combination
(inline sites inside a protected region accept only try-free callees)
and a counter records how often it triggers; hot code rarely lives
inside `try`.

The payoff chain to test end-to-end, because it is the shape the
compiler itself is made of: inline a higher-order function → its
callback `call_ref` gains a visible closure allocation → devirtualize →
inline the closure body → the environment allocation becomes
non-escaping → SROA deletes it. `Array.map` over a literal arrow
compiling to a plain loop is the acceptance test (milestone P1 below).

### Devirtualization

Two independent triggers, run as one pass:

- **Provenance (exact type).** Trace the `call_ref`'s funcref operand
  back through SSA. The chain that occurs in practice is `struct_get`
  of a vtable slot ← vtable reference, where the vtable reference is
  either a `global_get` of an immutable vtable global (GVN already
  treats those as pure), a `struct_get` of the `<vtable>` field of a
  receiver that traces to a `struct_new` or a known singleton global,
  or an `iface_vtable` of an `iface_pack` whose `IrRefClassInterface`
  names the pair. In every case the vtable global's `VTableInit`
  contents are compile-time constants, so the slot resolves to one
  `WasmFunction` and `call_ref` rewrites to `call`. This is local
  pattern matching plus a table lookup; no class-hierarchy knowledge.
- **CHA/RTA (single implementation).** The slot's `IrRefField` names
  the vtable struct and member. Query the RTA results for every
  instantiated class whose vtable was built over that struct: if
  exactly one implementation is live across them, rewrite to a direct
  call with no guard — whole-program closed world. This needs one new
  query API over data RTA already has (the per-class vtable
  initializers), built once and shared with the harvest feedback loop.

Dead `struct_get`/`iface_pack` chains left behind are ordinary DCE
food, and their disappearance is what later lets harvest shrink vtables.

The speculative variant — a `br_on_cast` ladder over ≤N live
implementations — is deliberately not in v1. It trades size for speed
and needs the `-O2`/`-Os` split plus evidence from the surviving
`call_ref` census (below) before it earns its complexity.

### Escape analysis and SROA

Escape analysis here is per-allocation and local, not a module
analysis: collect the SSA uses of each `struct_new`/`iface_pack` and
classify. An allocation escapes if it is passed to a non-inlined call,
stored into a field, array, global, or `var`, returned, thrown, or
compared by `ref_eq` (identity for class instances is observable;
records and tuples have no identity by language rule, so they never
fail this test). Non-escaping allocations get scalar replacement:

- **v1 — immutable forwarding.** If every field is set only at
  allocation and every use is a field read, a test, or a devirtualized
  receiver position, forward each read to the corresponding init value
  and delete the allocation. This already covers the primary targets:
  fat pointers (`iface_pack` whose uses are all
  `iface_instance`/`iface_vtable`), tuple and record temporaries from
  destructuring, boxes, and closure environments that are never
  written after capture.
- **v2 — mutable fields.** Per-field SSA reconstruction with block
  parameters at joins — mem2reg over one allocation. Iterator objects
  from protocol `for-in` loops (the array case already lowers to index
  loops without allocating) and mutated closure environments live
  here. Scheduled by milestone P2, iterator evaporation, which cannot
  close without it.

### SCCP

Sparse conditional constant propagation: the standard
constants-and-reachability lattice, extended with cast outcomes —
`ref_test`/`br_on_cast` against a value whose provenance proves the
answer folds, and the dead arm's edge goes unexecutable. Iterated
`simplify` + `blockmerge` catches most constant branches; what SCCP
adds is precision at joins and loops (a block only some of whose
predecessors are live) and one place where cast-outcome and
instantiation-set facts (from harvest feedback) plug in. It enters the
loop after inline/devirt/SROA are producing the constants it feeds on.

### Harvest and layout feedback

ir.md §10 in staged form:

1. **Sweep and prune.** Walk `refTable`s from exports, `main`, the
   start function, and element-section entries; functions, globals,
   and types never reached are dropped before layout. Because indices
   bind at emission off the target objects, pruning is deleting from
   `wasm.functions` and re-running index assignment — no body rewrites.
2. **Instantiation feedback.** Recompute the instantiated-class set
   from surviving `struct_new` sites and singleton references. If it
   shrank relative to what devirtualization last used, rerun devirt +
   cleanup with the narrowed set and sweep again. The set is finite
   and strictly shrinking, so this converges, in practice in one or
   two extra rounds.
3. **Deferred vtable layout.** The full §10.2 program — slot sets from
   surviving dispatch sites, vtable globals and trampolines
   materialized only for surviving packs, the hidden vtable field
   dropped from never-dispatched hierarchies. This is the
   binary-size payoff ([binary-size.md](binary-size.md)'s
   dispatch-global pruning) and the largest structural change; it lands
   last, after stages 1–2 are proven, and can ship incrementally
   (slot pruning before field removal).

### LICM

Loop-invariant code motion, after the loop passes above — it improves
loops the semantic passes have already simplified. Its priority is set
less by the benchmark suite (`sieve`, `sum-loop`, the string
benchmarks) than by
[array-mutability.md](array-mutability.md), which lists hoisting the
immutable fat-pointer and vtable-slot loads out of interface-typed
array loops as a precondition, not a follow-up — GVN cannot touch
those loads even once extended, because each executes once per
iteration with no dominating duplicate.
Compute the loop forest from the existing dominator tree plus
back edges, insert preheaders via `blockmerge`, hoist instructions
whose operands are invariant and which are pure: numerics, casts
already proven safe, `struct_get` of immutable fields, `array_len`.
An op that can trap hoists only if its block dominates every loop exit
(hoisting a trap out of a loop that would have executed zero times
invents a failure). Loads from mutable fields and arrays stay put until
there is an aliasing story; a crude no-stores-no-calls-in-loop check
covers the common counting loop and can come first.

### PRE

Deferred, and likely permanently. GVN removes full redundancies; LICM
removes the loop-shaped partial ones; classic lazy-code-motion PRE
buys the remainder at high implementation and determinism cost. The
known gap follows from the narrowing contract (ir.md §5, `gvn.zena`):
every read of a flow-narrowed binding emits its own `ref_cast`, and a
cast emitted on both arms of a join dominates nothing downstream, so
GVN keeps the re-emissions after the join. That shape has a cheaper
targeted fix than PRE: extend GVN to propagate cast facts along
`br_on_cast` and test-guarded edges into the successor's scope. PRE
gets revisited only if pass counters show partial redundancies
surviving both that extension and LICM.

### Signature specialization and argument explosion

[argument-explosion.md](argument-explosion.md) covers the
record-parameter half as a semantics-guaranteed lowering rewrite; it
proceeds
on its own schedule and is not gated on this loop. The general pass —
dropping dead parameters, scalarizing fat-pointer parameters into
`(instance, vtable)` pairs, cloning a function for a constant argument
or for a concrete argument class (a call site passing a `FixedArray`
where the parameter says `Array` gets a clone in which the receiver is
exact, so every dispatch inside devirtualizes — monomorphization over
interface parameters, bounded by a clone budget)
— rides this pipeline's callgraph: direct call edges are rewritable
in place, and functions whose reference is installed in a vtable slot
or escapes keep an adapter with the slot's signature that `tail
return`s the specialized body — `tail return` is implemented, so the
adapter costs no stack frame. It runs
after inline/devirt settle in the implementation order, because those
passes delete most of the edges it would otherwise waste rewrites on.

## Driver

No pass-manager framework — a fixed pipeline function, per ir.md §9.
Three nested levels:

```
cleanup(f):                    # per function, to local fixpoint
  repeat: simplify, gvn, dce, blockmerge   until no change (cap 4)

round:                         # per module
  inline sweep (bottom-up over the callgraph)
  for each function: devirt, sroa, sccp, cleanup

optimizeModule:
  repeat round                 until no change or cap (2–3)
  repeat:                      # harvest feedback
    sweep + prune, recompute instantiated set
    if narrower: devirt + cleanup on affected functions
  until stable
  layout, emit
```

The ordering inside a round is the enablement chain: inlining exposes
provenance, devirtualization turns `call_ref`s into inlinable `call`s
(picked up next round), SROA needs the uses inlining localized, SCCP
folds the branches the others made constant, cleanup feeds the
remains to the next round. Two to three rounds capture the wins;
the cap is a compile-time guarantee, not a correctness matter.

Flags, wired for the first time in the restructure PR: `-O0` = lower +
GVN + emit (today's behavior; GVN stays because emission quality and
the cast-dedup contract depend on it), `-O1` = plus cleanup, `-O2` =
plus the loop and harvest, `-Os` = `-O2` with inline budgets down.
Dev builds and `zena run` default to `-O0`/`-O1`; release artifacts,
the benchmark suite, and the self-compile parity gate run `-O2` — byte
parity must hold with the loop on, which is what forces every pass to
the determinism discipline from day one.

## Implementation order

Each step is one or a few PRs, lands green, and states its gate.

1. **`simplify` v1** (folding, identities, branch folds) — runs in the
   current streaming pipeline. Gate: golden WAT invariants per rule
   class, portable suite, parity.
2. **`dce` + `blockmerge`.** Gate: same, plus self-compile binary does
   not grow.
3. **GVN extension** (immutable `struct_get`, `array_len`). Gate:
   invariant test showing a repeated narrowed-field read collapses.
4. **Pipeline restructure + flags + counters.** Lower-all, then
   optimize, then layout/emit; `-O` flags; `ZENA_ZIR_STATS` grows
   per-pass counters (instructions removed, calls devirtualized,
   inlines performed, allocations scalarized, surviving `call_ref`
   count). Gate: `-O0` output byte-identical to pre-restructure,
   compile time within noise, peak memory measured and recorded here.
5. **Inliner v1** (always-inline tier, rounds driver). Gate: accessor
   call sites gone from a golden test; self-compile time and binary
   size recorded.
6. **Devirt trigger A** (provenance). Gate: `new C().m()` and
   fat-pointer-local dispatch compile to `call` in invariants.
7. **Devirt trigger B** (CHA/RTA single implementation). Gate:
   single-implementation interface call devirtualizes across the
   suite; surviving-`call_ref` census recorded.
8. **Inliner v2** (budgets, `-Os`). Gate: benchmark suite deltas;
   binary size at `-Os` not worse than `-O0`.
9. **SROA v1** (immutable forwarding). Gate: milestone P1 — `map`
   over a literal arrow allocates nothing; fat-pointer
   assertNoAllocation invariants.
10. **Harvest stages 1–2** (sweep/prune + instantiation feedback).
    Gate: binary size drop on self-compile; portable suite at `-O2`.
11. **SCCP.** Gate: match-over-known-exact-type folds; unreachable-arm
    invariant.
12. **LICM.** A precondition for array-mutability.md's interface-typed
    arrays, so it schedules ahead of that workstream regardless of
    benchmark standing. Gate: benchmark loop kernels; hoist counters;
    the fat-pointer loop from array-mutability.md hoists its four
    loads.
13. **SROA v2, speculative devirt, signature specialization.**
    SROA v2 is scheduled by milestone P2 (iterator evaporation) and
    signature specialization by P3 and P4; speculative devirt stays
    gated on the counters from steps 4–12 showing its target pattern
    surviving in the self-compile.
14. **Measurement checkpoint.** The surviving-`call_ref` census on the
    self-compile decides the TFA-style interprocedural type
    propagation question ir.md §2.3 left open, and the
    partial-redundancy counters decide the PRE/edge-GVN question.
    Deferred vtable layout (harvest stage 3) is scheduled here against
    whatever binary-size headroom remains.

Steps 1–3 are independent of the restructure and start immediately;
5–7 each depend on 4; 8–12 are mostly independent of each other once
5–7 exist, so they can interleave with other compiler work.

## Parity milestones

Counters and suite-wide numbers track progress; these milestones define
*done* for the abstractions the language most wants to be free. Each is
a pair of programs — the same workload written abstractly and written
concretely — compiled by the same compiler and compared with the
existing harness: `zena-cli bench`'s Welch's-t sampling must call their
speeds indistinguishable (or the abstract form faster), and WAT
invariants must assert the structural facts, since a timing tie can
also mean both sides missed. They live as workload pairs under
`benchmarks/workloads/`, next to the frozen hand-written WAT baselines
that anchor absolute cost.

**P1 — `map` fusion.** `arr.map(x => ...)` against the handwritten
loop that allocates the result array and fills it. `Array` being an
interface puts receiver devirtualization at the front of the chain:
devirtualize `map` on the fat pointer's provenance, inline it,
devirtualize and inline the callback, scalar-replace the closure
environment and the fat pointer. Invariants: no closure allocation, no
fat-pointer allocation, no `call_ref`, `array.get`/`array.set` directly
in the loop. Achievable at step 9 (its gate names this pair).

**P2 — iterator evaporation.** `for (let x in arr)` through the
general iterator protocol against the C-style index loop. Array
`for-in` today bypasses the protocol by a lowering special case; this
pair compiles the *general* path (special case disabled) and demands
the iterator object dissolve: devirtualize and inline `iterator()` and
`next()`, then scalar-replace an allocation with a **mutable** index
field into a loop-carried block parameter — SROA v2's mem2reg, plus
SCCP to fold the done-flag control flow. Invariants: no allocation in
the loop, no `call_ref`, one back edge. P2 green is the trigger to
delete the array `for-in` special case from lowering (one less thing
`lowerStmt` owns, and the rooting hazard around what lowering calls
goes with it); P2 is also what graduates SROA v2 from evidence-gated
to scheduled.

**P3 — interface-parameter parity.** A function taking `Array<i32>`
and summing it, called with a `FixedArray<i32>`, against the identical
function taking `FixedArray<i32>`. Three regimes, gated separately:

- *Callee inlined:* provenance devirtualization inside the caller
  closes it — parity from step 9's pass set.
- *Not inlined, one live implementation:* CHA devirtualization plus
  fat-pointer parameter scalarization make the specialized body
  identical to the concrete one — parity at step 13.
- *Not inlined, several live implementations:* per-type cloning (step
  13) buys parity at the cost of duplication; without a clone, parity
  is impossible in principle — the dispatch must execute somewhere —
  and the target drops to array-mutability.md's bound of hoisted
  fat-pointer/vtable loads (LICM, step 12) and one indirect call per
  operation.

**P4 — argument explosion.** `f({url, retries})` against positional
parameters — [argument-explosion.md](argument-explosion.md)'s own
acceptance criterion, listed here because its fat-pointer sibling is
step 13's scalarization and the two share the adapter machinery. The
record half is a guaranteed lowering rewrite and does not wait for this
pipeline.

The pairs are cheap to write early and sit red on the dashboard until
their steps land — a standing, honest statement of the gap, in the
spirit of the frozen WAT milestones.

## Verification and determinism

Every pass follows the discipline the backend already enforces:

- **The verifier runs after every pass** during development and at
  `-O1`+ in debug builds; a pass that produces unverifiable IR is a
  hard error at the pass, not a mystery at emission.
- **Differential execution**: the portable execution suite runs at
  `-O0` and `-O2` and must agree — the cheapest miscompile detector
  the project has.
- **Golden WAT invariants** (`wat-invariants.zena`) per optimization,
  each seen to fail before it passes, paired with snapshots per
  `ir/CONTEXT.md`'s testing rules.
- **Byte parity is the standing gate.** Passes iterate in instruction
  and block id order, worklists are ordered, and no hash-iteration
  order may influence output — the same rules GVN already documents.
  The fixpoint test runs at the same `-O` level as release builds.
- **Counters over impressions.** Every pass reports what it did under
  `ZENA_ZIR_STATS`; the self-compile's counter trends, benchmark
  suite, compile time, and binary size are recorded in the PR that
  changes them. The compiler compiling itself is the benchmark that
  decides priority disputes (ir.md M3).

Optimization passes change emitted bytes on nearly every PR, so
snapshot churn is expected; the invariants are what distinguish
regression from reformat. No reseed is ever required by this work:
passes are ordinary compiler-library code the current bootstrap
compiles, and they change output, not language semantics.
