# Pre-Retirement Benchmark Baseline

**Captured**: 2026-08-05 (superseding a partial capture of 2026-08-04)
**Commit**: `6299d9ca2768300e203cf5dab5afad5d640fd75f`

## Why this file exists

This is the last point at which Zena has **two independent compiler
implementations** — the TypeScript bootstrap compiler (`packages/compiler`) and
the self-hosted compiler (`packages/zena-compiler`). Once `packages/compiler` is
deleted ([bootstrap-retirement.md](../design/bootstrap-retirement.md)), the
comparison below cannot be reproduced at any commit, ever again.

Everything else in the retirement plan can be redone. This cannot. That is why
capturing it is step 1.

Post-retirement regressions should be measured against these numbers, with the
caveat that they are single-machine and single-run-set — see *Reading these
numbers* below.

## Environment

| | |
| --- | --- |
| Commit | `6299d9ca` (`main`) |
| CPU | AMD Ryzen 9 5950X, 16 cores / 32 threads |
| Memory | 23 GB, no swap |
| OS | Linux 6.18.41 |
| Node.js | v26.3.0 |
| wasmtime | 46.0.0 (423be7a4e, 2026-06-22) |
| wasm-tools | 1.252.0 |
| rustc | 1.95.0 (59807616e, 2026-04-14) |
| Command | `npm run benchmark -w @zena-lang/zena-compiler`, inside `nix develop` |

Run inside the flake dev shell deliberately: outside it the environment supplies
Node v22, and the CLI warns that Zena requires Node 25+. A baseline taken on an
unsupported runtime would not be comparable.

## Reading these numbers

- **Bootstrap (Node)** — the TypeScript compiler on Node.
- **Self-Hosted (Wasmtime)** — the Zena compiler compiled to WASM, run by
  `zena-cli`.
- **Self-Hosted (Node)** — the same WASM, run on Node.
- Ratios are relative to Bootstrap; **lower is better**.
- `self_compile` runs once per configuration; the other targets run 5 times and
  are reported as means.
- `self_compile` uses `ZENA_GC_RESERVE_MB=1536`, matching `build:self-hosted`.
  The smaller targets use `0`, because the balloon's ~1s page-commit cost would
  dominate them.
- These are wall-clock timings on one busy workstation. Treat differences under
  roughly 10% as noise.

## Status of this capture: COMPLETE

| Measurement | Status |
| --- | --- |
| Compile time — all four targets | ✅ |
| Emitted code size, bootstrap vs self-hosted | ✅ |
| Runtime of emitted code, bootstrap vs self-hosted | ✅ |

The 2026-08-04 capture was partial: `stdlib_moderate` and `stdlib_heavy` could
not be compiled by the self-hosted compiler at all, and neither emitted size nor
emitted-code runtime was measured by the suite. All three gaps are closed, and
every figure below is re-measured on `6299d9ca` rather than carried over, so the
document is internally consistent rather than a mix of pre- and post-fix runs.

## Compile time

Bootstrap = TypeScript compiler on Node. Ratios relative to Bootstrap; lower is
better. Means of 5 runs, except `self_compile` which runs once.

| Target | Bootstrap (Node) | Self-Hosted (Wasmtime) | Self-Hosted (Node) | Wt/Boot | Node/Boot |
| --- | --- | --- | --- | --- | --- |
| `minimal.zena` | 301.68 ms | 434.86 ms | 274.25 ms | 1.44× | 0.91× |
| `stdlib_moderate.zena` | 321.14 ms | 527.24 ms | 295.23 ms | 1.64× | 0.92× |
| `stdlib_heavy.zena` | 405.32 ms | 934.89 ms | 403.82 ms | 2.31× | 1.00× |
| `self_compile` | 5122.78 ms | 9449.86 ms | 2981.90 ms | 1.84× | 0.58× |

The self-hosted compiler is slower than the bootstrap under wasmtime and roughly
at parity — or better — on Node, which is the same runtime the bootstrap uses.
The Node column is the like-for-like comparison; the wasmtime column carries
wasmtime's own startup and compilation costs.

## Runtime of emitted code: bootstrap vs self-hosted

Each fixture is compiled by **both** compilers and both artifacts run under
wasmtime, so the only variable is which compiler produced the code. 59
comparisons:

| | |
| --- | --- |
| Median ratio (self-hosted / bootstrap) | **0.91×** |
| Comparisons slower than 1.10× | **4 of 59** |

**Self-hosted codegen is meaningfully faster than the bootstrap's**, with the
wins concentrated where the ZIR work has been:

| Benchmark | Bootstrap | Self-hosted | Ratio |
| --- | --- | --- | --- |
| `DevirtInferCall` | 8.71 ms | 2.62 ms | **0.30×** |
| `DevirtStaticCall` | 6.48 ms | 2.14 ms | **0.33×** |
| `LoopForInImmutableArrayInterface` | 299.61 ms | 141.94 ms | **0.47×** |
| `FieldAssignDevirtFinalField` | 4.25 ms | 2.28 ms | **0.54×** |

The four cases above 1.10×:

| Benchmark | Bootstrap | Self-hosted | Ratio |
| --- | --- | --- | --- |
| `FieldAccessVirtual` | 2.22 ms | 4.39 ms | 1.98× |
| `FieldAccessDevirtFinalField` | 2.43 ms | 4.36 ms | 1.79× |
| `IfSingle` | 9.02 ms | 10.54 ms | 1.17× |
| `FieldAccessRecordAdapt` | 134.69 ms | 149.23 ms | 1.11× |

For context, `FieldAccessVirtual` was **59.53×** in the 2026-08-04 capture, at
126.79 ms. It is now 4.39 ms.

The residual ~2× is worth understanding but is not a stable property of any one
benchmark. Across runs, two of the four field-access benchmarks sit at ~4.2 ms
and two at ~2.1 ms, and *which* two swapped after an unrelated reachability
change — earlier it was `DevirtFinal` and `DevirtEffectivelyFinal`, now it is
`Virtual` and `DevirtFinalField`. Reproduced across two consecutive runs, so it
is not measurement noise. That points at an inlining threshold rather than
anything intrinsic to devirtualization. Tracked in BUGS.md.

## Emitted code size: bootstrap vs self-hosted

Measured **excluding custom sections**. Raw file size is not comparable: the
self-hosted compiler always emits a `name` section while the bootstrap only does
under `-g`, and that section accounted for 55–62% of the apparent gap.

| Target | Bootstrap | Self-hosted | Ratio |
| --- | --- | --- | --- |
| `minimal.zena` | 13,097 B | 22,082 B | 1.69× |
| `stdlib_moderate.zena` | 22,972 B | 36,930 B | 1.61× |
| `stdlib_heavy.zena` | 65,217 B | 94,817 B | 1.45× |
| the compiler itself | 1,959,761 B | 2,721,008 B | **1.39×** |

**Correction to the 2026-08-04 capture.** That version concluded the size gap
was proportional rather than fixed overhead, on the grounds that the ratio held
steady as programs grew. With custom sections excluded and the dead closure
wrappers removed, that no longer holds: the ratio *declines* with program size
(1.69 → 1.61 → 1.45 → 1.39), and the incremental ratio against the `minimal`
baseline converges to the same ~1.39×. So there is a modest fixed component that
dominates small programs, on top of a proportional ~1.39×. The earlier reading
was an artifact of measuring raw bytes, where the name section grew with the
program and masked the trend.

~1.39× is the number to carry forward for anything compiler-sized.

The `types` section remains the disproportionate part and is **still
unexplained**: 605 distinct function types against the bootstrap's 287, and
struct-ish types 207 → 500. Dead closure wrappers were investigated and fixed,
which removed 43 functions and ~455 code bytes but left the type section
byte-identical.

Caveat retained: neither leg passes `--dce`, which BUGS.md records as a ~340×
difference on a trivial program, so absolute sizes are dominated by unreachable
stdlib and only ratios are meaningful.

## Appendix: raw output

Reproduce with `npm run benchmark -w @zena-lang/zena-compiler` inside
`nix develop`.

```
error (ignored): SQLite database '/home/justin/.cache/nix/eval-cache-v6/b3ef30103fb9a67d6ddb3da0206c9b23325ff4ed3b405dc4ef96a57ba5f42663.sqlite' is busy
Zena development environment
Node.js version: v26.3.0
npm version: 11.16.0
wasmtime version: wasmtime 46.0.0 (423be7a4e 2026-06-22)
wasm-tools version: wasm-tools 1.252.0
rustc version: rustc 1.95.0 (59807616e 2026-04-14) (built from a source tarball)

Run 'npm install' to install dependencies
Run 'npm run build' to build the compiler
Run 'npm test' to run tests
==================================================
Starting Zena Compiler Benchmark Suite
Iterations per target: 5
==================================================

Running benchmarks for minimal.zena...

Benchmark Results for minimal.zena:
┌─────────────────────────┬──────────────────────┬────────────────────────┬──────────────────────┬──────────────────┬────────────────────┐
│ Metric                  │     Bootstrap (Node) │ Self-Hosted (Wasmtime) │   Self-Hosted (Node) │  Ratio (Wt/Boot) │  Ratio (Node/Boot) │
├─────────────────────────┼──────────────────────┼────────────────────────┼──────────────────────┼──────────────────┼────────────────────┤
│ Mean Compilation Time   │            301.68 ms │              434.86 ms │            274.25 ms │            1.44x │              0.91x │
│ Emitted Size (no custom) │             13,097 B │               22,082 B │             22,082 B │            1.69x │              1.69x │
└─────────────────────────┴──────────────────────┴────────────────────────┴──────────────────────┴──────────────────┴────────────────────┘

Self-Hosted Internal Phase Breakdown (Mean of 5 Runs):
┌─────────────────────────┬────────────────────────┬────────────────────────┐
│ Phase                   │     Wasmtime Execution │      Node.js Execution │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ File Load               │                7.30 ms │                6.65 ms │
│ Pure Parse              │               20.01 ms │               26.73 ms │
│ Scope                   │               13.69 ms │                8.96 ms │
│ Check                   │               48.29 ms │               39.01 ms │
│ Codegen                 │              110.93 ms │               89.56 ms │
│   Discovery             │               74.95 ms │               49.04 ms │
│     Init                │                2.20 ms │                5.49 ms │
│     Queues              │               18.63 ms │               19.73 ms │
│     Layout              │               52.92 ms │               17.32 ms │
│   Layout                │                0.55 ms │                0.65 ms │
│   Emit Code             │               24.53 ms │               29.75 ms │
│   Emit Other            │                0.97 ms │                1.27 ms │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ Total Phase Time        │              200.22 ms │              170.91 ms │
└─────────────────────────┴────────────────────────┴────────────────────────┘

--------------------------------------------------

Running benchmarks for stdlib_moderate.zena...

Benchmark Results for stdlib_moderate.zena:
┌─────────────────────────┬──────────────────────┬────────────────────────┬──────────────────────┬──────────────────┬────────────────────┐
│ Metric                  │     Bootstrap (Node) │ Self-Hosted (Wasmtime) │   Self-Hosted (Node) │  Ratio (Wt/Boot) │  Ratio (Node/Boot) │
├─────────────────────────┼──────────────────────┼────────────────────────┼──────────────────────┼──────────────────┼────────────────────┤
│ Mean Compilation Time   │            321.14 ms │              527.24 ms │            295.23 ms │            1.64x │              0.92x │
│ Emitted Size (no custom) │             22,972 B │               36,930 B │             36,930 B │            1.61x │              1.61x │
└─────────────────────────┴──────────────────────┴────────────────────────┴──────────────────────┴──────────────────┴────────────────────┘

Self-Hosted Internal Phase Breakdown (Mean of 5 Runs):
┌─────────────────────────┬────────────────────────┬────────────────────────┐
│ Phase                   │     Wasmtime Execution │      Node.js Execution │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ File Load               │                7.64 ms │                6.63 ms │
│ Pure Parse              │               20.65 ms │               29.22 ms │
│ Scope                   │               14.64 ms │                6.84 ms │
│ Check                   │               44.69 ms │               39.88 ms │
│ Codegen                 │              213.95 ms │              115.38 ms │
│   Discovery             │              159.54 ms │               62.99 ms │
│     Init                │                5.37 ms │                5.46 ms │
│     Queues              │              133.54 ms │               40.57 ms │
│     Layout              │               19.49 ms │               10.36 ms │
│   Layout                │                0.70 ms │                0.84 ms │
│   Emit Code             │               45.08 ms │               42.00 ms │
│   Emit Other            │                1.16 ms │                1.43 ms │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ Total Phase Time        │              301.57 ms │              197.95 ms │
└─────────────────────────┴────────────────────────┴────────────────────────┘

--------------------------------------------------

Running benchmarks for stdlib_heavy.zena...

Benchmark Results for stdlib_heavy.zena:
┌─────────────────────────┬──────────────────────┬────────────────────────┬──────────────────────┬──────────────────┬────────────────────┐
│ Metric                  │     Bootstrap (Node) │ Self-Hosted (Wasmtime) │   Self-Hosted (Node) │  Ratio (Wt/Boot) │  Ratio (Node/Boot) │
├─────────────────────────┼──────────────────────┼────────────────────────┼──────────────────────┼──────────────────┼────────────────────┤
│ Mean Compilation Time   │            405.32 ms │              934.89 ms │            403.82 ms │            2.31x │              1.00x │
│ Emitted Size (no custom) │             65,217 B │               94,817 B │             94,817 B │            1.45x │              1.45x │
└─────────────────────────┴──────────────────────┴────────────────────────┴──────────────────────┴──────────────────┴────────────────────┘

Self-Hosted Internal Phase Breakdown (Mean of 5 Runs):
┌─────────────────────────┬────────────────────────┬────────────────────────┐
│ Phase                   │     Wasmtime Execution │      Node.js Execution │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ File Load               │                9.36 ms │                8.20 ms │
│ Pure Parse              │               35.25 ms │               36.74 ms │
│ Scope                   │               19.31 ms │               12.14 ms │
│ Check                   │               99.84 ms │               57.26 ms │
│ Codegen                 │              545.76 ms │              187.74 ms │
│   Discovery             │              431.22 ms │               94.40 ms │
│     Init                │                2.35 ms │                5.76 ms │
│     Queues              │              389.07 ms │               67.53 ms │
│     Layout              │               38.61 ms │               14.41 ms │
│   Layout                │                1.49 ms │                2.63 ms │
│   Emit Code             │               94.80 ms │               76.49 ms │
│   Emit Other            │                2.00 ms │                2.40 ms │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ Total Phase Time        │              709.51 ms │              302.09 ms │
└─────────────────────────┴────────────────────────┴────────────────────────┘

--------------------------------------------------

Running benchmarks for self_compile.zena...

Benchmark Results for self_compile.zena:
┌─────────────────────────┬──────────────────────┬────────────────────────┬──────────────────────┬──────────────────┬────────────────────┐
│ Metric                  │     Bootstrap (Node) │ Self-Hosted (Wasmtime) │   Self-Hosted (Node) │  Ratio (Wt/Boot) │  Ratio (Node/Boot) │
├─────────────────────────┼──────────────────────┼────────────────────────┼──────────────────────┼──────────────────┼────────────────────┤
│ Mean Compilation Time   │           5122.78 ms │             9449.86 ms │           2981.90 ms │            1.84x │              0.58x │
│ Emitted Size (no custom) │          1,959,761 B │            2,721,008 B │          2,721,008 B │            1.39x │              1.39x │
└─────────────────────────┴──────────────────────┴────────────────────────┴──────────────────────┴──────────────────┴────────────────────┘

Self-Hosted Internal Phase Breakdown (Mean of 5 Runs):
┌─────────────────────────┬────────────────────────┬────────────────────────┐
│ Phase                   │     Wasmtime Execution │      Node.js Execution │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ File Load               │               45.54 ms │               28.93 ms │
│ Pure Parse              │              265.08 ms │              157.86 ms │
│ Scope                   │              159.48 ms │               86.14 ms │
│ Check                   │              567.25 ms │              292.42 ms │
│ Codegen                 │             6916.75 ms │             2289.82 ms │
│   Discovery             │             3959.75 ms │             1291.28 ms │
│     Init                │                5.70 ms │                7.99 ms │
│     Queues              │             3578.17 ms │             1155.01 ms │
│     Layout              │              374.79 ms │              122.67 ms │
│   Layout                │              126.72 ms │               48.42 ms │
│   Emit Code             │             2679.56 ms │              858.73 ms │
│   Emit Other            │               41.27 ms │               21.29 ms │
├─────────────────────────┼────────────────────────┼────────────────────────┤
│ Total Phase Time        │             7954.11 ms │             2855.17 ms │
└─────────────────────────┴────────────────────────┴────────────────────────┘

--------------------------------------------------

==================================================
Running String Micro-Benchmark Suite (Execution)
==================================================

Compiling string_bench.zena...
Compilation successful.

Running Zena (wasmtime via zena-cli) benchmark...
Running Zena (Node.js WASI) benchmark...
Running Node.js (V8 JS) benchmark...

String Micro-Benchmark Comparison:
┌──────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                │   Zena (Wasmtime) │    Zena (Node.js) │     Node.js (JS) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├──────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ StringConcatPlus (N=10,000)              │           7.59 ms │          29.69 ms │          0.58 ms │          13.09x │          51.19x │
│ StringConcatBuilder (N=10,000)           │           0.07 ms │           0.21 ms │          0.50 ms │           0.14x │           0.42x │
│ StringConcatBuilder (N=100,000)          │           0.97 ms │           0.58 ms │          3.39 ms │           0.29x │           0.17x │
│ StringConcatBuilderByte (N=100,000)      │           0.22 ms │           0.36 ms │          1.18 ms │           0.19x │           0.31x │
│ StringDirectByteArray (N=100,000)        │           0.08 ms │           0.16 ms │          0.55 ms │           0.15x │           0.29x │
│ StringSlicing (N=100,000)                │           0.77 ms │           0.79 ms │          2.61 ms │           0.30x │           0.30x │
│ StringComparison (N=100,000)             │           7.55 ms │           1.93 ms │          0.34 ms │          22.21x │           5.68x │
│ StringCompareIdentical (N=100,000)       │           0.27 ms │           0.30 ms │          0.24 ms │           1.13x │           1.25x │
│ StringCompareNonIdentical (N=100,000)    │           5.24 ms │           1.56 ms │          0.25 ms │          20.96x │           6.24x │
│ StringTemplateLiteral (N=10,000)         │           0.84 ms │           0.44 ms │          0.76 ms │           1.11x │           0.58x │
│ StringSearch (N=10,000)                  │           0.52 ms │           0.48 ms │          0.58 ms │           0.90x │           0.83x │
│ StringMapIndexing (N=10,000)             │           0.34 ms │           0.78 ms │          0.83 ms │           0.41x │           0.94x │
│ CompareConcatPlus (N=100,000)            │           8.23 ms │           7.78 ms │          0.27 ms │          30.48x │          28.81x │
│ CompareTemplateLiteral (N=100,000)       │           7.03 ms │           5.46 ms │          1.27 ms │           5.54x │           4.30x │
│ CompareStringBuilderNew (N=100,000)      │          11.98 ms │           9.23 ms │          9.60 ms │           1.25x │           0.96x │
│ CompareStringBuilderFromString (N=100,000) │          10.33 ms │           8.38 ms │          9.69 ms │           1.07x │           0.86x │
│ CompareStringFromParts (N=100,000)       │           5.71 ms │           4.78 ms │          8.41 ms │           0.68x │           0.57x │
└──────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Concatenation Techniques Comparison (N=100,000):
┌──────────────────────────┬───────────────────┬───────────────────┬──────────────────┬──────────────────────┐
│ Technique                │   Zena (Wasmtime) │    Zena (Node.js) │     Node.js (JS) │    Speedup vs + (Wt) │
├──────────────────────────┼───────────────────┼───────────────────┼──────────────────┼──────────────────────┤
│ Operator +               │           8.23 ms │           7.78 ms │          0.27 ms │                1.00x │
│ Template Literal         │           7.03 ms │           5.46 ms │          1.27 ms │                1.17x │
│ StringBuilder (New)      │          11.98 ms │           9.23 ms │          9.60 ms │                0.69x │
│ StringBuilder (from)     │          10.33 ms │           8.38 ms │          9.69 ms │                0.80x │
│ String.fromParts         │           5.71 ms │           4.78 ms │          8.41 ms │                1.44x │
└──────────────────────────┴───────────────────┴───────────────────┴──────────────────┴──────────────────────┘

--------------------------------------------------

==================================================
Running Basic Micro-Benchmark Suite (Execution)
==================================================

Compiling basic_bench.zena...
Compilation successful.

Running Zena (wasmtime via zena-cli) benchmark...
Running Zena (Node.js WASI) benchmark...
Running Node.js (V8 JS) benchmark...

Category: Control Flow & Recursion
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Fibonacci Recursive (N=35)                 │          53.01 ms │          23.73 ms │         69.17 ms │           0.77x │           0.34x │
│ Fibonacci Recursive (N=40)                 │         626.45 ms │         272.57 ms │        780.02 ms │           0.80x │           0.35x │
│ Fibonacci Iterative (N=10M)                │          26.11 ms │          23.38 ms │         23.37 ms │           1.12x │           1.00x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Direct & Indirect Function Calls (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Direct Call (simple/inlinable)             │           3.04 ms │           2.16 ms │          3.46 ms │           0.88x │           0.62x │
│ Direct Call (non-inlinable)                │           6.48 ms │          15.19 ms │         11.81 ms │           0.55x │           1.29x │
│ Indirect Closure Call                      │         141.24 ms │           2.38 ms │          3.48 ms │          40.59x │           0.68x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Looping & Iteration (N=10,000,000 elements)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ C-style index for-loop                     │           8.94 ms │           3.64 ms │          3.56 ms │           2.51x │           1.02x │
│ while-loop / array                         │           8.76 ms │           3.61 ms │          3.62 ms │           2.42x │           1.00x │
│ for-in / array                             │           8.75 ms │           3.73 ms │          3.81 ms │           2.30x │           0.98x │
│ for-in / array (interface)                 │         305.50 ms │          26.42 ms │          3.83 ms │          79.77x │           6.90x │
│ for-in / growable array                    │           9.82 ms │           2.98 ms │          4.56 ms │           2.15x │           0.65x │
│ for-in / growable array (interface)        │         317.10 ms │          27.04 ms │          3.88 ms │          81.73x │           6.97x │
│ for-in / immutable array                   │           9.02 ms │           3.64 ms │          3.84 ms │           2.35x │           0.95x │
│ for-in / immutable array (interface)       │         284.09 ms │          26.72 ms │          3.84 ms │          73.98x │           6.96x │
│ for-in / custom collection                 │         281.66 ms │          26.81 ms │         49.09 ms │           5.74x │           0.55x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Type Casting (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Direct Field Access                        │          11.46 ms │           2.17 ms │          3.53 ms │           3.25x │           0.61x │
│ Cast Field Access (as String)              │          17.31 ms │           2.17 ms │          3.50 ms │           4.95x │           0.62x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Field Access (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Virtual Dispatch                           │           2.23 ms │           2.16 ms │          3.53 ms │           0.63x │           0.61x │
│ Devirtualized (Final Class)                │           2.19 ms │           2.17 ms │          3.46 ms │           0.63x │           0.63x │
│ Devirtualized (Final Field)                │           2.20 ms │           2.16 ms │          3.47 ms │           0.63x │           0.62x │
│ Devirtualized (Effectively Final)          │           2.18 ms │           2.16 ms │          3.46 ms │           0.63x │           0.62x │
│ Record (No Adaptation)                     │         132.49 ms │           2.38 ms │          3.46 ms │          38.29x │           0.69x │
│ Record (Adaptation)                        │         133.09 ms │           2.40 ms │          3.47 ms │          38.35x │           0.69x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Field Assignment (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Virtual Dispatch                           │           4.34 ms │           2.18 ms │          2.68 ms │           1.62x │           0.81x │
│ Devirtualized (Final Class)                │           4.30 ms │           2.18 ms │          2.68 ms │           1.60x │           0.81x │
│ Devirtualized (Final Field)                │           4.30 ms │           2.17 ms │          2.68 ms │           1.60x │           0.81x │
│ Devirtualized (Effectively Final)          │           4.29 ms │           2.18 ms │          2.72 ms │           1.58x │           0.80x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Method Devirtualization (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Dynamic (non-devirtualizable)              │         125.38 ms │           3.40 ms │          3.47 ms │          36.13x │           0.98x │
│ Dynamic (devirtualizable)                  │           8.81 ms │           2.17 ms │          3.48 ms │           2.53x │           0.62x │
│ Override Dynamic (non-devirt)              │         188.92 ms │           4.82 ms │          3.71 ms │          50.92x │           1.30x │
│ Override Dynamic (devirtualized)           │          13.12 ms │           2.22 ms │          3.47 ms │           3.78x │           0.64x │
│ Static (devirtualized)                     │           6.62 ms │           2.16 ms │          3.64 ms │           1.82x │           0.59x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Pattern Matching vs is/else (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ match (single case)                        │          10.81 ms │           3.26 ms │         21.40 ms │           0.51x │           0.15x │
│ is check with if/else                      │           8.68 ms │           3.30 ms │         20.91 ms │           0.42x │           0.16x │
│ match (3 cases)                            │          28.88 ms │           9.70 ms │         21.29 ms │           1.36x │           0.46x │
│ is checks with if/else (3 cases)           │          26.86 ms │           9.42 ms │         20.17 ms │           1.33x │           0.47x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

--------------------------------------------------

==================================================
Running Map Micro-Benchmark Suite (Execution)
==================================================

Compiling map_bench.zena...
Compilation successful.

Running Zena (wasmtime via zena-cli) benchmark...
Running Zena (Node.js WASI) benchmark...
Running Node.js (V8 JS) benchmark...

Map Micro-Benchmark Comparison:
┌──────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                │   Zena (Wasmtime) │    Zena (Node.js) │     Node.js (JS) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├──────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ HashMapInsertString (N=50,000)           │          14.99 ms │          15.87 ms │         10.17 ms │           1.47x │           1.56x │
│ HashMapLookupString (N=100,000)          │           3.86 ms │           2.81 ms │          2.70 ms │           1.43x │           1.04x │
│ HashMapInsertInt (N=50,000)              │           2.86 ms │           2.12 ms │          2.90 ms │           0.99x │           0.73x │
│ HashMapLookupInt (N=100,000)             │           1.14 ms │           1.13 ms │          1.27 ms │           0.90x │           0.89x │
│ OrderedMapInsertString (N=50,000)        │          10.58 ms │           4.72 ms │          8.10 ms │           1.31x │           0.58x │
│ OrderedMapLookupString (N=100,000)       │           3.96 ms │           7.62 ms │          2.99 ms │           1.32x │           2.55x │
└──────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

--------------------------------------------------

==================================================
Running Map Key Micro-Benchmark Suite (Execution)
==================================================

Compiling map_key_bench.zena...
Compilation successful.

Running Zena (wasmtime via zena-cli) benchmark...
Running Zena (Node.js WASI) benchmark...
Running Node.js (V8 JS) benchmark...

Map Key Micro-Benchmark Comparison:

Category: 2-Part Compound Keys (N=100,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ String key (concat)                        │          41.11 ms │          33.70 ms │         22.14 ms │           1.86x │           1.52x │
│ CustomKey class                            │           8.72 ms │          10.05 ms │         15.68 ms │           0.56x │           0.64x │
│ CaseKey class                              │           8.11 ms │          10.73 ms │         14.15 ms │           0.57x │           0.76x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: 3-Part Compound Keys (N=80,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ String key (concat)                        │          38.40 ms │          26.88 ms │         15.87 ms │           2.42x │           1.69x │
│ CustomKey class                            │           7.96 ms │           8.85 ms │         13.43 ms │           0.59x │           0.66x │
│ CaseKey class                              │           7.06 ms │           8.88 ms │         13.39 ms │           0.53x │           0.66x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

--------------------------------------------------

==================================================
Codegen Comparison: string
==================================================

  emitted size (excluding custom sections): bootstrap 39,923 B, self-hosted 61,329 B (1.54x)
  raw file size: 39,923 B vs 87,388 B (2.19x) — the gap is mostly the name section, which only one side emits

┌──────────────────────────────────────────────┬──────────────────────┬──────────────────────┬──────────────┐
│ Test Case                                    │    Bootstrap-emitted │  Self-hosted-emitted │        Ratio │
├──────────────────────────────────────────────┼──────────────────────┼──────────────────────┼──────────────┤
│ StringConcatPlus (N=10,000)                  │              6.08 ms │              6.70 ms │        1.10x │
│ StringConcatBuilder (N=10,000)               │              0.07 ms │              0.07 ms │        1.00x │
│ StringConcatBuilder (N=100,000)              │              1.07 ms │              0.81 ms │        0.76x │
│ StringConcatBuilderByte (N=100,000)          │              0.23 ms │              0.18 ms │        0.78x │
│ StringDirectByteArray (N=100,000)            │              0.09 ms │              0.09 ms │        1.00x │
│ StringSlicing (N=100,000)                    │              0.75 ms │              0.68 ms │        0.91x │
│ StringComparison (N=100,000)                 │              6.26 ms │              5.51 ms │        0.88x │
│ StringCompareIdentical (N=100,000)           │              0.28 ms │              0.17 ms │        0.61x │
│ StringCompareNonIdentical (N=100,000)        │              5.03 ms │              4.55 ms │        0.90x │
│ StringTemplateLiteral (N=10,000)             │              0.69 ms │              0.75 ms │        1.09x │
│ StringSearch (N=10,000)                      │              0.52 ms │              0.51 ms │        0.98x │
│ StringMapIndexing (N=10,000)                 │              0.36 ms │              0.28 ms │        0.78x │
│ CompareConcatPlus (N=100,000)                │              8.35 ms │              8.10 ms │        0.97x │
│ CompareTemplateLiteral (N=100,000)           │              7.14 ms │              7.28 ms │        1.02x │
│ CompareStringBuilderNew (N=100,000)          │             13.57 ms │             10.12 ms │        0.75x │
│ CompareStringBuilderFromString (N=100,000)   │             10.68 ms │              9.33 ms │        0.87x │
│ CompareStringFromParts (N=100,000)           │              5.52 ms │              5.73 ms │        1.04x │
└──────────────────────────────────────────────┴──────────────────────┴──────────────────────┴──────────────┘

  worst regression: StringConcatPlus (N=10,000) at 1.10x

==================================================
Codegen Comparison: basic
==================================================

  emitted size (excluding custom sections): bootstrap 47,234 B, self-hosted 64,228 B (1.36x)
  raw file size: 47,234 B vs 87,917 B (1.86x) — the gap is mostly the name section, which only one side emits

┌──────────────────────────────────────────────┬──────────────────────┬──────────────────────┬──────────────┐
│ Test Case                                    │    Bootstrap-emitted │  Self-hosted-emitted │        Ratio │
├──────────────────────────────────────────────┼──────────────────────┼──────────────────────┼──────────────┤
│ FibonacciRecursive35                         │             54.18 ms │             54.22 ms │        1.00x │
│ FibonacciRecursive40                         │            595.63 ms │            584.30 ms │        0.98x │
│ FibonacciIterative (N=10,000,000)            │             26.75 ms │             25.34 ms │        0.95x │
│ FunctionCallSimple (N=10,000,000)            │              2.32 ms │              2.11 ms │        0.91x │
│ FunctionCallNoInline (N=10,000,000)          │              6.62 ms │              4.25 ms │        0.64x │
│ FunctionCallClosure (N=10,000,000)           │            133.68 ms │            136.09 ms │        1.02x │
│ LoopForLoop (N=10,000,000)                   │              9.45 ms │              8.67 ms │        0.92x │
│ LoopWhileArray (N=10,000,000)                │              8.98 ms │              8.82 ms │        0.98x │
│ LoopForInArray (N=10,000,000)                │              8.78 ms │              8.70 ms │        0.99x │
│ LoopForInArrayInterface (N=10,000,000)       │            303.69 ms │            149.81 ms │        0.49x │
│ LoopForInGrowableArray (N=10,000,000)        │              9.95 ms │             10.87 ms │        1.09x │
│ LoopForInGrowableArrayInterface (N=10,000,000) │            300.28 ms │            145.36 ms │        0.48x │
│ LoopForInImmutableArray (N=10,000,000)       │              8.69 ms │              8.85 ms │        1.02x │
│ LoopForInImmutableArrayInterface (N=10,000,000) │            319.71 ms │            150.51 ms │        0.47x │
│ LoopForInCustom (N=10,000,000)               │            277.88 ms │            151.19 ms │        0.54x │
│ CastDirectAccess (N=10,000,000)              │             10.87 ms │              7.51 ms │        0.69x │
│ CastWithCastAccess (N=10,000,000)            │             17.32 ms │             14.61 ms │        0.84x │
│ DevirtNoInferCall (N=10,000,000)             │            129.36 ms │            125.73 ms │        0.97x │
│ DevirtInferCall (N=10,000,000)               │              8.60 ms │              2.62 ms │        0.30x │
│ DevirtNoInferOverrideCall (N=10,000,000)     │            191.13 ms │            122.96 ms │        0.64x │
│ DevirtInferOverrideCall (N=10,000,000)       │             12.92 ms │              8.89 ms │        0.69x │
│ DevirtStaticCall (N=10,000,000)              │              6.58 ms │              2.19 ms │        0.33x │
│ FieldAccessVirtual (N=10,000,000)            │              2.22 ms │              4.39 ms │        1.98x │
│ FieldAccessDevirtFinal (N=10,000,000)        │              2.20 ms │              2.27 ms │        1.03x │
│ FieldAccessDevirtFinalField (N=10,000,000)   │              2.43 ms │              4.36 ms │        1.79x │
│ FieldAccessDevirtEffectivelyFinal (N=10,000,000) │              2.13 ms │              2.23 ms │        1.05x │
│ FieldAccessRecordNoAdapt (N=10,000,000)      │            132.48 ms │            139.91 ms │        1.06x │
│ FieldAccessRecordAdapt (N=10,000,000)        │            134.69 ms │            149.23 ms │        1.11x │
│ FieldAssignVirtual (N=10,000,000)            │              4.92 ms │              2.74 ms │        0.56x │
│ FieldAssignDevirtFinal (N=10,000,000)        │              5.16 ms │              4.69 ms │        0.91x │
│ FieldAssignDevirtFinalField (N=10,000,000)   │              4.25 ms │              2.28 ms │        0.54x │
│ FieldAssignDevirtEffectivelyFinal (N=10,000,000) │              4.22 ms │              4.53 ms │        1.07x │
│ MatchSingle (N=10,000,000)                   │             10.74 ms │              9.00 ms │        0.84x │
│ IfSingle (N=10,000,000)                      │              8.60 ms │             10.05 ms │        1.17x │
│ Match3Case (N=10,000,000)                    │             30.43 ms │             26.94 ms │        0.89x │
│ If3Case (N=10,000,000)                       │             29.16 ms │             18.45 ms │        0.63x │
└──────────────────────────────────────────────┴──────────────────────┴──────────────────────┴──────────────┘

  worst regression: FieldAccessVirtual (N=10,000,000) at 1.98x

==================================================
Codegen Comparison: map-key
==================================================

  emitted size (excluding custom sections): bootstrap 56,530 B, self-hosted 85,419 B (1.51x)
  raw file size: 56,530 B vs 131,786 B (2.33x) — the gap is mostly the name section, which only one side emits

┌──────────────────────────────────────────────┬──────────────────────┬──────────────────────┬──────────────┐
│ Test Case                                    │    Bootstrap-emitted │  Self-hosted-emitted │        Ratio │
├──────────────────────────────────────────────┼──────────────────────┼──────────────────────┼──────────────┤
│ MapStringKey2 (N=100,000)                    │             41.97 ms │             41.03 ms │        0.98x │
│ MapCustomKey2 (N=100,000)                    │              8.90 ms │              6.59 ms │        0.74x │
│ MapCaseKey2 (N=100,000)                      │              8.63 ms │              6.72 ms │        0.78x │
│ MapStringKey3 (N=80,000)                     │             39.66 ms │             36.80 ms │        0.93x │
│ MapCustomKey3 (N=80,000)                     │              8.02 ms │              5.30 ms │        0.66x │
│ MapCaseKey3 (N=80,000)                       │              7.36 ms │              6.02 ms │        0.82x │
└──────────────────────────────────────────────┴──────────────────────┴──────────────────────┴──────────────┘

  worst regression: MapStringKey2 (N=100,000) at 0.98x

```
