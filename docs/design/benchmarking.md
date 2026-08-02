# Benchmarking: `zena:bench`

Status: v1 landed (in-process runner). Cross-binary orchestration and
result history are follow-ups, sketched at the bottom.

## Why

Our benchmark story (`packages/zena-compiler/src/scripts/benchmark.ts`)
reports raw means to stdout and keeps no history. That is not enough to
answer the two questions that matter as we remove the bootstrap compiler
and the streaming backend:

1. **Is this in-flight change faster or slower — really?** Raw means on a
   shared, loaded machine routinely differ by more than real effects do.
2. **Are we faster than last month?** Machines change, VMs move; a number
   with no distribution, no machine context, and no fixed reference point
   cannot be compared across time.

`zena:bench` copies the architecture of Google's
[Tachometer](https://github.com/google/tachometer), CLI-only:

- **Round-robin sampling.** Variants are sampled in rotation, one sample
  each per round, so drifting CPU load, thermal throttling, and noisy
  neighbors bias all variants equally rather than penalizing whichever
  ran last.
- **Distributions, not point estimates.** Each variant's samples are
  summarized with a 95% t-confidence interval of the mean.
- **Conclusions from difference CIs.** Variants are compared with the
  confidence interval of the _difference_ of means (Welch's construction,
  fractional degrees of freedom). If the interval excludes zero, "A is
  faster than B" is a robust conclusion; if it straddles zero, the report
  says "unsure" instead of manufacturing a winner.
- **Auto-sampling against horizons.** After a minimum sample count, the
  runner keeps sampling until every pairwise difference CI straddles no
  horizon boundary (default horizon: 0%) or a time budget runs out. A CI
  entirely inside ±1% is also a conclusion — "differs by less than 1%" —
  if a 1% horizon is configured.
- **Machine context recorded with every run:** CPU model and core count,
  total/available RAM, 1/5/15-minute load averages, hostname — read from
  `/proc` and `/etc/hostname` when preopens allow, null otherwise. On a
  VM these are weak signals (steal time is invisible), but on raw
  hardware they explain wide CIs after the fact, and load averages are
  useful everywhere.

## What v1 is

`zena:bench` (stdlib; a directory-based library — statistics live in the
private `bench/stats.zena` module and are re-exported from the entry
point) measures **in-process variants**: closures
registered on a `BenchRunner`, timed with the WASI monotonic clock
(nanosecond resolution). Like `zena:fs`, the module is WASI-only.

```zena
import { BenchRunner, BenchContext, reportToString, reportToJson } from 'zena:bench';
import { console } from 'zena:console';

export let main = (): i32 => {
  let runner = new BenchRunner('string concat');
  runner.options.minSamples = 50;        // default
  runner.options.horizons = ['0%'];      // default; also e.g. ['1%', '0.5ms']
  runner.bench('plus', (ctx: BenchContext) => { /* … */ });
  runner.bench('builder', (ctx: BenchContext) => {
    /* setup excluded from timing */
    ctx.start();
    /* measured region */
    ctx.stop();
  });
  let report = runner.run();
  console.log(reportToString(report));
  console.log(reportToJson(report));     // versioned schema, for recording
  return 0;
};
```

By default a sample is one whole invocation; `ctx.start()`/`ctx.stop()`
restrict measurement to a region. `run()` warms up untimed, discards
warmup state, samples round-robin, then auto-extends in rounds of
`extraSamples` until resolved or `timeBudgetMs` is exhausted — so every
variant always has the same sample count.

Statistics are deliberately small: a Student-t table at 95% (the only
supported confidence level) with 1/df interpolation, not a full inverse
CDF. `formatFixed`, `summarize`, `differenceOfMeans`, `parseHorizons`,
and `isResolved` are exported for reuse and are unit-tested against
standard tables in `packages/stdlib/tests/bench/`.

The JSON schema (`schemaVersion: 1`) records suite name, wall-clock
timestamp, options, machine info, and per-variant samples + summary +
pairwise difference CIs. Samples are included on purpose: future tooling
can re-analyze (different horizons, outlier filters) without re-running.

## What v1 is not (follow-ups)

- **Cross-binary comparison.** The headline use case — the same workload
  compiled by two compiler versions, or by the working tree vs `main` —
  needs a host-side orchestrator, because WASI cannot spawn processes.
  Plan: a `zena-cli bench` subcommand (Rust) that takes N variant wasm
  binaries, instantiates each freshly per sample in round-robin order,
  and either measures the invoke wall time or lets the guest self-report
  via a `zena:bench` single-sample mode; the stats/report/JSON layer is
  the same `zena:bench` code, run as an analyzer program over the
  collected samples.
- **Fixed milestones.** Hand-written `.wat` reference implementations of
  a few workloads, checked in and never regenerated, so runs on
  different machines and years can both be expressed relative to the
  same milestone. This is the durable answer to "machines change".
- **Result history.** A `bench-results/` store of `reportToJson` outputs
  keyed by commit + machine, and a comparison tool that diffs a run
  against a stored baseline using the same difference-CI machinery.
  Dedicated benchmark runner hardware strengthens this but is not
  required by the format — that's the point of recording machine info
  and relative-to-milestone numbers.
- **Repointing the existing suites.** `benchmark.ts`'s execution suites
  still compile workloads with the bootstrap compiler; they must move to
  `zena-cli` + `zena:bench` before the bootstrap compiler can be
  removed.

## Notes

- `zena-cli` now honors `ZENA_REPO_ROOT` (falling back to the baked-in
  build checkout), so one built binary can serve git worktrees and
  secondary clones — needed by any workflow that benchmarks the working
  tree against another checkout.
- VMs make absolute numbers untrustworthy (invisible steal time); the
  round-robin + difference-CI design is exactly what keeps _relative_
  conclusions valid there. Absolute tracking belongs on raw hardware.
