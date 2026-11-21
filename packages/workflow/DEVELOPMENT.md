# Developing `workflow`

This document covers the internal layout and test suites for `packages/workflow`.

## Directory Layout

```text
packages/workflow/
├── zena-package.json       # Zena package manifest
├── package.json            # Monorepo npm/wireit test runner config
├── src/                    # Published Zena library source files
│   ├── cache.zena          # StepCache interface and NullCache
│   ├── canonical.zena      # Canonical cache-key and manifest encodings
│   ├── concurrency.zena    # Tree-structured ConcurrencyGroups and FairSemaphore
│   ├── delta.zena          # InputDelta and per-output invalidation
│   ├── engine.zena         # Engine, RunOptions, RunResult, ServicePool
│   ├── errors.zena         # WorkflowError
│   ├── fingerprint.zena    # Fingerprint, CacheKey, Digest
│   ├── graph.zena          # Validated DAG and topological sort
│   ├── manifest.zena       # OutputManifest and OutputEntry
│   ├── state.zena          # EngineState and StepRecord
│   └── step.zena           # Step, TaskStep, ServiceStep, InputRef
└── test/                   # Zena test suites
    ├── canonical_test.zena
    ├── concurrency_test.zena
    ├── delta_test.zena
    ├── engine_test.zena
    ├── graph_test.zena
    └── service_test.zena
```

When publishing to the Zena package manager (`zena pkg publish`), `"files": ["src"]` in `zena-package.json` restricts the published archive to `src/`, `zena-package.json`, `README.md`, and `LICENSE`.

## Testing

From the repository root:

```sh
npm test -w @zena-lang/workflow
```

Or directly with `zena`:

```sh
./target/release/zena test "packages/workflow/test/*_test.zena"
```
