# Cancellation

Status: **Proposal** (2026-08). Decides the questions earlier documents
deferred here: `finally` on abandonment ([async.md](async.md) §6,
[generators.md](generators.md) §6), generator disposal, and how
`Future.race` could cancel its losers. Builds on the checkpoint
machinery that already exists: every `await` resumes through a point
that can throw, and suspensions compose with `try`/`finally`/`using`.

The organizing decision: **cancellation is a third channel**, distinct
from both `Result` and thrown errors, and the platform enforces the
distinction rather than documenting it.

## Three channels

Zena's convention is `Result<T, E>` for outcomes addressed to the
caller and exceptions for failures that propagate by default. The test
that assigns an outcome to a channel is not how expected it is but who
is positioned to act on it:

- **`Result`** carries answers to the question the caller asked. A
  parse error is domain data; the immediate caller must consider it,
  so it belongs in the signature.
- **The error channel** carries failures no particular frame is
  expected to handle. Propagation is the default; `catch` is the
  opt-in.
- **Cancellation** is a directive from an ancestor scope: the answer
  is no longer wanted. No intermediate frame decides anything about
  it — the correct behavior of essentially every frame is to run its
  cleanup and keep unwinding. Only the scope that requested the
  cancellation treats it as an outcome, and there it is data (a task
  that completed as cancelled), which is the `Result`-shaped surface.

Threading cancellation through `Result` fails both halves of the test:
every async signature would carry the same `Cancelled` variant (a
marker on everything distinguishes nothing), every call site would
forward it unexamined, and an error arm invites recovery — code that
catches `Cancelled` and continues is defying the scope, not handling a
failure.

## Survey

Two design families dominate, split on where the cancel capability
lives.

**Tokens, threaded explicitly.** C#'s
`CancellationTokenSource`/`CancellationToken` is the ancestor of the
web's `AbortController`/`AbortSignal`: the source cancels, the token
observes, and every cooperating API takes the token as a parameter.
Composition is first-class (`CreateLinkedTokenSource`; the web
retrofitted `AbortSignal.any` much later), and .NET tasks carry a real
third completion state (`TaskStatus.Canceled`). Go's `context.Context`
is the same design with a derivation tree (`WithTimeout(parent)`) and
the heaviest ceremony — the context is by convention the first
parameter of every function. The family works, and its cost is
uniform: the capability is an object, so it appears in signatures
forever.

**Scopes, inherited structurally.** Trio's cancel scopes
([Timeouts and cancellation for humans](https://vorpus.org/blog/timeouts-and-cancellation-for-humans/))
made a timeout a block rather than a token: work spawned inside a
scope belongs to it, cancelling the scope cancels the work, and no
signature mentions any of it. Two Trio decisions carry over here:
delivery happens only at **checkpoints** (suspension points), as an
exception raised from the await, so running code is never interrupted
mid-state; and cancellation is **level-triggered** — a cancelled scope
stays cancelled, so any later checkpoint inside it also raises, which
closes the lost-wakeup bugs of deliver-once designs and is why a
`shield` escape hatch exists for cleanup that must still await. Kotlin
is the same design carried by an implicit `CoroutineContext` (the
compiler threads it), Swift by task-locals. The family answers "who
may cancel" structurally: the future is a value; the scope owns the
work; holding a future confers awaiting, not cancelling.

**Dropping, in Rust.** Lazy poll-driven futures make cancellation
non-existent as an API: the owner drops the future and `Drop` unwinds
what it held. It does not transfer: Zena futures are eager and
GC-shared, so abandonment is neither deterministic nor exclusive, and
async cleanup under drop is an open problem even in Rust.

**The swallowing problem** decides the channel question. Kotlin's
`CancellationException` is an ordinary exception, and
`catch (e: Exception)` swallowing it is the ecosystem's best-known
coroutine bug. Python shipped the same bug and then fixed it in the
type hierarchy: 3.8 re-parented `asyncio.CancelledError` from
`Exception` to `BaseException` specifically so `except Exception:`
cannot reach it
([bpo-32528](https://bugs.python.org/issue32528)); Trio's `Cancelled`
derived from `BaseException` from the start. The pattern is older than
async: Ruby's bare `rescue` catches `StandardError`, deliberately
missing `Interrupt` and `SystemExit`; Erlang separates `throw`,
`error` and `exit` into three catch-selectable classes at the language
level; glibc delivers `pthread_cancel` as a forced unwind that
`catch (...)` may observe but must rethrow, on pain of `terminate`.
Every one of these is a cancellation-like channel pushed out of reach
of the default catch form. Zena can enforce statically what they
enforce by hierarchy or convention.

## Scopes

`CancelScope` is a class in `zena:async` (the cancellable half of the
`TaskGroup` [concurrency.md](concurrency.md) sketches; the structured
half layers on below). A scope holds a level-triggered cancelled flag
and a parent link; cancelling a scope marks it and every descendant.

Frames bind to a scope at creation, with no signature or context
machinery. Zena owns its executor and runs to completion between
suspensions, so an ambient current scope is ordinary library state
maintained at exactly two control-transfer sites: the executor sets it
around each `task.run()` (to the running frame's scope), and a scope's
own entry sets it around running its body. Eager start does the
inheritance: an async call's ramp runs synchronously inside its
caller, so the ambient scope at frame creation is the caller's, and
the frame stores it in one field. After creation, nothing consults the
ambient — delivery is a frame-field test. Code that starts before any
scope exists belongs to the root scope, which cannot be cancelled.
The ambient should be a context record with the scope as its first
field rather than a lone variable: the signals library needs a
dependency-tracking cell propagated across suspensions the same way
(see "Integration with planned systems"), and one record at the same
two sites serves every such consumer.

Sync code never observes any of this. A compute loop that wants to
stop early polls explicitly — a `currentScope()` getter, or a context
parameter once [context-parameters.md](context-parameters.md) lands —
and its signature stays whatever it was.

## Delivery at checkpoints

A checkpoint is a suspension point: entering an `await` and resuming
from one. At each, the split pass emits a test of the frame's scope —
one field load and branch, at the sites where `step()` already loads
`$state` — and a cancelled scope raises on the cancellation channel.
Level-triggering means the test is stateless: every checkpoint in a
cancelled scope raises, however many already have.

Eager start is unchanged: a call runs synchronously to its first
await, so a task in a just-cancelled scope still executes its ramp
segment. That is the checkpoint contract, not a leak — code between
suspensions is never interrupted anywhere in this design.

## The cancellation exception tag

Zena exceptions are one wasm tag carrying an `Error` payload
([exceptions.md](exceptions.md)); user `try`/`catch` lowers against
that tag. Cancellation raises on a **second tag**. The consequences
are the point:

- `catch (e)` cannot observe a cancellation, so the Kotlin/Python
  swallowing bug is unrepresentable rather than discouraged. Zena's
  `catch` has no type filters, so a hierarchy-based fix (a
  `BaseException` analog) is not available; the tag is the enforcement
  that fits the language.
- `finally` and `using` regions must run their cleanup on
  cancellation unwinds, so finalizer regions lower to catch both tags.
  The region machinery already dispatches exits by code; the
  cancellation unwind is one more exit, replayed as a rethrow of its
  own tag.
- The failure-capture region of `step()` likewise distinguishes the
  tags: an error rejects the frame's future; a cancellation completes
  the frame as cancelled and continues the unwind to the frame's own
  awaiters via their checkpoints.

## The `cancel` clause

Observation without suppression, as a clause beside `catch`:

```zena
try {
  let rows = await db.query(q);
  return render(rows);
} cancel {
  metrics.increment('query-abandoned');
} catch (e) {
  return errorPage(e);
} finally {
  releaseBuffers();
}
```

The `cancel` block runs on a cancellation unwind, and the unwind then
continues unconditionally — the block is a cancellation-specific
sibling of `finally`, not of `catch`. The checker rejects `return`,
`break`, and `continue` out of it, which is Trio's re-raise discipline
and forced-unwind's rethrow-or-terminate made structural. `catch (e)`
sees failures only; `finally` runs on all three paths. The clause is
legal only in `async` (later `gen`) bodies, like `await`: cancellation
is delivered only at checkpoints, so in sync code the clause is
unreachable and is rejected rather than accepted as dead ceremony.

Conversion — catching a cancellation and producing a value in its
place — is deliberately inexpressible mid-chain. The place to decide
something about cancelled work is the scope boundary, where it is
data.

## Shields

Cleanup that must await after cancellation has arrived needs a region
where checkpoints do not deliver:

```zena
} finally {
  shielded {
    await connection.sendGoodbye();
  }
}
```

Inside `shielded`, the checkpoint test is suppressed (the frame's
scope test is masked for the region's extent); at the closing brace,
level-triggering resumes and the next checkpoint raises. Without it, a
`finally` that awaits during a cancellation unwind would raise at its
own first checkpoint — that is the level-triggered rule working as
intended, and the shield is its explicit, greppable exception. Kotlin
spells this `withContext(NonCancellable)`; Trio spells it
`shield=True`.

## Observation at the boundary

The scope that cancelled — or a supervisor joining a group — sees
completion as data: a task ends with a value, a failure, or
cancelled. Internally this is a fourth `FutureState`, cheap because
the state field is already slated to go private
([async-runtime-shape.md](async-runtime-shape.md)); externally it
surfaces on the scope API (`join` results, a group's outcomes), not on
`Future` — awaiting a cancelled task's future raises on the
cancellation channel like any other checkpoint, because awaiting is
being downstream of the work, and downstream is inside the directive's
blast radius.

## Work is cancellable, futures are not

A future is a value, possibly held by several consumers; cancelling
through it would let any holder destroy what another still needs —
the concern that shaped the web's controller/signal split, answered
here structurally. Nothing on `Future` cancels. `Future.race` over
already-started futures therefore keeps its current semantics: losers
are ignored, not cancelled, because race does not own them. The
loser-cancelling form is a scope API over computations race *does*
own — spawn the candidates in a child scope, cancel the scope when
the first settles. That form arrives with the structured half of
`TaskGroup`.

## Consumer interest

An opt-in layer over the previous section: work spawned on behalf of
several consumers, cancelled when the last of them disclaims interest.
It changes nothing in the mechanism — the last disclaim calls the
scope's cancel, and delivery, cleanup, and the boundary state are the
ones above — and it belongs in the stdlib next to the task object, in
the structured half of the sequencing.

Implicit interest — cancel when nobody holds the future — is not
available: WasmGC has no deterministic finalization, so the death of a
last reference is unobservable. Interest is therefore declared and
released explicitly, which is also the safer contract: disclaiming has
consequences for other consumers, and should be an act rather than a
garbage-collection artifact.

The encoding is an affine handle in the ownership regime —
`OwnedFuture<T>` as the working name (`Lease<T>` is the alternative;
the concept has no canonical name, and the nearest mechanisms are
Rust's `Shared`, whose clones are counted interests with last-drop
cancelling the inner future, and Rx's `refCount`):

- Spawning shared work yields an `OwnedFuture<T>`: awaitable directly,
  and a resource whose release — `using`, `dispose`, or move-checked
  consumption — decrements the interest count. Sharing is an explicit
  split that increments before the second handle exists. Move checking
  makes the discipline static: an affine handle cannot be aliased, so
  "two holders, one drops what the other needs" cannot be written —
  a holder either moved its handle away or split it, and splits are
  counted.
- The last release cancels the scope, deferred by one microtask so a
  same-turn handoff (release, then acquire) never observes a transient
  zero — Kotlin's `WhileSubscribed` grace period reduced to its
  minimal form under run-to-completion.
- `Future` itself stays inert and freely copyable: an `OwnedFuture`
  exposes the bare future for bystanders, holding it confers awaiting
  and nothing else, and if the interest holders all release, a
  bystander mid-await gets the cancellation raise at its checkpoint.
  Awaiting without holding interest is awaiting at the holders'
  pleasure, which is the legible version of the contract every
  shared-cancellation design needs somewhere.

Two boundary markers from the precedent record, both deliberate here:
handle lifetime is not interest (Swift's SE-0304 made dropping an
unstructured task handle not cancel it, and tokio's `JoinHandle`
detaches on drop — an `OwnedFuture` released by the ownership regime
is an explicit act, not a scope exit surprise), and interest never
lives on the shared value (TC39's cancelable-promises proposal
foundered on making every promise holder a threat to every other; the
inert `Future` is the same lesson enforced by type).

## Abandonment and generator disposal

The deferred questions resolve as one rule: **cleanup runs at
cancellation, and only cancellation is deterministic.**

- A pending frame that is merely dropped — every reference gone, no
  scope cancelled — runs no finalizers. WasmGC offers no deterministic
  finalization to hang them on, and pretending otherwise would make
  `finally` timing a garbage-collector artifact. Under the structured
  half of `TaskGroup` (a scope joins its children before exiting),
  abandonment without cancellation stops being an idiom: work is
  either awaited, or its scope ends and cancels it, and either way
  cleanup runs at a defined point.
- A half-consumed generator is disposed the same way: leaving a
  `for`-in early delivers the cancellation channel at the suspended
  `yield`, the generator's `finally`/`using` regions run, and the
  frame completes as cancelled. This is generators.md §6's disposal
  protocol, inherited rather than designed twice — the yield
  checkpoint uses the same tag, the same region lowering, and the same
  shield.

## Integration with planned systems

Three systems on the roadmap interact with this design. Each needs its
own document; this section records how the mechanisms here meet their
most likely directions, and what those directions ask of this design
now.

### Signals and async computeds

A signals library in the TC39 style tracks a computed's dependencies
through an ambient "currently computing" cell during evaluation. The
open question in TC39 — tracking across suspension points, where the
committee reached for AsyncContext and its tradeoffs — is the same
problem this design already solves for the cancel scope: an ambient
value that must follow a logical task across suspensions. The solution
transfers wholesale, and soundly, for the same reasons: Zena owns its
executor, execution runs to completion between suspensions, and a
frame captures its context at creation. The consequence for this
design is small and worth taking now: the two save/restore sites
should carry a **context record** rather than a lone scope variable,
so the cancel scope is the first field of a structure the signals
library later adds a tracking cell to — frame-propagated ambients as
one mechanism, not one mechanism per consumer.

An `AsyncComputed` in the
[signal-utils](https://github.com/proposal-signals/signal-utils#asynccomputed)
shape then needs no machinery of its own: each run of the async
computation executes in a fresh child scope, and a dependency change
cancels that scope and starts the next run. Supersession *is*
cancellation — the stale run dies at its next checkpoint
(level-triggered, so however it is shaped), its cleanup runs, and it
completes as cancelled rather than as an error, which is exactly the
distinction the computed's status signal wants to surface. The
unswallowable tag matters here specifically: user code inside a
computed cannot `catch (e)` its way past supersession and write a
stale value.

### A stdlib task object

A `Task` in the [Lit task](https://lit.dev/docs/data/task/) shape —
states for non-started, pending, complete, and error — extends
naturally with completed-as-cancelled, which is this design's boundary
state, observed exactly where such an object sits. The non-started
state also fits: async calls are eager, so a task object that owns a
not-yet-run computation holds a thunk, and running it is where the
task creates the child scope that a re-run or supersession later
cancels — the same shape as `AsyncComputed` minus the signal graph.
Nothing new is required of this design; the task object is a consumer
of the scope API and the boundary states, and `OwnedFuture` (see
"Consumer interest") is its natural neighbor — the same shelf of the
stdlib, task state on one object and counted interest on the other.

One naming collision to resolve before that lands: `zena:async`
already uses `Task` for the executor's queue protocol (the interface
suspended frames implement). The internal protocol should yield the
name.

### Streams and Component Model async

WASI 0.3 streams come with the Component Model's own cancellation
primitives: dropping a stream end signals the peer, and the canonical
ABI can cancel an in-flight subtask. The integration is a division of
labor rather than a translation layer:

- **Inside the component**, a pending stream read or write is a
  checkpoint like any other await; cancelling the scope raises the
  cancellation channel there.
- **Across the component boundary**, propagation is the cleanup this
  design already guarantees: stream ends and other WIT handles are
  resources released by `using`/ownership, those regions run on the
  cancellation unwind, and dropping the handle *is* the Component
  Model's cancel signal to the peer. The unwind's cleanup is the wire
  protocol; no separate signaling path exists to keep consistent.
- **In the runtime glue**, a cancelled scope with an in-flight async
  import can additionally issue the ABI's subtask cancel rather than
  merely abandoning the waitable, and a host cancelling one of the
  component's export tasks delivers into that task's root scope — the
  scope tree gives the host-facing cancel a place to land.

End-of-stream and backpressure stay off this channel: a read that
returns "closed" is an ordinary `Result`-shaped outcome addressed to
the caller, not a directive to unwind.

## Sequencing

1. **The tag.** A second exception tag; finalizer and `using` regions
   catch both; `step()`'s failure capture distinguishes them.
   Compiler-internal, no syntax.
2. **Scopes and delivery.** `CancelScope`, the two ambient
   save/restore sites, the frame's scope field, checkpoint tests,
   completed-as-cancelled at the boundary. Stdlib plus the split
   passes.
3. **Syntax.** The `cancel` clause and `shielded` block.
4. **The structured half.** `TaskGroup` joins its children, a child's
   failure cancels its siblings, and the loser-cancelling race and
   `OwnedFuture` arrive. This changes no mechanism above; it adds
   policy over the same scope object.
5. **Generator disposal** over the same machinery.

## Alternatives considered

- **Cancellation as an ordinary `Error`.** Rejected on the swallowing
  evidence above; with untyped `catch` the exposure is total.
- **Cancellation in `Result`.** Rejected: a universal variant nobody
  handles, and an error arm that invites exactly the recovery the
  directive forbids.
- **Token parameters.** Subsumed by scopes; the capability question
  they answer (source vs token) is answered structurally, without the
  permanent signature cost.
- **Drop-based cancellation.** Requires lazy, uniquely-owned futures;
  Zena's are eager and shared.
- **An interceptable `cancel` clause.** A suppressing clause reopens
  the swallowing hole with a nicer name; loosening a too-strict
  observer later is cheap, and the reverse is the Python 3.8
  migration.
