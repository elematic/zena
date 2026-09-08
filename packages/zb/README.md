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

- wireit script configs: `command`, `files`, `output`, string
  `dependencies` (including `../pkg:script` and dependency-only scripts),
  `clean` (`true`/`false`/`if-file-deleted`), comment keys
- wireit's tracking rules: a script with a command is only fresh or
  cacheable when both `files` and `output` are declared (an explicit
  `[]` counts); omitting either means unknown inputs or outputs, so the
  script always runs and so do its dependents. Command-less scripts are
  dependency groups.
- bare npm scripts as always-run commands (with the same dependent
  poisoning)
- content-addressed local cache under `.zb/` (state file, per-key
  manifests, blob store); lost state restores from cache instead of
  rebuilding
- precise cleaning: exactly the previous run's outputs are deleted, not a
  glob guess

Not yet (see the design doc's milestones):

- services and watch mode
- parallel command execution (process waiting is synchronous, so scripts
  run one at a time)
- `packageLocks` fingerprinting; wireit's `env` and object-form
  dependencies are rejected loudly
- an mtime memo for input hashing — every run rehashes all inputs
- output freshness trusts the disk: deleting an output file by hand does
  not make its step stale
- remote caches, per-output incremental deltas to commands

## Running

Prerequisite: a built checkout (`npm run build`), so
`target/release/zena-cli` and the compiler exist. From the repository
root:

```sh
./target/release/zena-cli run --dir . --allow-spawn packages/zb/zena/main.zena \
  [-C <workspace-root>] [<package-dir>] <script>
```

`--dir .` grants filesystem access and `--allow-spawn` process spawning;
`-C` points at a workspace other than the current directory. Each step
prints one of `ran`, `fresh`, `restored`, `skipped (...)`, or `FAILED`.

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
content-addressed). Because state sits next to each `package.json`, the
cache location does not depend on the directory zb was invoked from.
To bust it: deleting a package's `state.json` drops freshness but its
steps restore from the cache; deleting the package's `.zb/` (or all of
them) forces a rebuild. There is no `--force` flag yet.

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

| Command                                                                                                               | First run | Fresh rerun    |
| --------------------------------------------------------------------------------------------------------------------- | --------- | -------------- |
| `packages/stdlib build` (tsc)                                                                                         | ~8s       | <1s            |
| `packages/zena-compiler build:cli` (the compiler, via the bootstrap, plus its cargo and stdlib dependencies)          | ~28s      | ~11s           |
| `build` (the whole monorepo: every package, the self-hosted compiler rebuild, the language-service wasm, the website) | minutes   | ~30s, 24 steps |

The root build converges over two runs: the first zb build regenerates
some outputs with contents that differ from wireit's, so a handful of
downstream steps rerun once, and from the third run on everything is
fresh. Rerun time is dominated by rehashing the input closure (~4,600
files for `build:cli` alone); the design doc's mtime-memo and
configuration-snapshot milestones exist to cut exactly this.

zb keeps its own state in `.zb/` and never touches `.wireit/`, so it can
run side by side with wireit on the same checkout. The two systems do
not share caches: after building with one, the other will re-run steps
whose outputs changed on disk.

## Layout

- `zena/main.zena` — the CLI
- `zena/runner.zena` — config → plan → engine run → persisted state
- `zena/wireit-config.zena` — package.json wireit parsing and resolution
- `zena/builder.zena` — script configs → workflow steps and run callbacks
- `zena/fs-walk.zena`, `zena/glob.zena` — input discovery
- `zena/disk-cache.zena`, `zena/state-json.zena` — the `.zb/` formats
- `zena/sha256.zena` — content fingerprints

Tests: `npm test -w @zena-lang/zb`. The end-to-end tests build fixture
workspaces under `/tmp` through the real filesystem and shell.
