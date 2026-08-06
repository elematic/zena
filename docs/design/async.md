# Async v1: `async`/`await`, `Future<T>`, and the host contract

Status: **Proposal** (2026-08). The focused v1 design for asynchronous
functions, building directly on the generator split pass
([generators.md](generators.md) §5, implemented). Supersedes the v1
portions of [concurrency.md](concurrency.md), which remains the wider
exploration (workers, channels, shared memory, WASI P3 threading);
its stackless-only decision and its JS-style semantics survey carry
over unchanged.

The organizing claim: **async needs no new compilation machinery and
almost no host machinery.** The split pass already turns suspendable
bodies into frame-based state machines; async adds a resume-value
slot it was designed to accept (generators.md §5.3). The event loop
is a plain Zena library, not a host feature — so async programs run
on today's unmodified hosts (wasmtime via zena-cli, Node, browsers),
and the _optional_ host contract is two hooks.

## 1. Surface language and typing

An async function is a function expression or method with the `async`
modifier (`async`/`await` have been reserved words since generators
G0). `await e` is a unary expression valid only in the immediately
enclosing `async` body.

```zena
let fetchUser = async (id: i32): Future<User> => {
  let resp = await http.get(userUrl(id));
  return parseUser(resp.body);
};

let show = async (id: i32): Future<void> => {
  let user = await fetchUser(id);
  console.log(user.name);
};
```

Typing follows the rule settled for generators (generators.md §2.2,
§10.2): **the declared return type is the call expression's type** —
`Future<T>` — and the annotation must be exactly that. `return e;`
inside the body checks `e` against `T`. With no annotation, `T` is
inferred from the returns (same machinery as ordinary return-type
inference) and the function types as `Future<inferred>`. `Future`
resolves from the prelude without an import, like `Iterator`.

Checker rules:

- `await e` — `e` must be a `Future<T>` (expression type `T`) **or a
  union `T | Future<T>`** (expression type `T`): the common
  maybe-async shape awaits the future arm and forwards a bare value
  through one queue hop (preserving the always-async rule). The union
  form is only legal where the checker can prove the arms are
  runtime-distinguishable — `T` must not itself be (or be able to be)
  a `Future`. Monomorphization makes this checkable even for generic
  `T`: each instantiation sees a concrete `T`, and an instantiation
  where `T = Future<U>` is rejected at the use site, loudly, rather
  than guessed at (`await` on `Future<U> | Future<Future<U>>` is
  genuinely ambiguous and stays an error). A `MaybeFuture<T>` alias
  for `T | Future<T>` can ship in the stdlib.
- `await` is valid only inside `async` bodies; a non-`async` closure
  nested in an async body cannot await (it is its own function), same
  as yield.
- `async` methods: `async load(): Future<Config> { … }` — modifier
  position, annotation required (methods do not infer).
- `await` is an ordinary expression: `f(a, await g(), b)` is legal.
  (The transform operates on the lowered CFG, so partially-evaluated
  operands live across the suspension are spilled like any other
  value — expression-position await costs nothing special.)
- **v1 restriction: `await` may not appear inside `try`** — same
  restriction and same reason as yield-in-try (generators.md §6),
  BUT with a difference in urgency: try/catch around awaits is
  bread-and-butter async code, so unlike generators this restriction
  gets a concrete lifting plan (§6) and is the top fast-follow, not
  an indefinite deferral.

### 1.1 Semantics: eager start, run-to-completion

Calling an async function runs the body **synchronously until the
first `await`** (JS semantics), then returns the pending `Future<T>`.
This is the opposite of generators (lazy) and of Rust (poll-driven),
and it is deliberate:

- It matches the muscle memory of every TS developer.
- It makes "start several, then await them" natural without a spawn
  primitive: `let a = fetchA(); let b = fetchB(); await a; await b;`
  runs both requests concurrently.
- Between suspension points, execution is run-to-completion on a
  single logical thread: no data races, no preemption — exactly the
  JS model, and the model concurrency.md already chose.

Continuations resume from a FIFO microtask queue (deterministic
ordering — this matters for testing, §5). A future completes exactly
once; awaiting an already-completed future still yields to the queue
first (no synchronous re-entry surprises — JS's "always async" rule).

## 2. `Future<T>` and the executor are ordinary library code

`Future<T>` is a plain generic class; the executor is a FIFO queue of
ready continuations. **Neither uses `async`/`gen` syntax, so both can
live in the stdlib today** — the bootstrap compiler can compile them
(the corollary in generators.md §1 blocks only the _syntax_, not the
runtime types). Only user code containing `async`/`await` is
self-hosted-only.

```zena
// stdlib zena:async (sketch)
enum FutureState { Pending, Resolved, Rejected }

class Future<T> {
  // state, value, error, continuation list (frames to resume)
  isCompleted: boolean { get }
  /** Low-level subscription: cb runs on the microtask queue with the
   * settled result. This is what frames register through, and the
   * bridge for non-async code. */
  onComplete(cb: (value: inline (true, T) | inline (false, _), error: Error | null) => void): void;
  static resolve<T>(value: T): Future<T>;
  static fail<T>(error: Error): Future<T>;
}

class Completer<T> {      // the host/manual bridge
  future: Future<T>;
  complete(value: T): void;
  /** Chaining/adoption: when `f` settles, this future settles with
   * the same value or failure. One level, statically typed — the
   * future's own T is delivered, exactly like awaiting it. */
  completeWith(f: Future<T>): void;
  fail(error: Error): void;
}

// Module-level executor: FIFO microtask queue + drain loop.
// drain(): run continuations until the queue is empty.
```

`Completer<T>` is the boundary object: everything external — host
I/O, timers, test harnesses — completes futures through it. There is
no other way in, which is what makes the host contract small (§4).

Two API stances, decided here:

- **Chaining yes, silent flattening no.** Completing with a future is
  a first-class operation — `completeWith(f)` adopts `f`'s eventual
  value or failure, so the completer's `Future<T>` delivers `T`
  either way, exactly like awaiting. What Zena does _not_ do is JS's
  implicit move: there is no single entry point that runtime-tests
  "value or thenable?" and recursively unwraps — that behavior is
  what forces TS into the `Awaited<T>` recursion and makes
  `Promise<Promise<T>>` unrepresentable. Here the two operations have
  two names, both statically exact (a union-typed
  `complete(T | Future<T>)` would be runtime-ambiguous exactly when
  `T` is itself a future; separate methods work for every
  instantiation), chaining is one level (the type says which level),
  and `Future<Future<T>>` stays a real type with `await` as its
  unwrap. The same adoption applies in async bodies:
  `return e` accepts `T | Future<T>` under the same
  distinguishability rule as `await`'s union — `return fetchUser(id);`
  without an `await` forwards the future's result (and skips a
  suspension state doing it).
- **Combinators are post-v1 and need no primitives.** `then`/`map`/
  `flatMap`/`all`/`race` are ordinary async functions once the syntax
  exists (`Future.all` is a ten-line async fn) — which is why v1's
  public surface is only `await`, `onComplete`, `resolve`/`fail`, and
  `Completer`. Non-async code that wants a callback uses
  `onComplete` directly.

## 3. Compilation: the split pass grows a resume-value slot

Exactly the extension generators.md §5.3 reserved. The suspension
descriptor gains a resume value:

```
yield  %v -> b_r          // generator: value out, nothing in
await  %f -> b_r(%x: T)   // async: future out, awaited result in
```

Per async function, the split pass synthesizes a frame class that
**is** its `Future<T>` (one allocation; the frame extends/embeds the
future state), plus a `step()` function:

- **The ramp** allocates the frame and — eager start — immediately
  calls `step()` for the first segment, then returns the frame as
  `Future<T>`.
- **`step()`** is the same dispatcher-loop state machine as a
  generator's `next()`, with three differences:
  1. Resume values: suspended states read the awaited result from a
     `$resume` frame field (written by the completion path) instead
     of resume blocks taking no input. This is the block-parameter
     the split pass already knows how to demote to a field.
  2. At `await %f`: if `%f` is already completed, push this frame on
     the microtask queue and return (the always-async rule); else
     register the frame (+ resume state) as `%f`'s continuation and
     return. Either way the suspension is a plain `return` from
     `step()` — same shape as a generator's `(true, v)` return.
  3. At `return %v` / falloff: complete the frame's own future,
     which moves its registered continuations onto the queue.
- **Failure capture**: `step()`'s whole state machine is wrapped in
  one `try_br` region whose catch stores the error and moves the
  future to `Rejected` (then completes dependents with the failure).
  No suspension edge crosses the region — suspends _return_ out of
  it, which is structurally legal — so this does not hit the
  region-surgery problem that user-level try does (§6). This also
  replaces the generator RUNNING-trap discussion for async: a frame
  that throws is a _failed future_, observed at the await sites, and
  no synthesized Error construction is needed — we store the caught
  ref (§7).

Everything else — liveness, spilling, the reducible dispatcher-loop
construction, the interning fix, frame field naming — is shared with
generators verbatim. Generator limits carry over and lift together
(closures already work; specialized generics already work).

## 4. The host contract (and how we test without one)

The question that shapes v1: what does a host have to provide? The
answer is a ladder, and **rung zero is empty**.

### Level 0 — no host support at all (v1 target, tests run here)

The executor lives inside the module. An async `main` runs eagerly,
and the exported `main` drains the microtask queue until it is empty
before returning. Programs whose futures all complete _internally_ —
pure computation, `Completer`s completed by other tasks, test
choreography — run to completion on **any** wasm host that can call
one export. That includes today's zena-cli/wasmtime with **zero Rust
changes**, and answers the "delegate the event loop to wasmtime"
question: we don't. Core-module wasmtime has no event loop to
delegate to; the loop is Zena code inside the module, and wasmtime
just calls `main` once.

If the queue empties while some future is still pending and no
external completion source exists, that is a deadlock: the drain loop
**throws an ordinary `Error`** naming the condition. (Unlike the
generator poison state, there is no size argument against it here —
any async program already links the `Future` machinery, and the
executor is ordinary library code that can construct an Error.)

Testing story (this is the point): the executor is deterministic
(FIFO, single-threaded), so portable execution tests — with
`// @skip: bootstrap`, like all generator tests — cover interleaving,
ordering, eager-start observability, failure propagation, and
already-completed awaits using nothing but `Completer`s, running
under plain `wasmtime --invoke main` today.

### Level 1 — timers, no custom host code (WASI p1 already suffices)

`sleep(ms)`/timeouts need a clock and a way to park. WASI preview 1
already provides both: `clock_time_get` and `poll_oneoff` with a
clock subscription. The drain loop grows one arm: when the queue is
empty but timers are pending, `poll_oneoff` until the next deadline,
then complete the timer's `Completer` and keep draining. Still no
zena-cli changes — this is stdlib code over existing WASI imports.

On a JS host, timers need neither a clock arm nor a park: `sleep` is
`setTimeout` completing a `Completer` through the Level-2 exports,
and the JS event loop is the park. So yes, the timer module is
**target-conditional stdlib** — but the conditionality is confined to
that one module (park-on-`poll_oneoff` vs setTimeout-wrapper), rides
the target distinction the compiler already has (`--target wasi` vs
`--target host`), and the `Future`/`Completer`/executor core is
target-independent.

### Level 2 — external completions (JS host; later, custom Rust I/O)

Real I/O means the host completes futures. The generic shape, on any
host:

1. The module exports `__zena_complete(handle: i32, …payload)` and
   `__zena_drain()`.
2. A host-async import returns a handle immediately; Zena wraps it in
   a `Completer` keyed by handle.
3. When the host operation finishes, the host calls
   `__zena_complete(handle, result)` then `__zena_drain()`.

On a **JS host** this is a five-line wrapper per import — the JS
event loop is the parking mechanism, `promise.then(v => {
complete(handle, v); drain(); })` is the completion path, and an
async `main` simply returns with work pending while the embedder
keeps the instance alive. **No JSPI required.** Our runtime library
gains one small helper for wrapping Promise-returning imports.

On the **Rust CLI**, the same shape backed by tokio: host ops spawn
onto a runtime keyed by handle, and a `zena_park()` import blocks
until a completion is ready (then the CLI calls `__zena_complete` /
`__zena_drain` back into the instance). This is the first point where
zena-cli needs custom code, and it is confined to: one park import,
the completion trampoline, and whatever I/O ops we choose to expose.
It is _not_ needed for v1.

### The most generic host contract, stated once

> A host that can instantiate the module and call `main` runs every
> program whose futures complete internally. A host that can
> additionally (a) call two exports (`__zena_complete`,
> `__zena_drain`) when its own asynchronous work finishes and (b)
> optionally provide a "park until something completes" import, runs
> everything. Nothing else is assumed: no threads, no components, no
> JS, no JSPI, no wasmtime-specific machinery.

### Non-goals and future backends

- **JSPI** is deliberately _not_ the v1 JS driver. Portable state
  machines make whole-stack suspension unnecessary, JSPI availability
  is still uneven, and mixing it with our own executor buys two
  schedulers. It stays interesting later for one thing only:
  sync-looking FFI over promise-returning imports in JS-only builds
  (concurrency.md's survey stands). Revisit post-v1 if that need
  materializes.
- **WASI P3 / component-model async**: the callback ABI (export
  returns EXIT/YIELD/WAIT + companion callback) maps almost 1:1 onto
  `step()`/drain — the design was chosen with this in mind — but it
  arrives as a Level-2-style backend when the tooling stabilizes,
  not as a v1 dependency. §4.1 details the mapping, because it is the
  path to the first real Zena deployment target.

### 4.1 WASI 0.3 http/fs, and serving a website from Zena

WASI 0.3's headline change is exactly this design's shape: `http`,
`filesystem`, and `sockets` become **async component-model
functions**, with `stream<u8>`/`future<T>` as canonical-ABI built-ins
replacing 0.2's resource streams + `poll`. `wasi:http@0.3`'s handler
is an async export (`handle: func(request) -> result<response,
error-code>` under async lifting); body I/O is `stream<u8>`. And this
is not hypothetical tooling: **wasmtime 46 (in our dev shell) ships
`wasmtime serve` with `-S p3` and `-W component-model-async`.**

The mapping onto this design, piece by piece:

- **Async export (`handle`)**: async lifting with callback. The
  first call runs the ramp + first `step()` segment; suspending
  returns WAIT with a waitable set; wasmtime invokes the companion
  callback on progress, which is `drain()` + a status code;
  `task.return` delivers the response — i.e., completes the handler's
  `Future<Response>`. Each in-flight request is its own component
  task driving its own frame graph — run-to-completion per task, the
  same model as everywhere else in this design.
- **Async imports (outbound http, fs reads)**: a lowered async call
  either completes immediately or returns BLOCKED with a waitable —
  which is precisely a `Completer` keyed by the waitable, parked on
  the task's waitable set. Wasmtime is the Level-2 driver; the
  "park" hook is the WAIT status itself.
- **Streams**: request/response bodies arrive as `stream<u8>`; a
  minimal Zena wrapper with `async read(buf): Future<i32>` (backed by
  `stream.read` + waitable completion) suffices for a web server.
  Rich `Stream<T>`/`async gen` integration stays post-v1.

**The dependency that is NOT async**: Zena emits core modules today,
and `wasmtime serve` consumes _components_ — WIT-typed exports plus
canonical-ABI lifting. Componentization is the WIT-first-class
compiler track (wit-parser + bindings), and it gates 0.2 and 0.3
serving equally. That ordering suggests a two-step path to "the Zena
website served by a Zena server":

- **W1 — static server on `wasi:http@0.2`, no async at all.** The
  0.2 proxy world is synchronous (resource streams + poll), so a
  static-asset server — site baked into data segments, no filesystem
  imports — needs only componentization + 0.2 http bindings, and
  runs under stable `wasmtime serve` today. This ships the website
  on a Zena server before async v1 even lands, and proves out the
  component pipeline.
- **W2 — upgrade to `wasi:http@0.3`** once A0–A1 (async front end +
  transform) and the callback-ABI backend exist: async `handle`,
  concurrent request tasks, streamed bodies, async fs if we outgrow
  baked assets. Same server code, modulo the handler becoming
  `async`.

## 5. Milestones

- **A0 — front end.** Parse `async` functions/methods and `await`
  expressions (keywords already reserved); checker rules from §1;
  `Future<T>`/`Completer<T>`/executor in the stdlib (ordinary code,
  both compilers compile it); portable syntax/semantics tests with
  `@skip: bootstrap`.
- **A1 — transform.** `await` suspension terminator with the
  resume-value slot; async mode in the split pass (frame-is-future,
  eager ramp, step(), failure-capture region); execution tests at
  Level 0 (Completers, ordering, failure propagation, deadlock trap).
- **A2 — timers.** `sleep`/timeout over WASI p1 `poll_oneoff`; the
  drain/park arm; JS-host parking via the event loop.
- **A3 — external completions on the JS host.** The
  `__zena_complete`/`__zena_drain` exports + runtime-library Promise
  wrapper; first real async I/O (fetch on the web playground).
- **Post-v1** (each its own design conversation): await-in-try (§6),
  cancellation + structured concurrency (TaskGroup, from
  concurrency.md), combinators (`Future.all`/`race`), Rust-CLI tokio
  I/O, WASI P3 backend, streams/`async gen`.

## 6. Await-in-try: the lifting plan (fast-follow, not v1)

Why it is hard: a suspension edge that leaves a `try_br` region and
re-enters it on resume requires reconstructing exception-region
nesting around resumed control flow — the region surgery ir.md §15
flags. Why it is urgent anyway: `try { await f(); } catch` is normal
async code in a way that yield-in-try never was for generators.

The known-good construction (C#/Kotlin do the equivalent): resume
points inside a try region are not entered directly from the
function-level dispatcher; instead the dispatcher enters the region
through its `try_br` and a small _inner_ dispatcher inside the region
routes to the right resume block. Nesting composes (one inner
dispatcher per suspension-containing region). This keeps regions
properly nested and the CFG reducible at the cost of one extra
dispatch hop per region level on resume. `finally` semantics on
_abandonment_ (a pending try's future is dropped) remain coupled to
cancellation and are decided there — same one-place answer promised
in generators.md §6, which generators then inherit.

## 7. Errors: plain `Error`, everywhere

**Decision: async v1 uses `Error` as-is.** Failed futures store the
caught `Error` ref; the deadlock check, double-completion of a
`Completer`, and unhandled rejections construct and throw ordinary
`Error`s with messages, from ordinary library code. No part of this
design depends on making errors cheaper.

(Decoupling `Error` construction from string machinery — e.g. a
tag-plus-lazy-message core, motivating the generator poison state
becoming a throw — remains possible future work, and nothing here
gets in its way. It is deliberately _not_ a prerequisite or a design
input for async v1.)

## 8. Open questions

1. **`Future<void>`**: does `async (): Future<void>` want a distinct
   spelling (`async (): void`?) or is `Future<void>` fine? (Leaning:
   `Future<void>`, no special case — consistency over brevity.)
2. **Async main**: is `export async function main(): Future<i32>` the
   blessed form, with the export wrapper doing start+drain? (Leaning:
   yes; sync main stays valid.)
3. **Unhandled rejections**: a future that fails with no awaiter —
   trap at drain end (loud, v1) vs host-reportable hook (later)?
4. **Queue fairness**: strict FIFO microtasks only in v1; do timers
   get a macrotask-style separate queue (JS-alike) or share FIFO?
   (Leaning: share, revisit with real I/O.)
5. **`async gen`**: explicitly post-v1 (needs both resume values and
   the iterator protocol; design after streams).
