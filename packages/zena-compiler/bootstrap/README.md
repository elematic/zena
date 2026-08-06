# The bootstrap compiler

`cli.wasm` is the prebuilt self-hosted Zena compiler that bootstraps a
fresh checkout: `build:cli` runs it through `zena-cli` (which cargo
builds from source) to compile `zena/cli/main.zena` into the working
compiler, and everything else builds from there. It is the only
prebuilt artifact in the repository.

The full story — why it is checked into git, the invariant it must
uphold, how to audit it, and how to land changes it cannot compile —
is in [docs/design/bootstrapping.md](../../../docs/design/bootstrapping.md).

Its provenance is its git history: the commit that last changed
`cli.wasm` is the re-baseline commit, and the artifact reproduces
itself byte-for-byte from that commit's source (it is the
self-hosted-built stage, and the B≡C fixpoint held when it was made).

To re-baseline:

```bash
npm run reseed -w @zena-lang/zena-compiler   # gated on the full suite + fixpoint
npm test                                     # rebuild + retest from the new bootstrap
```

then commit the new `cli.wasm` together with the change that motivated
it. Never edit this artifact by hand; `cli.cwasm`/`cli.lock` beside it
are local precompilation caches, gitignored.
