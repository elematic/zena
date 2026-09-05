# ZIR: An Optimizing IR for the Self-Hosted Compiler

Status: **Proposed**

This document designs a mid-level intermediate representation — **ZIR** (Zena
IR) — for the self-hosted compiler (`packages/zena-compiler`). It supersedes
the IR sketches in two earlier documents:

- `optimizations.md` proposed optional HIR/LIR tiers and deferred SSA
  ("only if needed").
- `separate-compilation.md` proposed a serializable `.zir` expression-tree
  format for link-time whole-program optimization.

ZIR reconciles both: a **single CFG-based SSA IR** that is the substrate for
optimization _and_ (in a later milestone) the on-disk unit of incremental
compilation. `self-hosted-compiler.md` §7 deliberately deferred an IR but
required structuring the code so one could be inserted later between
`AST + SemanticModel` and WASM emission; this document exercises that escape
hatch and specifies exactly where the seam is.

## 1. Why now, and why SSA

The reasons the earlier docs deferred an IR no longer hold:

1. **We want real optimizations.** Inlining, scalar replacement of aggregates
   (SRoA), sparse conditional constant propagation (SCCP), devirtualization,
   and instruction-level DCE are all on the roadmap
   (`optimizations.md` §Devirtualization–§Escape Analysis, all currently 🔲).
   Every one of them is dramatically simpler on a CFG+SSA form than on an AST:
   dead code is "no users", constant propagation is a lattice walk over defs,
   inlining is splicing blocks, and SRoA is rewriting the users of one
   allocation instruction. On the AST each of these requires re-deriving
   control flow and data flow from scratch, per pass.

2. **The toolchain is self-contained — no wasm-opt.** The division of labor in
   `optimizations.md` ("wasm-opt owns mechanical opts") is retired. We do not
   depend on Binaryen or any external optimizer. That means the mechanical
   layer — constant folding, branch simplification, instruction DCE, local
   coalescing — is also ours, which strengthens the case for SSA: those passes
   are trivial on SSA and miserable on an AST or on raw stack code.

3. **AOT engines don't save us.** Wasmtime/Cranelift performs no inlining and
   no devirtualization of `call_ref`. Every abstraction Zena encourages —
   interfaces, iterators, closures, small methods — survives to runtime unless
   _we_ remove it. (V8 recovers some of this with speculative inlining; the
   CLI and server targets get nothing.)

4. **Compiler performance itself is the headline problem.** The current
   bottlenecks are monomorphization code explosion (importing `zena:test` pulls
   790+ WASM functions; one test file compiles in ~47s cold vs 0.24s in the
   bootstrap compiler) and repeated AST re-walking. An IR designed for cheap
   copying gives us a structural fix: lower each generic function to IR
   **once** and specialize by copying flat arrays, instead of re-walking the
   AST per instantiation (§8).

The design principle throughout: **the IR is a data-oriented, index-based
structure** — flat `i32` arrays, side tables, no per-instruction heap objects —
because the self-hosted compiler runs on wasm GC where allocation and pointer
chasing are exactly what we can't afford. This is the same philosophy the
front end already committed to (immutable AST + side tables keyed by integer
node IDs, `self-hosted-compiler.md` §3).

### Non-goals

- **Not a second checker.** The checker remains backend-agnostic and
  authoritative; ZIR is constructed _from_ the checked AST + `SemanticModel`
  and trusts them. The ZIR verifier (§11) checks IR invariants, not language
  rules.
- **No register allocation.** Wasm locals are unbounded; we only coalesce.
- **Not an interpreter/constexpr substrate** (possible later; not designed
  for here).
- **No new semantics.** Runtime behavior of every construct is already
  specified by the current codegen; ZIR must reproduce it exactly.

## 2. Position in the pipeline

Before ZIR, `ModuleGenerator.compile()` walked each function's AST and
emitted bytes in a single streaming pass (`FunctionGenerator`, deleted at
M4). ZIR changed only the _function-body_ path. The structural model
(`WasmModule`, `WasmStruct`, `WasmGlobal`, vtable globals) survives as-is;
the AST walk is split into lowering and emission with the optimization
loop between them:

```
Program
  → ReachabilityAnalysis.run()        (RTA + monomorphization, as today,
                                       but producing *candidate* vtable
                                       slot sets, not final layouts)
  → LOWER: for each reached WasmFunction, AST → ZIR body     [parallelizable]
  → OPTIMIZE: module-level fixpoint loop over ZIR            (§9)
      inline ⇄ devirtualize ⇄ SRoA ⇄ SCCP ⇄ simplify ⇄ DCE
  → PRUNE + LAYOUT: IR-level reachability sweep              (§10)
      drops functions/types orphaned by devirt+inlining;
      THEN finalizes vtable layouts, materializes vtable
      globals/trampolines, finalizes struct layouts
  → wasm.layout() + section emission
  → EMIT: per function, ZIR → bytes                          (§12)
      SSA destruction → stack scheduling → local coalescing
      → existing BinaryEmitter / WatEmitter
```

The governing principle for the split: **discovery decides existence and
candidates; layout assigns numbers, and all numbering happens after the
optimization fixpoint.** ZIR never contains a numeric vtable slot, field
offset, or wasm index — only symbolic references (§4's `refTable`) that
layout binds at the end. §10.2 spells out why this ordering is forced.

Everything upstream of lowering — parser, checker, `SemanticModel`,
scope analysis, incremental re-checking — is untouched, exactly as
`self-hosted-compiler.md` §7 prescribed.

### 2.1 Where discovery and RTA run

**RTA stays where it is, on the AST side.** This is a deliberate and important
choice:

- RTA's job is to decide _what exists_: which functions are reachable, which
  classes are instantiated, which generic instantiations to materialize, and
  which members are dispatch _candidates_ (virtual and reached through
  dynamic dispatch). It does **not** decide final vtable layouts — those
  depend on what survives optimization and are assigned post-fixpoint
  (§10.2). Its inputs (`SymbolDependencies`) are computed by
  the checker (`semantic-model.zena:678`, `checker.zena:253–327`) and live in
  the `SemanticModel`. Moving RTA onto ZIR would require lowering _every_
  function — including never-reached ones — before knowing what's reachable,
  which is exactly backwards for compile time. Lowering only reached,
  already-monomorphized functions keeps the IR population minimal.
- The `discovery.zena` index-allocation pass and the
  `Specializer`/`ClassHierarchyAnalysis` cluster keep their current roles.
  ZIR consumes their outputs: the set of `WasmFunction`s to lower, the
  declared field and candidate-slot _membership_ of each struct/vtable
  (symbolically — numbering comes later), and the CHA tables that
  devirtualization queries.

**Why discovery is dispatch-aware at all.** Lowering emits exactly one
uniform shape for every virtual call (`vt.load`/`vt.slot`/`call_ref`, §5),
and _all_ devirtualization happens against the IR (§9) — discovery resolves
no call site. Its dispatch-awareness serves only the liveness question.
RTA's defining transfer function is a conjunction: a virtual method body is
reachable iff (a dispatch site naming that member is reached) **and** (a
class providing that implementation is instantiated). Drop the conjunction
and discovery degrades to "any reference to an interface member reaches
every implementation in the program" — sound, but it lowers and
monomorphizes vast amounts of code that the §10 harvest then deletes.
Correctness would survive that ordering; compile time would not: the
over-approximation _is_ the monomorphization explosion (§1, point 4)
re-created deliberately. Dispatch-awareness in discovery is how the reached set — and
therefore the lowering and optimization workload — stays proportional to
the program that actually runs.

This ordering matches how closed-world AOT compilers with real IRs arrange
things. GraalVM Native Image parses each method to Graal IR lazily on
first reach and runs its points-to/RTA analysis over the IR to a fixpoint
— the fused model of §2.2 — with devirt/inlining downstream of the
analysis. Dart AOT lowers everything to kernel IR first, then runs TFA (an
RTA descendant) over it for tree-shaking and devirt facts — affordable
because Dart shares generic code at runtime instead of monomorphizing;
Zena monomorphizes, which is exactly why lower-everything-first is the
wrong order here. Kotlin/Wasm does dispatch-aware DCE in its frontend IR
before Binaryen's closed-world type-directed devirt. The invariant across
all of them: discovery is dispatch-aware wherever tree-shaking or
monomorphization matters, it runs over whatever representation is cheapest
to have at that point (for us, the checker's `SymbolDependencies`), and
devirtualization as an _optimization_ is always downstream, on the IR.

**A second, much cheaper reachability pass runs on ZIR after optimization**
(§10). Devirtualization and inlining strand things: a vtable global whose
every slot load was folded away, a method body reachable only through
now-devirtualized dispatch, an interface fat-pointer struct that SRoA
evaporated at every use site. AST-level RTA cannot see this because it
computed reachability against the _pre-optimization_ dispatch structure. The
IR-level sweep is trivial by comparison — a worklist over instruction operands
(function refs, global refs, type refs), no CHA, no specialization — because
by then all dispatch that could be resolved _has been_ resolved into direct
references.

So: **discover on the AST, harvest on the IR.** The IR-side sweep also
closes a precision loop back into devirtualization when optimization
shrinks the instantiated-class set (§10.1). Long-term, if we ever want
optimistic RTA (assume-dead until proven live during the optimization loop
itself), that too is an extension of the §10 sweep, not a rewrite of
AST-side RTA.

### 2.2 One pass or two? Discovery is staged in v1, IR-driven eventually

An obvious alternative to the pipeline above is to **fuse discovery and
lowering**: lower a function to ZIR the moment RTA first reaches it, and
let the lowered body itself drive the worklist — `struct.new` sites are
the instantiation facts, `vt.slot` metadata the (class, member) dispatch
facts, `refTable` entries the direct edges. RTA's two-queue,
instantiation-aware fixpoint keeps its structure; only its transfer
function's input changes (scan the body's IR instead of reading
`SymbolDependencies`).

**v1 stays staged** (RTA to fixpoint, then lower the settled set):

- Today's RTA never walks bodies — it reads the `SymbolDependencies` the
  checker computed anyway (and incrementally caches). Fusing doesn't save
  a body walk; it swaps side-table reads for IR scans.
- Lowering over a settled set is embarrassingly parallel; a fused
  worklist serializes (fixable with batched parallel BFS, but that's
  machinery v1 doesn't need).
- The RTA cluster stays untouched — the bulk of the migration-risk
  argument.

The ordering worry that would seem to block fusion — vtable slot numbers,
struct layouts, and super-linking are only final _after_ the fixpoint —
is already neutralized by design: ZIR stores symbolic `refTable` entries,
never raw indices; layout binds numbers post-fixpoint (§10.2). So bodies
lowered mid-fixpoint cannot bake in stale numbering. Fusion is a
representation change, not a soundness question.

**The `.zir` endgame forces IR-driven discovery anyway.** In the
two-phase model (§13), link-time RTA cannot consult `SymbolDependencies`
— ASTs and `SemanticModel`s aren't loaded in phase 2. Discovery there
must run off IR-derived facts: module summaries plus template
`refTable`s. Template ZIR (§8) makes this cheap in exactly the right
place: discovering an instantiation doesn't materialize its body — the
instantiation's dependencies are the template's symbolic dependencies
pushed through the type substitution, and bodies materialize only for
survivors. So the trajectory is: staged (M1–M4) → IR-driven discovery as
part of the link phase (M6), with fused discover-by-lowering available
earlier if the exactness of post-lowering dependencies (resolved
adaptations, intrinsics, narrowing) proves worth the plumbing.

### 2.3 Why RTA and not something stronger (TFA)?

The call-graph-analysis precision ladder (Tip & Palsberg) runs:
**CHA** (all declared subtypes — too coarse; keeps methods of
never-instantiated classes alive) → **RTA** (one global instantiated set)
→ **XTA** (per-method/per-field sets) → **0-CFA / points-to / TFA**
(per-variable type flow, as in Dart AOT's Type Flow Analysis). Two
different jobs sit on this ladder, and they deserve different rungs:

- **Discovery (liveness):** RTA is the sweet spot and stays permanently.
  The dominant tree-shaking fact is "this class is never allocated",
  which RTA captures, near-linearly, from side tables that exist anyway.
  Stronger analyses mostly sharpen _per-call-site_ answers, not liveness.
- **Per-site devirtualization precision:** TFA's genuine edge — a site
  whose receiver can only be `Circle` devirtualizes even though five
  other implementations are instantiated elsewhere. But Dart needs that
  precision because Dart cannot monomorphize (generics are shared at
  runtime; TFA is how concrete types are recovered at all). Zena
  monomorphizes, and the ZIR loop recovers much of the same precision
  locally: inlining propagates exact receiver types through SSA, and the
  §10.1 feedback narrows the global set as allocations die. What the
  loop cannot see is types flowing through _non-inlined_ call
  boundaries, fields, and collections — that residue is TFA's actual
  territory here, and it is an empirical question how much of it
  remains.

TFA is also one of the most complex components in Dart's toolchain
(per-method summaries, whole-program fixpoint with invalidation and
widening) and wants IR for everything up front, colliding with our
lower-only-what's-reached ordering.

**Decision:** RTA for discovery, forever. Call-site precision beyond the
loop is an _optimization-side_ pass, bought only on evidence: after M3,
instrument the compiler compiling itself and count surviving `call_ref`
sites (weighted by profile hotness where available). If the residue
matters, add sparse interprocedural type propagation over ZIR —
per-function summaries + SSA cone propagation, emitting per-site
instantiated sets into the same devirt pass that consumes the global set
today. That is TFA grown incrementally on the IR, in the phase where it
belongs; the §10.1 harvest loop already accepts narrowed sets, so the
hook exists by construction.

## 3. IR structure

ZIR is a conventional CFG-of-basic-blocks SSA IR with **block parameters
instead of φ-nodes** (as in Cranelift and MLIR). A block declares typed
parameters; each predecessor's branch supplies arguments. This is equivalent
to φs but has no "all φs execute in parallel at the top of the block"
subtlety, simplifies the verifier, and maps directly onto wasm branches that
carry values.

```
fn @List_sum(%list: ref $List) -> i32 {
b0():
    %n    = struct.get %list, $List.length
    br b1(0, 0)                          // i, acc

b1(%i: i32, %acc: i32):
    %cond = i32.lt_s %i, %n
    br_if %cond, b2(), b3(%acc)

b2():
    %item = call @List_get(%list, %i)
    %acc2 = i32.add %acc, %item
    %i2   = i32.add %i, 1
    br b1(%i2, %acc2)

b3(%ret: i32):
    ret %ret
}
```

Core properties:

- **One definition per value.** A value is defined by exactly one instruction
  or block parameter. Uses must be dominated by their definition.
- **Blocks end in exactly one terminator**: `br`, `br_if`, `br_table`,
  `br_on_cast` / `br_on_cast_fail`, `ret`, `ret_multi`, `ret_call`,
  `ret_call_ref`, `try_br`, `throw`, `unreachable`. The two `ret_call`
  forms are `call`/`call_ref` with no result — a `tail return` lowers
  the call and rewrites it in place ([tail-calls.md](tail-calls.md) §4).
- **Instructions are typed** with the existing `ValType` from
  `codegen/wasm.zena` — i.e. ZIR types are _lowered wasm-GC types_
  (`i32`/`i64`/`f32`/`f64`, `ref $Struct`, `ref null $Sig`, `anyref`, …), not
  semantic checker `Type`s. By lowering time, monomorphization has already
  produced concrete `WasmStruct`s, and reusing `ValType`/`WasmType` (with its
  process-unique `uid`) avoids a parallel type universe. Semantic identity
  that optimization still needs (which class, which method slot) rides along
  as instruction metadata, not as a type system (§5).
- **The CFG is always reducible.** Zena has no `goto`; lowering from
  structured source produces reducible CFGs, and no planned pass introduces
  irreducibility (jump threading is restricted to not duplicate loop headers
  into their own bodies). The emitter (§12) relies on this.

### 3.1 The level question: one IR, not two

`optimizations.md` sketched HIR (Zena-semantic, structured) + LIR (basic
blocks). The Gemini-style textbook pipeline suggests mid + low tiers. We build
**one tier**. Rationale:

- Wasm GC is itself high-level: typed structs, checked casts, GC allocation.
  The gap between "Zena semantics minus sugar" and "wasm GC instructions" is
  small — mostly dispatch and pattern matching, which ZIR makes explicit. A
  second tier would be near-isomorphic to the first.
- Every additional tier is a full extra data structure + lowering + tests,
  paid for in a compiler that's already fighting compile-time budgets.
- What LIR would have done (local assignment, stack scheduling) is an
  _emission algorithm_ (§12), not a data structure worth materializing.

By the time code is in ZIR, all of the following are **already explicit**:
operator overloads are calls, pattern matches are test/branch chains, for-in
is iterator calls, string interpolation is builder calls, narrowing is casts,
field access is `struct.get` against a resolved field of a concrete struct. This matches the
`.zir` lowering inventory from `separate-compilation.md` ("no operator
overloading, no pattern matching, no for-in") — that document's instinct was
right; it just lacked a CFG.

## 4. Data-oriented encoding

This section is the performance heart of the design. **No per-instruction
heap objects.** A function body is a handful of parallel flat arrays indexed
by instruction id; a value id _is_ the id of its defining instruction (block
parameters get ids too, so the value namespace is uniform).

```zena
// All arrays indexed by InstId (i32). Value = InstId of the def.
final class IrBody {
  // Instruction stream, grouped by block, in emission order.
  var opcode:   FixedArray<i32>;   // Opcode enum
  var typeId:   FixedArray<i32>;   // index into typeTable; -1 for void
  var a:        FixedArray<i32>;   // operand 0: value id, or payload
  var b:        FixedArray<i32>;   // operand 1: value id, or payload
  var extra:    Array<i32>;        // overflow operands (calls, br args…)
                                   //   a = index into extra, b = count
  // Blocks.
  var blockStart: FixedArray<i32>; // first InstId of block b
  var blockEnd:   FixedArray<i32>; // one past terminator
  var blockParamCount: FixedArray<i32>;
  // Indirection tables (per function).
  var typeTable: Array<ValType>;   // §8: the specialization seam
  var refTable:  Array<IrRef>;     // module entities: functions, globals,
                                   //   structs, fields, string literals
  var constPool: …                 // i64/f64/big payloads
  // Side tables, populated on demand, invalidated by edit epochs:
  var srcSpan:  FixedArray<i32>;   // for diagnostics/source maps
}
```

Design rules:

- **Two inline operand slots + overflow.** The overwhelming majority of
  instructions (arithmetic, `struct.get`, casts, `br_if`) have ≤2 operands;
  calls and branch argument lists spill to `extra`. This is the
  Cranelift/`FIRM`-style layout and keeps the hot arrays dense.
- **Module entities are referenced through `refTable`**, a small per-function
  array of `IrRef` (a sealed class over `WasmFunction | WasmGlobal |
WasmStruct | field | data-segment | …`). Instructions store an `i32` index
  into it. This keeps the instruction stream free of object references
  (cheap to copy — see §8 — and trivially serializable — see §13), while a
  single indirection resolves to the live object during a pass.
- **Analyses are side tables computed on demand**, not maintained
  incrementally: def-use counts (one `i32` array), dominator tree
  (Cooper–Harvey–Kennedy over the block array), liveness (per-emission).
  Passes that mutate bump an epoch; analyses cache against it. We explicitly
  do **not** maintain LLVM-style intrusive use-lists — they're the classic
  source of both bugs and allocation churn, and every pass we've planned is
  happy with "recompute use counts in one linear scan".
- **Mutation model: append + forward.** Passes never splice arrays.
  Rewriting an instruction means overwriting its slot in place (same arity)
  or marking it `Nop`/`Alias(target)`; a periodic `compact()` renumbers and
  drops dead slots (also run before serialization and emission). Inlining
  appends the callee's (renumbered) instructions and blocks. This makes every
  pass a linear scan plus O(changes), never O(n) shifting.
- **Growth strategy**: bodies allocate arrays sized from a lowering-time
  estimate (AST node count is a good predictor and already available), so the
  common case is zero reallocation during lowering.

Why this matters here specifically: on wasm GC, a pointer-graph IR (an object
per instruction, arrays of references, use-list nodes) would generate tens of
millions of small allocations while compiling the compiler. Flat `i32` arrays
are unboxed after monomorphization (`array<i32>` under `FixedArray<i32>`),
scan at memory bandwidth, and copy with `array.copy`.

### 4.1 Value types (inline classes) and this layout

Zena has no non-heap objects yet — `inline` tuples give allocation-free
_returns_ (wasm multi-values), but there is no Valhalla-style `inline
class` for allocation-free _storage_. Does that blunt the data-oriented
design? No, and the reason is a target-level fact worth stating plainly:

- **The hot side of `IrBody` contains no references.** `opcode`, `typeId`,
  `a`, `b`, `extra`, the block arrays — all `FixedArray<i32>`, which
  monomorphizes to wasm `(array i32)`: unboxed scalars, no per-element
  objects. Structure-of-arrays _is_ the substitute for value types, and
  for pass workloads (linear scans touching two or three fields) it is
  generally the better layout than array-of-structs anyway.
- **Wasm GC cannot express the alternative.** There is no inline struct
  storage in wasm GC: `(array (ref $S))` stores references, and no
  `(array $S)`-of-inline-structs exists. A future `inline class` on this
  target must therefore _compile to_ scalarization — multi-values in
  signatures, parallel scalars in storage — i.e., exactly the layout ZIR
  hand-writes. Language-level value types would improve the ergonomics of
  this file, not the achievable memory layout. We are not leaving
  performance on the table by not waiting for them.
- **Where references legitimately remain** — `refTable`/`typeTable` — the
  counts are per-_entity_ (tens per function), not per-instruction, and
  they're touched only at resolution points. Object population per
  function is one `IrBody` plus ~ten array objects: thousands of
  allocations per compile, not tens of millions.

What we pay meanwhile is ergonomics: index juggling and hand-packed pairs.
Mitigations that exist today: accessor/cursor helpers on `IrBody` (an
`i32`-taking view API, no wrapper objects), `inline` tuples for multi-value
returns like `span(i): inline (i32, i32)`, and `FixedArray` (intrinsic
`array.get`, wasm-level trap) rather than `Array` (user bounds check +
throw) in hot loops.

**Can inline classes come later? Yes, locally.** An `inline class
Span(start, end)` would replace the hand-packed pairs and inline-tuple
plumbing site by site, with zero change to the array-level layout — its
fields flatten into the same parallel arrays and multi-values. Nothing in
ZIR forecloses the feature; adopting it is mechanical cleanup.

**Should we build them now? No — decouple.** Inline classes still carry
open language questions (identity and `==`, `is` on erased values,
interaction with unions — which deliberately exclude primitives, and an
inline class _is_ primitives —, mutability, interface conformance), and
putting them on ZIR's critical path couples M1 to a language-design
schedule. The two features also meet in the middle: ZIR's SRoA is
"automatic value types for objects the optimizer proves non-escaping",
which relieves some of the pressure for the language feature; and when
`inline class` does land, lowering implements it with the same
scalarization machinery ZIR already has (multi-values + parallel scalars),
so building ZIR first makes the language feature _cheaper_, not harder —
with this file as its natural first dogfood.

## 5. Instruction set

Grouped inventory; the exact opcode list will live with the implementation.
"meta" = payload in `a`/`b`/`extra`, resolved through `refTable`.

**Constants & arithmetic** — `iconst`/`fconst` (pool-indexed), full wasm
numeric ops 1:1 (`i32.add`, `f64.div`, comparisons, conversions). No novelty;
carrying wasm's own opcodes makes folding rules table-driven and emission an
identity map.

**Aggregates (classes, records, tuples, closures)**

| Instruction                          | Meaning                                                    | Emits as         |
| ------------------------------------ | ---------------------------------------------------------- | ---------------- |
| `struct.new S, args…`                | allocate class/record/tuple/env `S`                        | `struct.new`     |
| `struct.get v, S.f` / `struct.set`   | field resolved symbolically; index bound at layout (§10.2) | `struct.get/set` |
| `array.new/get/set/len/copy E`       | array intrinsics                                           | 1:1              |
| `null T` / `is_null` / `as_non_null` |                                                            | 1:1              |

Classes are **already lowered** here: a `struct.new $Point_VTable…` for the
vtable-carrying layout that `Specializer.populateClassStructAndMethods`
computed, fields addressed by index. ZIR does not know what a "class" is —
but it knows _which_ struct a given allocation creates and keeps the
class-key as metadata on the allocation for CHA queries.

**Dispatch — vtables are represented, decomposed**

Vtable _contents_ are a compile-time-constant mapping the optimizer may
query: `(classKey, memberId) → implementation`, maintained by RTA/CHA.
The physical artifacts — the vtable struct types and the immutable
`WasmGlobal` initializers (today built eagerly in RTA Pass 1.5–2) — are
**materialized only after the optimization fixpoint** (§10.2), from the
slots that survive. ZIR therefore never references a numeric slot; vtable
_operations_ are explicit instructions carrying symbolic metadata:

```
%vt   = vt.load %obj                 ; struct.get of the vtable field;
                                     ;   meta: classKey
%f    = vt.slot %vt, <member>        ; struct.get on the vtable struct;
                                     ;   meta: (classKey|ifaceKey, memberId)
%r    = call_ref %f, args…           ; meta: signature
```

Devirtualization then has two independent triggers, both local pattern
matches (§9):

1. **Exact type**: `%vt` traces (through SSA, no aliasing questions) to
   a `struct.new` or to a `global.get` of a known singleton → the class
   is exact, so `vt.slot`'s `(classKey, memberId)` resolves through the
   constant vtable-contents mapping to a single `WasmFunction` →
   `call_ref` rewrites to `call`.
2. **CHA/RTA**: `vt.slot`'s metadata names the (class, member). Query
   `ClassHierarchyAnalysis.findInstantiatedSubclasses` + override tables:
   exactly one reachable implementation → rewrite to `call` (guarded by
   nothing — whole-program closed world). A small number (≤ N, sealed) →
   optionally a `br_on_cast` chain (speculative if-ladder), decided by the
   size/speed flag.

This is why decomposition beats a monolithic `call_virtual` instruction: (1)
is pure constant folding with zero class-hierarchy knowledge, and (2) is a
metadata lookup. Both leave dead `vt.load`/`vt.slot` instructions behind for
ordinary DCE, whose disappearance is what lets §10.2 shrink the vtable's
final layout — or skip materializing it entirely.

**Interfaces — fat pointers explicit**

```
%fp = iface.pack %obj      ; struct.new of _FatPtr; meta: (classKey, ifaceKey)
%vt = iface.vtable %fp     ; struct.get fatptr.vtable
%o  = iface.instance %fp   ; struct.get fatptr.instance
```

`iface.pack` names its (class, interface) pair symbolically — the physical
per-pair vtable global it will reference is materialized at layout (§10.2),
and only for packs that survive. `iface.pack` is also the SRoA jackpot
(§9): when a fat pointer's uses are all `iface.vtable`/`iface.instance`
(after inlining made them local), the pack evaporates, dispatch
constant-folds through the pair's known vtable contents, and the interface
costs nothing.

**Casts, tests, narrowing**

`ref.test T`, `ref.cast T` as value instructions; `br_on_cast T` /
`br_on_cast_fail T` as terminators with two successors, the cast-success
edge carrying the narrowed value as a block argument. The checker's
narrowing decisions arrive from lowering as explicit casts (each narrowed
use site reads `model.getNodeType`); after that, narrowing is
invisible to ZIR — it's just types. Redundant-cast elimination is then a
dominance query: a `ref.cast T` dominated by a successful `ref.cast T`/
`br_on_cast T` edge on the same value folds away. The runtime-type-tag rules
(`runtime-type-tags.md`) are enforced by the checker before we get here; ZIR
never invents a test the checker didn't sanction.

**Calls** — `call @f, args…`, `call_ref`, `throw $tag, args…`, plus
`call.intrinsic` for the small set of ops codegen special-cases today
(string interning access, `__array_new`, etc.). Every call site carries a
`refTable` entry, so the callgraph is one scan per body.

**Strings**: string literals stay module-level interned data (the shared
data segment + `get_string_literal` machinery in `module-generator.zena` is
untouched). ZIR references a literal as `str.lit k` (meta: literal id),
which emits as the existing helper call / global access. The banked
interning win is preserved by construction.

### 5.1 Exceptions

Zena has `throw`/`try`. Model: a block may carry an optional **handler edge**
(`handlerBlock: BlockId | -1`, a per-block side array). Semantics: any
may-throw instruction in the block (calls, `throw`, trapping ops if we choose
to route them) may transfer to the handler block, whose single parameter is
the exception value. Constraints on passes:

- May-throw instructions are **effect-ordered**: they don't reorder with each
  other or with stores, and DCE never removes them (removal only via inlining
  a callee proven non-throwing — a cheap bottom-up module analysis we get for
  free from the callgraph scan).
- Code motion never moves an instruction into or out of a handled region.
- A handler edge leaves from _anywhere_ in the region, so it can carry no
  per-variable SSA state: values threaded along it can only be the ones
  live at region entry. Locals the region ASSIGNS therefore cannot ride
  it — the handler would not see an assignment the body completed before
  it threw. **Mutable variables** (below) cover exactly that gap. Any
  future handler-edge representation has to keep the split.

Emission reconstructs wasm `try_table` nesting from handler-edge structure;
since lowering only ever produces properly nested handled regions and passes
can't create new handler edges, this reconstruction is straightforward
(§12). This is deliberately conservative — optimizing _across_ try
boundaries is out of scope for v1; optimizing _within_ them (the common
case: a hot loop inside a `try`) works fully.

#### 5.1.1 Mutable variables

Wasm locals survive an exception unwinding to a handler in the same
frame; SSA values do not, because a value is a _definition_, reachable
only along edges from its defining block. ZIR therefore has one
non-SSA construct, used for nothing else:

    var_get v      -> value          ; reads variable v
    var_set v, x                     ; writes x into variable v

`IrBody.varTypes` declares them; emission gives each its own wasm local
and keeps it out of copy coalescing, so nothing else can land there.
Reads are not value-numbered — GVN's key function returns null for both
ops, which falls out of its pure-op whitelist.

Lowering uses them only for the enclosing locals a `try` body assigns.
The binding stays an ordinary SSA variable: reads, merges and loop
carries are untouched, so nothing about using such a variable gets
slower. What changes is that every assignment ALSO writes the mirror
(`LoweringContext.noteVarWrite`), the mirror is seeded at try entry,
and the handler block seeds its environment by reading it back. Past
the join both arms arrive as ordinary merge params and the mirror goes
out of scope. Nested tries share one mirror per symbol — the innermost
handler wants the same "last value written" the outer one does.

The one place this cannot work is a `gen`/`async` body, whose locals do
not survive a suspension. There the same symbols are boxed into heap
cells (the closure-capture mechanism), decided in the checker on the
enclosing function and asserted by a ZIR bail if the two disagree.

### 5.2 Traps

`array.get` out of bounds, `ref.cast` failure, integer division — wasm traps.
ZIR marks these `can_trap`. Policy (matching wasm-opt's default and LLVM's
practical stance): a trapping instruction whose _result is unused_ may be
removed only if the pass proves it cannot trap (e.g. index provably in
bounds, cast provably succeeds via dominating test); otherwise it stays.
Trap-preserving is the correctness default; a later `--trap-relaxed` flag can
loosen this for size if we ever want it.

## 6. Lowering (AST → ZIR)

`codegen/ir/lowering.zena` (with `LoweringContext` and the per-construct
modules around it) replaced the emission half of the streaming
`FunctionGenerator` while keeping its _semantic_ half — all the knowledge
about how constructs translate (constructor prologues, cell-boxing for
captured mutables, argument adaptation, match compilation) transferred
over; the difference is the output is ZIR instructions instead of emitter
calls.

SSA construction uses the standard technique for structured input (Braun et
al. 2013, "Simple and Efficient Construction of SSA Form"): per-block
variable→value maps, sealed blocks, on-demand block parameters. Because Zena
is expression-oriented and `let` dominates, most values are born SSA; only
`var` locals and loop-carried state generate block parameters at merge
points. Cells (mutably captured variables) remain heap cells — that's a
semantic requirement from closures, not an SSA question; SRoA can still
scalarize a cell whose closure never escapes (post-inlining).

Lowering is **per-function and embarrassingly parallel** — it reads the
(immutable) AST + `SemanticModel` and the (frozen-by-then) RTA outputs, and
writes a fresh `IrBody`. Even before any threading exists, this discipline
keeps the door open (`self-hosted-compiler.md` "prepare for parallelism").

The streaming path (`FunctionGenerator` → bytes) remained in the tree
during the migration behind a backend flag and was deleted at M4 (§14)
once ZIR reached parity.

## 7. What ZIR deliberately does NOT contain

- **Vtable/struct layout decisions** — RTA/Specializer own _membership_
  (which fields/candidate slots exist); final numbering is assigned
  post-fixpoint (§10.2). ZIR holds only symbolic (class, member) and
  (class, field) references.
- **Checker `Type`s** — only lowered `ValType`s plus metadata keys. If a
  pass needs semantic info (CHA, effective finality), it asks the RTA-era
  tables through metadata keys; it never re-derives types.
- **Wasm index space numbers** — `refTable` holds object references;
  `wasm.layout()` assigns indices after pruning, exactly as today. (This
  also kills the documented O(N²) linear scans: ZIR construction gets its
  `WasmFunction` references from RTA's existing maps once, at lowering.)
- **Scopes, names** — values are numbers; `srcSpan` + a debug-names side
  table exist only for diagnostics and WAT comments.

## 8. Generics: specialize the IR, not the AST (v2)

The monomorphization explosion is the top compile-time bottleneck, and its
cost is not the _number_ of instantiations so much as **re-walking the AST
through `Specializer`/lowering for every one of them**.

ZIR's `typeTable` indirection is designed as the fix:

- **v1 (migration):** lower each specialized `WasmFunction` separately,
  exactly mirroring today's flow. Simple, no new invariants; the instruction
  streams of `Box<i32>.get` and `Box<String>.get` are duplicates that differ
  only in types. This is still faster than today per-instantiation (walking
  the small checked AST once instead of doing full emission logic), but it's
  the same asymptotics.
- **v2 (template ZIR):** lower each _generic source function_ _once_ to a
  polymorphic body whose `typeTable` entries may be symbolic (type-parameter
  slots) and whose `refTable` entries may name unspecialized members.
  Specialization becomes: `array.copy` the instruction arrays (they are
  type-argument-independent by construction — all type references go through
  the tables), substitute the ~tens-of-entries `typeTable`/`refTable`, and
  run one local simplify pass. That turns per-instantiation cost from "walk
  and re-emit a function" into "memcpy + patch a small table".

  v2 requires that instruction _selection_ not depend on the type argument.
  Where it genuinely does (e.g. `==` on `i32` vs a reference type inside a
  generic), lowering emits a `generic.op` instruction that specialization
  resolves — a small, enumerable set, because the checker already forces
  these operations through known interfaces/intrinsics.

RTA still decides _which_ instantiations exist (nothing changes in
discovery); v2 changes only how their bodies are produced. This is also the
prerequisite for caching generic code on disk (§13) — you cannot cache what
you can only produce whole-program-specialized.

## 9. Optimization pipeline

The implementation plan for this section and §10 — per-pass designs,
the driver, and build order — is `optimization-pipeline.md`.

Per `optimization-strategy.md`'s phasing, correctness and explicit wins
first, then the implicit/global loop. Passes, in rough build order:

**Foundation (with the IR itself):**

- `verify` (§11), `simplify` (peephole + constant folding, table-driven off
  wasm opcodes), `dce` (use-count worklist; respects `can_trap`/effects),
  `blockmerge` (straightline block fusion, dead-edge removal after folding).

**The semantic loop:**

- `inline` — bottom-up over the callgraph (SCCs handled with a budget
  cutoff). Heuristics: always inline trivial bodies (accessors — the
  synthesized getter/setter functions, `vt.load`-only wrappers, single-call
  adapters); size-budgeted otherwise, budget scaled by `-Os`/`-O2`. Inlining
  is block-splice + `refTable`/`typeTable` merge + argument-to-parameter
  rewiring — no AST involvement.
- `devirt` — the two triggers from §5. Also **interface-to-class**
  devirtualization: `iface.pack` metadata names the concrete class, so a
  fat-pointer dispatch whose pack site is visible devirtualizes even before
  SRoA runs.
- `sroa` — escape analysis over one allocation's SSA uses. If a
  `struct.new`/`iface.pack`'s value never escapes (all uses are
  field get/set, tests, or as receiver of devirtualized calls after
  inlining), replace fields with SSA values (block parameters where control
  flow merges). Fat pointers and iterator objects are the primary targets;
  closure environments whose closure was inlined are the secondary one.
- `sccp` — sparse conditional constant propagation: constants, unreachable
  branch pruning, and (because tests are values) cast-outcome propagation.
- `licm`-lite and `gvn` — later; explicitly not required for the first
  useful loop.

**Signature specialization.** Because compilation is whole-program, direct
call edges are fully rewritable: a pass may scalarize a fat-pointer
parameter into `(instance, vtable)` params, drop dead parameters, or clone a
function for a constant argument, rewriting all callers. The only pinned
signatures are functions **whose reference is installed in a typed vtable
slot or escapes as a first-class value** — wasm `call_ref` requires the
stored funcref to match the slot's declared signature. Those keep a thin
adapter with the slot's signature that tail-calls the specialized body;
direct callers bypass the adapter. (This narrows the blanket "no fat-pointer
flattening across ABI boundaries" rule in `interfaces.md`: the invariant is
per-_slot_, not per-_function_, and adapters make it a non-restriction for
everything except the slot itself.)

**Driver.** The classic fixpoint with a cap:

```zena
let optimizeModule = (m: IrModule, opts: OptOptions) => {
  for (let round in 0..opts.maxRounds) {        // 2–3 in practice
    var changed = false;
    for (let f in m.bodies) {                   // per-function, parallel-ready
      changed = inlinePass(f)  || changed;
      changed = devirtPass(f)  || changed;
      changed = sroaPass(f)    || changed;
      changed = sccpPass(f)    || changed;
      changed = simplify(f)    || changed;
      changed = dce(f)         || changed;
    }
    if (!changed) break;
  }
};
```

No generalized pass-manager framework (dependency graphs, invalidation
registries) in v1 — `optimizations.md` sketched one; we defer it until the
pass count demands it. A fixed pipeline function is debuggable and fast.

**Flags.** `-O0` = lower + emit, no loop (fast dev builds, the default for
`--backend=zir` until parity). `-O1` = foundation passes. `-O2` = the loop.
`-Os/-Oz` = the loop with inline budgets down and the br_on_cast-ladder
devirt capped. This slots into the flag matrix `optimizations.md` proposed.

## 10. Post-optimization reachability (the harvest pass)

After the loop settles, a module sweep computes the _true_ live set by
scanning `refTable` entries reachable from exports/`main`/`__start`:

- functions never referenced (dispatch fully devirtualized away, bodies
  fully inlined) → dropped before `layout()`;
- struct/array types unreferenced by any live instruction, global, or other
  live type → dropped from the type section;
- interface fat-pointer types with no surviving `iface.pack` → dropped;
- vtables, trampolines, and accessors are handled by _not materializing_
  them in the first place — physical vtable artifacts don't exist yet at
  this point; §10.2 builds them from what the sweep found live.

This pass is ~100 lines against ZIR versus the 2,000-line AST-side RTA,
because all the hard questions (what can this dispatch reach?) were already
answered by rewriting. It is also where empty-vtable elimination and
method-level DCE (`dead-code-elimination.md` future tiers) fall out for
free.

### 10.1 The sweep feeds back into devirtualization

AST-side RTA computes its instantiated-class set against the
_un-optimized_ program, and optimization only ever shrinks the truth:
SCCP deletes a constant-false branch that held the only `new FooImpl(…)`;
inlining + DCE remove the last call to the factory that allocated `Bar`.
Pruning the output (above) handles the _liveness_ consequence, but not the
_precision_ consequence: devirtualization decisions made with the stale
set are needlessly conservative — an interface call that saw two candidate
implementations may in truth have one, and a `ref.test`/`br_on_cast`
against a class with no surviving allocation site could fold to
false/never-taken.

So the harvest sweep is a loop, not a single pass:

1. Sweep: compute live functions/globals/types; additionally **recompute
   the instantiated-class set from surviving allocation sites**
   (`struct.new` of class structs, live singleton-global references) — a
   linear scan over the same operands the sweep already visits.
2. If the instantiated set shrank relative to what devirt last used:
   rerun `devirt` + `simplify` + `dce` with the narrowed set (single-
   implementation folding, cast-outcome folding), then go to 1.
3. Stop when the set is stable.

Convergence is guaranteed — the set is finite and strictly monotone
decreasing — and fast in practice (one or two extra rounds; each round is
cheap because only devirt-relevant rewrites remain).

Note what we never do: re-run AST-side RTA. Its over-approximation is only
used to decide _what to lower_, and soundness there is all that's needed;
every subsequent fact is recomputed from the strictly-more-precise IR. The
residual cost we knowingly accept is compile time spent lowering and
optimizing functions that later rounds prove dead; eliminating that would
require interleaving discovery with optimization (lazy lowering on first
surviving reference), which stays out of v1.

### 10.2 Layout happens here, not in discovery

Vtable layout cannot be decided before the optimization loop, because the
loop changes what a vtable must contain: devirtualization can remove the
last dynamic dispatch through a slot (the method may stay live via direct
calls — it just no longer needs a slot), and can eliminate the need for a
class's vtable entirely. A layout fixed at RTA time would carry every
candidate slot into the binary. So layout is the _last_ step of the
harvest, computed from the settled IR:

- **Slot sets:** for each hierarchy root, the surviving slots are the
  union of members named by live `vt.slot` instructions across the
  hierarchy (dispatch through a supertype-typed receiver must use the
  same slot index in every subclass vtable, so slot assignment is
  per-hierarchy, in canonical declaration order for determinism).
  Subclass vtable struct types extend their superclass's — the wasm
  subtyping requirement falls out of the shared prefix.
- **Vtable existence:** a class hierarchy with no live `vt.load` at all
  drops its vtable globals, its vtable struct types, _and the hidden
  vtable field in the object structs_ — possible only because ZIR field
  references are symbolic and object-struct layout is also finalized
  here.
- **Materialization:** vtable globals (`VTableInit`) are built now, only
  for classes that are still instantiated and still dispatched-to.
  Interface trampolines and per-(class, interface) vtable globals are
  synthesized only for pairs with a surviving `iface.pack` — trampoline
  elimination (`optimizations.md` 🔲) falls out rather than being a pass.
- **Accessor pruning:** the synthesized virtual field accessors (today's
  RTA Pass 1.1–1.2) are materialized only for slots that survive.

This is the vtable analogue of §10.1's instantiation-set feedback, and
together they complete the principle stated in §2: discovery
over-approximates existence; nothing gets a number, an initializer, or a
byte in the binary until the fixpoint has spoken. What devirtualization
consumes during the loop is never a physical layout — only the
`(classKey, memberId) → implementation` mapping (§5), which is stable
under slot renumbering by construction.

One consequence for the migration plan: at `-O0` (no loop), the harvest
runs with the IR exactly as lowered, so "candidate layout" and "final
layout" coincide and M1/M2 need no special-casing — layout is simply
always a post-loop activity, with a loop of zero rounds.

## 11. Verifier and testing

**Verifier** (debug builds / `--verify-ir`, off in release): SSA dominance,
terminator well-formedness, block-argument arity/type agreement, `refTable`
index validity, type agreement between defs and uses, handler-edge nesting.
Run after lowering and after each pass in verify mode. Failures are fatal
and loud — consistent with the project's no-fuzzy-fallback rule; a broken
invariant must never limp into emission.

**Testing strategy** (per `optimization-strategy.md` doctrine):

1. The portable execution suite (`tests/language/execution/`) must pass
   identically under `--backend=zir` at every optimization level. This is
   the semantic gate.
2. **Golden WAT tests per optimization**: assert `call $Circle_print`
   appears and `call_ref` doesn't for a devirt fixture; assert no
   `struct.new $..._FatPtr` after SRoA of a non-escaping interface use; etc.
3. **Differential self-compile**: stage1 (bootstrap-built) and stage2
   (self-built) compilers must produce byte-identical output — the existing
   parity harness extends to the ZIR backend, and pass determinism is a hard
   requirement (no iteration-order-dependent rewrites; all worklists are
   index-ordered).
4. The benchmark suite (`test-files/benchmarks/`) gates compile-time _and_
   output-size/speed regressions per level.

## 12. Emission (ZIR → wasm bytes)

Three sub-steps, all per-function, feeding the existing
`BinaryEmitter`/`WatEmitter` unchanged:

1. **SSA destruction.** Block parameters become copies in predecessors
   (with the standard parallel-copy sequentialization for swaps). Most
   copies then dissolve in step 3's coalescing.
2. **Control-flow reconstruction.** The reducible CFG is turned back into
   wasm's structured `block`/`loop`/`if`/`br_table`/`try_table` via the
   dominator-based stackifier (Ramsey, _Beyond Relooper_, ICFP 2022 — the
   algorithm wasm-tooling has converged on). Reducibility is an IR
   invariant (§3), so no node-splitting path is needed.
3. **Stack scheduling + local coalescing.** A value defined and used exactly
   once, in the same block, with uses in def order and no interfering
   effects between def and use, rides the wasm operand stack and never
   touches a local (this reconstructs the expression trees that today's
   direct AST walk gets for free — without it, ZIR output would be
   `local.set`/`local.get` soup). Everything else gets a local; locals are
   assigned per-type by linear scan over live ranges, reusing slots whose
   ranges ended (first-fit; no graph coloring needed since spilling doesn't
   exist). This subsumes today's ad-hoc scratch-local machinery
   (`FunctionContext.allocLocal`/`getStructScratchLocal`) and preserves the
   typed-scratch-local win (locals are typed `ref $T`, casts not
   reintroduced).

Since there is no wasm-opt behind us, emission quality is on us: the
combination of simplify/DCE (pre-emission) + stack scheduling + local
coalescing (at emission) is the floor we own. What we consciously _don't_
build: instruction scheduling beyond stack-order (engines re-schedule),
and binary-level tricks like code-section sorting (possible later).

### 12.1 Type-accurate locals: no nullable widening

Declared wasm types must equal Zena types everywhere a value is
stored — in particular, Zena non-nullable references land in
`(ref $T)` locals, never `(ref null $T)`. Engines don't null-check
`local.get`/`local.set` themselves, but inaccurate local types cost
real money at the _uses_: an explicit `ref.as_non_null` re-assert
compiles to a compare-and-trap (there is no dereference for the
trap-handler trick to ride), and a nullable declared type pessimizes
engine-side redundant-check elimination, `call_ref` handling, and
inlining even where the hardware makes the check itself free.

The obstacle is wasm's _scoped_ initialization tracking for
non-defaultable locals (all rules below verified against wasm-tools):
a `local.set` is forgotten at the `end` of the block containing it,
even when control provably flowed through it — and the rollback is
uniform, not a join: setting the local in BOTH arms of an `if`/`else`
still counts as uninitialized after the `end`. Only a set in an
enclosing scope persists (into nested blocks and past their ends).
Structured init visibility is strictly weaker than CFG dominance.
This is exactly why the interim every-value-a-local emitter stores
non-null values in nullable locals: its synthetic merge labels
routinely sit between a def and its uses, and a merge parameter's
copies _always_ sit inside the label they branch to, with the reads
after its `end`.

The reason full accuracy is reachable at all is a source-language
theorem: Zena scoping puts every source local's single initialization
point lexically before all reads, in the same or an enclosing scope —
so a wasm structure mirroring the source always has the set in a
block enclosing every get, which the persistence rule accepts. ZIR's
CFGs only
ever come from lowering structured source, so that structure is
always recoverable. Emission owes every local an accurate type,
through five mechanisms:

1. **Signature params** are exact already, non-null receivers included.
2. **Stack scheduling** (step 3) removes the locals entirely for
   single-use values in def order — the operand stack is typed exactly
   by the IR.
3. **Label elision**: a merge whose predecessors all reach it by
   structural fallthrough (both arms of an `if` running off their
   ends) needs no labeled block at all; eliding the label — and first
   the `br`s that a naive translation aims at it — restores the
   source-shaped scoping in which defs before the construct stay
   init-visible after it. The uniform wrap-every-merge form is the
   M2 simplification, not a requirement.
4. **Typed labels and phi-web coalescing**: Zena has no deferred-init
   locals — every declaration carries its initializer — so "a value
   set on multiple paths" is never a source construct; it is a shape
   LOWERING manufactures when it flattens the two idioms that produce
   join values. Each maps back to a single-init encoding:
   - A conditional-expression initializer
     (`let x = if (y) foo else bar`, match expressions) becomes a
     merge parameter in ZIR; the wasm-native encoding un-flattens it —
     the value rides out as a construct result / typed-label operand
     (`(if (result (ref $T)))`, `(block (param …))`,
     `(loop (param …))` for loop-carried values), and if multi-use,
     SSA destruction (step 1) materializes ONE `local.set` at the
     join, in the scope enclosing all reads.
   - A `var` reassigned across arms phi-joins in SSA, but local
     coalescing (step 3), by assigning the whole phi web to one
     local, reconstructs the source variable: its first set is the
     declaration's init in the enclosing scope, and arm assignments
     are re-sets, which init tracking ignores.
     The naive per-SSA-value emission that sets a local on each arm —
     the shape the validator rejects even when both arms set (per
     above) — is therefore always avoidable for source-derived CFGs;
     it only exists if the emitter chooses it.
5. **Init-discipline typing** as the backstop: type every local
   `(ref $T)` and demote to nullable only what a simulation of the
   validator's scoped init tracking rejects. Demotions are counted
   and reported under `ZENA_ZIR_STATS`.

Mechanisms 1, 2, and 5 are implemented, plus the label-placement half
of 3: a block's own instructions emit BEFORE its merge children's
wrapper labels open (the labels are only needed from the terminator
on), so a def is set in the scope enclosing the whole dominated
subtree and stays init-visible through it — with the exception of a
trailing streamed/teed producer chain that feeds the terminator on the
operand stack, which must stay adjacent to its consumer because wasm
frames cannot carry operands across a `block` boundary.

Mechanism 5 works by replaying the validator rather than
approximating it (`#initNonNullTracking` / `#finishNonNullLocals` in
emit.zena): the validator's own init state — sets forgotten at their
block's `end`, uniform rollback, enclosing-scope persistence — is
maintained live during the single emission pass, at the scope, set,
and get points the emitter already runs through. A get of an
uninitialized candidate demotes it on the spot. A `#copyArgs` move
transfers the source local's declared type, so a destination
graduates only when every source ends at the same non-null type — a
fixpoint at the end of the body demotes across copy chains, move
temps included. Mutable variables and multi-value projections need
no special casing: their sets and gets hit the same hooks.

Because graduation is decided after the body, its two outputs are
assembled late: re-asserts on candidate reads are emitted
optimistically through `emitRemovableRefAsNonNull`, which records
where each landed, and both emitters build the function at
`emitFunctionCodeEnd` — the binary emitter skips the dropped
one-byte asserts during its existing body copy, and the WAT emitter
joins per-function head/body pieces so the locals declaration
prints the final graduated types. Binary and text stay aligned by
construction: the WAT never shows a `ref.as_non_null` the binary
does not pay for, because readers judge emitted code quality by the
text.

On the compiler's own module the split is ~34,100 ref locals
non-null against ~8,900 kept nullable (~52 KB of re-asserts
removed). The residue is dominated by conditional-expression join
values — merge params set on their in-edges, inside the arms'
scopes — which is exactly mechanism 4's territory (typed labels /
construct results), still outstanding along with label elision
proper. The counter also guards shapes the OPTIMIZER invents later
(post-M3 code motion and CSE can hand a temporary a live range no
lexical scope ever had): a pass that breaks the invariant shows up
as a number, not as silent widening.

For a demoted local that does survive, `ref.as_non_null` is inserted
only where the consumer's type discipline demands non-null (call and
branch arguments, non-null struct fields); dereferencing consumers
accept nullable refs with identical trap semantics and hardware-priced
checks, so they read the local raw. What we deliberately do _not_ do
is thread multi-use live-across values through label results (full
multi-value stackification): that trades cheap-or-free null checks for
real operand shuffling on every path. If the demotion counter ever
shows a hot residue, that decision gets revisited with data.

**Fields are the third leg** (after params — already accurate — and
locals, above), and the last piece of `non-nullable-refs.md` still
outstanding: struct fields today stay `(ref null $T)` because
`struct.new_default` requires every field defaultable, and the
allocate-then-mutate constructor protocol depends on it. The plan is
to move construction to **single-shot `struct.new`** — constructors
evaluate field defaults, the initializer list, and the super chain's
contributions into values, then allocate fully initialized — at which
point field types flip to `(ref $T)` and `struct.get` on a non-null
field returns non-null with no re-assert. This was deliberately
scheduled **after M4** (§14): struct types are module-global and the
construction protocol was a cross-backend ABI under per-function
fallback, so the flip could not be made for one backend at a time.
With M4 complete, this arc is unblocked.

## 13. ZIR as a disk format for incremental compilation

Short answer: **yes — this design is chosen partly to make that cheap — but
it ships as a separate milestone after the in-memory IR stabilizes.**

What makes `IrBody` serialization-friendly by construction:

- The instruction stream is flat `i32` arrays → serialization is length
  prefixes + raw array bytes; deserialization is bulk reads with no pointer
  fixup inside the stream.
- All external references are corralled into two small tables. On disk,
  `refTable` entries become **symbolic**: stable names/keys (function
  symbol path + specialization key, class key + field symbol, literal hash)
  instead of object references; `typeTable` entries serialize as structural
  type descriptions keyed the same way RTA's dedup caches already key them.
  Loading = resolve two small tables against the current compilation, then
  use the instruction stream untouched.
- v2 template ZIR (§8) solves the _what-do-you-cache_ problem for generics:
  cache the polymorphic template per source function; instantiate at link
  time by table substitution. Without templates, a per-file cache can't
  hold monomorphized bodies (they depend on type arguments discovered
  whole-program), which was an unresolved tension in
  `separate-compilation.md`.

The two-phase model from `separate-compilation.md` maps on directly, with
its `IRExpr` tree replaced by ZIR bodies:

- **Phase 1 — per file, cacheable, parallel:** parse → check → lower to
  template ZIR. Artifact: `.zir` = header (magic `ZIR\0`, format version,
  source hash, compiler version) + module summary (exports, class
  hierarchy fragment, interface impls — what link-time RTA needs without
  bodies) + per-function template bodies. Cache key: (source hash, ZIR
  format version, compiler version, dependency _interface_ hashes — the
  export-signature machinery in `compiler.zena:575` already computes
  exactly this).
- **Phase 2 — whole-program link:** load summaries → RTA over summaries →
  instantiate needed bodies from templates → §9 loop → §10 sweep → emit.
  Only phase 2 reruns on a cache hit, and phase 2's inputs are bulk array
  loads instead of parse+check.

Constraints to accept up front:

- The `.zir` format is **not stable across compiler versions** until we
  declare v1.0 (a version-mismatched cache entry is simply recompiled —
  the cache is a pure accelerator, never a correctness input).
- Whole-program passes (RTA, devirt, inlining, pruning) always rerun at
  link; the cache accelerates the per-file front half only. That is the
  right split: the front half (parse/check/lower) is where cold-compile
  time goes today, and the link half is exactly the part ZIR makes fast.
- Anything content-addressed must be deterministic — one more reason pass
  determinism (§11.3) is a hard requirement.

Non-goals here match `separate-compilation.md`: no intra-file incremental
codegen, no hot reload, no cross-version source compat.

## 14. Migration plan

Each milestone keeps the tree green; the old backend remains the default
until M4.

- **M1 — IR core.** `IrBody`/`IrModule` data structures, builder, printer
  (textual ZIR for tests/debugging), verifier. Lowering for the
  straight-line + control-flow subset; `--backend=zir -O0` runs a growing
  slice of the portable execution suite. Emission via stackifier + trivial
  locals (every value a local — correctness first).
  _Status: complete._
- **M2 — parity.** Full construct coverage (classes, interfaces, closures,
  match, exceptions, generics-as-v1). Stack scheduling + local coalescing.
  Entire portable suite + self-compile parity green under `--backend=zir`.
  Benchmark: compile-time within budget of the direct backend (target:
  ≤1.15×; the extra IR pass is offset by cheaper emission and the removal
  of per-emission rediscovery).
  During migration, unsupported constructs fall back per function to the
  streaming generator — scaffolding with a scheduled demolition, not a
  permanent path. The enforcement ratchet is **strict mode**
  (`ZENA_BACKEND=zir-strict`): fallback becomes a fatal error naming the
  unsupported construct. M2's exit gate is the portable suite and
  self-compile passing under strict mode (zero fallbacks); until then,
  strict mode is the everyday tool for finding the next construct to
  lower.
  _Status: complete (2026-07-31) — the portable suite and the full
  self-compile pass strict mode with zero fallbacks; the benchmark
  gate held (self-compile 0.97× vs streaming at the flip)._
- **M3 — the loop.** simplify/DCE/blockmerge, then inline, devirt, SRoA,
  SCCP; golden WAT tests per pass; `-O2`/`-Os` wired. §10 harvest pass.
  Success metric: measurable size _and_ speed wins on the benchmark suite
  and on the compiler compiling itself (the compiler is our biggest, most
  interface-heavy program — it is the benchmark).
  _Status: in progress — GVN, stack scheduling, local coalescing, and
  loop-shape emission landed (geomean 0.58× vs streaming at deletion
  time; binary −21%); the inline/devirt/SRoA/SCCP fixpoint loop and
  the §10 harvest pass remain open._
- **M4 — flip the default.** Delete the direct `FunctionGenerator` emission
  path; ZIR backend becomes the only backend, and with it the fallback
  (and strict mode) cease to exist — any lowering gap is a hard compile
  error by construction, because there is nothing left to fall back to.
  Streaming's deletion also unblocks the deferred tail of
  `non-nullable-refs.md`: **non-null struct fields and single-shot
  `struct.new` construction** (§12.1). Field types are module-global and
  the construction protocol is a cross-backend ABI (a ZIR call site can
  invoke a streaming-compiled constructor and vice versa), so neither can
  flip while two backends coexist; once ZIR is the only backend, the flip
  is a single-backend change: constructors evaluate field defaults, the
  initializer list, and the super chain's contributions into values and
  allocate with one `struct.new` — `struct.new_default` retires along
  with the nullable field types it required.
  _Status: complete (2026-08-05, PR #132) — the streaming backend is
  deleted and ZIR is the only backend; lowering gaps are hard compile
  errors by construction. The non-null-fields / single-shot
  `struct.new` flip (§12.1) is now unblocked._
- **M5 — template ZIR (v2 generics).** Per-source-function lowering +
  table-substitution specialization. Success metric: cold-compile of
  `assert_test.zena` and `zena:test`-heavy files (the 47s case) drops by
  an order of magnitude class, not percent.
- **M6 — `.zir` on disk.** Serialization, cache directory, phase-1/phase-2
  CLI split per §13.

## 15. Risks and open questions

- **Compile-time regression before M3 pays off.** Mitigation: M2's ≤1.15×
  gate, the data-oriented encoding, and `-O0` staying loop-free.
- **Emission quality vs today's tree-shaped walk.** The direct backend gets
  expression-tree stack code for free; ZIR must re-earn it via stack
  scheduling. The M2 parity gate includes output-size comparison per
  portable test to catch `local` soup early.
- **Exception regions vs aggressive inlining**: inlining a `try` into a
  `try` nests handler edges; the emitter's nesting reconstruction must stay
  simple. If it doesn't, restrict inlining across handler boundaries in v1
  (rare in hot code).
- **Determinism discipline** is a standing tax on every pass (ordered
  worklists, no hash-iteration-order effects). HashMap iteration order in
  the stdlib must either be insertion-ordered or banned in passes.
- **v2 template soundness**: the claim "instruction selection is
  type-argument-independent modulo `generic.op`" needs an audit of lowering;
  the audit list is the set of places lowering branches on a
  substituted type.
- **Open**: do `vt.load`/`vt.slot` metadata keys reference RTA-era tables
  by classKey strings (as `wasm.vtables` does today) or by interned ids?
  (Strings are the current convention; ids are cheaper — decide at M1 with
  a measurement.)
- **Open**: does the §10 sweep subsume declaration-level DCE entirely, or
  do we keep AST-side usage analysis for check-time "unused" diagnostics?
  (Likely: keep for diagnostics, since post-optimization liveness is not
  what a "unused declaration" warning should reflect.)
- **Open (measure after M3)**: how many `call_ref` sites survive the
  optimization loop + harvest feedback on the compiler itself? That count
  decides whether the TFA-style interprocedural type-propagation pass
  (§2.3) is worth building.
