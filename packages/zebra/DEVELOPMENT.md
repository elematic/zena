# Developing `zebra`

This document covers the internal layout, CLI invocation inside the monorepo, and test suites for `packages/zebra`.

## Directory Layout

```text
packages/zebra/
├── zena-package.json           # Zena package manifest
├── package.json                # Monorepo npm/wireit test runner config
├── src/                        # Published Zena library source files
│   ├── main.zena               # CLI entry point
│   ├── runner.zena             # Config -> plan -> engine run -> state & rail report
│   ├── zebra-config.zena       # zena-package.json / zebra.json parsing & --migrate
│   ├── plan-cache.zena         # .zebra/plans/ snapshot serialization & warm loading
│   ├── wireit-config.zena      # package.json wireit parsing & ScriptConfig types
│   ├── builder.zena            # Script configs -> workflow steps & process execution
│   ├── fs-walk.zena            # Glob base-directory walk & (mtime, size) hash memo
│   ├── fs-util.zena            # Workspace path & directory helpers
│   ├── disk-cache.zena         # Content-addressed .zebra/cache and .zebra/blobs
│   ├── state-json.zena         # JSON serialization for .zebra/ state & manifests
│   ├── colors.zena             # Terminal ANSI color & width helpers
│   ├── layout.zena             # Clack-style rail output formatting
│   ├── animation.zena          # Interactive terminal spinner
│   └── shell.zena              # POSIX shell argument quoting helpers
└── test/                       # Zena test suites and fixtures
    ├── *_test.zena             # Unit and end-to-end tests
    └── fixtures/
        └── example/            # Three-package example workspace fixture
```

When publishing to the Zena package manager (`zena pkg publish`), `"files": ["src"]` in `zena-package.json` restricts the published archive to `src/`, `zena-package.json`, `README.md`, and `LICENSE`.

## Running in the Monorepo

Prerequisite: a built checkout (`npm run build`), so `target/release/zena-cli` and the compiler exist. From the repository root:

```sh
./target/release/zena-cli build [-j <jobs>] [-w|--watch] [-f|--force] [--no-cache] [-v|--verbose] [<target>]
./target/release/zena-cli build --migrate [--dry-run] [-f|--force] [<package-dir>]
# or directly via zena-cli run:
./target/release/zena-cli run --dir . --allow-spawn packages/zebra/src/main.zena \
  [-C <workspace-root>] [-j <jobs>] [-w|--watch] [-f|--force] [--no-cache] [-v|--verbose] [<package-dir>] [<script>]
```

### Example Fixture Workspace

`test/fixtures/example/` is a three-package workspace (`greeting`, `site`, and `hello-wasm`). Build it in place from the repository root:

```sh
./target/release/zena-cli run --dir . --allow-spawn packages/zebra/src/main.zena \
  -C packages/zebra/test/fixtures/example build
```

## Testing

From the repository root:

```sh
npm test -w @zena-lang/zebra
```

Or directly with `zena-cli`:

```sh
./target/release/zena-cli test "packages/zebra/test/*_test.zena"
```

The end-to-end tests build temporary workspaces under `/tmp` through the real filesystem and shell.
