# Bootstrapping

## Status

- **Status**: Stable — describes the standing build architecture
- **Date**: 2026-08-06

How a fresh checkout of Zena builds a Zena compiler, given that the
compiler is written in Zena. (The _plan_ that got us here is
[bootstrap-retirement.md](./bootstrap-retirement.md) — a historical
document; this one stays current.)

## The bootstrap

`packages/zena-compiler/bootstrap/cli.wasm` is **the bootstrap
compiler**: a prebuilt, checked-in build of the self-hosted compiler.
It is the base case that enables bootstrapping — the one artifact that
exists before anything is built. Everything else compiles from source:

```
cargo build          → zena-cli            (the Rust/wasmtime host, from source)
zena-cli + bootstrap → zena/out/cli.wasm   (the working compiler, from source)
zena/out/cli.wasm    → everything else     (stdlib tests, LSP, formatter, …)
```

The `build:cli` wireit script in `packages/zena-compiler` is the
second step: it runs the bootstrap through `zena-cli`
(`ZENA_COMPILER_WASM=bootstrap/cli.wasm`) to compile
`zena/cli/main.zena`. Only the _compiler_ is prebuilt; the host that
executes it is built by cargo at HEAD, so the bootstrap can never pin
a stale wasmtime configuration.

It is checked into git (not fetched) so that a clone plus cargo is a
complete build environment: hermetic, offline, and
`git checkout <old-sha> && build` just works because every commit
carries a bootstrap that can build it. The cost is a few MB of
repository history per re-baseline, which is on-demand and rare.

## The stages

A, B and C are the same program — the self-hosted compiler, built from the
source in the tree. They differ only in which compiler emitted them.

| Stage     | Built by           | Artifact                                       | Differs from the stage before it when                                                                                                  |
| --------- | ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| bootstrap | a past re-baseline | `bootstrap/cli.wasm`, checked in               | —                                                                                                                                      |
| A         | the bootstrap      | `zena/out/cli.wasm` (`build:cli`)              | the compiler's **source** has changed since the re-baseline                                                                            |
| B         | stage A            | `zena/out/cli-self.wasm` (`build:self-hosted`) | the compiler's **output** has changed: A emits what the source in the tree says to, and the bootstrap emitted what its own commit said |
| C         | stage B            | `zena/out/cli-self2.wasm` (`test:fixpoint`)    | never — **B ≡ C** is the invariant below                                                                                               |

A and B are expected to differ, and nothing compares them. B and C are
emitted by compilers built from the same source, so they must emit the same
bytes for the same input: a difference means the compiler miscompiles
itself, which is a blind spot for every other test, since the rest of the
suite exercises the compiler's output on other programs rather than on
itself.

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
changed `bootstrap/cli.wasm` is the re-baseline commit, and the
re-baseline procedure (below) builds the artifact from that same
commit's source. There is no separate provenance file to keep in sync.

The artifact is also self-certifying: the bootstrap is always a stage B,
and because B ≡ C held when it was made, the bootstrap compiling its own
source reproduces itself **byte-for-byte**. To audit a bootstrap, check out its re-baseline
commit, run `build:cli`, and `cmp` the output against it.

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
`build:cli`'s wireit inputs are the entire compiler source
(`zena/**/*.zena`), the stdlib source, and `bootstrap/cli.wasm`
itself — so **any** edit to compiler or stdlib source invalidates the
cached result and reruns compilation _through the bootstrap_. If the
bootstrap can't compile the new source, `build:cli` fails right there,
before a single test runs, and every test script depends on it. CI
(`nix flake check`) runs the same graph from a clean copy of the tree,
so there is no cache path around it. The failure is loud and local: a
compile error from `build:cli`, which is the signal to use the
two-step landing below.

A language or stdlib change can make compiler source unbuildable by
the existing bootstrap (for example, the compiler starts _using_ new
syntax it just gained). Two options, in order of preference:

1. **Two-step landing.** First land the feature without using it in
   the compiler's own source (the old bootstrap builds this fine),
   re-baseline, then land the usage.
2. **Re-baseline in the same change**, when the two-step split is
   impractical: build the new bootstrap from the last commit the old
   bootstrap could build, then apply the source change on top.

## Re-baselining

```bash
npm run reseed -w @zena-lang/zena-compiler
```

`reseed` is gated: it depends on the full compiler test suite
(fixpoint included) and only then copies `zena/out/cli-self.wasm` —
stage B — over `bootstrap/cli.wasm`. After it
runs, run `npm test` once more: the changed bootstrap invalidates
`build:cli`, so this second pass rebuilds and tests everything _from
the new bootstrap_, which is exactly the "is the new bootstrap good?"
check. Commit the new `bootstrap/cli.wasm` together with whatever
change motivated the re-baseline.

`cli.cwasm` and `cli.lock` may appear next to the bootstrap — they are
`zena-cli`'s machine-specific precompilation cache, gitignored, never
committed.
