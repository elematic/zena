# Zena Development Plan

This document tracks completed work and planned features. For project instructions and coding standards, see [AGENTS.md](./AGENTS.md).

## Completed

- **Core Infrastructure**: Project setup with TypeScript compiler, CLI, and portable test suites.
- **Language Syntax & Semantics**: Arrow functions, top-level `function` declarations (hoisted, never closures), lexical blocks, and control flow.
- **WASM-GC Native Code Generation**: Implemented natively targeting WebAssembly GC.
- **Data Structures & Types**:
  - Primitives (`i32`, `i64`, `u32`, `f32`, `f64`, `boolean`, `String`).
  - Records & Tuples (boxed canonical WASM structs, destructured bindings, and unboxed multi-value returns).
  - Arrays (Fixed-size WASM arrays and growable array implementations).
- **Generics & Polymorphism**:
  - Reified generics with complete monomorphization (no auto-boxing overhead for primitives).
  - Single inheritance, abstract classes, mixins, and interfaces (fat pointer representation with vtables).
- **Functional Programming**: Closures and captures, inline tuples, and the pipeline operator (`|>`).
- **Control Flow & Pattern Matching**:
  - Exhaustive pattern matching (`match` expression) supporting literals, variables, records, classes, logical combinators, and guards.
  - Pattern conditions (`if let`, `while let`) and `for-in` loops over `Iterator`/`Array`.
- **Error Handling**: WASM-GC exception handling (`throw` and `try`/`catch`).
- **Standard Library**: Core library modules (`String`, `StringBuilder`, `Array`, `Map`, `HashSet`, `Option`, `JSON`, `Regex`, file I/O).
- **Optimization**: Compiler-driven dead code elimination (DCE) for functions, classes, methods, and WASM types.
- **Tooling & IDE**: Incremental type-checking (ScopeResult caching, export signature comparison) and language service support.

## Planned / Next Milestones

> Detailed cross-track sequencing for the 2026-08 language arc —
> generators → async, value-semantics/equality contractions, row types,
> and the record-semantics flip at bootstrap retirement — is in
> [docs/design/implementation-plan.md](docs/design/implementation-plan.md).

### Phase 1: Self-Hosted Compiler (COMPLETE 2026-08-06)

- **Goal**: Retire the TypeScript bootstrap compiler and move entirely to the self-hosted compiler (`packages/zena-compiler`).
- **Status**: **Done.** The TypeScript compiler is deleted; a fresh checkout bootstraps from the checked-in `packages/zena-compiler/bootstrap/cli.wasm` (see `docs/design/bootstrapping.md`), gated by the `test:fixpoint` self-compilation byte-parity check.
- **New IR Backend**: Building a new IR-based backend to unlock advanced optimizations (devirtualization, specialization, and size reductions).
- **Performance Optimizations**:
  - Solve quadratic JIT compilation/lookups. Introduce hashed lookup indices for WASM functions in the code generator to eliminate $O(N)$ linear scans.
  - Implement hybrid monomorphization: share specialized reference type methods (e.g. `Box<anyref>`) to reduce compiled WASM code size.

### Phase 2: Platform Features (Post-Retirement)

- **Async Functions & Cooperative Multithreading**: Native support for asynchronous execution, targeting upcoming WASM P3 features with cooperative multithreading.
  - **A0 (front end) and A1 (transform) are done.** `async`/`await` parse,
    check, and _run_: the split pass compiles async bodies into frame-based
    state machines that park on futures and resume off a microtask queue, and
    an async `main` is driven to completion by a synthesized export wrapper —
    so async programs run under plain `wasmtime --invoke main` today, with no
    host event loop and no changes to `zena-cli`.
  - **`await` on a union is done**, generalized past the design's
    sketch: `T | Future<U> | Future<V>` yields `T | U | V` — future
    arms are distinguished at runtime and each suspends on its own
    future, bare arms forward through one queue hop (the always-async
    rule), and `T | Future<T>` collapses to `T`, the maybe-async
    shape. See [async.md](docs/design/async.md) §1.
  - **await-in-try is done too** (§6), the fast-follow to A1: resuming
    re-enters each enclosing `try` region, so a failed await is caught by
    the handler the user wrote rather than silently rejecting the
    function's own future. Re-entry happens at every dispatch target,
    not only the resume blocks — a suspending loop's header is one too,
    and covering resume blocks alone leaves the stretch before each
    `await` unprotected on every iteration.
  - **`yield` inside `try` now works as well.** It was a v1 generator
    restriction waiting on exactly this region construction, so
    generators inherit it: both split passes share one implementation.
    See [generators.md](docs/design/generators.md) §6.
  - **Generator disposal is implemented** (cancellation step 5, the
    last piece): leaving a `for`-in early delivers a cancellation at
    the suspended `yield` — the generator's `finally`/`using` regions
    run and the frame is exhausted — behind its own whole-program gate
    (a protocol `for`-in plus a generator), with no `return()` method
    on `Iterator`. `yield` inside a `finally` block is now a checker
    error, and a dropped, hand-iterated generator still runs nothing.
  - **`Future<void>` works** — the fire-and-forget shape. It needed no
    async machinery: the blocker was that `void` could not be a type
    argument at all. `void` is now a zero-width type argument (it takes
    no wasm slot, so callers omit its arguments); see the language
    reference under "Generic Classes".
  - **A2 (timers) is done, on both targets.** `zena:time` provides
    `sleep(ms): Future<void>` and a monotonic clock, and `zena:async`
    grew a `Parker` hook so an empty microtask queue means "wait for
    the next external completion" rather than "done". The WASI entry
    parks on `poll_oneoff`; the host entry parks on two imports from
    `@zena-lang/runtime`. No `zena-cli` changes. `sleep` is what
    `Future<void>` was blocking.
  - **A3 (external completions on a JS host) is done.** A JS host can
    settle a Zena future from its own event loop, so `fetch` and friends
    are now expressible: `zena:host-async` mints an i32 handle and keeps
    the `Completer` behind it, the host calls `__zena_complete_<kind>`
    and `__zena_drain` when its work finishes, and
    `@zena-lang/runtime`'s `asyncImports` turns a promise-returning JS
    function into an import Zena can await. The registry needs no type
    tag — the completer's own specialized type is the tag — and the
    completion exports exist only in programs that import the module, so
    the JS target pays nothing for host I/O it does not do.
    `zena:time`'s host entry became an ordinary host-async binding over
    `setTimeout` in the process, leaving the `Clock`/timer-queue/`Parker`
    machinery reachable only from the WASI entry, which is the target
    that can actually block. `run()`/`runSync()` split so that a caller
    who wants a value and a caller who wants a promise get different
    functions.
  - **Combinators: `Future.all` and `Future.race` are done.** `Future.all` gives a
    future of every value in input order, or the first failure to
    arrive — reported at once, without waiting on inputs whose result
    can no longer matter. `Future.race` gives the first input to settle,
    value or failure, and refuses an empty array rather than handing
    back a future that can never settle. Both are ordinary library
    code over `subscribe`, exactly as the design predicted: no
    primitive and no compiler support. They shipped as free functions
    and became statics once statics-on-a-generic-class landed; each
    declares its own type parameter, because a static is outside its
    class's generic scope (§"Statics on a Generic Class" of the
    language reference).
  - **Fetch is done — the "first real async I/O" A3 was aiming at.**
    `zena:fetch` is a virtual module for the JS-hosted targets whose
    API follows the web's: `fetch(url): Future<Response>`, with
    `status`/`ok` on the response and `text(): Future<String>` reading
    the body — a 404 is a normal completion, and only "no response at
    all" fails the future. The host's response object crosses as a
    garbage-collected reference (host-interop.md, "Host object
    handles"), so `Response` carries no release obligation and the
    body stays on the host until `text()` reads it — also the
    structure a streamed body needs later.
    `@zena-lang/runtime` supplies the backing `web.*` imports by
    default from the host's own `fetch()`, which puts it in the
    playground with no playground changes. WASI and component builds
    fail at import resolution; the component's HTTP is `wasi:http`
    (async.md §4.1).
  - **Suspensions compose with exception regions.** Two fixes in the
    split passes: values live into a re-entered region's catch are
    spilled to the frame (the "local live across a try holding an
    `await` and a `return`" miscompile, loud and silent forms both),
    and every mutable variable moves into the frame — which lifted the
    `try`/`finally` and `using` suspension bails. `await` now works
    inside `try`/`finally` (finalizers can await too) and after
    `using`, the async-resource pattern.
  - **`Future.then` and `Future.flatMap` are done** (closure
    specialization unblocked them): derived futures settle from the
    source's outcome — transformed value, recovered or propagated
    failure — and cancellation forwards structurally, running no
    callback. No separate `map`: it is `then` with one argument.
  - **Cancellation and structured concurrency are done**, end to end
    ([cancellation.md](docs/design/cancellation.md)): the tag, scopes,
    checkpoints, completed-as-cancelled, the `cancel` clause,
    `shielded`, cancel-wakes-parked-frames, the `TaskGroup` core
    (spawn/join, first failure cancels siblings),
    `CancelScope.detached()`, the whole-program gate (async without a
    way to cancel carries none of the machinery), `TaskGroup.race`
    (loser-cancelling), `FutureClaim` (counted consumer interest), and
    generator disposal.
  - **The async roadmap**, roughly in order:
    1. **Reseed.** The bootstrap predates per-instantiation closure
       specialization, so the stdlib itself cannot yet create closures
       in generic code. Everything stylistic below waits on this.
    2. **Library cleanup.** Drop `onComplete` (`then` covers it),
       rewrite the internal waiter classes as closures where the cost
       is equal — they run once per settle — and document the
       zero-allocation await invariant where the code enforces it: a
       frame subscribes ITSELF (it implements `Task`), a settle
       allocates nothing (waiters pull), and the only allocation is
       the async call's own frame-plus-future.
    3. **Async iteration**: `async gen` functions (the two split
       passes already share their machinery), an `AsyncIterator<T>`
       protocol (`next(): Future<...>` — streams.md's convenience
       layer), and an explicit `for await` loop — explicit because
       suspension points are where cancellation delivers, and loop
       syntax should not hide one. Early exit disposes through the
       generator-disposal machinery, which for an async generator is
       exactly right: its pending `next()` is real work.
    4. **`await` on tuple and record literals of futures** —
       `let (a, b) = await (getA(), getB());` and
       `let {x, y} = await {x: fx(), y: fy()};` — the typed form of
       JS's `all`/`allKeyed`/`await*`, heterogeneous and with no
       combinator name to learn. Alongside, the library batch:
       `allSettled` (which needs an `Outcome<T>` sealed type — the
       principled outcomes-as-data counterpart to hiding `state`),
       `any`, and the composable resilience combinators below.
    5. **Composable resilience over real cancellation.** One shape,
       `type Op<T> = () => Future<T>`, and combinators from `Op<T>`
       to `Op<T>` — `timeout(ms, op)`, `deadline(t, op)`,
       `retry(n, op)` (with backoff), `fallback(op, alt)`,
       `hedge(delay, op)` — so composition order is syntax:
       `retry(3, timeout(100, op))` is a per-attempt budget,
       `timeout(500, retry(3, op))` an overall one. `TaskGroup.race`
       already has the `Array<Op<T>>` shape. Two rules make the
       algebra sound: policies act on FAILURES and never on
       cancellation (an ambient cancel passes through everything,
       untouched — retrying cancelled work would violate the scope
       tree), and every attempt runs in a child scope, so losers and
       expired attempts are actually cancelled rather than abandoned —
       the thing JS resilience libraries cannot do.
    6. **`checkCancellation()`** — the opt-in sync checkpoint for
       CPU-bound work with no natural suspension point (a parser's
       token loop): raises on the cancellation channel, so cleanup and
       propagation work exactly as at a real suspension point, where
       `currentScope().isCancelled` remains the poll-only form.
       `shielded` composes automatically (the ambient is rebound), and
       it is an observe site, so it never opens the whole-program
       gate. Kotlin's `ensureActive`, .NET's
       `ThrowIfCancellationRequested`.
    7. **Unhandled rejections.** A rejected future nobody observes
       currently vanishes, which is a fuzzy fallback. Design: a
       rejected future with no waiters joins a pending-unhandled
       list, any observation clears it, and drain quiescence reports
       the remainder through a settable handler, loud by default.
    8. **`async { ... }` blocks** — an expression of type `Future<T>`
       desugaring to an immediately-called async function expression,
       for awaiting inside sync contexts.
    9. **JS interop**: Zena async exports surfacing as Promises, and
       the `AbortSignal` ↔ `CancelScope` bridge in both directions
       (a signal cancels a scope; a scope hands `fetch` a signal).
    10. **WASI p3 as the primary parker** for the wasi target,
       retiring `poll_oneoff` — rides the components track's
       `Stream<T>`-across-the-boundary work.
  - Open type-system threads feeding this roadmap (from the #335
    review): `WithDefault<T>` (the honest type of a default-initialized
    generic field; de-boxes `Future.#value` and gives collections an
    honest empty-slot element type), `Awaited<R>` (folds `flatMap`
    into a flattening `then`), and in-place sealed variants (the
    general typestate answer: cases sharing one flat object, `match`
    binding copies, in-place transitions).
  - Also next: richer fetch (headers, streamed bodies — streams are
    designed in [streams.md](docs/design/streams.md) with the
    `zena:stream` rendezvous core implemented), the tokio-backed CLI,
    and the WASI P3 backend.
- **WASI Component Model & WIT Support**: Direct parser and bindings generator for WebAssembly Interface Type (`.wit`) files, enabling Zena programs to natively import/export WIT interfaces and compile into compliant WASI Component Model binaries.
  - The WIT parser and resolver are **done** (real WASI p2 and p3 both parse and
    resolve); what remains is everything that turns a parsed WIT into a running
    component. The near-term work is _language_ work, because a WIT import needs
    a Zena type for every construct it mentions — see
    [component-model.md](docs/design/component-model.md) Part 8:
    1. ~~`Result<T, E>` in the stdlib, plus `inline` tuples permitted in type
       aliases~~ **done** (45% of WASI p2 functions return a `result`)
    2. ~~Narrow integers `u8`/`u16`/`i8`/`i16`~~ **done** — types, promotion,
       casts and literal range checking
       ([arithmetic-conversions.md](docs/design/arithmetic-conversions.md)).
       Their packed `i8`/`i16` storage is deliberately left to step 3, which
       is the step that needs it.
    3. ~~`FixedArray<u8>` / `Array<u8>`, retiring the bespoke `ByteArray`
       primitive~~ **done** (`list<u8>` is half of all lists in p2): narrow
       array elements are stored packed, and `ByteArray` is now simply
       `array<u8>` rather than a type of its own. Packed _struct fields_
       are still outstanding.
    4. `Disposable`, giving WIT `resource` a shape (79% of p2 functions are
       resource methods). This is the first step of **Track O**, adopted
       2026-08-06 — see [ownership.md](docs/design/ownership.md). The layer 0
       protocol lives in `zena:ownership`; the rest of O0 (`resource class`,
       `Own<T>`/`Borrow<T>`/`Unmanaged<T>`, `disown`/`adopt`) follows there and
       is what freezes the generated-wrapper signatures.
    5. Only then: first-class WIT imports.
- **Tooling & DX**: A package manager, online playground, and enhanced VS Code integration.

### Phase 3: Post-Bootstrap Headline Features

Features that distinguish Zena from TypeScript:

- **Ownership & Affine Resources** (Track O): `Own<T>`/`Borrow<T>`/`Unmanaged<T>`, second-class borrows, a checker flow graph, and implicit drop — one release mechanism shared by WIT handles, WASI descriptors, linear-memory allocations and FFI pointers. Plan of record in [ownership.md](docs/design/ownership.md); phase 2 step 4 above is its first milestone.
- **Numeric Unit Types & Units of Measure**: Statically verified physical units and units of measure (e.g. preventing adding meters to feet at compile time).
- **SIMD**: the `v128` type, all 236 fixed-width vector instructions, and the
  signed and float shaped types (`I32x4`, `F32x4` and siblings) with
  elementwise operators are implemented — see [simd.md](docs/design/simd.md).
  What remains: unsigned shapes, lane comparisons, and reductions.
- **Decorators and Macros**: Metaprogramming capabilities for compile-time code generation and extension.
- **Contracts**: `requires` and `ensures` pre/post-conditions, enabling runtime assertion checks and future static verification using SMT solvers.
