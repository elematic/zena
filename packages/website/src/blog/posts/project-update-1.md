---
title: 'Zena Project Update #1: Optimizations, Async, WASI Components, and the Standard Library'
description: 'Our first project update covers the ongoing major workstreams across Zena: aggressive ZIR optimizations, structured async concurrency, deterministic ownership, WASI Preview 3 components, standard library restructuring, and the new website.'
date: 2026-09-25T15:00:00Z
author: justinfagnani
tags:
  - updates
hero:
  image: 'https://images.unsplash.com/photo-1503694978374-8a2fa686963a?auto=format&fit=crop&w=1600&q=80'
  alt: 'A printing press printing a newspaper at high speed'
  credit: 'Photo by Bank Phrom on Unsplash'
---

Welcome to the very first **Zena Project Update**!

Zena is evolving very rapidly, and yet still doesn't have its first release.
Rather than waiting for big milestone we're going to attempt weekly(ish) updates
to serve as an window into ongoing development. We'll cover things like language
design evolutions, compiler optimizations, standard library additions, and
developer tools.

A few weeks ago, we achieved a huge milestone: **retiring the TypeScript
bootstrap compiler**. The Zena compiler is now 100% self-hosted, written in Zena
itself. Before that we were porting language changes across two compiler and
for a time, three backends. Now, with the self-hosted foundation solid and the
intermediate representation (ZIR) in place, our pace has accelerated across
several major workstreams.

## 1. Compiler Optimizations

Deleting the old AST-based backend and moving to **ZIR** (our control-flow graph
and SSA intermediate representation) opened the door to aggressive, multi-pass
optimizations.

We began by implementing the split passes for generators and `async`/`await`.
Once those landed, we built out a modular, multi-round optimization loop:

- **Global Value Numbering (GVN)**: Eliminates redundant calculations and loads.
  If code computes the same value twice (like `a + b`) or reads the same
  immutable field repeatedly, GVN replaces subsequent occurrences with the first
  result, deleting duplicate instructions from the output.
- **Inlining**: Copies a called function's body directly into the caller. This
  eliminates function-call overhead and exposes the callee's code to surrounding
  optimizations.
- **Devirtualization**: Replaces indirect, dynamic method lookups (vtable
  dispatches) with direct function calls whenever the concrete class of an
  object can be determined at compile time.
- **Scalar Replacement of Aggregates (SRoA)**: Dissolves short-lived heap
  objects into individual local variables. If an object is allocated locally and
  never escapes the function (like an iterator), SRoA breaks its fields apart
  into SSA registers, completely eliminating the heap allocation.
- **Jump Threading & Constant Propagation (SCCP)**: Evaluates branches and
  conditional checks whose values are known at compile time, bypassing branch
  diamonds and deleting unreachable dead paths.
- **Loop-Invariant Code Motion (LICM)**: Identifies computations inside a loop
  that produce the exact same result on every iteration and hoists them before
  the loop, executing them once instead of on every iteration.
- **Signature Specialization**: When a function accepting an interface is
  consistently called with the same concrete type, the compiler creates a
  specialized copy expecting that type, opening the door for direct calls and
  further inlining.
- **Dead-Code & Vtable Harvesting**: Sweeps through the module to delete
  functions, types, and vtable slots that became unreferenced after inlining and
  devirtualization, shrinking the final WebAssembly binary.

### Results

#### Iterator Protocol Evaporation

One of our primary optimization goals is **iterator protocol evaporation**.

In languages with dynamic dispatch, iterating over a custom collection using a
`for-in` loop usually incurs significant overhead: allocating an iterator
object, calling `[Iterable.iterator]()`, and performing virtual `next()` calls
on every iteration. While many compilers add special-case fast paths hardcoded
for built-in arrays, user-defined collections suffer.

In Zena, our optimizer takes the general iterator protocol:

```zena
for (let item in myCollection) {
  process(item);
}
```

and runs it through devirtualization, inlining, and SRoA. The iterator object
allocation dissolves completely, the `.next()` calls inline directly, and the
iterator's internal index becomes a plain, loop-carried SSA variable. The
general abstraction evaporates down to the exact performance of a hand-written
while loop—without any special-cased compiler hacks for specific collection
types.

#### `.map()` Fusion

Higher-order collection methods like `.map()` and `.filter()` frequently create
performance penalties due to temporary array allocations and closure creation.

Through the combination of interface devirtualization, inlining, and escape
analysis, a call like:

```zena
let ys = xs.map((x: i32): i32 => x * 3 + offset);
```

can inline `map`, invoke the closure body directly as a straight-line scalar
operation, and avoid heap-allocating the closure environment entirely. In
microbenchmarks, this brings functional-style chained expressions down to the
equivalent of hand-written loops.

#### Measurements

To measure the real-world impact of these passes, our benchmark suite pairs
high-level idiomatic abstractions against hand-written imperative baselines:

<div class="no-zebra benchmark-table">

| Workload                                              | Optimization Level    | Binary Size | Runtime (Wasmtime) |
| :---------------------------------------------------- | :-------------------- | :---------- | :----------------- |
| **`iter-protocol`** (`for-in` over custom `Iterable`) | `-O0` (Unoptimized)   | 3.6 KB      | 106 ms             |
|                                                       | **`-O2` (Optimized)** | **221 B**   | **17 ms**          |
| _`iter-loop` (Hand-written `while` loop baseline)_    | _Baseline_            | _224 B_     | _18 ms_            |
| **`map-fusion`** (`array.map()` with closure literal) | `-O0` (Unoptimized)   | 12.0 KB     | 200 ms             |
|                                                       | **`-O2` (Optimized)** | **236 B**   | **20 ms**          |
| _`map-loop` (Hand-written loop without closure)_      | _Baseline_            | _247 B_     | _20 ms_            |

</div>

At `-O2`, the general iterator protocol drops from 3.6 KB to just 221 bytes and
runs **over 6× faster**—achieving exact parity with the hand-written index loop.
Similarly, higher-order `.map()` with a closure drops from 12 KB to 236 bytes
and runs **10× faster**, erasing the closure allocation overhead entirely.

#### The Compiler as a Benchmark

The ultimate stress test for the optimizer is compiling the Zena compiler
itself. Comparing the self-hosted compiler built at the lowest optimization
level (`-O0`) against the fully optimized pipeline (`-O2`) highlights the
compound effect of these passes on a large, real-world codebase:

- **Binary Size**: Compiling the compiler at `-O0` produces a 3.1MB WebAssembly
  binary. With the full ZIR optimization pipeline, the binary drops to
  **2.6MB**—a **500KB (~16%) reduction** across the compiler's codebase, even
  after aggressive inlining and specialization that increase binary output.
- **Compiler Throughput**: Because the compiler is written in Zena, optimizing
  the compiler speeds up compilation itself. Compiling benchmark programs with
  the optimized compiler binary runs **over 5× faster** than running the
  unoptimized compiler binary (e.g. compiling the `sieve` benchmark drops from
  7.7s to 1.4s).

## 2. Async & Structured Concurrency

Asynchronous execution is a first-class citizen in Zena. We compile `async`
functions into frame-based suspending state machines that execute over
cooperative microtask queues.

Recently, we've landed several critical primitives for **structured
concurrency**:

- **`CancelScope`**: Provides hierarchical cancellation trees. When an outer
  scope cancels, that cancellation cascades down to all child tasks and scopes
  automatically.
- **Wasm Exception Handling for Cancellation**: Cancellation raises on a
  **dedicated WebAssembly exception tag** rather than an ordinary `Error`. This
  cleanly unwinds the stack from any `await` suspension point,
  `checkCancellation()`, or `raiseCancellation()` call—running active `finally`
  blocks and `using` cleanups deterministically without ordinary `catch` blocks
  accidentally swallowing the directive.
- **`TaskGroup`**: Enables clean task spawning and nursery-style concurrency,
  ensuring child tasks cannot outlive the parent lexical block or leak
  background work.
- **`Stream<T>`**: First-class asynchronous generators and streams for
  processing sequences of values over time.

### Scoping Cancellation Capabilities

Our next step in the async workstream is refining cancellation capabilities. We
are scoping the `.cancel()` capability specifically to the creator of a
`CancelScope` and make `CancelScope` read only, ensuring that child code cannot
arbitrarily cancel parent scopes. This will likely involve closure cooperation
between `TaskGroup` and `CancelScope`, and possibly a generalization of
`CancelScope` to an `AsyncScope` that also supports nested microtask queues to
mitigate the infamous function coloring problem.

## 3. Deterministic Ownership in a WebAssembly GC World

Zena is a garbage-collected language targeting WebAssembly GC. Most
values—strings, records, classes, closures—are reclaimed automatically by the
host engine.

However, modern systems code must frequently interact with **external host
resources**: file descriptors, sockets, linear memory buffers, and WebAssembly
Component Model resource handles (`own<T>`).

**WebAssembly GC provides no object finalizers or destructors.** If a program
drops the last reference to an open file without explicitly closing it, that
resource leaks permanently in the host environment.

To solve this, Zena provides a sound, compile-time **ownership and resource
management system**:

- **`resource` classes**: Declared with the `resource` modifier and implementing
  the `Disposable` protocol.
- **Linear Ownership (`Own<R>`)**: A resource has exactly one owner at any time.
  Assigning or passing an owned resource moves ownership; the compiler
  statically ensures that unused resources are automatically disposed when their
  scope ends.
- **Second-Class Borrows (`Borrow<R>`)**: Owners can lend temporary,
  non-consuming access to functions down the stack.
- **`Scoped<T>` & `<scoped T>` Type Parameters**: Stack-bound values (such as
  borrowed resources or scoped futures) cannot be stored in heap collections or
  captured by long-lived closures. The `<scoped T>` generic constraint enforces
  affine consumption across execution paths.

_(Note on terminology: `Scoped<T>` remains the type for stack-scoped values,
while `Lease<T>` is our planned mechanism for exclusive, mutable borrows.)_

## 4. WebAssembly Components & WASI Preview 3

The WebAssembly Component Model is the future of interoperable, modular Wasm.
Zena is designed from the ground up to be a premier guest language for
components.

Recent component milestones include:

- **Direct WIT Support**: Thanks to our `@zena-lang/wit-parser` package, Zena
  can directly read WIT definitions and synthesize type-safe bindings for
  imports and exports.
- **"Hello World" HTTP Service**: We now have working end-to-end component
  examples, including a standalone HTTP service running under `wasmtime serve`.
  The service handles incoming HTTP requests and streams response text over
  `wasi:http` interfaces.

Components represent the natural convergence of our async and ownership
workstreams: WIT resource handles map directly to Zena's `Own<R>` types, and
WASI async functions map directly to Zena's `Future<T>`.

### Moving from WASI p1 to p3

Currently, Zena's command-line runtime uses WASI Preview 1 for basic stdio and
filesystem access. Over the coming milestones, we will migrate all of Zena's
core standard library I/O off WASI p1 and onto **WASI Preview 3**. This will
unlock rich async streams of objects, enabling native support for graphical
windows and GPU APIs (like `wasi:webgpu` and `wasi-gfx:surface`).

We are also designing an Express-like `zena:http` framework to make writing HTTP
microservices in Zena feel effortless and modern.

## 5. Standard Library Restructuring

We finished a major reorganization of the standard library to streamline
namespaces. We also added several new libraries that Zena needs for it's own
tools:

- **`zena:path`**: Cross-platform path parsing, joining, normalization, and
  segment traversal.
- **`zena:args`**: Declarative command-line argument parsing with typed flag
  extraction.
- **`zena:glob`**: High-performance glob matching featuring `GlobSet` and brace
  expansions (`src/**/*.{ts,zena}`).
- **`zena:url`**: Comprehensive URL parsing and standard `URLPattern` matching
  with minimal binary size footprint.
- **`zena:wasm`**: Spawning, supervising, and precompiling child WebAssembly
  modules from within Zena programs. These are based on Zena-specific host
  imports, since there are no WASI interfaces for running new modules.

See the new [Standard Library Reference](/api/) for the full list of APIs.

## 6. CLI & Runtime Architecture Split

As Zena's deployment targets expanded, bundling the compiler and runtime into a
single monolith became impractical. We restructured the CLI architecture into
modular layers:

- **`packages/zena-runtime`**: A standalone Rust crate that configures the
  Wasmtime engine, manages `.cwasm` ahead-of-time compilation caches, and
  provides host imports.
- **`packages/zena-run`**: A lightweight binary dedicated solely to executing
  compiled Zena modules without loading compiler machinery.
- **`packages/zena-cli`**: The complete developer command-line interface for
  compiling, running, testing, and benchmarking.
- **`packages/zb`**: An early build orchestrator written entirely in Zena, based
  on Google's [Wireit npm script runner](https://github.com/google/wireit).

## 7. Documentation, Website, & Playground

We officially launched our new project documentation website at
[zena-lang.dev](https://zena-lang.dev)!

The new site includes:

- **The Interactive Playground**: An in-browser editor
  ([`<zena-playground>`](/playground/)) running the full Zena compiler and
  Language Server Protocol (LSP) in WebAssembly GC right inside your browser.
- **Auto-Generated API Reference**: The [Standard Library Reference](/api/) is
  extracted directly from Zena source files and doc comments using
  `@zena-lang/zenadoc`.
- **In-Depth Language Docs**: New reference guides covering
  [Classes](/reference/classes/), [Streams](/reference/streams/),
  [Decorators](/reference/decorators/), and [Ownership](/reference/ownership/).
- **Atom Feed**: Subscribe to project updates directly via
  [`/blog/feed.xml`](/blog/feed.xml).

## On Deck

Here is a glimpse of what's currently in progress for upcoming updates:

- **Hybrid Sync/Async Iteration Protocol**: Unifying synchronous and
  asynchronous iteration protocols for optimal performance and flexibility.
- **WebAssembly `js-string-builtins` Support**: Direct zero-copy string
  interoperability when running in JavaScript environments.
- **`zena:http` Framework**: An Express-inspired routing and middleware library
  for WASI HTTP microservices.
- **Ownership Move Analysis**: Completing static borrow provenance and move
  checking for resource classes.

Stay tuned for our next update! If you want to follow along, you can subscribe
to the blog's [Atom feed](/blog/feed.xml), check out the [GitHub
repository](https://github.com/justinfagnani/zena), or join our conversations on
[Bluesky](https://bsky.app/profile/justinfagnani.com).
