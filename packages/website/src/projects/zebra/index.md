---
title: 'Zebra'
description: 'The Zena Build and Run tool: a Wireit-inspired task graph, content-addressed build cache, and dev service supervisor, with planned WebAssembly build rules.'
status: 'In progress'
statusType: 'warning'
lead: "Zebra is the Zena Build and Run tool—an incremental task runner, build cache, and dev service supervisor inspired by Google's Wireit and written in Zena."
---

Zebra (`packages/zebra`, invoked via `zena build` or `zebra`) is inspired by
[Google's Wireit](https://github.com/google/wireit). Its goal is to give Zena a
native task graph and incremental build runner without depending on Node.js,
iterating on Wireit's design with faster startup today and planned extensions
for custom build rules as WebAssembly components, incremental file-delta steps,
in-memory resident workers, Blaze-style graph queries, and build dashboards.

Although Zebra is written in Zena and ships with the Zena toolchain, its task
graph and caching model do not assume Zena source code. A target can compile
`.zena` libraries, build a Rust crate with Cargo, compile TypeScript, or run a
WebAssembly component.

## Build and run model

A workspace defines targets across one or more packages: build steps that
transform declared input files into declared output files, reusable `filesets`,
one-shot commands such as linters and test runners, and persistent background
services such as HTTP servers or emulators.

Running a target resolves the transitive subgraph of dependencies it needs,
checks which inputs have changed, executes outdated build steps in parallel up
to a configurable concurrency limit, and then either finishes or launches the
requested program or service.

Zebra reads native Zena package manifests (`zena-package.json`), standalone
`zebra.json` files for non-Zena repositories, and existing `wireit` blocks in
`package.json` (with `zena build --migrate` to convert `package.json` scripts
into `zena-package.json` or `zebra.json`):

```sh
# Build the current package, or a specific package target
zena build
zena build packages/zena-compiler:build

# Watch inputs and keep dependent dev services running
zena build -w packages/website:serve
```

## Task graphs, caching, and dev services

Zebra separates dependency scheduling from filesystem and process I/O, keeping
warm no-op checks down to `stat` calls and cached plan snapshots:

- **Pure workflow core (`packages/workflow`)** — Task scheduling, cycle
  detection, topological ordering, readiness queues, and per-step memoization
  live in an I/O-free Zena library (`zena:workflow`). That same library is
  reusable in other tools, including in-memory compilers and the planned
  [static site generator](/projects/ssg/).
- **Fast startup and plan snapshots (`.zebra/plans/`)** — Zebra runs as a
  precompiled Wasm component without Node startup overhead. Cold runs snapshot
  resolved target closures into `.zebra/plans/`; warm runs verify config file
  `stat` stamps and skip re-reading or re-parsing package manifests.
- **Content-addressed `.zebra/` cache and early cutoff** — File inputs are
  hashed with SHA-256 and memoized by `(mtime, size)` in `.zebra/hashes.json`.
  Each package's `.zebra/` directory stores action manifests and output blobs in
  `.zebra/blobs/`. Dependencies contribute the digest of their _outputs_ to
  downstream cache keys: if a step re-runs after a comment edit and produces
  identical output bytes, downstream dependents stay fresh.
- **Managed dev services** — Long-running targets declare readiness patterns
  (`readyWhen.lineMatches`) and run under a supervisor pool that coordinates
  startup order, keeps unchanged services alive across `--watch` rebuilds, and
  stops Unix process groups cleanly on exit.

## Custom build rules as WebAssembly components

Custom build rules are planned and not implemented yet. Today Zebra executes
shell commands, scripts, and supervised services declared in package manifests.

In Wireit, every package repeats the same command flags, input globs, output
directories, and cross-package dependencies by hand—even when another tool
config in the directory already declares them. Meanwhile, shelling out to
custom scripts is slow to start, OS-dependent, and unsandboxed.

Zebra's planned plugin model will use WebAssembly components (built on the
[`zena:host` extension interfaces](/projects/runtime/#sandboxed-wasm-extensions))
to package custom build rules, asset transforms, and target runners:

- **Config-aware rule expansion** — A TypeScript build-rule component will be
  able to read `tsconfig.json` directly (`include`, `outDir`, and project
  `references`) and emit the corresponding task inputs, outputs, and upstream
  dependencies, avoiding duplicated configuration across `tsconfig.json` and the
  build manifest.
- **Capability-scoped execution** — Rule and transform components will receive
  read access only to declared input directories and write access only to
  declared output directories, with no ambient filesystem or network access
  unless explicitly granted.
- **Language-agnostic distribution** — Any language that compiles to a WASI
  component (Zena, Rust, Go, C, or others) will be able to author a Zebra rule,
  and the compiled `.wasm` binary will run identically on Linux, macOS, and
  Windows.

## Incremental steps, resident workers, and graph queries

Incremental steps, resident workers, graph queries, and dashboards are also
planned designs and not implemented yet:

- **Incremental steps** — Standard task runners re-invoke a step from scratch
  whenever any input changes. For steps that opt into incremental execution,
  Zebra will pass the exact set of added, modified, and deleted input files
  since the step's previous run so compilers, bundlers, and site generators can
  update only affected outputs.
- **In-memory and resident workers** — Steps implemented as Wasm components or
  persistent worker processes will be able to stay resident in memory across
  multiple targets in a build and across `--watch` cycles, keeping parsed ASTs,
  type caches, and compiled state warm without cold process startup per package.
- **Blaze-style graph queries** — Over Zebra's explicit target and fileset
  graph, planned workspace queries (modeled on Bazel / Blaze `query`) will
  answer what depends on a package, trace the dependency chain between two
  targets, or list the minimal set of test targets affected by a git diff.
- **Dashboards** — Structured execution events will feed terminal and local web
  dashboards showing critical-path timelines, cache hit rates, per-step logs,
  and live status for background dev services.

## Current status and roadmap

Zebra (`packages/zebra` and `packages/workflow`) runs in the Zena monorepo today
with `zena-package.json`, `zebra.json`, and `package.json` (`wireit`) support,
`--migrate` config conversion, `.zebra/` plan, hash, and blob caches, early
cutoff, watch mode, supervised services, and Clack-style terminal progress
output.

Planned work is tracked in
[open Zebra issues on GitHub](https://github.com/elematic/zena/issues?q=is%3Aissue+state%3Aopen+in%3Atitle+zebra)
and covers:

- The Wasm component API for custom build rules (such as `tsconfig.json`-driven
  TypeScript rules) and sandboxed transforms.
- Incremental file-delta delivery to steps and resident in-memory worker
  execution.
- Blaze-style dependency graph queries (`deps`, `rdeps`, `somepath`, and
  affected-target selection).
- Local build and service dashboards, plus shared remote caches for CI and teams.

→ Source: [`packages/zebra`](https://github.com/elematic/zena/tree/main/packages/zebra) ·
[`packages/workflow`](https://github.com/elematic/zena/tree/main/packages/workflow) ·
Design: [`docs/design/workflow.md`](https://github.com/elematic/zena/blob/main/docs/design/workflow.md) ·
[Open issues](https://github.com/elematic/zena/issues?q=is%3Aissue+state%3Aopen+in%3Atitle+zebra)
