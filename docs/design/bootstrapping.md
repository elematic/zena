# Bootstrapping

## Status

- **Status**: Stable — describes the standing build architecture
- **Date**: 2026-08-06

How a fresh checkout of Zena builds a Zena compiler, given that the
compiler is written in Zena. (The _plan_ that got us here is
[bootstrap-retirement.md](./bootstrap-retirement.md) — a historical
document; this one stays current.)

## The bootstrap

`packages/zena-cli/bootstrap/zena.wasm` is **the bootstrap**: a
prebuilt, checked-in build of the CLI module (`packages/zena-cli/zena/main.zena`),
with the self-hosted compiler, zebra, the formatter, the linter, zenadoc,
the language service and the package manager linked in. It is the base
case that enables bootstrapping — the one artifact that exists before
anything is built. Everything else compiles from source:

```
cargo build             → zena-cli, zena-run      (the Rust/wasmtime hosts, from source)
zena-cli + bootstrap    → zena/out/cli.wasm       (Stage A: the working compiler, from source)
zena-run + cli.wasm     → packages/zena-cli/out/zena.wasm (the working CLI module, from source)
zena-cli (+ zena.wasm)  → everything else         (stdlib tests, LSP, formatter, …)
```

Before `packages/zena-cli/out/zena.wasm` is built, `zena-cli` falls back
to `packages/zena-cli/bootstrap/zena.wasm`, so once cargo has built
`zena-cli` a fresh checkout can already run `zena build` (including
zebra target builds), `zena fmt`, `zena lint`, `zena run` and
`zena test`. During a build, `build:cli` in `packages/zena-compiler`
sets `ZENA_CLI_MODULE=../zena-cli/bootstrap/zena.wasm` explicitly so
Stage A is always compiled by the bootstrap even when `out/zena.wasm`
already exists on disk. Only the Wasm module is prebuilt; the host that
executes it is built by cargo at HEAD, so the bootstrap never pins a
stale wasmtime configuration.

Keeping Stage A between the bootstrap and `out/zena.wasm` decouples the
rest of the repository from the bootstrap's age: changes to `zebra`,
`zena-lint`, `zena-formatter`, `zenadoc`, `pds` or `zena-cli` are
compiled by Stage A and take effect without re-baselining.

It is checked into git (not fetched) so that a clone plus cargo is a
complete build environment: hermetic, offline, and
`git checkout <old-sha> && build` just works because every commit
carries a bootstrap that can build it. The cost is a few MB of
repository history per re-baseline, which is on-demand and rare.

## The stages

A, B and C are the same program — the self-hosted compiler, built from the
source in the tree. They differ only in which compiler emitted them.

| Stage     | Built by           | Artifact                                            | Differs from the stage before it when                                                                                                  |
| --------- | ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| bootstrap | a past re-baseline | `packages/zena-cli/bootstrap/zena.wasm`, checked in | —                                                                                                                                      |
| A         | the bootstrap      | `zena/out/cli.wasm` (`build:cli`)                   | the compiler's **source** has changed since the re-baseline                                                                            |
| B         | stage A            | `zena/out/cli-self.wasm` (`build:self-hosted`)      | the compiler's **output** has changed: A emits what the source in the tree says to, and the bootstrap emitted what its own commit said |
| C         | stage B            | `zena/out/cli-self2.wasm` (`test:fixpoint`)         | never — **B ≡ C** is the invariant below                                                                                               |

A and B are expected to differ, and nothing compares them. B and C are
emitted by compilers built from the same source, so they must emit the same
bytes for the same input: a difference means the compiler miscompiles
itself, which is a blind spot for every other test, since the rest of the
suite exercises the compiler's output on other programs rather than on
itself.

A change to what a construct means can also make B ≢ C while every other
test passes, when the compiler's own source uses the construct. The
bootstrap compiled A with the old meaning and A compiled B with the new
one, so A and B behave differently wherever the compiler relies on the
construct, and emit different bytes for the same input. The compiler
source that relies on the old meaning has to be rewritten to mean the
same thing under both.

What each stage is for:

- **A** is what everything in the repository compiles with. `zena-cli`'s
  module (`packages/zena-cli/out/zena.wasm`) is compiled by it, and so
  every package that compiles Zena reaches A's output, along with the
  compiler's own test program and the component fixtures.
- **B** is the re-baseline candidate and the subject of the fixpoint check.
  Nothing else uses it.
- **C** is compared with B and then has no further use.

### Which stage to use

**Stage A.** What matters is that the compiler has the current
implementation, not that it was itself built by the current
implementation. A stage A built from the source in the tree implements
exactly what that source says, whoever emitted its bytes — so a script
that wants the compiler's current behaviour wants A, and paying for B
first buys it nothing.

When being built by the current implementation does matter — a
performance change the compiler itself should benefit from, say — the way
to get it is a re-baseline. That makes the new bytes the bootstrap, and so
makes them stage A for every build afterwards. It is a deliberate step
with a gate in front of it, which is the right shape for a change of that
kind: `reseed` runs the full suite, fixpoint included, before it copies
anything.

The cost of reaching for B instead is not only the 64s it takes to build.
It also moves what a test exercises: the suite's job is to show that the
bootstrap builds a HEAD that passes, and a test compiled by B exercises B
rather than the bootstrap's output.

## Provenance

The bootstrap's provenance is its git history: the commit that last
changed `packages/zena-cli/bootstrap/zena.wasm` is the re-baseline commit, and the
re-baseline procedure (below) builds the artifact from that same
commit's source. There is no separate provenance file to keep in sync.

The artifact is also self-certifying: `reseed` compiles `zena/main.zena`
at `-g -O2` with `out/zena.wasm` (whose compiler was emitted by Stage A)
and checks that the resulting module compiling `zena/main.zena` again
reproduces itself **byte-for-byte**. To audit a bootstrap, check out its
re-baseline commit, build `zena-cli`'s binary
(`cargo build --release -p zena-cli`), and compile the CLI module with
the bootstrap:

```bash
ZENA_GC_RESERVE_MB=1536 ZENA_CLI_MODULE=packages/zena-cli/bootstrap/zena.wasm \
  ./target/release/zena-cli -g -O2 build packages/zena-cli/zena/main.zena \
  -o packages/zena-cli/out/audit.wasm
cmp packages/zena-cli/out/audit.wasm packages/zena-cli/bootstrap/zena.wasm
```

`build:module`'s output (`packages/zena-cli/out/zena.wasm`) does not
match: it is built at `-O1` rather than `-O2`.

## The invariant

**The bootstrap must build a HEAD that passes the test suite.**

Both halves matter. It is not enough that the bootstrap can compile
current HEAD; the compiler it produces must itself be correct. The
gate is automatic and continuous: every `npm test` run builds
`zena/out/cli.wasm` from the bootstrap and then exercises that output
— the portable execution suites, every package that compiles Zena, and
`test:fixpoint`, which requires stage B and stage C to agree
byte-for-byte. CI (`nix flake check`) runs all of it hermetically from a
clean copy of the tree.

There is deliberately **no** requirement that the bootstrap stay
current, and no per-commit re-baselining. An old bootstrap that still
builds a green HEAD is a good bootstrap.

### How an incompatible change is caught

You cannot _accidentally_ land a change the bootstrap can't compile.
`build:cli`'s inputs are the entire compiler source
(`zena/**/*.zena`), the stdlib source, and
`packages/zena-cli/bootstrap/zena.wasm`
itself — so **any** edit to compiler or stdlib source invalidates the
cached result and reruns compilation _through the bootstrap_. If the
bootstrap can't compile the new source, `build:cli` fails right there,
before a single test runs, and every test script depends on it. CI
(`nix flake check`) runs the same graph from a clean copy of the tree,
so there is no cache path around it. The failure is loud and local: a
compile error from `build:cli`, which is the signal to use the
two-step landing below.

That error can come from code generation. The bootstrap checks the new
source with its own, older checker. Where that checker types an
expression differently from the current one, after a change to type
inference for example, the bootstrap's code generator can meet a value
it cannot lower and fail with `zir unsupported: <reason> @<function>`
in code the current checker accepts. Fix one site at a time, and after
each rerun `build:cli`, which shows the bootstrap's view, then
`build:self-hosted`, which shows stage A's and so the current checker's.
Each run finds the next site.

A language or stdlib change can make compiler source unbuildable by
the existing bootstrap (for example, the compiler starts _using_ new
syntax it just gained). Two options, in order of preference:

1. **Two-step landing.** First land the feature without using it in
   the compiler's own source (the old bootstrap builds this fine),
   re-baseline, then land the usage.
2. **Re-baseline in the same change**, when the two-step split is
   impractical: build the new bootstrap from the last commit the old
   bootstrap could build, then apply the source change on top.
   `reseed` cannot build this bootstrap: it depends on the whole test
   suite, which starts with `build:cli` on the tree being committed, and
   that is the build that fails. Build the stages by hand with the
   `build:cli` and `build:self-hosted` commands: A' is the old bootstrap
   compiling the newest tree it can build, B' is A' compiling the
   change, and C' is B' compiling it again. Commit C'
   after checking that C' compiling the change emits C' again, byte for
   byte. B' can differ from C', since A' was built from the older tree.

A standard library file in the compiler's closure, such as `zena:fs`
or, through the prelude, `zena:async`, is compiled by the bootstrap as
part of the compiler. When a change to such a file needs a compiler
change to compile, the compiler change lands first, handling both the
old and the new form of the library, and is re-baselined; the library
changes after. Before re-baselining, check the new form against the
fixed compiler by editing the library file and compiling a probe with
`./target/release/zena-cli`, whose compiler reads the standard library
from disk.

The same holds for what the compiler reads besides source. The
repository's packages are a workspace of `zena-package.json` manifests
(package-manifest.md), and the bootstrap reads them with its own code
when `build:cli` runs it. A change to the manifest format has to be one
that code still reads, or it lands in two steps like a language change.
The root `check:workspace` script compiles a file with the bootstrap
for that reason: `build:cli` lists only the manifests the compiler's
own imports reach, so it would not rebuild, and fail, when another
package's manifest changed.

## Re-baselining

```bash
npm run reseed
```

`reseed` is gated: it depends on the full workspace test suite
(fixpoint included), compiles `packages/zena-cli/zena/main.zena` at
`-g -O2` with `packages/zena-cli/out/zena.wasm`, compiles it once more
with the candidate bootstrap to verify byte-for-byte self-reproduction,
and then moves it into `packages/zena-cli/bootstrap/zena.wasm`. After it
runs, run `npm test` once more: the changed bootstrap invalidates
`build:cli`, so this second pass rebuilds and tests everything _from
the new bootstrap_, which is the "is the new bootstrap good?"
check. Commit the new `packages/zena-cli/bootstrap/zena.wasm` together
with whatever change motivated the re-baseline.

Reseed after the commit's last source change. The bootstrap a commit
carries is built from that commit's own source (Provenance, above), and
a pull request is squash-merged into one commit. So a pull request that
re-baselines and then changes source in the CLI module's closure
re-baselines again at the end.

`*.cwasm` and `*.lock` may appear next to the bootstrap — they are
`zena-cli`'s machine-specific precompilation cache, gitignored, never
committed.
