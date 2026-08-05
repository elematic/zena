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
| **M1–M5**           | ZIR backend migration milestones                            | [ir.md](ir.md) §14                                          |

Two things that trip people up:

- **There is no R1 or R2 here.** The R-numbering originates in
  [row-types.md](row-types.md) §9, which proposed R1/R2/R3; this plan absorbed
  R1 and R2 into Track A and kept only the flip, which stayed named R3.
- **The M-track is not one of this file's tracks.** It is the ZIR backend
  migration in [ir.md](ir.md) §14, referenced here because several items
  depend on it. M1 and M2 are complete; M3 is in progress.

Proposed but **not adopted**: `docs/design/ownership.md` suggests a **Track O**
(O0–O4) for resource management and ownership. It is a proposal under review,
not part of this plan of record; treat the label as provisional until it is
either adopted here or dropped.

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

Milestones G0–G3 per generators.md §9. **Status: G0 (front end) is
implemented** — the self-hosted tokenizer reserves
`gen`/`yield`/`async`/`await`, the parser/checker accept `gen`
functions and methods with the yield-type convention and the v1
rejections (yield-in-try, yield-in-closure, value returns), and
codegen hard-errors on any generator reaching lowering until G1's
split pass exists.

The async-specific refinement:

- **Async's prerequisite is G1 (the split pass), not G2 (fusion).**
  Fusion is the generator _performance_ story; async needs only the
  suspension transform. Critical path: **G0 → G1 → async v1**, with G2
  proceeding in parallel as capacity allows.
- **Start the async runtime design during G1**, since it's the half
  generators teach nothing about: the `Future<T>` type and checker
  rules, and the first host driver — JSPI on a JS host is the cheapest
  first event loop; the WASI P3 callback ABI comes second
  (concurrency.md).
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
- **A3 — default-bearing config records** (row-types.md §3.5): can go
  **first** in this track — independent of A0/A1, addresses the
  config-ergonomics pain directly, full payoff (immutable fields via
  option-bag constructors) arrives with M4 single-shot construction.

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

Both tracks' breaking pieces gate on bootstrap retirement; neither
blocks the other's path there. Retirement itself (PLAN.md Phase 1)
remains the highest-leverage unlock: it frees generators for
stdlib/compiler use, and opens R3.
