# The bootstrap CLI module

`zena.wasm` is the prebuilt Zena CLI module that bootstraps a fresh checkout.
Once cargo builds `zena-cli` (`cargo build --release -p zena-cli`), the host
falls back to `bootstrap/zena.wasm` whenever `out/zena.wasm` has not been built
yet, so `zena build`, `zena fmt`, `zena lint`, `zena run` and `zena test` work
immediately. During a repository build, `zena-compiler:build:cli` runs
`bootstrap/zena.wasm` to compile `zena/cli/main.zena` into the working Stage A
compiler (`packages/zena-compiler/zena/out/cli.wasm`), which then compiles
`packages/zena-cli/out/zena.wasm` and every other package. It is the only
prebuilt artifact in the repository.

Why it is checked into git, the invariant it upholds, how to audit it, and how
to land changes it cannot compile are covered in
[docs/design/bootstrapping.md](../../../docs/design/bootstrapping.md).

Its provenance is its git history: the commit that last changed `zena.wasm` is
the re-baseline commit, and the artifact reproduces itself byte-for-byte from
that commit's source.

To re-baseline:

```bash
npm run reseed   # gated on the full suite + fixpoint + byte-for-byte self-audit
npm test         # rebuild + retest from the new bootstrap
```

Commit the new `zena.wasm` together with the change that motivated it. Never
edit this artifact by hand; `*.cwasm` and `*.lock` beside it are local
precompilation caches, gitignored.
