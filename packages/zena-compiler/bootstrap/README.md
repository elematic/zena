# The seed

`cli.wasm` is the prebuilt self-hosted Zena compiler that breaks the
bootstrap cycle: `build:cli` runs it (through `zena-cli`, which cargo
builds from source) to compile `zena/cli/main.zena` into the working
compiler, and everything else builds from there. It is the only
prebuilt artifact in the repository; see
`docs/design/bootstrap-retirement.md` §2 for why it is checked into
git rather than fetched.

## Provenance

- **Built from**: commit `6d6404e1049d8997726e4dd312e363a16b7323cb`
  (tree `b8e4d7a0e369350ede00f5dfd0df75e22701b01b`), 2026-08-06.
- **How**: `npm run build:self-hosted -w @zena-lang/zena-compiler`,
  i.e. this is the *self-hosted-built* compiler (stage B of the
  fixpoint gate), not the TypeScript-bootstrap-built one. Because the
  B≡C fixpoint held at the pin commit, this seed compiling its own
  source reproduces itself byte-for-byte — `cmp` against a fresh
  `zena/out/cli.wasm` built at the pin commit is the integrity check.

## The rule

**The seed must be able to build current HEAD.** Nothing more — see
the ratchet in `docs/design/bootstrap-retirement.md` §3. When a
language change makes HEAD unbuildable by the seed, land the change in
two steps (first a version the seed can compile, then the version
using the new feature), or re-baseline.

## Re-baselining

From a commit where the full suite and `test:fixpoint` are green:

```bash
npm run build:self-hosted -w @zena-lang/zena-compiler
cp packages/zena-compiler/zena/out/cli-self.wasm \
   packages/zena-compiler/bootstrap/cli.wasm
```

Then update the provenance block above with the new commit hash, and
commit both together. Re-baseline on demand (a seed too old to build
HEAD, or a codegen improvement worth capturing), not per change.
