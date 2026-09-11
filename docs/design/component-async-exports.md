# Async exports: the service world

- **Status**: Draft
- **Date**: 2026-09-10
- **Depends on**: the WIT interop stack through futures and streams
  (component-emission.md C6), the async-import driver
  (`zena:component-async`)

`wasi:http@0.3.0`'s service world is one export:

```wit
world service {
  import client;
  export handler;   // handle: async func(request) -> result<response, error-code>
}
```

The host calls `handle` zero or more times, possibly concurrently.
Everything the import side built — marshaling, resources, streams,
futures, the driver — is one-directional today: the program is the
caller, the host the callee, and there is exactly one guest task, the
lifted entry. Exporting an async function inverts the direction and
multiplies the tasks, and those are separate problems.

## Part 1: The marshaling mirror

An exported `handle` receives what an imported `send` passes, so every
conversion runs in the opposite direction:

| position           | import side (built)              | export side (needed)            |
| ------------------ | -------------------------------- | ------------------------------- |
| parameter          | lower (Zena value → wire)        | lift (wire → Zena value)        |
| result             | lift from the return area        | lower through `task.return`     |
| resource parameter | pass handle, mark moved          | wrap received handle            |
| stream/future      | `lowerByteStream`/`lowerFutureK` | `liftByteStream`/`liftFutureK`  |

None of that is new machinery — `wit-module-synth` already generates
both directions for values, and the pumps and future helpers are
direction-agnostic (a lift helper does not care whether the end
arrived from an import's result or an export's parameter). What is new
is *where the generated code lives*. Import wrappers are synthesized
source in a WIT-typed module the program imports. An export wrapper
wraps the *program's own* function, which no stdlib or synthesized
module can name — the same reason the entry is built in
`component-adapters` as IR.

Building rich marshaling in `IrBuilder` would rebuild everything the
synthesizer says in Zena, badly. The alternative that keeps the
generated code as source is a *wrapper module* the compiler writes and
loads beside the entry: source, like a WIT-typed module, importing the
program's function and any types module it needs, whose exported
wrapper is what gets lifted. The host-facing wrapper is then ordinary
Zena: lift the request handle into `Request`, call the program's
`handle`, await it, lower the `Outcome` through `task.return`.

**The mechanism is in place**, with the async entry as its first user
(`lib/component-entry.zena`). `Compiler.compile` decides from the
entry's syntax alone whether a wrapper is needed, writes its source,
and hands it to the loader with the import of the entry *pinned* to
the entry's already-loaded path (`LibraryLoader.loadSynthesized`), so
the wrapper joins the same compile and the entry is never loaded twice
under two spellings of its path. Codegen finds the wrapper's function
by name in the wrapper unit (`WasmModule.getUnitFunc`), the way it
finds driver functions; the wrapper is not the entry and exports
nothing at the component level itself. The entry adapter calls the
wrapper's `run` in place of `main`, and the shape gives the lifted
entry the result type the wrapper returns through.

The entry's case: `export async function main(): Future<u32>`. The
lifted entry is `async func() -> u32`, and the value cannot come back
from the call that started main. The wrapper declares
`task.return` at `u32` under its own name (`task.return#main`, beside
the driver's bare one, disambiguated the way the per-type `future.*`
builtins are) and calls the driver's `finishTask(main(), ret)`, which
parks the typed return on the task until main's future settles and
calls it from the task's own entry — see "One task per call". The
result types the wrapper can name without importing anything are the
flat scalars; a richer result waits on the types module import below.

`task.return` with a rich result is the remaining half: a
`result<response, error-code>` result means the canon entry's type is
that result — the same component-type aliasing the `future.*` builtins
use (`future:<iface>#<payload>` generalizes to `return:<iface>#<type>`)
— and the call site passes the flattened value or spills it, per the
same rules as any lowering. Its `memory` option must equal the lift's
(the canonical ABI's `canon_task_return` traps on a mismatch), so a
rich export's lift and its return carry memory together.

## Part 2: One task per call

The driver assumes one task. Its registries — `pending`,
`pendingCopies`, the waitable set — are module globals; `componentPoll`
returns EXIT by calling `task.return` when both registries drain; the
callback is shared by every waitable in the program.

With concurrent `handle` calls that breaks in three places:

1. **`task.return` is per task, from that task's own execution.** Two
   in-flight calls each owe one `task.return` with their own result,
   and each must be issued while the host considers that task the
   running one — inside its export call or one of its callback
   re-entries.
2. **A waitable set is waited by one task at a time.** Two tasks both
   returning `WAIT` on the shared set is invalid; each task needs its
   own set, and each waitable must be joined to the set of the task
   that will consume its completion.
3. **A task's work can finish during another task's entry.** The
   instance has one microtask queue, and the runtime runs the
   microtask checkpoint at every host→guest entry — the export call,
   and each callback re-entry (see "The microtask checkpoint" below;
   this is exactly JS's model, with the checkpoint at the end of every
   macrotask). A continuation runs at the first checkpoint after its
   future settles, whichever task's entry that turns out to be: if
   task B awaits a `Completer` that task A's code completes, B's
   continuations run during A's entry, possibly to B's logical end.
   JS has no notion of "which request is running" and does not care;
   the component model does — B's `task.return` must be issued from
   one of B's own entries, and B is only re-entered when something in
   *B's* set fires. If B's last host-owed event was already consumed,
   nothing ever fires.

Problem 3 is the real design problem. Per-task microtask queues would
not remove it: B's continuation would then wait for a B entry that
nothing triggers. The fix is a self-wake channel:

- Each task's context carries a canonical **future pair** created at
  task start (`future.new`). The readable end joins the task's set.
- The wrapper's tail is: await the program's result, store it in the
  task context, then write the wake future (`future.write` of nothing —
  a bare `future`, the one payload shape currently refused, or a
  `future<u8>` written with a byte if bare futures stay refused).
- Whoever's drain completes the program's work thereby fires B's wake
  future — the host delivers B's FUTURE_READ event, B's callback runs
  *as B*, finds the stored result, lowers it through `task.return`,
  and returns EXIT.

A task that completes without ever suspending skips all of this: the
wrapper sees the result before returning and calls `task.return`
directly, exactly as the import driver's RETURNED-inside-the-lowering
fast path does.

### The microtask checkpoint

`drainMicrotasks()` is the checkpoint a JS engine runs implicitly at
the end of every macrotask: run every queued continuation until the
queue is empty. Zena code has no engine around it — "the end of the
macrotask" is the return from a wasm export to the host — so the
runtime's own entry points run the checkpoint explicitly, at that
boundary and nowhere else: the component driver's `componentPoll`
(after the entry call) and `componentResume` (after each callback
re-entry), the `__zena_drain` export a JS host re-enters through, and
the level-0 `main` wrapper for hosts with no event loop at all
(async.md §4), which also throws on a still-pending future rather
than returning a wrong answer — the deadlock a `sleep()` produces
where nothing can wake the module. `runFuture` is the same
checkpoint packaged for a synchronous caller, and documented as
top-level only for the same reason.

Nothing else should call it, and the design above never does: the
driver's checkpoint at each entry is the whole story. The
`main(): void { go(); drainMicrotasks(); }` idiom that many fixtures
carry predates async `main` on the component target and is
redundant there (the poll drains); with async `main` driven directly,
the idiom retires, and the export deserves to become an internal of
the drivers rather than public surface.

### The task registry

`zena:component-async` keeps a context per task (landed):

```zena
final class TaskContext {
  var waitableSet: WaitableSet;   // this task's waitable set
  var pendingWaitables: i32;      // joined and still owed an event
  var returnsValue: boolean;      // typed task.return, not the bare one
  var pendingReturn: (() => void) | null;  // the typed return, once known
  var returned: boolean;
  var failure: Error | null;      // reported instead of a return
}
```

- The callback routes by owner: every waitable is registered with the
  task context that joined it, so `componentResume(event, waitable,
  code)` finds the context, runs the completion, drains, and answers
  for *that* task — `EXIT` after its `task.return`, or
  `WAIT | (ctx.waitableSet << 4)`.
- `pending` and `pendingCopies` stay global maps (a waitable index is
  instance-global); the `owners` map says whose each one is, so the
  post-drain answer is computed against the right task.
- The entry (`main`) is task 0, the same as any other.
- A task with a value hands the driver its future and typed return
  through `finishTask(result, ret)`. The driver parks `ret` on the
  context when the future settles and calls it from the task's own
  entry — the next `componentPoll` or `componentResume` answering for
  that task — which is what "issued from the task's own execution"
  requires. A task that runs out of waitables with its value still
  pending is a deadlock, reported as one rather than returned wrongly.
  The self-wake future above is what makes "the task's own entry"
  arrive when the settling happened during another task's; with one
  task there is always a next entry of its own, and the wake is the
  next increment.

**To verify against wasmtime before building** (each a small probe,
in the spirit of the timer and stream probes that preceded C6). Two
of the three are already answered:

- ~~whether an export lifted async may call `task.return` from a
  callback re-entry rather than the initial call~~ — **proven**: the
  existing entry does exactly this. `componentResume` calls
  `task.return` from a callback re-entry whenever the drain empties
  the registries, and the timer fixture exercises it in CI.
- whether a subtask or stream end may be *created* by task A and its
  completion consumed while task B is the running task (cross-task
  awaits make this reachable) — genuinely open; needs two live
  tasks, so it becomes the first increment of the export work rather
  than a standalone probe.
- ~~whether `wasmtime serve` runs a p3 `service` world in the pinned
  version~~ — **yes**: v47's `serve` command implements
  `wasmtime_wasi_http::p3::WasiHttpView` and wires
  `p3::add_to_linker` under `-S p3` (`src/commands/serve.rs`). Its
  concurrency default is telling: 1 in-flight request for a WASIp2
  component, **128 for WASIp3** — concurrent `handle` calls are the
  default operating condition, not an edge case, which is why Part 2
  is load-bearing.

## Part 3: What this unlocks beyond http

An exported interface with rich types is the missing half of
*composition testing*: a Zena provider component implementing
`wasi:geo`/`wasi:store` composed (`wasm-tools compose`) with the
existing consumer fixtures would execute the whole type matrix —
records, variants, enums, borrows — with both sides generated, no
host support required. Today those fixtures stop at "compiles and
validates" because only interfaces wasmtime happens to serve can run.
That also requires instance-grouped exports (`wasi:geo/survey` as an
exported instance, not flat names), which the emitter does not emit
yet and composition needs.

## Sequencing

1. Probes for the three open questions above.
2. ~~Driver generalization to task contexts (`main` becomes task 0)~~
   — landed (#571), no new surface.
3. `task.return` with a typed result — landed for flat scalars, with
   the wrapper-module mechanism and the async entry as its user
   (`main(): Future<u32>` returns `42` through `task.return#main`,
   e2e). Remaining: the `return:<iface>#<type>` aliasing for rich
   results, which arrives with its first user in 4.
4. Export wrapper synthesis for async exports with rich types, and the
   world plumbing to declare them — landed for a world's *function*
   exports (`service.wit` / `service.zena`, e2e): `wit-module-synth`'s
   `synthesizeExportWrapper` writes one `<name>_export` wrapper per
   async export, injected into `compile` through
   `CompilerOptions.componentWrapperSynth` because the compiler does
   not link the WIT parser; the encoder writes each lift's type from
   the WIT (`EncodedImports.exportTypeIndices`) and the typed return's
   result (`return:<interface>#<type>`, the interface empty at world
   level); the lift's and the return's memory options are one
   decision (`needsMemoryLift`). Parameters cross as flat scalars and
   strings; results as anything the import path lowers, a `result` as
   `Outcome`. Named types wait on 5: at world level they need
   world-level `use`, and the http world's come through its exported
   interface.
5. Instance-grouped exports.
6. The http `service` world end to end — `wasmtime serve` if the
   probe says yes, composition with a Zena client otherwise — then
   provider components for the fixture interfaces.
