# zb

An incremental script runner: zb runs a graph of scripts and services
with declared inputs, outputs, and dependencies, rerunning only what
changed. It is written in Zena on the `workflow` engine
(`packages/workflow`); `docs/design/workflow.md` describes the layered
design this implements and where it is headed.

Configuration currently comes from a
[wireit](https://github.com/google/wireit) compatibility mode: zb reads
the same `package.json` wireit blocks this repository already uses.
Zena workspaces will get their own configuration (likely as part of the
Zena package manifests) as that format takes shape.

For each script, zb content-hashes the declared inputs and asks the
engine what to do: nothing (the previous run recorded the same
fingerprints), restore from the local cache, or run the command.
Commands run through `sh -c` in the package directory with
`node_modules/.bin` on `PATH`, like wireit through npm.

## Status

Working today:

- wireit script configs: `command`, `files`, `output`, `packageLocks`
  (`['package-lock.json']` by default, `[]` to disable), `dependencies`
  (strings, `../pkg:script`, dependency-only scripts, and `{script,
cascade}` objects), `env` (literal values and `{external: true,
default?}`), `service` (`true` and `{readyWhen: {lineMatches}}`),
  `clean` (`true`/`false`/`if-file-deleted`), comment keys
- wireit's tracking rules: a task script with a command is fresh or
  cacheable when both `files` and `output` are declared (an explicit
  `[]` counts); omitting either means unknown inputs or outputs, so the
  script always runs and its cascading dependents rerun too. Services
  track their identity when `files` is declared, and command-less
  scripts forward their resolved inputs as dependency/fileset groups.
- lazy per-step input expansion and a persistent `(mtime, size)` hash
  memo (`.zb/hashes.json`, with a 20ms racy-timestamp guard): a step's
  `files` globs expand after its dependencies finish, literal file
  entries check only that path, and warm runs verify unchanged files by
  `stat` without rereading bytes
- on-disk output verification: before reporting a key-matched step
  `fresh`, zb checks that its recorded file outputs still match on disk,
  restoring from `.zb/blobs/` or rerunning the command if an output was
  deleted or modified
- services: started on demand when a dependent executes, gated on
  `readyWhen.lineMatches` when configured, shared across dependents,
  skipped when all dependents are fresh or cached, and stopped as a Unix
  process group (`SIGTERM` then `SIGKILL`). Invoking a service directly
  as the top-level target runs its dependencies and streams the service
  in the foreground.
- watch mode (`-w` / `--watch`): watches input globs, lockfiles, and
  `package.json` manifests for changes, re-running affected steps
  incrementally while keeping unchanged services pinned alive in a
  `ServicePool` across rebuilds and restarting them (stopping child
  services before parents) only when their own configuration or inputs
  change. `SIGINT` and `SIGTERM` cleanly stop in-flight scripts,
  foreground services, and pinned watch-mode service process groups in
  reverse startup order before exiting (`130` / `143`).
- bare npm scripts as always-run commands (with dependent poisoning)
- content-addressed local cache under `.zb/` (state file, per-key
  manifests, blob store); lost state restores from cache instead of
  rebuilding
- bounded parallel command execution (`-j <jobs>`, defaulting to
  `ZENA_AVAILABLE_PARALLELISM`), cache flags (`-f` / `--force`,
  `--no-cache`), and verbose output (`-v` / `--verbose`)
- Clack-style rail output (`┌`, `│`, `◇`, `◆`, `○`, `▲`, `■`, `└`) with
  per-step durations, buffered stdout/stderr blocks shown on failure (or
  for all non-empty outputs with `-v` / `--verbose`), summarized fresh
  and skipped step counts by default, and a live interactive spinner
  when stdout is a terminal
- precise cleaning: the previous run's recorded file outputs are deleted

Not yet (see the design doc's milestones):

- remote caches, per-output incremental deltas to commands

## Running

Prerequisite: a built checkout (`npm run build`), so
`target/release/zena-cli` and the compiler exist. From the repository
root:

```sh
./target/release/zena-cli build [-j <jobs>] [-w|--watch] [-f|--force] [--no-cache] [-v|--verbose] [<target>]
# or directly:
./target/release/zena-cli run --dir . --allow-spawn packages/zb/zena/main.zena \
  [-C <workspace-root>] [-j <jobs>] [-w|--watch] [-f|--force] [--no-cache] [-v|--verbose] [<package-dir>] <script>
```

`--dir .` grants filesystem access and `--allow-spawn` process spawning;
`-C` points at a workspace other than the current directory. By default,
executed (`ran`), cache-restored (`restored`), and failed (`FAILED`)
steps appear on the rail and `fresh` / `skipped` steps are summarized in
the footer (`└  build succeeded in 42ms (2 ran, 4 fresh)`); pass `-v` /
`--verbose` to list every step and any captured stdout/stderr on the
rail.

## The example workspace

`example/` is a three-package workspace: `greeting` concatenates text
files, `site` builds an HTML page from them, and `hello-wasm` compiles a
real Zena program with `zena-cli`. Build it all:

```sh
./target/release/zena-cli run --dir . --allow-spawn packages/zb/zena/main.zena \
  -C packages/zb/example build
```

The first run reports `ran` for every step; a second run reports `fresh`.
Edit `example/greeting/src/hello.txt` and only `greeting` and `site`
rebuild. The built page is `example/site/out/index.html`, and the wasm
runs directly:

```sh
wasmtime run -W gc=y -W function-references=y -W exceptions=y \
  --invoke main packages/zb/example/hello-wasm/out/hello.wasm
```

Build state lives in each package's `.zb/` directory (gitignored, safe
to delete — the next build restores outputs from scratch or cache).

## The cache

Build state lives per package, like wireit's `.wireit/`: each package's
`<pkg>/.zb/` holds `state.json` (freshness records for that package's
scripts: the last cache key and output manifest), `cache/<key>.json`
(cache key → output manifest), and `blobs/` (output bytes,
content-addressed). The workspace root's `.zb/hashes.json` stores the
`(mtime, size)` → `sha256` file memo shared across packages. Because
per-package state sits next to each `package.json`, the cache location
does not depend on the directory zb was invoked from. Pass `-f` /
`--force` to rerun scripts regardless of freshness or cached outputs, or
`--no-cache` to disable restoring from `blobs/` when a step is not
fresh. Deleting a package's `state.json` drops freshness while keeping
cached blobs; deleting `.zb/` directories clears both.

One semantic difference from wireit to know about: a dependency
contributes the digest of its _outputs_ to dependents' cache keys, not
its input fingerprint. That gives early cutoff (a dependency that reruns
but produces identical outputs leaves dependents fresh) — and it makes
complete `output` declarations matter more than under wireit, where
input-transitive fingerprints rerun dependents regardless. An output a
step produces but does not declare is invisible to dependents.

## Building this repository

zb builds real targets of this monorepo from its existing wireit
configuration, measured on a warm checkout:

| Command                                                                                                      | First run | Fresh rerun |
| ------------------------------------------------------------------------------------------------------------ | --------- | ----------- |
| `packages/stdlib build` (tsc)                                                                                | ~8s       | ~0.05s      |
| `packages/zena-compiler build:cli` (the compiler, via the bootstrap, plus its cargo and stdlib dependencies) | ~28s      | ~0.35s      |

The root build converges over two runs: the first zb build regenerates
some outputs with contents that differ from wireit's, so a handful of
downstream steps rerun once, and from the third run on everything is
fresh. Warm rerun time on `build:cli` is mostly the untracked `cargo
build --release -p zena-run` check (~0.25s); `.zb/hashes.json` and
literal-path resolution avoid rereading unchanged source and output
files across runs.

zb keeps its own state in `.zb/` and never touches `.wireit/`, so it can
run side by side with wireit on the same checkout. The two systems do
not share caches: after building with one, the other will re-run steps
whose outputs changed on disk.

## Layout

- `zena/main.zena` — the CLI
- `zena/runner.zena` — config → plan → engine run → persisted state and
  rail report
- `zena/wireit-config.zena` — package.json wireit parsing and resolution
- `zena/builder.zena` — script configs → workflow steps and run callbacks
- `zena/fs-walk.zena` — input discovery: walks each glob's literal base
  directory and keeps what `zena:glob`'s `GlobSet` matches
- `zena/disk-cache.zena`, `zena/state-json.zena` — the `.zb/` formats
- `zena/colors.zena`, `zena/layout.zena`, `zena/animation.zena` —
  standalone terminal formatting, Clack-style rail layout, and spinner
  animation helpers

Fingerprints are `sha256:<hex>`, hashed with `zena:crypto`.

Tests: `npm test -w @zena-lang/zb`. The end-to-end tests build fixture
workspaces under `/tmp` through the real filesystem and shell.
