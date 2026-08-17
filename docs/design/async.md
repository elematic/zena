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
  union with at least one `Future` arm** (implemented): awaiting
  `T | Future<U> | Future<V>` yields `T | U | V`. Each future arm is
  distinguished at runtime by its own specialization and suspends on
  its future; the bare arms forward through one queue hop (preserving
  the always-async rule — the split pass parks the frame directly on
  the microtask queue via `scheduleTask`). `T | Future<T>` collapses
  to `T`, the common maybe-async shape. A multi-arm result may not mix
  a value primitive into a union — the language's ordinary union rule,
  so `A | Future<i32>` is rejected at the await. Monomorphization
  makes the shape checkable even for generic `T`: each instantiation
  lowers against concrete arms, and an instantiation where a bare arm
  substituted to a `Future` — `T = Future<U>` in `T | Future<T>`,
  where a value the source passes through would instead be awaited —
  is rejected loudly at lowering rather than guessed at. A
  `MaybeFuture<T>` alias for `T | Future<T>` can ship in the stdlib.
- `await` is valid only inside `async` bodies; a non-`async` closure
  nested in an async body cannot await (it is its own function), same
  as yield.
- `async` methods: `async load(): Future<Config> { … }` — modifier
  position, annotation required (methods do not infer).
- `await` is an ordinary expression: `f(a, await g(), b)` is legal.
  (The transform operates on the lowered CFG, so partially-evaluated
  operands live across the suspension are spilled like any other
  value — expression-position await costs nothing special.)
- **`await` inside `try` is supported** (§6). Generators picked the
  construction up, so `yield` inside `try` works too and both split
  passes share one implementation of it.

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

**The shipped surface differs from this sketch.** Waiters pull rather
than being pushed to, so there is one untyped `Task` protocol instead of
`Microtask`/`Resumable`/`FutureListener`; the settled-value reads AND
the settling operations are symbol-keyed and private to `zena:async`,
so a reference to a `Future` is read-only and "there is no other way
in" above is identity-enforced, not conventional; `onComplete` takes a
pair of callbacks rather than one tagged-tuple callback; the statics
are `of`/`failed`; and `runFuture(f)` is how synchronous code gets a
value out. [async-runtime-shape.md](async-runtime-shape.md) has the current
shape and the reasoning.

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
- **Combinators need no primitives.** `then`/`map`/`flatMap`/`all`/
  `race` are ordinary library code over `subscribe` — which is why
  v1's core surface is only `await`, `onComplete`, `resolve`/`fail`,
  and `Completer`. Non-async code that wants a callback uses
  `onComplete` directly.

  `all` and `race` are **implemented**, as `Future.all` and
  `Future.race` in `zena:async`, alongside `Future.of` and
  `Future.failed`. Two things came out differently from the sketch
  above:
  - **Each static declares its own type parameter.** A static is
    outside its class's generic scope, so the signature is
    `static all<A>(futures: Array<Future<A>>): Future<Array<A>>`, not
    one written in the class's `T`. They shipped as free functions
    first — `allOf`/`raceOf`/`futureOf`/`failedFuture` — because a
    generic static's body could reach no generic construct; fixed in
    `86e63185`.
  - **They are not async functions.** Awaiting the inputs in
    sequence would report a rejected input only after everything
    ahead of it settled, and would hang outright if one of those
    never settles — so both subscribe to every input at once and
    settle a `Completer`. This is a semantic difference, not a
    stylistic one, and it is what the tests pin.
  - **`Future.race` throws on an empty array** rather than returning a
    future. A race with no inputs can never settle, and an unsettled
    future surfaces much later as a deadlock report naming the
    awaiting code, so the mistake is refused where it was made.
    `Future.all` of nothing is an empty array, which is well-defined.

  `then`/`map`/`flatMap` are still open, and they are the harder
  half: each takes a user callback, so each needs a closure created
  inside generic code, which does not lower today (the restriction
  the `zena:async` header describes).

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

**Confirmed by the implementation, including the "no JSPI" call.**
The `setTimeout` shape is what the host uses — but not by "completing a
`Completer` through the Level-2 exports", because a host cannot call
into wasm until an export exists for it. So Level 1 needed one piece of
Level 2 after all: **`__zena_drain`**, which the compiler now
synthesizes whenever `zena:async` is reached.

With it the host clock never waits. `time.request_wake(ms)` schedules a
`setTimeout` and returns, `Clock.waitNs` reports `false`, and the drain
unwinds; when the timeout fires the host calls `__zena_drain` and the
drain resumes where it stopped. Nothing blocks, on any thread, with no
JSPI and no `SharedArrayBuffer` — which matters because Safari has
neither. (An earlier attempt did use JSPI; §"Non-goals" below was right
to rule it out, for the availability reason exactly.)

The conditionality stays confined to the clock, and is smaller than
expected: the timer queue, the `Parker`, and the meaning of
`drainMicrotasks()` — _run until nothing more can happen now_ — are
shared. WASI's clock can genuinely wait, so its drain never unwinds and
`main` still completes inside the call; a standalone
`wasmtime --invoke main` is unaffected.

**Superseded by A3 for the JS target.** "Timers are not special" below
replaced this driver: `time/host.zena` installs no `Clock` and registers
no `Parker`, and reaches `time/queue.zena` not at all. `Clock.waitNs`'s
`false` arm therefore has no implementation in the tree today — the only
`Clock` is `WasiClock`, which always returns `true`. The arm is kept
because it is what a p3 clock wants
([component-emission.md](component-emission.md)), not because anything
uses it now. See
[async-runtime-shape.md](async-runtime-shape.md), "Parking".

An async `main` on a non-blocking host does return before its timers
fire, exactly as this document predicted. It is therefore split into
`__zena_main_start` (run the body, park the future in a global) and
`__zena_main_result` (unwrap it once the pings have carried it to
completion). Two unconditional exports rather than one with an
`isCompleted` branch, and `main` itself is left untouched.
`@zena-lang/runtime`'s `run()` drives the pair and hands back a promise.

This inherits `setTimeout`'s web semantics on purpose, including the

> =4ms floor browsers impose once timeouts nest more than five deep.
> Each wake schedules a fresh timeout, so long chains of very short
> sleeps hit that floor; driving them from a single shared interval would
> avoid it if the granularity ever matters.

### Level 2 — external completions (JS host; later, custom Rust I/O)

Real I/O means the host completes futures. The shape, for a JS host
(`zena:js` is virtual and resolves only on the JS-hosted targets — the
protocol assumes an embedder with an event loop that calls back into
the module's exports; WASI p1 parks instead, and the component
target's futures ride the canonical ABI's waitables):

1. A host-async import takes a freshly minted handle; `zena:js`
   keeps the `Completer` behind it and hands Zena code the `Future`.
2. When the host operation finishes, the host calls
   `__zena_complete_<kind>(handle, value)` — or
   `__zena_complete_error(handle, message)` — and then `__zena_drain()`.

That is the whole protocol. **The handle the host was given already
names the future**, so nothing has to be looked up, asked back for, or
matched up: the completion says which operation finished and what it
produced, in one call.

**Implemented** on the JS host, and confirmed as designed. An earlier
revision of this document had the module _pull_ completions instead —
the host would park a result, ping the drain, and a `Parker` would ask
`next_ready()` which handle was ready and then for its payload. That was
built and then removed. It was chosen to avoid a compiler change (an
export has to be _reached_ by RTA, and nothing in Zena calls a
completion entry point), which is the wrong thing to optimise for in a
language's own stdlib: it put a ready-queue and a peek/consume protocol
in every host, to save rooting five functions.

#### The registry needs no type tag

`zena:js`'s registry is exactly `HashMap<i32, AnyCompleter>` —
ID to completer — and registration is a single generic function,
`pending<T>()`, for every payload type.

That works because erasing the payload and narrowing back is checkable
at runtime: a `Completer<String>` held as the erased base tests true for
`Completer<String>` and false for `Completer<i32>`, `Completer<f64>`,
and `Completer<SomeOtherClass>` alike. **The completer's own specialized
type is the tag**, checked by the `ref.cast` the language already emits,
so a host that completes a String handle with an i32 gets an error
naming both rather than a coercion.

One constraint fell out of building it and is worth recording, because
it shapes any other erase-and-narrow design: this only works through a
**base class**. Through an _interface_, `is` answers false and the cast
traps, for plain and generic classes alike — see BUGS.md. `AnyCompleter`
is a class for that reason and not by preference.

Only _delivery_ is per-payload-type, and unavoidably so: each entry
point is a wasm export whose signature has to name the payload. The set
is small and closed because it is bounded by what a host can hand to
wasm at all — nothing, an integer, a double, a string, or a reference
to one of its own objects (`__zena_complete_extern`, which registers as
`pending<anyref>()`; see host-interop.md, "Host object handles") — plus
one type-agnostic failure entry point, since rejecting needs no
payload.

#### Where the exports come from

`__zena_complete_*` are the exported `complete*` functions of
`zena:js`. Nothing inside a program references them — the host
calls them — so RTA would drop them. It roots the exports of that one
module the way it roots the entry point's, which makes the gate exact:
the unit exists only when the program imports the module, so a program
that does no host I/O links none of this and exports none of it. (The
runtime suite's host_async_test asserts both halves of that.)

#### Timers are not special

Once a host can settle a future by handle, `sleep` is an ordinary
host-async binding whose host side is `setTimeout`, and `zena:time`'s
host entry is six lines with no mechanism of its own. The `Clock`
interface, the timer queue and the `Parker` exist for the target that
can genuinely _block_: WASI's drain sorts pending deadlines itself and
sleeps on the nearest through `poll_oneoff`. `time/queue.zena` is
reachable only from `time/wasi.zena`, and Level 1 above describes the
WASI story.

The p3 clock (`time/p3.zena`) is a third `Clock` on the non-blocking
side: it arms `wait-for` and returns `false` like the JS entry, and the
host re-enters through the component's callback. That leaves exactly one
blocking driver, and it is **slated for removal**. Blocking is only
unobservable on `zena-cli` because timers are the one thing that can
settle a future there; a second source — p1 fd readiness, a host-async
binding, a process future — would be starved by a drain that sleeps on
the nearest deadline. What keeps it alive is that zena-cli calls `main`
once and never re-enters, so an async `main` there depends on the drain
running everything to completion before it returns.

Removing it is therefore not a stdlib change but a host one, and the
destination is the component target rather than a second driver over
zena-cli's private `env.*` surface: a p3 host already does the blocking
on its own threads and hands the guest a subtask, which is the thread
pool such a driver would otherwise reimplement. When that lands, the
`Parker`, the boolean on `Clock.waitNs` and `drainMicrotasks()`'s park
loop go together, and the drain becomes what it already is on JS — run
every runnable microtask, then return, as the host's re-entry point
rather than an API a program calls. See
[component-emission.md](./component-emission.md), open question 2.

On the **Rust CLI**, the same shape backed by tokio: host ops spawn onto
a runtime keyed by handle, and a `zena_park()` import blocks until a
completion is ready, after which the CLI calls the completion exports
back into the instance. This is the first point where zena-cli needs
custom code, and it is confined to the park import and whatever I/O ops
we choose to expose. It is _not_ needed for v1.

### The most generic host contract, stated once

> A host that can instantiate the module and call `main` runs every
> program whose futures complete internally. A host that can
> additionally call the completion exports and `__zena_drain()` when its
> own asynchronous work finishes, and optionally provide a "park until
> something completes" import, runs everything. Nothing else is assumed:
> no threads, no components, no JS, no JSPI, no wasmtime-specific
> machinery.

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
  Rich `Stream<T>`/`async gen` integration is designed in
  [streams.md](streams.md); the in-language rendezvous core is
  `zena:stream`.

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
- **A1 — transform. Implemented** (`codegen/ir/async.zena`), with two
  deviations from §3 and one gap, all deliberate:
  - **The frame is not the future; it holds one and implements
    `Resumable`.** Making a synthesized struct a true subclass of the
    specialized `Future<T>` means inheriting its vtable and layout
    through RTA — a lot of machinery to save one allocation. The
    observable semantics are identical.
  - **No resume-value slot.** The awaited future is an ordinary value
    live across the suspension, so the generator pass's existing
    liveness/spill machinery already gives it a frame field; the
    resumed segment reads the settled result back off it with
    `Future.valueOrThrow()`. That also makes failure propagation fall
    out for free — a rejected future resurfaces as a plain throw at the
    resume point, unwinds into the failure-capture region, and rejects
    the frame's own future, with no error slot to thread. This held
    up under await-in-try (§6), which needed no change to the error
    path at all — a per-frame error slot would have.
  - **`await` on a union is implemented** (§1), generalized past the
    original sketch: any union with future arms lowers, and
    `T | Future<U> | Future<V>` yields `T | U | V`. Future arms are
    `ref.test`ed in arm order and each suspends on its own future; the
    bare fall-through parks the frame directly on the microtask queue,
    so the hop costs no allocation (the frame is already the `Task`).
    `tests/language/execution/async/union_await*.zena` pin the hop's
    observability (the bare arm never completes synchronously), the
    per-arm values, a failed future arm, and generic instantiations.
  - **`Future<void>` now works** (§8 question 1), and it took no
    async-specific machinery: what was missing was the general rule
    that `void` is a ZERO-WIDTH type argument (language reference,
    "Generics"). Once a void-typed parameter takes no wasm slot,
    `complete(value: T)` at `T = void` specializes to the receiver
    alone, so the value type this pass reads falls out `null` — which
    is precisely the case `presplitAsyncValueVt` was already
    documented to handle.

  Level-0 execution tests cover eager start, multi-suspension bodies,
  suspension inside a loop, failure propagation, async methods and
  closures, and an async `main` driven by the synthesized export
  wrapper (§4).

- **A2 — timers. Implemented on both targets** (`zena:time`):
  `sleep(ms): Future<void>` and a monotonic clock, plus the drain/park
  arm. The WASI entry parks on `poll_oneoff` with a relative monotonic
  clock subscription; the host entry parks on two imports supplied by
  `@zena-lang/runtime`. Only the clock differs — `time/queue.zena`
  holds the timer queue and is shared.

  The host wait is a `setTimeout` that pings the module's
  `__zena_drain` export. The host clock never waits: it schedules and
  reports that it did not wait, so the drain unwinds and resumes when
  the ping arrives. Nothing blocks on any thread — no JSPI, no
  `SharedArrayBuffer` — which is what makes it work on a browser main
  thread, Safari included.

  An async `main` therefore returns before its timers fire on such a
  host, so it is split into `__zena_main_start` and
  `__zena_main_result`; `@zena-lang/runtime`'s `run()` drives the pair
  and returns a promise. `main` itself is unchanged, so WASI and
  `zena-cli` are untouched.

  Note that `sleep()` needed `Future<void>`, which is why that had to
  land first: a sleep carries no value, and faking it with
  `Future<i32>` would have put a meaningless zero in the stdlib
  permanently.

- **A3 — external completions on the JS host. Implemented**
  (`zena:js` + `@zena-lang/runtime`'s `asyncImports`), as
  designed — the host calls `__zena_complete_<kind>(handle, value)` and
  then `__zena_drain()`, and the handle it was given names the future.
  What the implementation settled:
  - **The registry needs no type tag** (§4). `HashMap<i32, AnyCompleter>`
    with one generic `pending<T>()`; the completer's own specialized type
    is the tag. It has to erase through a base class rather than an
    interface, because `is` and downcasts fail through an interface
    reference (BUGS.md) — that constraint is worth knowing before
    designing anything else that erases and narrows back.
  - **The completion exports are gated on importing the module**, by
    rooting `zena:js`'s exports in RTA. A program that does no
    host I/O links and exports none of it, which matters because the JS
    target is the size-sensitive one.
  - **Timers stopped being special** (§4). `zena:time`'s host entry is
    now an ordinary host-async binding over `setTimeout`; the `Clock`,
    the timer queue and the `Parker` are reachable only from the WASI
    entry, which is the target that can actually block. Two mechanisms
    became one.
  - **`run()` split into `run` / `runSync`.** `run()` always returns a
    promise, `runSync()` returns the value and throws if `main` is async
    rather than returning something that is only sometimes a promise.
    `main` itself cannot be the promise-returning export — a wasm export
    returns a wasm value, and handing back a JS promise needs JSPI,
    which this design does not depend on.
  - **Failures that happen while re-entering the module** — a mismatched
    payload, a completion for a spent handle, a throw out of resumed
    code — are recorded and surfaced through `run()`. They land on a
    stack no caller owns, so without that they would be unhandled
    rejections, and the program would go on to fail later with something
    less informative (a drain that never settles reports a deadlock).
  - **Fetch is implemented** — the "first real async I/O". `zena:fetch`
    is a virtual module for the JS-hosted targets, and its API follows
    the web's: `fetch(url): Future<Response>`, where `Response` carries
    `status`/`ok` and reads its body separately with
    `text(): Future<String>` — a 404 is a normal completion, and only
    "no response at all" (network error, CORS refusal, a host with no
    `fetch()`) fails the future, caught around the `await`. WASI and
    component builds fail at import resolution rather than linking an
    import no host provides (the component's HTTP is `wasi:http`, §4.1).
    The lowering is two host-async completions: `fetch` settles with a
    reference to the host's response object (`__zena_complete_extern`;
    host-interop.md, "Host object handles"), and `text()`'s completion
    reads its body. The body stays on the host until it is read, which
    is also the structure a streamed read needs — the stream stays
    there, and chunks would cross one completion at a time, once
    streams exist (post-v1, with headers riding along).
    `@zena-lang/runtime` supplies the `web.*` imports by default from
    the host's own `fetch()`, sharing the outstanding-work count
    `run()` waits on — which is what puts fetch in the playground with
    no playground changes at all. As on the web, a body reads once:
    a second `text()` throws rather than handing back an empty body.
    `Response` carries no release obligation: the reference lives in
    the WasmGC heap, so the engine's unified garbage collector frees
    the host object when the `Response` dies. (An earlier version kept
    the response on the host behind an `i32` id, which brought a
    registry and a `Disposable` implementation with it; the reference
    completion deleted both.)
- **Await-in-try — done** (§6), the fast-follow to A1: resuming
  re-enters each enclosing `try` region, so a failed await is caught
  by the handler the user wrote.
- **Combinators — `Future.all` and `Future.race` are done** (§2). Ordinary
  library code over `subscribe`, as designed: no primitive, no
  compiler support, nothing the executor knows about. `then`/`map`/
  `flatMap` wait on closures-in-generic-code.
- **Post-v1** (each its own design conversation): cancellation +
  structured concurrency — designed in
  [cancellation.md](cancellation.md) (scopes, checkpoint delivery on
  a second exception tag, the `cancel` clause and `shielded` block,
  and the loser-cancelling race as a TaskGroup API) — Rust-CLI tokio
  I/O, WASI P3 backend, streams/`async gen`.

## 6. Await-in-try (implemented)

Why it was hard: a suspension edge that leaves a `try_br` region and
re-enters it on resume requires reconstructing exception-region
nesting around resumed control flow — the region surgery ir.md §15
flags. Why it was urgent anyway: `try { await f(); } catch` is normal
async code in a way that yield-in-try never was for generators.

Failing to do it is **silent**, which is what made the restriction
worth keeping until it was fixed: without the construction below the
code still compiles and the success path still works, but the region
quietly shrinks to exclude the resumed segment — so the dispatcher
enters it unprotected, and a failure surfacing at `valueOrThrow()`
sails straight past the handler the user wrote and rejects the
function's own future instead.

The construction: the dispatcher lives outside every user region, so
it cannot branch at a dispatch target directly. Instead, dispatching
**re-enters** each enclosing region through a fresh `try_br` whose
catch is that region's own handler, innermost last, so the segment it
heads runs at the same protection depth the source put it at. Nesting
composes — one fresh `try_br` per enclosing region per dispatch target
— and every region is still entered normally through its own `try_br`,
so regions stay properly nested and the CFG reducible.

This covers **every dispatch target, not just the resume blocks**, and
the difference is not cosmetic. `rerouteEdges` sends every edge into a
dispatch target through the dispatcher, and a loop whose body suspends
makes the loop _header_ a dispatch target — so the loop's entry edge
and its backedge both leave the region. Re-entry at the resume blocks
alone protects the stretch after each `await`, which is what that
resume block dominates, and leaves the stretch from the header down to
the `await` unprotected on every iteration. A `throw` there escapes
the user's handler; a `throw` after the `await` does not, which is
exactly the sort of half-working that hides in a test suite. (It hid
in this one: the original await-in-try tests exercised a loop, but
awaited a future that never fails and threw nothing ahead of the
suspension.)

This is a simplification of the known-good construction C# and Kotlin
use (and of what this section originally planned): those thread the
resume pc through the region's ORIGINAL `try_br` into a small _inner_
dispatcher inside the region. Re-entering through fresh `try_br`s
needs no inner dispatcher, no pc threading across a region edge, and
no splitting of the block holding the original `try_br` — and it
builds the same region, because a region's extent is the dominator
subtree of its body target and a dispatch target inside a try body
dominates precisely the part of that body it heads.

`finally` semantics on _abandonment_ (a pending try's future is
dropped) are decided in [cancellation.md](cancellation.md) — the
one-place answer promised in generators.md §6, which generators then
inherit: cleanup runs at cancellation, and only cancellation is
deterministic. `await` inside a `finally`-protected region — the body, and
the finalizer itself — lowers: the exit-dispatch state (the exit code,
the parked result, the saved payload) rides mutable variables, and the
split passes move every variable into the frame
(`rewriteVarsToFrame`), since a wasm local does not survive a
suspension. The same lifting covers `using` followed by awaits, which
is the async-resource pattern. `tests/language/execution/async/
await_in_try_finally.zena` and `await_in_using.zena` pin every exit
path — normal, failure at the resume point, `return`, `break`.

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
   _RESOLVED_: `Future<void>`, no special case. It compiles and runs
   (`tests/language/execution/async/future_void.zena`) as an ordinary
   instantiation, so a distinct spelling would buy only brevity and
   would cost a second way to write the same type. The blocker was
   never async: it was that `void` could not be a type argument at
   all. That is now the general zero-width rule — a `void` value takes
   no wasm slot, so a `void` parameter has none either and callers
   omit its argument (`c.complete()`). `new Completer<void>()` works
   in ordinary non-async code for the same reason.
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
6. **Can the `Future` be elided when it is never observed?** Raised
   because reducing promise allocation is a large, well-trodden win in
   JS VMs, and nothing in this document had addressed it.

   Where it stands today: §3 planned for the frame to _be_ its
   `Future<T>` — one allocation — and A1 deliberately traded that away,
   so the frame _holds_ one. Counting what an `await` of an async call
   actually costs now:
   1. the frame struct,
   2. its `Future<T>`,
   3. `Future`'s two eagerly-constructed `Array` fields (`#listeners`,
      `#resumables`), each an object plus backing storage,
   4. a `Box<T>` for the settled value (`#value: Box<T> | null`),
   5. a `ResumeDelivery` (or `ValueDelivery`) microtask per settle.

   Six to eight objects where the design said one. Most of that is not
   the frame/future split at all — it is `Future`'s own shape, and the
   cheapest wins are there and need no analysis: the two arrays are
   empty in the overwhelmingly common case of a single waiter and could
   start null or inline the first entry, and `Box<T>` exists only
   because a `T | null` field cannot represent "resolved with null".

   The interesting case is narrower and more tractable than general
   escape analysis. In `let x = await g();` where `g` is async, the
   future is awaited exactly once, by a statically known frame, and
   never stored — so it is pure indirection: `g`'s frame could complete
   into the caller's frame directly. That is the moral equivalent of
   V8's promise-resolve fast path, and it is a targeted peephole on a
   shape the split pass already recognises (it knows both frames), not
   the whole-program escape analysis
   [optimizations.md](optimizations.md) files under future work. Note
   that under WASM GC there is no stack allocation to fall back on:
   scalar replacement — deleting the object and promoting its fields —
   is the only mechanism, as that document says.

   Two things make it _not_ a free win, and are why this is a question
   rather than a plan. The always-async rule (§1.1) means the queue hop
   must survive even if the future does not, so the peephole may remove
   the allocation but not the suspension. And eager start means the
   callee's frame is live before the caller decides to await it, so
   "awaited exactly once, immediately" has to be proven, not assumed —
   `let a = g(); …; await a;` is the same source shape with a different
   answer. Wants measurement on a real async workload before any of it
   is built; there is none yet.

   _Taken up in_ [async-runtime-shape.md](async-runtime-shape.md), which
   answers the cheap half outright — the two arrays, the `Box`, and the
   per-settle delivery objects all fall out of one change to the
   notification protocol — and sharpens the hedge above: eliding the
   queue hop is observable whenever anything else is queued, so the rule
   is unconditionally _elide the allocation, keep the hop_. That makes
   the remaining work a multi-value ramp return rather than an escape
   analysis.
