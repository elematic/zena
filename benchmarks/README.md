# Cross-Language Wasm Benchmarks (Size & Speed)

This suite benchmarks **Binary Size** and **Execution Speed** across WebAssembly-compiled languages.

Languages supported in Phase 1:

- **Zena** (WASM-GC)
- **AssemblyScript** (`asc-size` with `--runtime stub -O3z`, `asc-speed` with `--runtime incremental -O3`)
- **Rust** (`rust-nostd` with `#![no_std]` size-optimized, `rust-std` with standard library)
- **Frozen WAT Milestones** (hand-written core-wasm baseline)
- **Node.js / V8** (JIT baseline with self-reported timing)

Future languages planned: JavaScript, Python, Dart, Swift, Go, Kotlin, and Zig.

---

## Running Benchmarks

All benchmark orchestration tools are written in **Zena** and executed via `zena-cli`.

### Quick Commands

```sh
# Build all workload variants and run size analysis
npm run bench

# Build all workload variants across Zena, AssemblyScript, and Rust
npm run bench:build

# Run binary size analysis and generate comparison table
npm run bench:size

# Run speed benchmarks (Tachometer-style statistical sampling)
npm run bench:speed

# Target a specific workload
./target/release/zena-cli run --allow-spawn --dir .::. benchmarks/zena/run.zena fib
```

---

## Workloads

| Workload              | Exercises                              | Description                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`minimal`**         | Runtime & prelude baseline             | Smallest valid module returning integer `42`.                                                                                                                                                                                                 |
| **`hello-world`**     | String literals & host boundary        | Program returning string `"Hello World"`.                                                                                                                                                                                                     |
| **`array-sum`**       | Collections & iteration                | Fixed array literal `[1, 2, 3]` summed in loop.                                                                                                                                                                                               |
| **`map-fusion`**      | Interface dispatch, closures, inlining | `xs.map(x => ...)` through the `Array` interface with a closure literal; compares itself against `map-loop`.                                                                                                                                  |
| **`map-loop`**        | Baseline for `map-fusion`              | The same computation as a loop written by hand.                                                                                                                                                                                               |
| **`iter-protocol`**   | Iterator protocol, scalar replacement  | `for (let x in xs)` over a collection class of its own that delegates to a `FixedArray`'s iterator, so the loop goes through `iterator()` and `next()` and can never take lowering's array special case; compares itself against `iter-loop`. |
| **`iter-loop`**       | Baseline for `iter-protocol`           | The same sum as an index loop written by hand.                                                                                                                                                                                                |
| **`iface-param`**     | Interface-typed parameters             | A two-loop sum whose parameter is `Array<i32>`, called with a `FixedArray`; the callee is a real function (two call sites, over the inline budgets); compares itself against `concrete-param`.                                                |
| **`concrete-param`**  | Baseline for `iface-param`             | The same function taking `FixedArray<i32>` directly.                                                                                                                                                                                          |
| **`immutable-param`** | Immutable arrays                       | The same function taking `ImmutableArray<i32>` — every access an `array.get` on Wasm's `(array i32)`; compares itself against `concrete-param` to see whether the engine treats immutable element loads differently.                          |
| **`generic-param`**   | Generic over the representation        | The same function as `<A extends Array<i32>>`, called with a `FixedArray` for half the rounds and an `ImmutableArray` for the other half; each call site specializes the callee to its argument's representation.                             |
| **`poly-param`**      | Genuinely polymorphic interface param  | The same function taking `Array<i32>`, called with both representations — two live implementations, so devirtualization cannot make the accesses direct; compares itself against `generic-param`, `concrete-param`, and `immutable-param`.    |
| **`record-ctor`**     | Record parameters, scalar replacement  | A seven-field class constructed two million times through a record parameter with optional fields (the named-argument pattern); compares itself against `positional-ctor` to see whether the record temporary is removed.                     |
| **`positional-ctor`** | Baseline for `record-ctor`             | The same class and loop, constructed positionally with default parameters.                                                                                                                                                                    |
| **`fib`**             | Function calls & recursion             | Recursive `fib(27)`.                                                                                                                                                                                                                          |
| **`sum-loop`**        | Branching & integer arithmetic         | Iterative loop accumulation up to 5,000,000.                                                                                                                                                                                                  |
| **`sieve`**           | Memory / array allocation & indexing   | Sieve of Eratosthenes up to 300,000.                                                                                                                                                                                                          |

---

## Workload Directory Structure

Each workload lives under `benchmarks/workloads/<name>/`:

```
benchmarks/workloads/minimal/
├── main.zena          # Zena implementation
├── main.as.ts         # AssemblyScript implementation
├── main_nostd.rs      # Rust no_std implementation
├── main_std.rs        # Rust standard library implementation
└── bench.json         # Speed benchmark configuration for zena-cli bench
```

---

## Speed Benchmarking Methodology

Speed benchmarks use `zena-cli bench` (powered by `zena:bench`):

- **Tachometer-style round-robin sampling**: Variants are sampled in rotation to eliminate bias from CPU throttling and background noise.
- **Fresh instantiation**: Each `.wasm` sample is freshly instantiated and timed host-side (`Instant`), excluding compilation and module load time.
- **Distributions & Welch's t-difference of means**: 95% confidence intervals and hypothesis testing determine whether differences are statistically significant or "unsure".
- **Result Output**: Outputs detailed comparison and writes `<workload>.results.json`.
