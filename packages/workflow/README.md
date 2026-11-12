# workflow

An incremental workflow execution engine for Zena: dependency graphs, content fingerprints, cache keys with early cutoff, fine-grained per-output invalidation, and on-demand service lifecycles.

`workflow` performs no I/O of its own. Hosts supply leaf fingerprints, a digest function, a step cache, and step callbacks; the engine schedules work in dependency order with bounded parallelism and returns the updated state.

## Installation

```sh
zena pkg add zena-lang:workflow
```

## Example

```zena
import { NullCache } from 'zena-lang:workflow/cache';
import { Engine, StepSource, Succeeded } from 'zena-lang:workflow/engine';
import { Fingerprint } from 'zena-lang:workflow/fingerprint';
import { Graph } from 'zena-lang:workflow/graph';
import { OutputEntry, OutputManifest } from 'zena-lang:workflow/manifest';
import { EngineState } from 'zena-lang:workflow/state';
import { LeafInput, StepKey, StepOutputs, TaskStep } from 'zena-lang:workflow/step';

let compile = new TaskStep(
  new StepKey('compile'),
  new Fingerprint('cmd:compile-v1'),
  [new LeafInput('src/main.zena')],
  async (ctx) => {
    return new OutputManifest([
      new OutputEntry('out/main.wasm', new Fingerprint('wasm-hash-1')),
    ]);
  },
);

let bundle = new TaskStep(
  new StepKey('bundle'),
  new Fingerprint('cmd:bundle-v1'),
  [new StepOutputs(new StepKey('compile'))],
  async (ctx) => {
    return new OutputManifest([
      new OutputEntry('dist/app.wasm', new Fingerprint('bundle-hash-1')),
    ]);
  },
);

let graph = new Graph([compile, bundle]);
let leaves = {'src/main.zena' => new Fingerprint('src-hash-1')};
let engine = new Engine((data) => new Fingerprint( sha256(data) ), new NullCache());

// First run executes both steps in topological order.
let first = await engine.run(graph, leaves, EngineState.empty());

// Second run with identical inputs and prior state is a no-op (StepSource.Fresh).
let second = await engine.run(graph, leaves, first.state);
```

## Core Concepts

- **Steps and inputs (`workflow/step`)**:
  - `TaskStep`: runs to completion and returns an `OutputManifest`.
  - `ServiceStep`: starts on demand only when a dependent step actually executes, and stops when its last dependent settles (or stays pinned across watch runs in a `ServicePool`).
  - `LeafInput(name)`: a named external input resolved from the `leaves` map passed to `Engine.run`.
  - `LeafSet(name, resolve)`: a lazy input set resolved after upstream dependencies finish (for example, expanding globs over generated files).
  - `StepOutputs(step)`: a dependency on another step whose output manifest (or service identity) enters this step's cache key. Because dependents key on upstream _output_ fingerprints rather than upstream input fingerprints, an upstream step that reruns and produces identical outputs leaves downstream dependents fresh (early cutoff).
  - `StepOrder(step)`: an ordering-only dependency (like Wireit's `"cascade": false`) that waits for the upstream step without folding its outputs into the dependent's cache key.
- **Validated graph (`workflow/graph`)**: `Graph` checks that step keys are unique, all referenced steps exist, no step lists duplicate inputs, and the dependency graph is acyclic (reporting the cycle path in `WorkflowError`), producing a deterministic topological order.
- **Caching and freshness (`workflow/engine`, `workflow/cache`, `workflow/state`)**:
  - If a step's `CacheKey` matches the `StepRecord` in the previous `EngineState` (and optional `RunOptions.verifyOutputs` succeeds), the step is `StepSource.Fresh` without consulting the cache or starting services.
  - Otherwise `StepCache.get` is checked (`StepSource.Cache`), falling back to executing the step callback (`StepSource.Ran`) under the run's parallelism limit.
- **Incremental per-output deltas (`workflow/delta`, `workflow/manifest`)**:
  - Each `OutputEntry` in an `OutputManifest` can record `dependsOn` (the namespaced inputs `leaf:...`, `step:...` it was derived from).
  - When a step reruns with the same `config` fingerprint, `RunContext` provides `delta` (`changed`, `added`, `removed`), `previous` (`OutputManifest`), and `staleOutputs`. The engine verifies before caching that any output carried over as non-stale kept its previous fingerprint.

## Libraries

- `workflow/engine` — `Engine`, `RunOptions`, `RunResult`, `StepOutcome` (`Succeeded`, `Failed`, `Skipped`), `StepSource`, `ServicePool`, and `PinnedService`.
- `workflow/step` — `Step`, `TaskStep`, `ServiceStep`, `StepKey`, `InputRef` (`LeafInput`, `LeafSet`, `StepOutputs`, `StepOrder`), `RunContext`, `ServiceContext`, and `ServiceHandle`.
- `workflow/graph` — `Graph` validation and deterministic topological sorting.
- `workflow/manifest` — `OutputManifest` and `OutputEntry`.
- `workflow/state` — `EngineState` and `StepRecord` for persisting prior-run state across runs.
- `workflow/cache` — `StepCache` interface and `NullCache`.
- `workflow/fingerprint` — `Fingerprint`, `CacheKey`, and `Digest`.
- `workflow/canonical` — Canonical length-prefixed encodings (`cacheKeyFor`, `manifestFingerprint`, `ResolvedInput`, `compareStrings`, `sortBy`).
- `workflow/delta` — `InputDelta`, `computeDelta`, and `staleOutputNames`.
- `workflow/errors` — `WorkflowError`.

## License

MIT
