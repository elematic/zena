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

The Zena compiler and CLI are written in Zena, so a fresh checkout
builds from **the bootstrap**: `packages/zena-cli/bootstrap/zena.wasm`,
a prebuilt, checked-in build of the CLI module and the only prebuilt
artifact in the repository.

```
cargo build          → zena-cli, zena-run       (Rust/wasmtime hosts, from source)
zena-cli + bootstrap → zena/out/cli.wasm        (Stage A: the working compiler)
zena/out/cli.wasm    → out/zena.wasm, and rest  (CLI module, stdlib tests, LSP, …)
```

Before `packages/zena-cli/out/zena.wasm` is built, `zena-cli` falls back
to `bootstrap/zena.wasm`, so `zena build`, `zena fmt` and `zena lint`
work immediately after `cargo build --release -p zena-cli`.

The invariant, enforced by `npm test` and CI on every change: **the
bootstrap must build a HEAD that passes the test suite**, including
`test:fixpoint` — the compiler compiled by itself must byte-match the
compiler compiled by _that_ compiler, so a compiler that miscompiles
itself cannot land.

Re-baselining the bootstrap (rare, on demand):

```bash
npm run reseed   # gated on the full suite + fixpoint + byte-for-byte self-audit
npm test         # rebuild + retest from the new bootstrap
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
something. [packages/workspace-hack/README.md](./packages/workspace-hack/README.md)
has more, including how to check that the binaries share their build.

## CI

The GitHub workflow (`.github/workflows/test.yml`) runs `npm test` in the
dev shell. It restores three caches, so a run rebuilds only what its change
reaches: the Rust dependencies (rust-cache), the workspace crates' own
build, which `scripts/ci-cargo-freshness.py` lets cargo reuse, and wireit's
script results.

`nix flake check` builds the whole monorepo hermetically in the Nix
sandbox — cargo compiles `zena-cli`, the bootstrap compiles the
compiler, and the entire `npm test` suite runs offline — so it shows
that a clean checkout bootstraps, which a cached run does not.

### Known CI flakes

Rerun the failed jobs (`gh run rerun <run> --failed`) when a failure
matches one of these:

- **Out of memory.** Scripts end `killed` and the job ends with
  "The operation was canceled", with no failing test. The runner has
  16 GB, and a change to the compiler reruns every script. The `mem`
  lines the test step prints every 30 seconds show `available=` falling
  below 1 GiB just before.
- **The `http-service` component test** (`test:component` in
  `packages/zena-compiler`) gets empty bodies for its four concurrent
  requests under load (#449).
- **A script's output missing after a cache restore.** A script fails
  because a file another script declares as its output is not there,
  although that script's result was restored from wireit's cache: for
  example `zenafx:test` reporting `out/widgets.wasm is missing`. Rerun
  when the change touches none of the missing file's inputs.

`WARNING: recompiling … deserialization failed` is not a failure: a
`.cwasm` built on another machine is compiled again in place.

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
