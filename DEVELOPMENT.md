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
npm install
npm run build
npm test
```

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
cargo build          → zena-cli            (Rust/wasmtime host, from source)
zena-cli + bootstrap → zena/out/cli.wasm   (the working compiler)
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

## CI

`nix flake check` builds the whole monorepo hermetically in the Nix
sandbox — cargo compiles `zena-cli`, the bootstrap compiles the
compiler, and the entire `npm test` suite runs offline — so CI is also
a standing proof that a clean checkout bootstraps.

## Where things live

- `packages/zena-compiler` — the compiler (Zena). `zena/lib/codegen/`
  has its own CONTEXT.md files.
- `packages/zena-cli` — Rust host that executes the compiler and Zena
  programs under wasmtime.
- `packages/stdlib` — the standard library.
- `tests/language/` — portable language tests (syntax / semantics /
  execution) shared by all compiler implementations.
- `docs/language-reference.md` — the language reference;
  `docs/design/` — design docs; `PLAN.md` — roadmap. Known bugs are
  [GitHub issues](https://github.com/elematic/zena/issues).
