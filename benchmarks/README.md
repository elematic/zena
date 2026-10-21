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

| Workload                     | Exercises                              | Description                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`minimal`**                | Runtime & prelude baseline             | Smallest valid module returning integer `42`.                                                                                                                                                                                                                                                                                                                         |
| **`hello-world`**            | String literals & host boundary        | Program returning string `"Hello World"`.                                                                                                                                                                                                                                                                                                                             |
| **`array-sum`**              | Collections & iteration                | Fixed array literal `[1, 2, 3]` summed in loop.                                                                                                                                                                                                                                                                                                                       |
| **`map-fusion`**             | Interface dispatch, closures, inlining | `xs.map(x => ...)` through the `Array` interface with a closure literal; compares itself against `map-loop`.                                                                                                                                                                                                                                                          |
| **`map-loop`**               | Baseline for `map-fusion`              | The same computation as a loop written by hand.                                                                                                                                                                                                                                                                                                                       |
| **`iter-protocol`**          | Iterator protocol, scalar replacement  | `for (let x in xs)` over a collection class of its own that delegates to a `FixedArray`'s iterator, so the loop goes through `iterator()` and `next()` and can never take lowering's array special case; compares itself against `iter-loop`.                                                                                                                         |
| **`iter-loop`**              | Baseline for `iter-protocol`           | The same sum as an index loop written by hand.                                                                                                                                                                                                                                                                                                                        |
| **`zip-protocol`**           | Two iterators in step                  | `for (let (x, y) in zip(xs, ys))` over two `FixedArray`s with the standard library's `zip`, which drives both arrays' iterators and yields pairs; compares itself against `zip-loop`. The gaps that remain are in #456.                                                                                                                                               |
| **`zip-loop`**               | Baseline for `zip-protocol`            | The same sum of products as one index loop written by hand.                                                                                                                                                                                                                                                                                                           |
| **`iface-param`**            | Interface-typed parameters             | A two-loop sum whose parameter is `Array<i32>`, called with a `FixedArray`; the callee is a real function (two call sites, over the inline budgets); compares itself against `concrete-param`.                                                                                                                                                                        |
| **`concrete-param`**         | Baseline for `iface-param`             | The same function taking `FixedArray<i32>` directly.                                                                                                                                                                                                                                                                                                                  |
| **`immutable-param`**        | Immutable arrays                       | The same function taking `ImmutableArray<i32>` — every access an `array.get` on Wasm's `(array i32)`; compares itself against `concrete-param` to see whether the engine treats immutable element loads differently.                                                                                                                                                  |
| **`generic-param`**          | Generic over the representation        | The same function as `<A extends Array<i32>>`, called with a `FixedArray` for half the rounds and an `ImmutableArray` for the other half; each call site specializes the callee to its argument's representation.                                                                                                                                                     |
| **`poly-param`**             | Genuinely polymorphic interface param  | The same function taking `Array<i32>`, called with both representations — two live implementations, so devirtualization cannot make the accesses direct; compares itself against `generic-param`, `concrete-param`, and `immutable-param`.                                                                                                                            |
| **`record-ctor`**            | Record parameters, scalar replacement  | A seven-field class constructed two million times through a record parameter with optional fields (the named-argument pattern); compares itself against `positional-ctor` to see whether the record temporary is removed.                                                                                                                                             |
| **`positional-ctor`**        | Baseline for `record-ctor`             | The same class and loop, constructed positionally with default parameters.                                                                                                                                                                                                                                                                                            |
| **`iface-test-anyref`**      | Interface type tests on `anyref`       | `x is Shape` on an `anyref` operand cycling through eight implementers and two other classes. Eight implementers is under the chain limit, so the compiler emits a chain of class tests, each an inline compare against a final struct; compares itself against `iface-test-chain` (the same chain written by hand), `iface-test-anyref-many` and `iface-test-class`. |
| **`iface-test-anyref-many`** | Type tests through type info           | The same loop with twenty-four implementers, over the chain limit: a `ref.test` against `Object` (an open type, so wasmtime's `is_subtype` libcall) and the type-info loads.                                                                                                                                                                                          |
| **`iface-test-class`**       | Baseline for the type-info read        | The same test on a class-typed operand: the type-info loads with no cast.                                                                                                                                                                                                                                                                                             |
| **`iface-test-chain`**       | Baseline for `iface-test-anyref`       | The same question as a hand-written chain of up to eight class tests.                                                                                                                                                                                                                                                                                                 |
| **`fib`**                    | Function calls & recursion             | Recursive `fib(27)`.                                                                                                                                                                                                                                                                                                                                                  |
| **`sum-loop`**               | Branching & integer arithmetic         | Iterative loop accumulation up to 5,000,000.                                                                                                                                                                                                                                                                                                                          |
| **`sieve`**                  | Memory / array allocation & indexing   | Sieve of Eratosthenes up to 300,000.                                                                                                                                                                                                                                                                                                                                  |

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

---

## HTTP File Serving

`benchmarks/http/file-serving.sh` times serving one file over HTTP from
`zena-cli` (issue #323). It writes a file of random bytes, serves it with
`benchmarks/http/file-server.zena`, and fetches it with curl two ways:
through `serve`, where the file's stream goes to the response unread and
the host copies it, and through `/copy/`, where the guest reads the file
and sends the bytes. Python's `http.server` (which uses `sendfile`) on the
same file is the reference. Each route's bytes are checked against the
file once.

```sh
benchmarks/http/file-serving.sh
SIZE_MB=256 RUNS=25 benchmarks/http/file-serving.sh
```

A dev build of `zena-cli` compiles against the standard library of the
checkout it was built from, so run the script from that checkout.
