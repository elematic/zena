# Language benchmarks

Tachometer-style benchmarks for Zena-generated code, run with
`zena-cli bench` (see `docs/design/benchmarking.md` for the design).

```sh
# from the repo root, after `npm run build` and a zena-cli build:
./target/release/zena-cli bench benchmarks/fib.json
```

Each workload is a triple that computes the same thing:

- `<name>.zena` — the Zena implementation, compiled by the current
  compiler at run time. This is the thing being measured.
- `milestones/<name>.wat` — a hand-written core-wasm reference,
  **frozen forever**. Never regenerate, reformat, or "optimize" a
  milestone: its entire value is that it is identical across years and
  machines, so results from different eras can both be expressed
  relative to it ("zena is within 3% of milestone" survives a hardware
  change; "zena took 1.38ms" does not).
- `<name>-node.js` — a Node/V8 baseline. It self-reports its inner
  measurement (last stdout line, in ms) so Node startup is excluded;
  each sample is still one fresh process.

Results land in `<suite>.results.json` (gitignored — they are
per-machine artifacts). The report only claims one variant is faster
than another when the 95% confidence interval of the difference of
means excludes zero; "unsure" is an honest and common answer on a
loaded machine, and the runner auto-extends sampling until conclusions
resolve or the time budget runs out.

Workloads:

| suite      | exercises                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fib`      | call overhead, recursion, scalar arithmetic                                                                                         |
| `sum-loop` | loop/branch codegen, integer ops, no calls                                                                                          |
| `sieve`    | allocation + indexed array reads/writes (GC array in Zena, linear memory in the milestone — a frozen reference, not a codegen twin) |

When adding a workload: keep all three variants semantically identical,
make the Zena and WAT versions return the same small exit code so a
mismatch is visible, and size the work so one invocation lands in
roughly the 1–20ms range — big enough for stable samples, small enough
that auto-sampling can afford hundreds of them.
