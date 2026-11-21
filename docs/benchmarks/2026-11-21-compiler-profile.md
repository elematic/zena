# Compiler Benchmarks and Profile, November 2026

**Captured**: 2026-11-21
**Commit**: `c9b00790f` (`main` at `fae0de355` plus the build-graph change of #1299)

What the self-hosted compiler cost on that day, what wasmtime 51 changes,
where a profile says the time goes, and what each change made from it
bought. The method is in [profiling.md](../profiling.md) ("Linux, with
perf"), and the memory side in
[compiler-memory.md](../design/compiler-memory.md).

## Environment

|           |                                           |
| --------- | ----------------------------------------- |
| CPU       | AMD Ryzen 9 9955HX, 16 cores (a VM)       |
| Memory    | 31 GB                                     |
| OS        | Linux 6.18.63                             |
| wasmtime  | 50.0.1, and 51.0.0 where named            |
| rustc     | 1.98.1                                    |
| Collector | wasmtime's copying collector, the default |

## Workloads

Each is one run of a compiler module on `zena-run`, with nothing cached:

| name         | compile                                                  | reserve  |
| ------------ | -------------------------------------------------------- | -------- |
| `hello`      | `packages/compiler/src/test/hello_test.zena`             | none     |
| `self -O1`   | `packages/compiler/src/cli/main.zena`                    | 1536 MiB |
| `self -O2`   | the same, at `-O2`                                       | 1536 MiB |
| `CLI module` | `packages/cli/zena/main.zena`, which `build:module` runs | 1536 MiB |

The compiler module is stage A (`packages/compiler/out/cli.wasm`), which
the bootstrap builds at `-O2`. Times are the best of the runs named;
runs of one workload agree within 1% on an idle machine.

## Baseline

Three runs each, wasmtime 50.0.1:

| workload     | time   | peak RSS | time with no reserve | peak RSS with no reserve |
| ------------ | ------ | -------- | -------------------- | ------------------------ |
| `hello`      | 0.74 s | 143 MiB  | 0.74 s               | 143 MiB                  |
| `self -O1`   | 14.2 s | 3129 MiB | 37.6 s               | 1587 MiB                 |
| `self -O2`   | 22.8 s | 3129 MiB | 43.6 s               | 1587 MiB                 |
| `CLI module` | 26.1 s | 3129 MiB | 52.2 s               | 1587 MiB                 |

Under the null collector, which never frees, `hello` takes 0.27 s and
`self -O1` 13.3 s, allocating 2.98 GiB. So at the build's reserve the
collector is about 1 s of `self -O1`, and with no reserve it is most of
every compile, the smallest included.

By phase (`--time`, ms):

| phase                    | `self -O1` | `self -O2` | `CLI module` |
| ------------------------ | ---------- | ---------- | ------------ |
| load, parse, scope       | 781        | 787        | 1,095        |
| check                    | 1,021      | 1,017      | 236          |
| discovery: queues        | 5,743      | 5,662      | 11,869       |
| discovery: layout        | 851        | 742        | 2,546        |
| layout                   | 779        | 739        | 1,185        |
| lower, optimize per body | 1,921      | 1,922      | 3,847        |
| the `-O2` module loop    |            | 8,167      |              |
| emit code                | 2,477      | 2,951      | 4,925        |
| total                    | 13,881     | 22,240     | 26,139       |

The CLI module's bodies are checked when reachability reaches them, so
its `check` is small and its discovery holds that work too.

## Wasmtime 51

The same compiler module on a host built with each, three runs each:

| workload     | 50.0.1  | 51.0.0  |
| ------------ | ------- | ------- |
| `hello`      | 0.73 s  | 0.74 s  |
| `self -O1`   | 14.07 s | 13.92 s |
| `self -O2`   | 22.61 s | 22.48 s |
| `CLI module` | 26.30 s | 26.11 s |

Peak RSS is the same. 50.0.3, the last patch release of 50, also
measures the same as 50.0.1.

51.0.0 does not have the fix for the subtype-check cache
([bytecodealliance/wasmtime#15133](https://github.com/bytecodealliance/wasmtime/issues/15133)),
which merged after its release branch was cut. With that fix applied to
a local copy of 51.0.0:

| workload     | 51.0.0  | 51.0.0 with the fix |
| ------------ | ------- | ------------------- |
| `self -O1`   | 13.94 s | 10.70 s             |
| `self -O2`   | 22.55 s | 19.45 s             |
| `CLI module` | 25.87 s | 19.47 s             |

The repository cannot take 51 yet, for two reasons. `wasi-gfx-runtime`
requires `wasmtime <=50`, so `zenafx` would be built against two
wasmtimes and does not compile. And three of the extension tests
(`packages/stdlib/tests/extensions/extensions_test.zena`) fail on 51
where they pass on 50, with "Recursive `StoreContextMut::run_concurrent`
calls not supported" when a resource an extension released is dropped.

## Changes to wasmtime, tried on a local copy

Each of these is wasmtime's to make. They were measured on a copy of the
51.0.0 crate, with the subtype-cache fix, to see what they are worth.

**The copying collector's growth threshold.** On a failed allocation
wasmtime collects, and grows the heap only once what survived the last
collection fills a whole semi-space. A compiler's live set grows
steadily, so each collection copies a nearly full semi-space to free
very little: compiling a three-line program, which allocates 124 MiB,
runs 101 collections that copy 1,030 MiB. Growing once the survivors
pass half a semi-space, the same compile runs 20 collections that copy
116 MiB, and ends with a heap of the same size. With no heap reserve at
all:

| compile or test run     | as released   | half a semi-space |
| ----------------------- | ------------- | ----------------- |
| a three-line program    | 0.67 s, 143 M | 0.27 s, 146 M     |
| `self -O1`              | 27.8 s, 1.5 G | 9.3 s, 1.6 G      |
| `CLI module`            | 37.8 s, 1.6 G | 16.4 s, 3.1 G     |
| `packages/stdlib` tests | 40.2 s, 1.9 G | 21.4 s, 2.6 G     |
| `package-manager` tests | 23.6 s, 2.3 G | 8.5 s, 4.0 G      |
| `registry` tests        | 72.6 s, 5.7 G | 20.6 s, 9.7 G     |

That is as good as the compiler's 192 MiB reserve
(docs/design/compiler-memory.md, "The heap reserve") for the small
cases and much better for the large one, where the reserve gives
50.9 s. The reserve stands in for this change until wasmtime makes it.

**Inlining small callees into large callers.** Wasmtime checks the sum
of the caller's and callee's sizes against its limit before its rule
that a small callee is always worth inlining, so the rule never
applies. Applying it first changes nothing at the default small size
of 50, which the array accessors exceed once their GC operations are
expanded. At 200 `self -O1` is 5% faster and `self -O2` 9%, with a
`.cwasm` 24% larger, and at 400 the compiler overflows the stack.

**Reading a funcref from a struct**, which a closure call and a virtual
call both do, is a libcall. Skipping the type check inside it gains 0.5
to 0.8%. The rest of its 2 to 3.5% is the call, which only a fast path
in the code Cranelift emits would remove. That was not built.

## Profile

`perf` samples of the baseline compiler, by where the sample's leaf is:

| workload     | host        | the compiler | subtype checks | collector | other host |
| ------------ | ----------- | ------------ | -------------- | --------- | ---------- |
| `self -O1`   | 50.0.1      | 60%          | 23%            | 11%       | 6%         |
| `self -O1`   | 51 with fix | 75%          | 4%             | 14%       | 7%         |
| `self -O2`   | 51 with fix | 85%          | 2%             | 9%        | 4%         |
| `CLI module` | 51 with fix | 74%          | 4%             | 16%       | 6%         |

Inclusive samples on the host with the fix, which is where the
proportions will be once a release carries it:

| function or pass                          | `self -O1` | `self -O2` | `CLI module` |
| ----------------------------------------- | ---------- | ---------- | ------------ |
| reachability (`ReachabilityAnalysis.run`) | 38%        | 22%        | 48%          |
| of it, the queue walk                     | 33%        | 19%        | 39%          |
| copy coalescing at emission               | 18%        | 13%        | 20%          |
| lowering                                  | 8%         | 4%         | 10%          |
| the checker, before discovery             | 8%         | 4%         | 1%           |
| inlining sweeps                           |            | 8%         |              |
| use lists for the `-O2` passes            |            | 6%         |              |

By self time, `GrowableArray`'s `[]`, `[]=` and `push` are 13% of the
`-O1` workloads and 25% of `self -O2`. They are not inlined into the
functions that call them most: the compiler's own inliner takes a body
with control flow at several call sites only when it has six
instructions or fewer, and wasmtime's inlines nothing into a caller
past its size limit.

What the `self -O1` compile allocates, 2.99 GiB in 59 million objects:
strings and their bytes 20%, `i32` arrays 17% (three million of them
the eight-slot buffer a new list starts with), arrays of `ClassType`
5%, arrays of `Type` 4%, arrays of `String` 3%.

## Changes made from it

Each was measured against the build before it, on the host with the
subtype-cache fix, and each leaves the emitted modules byte-identical.

| change                                                               | `self -O1`     | `self -O2`      | `CLI module`    |
| -------------------------------------------------------------------- | -------------- | --------------- | --------------- |
| copy coalescing tracks only branch arguments and block params        | 10.85 → 9.60 s | 19.40 → 17.37 s | 19.77 → 17.37 s |
| discovery: repeated `discoverType` calls, member lookups, union keys | 9.63 → 9.15 s  | 17.48 → 16.64 s | 17.27 → 15.89 s |
| discovery: the subclass list walked in place                         | 8.86 → 8.73 s  |                 | 15.48 → 15.11 s |
| inliner: no tables for a body with nothing to inline                 |                | 16.77 → 16.09 s |                 |

The heap reserve is a change to the host, measured on wasmtime 50.0.1
with nothing cached (wall time; old binary and CLI module against new):

| command                              | before | after  |
| ------------------------------------ | ------ | ------ |
| `zena build` of a three-line program | 0.39 s | 0.23 s |
| `zena test packages/stdlib/tests`    | 43.0 s | 23.3 s |
| `zena test packages/package-manager` | 23.2 s | 10.3 s |
| `zena test packages/atproto`         | 15.4 s | 7.2 s  |

With the compiler changes as well, those are 0.21 s, 21.9 s, 9.6 s and
6.9 s, and `build:module` takes 18.2 s where it took 26.5 s.

## Measured and not taken

- **The compiler's inliner taking guarded accessors.** Leaving a
  callee's throwing blocks out of its size, and raising the limit for a
  body with control flow at several sites from six instructions to
  eight, inlines `GrowableArray`'s `[]`. A compiler built that way is
  3% faster at `-O1`, 7% at `-O2` and 2% on the CLI module, and 8%
  larger (2.43 MB to 2.64 MB).
- **A larger default reserve.** 256 MiB halves the registry's test time
  where the 192 MiB default takes a third off, and peaks at 9.8 GiB
  against 6.4.
- **A shared erased type** is in, for its 28,000 fewer types and 22,000
  fewer key strings, and moves no time.
- **Copying the inliner's replacement table to a fixed array** for the
  pass that rewrites every operand: no change.

## What is left

In the order the profile ranks them after the changes above:

- Reachability's queue walk. In the CLI module's compile, 49,766 of its
  60,495 member visits walk a body it has walked before, for another
  specialization: 2.8 s of 15.5 s. Most of that is registering what the
  specialization names, which a summary of the walk would still do.
- `GrowableArray` accessors, above.
- The collector, 9 to 16% at the build's reserve and more at the
  default: three million default-capacity `i32` lists (two per IR
  block, a dozen per emitted function) and 7.5 million strings.
- Copy coalescing's check of every pair of members of two classes, 4 to
  8%.
- At `-O2`: escape summaries are rebuilt for every body in every round
  (5%) though only the inliner's argument rule reads them, and each
  pass builds its own CFG (4%).
- Reading a funcref from a struct is a libcall in wasmtime, 2 to 3.5%.
