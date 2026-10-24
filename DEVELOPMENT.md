# Developing Zena

How the repository builds, tests, and bootstraps. For what Zena _is_,
see [README.md](./README.md); for agent-focused rules, see
[AGENTS.md](./AGENTS.md).

## Prerequisites

The supported environment is the **Nix flake**: `nix develop` (or
`direnv allow`) provides Node.js, Rust/cargo, wasmtime, and
wasm-tools at pinned versions. Without Nix you need Node.js 25+ and a
Rust toolchain; wasmtime and wasm-tools are only required for WASI
testing and wasm debugging.

```bash
npm ci
npm run build
npm test
```

`npm ci` installs what `package-lock.json` pins and never rewrites it.
Wireit counts the lockfile as an input of every script, so an
`npm install` that changes it reruns the whole build. To add or change a
dependency, use `npm i <package>` and commit the lockfile it writes.

Always drive builds and tests through `npm run` / `npm test` — they go
through [Wireit](https://github.com/google/wireit), which builds
dependencies in the right order and caches by input content. Never run
`node`/`npx`/`tsx` against sources directly, and trust "already fresh"
cache hits.

## How the build bootstraps

The Zena compiler is written in Zena, so a fresh checkout builds it
from **the bootstrap**: `packages/zena-compiler/bootstrap/cli.wasm`, a
prebuilt, checked-in build of the self-hosted compiler and the only
prebuilt artifact in the repository.

```
cargo build          → zena-cli, zena-run  (Rust/wasmtime hosts, from source)
zena-run + bootstrap → zena/out/cli.wasm   (the working compiler)
zena/out/cli.wasm    → everything else     (stdlib tests, LSP, formatter, …)
```

The invariant, enforced by `npm test` and CI on every change: **the
bootstrap must build a HEAD that passes the test suite**, including
`test:fixpoint` — the compiler compiled by itself must byte-match the
compiler compiled by _that_ compiler, so a compiler that miscompiles
itself cannot land.

Re-baselining the bootstrap (rare, on demand):

```bash
npm run reseed -w @zena-lang/zena-compiler   # gated on the full suite + fixpoint
npm test                                     # rebuild + retest from the new bootstrap
```

Full design: [docs/design/bootstrapping.md](./docs/design/bootstrapping.md).

## Rust dependencies

The Rust crates (`zena-runtime`, and the `zena-run`, `zena-cli` and `zfx`
binaries) each depend on `packages/workspace-hack`, which
[cargo hakari](https://docs.rs/cargo-hakari) generates so that every
crate resolves the same features for the dependencies they share. Without
it, building one binary compiles its own copy of wasmtime and Cranelift
when its features differ from another's by one. After adding, removing or
changing a dependency:

```bash
cargo hakari generate      # rewrite workspace-hack/Cargo.toml
cargo hakari manage-deps   # add workspace-hack to a new crate
```

CI runs both with `--diff`/`--dry-run` and fails when either would change
something.

## CI

`nix flake check` builds the whole monorepo hermetically in the Nix
sandbox — cargo compiles `zena-cli`, the bootstrap compiles the
compiler, and the entire `npm test` suite runs offline — so CI is also
a standing proof that a clean checkout bootstraps.

## Where things live

- `packages/zena-compiler` — the compiler (Zena). `zena/lib/codegen/`
  has its own CONTEXT.md files.
- `packages/zena-runtime` — Rust library: what a compiled Zena module
  needs from its wasmtime host (engine flags, `.cwasm` cache, the
  stack-trace and `zena:process` imports). The Rust counterpart of
  `packages/runtime`.
- `packages/zena-cli` — Rust host that executes the compiler and Zena
  programs under wasmtime; also the test, bench and doc runners.
- `packages/zena-run` — Rust host that runs one compiled module and
  nothing else.
- `packages/stdlib` — the standard library.
- `tests/language/` — portable language tests (syntax / semantics /
  execution) shared by all compiler implementations.
- `docs/language-reference.md` — the language reference;
  `docs/design/` — design docs; `PLAN.md` — roadmap. Known bugs are
  [GitHub issues](https://github.com/elematic/zena/issues).
