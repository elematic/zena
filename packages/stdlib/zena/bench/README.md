# `zena:bench`

Statistically rigorous benchmarking for Zena, modeled on Google's
[Tachometer](https://github.com/google/tachometer). Two pieces share one
statistics implementation:

- **`zena:bench`** (this library) — an in-process runner: closures
  registered on a `BenchRunner`, timed with the WASI monotonic clock.
- **`zena-cli bench`** — cross-binary comparison (Zena vs a pinned
  `.wat` milestone vs Node). The orchestration is itself a Zena program
  (`packages/zena-cli/zena/bench-run.zena`) that spawns one process per
  sample via `zena:process` and analyzes with this library; the host
  contributes the spawn capability and a hidden `sample` worker that
  times one fresh-instance call of a wasm/wat/zena module.

The full rationale and architecture live in
[docs/design/benchmarking.md](../../../../docs/design/benchmarking.md).

## Methodology

- **Round-robin sampling.** Variants are sampled in rotation, one sample
  each per round, so CPU-load drift and thermal throttling bias every
  variant equally instead of penalizing whichever ran last.
- **Distributions, not point estimates.** Each variant is summarized
  with a 95% t-confidence interval of the mean.
- **Conclusions from difference CIs.** Variants are compared with the CI
  of the *difference* of means (Welch's construction). Only when that
  interval excludes zero does the report say "A is faster than B";
  otherwise it honestly says "unsure".
- **Auto-sampling against horizons.** After `minSamples`, the runner
  keeps sampling in rounds until every pairwise difference CI straddles
  no horizon boundary or the time budget runs out. With a `'1%'`
  horizon, a CI entirely inside ±1% is also a conclusion: "differs by
  less than 1%".
- **Machine context** (CPU model/cores, RAM, load averages, hostname) is
  recorded with every run, best-effort from `/proc`; null when preopens
  exclude it.

## In-process runner

```zena
import { BenchRunner, BenchContext, reportToString, reportToJson } from 'zena:bench';
import { console } from 'zena:console';

export let main = (): i32 => {
  let runner = new BenchRunner('string concat');
  runner.bench('plus', (ctx: BenchContext) => { /* … */ });
  runner.bench('builder', (ctx: BenchContext) => {
    /* setup excluded from timing */
    ctx.start();
    /* measured region */
    ctx.stop();
  });
  let report = runner.run();
  console.log(reportToString(report));
  console.log(reportToJson(report));  // versioned schema, for recording
  return 0;
};
```

By default a sample is one whole invocation; `ctx.start()`/`ctx.stop()`
restrict measurement to a region. Like `zena:fs`, the library is
WASI-only.

### Options (`runner.options`)

| Option         | Default   | Meaning                                                  |
| -------------- | --------- | -------------------------------------------------------- |
| `minSamples`   | `50`      | Samples per variant before the first resolution check    |
| `extraSamples` | `10`      | Additional samples per variant per auto-sample round     |
| `warmupRuns`   | `5`       | Untimed invocations per variant before sampling          |
| `timeBudgetMs` | `60000.0` | Stop auto-sampling after this long (at a round boundary) |
| `horizons`     | `['0%']`  | Resolution horizons: `'N%'` relative or `'Nms'` absolute |

## Cross-binary comparison: `zena-cli bench`

```sh
zena-cli bench benchmarks/fib.json   # prints report, writes fib.results.json
```

The config names a suite, options (same meanings as above), and
variants:

```json
{
  "suite": "fib",
  "options": {"minSamples": 50, "timeBudgetMs": 120000, "horizons": ["0%"]},
  "variants": [
    {"name": "zena", "zena": "fib.zena"},
    {"name": "milestone-wat", "wat": "milestones/fib.wat"},
    {"name": "node", "command": ["node", "fib-node.js"]}
  ]
}
```

Paths are relative to the config file's directory. Sample semantics
differ by variant kind:

- **`zena` / `wasm` / `wat`** — each sample is one run of the hidden
  `zena-cli sample` worker: a fresh instance plus one timed call of the
  exported function (default `main`, override with `"invoke"`), with
  the milliseconds self-reported by the worker — so worker startup,
  module compilation (cached), and instantiation are all excluded from
  the measurement.
- **`command`** — each sample is one process run, but the measurement is
  the guest's **self-reported** milliseconds: the last non-empty stdout
  line that parses as a float (ANSI escapes stripped). This excludes
  interpreter startup, like Tachometer's self-reported metrics; the
  workload should loop enough iterations internally to be stable. If
  nothing parses, wall time is used and the report says so.

Reports print to stdout and are written as `<config>.results.json`
(`schemaVersion: 1`), raw samples included so future tooling can
re-analyze without re-running. `benchmarks/` at the repo root holds the
milestone workload suite.

## Files

| File         | Role                                                             |
| ------------ | ---------------------------------------------------------------- |
| `index.zena` | Public entry: runner, reports, `analyze()` for external samples  |
| `stats.zena` | Private: t-table, `summarize`, Welch difference CIs, horizons — re-exported from the entry point |

Statistics are deliberately small: a Student-t table at 95% (the only
supported confidence level) with 1/df interpolation, not a full inverse
CDF. Unit tests against standard tables live in
`packages/stdlib/tests/bench/`.
