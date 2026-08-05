# Bootstrap Retirement

## Status

- **Status**: Proposed — plan for deleting the TypeScript compiler
- **Date**: 2026-08-04
- **Goal**: PLAN.md Phase 1 — retire `packages/compiler` (TypeScript) and build
  Zena only with Zena.

## What retirement actually requires

Deleting the TypeScript compiler is not one change. It is three separable
problems, and only the first is the classic bootstrap question:

1. **A seed.** Today `packages/compiler` (JavaScript, runs on Node) compiles
   `zena/cli/main.zena` → `zena/out/cli.wasm`. Delete it and nothing can build
   Zena from a clean checkout. Something prebuilt has to exist.
2. **Six dependent packages.** The TypeScript compiler is not only the seed; it
   is a library other packages call.
3. **A fixpoint gate.** A self-hosted compiler that miscompiles itself is the
   worst failure mode in this project, and nothing currently checks for it
   automatically.

## 1. What depends on the TypeScript compiler today

| Package | Kind | How it uses the TS compiler | Migration |
| --- | --- | --- | --- |
| `packages/zena-compiler` | CLI | `build:cli` shells out to `cli.js build` to build the seed | replaced by the checked-in seed (§2) |
| `packages/language-service` | CLI | `build:wasm` shells out, `--target host` | swap the command — **needs `--target` on `zena-cli build`** |
| `packages/zena-formatter` | CLI | `build-wasi-tests.ts` `execSync`s `cli.js` | swap the command |
| `packages/wit-parser` | **library** | imports `Compiler`, `CodeGenerator`; compiles in-process and instantiates the result | restructure: shell out to `zena-cli build`, then instantiate |
| `packages/runtime` | **library** | test files import `compile` | restructure, or use prebuilt fixtures |
| `packages/cli` | **library** | it *is* the TS CLI | deleted, not migrated |

**Two shapes, not one.** An earlier draft of this document claimed every
dependent was a build-step dependency that just needed its command swapped.
That is true of the first three. It is **not** true of `wit-parser` and
`runtime`, which use the compiler as an **in-process library** — constructing
`Compiler`/`CodeGenerator` against a custom `CompilerHost`, or calling
`compile()`, and consuming the emitted bytes directly. Those cannot be fixed by
changing a command line; they need restructuring to shell out to `zena-cli
build` and instantiate the resulting `.wasm`, or an equivalent library surface
from the self-hosted compiler.

Neither is a *capability* gap — the self-hosted compiler can compile everything
involved — but they are meaningfully more work than the command swaps, and
`wit-parser`'s custom host (which maps `/wit-parser/` and `zena:` specifiers
onto a virtual filesystem) is the fiddliest part.

### The LSP is already self-hosted

An earlier draft of this document called `language-service` the long pole,
claiming the self-hosted compiler had to grow a checker surface first. That is
wrong. `packages/language-service/zena/lsp.zena` **is the language server, in
Zena**, built against `zena-compiler`, `zena-formatter` and the stdlib — which
is also what [lsp.md](./lsp.md) describes ("Phase 1: Self-Hosted Compiler via
WASM (Current)"). The TypeScript in that package is a thin JS shim exposing a JS
API to the VS Code extension, and it depends on `@zena-lang/runtime`, not on the
compiler.

So the only TypeScript-compiler dependency is this line:

```
build:wasm: node ../cli/lib/cli.js build zena/lsp.zena --target host -g -o lsp.wasm
```

Pointing it at `zena-cli` is the whole fix. The self-hosted compiler already
accepts the target (`zena/cli/main.zena` validates `zena-cli` and `host`); what
is missing is a `--target` passthrough on `zena-cli build` (§1.1).

Packaging is a separate, later question — a standalone LSP package, or an npm
package bundling `lsp.wasm` with the shim moved into the VS Code extension.
Worth doing, but it is cleanup, not a retirement blocker.

### 1.1 Can `zena-cli` replace the Node CLI today?

Nearly. Command coverage:

| Node CLI | `zena-cli` |
| --- | --- |
| `build` | `Build` — but **no `--target` flag** |
| `run` | `Run` |
| `test` | `Test` |
| `check` | **missing** |
| — | `Precompile` (extra) |

Two gaps, both small:

1. **`--target` passthrough on `build`.** `build_file()` in
   `packages/zena-cli/src/main.rs` takes `file`, `output`, `time`, `no_cache`
   and no target, so everything compiles with the default. The self-hosted
   compiler already parses `-t/--target` and validates `zena-cli` | `host`, so
   this is plumbing, not a feature. **Blocks the LSP build**, which needs
   `--target host`.
2. **No `check` command.** Type-check without emitting. No build script in the
   repo uses `cli.js check`, so this blocks nothing mechanical — but it is a
   user-facing command that would silently disappear.

Note also a naming mismatch worth resolving while both exist: the TS compiler's
targets are `host` | `wasi`; the self-hosted compiler's are `host` | `zena-cli`.

## 2. The seed

After retirement the build is `seed → compiler → everything`.

**What the seed is not:** a native binary. The seed is a `cli.wasm`, and it is
executed by `zena-cli` — the Rust host — **built from source at HEAD** by cargo.
So only the *compiler* is prebuilt; the *host that runs it* is compiled from
tree like any other dependency. That keeps the prebuilt surface as small as it
can be, and it means a seed cannot silently carry a stale wasmtime
configuration: the GC/exceptions/function-references flags come from
`base_config()` at HEAD.

`zena/out/` is currently `.gitignore`d, so today's artifacts are all local.
Current sizes:

| Artifact | Size | Checked in? |
| --- | --- | --- |
| `cli.wasm` | 2.6 MB | **yes** — this is the seed |
| `cli.cwasm` (precompiled native) | 42 MB | no — regenerate locally via `zena-cli precompile` |

**Decided: check `cli.wasm` into git** at a stable path such as
`packages/zena-compiler/bootstrap/cli.wasm`, rather than fetching it.

Rationale for the decision, over a nix-fetched-and-hash-pinned alternative:

- No assumption of nix in the build path. A clone plus cargo plus the checked-in
  seed is enough.
- Hermetic and offline by construction.
- `git checkout <old-sha> && build` works with no extra machinery, because the
  seed is versioned alongside the source that it must be able to build.
- No hosting location to maintain, and nothing to go stale or 404.

The cost is repository growth: roughly 1 MB of compressed history per
re-baseline. Because re-baselining is on demand rather than per commit (§3),
that is a few MB a year at a realistic cadence — acceptable. If it ever stops
being acceptable, moving to a fetched artifact later is a mechanical change, and
the in-tree pin would then hold a hash rather than the bytes.

Record next to the seed the source commit it was built from, so a stale seed is
diagnosable rather than mysterious.

## 3. The ratchet

The rule: **the seed must be able to build current HEAD.** Nothing more. So the
seed advances *on demand*, not per commit — which is what keeps option (a)
affordable if we pick it.

The workflow this forces is worth stating explicitly, because it will come up
constantly and surprises people the first time:

> To use a new language feature *in the compiler's own source*, it takes two
> commits. First teach the compiler to accept the feature and re-baseline the
> seed. Only then may the compiler's source use it — because the seed compiles
> that source, and the old seed does not know the feature.

This is the same two-step Rust's stage0 bumps and Go's bootstrap releases
impose. It is not a defect; it is the cost of self-hosting, and the alternative
(a seed that tracks HEAD) destroys reproducibility.

**Re-baseline procedure:**

1. Build a new seed with the current compiler.
2. Verify the fixpoint gate (§4) with the *new* seed.
3. Update the pin (or commit the binary), with the source commit it was built
   from recorded alongside.
4. CI proves a clean checkout builds from the new seed.

CI failing with "seed cannot build HEAD" is the signal to re-baseline. That is
the ratchet: it only ever moves forward, and every step is verified.

## 4. The fixpoint gate

This is the most important piece and it does not exist yet. `package.json` has
`build:self-hosted` (stage 2) and `test:self-hosted`, but **no byte comparison
between stages**.

The staging, precisely:

| Stage | Built by | Notes |
| --- | --- | --- |
| A | seed compiles current source | A's *behaviour* is current; A's *code* was generated by the old seed |
| B | A compiles current source | first build whose code comes from current codegen |
| C | B compiles current source | |

**The invariant is `B ≡ C`, byte for byte.** `A ≢ B` is expected and fine
whenever the seed is older than HEAD — the seed's codegen differs, so it emits
different (but equivalent) code.

Note that today's arrangement is a stronger, temporary special case: with the
TypeScript compiler as the seed, `stage1 ≡ stage2` currently holds because both
implement the same codegen. **That property disappears at retirement**, and
expecting it afterwards will produce confusing CI failures. The durable
invariant is `B ≡ C`.

A `B ≢ C` failure means the compiler miscompiles itself — the single highest-
severity class of bug available here, and one the existing test suites can miss
because they exercise the compiler's *output*, not its *self-image*.

**Action: land the `B ≡ C` gate in CI before retirement, while the TypeScript
compiler is still available as an independent oracle to debug against.** Doing
it afterwards means diagnosing a self-miscompile with no second implementation
to compare against — precisely when it is hardest.

## 5. Final benchmarks

Once `packages/compiler` is deleted, the ability to compare two independent
implementations is gone permanently. Capture, commit, and date the numbers
first.

`packages/zena-compiler/src/scripts/benchmark.ts` already drives both
(`bootstrapCli` and `zenaCli` are both wired in), so this is mostly a matter of
running it and committing the output rather than new tooling.

What to capture, in priority order:

1. **Compile time**, both compilers, same inputs, including the compiler
   compiling itself — the largest and most interface-heavy program available
   (ir.md §14 makes the same argument for the M-track).
2. **Output size** of the emitted WASM, per benchmark and for the compiler
   itself, with and without `--dce`.
3. **Runtime speed of generated code**, both compilers' output on the benchmark
   suite. This is the one that matters most and is the easiest to lose: it
   answers "did self-hosting cost us codegen quality?" and after retirement
   there is nothing to compare against. The suite now measures it — the answer
   as of 2026-08-05 is a median of 0.91x, i.e. self-hosted codegen is *faster*.
   Historically it did not measure this — the micro-benchmarks build their fixtures with the bootstrap
   compiler and run that one artifact under wasmtime, Node and against JS, so
   they measure Zena against JavaScript rather than one compiler's output
   against the other's. Note the suite *does* compare the two compilers on
   compile **time**, including the compiler compiling itself. **Emitted code
   size** is measured too, at ~1.39× for anything compiler-sized once custom
   sections are excluded; see the
   [2026-08-05 baseline](../benchmarks/2026-08-05-pre-retirement-baseline.md).
4. **Peak memory / GC reserve** for a self-compile. `build:self-hosted` already
   needs `ZENA_GC_RESERVE_MB=1536`, which is worth recording as a baseline
   rather than folklore.

Commit these as a dated JSON baseline under version control, not as prose in a
PR description. Post-retirement regressions are then measurable against the last
point where an independent implementation existed.

## 6. Order of operations

**Capture the benchmarks first (§5).** It is the only step here that is
irreversible if skipped: `benchmark.ts` already drives both compilers, so it
costs almost nothing now, and once `packages/compiler` is deleted the
cross-implementation comparison can never be reproduced. Everything else in this
plan can be redone.

1. ~~**Capture and commit final benchmarks** (§5)~~ — **done**,
   [2026-08-05 baseline](../benchmarks/2026-08-05-pre-retirement-baseline.md).
   Compile time for all four targets, emitted size, and emitted-code runtime,
   all measured by the suite so they can be reproduced.
2. **Land the fixpoint gate** (§4) while the oracle still exists.
3. **Clear the six dependents** (§1), in two waves. First the `--target`
   passthrough plus the three command swaps (`zena-compiler`,
   `language-service`, `zena-formatter`), which are mechanical. Then the two
   in-process library users (`wit-parser`, `runtime`), which need restructuring
   to shell out and instantiate.
4. **Choose and populate the seed** (§2), with the pin in-tree.
5. **Prove a clean-checkout build from the seed alone**, with the TypeScript
   compiler still present but unused — a dry run that can be reverted.
6. **Delete `packages/compiler`**, and with it the `@skip: bootstrap` markers
   (13 files) and the BUGS.md items deferred to retirement.

Steps 1, 2 and 3 are independent and can run in parallel. Only 5 and 6 are
ordered.

## Open questions

1. ~~Seed in git vs. nix-fetched~~ — **decided**: check `cli.wasm` into git
   (§2). No nix assumption in the build path.
2. ~~How does `language-service` get a checker~~ — **moot**: the LSP is already
   self-hosted; it needs a build-step change, not a new API (§1).
3. Does `zena-cli` grow a `check` command before or after retirement (§1.1)?
4. Reconcile target names: TS uses `host`|`wasi`, self-hosted uses
   `host`|`zena-cli` (§1.1).
5. Does `wit-parser` build through `zena-cli`, or does the compiler grow a
   library API for embedders (§1)?
6. Do we keep a *second* older seed to test that the ratchet still works from
   further back, or is one deep enough?

## Related

- PLAN.md Phase 1 — the retirement goal
- [self-hosted-compiler.md](./self-hosted-compiler.md) — architecture, §8 LSP
- [ir.md](./ir.md) §14 — the ZIR M-track; M4 flips the default backend
- [implementation-plan.md](./implementation-plan.md) — R3 gates on retirement
