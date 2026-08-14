# Implementation Plan: Generators/Async, Value Semantics, Equality, Rows

Status: **Plan of record** (2026-08)

This sequences the feature arc decided across
[generators.md](generators.md), [records-and-tuples.md](records-and-tuples.md)
§3.1, [equality.md](equality.md), [row-types.md](row-types.md), and
[weak-references.md](weak-references.md), against the ZIR M-track
([ir.md](ir.md) §14) and bootstrap-compiler retirement (PLAN.md
Phase 1).

## Legend

Track letters and milestone numbers are used throughout this file and in
review discussion. Their definitions live in several documents, so they are
collected here.

| Label               | Meaning                                                     | Defined in                                                  |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| **Track G** — G0–G3 | Generators, then async                                      | Track: below. Milestones: [generators.md](generators.md) §9 |
| **Track V** — V0–V2 | Equality/identity contractions                              | Below; decisions D1–D4 in [equality.md](equality.md)        |
| **Track A** — A0–A3 | Rows and config records                                     | Below; detail in [row-types.md](row-types.md) §9            |
| **R3**              | "The flip" — the single breaking record-semantics migration | Below                                                       |
| **Track B**         | Representation harvest, post-flip                           | Below                                                       |
| **Track O** — O0–O4 | Ownership and resource management                           | Below; layers and decisions in [ownership.md](ownership.md) |
| **M1–M5**           | ZIR backend migration milestones                            | [ir.md](ir.md) §14                                          |

Two things that trip people up:

- **There is no R1 or R2 here.** The R-numbering originates in
  [row-types.md](row-types.md) §9, which proposed R1/R2/R3; this plan absorbed
  R1 and R2 into Track A and kept only the flip, which stayed named R3.
- **The M-track is not one of this file's tracks.** It is the ZIR backend
  migration in [ir.md](ir.md) §14, referenced here because several items
  depend on it. M1 and M2 are complete; M3 is in progress.

**Track O was adopted on 2026-08-06** (it is listed above; it was previously
carried here as a provisional label). Its layers, vocabulary and decisions live
in [ownership.md](ownership.md).

## Organizing principles

1. **Contractions early, in both compilers.** Bans (e.g. `===` on
   records) are cheap to implement twice and shrink the eventual
   migration — every month of delay grows code that depends on what we
   are about to remove.
2. **Expansions self-hosted-only.** New syntax and semantics land only
   in the self-hosted compiler, with `// @skip: bootstrap` portable
   tests. The bootstrap never learns them.
3. **Breaking flips bundle at bootstrap retirement.** One migration
   event (R3) for record semantics, not a drip.
4. **Generators/async first.** The G-track has no dependency on the
   records/equality arc, and it advances the M-track (fusion builds the
   M3 inliner's splice substrate) while rows want M5 (template ZIR) —
   so concurrency-first is also the infrastructure-optimal order.

## Track G — generators, then async (the priority track)

Milestones G0–G3 per generators.md §9. **Status: G0 (front end) and
G1 (the split pass) are implemented** — generators compile and run in
the self-hosted compiler. The split pass (`codegen/ir/generators.zena`)
lowers each generator body to presplit ZIR with `yield_` terminators
between RTA and layout, synthesizes the frame struct + `next()` +
`Iterator<T>` vtable global, and rewrites the body into a
dispatcher-loop state machine (reducible by construction; `br_if`
chain until `br_table` gains emit support). Generator closures
(immutable, mutable, and `this` captures) and specialized generic
generators work. Remaining v1 deviations, all loud: the RUNNING
poison state traps instead of throwing (an Error payload would pull
exception machinery into every generator program; waits for the async
runtime work), and a generic gen method reached only through erased
vtable dispatch fails with a clear error. Fusion is G2.

The async-specific refinement:

- **Async's prerequisite is G1 (the split pass), not G2 (fusion).**
  Fusion is the generator _performance_ story; async needs only the
  suspension transform. Critical path: **G0 → G1 → async v1**, with G2
  proceeding in parallel as capacity allows.
- **The async v1 design is [async.md](async.md)** (milestones A0–A3
  there). Its driver conclusion revises the earlier sketch: the event
  loop is a plain Zena library inside the module, so Level 0 (tests,
  internal completions) runs on today's unmodified hosts; timers ride
  WASI p1 `poll_oneoff`; JS-host completions are a tiny runtime-lib
  wrapper — **no JSPI**, no zena-cli changes until real native I/O;
  WASI P3's callback ABI maps onto step()/drain later.
- Churn guard: the split machinery is effect-kind-tagged from day one
  (generators.md §5.3) and G0 reserves `async`/`await` alongside
  `gen`/`yield`, so a later effect-row generalization — if it ever
  happens — is a new surface over the same transform, not a rewrite.

## Track V — equality/identity contractions (cheap, early)

- **V0 (both compilers, ~days):** ban `===`/`!==` on record/tuple
  operands (equality.md D1). Convert
  `tests/language/execution/records/adaptation_identity.zena` and
  `identity_nullable_matrix.zena` to expected-error tests; create the
  missing `tests/language/semantics/records/` folder. No codegen
  changes; the observability-guarded optimizations stay guarded until
  Track B.
- **V1 (survey first; lands in both compilers or at retirement,
  survey decides):** no-fallback `==` on classes + the
  `Equatable`/`Hashable` interfaces with derived value conformance
  (equality.md D2/D3). Prerequisite survey: every bare `==` on class
  operands in compiler + stdlib becomes `===` or gains declared
  equality. Separable; blocks nothing else.
- **V2 (opportunistic, class-only, independent of the records flip):**
  identity-hash injection + `IdentityMap` + inverted `WeakMap`
  (weak-references.md). Depends only on RTA field-injection machinery
  and V1's interface shapes.

## Track A — rows and config records (additive, self-hosted-only)

Per row-types.md §9, refined:

- **A0 — bounds infrastructure** (prerequisite; generics.md still says
  "unconstrained"): `T extends X` bounds on type parameters, plus
  member-level `where` clauses (equality.md D4 — needed for
  `contains where T extends Equatable`, and by A1).
- **A1 — row generics**: `R extends record`/`tuple`, type-level spread,
  lacks constraints, monomorphized instantiation with
  `ZENA_ZIR_STATS` counters. Coordinate with **M5** (template ZIR) for
  instantiation cost — don't block on it, but gate stdlib-hot-path
  adoption on it.
- **A2 — value-level ops**: disjoint extension spread, `with` update,
  rest patterns and typed `...rest` (record + tuple).
- **A3 — presence-optional record fields** (design:
  [record-presence.md](record-presence.md); the earlier type-level
  defaults design, config-records.md, is superseded): bitmask
  presence, patterns as the presence API, live destructured-parameter
  defaults, `Required`/`Partial`, fallback spread. Independent of
  A0/A1; **prerequisite V0** (projection copies need unobservable
  identity); the fallback-spread/`with` refinements ride A2. M4 is
  complete, so the constructor-side payoff (immutable fields via
  option-bag constructors) is unblocked.

## Track O — ownership and resource management (adopted 2026-08-06)

Detail, vocabulary and the decisions behind the ordering are in
[ownership.md](ownership.md); this is the schedule view. Track O is checker- and
front-end work — it wants nothing from the M-track and blocks nothing in G, V or
A.

- **O0 — the type lattice, no flow analysis.** `resource class`; a new
  `zena:ownership` with `Own<T>`/`Borrow<T>`/`Unmanaged<T>`/`Disposable`;
  `disown`/`adopt`; the `owned | disowned | moved | dropped` state flag; drop
  glue. Purely local rules only — owns are returnable, borrows are second-class,
  `Own → Borrow` is implicit at borrow-typed parameters. Move discipline is
  enforced at **runtime** here.
  **This is the milestone that matters for other work**: it freezes the
  signatures, so Track W's bindgen (component-model.md Part 8 stage 3) can
  proceed on O0 without waiting for O2, and `fs.open(): Result<Own<Descriptor>,
Error>` becomes writable.
- **O0.5 — `using`** and the scope-exit cleanup lowering (release on all exit
  paths). Same codegen O3 reuses, reached from the easier side. **Landed**:
  both forms parse, the checker requires `:dispose()` by member key, and
  lowering releases on normal exit, `return`, `break`/`continue` and exception
  unwind, in reverse declaration order. The release shares `try`/`finally`'s
  region — emitted once, in a dispatch outside the region — so the two nest
  through each other and a throwing `dispose` cannot release twice.
- **O1 — the checker flow graph.** TypeScript-style flow nodes built
  alongside the checker's walk (`analysis/flow.zena`). Independently
  justified; commits us to nothing about ownership. **Landed**: the graph,
  and assignment-aware narrowing validity on it — the narrowing soundness
  bug formerly in BUGS.md is fixed, and condition narrowing is now
  computed on the graph as well — the lexical narrowing stack is gone,
  compound loop conditions and expression-position `&&` narrow, an
  assignment narrows to what it stored, and `never`-returning calls end
  a path (ownership.md §"Landed: the graph, and narrowing on it").
  Still on the old recursion: `definitelyExits` and
  unreachable-code reporting; mutable-field narrowing builds on the
  graph from here.
- **O2 — affine move checking** on O1, with the meet-plus-edge-drops join rule.
  Upgrades O0's runtime detection to compile time; **no signature changes**.
  **Landed** for local bindings: moves are flow nodes (`Own`-parameter
  arguments — which makes `disown` consume — rebinding and field-store
  initializers, consuming-receiver calls), a use walks backward for a live
  move, and the loop back-edge rule is checked at loop exit
  (ownership.md §"Landed: moves on the flow graph"). Fields, aggregates and
  closure captures stay on the runtime flag; compensating drops are O3's.
- **O3 — implicit drop.** Needs O2, plus G1 for the per-state cancellation drop
  table (the liveness already exists in `generators.zena`). **Landed**: the
  scope-exit half — an unmoved, uncaptured `Own<resource>` `let` releases at
  its block's exit through `using`'s shared finally region — and the
  branch-join rule for `if`/`else`, with compensating drops at the
  non-moving arm's end (ownership.md §Implicit drop). Still open:
  value-block and parameter drops, `match`-arm joins, and the
  suspension/cancellation chapter.
- **O3.5 — `affine T` type parameters** and container opt-in, landing lazily one
  container at a time. The one cross-track dependency: needs **A0's member-level
  `where` bounds**. `Array<Unmanaged<Conn>>` covers the interim.
- **O4 — `isolated<T>`/`frozen<T>`/regions**, reusing O2. Reconcile
  concurrency.md's vocabulary first.

## R3 — the flip (one migration event, at bootstrap retirement)

Closed-by-default record types; literal exactness; `...` existential
syntax; width-by-projection replacing adaptation between static shapes;
`?` re-scoped to existential/parameter positions (A3 covers configs);
exhaustive destructuring; V1 lands here if its survey deferred it.
Because V0 and Track A shipped earlier, flip day is
assignability-and-representation only, and signatures can migrate to
`...R` forms ahead of time.

## Track B — the representation harvest (post-flip)

Ordered by payoff: delete the observability guards
(explosion/sinking/multi-value unconditional); records Phase 7
argument explosion; projection + prefix-chain-view lowerings; size-mode
shared lowering (row-types.md §7.4) wired to `-Osize`; SoA/`MultiList`;
`inline`-tuple destructuring relaxation.

## Dependency summary

| Work                    | Needs                             | Independent of       |
| ----------------------- | --------------------------------- | -------------------- |
| G0/G1 (generators core) | M2-era ZIR                        | records/equality arc |
| Async v1                | G1 + Future + one host driver     | G2 fusion, rows      |
| G2 fusion               | splice machinery (becomes M3's)   | async                |
| V0 `===` ban            | nothing                           | everything           |
| V1 `==` overhaul        | survey                            | G-track, rows        |
| V2 IdentityMap/WeakMap  | RTA injection + V1 interfaces     | records flip         |
| A0/A1/A2 rows           | bounds infra; M5 for scale        | G-track              |
| A3 config records       | nothing (better after M4)         | A0/A1                |
| R3 flip                 | bootstrap retirement, V0, Track A | —                    |
| Track B harvest         | R3                                | —                    |
| O0 type lattice         | nothing                           | everything           |
| O0.5 `using`            | O0                                | everything           |
| O1 flow graph           | nothing                           | everything           |
| O2 move checking        | O0 + O1                           | G, V, A              |
| O3 implicit drop        | O2 + G1 (cancellation table)      | V, A                 |
| O3.5 `affine T`         | O2 + **A0 `where` bounds**        | G, V                 |
| Track W bindgen stage 3 | **O0** (not O2)                   | O1–O3, G-track       |

Both tracks' breaking pieces gate on bootstrap retirement; neither
blocks the other's path there. Retirement itself (PLAN.md Phase 1)
remains the highest-leverage unlock: it frees generators for
stdlib/compiler use, and opens R3.
