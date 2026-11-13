# zebra

An incremental script and service runner for Zena (`zena-package.json`), standalone Zebra (`zebra.json`), and [Wireit](https://github.com/google/wireit) (`package.json`) workspaces, built on `zena-lang:workflow`.

Zebra runs a dependency graph of scripts and long-running services with declared inputs, outputs, and dependencies, rerunning only what changed. For each script, Zebra content-hashes the declared inputs and asks the workflow engine what to do: nothing (when the previous run recorded the same fingerprints and declared outputs are intact), restore from the local content-addressed cache, or execute the command (`sh -c` in the package directory with `node_modules/.bin` on `PATH`).

## Installation

`zebra` is built into the `zena` CLI (`zena build <target>`). To use it as a library or standalone runner:

```sh
zena pkg add zena-lang:zebra
```

## CLI Usage

```sh
zena build [-j <jobs>] [-w|--watch] [-f|--force] [--no-cache] [-v|--verbose] [<target>] [-- <args>...]
zena build --migrate [--dry-run] [-f|--force] [<package-dir>...]
```

- `<target>` can be a script name in the current package (`zena build test`), a package directory (`zena build ./packages/app`, which runs `build`), or `<package-dir>:<script>` (`zena build ./packages/app:test`). With no `<target>`, `zena build` runs the current package's `build` script.
- `-- <args>...` appends shell-quoted arguments to the entry target's command only, running that entry step uncached without overwriting its saved freshness record.
- `-j` / `--jobs <n>` bounds parallel command execution (defaulting to `ZEBRA_PARALLEL`, `WIREIT_PARALLEL`, or `ZENA_AVAILABLE_PARALLELISM`).
- `-w` / `--watch` watches input globs, lockfiles, and package manifests for changes, re-running affected steps incrementally while keeping unchanged services alive in a `ServicePool` across rebuilds.
- `-f` / `--force` bypasses freshness and cached outputs to rerun scripts unconditionally.
- `--no-cache` disables restoring outputs from `.zebra/blobs/` when a step is not fresh.
- `-v` / `--verbose` prints every step (including `fresh` and `skipped`) and any captured stdout/stderr on the rail.
- `--migrate` converts Wireit blocks in `package.json` into `zena-package.json` (when present) or `zebra.json`.

## Programmatic Usage

```zena
import { buildTarget, reportBuild } from 'zena-lang:zebra/runner';
import { ScriptRef } from 'zena-lang:zebra/wireit-config';

let outcome = await buildTarget('.', new ScriptRef('packages/app', 'build'), {
  parallelism: 4,
});
let exitCode = reportBuild(outcome);
```

## Configuration (`zena-package.json` and `zebra.json`)

Zena packages configure scripts and filesets directly in `zena-package.json`. Non-Zena projects can use a standalone `zebra.json` (with an optional `"workspace": {"packages": [...]}` at the workspace root). Both support `//` and `/* ... */` comments:

```jsonc
{
  "name": "app",
  "dependencies": {
    "lib": {"path": "../lib"},
  },
  "filesets": {
    "assets": ["assets/**"],
  },
  "scripts": {
    "build": {
      "command": "zena build src/main.zena -o out/app.wasm",
      "output": ["out/app.wasm"],
      "dependencies": ["source", "assets"],
    },
    "test": {
      "command": "zena test",
      "files": ["test/**/*_test.zena"],
      "dependencies": ["source"],
    },
    "fmt": "zena fmt --check .",
  },
}
```

- **Automatic `source` fileset**: Every package with `zena-package.json` exposes an automatic `source` fileset covering its library `.zena` files (from `"source"`, defaulting to `"src"` and excluding `*_test.zena`, `test/**`, and `tests/**`), `zena-package.json`, any `"wit"` dependencies, and the `source` filesets of all `"path"` dependencies. Scripts opt into it via `"dependencies": ["source"]` (or `"../pkg:source"`).
- **Named `filesets`**: Entries accept either a glob array shorthand (`"wit": ["wit/**/*.wit"]`) or `{"files": [...], "dependencies": [...]}` and compose transitively without spawning commands.
- **Caching and tracking**: Task scripts cache automatically whenever `files`, `output`, or a fileset dependency is declared, defaulting `output` to `[]` when omitted. Setting `"cache": false` opts a step out of freshness and caching while keeping its `files` globs active in `--watch` mode. Omitting `files`, `output`, and fileset dependencies on a command step leaves it untracked so it runs every time. String entries (`"fmt": "zena fmt --check ."`) are shorthands for always-run commands.
- **Locks**: `locks` defaults to `["zena-lock.json"]` and may be set at the package root or overridden per script (`"locks": []` disables lockfile hashing).
- **Services**: Scripts with `"service": true` or `"service": {"readyWhen": {"lineMatches": "..."}}` start on demand when a dependent executes, wait for readiness when configured, are shared across dependents, and are stopped as a Unix process group (`SIGTERM` then `SIGKILL`) when dependents finish. Invoking a service directly as the top-level target runs its dependencies and streams the service in the foreground.
- **Wireit fallback**: When a package directory has no `zebra.json` and no `"scripts"` block in `zena-package.json`, Zebra falls back to `package.json` Wireit scripts while still serving filesets from `zena-package.json`. Dependencies can cross freely between `zena-package.json`, `zebra.json`, and `package.json` packages.

## Cache Layout (`.zebra/`)

Each package's `<pkg>/.zebra/` directory stores:

- `state.json` — freshness records for that package's scripts (the last cache key and output manifest).
- `cache/<key>.json` — cache key to output manifest.
- `blobs/` — content-addressed output bytes (`sha256`).

The workspace root's `.zebra/` directory stores:

- `hashes.json` — the `(mtime, size)` to `sha256` file hash memo shared across packages (with a 20ms racy-timestamp guard).
- `plans/<hash>.plan` — `stat`-verified cached `ScriptConfig` closures keyed by target entry.

A dependency contributes the digest of its _outputs_ to dependents' cache keys rather than its input fingerprint, giving early cutoff when a dependency reruns and produces identical outputs.

### GitHub Actions Remote Cache

Setting `ZEBRA_CACHE=github` layers `GitHubActionsCache` behind the local `.zebra/` `DiskCache` (`TieredCache`). On a local cache miss, Zebra queries the GitHub Actions v2 `CacheService` Twirp JSON API, verifies downloaded blob `sha256` digests, populates `<pkg>/.zebra/`, and materializes outputs into the workspace. On a build step execution, Zebra writes `<pkg>/.zebra/` first and uploads the step's entry to GitHub Actions Cache (`ZEBRA_CACHE_READ_ONLY=1` disables uploads; `ZEBRA_CACHE=none` disables both local and remote caching).

In GitHub Actions workflows, run `.github/actions/setup-zebra-cache` before build steps so `ACTIONS_RESULTS_URL` and `ACTIONS_RUNTIME_TOKEN` are served to `run:` steps over a `127.0.0.1` token custodian (`ZEBRA_GITHUB_CUSTODIAN_URL`).

## Libraries

- `zebra` (`zebra/main`) — CLI entry point (`main`).
- `zebra/runner` — `buildTarget`, `watchTarget`, `BuildOptions`, `WatchOptions`, `reportBuild`, `reportMigration`, `formatBuildReport`, and `BuildOutcome`.
- `zebra/zebra-config` — `zena-package.json` and `zebra.json` parsing (`ZebraWorkspace`), synthesized `source` filesets, and Wireit migration (`migrateWorkspaceToZebra`, `convertPackageJsonToZebraJson`, `mergeWireitIntoZenaPackageJson`).
- `zebra/wireit-config` — `package.json` Wireit parsing (`WireitWorkspace`) and shared script configuration types (`ScriptConfig`, `ScriptRef`, `DependencySpec`, `ServiceConfig`, `EnvBinding`, `ConfigError`, `refKey`, `resolveDependency`).
- `zebra/plan-cache` — `.zebra/plans/` snapshot serialization and `stat`-verified warm plan loading (`loadOrCollectConfigs`, `PlanLoadStats`, `ConfigProbe`).
- `zebra/builder` — Translates `ScriptConfig` closures into `workflow` steps and execution callbacks (`planScripts`, `StepExecution`, `lockfileCandidates`).
- `zebra/disk-cache`, `zebra/github-cache`, and `zebra/state-json` — `.zebra/` blob/manifest storage (`DiskCache`, `TieredCache`, `stateDirOf`), GitHub Actions remote caching (`GitHubActionsCache`, `GitHubCacheConfig`, `CacheMode`, `resolveCacheMode`, `resolveGitHubCacheConfig`), and JSON serialization for state, manifests, and hash memos.
- `zebra/fs-walk` and `zebra/fs-util` — Input glob discovery (`FileHasher`, `expandGlobs`, `hashFile`, `validateGlobs`, `splitBase`) and workspace path utilities.
- `zebra/colors`, `zebra/layout`, `zebra/animation`, and `zebra/shell` — Terminal color formatting, Clack-style rail layout (`RailLayout`), interactive spinner animation (`Spinner`), and POSIX shell argument quoting (`shellQuote`, `appendShellArgs`).

## License

MIT
