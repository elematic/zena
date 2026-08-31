# Bootstrap Retirement

## Status

- **Status**: **Complete (2026-08-06)** — historical; the standing
  architecture is [bootstrapping.md](./bootstrapping.md)
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

| Package                     | Kind        | How it uses the TS compiler                                                          | Migration                                                    |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/zena-compiler`    | CLI         | `build:cli` shells out to `cli.js build` to build the seed                           | replaced by the checked-in seed (§2)                         |
| `packages/language-service` | CLI         | `build:wasm` shells out, `--target host`                                             | swap the command — **needs `--target` on `zena-cli build`**  |
| `packages/zena-formatter`   | CLI         | `build-wasi-tests.ts` `execSync`s `cli.js`                                           | swap the command                                             |
| `packages/wit-parser`       | **library** | imports `Compiler`, `CodeGenerator`; compiles in-process and instantiates the result | restructure: shell out to `zena-cli build`, then instantiate |
| `packages/runtime`          | **library** | test files import `compile`                                                          | restructure, or use prebuilt fixtures                        |
| `packages/cli`              | **library** | it _is_ the TS CLI                                                                   | deleted, not migrated                                        |

**Two shapes, not one.** An earlier draft of this document claimed every
dependent was a build-step dependency that just needed its command swapped.
That is true of the first three. It is **not** true of `wit-parser` and
`runtime`, which use the compiler as an **in-process library** — constructing
`Compiler`/`CodeGenerator` against a custom `CompilerHost`, or calling
`compile()`, and consuming the emitted bytes directly. Those cannot be fixed by
changing a command line; they need restructuring to shell out to `zena-cli
build` and instantiate the resulting `.wasm`, or an equivalent library surface
from the self-hosted compiler.

Neither is a _capability_ gap — the self-hosted compiler can compile everything
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

Pointing it at `zena-cli` is the whole _build-system_ fix. The self-hosted
compiler already accepts the target (`zena/cli/main.zena` validates `zena-cli`
and `host`); the `--target` passthrough on `zena-cli build` landed 2026-08-05.

**Update (2026-08-05, later): the swap is DONE.** The first attempt was
blocked on what turned out to be four distinct self-hosted compiler bugs
(spliced default arguments vs the cycle re-check pass; map literals never
registering their HashMap instantiation with RTA; tuple/array literals in
method bodies missing struct discovery; the host target emitting memory
ops with no memory section). All four are fixed with portable tests,
and `build:wasm` now runs `zena-cli build zena/lsp.zena
--target host`, with the language-service suite green against the
self-hosted-built lsp.wasm.

Packaging is a separate, later question — a standalone LSP package, or an npm
package bundling `lsp.wasm` with the shim moved into the VS Code extension.
Worth doing, but it is cleanup, not a retirement blocker.

### 1.1 Can `zena-cli` replace the Node CLI today?

Nearly. Command coverage:

| Node CLI | `zena-cli`                           |
| -------- | ------------------------------------ |
| `build`  | `Build` — but **no `--target` flag** |
| `run`    | `Run`                                |
| `test`   | `Test`                               |
| `check`  | **missing**                          |
| —        | `Precompile` (extra)                 |

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

> The standing, post-retirement description of this architecture lives
> in [bootstrapping.md](./bootstrapping.md) — that document stays
> current after this plan completes; the artifact is called **the
> bootstrap** there. This section records the decision as planned.

After retirement the build is `seed → compiler → everything`.

**What the seed is not:** a native binary. The seed is a `cli.wasm`, and it is
executed by `zena-cli` — the Rust host — **built from source at HEAD** by cargo.
So only the _compiler_ is prebuilt; the _host that runs it_ is compiled from
tree like any other dependency. That keeps the prebuilt surface as small as it
can be, and it means a seed cannot silently carry a stale wasmtime
configuration: the GC/exceptions/function-references flags come from
`base_config()` at HEAD.

`zena/out/` is currently `.gitignore`d, so today's artifacts are all local.
Current sizes:

| Artifact                         | Size   | Checked in?                                       |
| -------------------------------- | ------ | ------------------------------------------------- |
| `cli.wasm` (self-hosted-built)   | 4.0 MB | **yes** — this is the seed (`bootstrap/cli.wasm`) |
| `cli.cwasm` (precompiled native) | 42 MB  | no — regenerate locally via `zena-cli precompile` |

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
seed advances _on demand_, not per commit — which is what keeps option (a)
affordable if we pick it.

The workflow this forces is worth stating explicitly, because it will come up
constantly and surprises people the first time:

> To use a new language feature _in the compiler's own source_, it takes two
> commits. First teach the compiler to accept the feature and re-baseline the
> seed. Only then may the compiler's source use it — because the seed compiles
> that source, and the old seed does not know the feature.

This is the same two-step Rust's stage0 bumps and Go's bootstrap releases
impose. It is not a defect; it is the cost of self-hosting, and the alternative
(a seed that tracks HEAD) destroys reproducibility.

**Re-baseline procedure:**

1. Build a new seed with the current compiler.
2. Verify the fixpoint gate (§4) with the _new_ seed.
3. Update the pin (or commit the binary), with the source commit it was built
   from recorded alongside.
4. CI proves a clean checkout builds from the new seed.

CI failing with "seed cannot build HEAD" is the signal to re-baseline. That is
the ratchet: it only ever moves forward, and every step is verified.

## 4. The fixpoint gate

This is the most important piece and it does not exist yet. `package.json` has
`build:self-hosted` (stage 2) and `test:self-hosted`, but **no byte comparison
between stages**.

A, B and C are all the same program — the self-hosted compiler, built from the
current source. They differ only in which compiler built them:

| Stage | Built by |
| ----- | -------- |
| A     | the seed |
| B     | A        |
| C     | B        |

**The invariant is `B ≡ C`, byte for byte.** A and B differ, because the seed's
codegen is not the self-hosted compiler's — the two emit materially different
code, as the
[2026-08-05 baseline](../benchmarks/2026-08-05-pre-retirement-baseline.md)
measures. That difference is expected and is not what the gate checks. B and C
are built from the same source by compilers that are themselves built from the
same source, so they must emit identical bytes.

A `B ≢ C` failure means the compiler miscompiles itself — the single highest-
severity class of bug available here, and one the existing test suites can miss
because they exercise the compiler's _output_, not its _self-image_.

**Done (2026-08-05):** `npm run test:fixpoint -w @zena-lang/zena-compiler`,
wired into that package's `test` target, so it runs with the rest of the suite.
It builds stage C by pointing `ZENA_COMPILER_WASM` at stage B — the compile
cache keys on the compiler's mtime and length, so that is a genuine rebuild and
not stage B's cached output — and compares the two byte for byte.

The invariant holds today. Verified in both directions: the gate fails, with a
diagnostic and a non-zero exit, when stage B is replaced by a valid but
different compiler. It also refuses to run if `ZENA_COMPILER_WASM` stops taking
effect, since stage C would then be built by the default compiler and the
comparison would silently pass while testing nothing.

It was landed before retirement deliberately, while the TypeScript compiler is
still available as an independent oracle. Diagnosing a self-miscompile with no
second implementation to compare against is precisely when one is most
wanted.

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
   there is nothing to compare against. **The current suite does not measure
   this** — the micro-benchmarks build their fixtures with the bootstrap
   compiler and run that one artifact under wasmtime, Node and against JS, so
   they measure Zena against JavaScript rather than one compiler's output
   against the other's. Note the suite _does_ compare the two compilers on
   compile **time**, including the compiler compiling itself. **Emitted code
   size** is nearly free to add — both artifacts are already written per target
   — and already shows the self-hosted compiler emitting ~2× the bytes; see the
   [2026-08-04 baseline](../benchmarks/2026-08-04-pre-retirement-baseline.md).
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

1. **Capture and commit final benchmarks** (§5). _Partially done —
   [2026-08-04 baseline](../benchmarks/2026-08-04-pre-retirement-baseline.md).
   Compile time, emitted size and emitted-code runtime are all captured and
   now measured by the suite; `stdlib_moderate` and `stdlib_heavy` were
   blocked at capture time and need a re-run._
2. ~~**Land the fixpoint gate** (§4) while the oracle still exists~~ — **done**,
   `test:fixpoint`.
3. **Clear the six dependents** (§1), in two waves. First the `--target`
   passthrough plus the command swaps (`zena-compiler`, `language-service`,
   `zena-formatter`). Then the two in-process library users (`wit-parser`,
   `runtime`), which need restructuring to shell out and instantiate.
   _Progress 2026-08-05: wave one is COMPLETE — `--target` passthrough,
   the `zena-formatter` swap, and the `language-service` swap are all
   done (the self-hosted CLI loads `zena-packages.json`; the compiler
   bugs each swap exposed are fixed with portable tests — see §1).
   `zena-compiler`'s own `build:cli` intentionally stays on
   the bootstrap until the seed lands (§2)._

   _Wave two progress 2026-08-05: both restructures are DONE. The
   `runtime` tests and the `wit-parser` build/tests compile through the
   self-hosted compiler as a library: `api.wasm` (`build:api`) exports
   `compileSource()` plus error/output accessors, and the packages
   instantiate it in-process (`packages/runtime/src/test/compile-zena.ts`,
   `packages/wit-parser/src/lib/compile.ts`) — no file round-trips, and
   neither package depends on `@zena-lang/compiler`. Six self-hosted
   compiler bugs fell out of the wit-parser swap, each fixed with a
   portable test: deterministic vtable reach, distributed sealed
   variants, block-scoped function bindings, celled captures,
   inherited-member snapshots freezing pre-inference field types, and
   record literals ignoring their contextual type. The full wit-parser
   suite passes self-hosted-compiled._

   _2026-08-06: the package's last bootstrap caller is gone too.
   `test:example` ran `../cli/lib/cli.js check` on
   `examples/parse-wit.zena` because the self-hosted compiler crashed
   on it; it now builds and runs that example with `zena-cli`. The
   crash was a seventh compiler bug — a checkable-phase member visit
   satisfying the later reachable one, stranding closures it had
   created but not marked reached. `packages/wit-parser` no
   longer invokes the bootstrap anywhere._

4. **Choose and populate the seed** (§2), with the pin in-tree.

   _DONE 2026-08-06: `packages/zena-compiler/bootstrap/cli.wasm` (4.0 MB),
   with provenance and re-baseline instructions in `bootstrap/README.md`.
   The seed is the **self-hosted-built** compiler (stage B), not the
   bootstrap-built one: since B≡C held at the pin commit, the seed
   compiling its own source reproduces itself byte-for-byte, so seed
   integrity is a `cmp` away. `build:cli` now runs the seed through
   `zena-cli` (`ZENA_COMPILER_WASM=bootstrap/cli.wasm`); the TypeScript
   compiler is no longer in the compiler's own build path. The wireit
   edge `zena-cli:build → build:cli` was inverted to break the cycle,
   with dependents given the explicit edge._

5. **Prove a clean-checkout build from the seed alone**, with the TypeScript
   compiler still present but unused — a dry run that can be reverted.

   _DONE 2026-08-06: `nix flake check` builds the whole monorepo
   hermetically — cargo → `zena-cli`, seed → `cli.wasm`, everything
   else on top — and runs the full test suite offline._

6. **Delete `packages/compiler`**, and with it the `@skip: bootstrap` markers
   (13 files) and the bug-list items deferred to retirement.

   _DONE 2026-08-06: `packages/compiler` and `packages/cli` are gone
   (the marker count had grown to 47 by then — generators alone added
   a dozen). The dual test suites collapsed onto the self-hosted
   variants first, so the deletion itself was reference cleanup: root
   build/test graph, vestigial deps, tsconfig project references, the
   flake's `zena` command (now `zena-cli`; its
   can't-compile-outside-the-repo limitation is
   [#120](https://github.com/elematic/zena/issues/120)), and the two
   deferred rulings are unblocked — refutable patterns in let-conditions
   ([#106](https://github.com/elematic/zena/issues/106)) and field/method
   same-name semantics
   ([#107](https://github.com/elematic/zena/issues/107)). **Retirement
   complete** — the standing architecture is
   [bootstrapping.md](./bootstrapping.md)._

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
6. Do we keep a _second_ older seed to test that the ratchet still works from
   further back, or is one deep enough?

## Related

- PLAN.md Phase 1 — the retirement goal
- [self-hosted-compiler.md](./self-hosted-compiler.md) — architecture, §8 LSP
- [ir.md](./ir.md) §14 — the ZIR M-track; M4 flips the default backend
- [implementation-plan.md](./implementation-plan.md) — R3 gates on retirement
