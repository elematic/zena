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

## Provenance

The bootstrap's provenance is its git history: the commit that last
changed `bootstrap/cli.wasm` is the re-baseline commit, and the
re-baseline procedure (below) builds the artifact from that same
commit's source. There is no separate provenance file to keep in sync.

The artifact is also self-certifying: the bootstrap is always the
_self-hosted-built_ compiler (stage B of the fixpoint gate), and
because the B≡C fixpoint held when it was made, the bootstrap
compiling its own source reproduces itself **byte-for-byte**. To audit a bootstrap, check out its re-baseline
commit, run `build:cli`, and `cmp` the output against it.

## The invariant

**The bootstrap must build a HEAD that passes the test suite.**

Both halves matter. It is not enough that the bootstrap can compile
current HEAD; the compiler it produces must itself be correct. The
gate is automatic and continuous: every `npm test` run builds
`zena/out/cli.wasm` from the bootstrap and then exercises that output
— the portable execution suites, every package that compiles Zena, and
`test:fixpoint`, which requires the stage-1 compiler compiling itself
(stage 2) and stage 2 compiling itself again (stage 3) to agree
byte-for-byte. CI (`nix flake check`) runs all of it hermetically from
a clean copy of the tree.

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
the self-hosted-built stage — over `bootstrap/cli.wasm`. After it
runs, run `npm test` once more: the changed bootstrap invalidates
`build:cli`, so this second pass rebuilds and tests everything _from
the new bootstrap_, which is exactly the "is the new bootstrap good?"
check. Commit the new `bootstrap/cli.wasm` together with whatever
change motivated the re-baseline.

`cli.cwasm` and `cli.lock` may appear next to the bootstrap — they are
`zena-cli`'s machine-specific precompilation cache, gitignored, never
committed.
