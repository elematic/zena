# Pre-Retirement Benchmark Baseline

**Captured**: 2026-08-04
**Commit**: `b0e7ecd3546aa377bf24114103b01f5eb8a9e7e2`

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
| Commit | `b0e7ecd3` (`main`, matching both `origin` and `github`) |
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

## Status of this capture: PARTIAL

Two of the four compile-time targets could not be captured, because the
self-hosted compiler cannot currently compile them (see *Blocked* below). The
runtime figures were captured in full.

| Measurement | Status |
| --- | --- |
| Emitted code size, bootstrap vs self-hosted | ✅ captured (and now in the suite) |
| Compile time — `minimal.zena` | ✅ captured |
| Compile time — `self_compile` | ✅ captured |
| Compile time — `stdlib_moderate.zena` | ⚠️ unblocked, needs a re-run |
| Compile time — `stdlib_heavy.zena` | ⚠️ unblocked, needs a re-run |
| Runtime — string / basic / map-key suites | ✅ captured |
| Runtime speed of emitted code, bootstrap vs self-hosted | ✅ captured (and now in the suite) |

## Compile time

Bootstrap = TypeScript compiler on Node. Ratios relative to Bootstrap; lower is
better.

| Target | Bootstrap (Node) | Self-Hosted (Wasmtime) | Self-Hosted (Node) | Wt/Boot | Node/Boot |
| --- | --- | --- | --- | --- | --- |
| `minimal.zena` (mean of 5) | 240.03 ms | 326.90 ms | 229.96 ms | 1.36× | 0.96× |
| `self_compile` (1 run) | 4391 ms (wall) | 7194 ms (internal total) | — | ~1.64× | — |

`self_compile` self-hosted phase breakdown: Check 697 ms, Codegen 5946 ms,
Total 7194 ms.

The two figures for `self_compile` are not measured identically — the bootstrap
number is wall clock (`time`), the self-hosted number is the compiler's own
`--time` total, which excludes process startup and wasmtime instantiation. Treat
the ratio as indicative, not precise.

## Runtime of generated code

Full output is in the appendix. Selected results, Zena under wasmtime vs the
equivalent JavaScript on Node:

| Benchmark | Zena (Wasmtime) | JS (Node) | Ratio |
| --- | --- | --- | --- |
| Fibonacci Recursive (N=40) | 583.34 ms | 755.13 ms | **0.77×** |
| Direct Call (non-inlinable, N=10M) | 7.86 ms | 11.68 ms | **0.67×** |
| StringConcatBuilder (N=100,000) | 0.86 ms | 2.88 ms | **0.30×** |
| String.fromParts (N=100,000) | 5.49 ms | 8.64 ms | **0.64×** |
| C-style index for-loop (N=10M) | 8.66 ms | 3.58 ms | 2.42× |
| StringComparison (N=100,000) | 6.51 ms | 0.27 ms | 24.11× |
| Indirect Closure Call (N=10M) | 135.29 ms | 3.44 ms | 39.33× |

Zena beats JS on recursion, calls, and builder-based string construction, and
loses badly on string comparison and indirect closure calls — the latter is the
standout outlier (39× under wasmtime, yet 0.69× on Node, so it is a wasmtime
code-generation issue rather than a language one).

## Blocked

`stdlib_moderate.zena` and `stdlib_heavy.zena` cannot be compiled by the
self-hosted compiler at `b0e7ecd3`:

```
zir unsupported: unresolved callee @main [in main]
    at ZirUnsupported.<constructor>
    at ir/lowering.zena:lowerFunction
```

Filed in BUGS.md. The bootstrap compiles both. Note the failure aborts the whole
benchmark suite, which is why a run appears to stop after `minimal`.

**The bug is now fixed** (prelude closure split, see BUGS.md), and all six
fixtures compile under both compilers. These two rows — and the emitted-size
rows for them — need a re-run to fill in, which is the remaining work on this
baseline.

## Emitted code size: bootstrap vs self-hosted

The suite **does** compare the two compilers directly — every target, including
`self_compile`, is built by Bootstrap (Node), Self-Hosted (Wasmtime) and
Self-Hosted (Node), and all three are timed. What it did not do was compare the
*emitted code*; both artifacts are written per target and neither was measured.
Size comparison is now part of the suite.

**Measure it excluding custom sections.** Raw file size is not apples-to-apples:
the self-hosted compiler always emits a `name` custom section while the
bootstrap only does so under `-g`, and on these fixtures that section is
**55–62% of the apparent size gap**. The suite now reports both, with the
ex-custom figure as the headline.

| Fixture | Raw ratio | **Excluding custom** | `code` section | `types` section |
| --- | --- | --- | --- | --- |
| `string_bench` | 2.19× | **1.54×** | 1.44× | 2.23× |
| `basic_bench` | 1.92× | **1.37×** | 1.34× | 1.73× |
| `map_key_bench` | 2.34× | **1.51×** | 1.36× | 2.44× |

So the honest figure is **~1.4–1.5× larger**, not the ~2× a raw byte count
suggests. Within that, the `code` section is 1.34–1.44× and the **`types`
section is the disproportionate one** — 1.7–2.4× by bytes, and by count 14 → 71
type entries on `basic_bench`. That is a specific, actionable lead rather than a
diffuse "bigger output".

### It is not fixed support-code overhead

A natural suspicion is that the gap is a constant preamble of runtime/stdlib
support code. It is not — subtracting the `minimal.zena` baseline, the
*incremental* bytes show the same ratio:

| Fixture | Δ bootstrap | Δ self-hosted | Δ ratio |
| --- | --- | --- | --- |
| `string_bench` | 26,826 B | 57,548 B | 2.15× |
| `basic_bench` | 34,137 B | 60,877 B | 1.78× |
| `map_key_bench` | 43,433 B | 102,044 B | 2.35× |
| the compiler itself | 1,945,598 B | 4,037,579 B | 2.08× |

(These deltas are raw, so they carry the same name-section inflation.) The point
is the *shape*: if the gap were fixed overhead, the ratio would collapse toward
1.0 as programs grow. The compiler is ~150× larger than `minimal` and sits at
the same 2.08×, so the growth is proportional to the program, not a constant.

Caveat retained: neither leg passes `--dce`, which BUGS.md records as a ~340×
difference on a trivial program, so absolute sizes are dominated by unreachable
stdlib and only ratios are meaningful.

### Runtime of emitted code: captured

The suite now compiles each micro-benchmark fixture with **both** compilers and
runs both artifacts under wasmtime, so the only variable is which compiler
produced the code (`Codegen Comparison` sections). 59 comparisons:

| | |
| --- | --- |
| Median ratio (self-hosted / bootstrap) | **0.95×** |
| Comparisons slower than 1.10× | 7 of 59 |
| Emitted size | 1.9×–2.3× larger |

**Self-hosted codegen is broadly at parity or better despite emitting roughly
twice the bytes.** The wins are concentrated where the ZIR work has been:

| Benchmark | Bootstrap | Self-hosted | Ratio |
| --- | --- | --- | --- |
| `LoopForInGrowableArrayInterface` | 303.87 ms | 141.07 ms | 0.46× |
| `LoopForInArrayInterface` | 303.89 ms | 142.20 ms | 0.47× |
| `DevirtInferCall` | 8.75 ms | 4.34 ms | 0.50× |
| `MapCustomKey3` | 8.03 ms | 5.17 ms | 0.64× |

And two sharp outliers in the other direction, filed in BUGS.md:

| Benchmark | Bootstrap | Self-hosted | Ratio |
| --- | --- | --- | --- |
| `FieldAccessVirtual` | 2.13 ms | 126.79 ms | **59.53×** |
| `FieldAssignVirtual` | 4.29 ms | 123.83 ms | **28.86×** |

The devirtualized variants of the same benchmark are only ~2× off, so this
looks like a specific missing optimization for *virtual* field access rather
than a broad problem — and it is exactly the kind of thing that would have been
invisible after retirement.

## Appendix: raw output

Reproduce with `npm run benchmark -w @zena-lang/zena-compiler` inside
`nix develop`.

```
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
│ StringConcatPlus (N=10,000)              │           5.60 ms │          25.28 ms │          0.65 ms │           8.62x │          38.89x │
│ StringConcatBuilder (N=10,000)           │           0.07 ms │           0.20 ms │          0.76 ms │           0.09x │           0.26x │
│ StringConcatBuilder (N=100,000)          │           0.86 ms │           0.62 ms │          2.88 ms │           0.30x │           0.22x │
│ StringConcatBuilderByte (N=100,000)      │           0.22 ms │           0.37 ms │          1.43 ms │           0.15x │           0.26x │
│ StringDirectByteArray (N=100,000)        │           0.08 ms │           0.16 ms │          0.54 ms │           0.15x │           0.30x │
│ StringSlicing (N=100,000)                │           0.74 ms │           0.81 ms │          2.13 ms │           0.35x │           0.38x │
│ StringComparison (N=100,000)             │           6.51 ms │           1.89 ms │          0.27 ms │          24.11x │           7.00x │
│ StringCompareIdentical (N=100,000)       │           0.28 ms │           0.24 ms │          0.22 ms │           1.27x │           1.09x │
│ StringCompareNonIdentical (N=100,000)    │           4.94 ms │           1.54 ms │          0.28 ms │          17.64x │           5.50x │
│ StringTemplateLiteral (N=10,000)         │           0.69 ms │           0.58 ms │          0.49 ms │           1.41x │           1.18x │
│ StringSearch (N=10,000)                  │           0.51 ms │           0.47 ms │          0.54 ms │           0.94x │           0.87x │
│ StringMapIndexing (N=10,000)             │           0.35 ms │           0.70 ms │          0.78 ms │           0.45x │           0.90x │
│ CompareConcatPlus (N=100,000)            │           7.97 ms │           7.38 ms │          0.26 ms │          30.65x │          28.38x │
│ CompareTemplateLiteral (N=100,000)       │           6.82 ms │           5.23 ms │          1.17 ms │           5.83x │           4.47x │
│ CompareStringBuilderNew (N=100,000)      │          11.88 ms │           8.94 ms │         10.30 ms │           1.15x │           0.87x │
│ CompareStringBuilderFromString (N=100,000) │          10.12 ms │           8.13 ms │          9.79 ms │           1.03x │           0.83x │
│ CompareStringFromParts (N=100,000)       │           5.49 ms │           4.70 ms │          8.64 ms │           0.64x │           0.54x │
└──────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Concatenation Techniques Comparison (N=100,000):
┌──────────────────────────┬───────────────────┬───────────────────┬──────────────────┬──────────────────────┐
│ Technique                │   Zena (Wasmtime) │    Zena (Node.js) │     Node.js (JS) │    Speedup vs + (Wt) │
├──────────────────────────┼───────────────────┼───────────────────┼──────────────────┼──────────────────────┤
│ Operator +               │           7.97 ms │           7.38 ms │          0.26 ms │                1.00x │
│ Template Literal         │           6.82 ms │           5.23 ms │          1.17 ms │                1.17x │
│ StringBuilder (New)      │          11.88 ms │           8.94 ms │         10.30 ms │                0.67x │
│ StringBuilder (from)     │          10.12 ms │           8.13 ms │          9.79 ms │                0.79x │
│ String.fromParts         │           5.49 ms │           4.70 ms │          8.64 ms │                1.45x │
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
│ Fibonacci Recursive (N=35)                 │          57.49 ms │          24.12 ms │         69.03 ms │           0.83x │           0.35x │
│ Fibonacci Recursive (N=40)                 │         583.34 ms │         265.91 ms │        755.13 ms │           0.77x │           0.35x │
│ Fibonacci Iterative (N=10M)                │          25.61 ms │          23.22 ms │         23.22 ms │           1.10x │           1.00x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Direct & Indirect Function Calls (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Direct Call (simple/inlinable)             │           2.08 ms │           2.17 ms │          3.49 ms │           0.60x │           0.62x │
│ Direct Call (non-inlinable)                │           7.86 ms │          14.78 ms │         11.68 ms │           0.67x │           1.27x │
│ Indirect Closure Call                      │         135.29 ms │           2.36 ms │          3.44 ms │          39.33x │           0.69x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Looping & Iteration (N=10,000,000 elements)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ C-style index for-loop                     │           8.66 ms │           3.62 ms │          3.58 ms │           2.42x │           1.01x │
│ while-loop / array                         │           9.69 ms │           3.61 ms │          3.60 ms │           2.69x │           1.00x │
│ for-in / array                             │           9.12 ms │           3.60 ms │          3.77 ms │           2.42x │           0.95x │
│ for-in / array (interface)                 │         302.56 ms │          26.06 ms │          3.81 ms │          79.41x │           6.84x │
│ for-in / growable array                    │           9.91 ms │           3.24 ms │          3.81 ms │           2.60x │           0.85x │
│ for-in / growable array (interface)        │         306.81 ms │          26.15 ms │          3.81 ms │          80.53x │           6.86x │
│ for-in / immutable array                   │           8.62 ms │           3.62 ms │          3.80 ms │           2.27x │           0.95x │
│ for-in / immutable array (interface)       │         284.51 ms │          27.18 ms │          3.81 ms │          74.67x │           7.13x │
│ for-in / custom collection                 │         278.09 ms │          27.11 ms │         47.04 ms │           5.91x │           0.58x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Type Casting (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Direct Field Access                        │          10.79 ms │           2.31 ms │          3.51 ms │           3.07x │           0.66x │
│ Cast Field Access (as String)              │          17.61 ms │           2.15 ms │          3.48 ms │           5.06x │           0.62x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Field Access (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Virtual Dispatch                           │           2.27 ms │           2.56 ms │          3.44 ms │           0.66x │           0.74x │
│ Devirtualized (Final Class)                │           2.18 ms │           2.14 ms │          3.42 ms │           0.64x │           0.63x │
│ Devirtualized (Final Field)                │           2.12 ms │           2.15 ms │          3.42 ms │           0.62x │           0.63x │
│ Devirtualized (Effectively Final)          │           2.12 ms │           2.14 ms │          3.42 ms │           0.62x │           0.63x │
│ Record (No Adaptation)                     │         131.10 ms │           2.34 ms │          3.43 ms │          38.22x │           0.68x │
│ Record (Adaptation)                        │         131.65 ms │           2.37 ms │          3.43 ms │          38.38x │           0.69x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Field Assignment (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Virtual Dispatch                           │           4.40 ms │           2.16 ms │          2.68 ms │           1.64x │           0.81x │
│ Devirtualized (Final Class)                │           4.35 ms │           2.90 ms │          2.69 ms │           1.62x │           1.08x │
│ Devirtualized (Final Field)                │           4.31 ms │           2.15 ms │          2.75 ms │           1.57x │           0.78x │
│ Devirtualized (Effectively Final)          │           4.35 ms │           2.12 ms │          2.89 ms │           1.51x │           0.73x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Method Devirtualization (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ Dynamic (non-devirtualizable)              │         125.12 ms │           3.25 ms │          3.44 ms │          36.37x │           0.94x │
│ Dynamic (devirtualizable)                  │           8.59 ms │           2.17 ms │          3.46 ms │           2.48x │           0.63x │
│ Override Dynamic (non-devirt)              │         186.21 ms │           4.34 ms │          3.43 ms │          54.29x │           1.27x │
│ Override Dynamic (devirtualized)           │          12.84 ms │           2.16 ms │          3.42 ms │           3.75x │           0.63x │
│ Static (devirtualized)                     │           6.42 ms │           2.39 ms │          3.45 ms │           1.86x │           0.69x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: Pattern Matching vs is/else (N=10,000,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ match (single case)                        │          10.84 ms │           3.22 ms │         19.29 ms │           0.56x │           0.17x │
│ is check with if/else                      │           8.72 ms │           3.24 ms │         19.29 ms │           0.45x │           0.17x │
│ match (3 cases)                            │          28.20 ms │          10.00 ms │         19.48 ms │           1.45x │           0.51x │
│ is checks with if/else (3 cases)           │          26.11 ms │           9.96 ms │         19.37 ms │           1.35x │           0.51x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

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
│ String key (concat)                        │          41.21 ms │          25.58 ms │         22.44 ms │           1.84x │           1.14x │
│ CustomKey class                            │           8.69 ms │          10.03 ms │         16.22 ms │           0.54x │           0.62x │
│ CaseKey class                              │           8.01 ms │           9.33 ms │         14.13 ms │           0.57x │           0.66x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

Category: 3-Part Compound Keys (N=80,000)
┌────────────────────────────────────────────┬───────────────────┬───────────────────┬──────────────────┬─────────────────┬─────────────────┐
│ Test Case                                  │   Zena (Wasmtime) │       Zena (Node) │        JS (Node) │   Ratio (Wt/JS) │ Ratio (Node/JS) │
├────────────────────────────────────────────┼───────────────────┼───────────────────┼──────────────────┼─────────────────┼─────────────────┤
│ String key (concat)                        │          39.67 ms │          24.25 ms │         16.32 ms │           2.43x │           1.49x │
│ CustomKey class                            │           9.69 ms │           8.02 ms │         13.72 ms │           0.71x │           0.58x │
│ CaseKey class                              │           7.44 ms │           7.84 ms │         13.79 ms │           0.54x │           0.57x │
└────────────────────────────────────────────┴───────────────────┴───────────────────┴──────────────────┴─────────────────┴─────────────────┘

--------------------------------------------------

```
