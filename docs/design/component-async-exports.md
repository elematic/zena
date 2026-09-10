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
generated code as source: the program declares its export against the
WIT (mechanism to be settled — plausibly `export function handle(...)`
type-checked against the world, as `--wit`/`--world` already checks
declared surfaces), and the compiler synthesizes a *wrapper module* —
source, like a WIT-typed module, importing both the program's function
and the types module — whose exported wrapper is what gets lifted.
The host-facing wrapper is then ordinary Zena: lift the request handle
into `Request`, call the program's `handle`, await it, lower the
`Outcome` through `task.return`.

`task.return` with a rich result is itself new: today it is declared
`task.return: func()` (the entry returns nothing) and its canon entry
carries the lifted type. A `result<response, error-code>` result means
the canon entry's type is that result — the same component-type
aliasing the `future.*` builtins use (`future:<iface>#<payload>`
generalizes to `return:<iface>#<type>`), and the call site passes the
flattened value or spills it, per the same rules as any lowering.

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
3. **Completion crosses tasks through shared Zena state.** Task A's
   callback drains the microtask queue; that drain may complete a
   future task B is awaiting and run B's continuations to B's logical
   end — while the host still thinks B is parked. B's value exists,
   but B's `task.return` cannot legally happen until B is re-entered,
   and B re-enters only if something in *B's* set fires. If B's last
   awaited waitable was consumed by A's drain, nothing ever fires.

Problem 3 is the real design problem, and the fix is a self-wake
channel:

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

### The task registry

`zena:component-async` grows a task table:

```zena
final class TaskContext {
  set: i32;                       // this task's waitable set
  wakeWritable: i32;              // fires the callback when work done
  var result: ...;                // parked until task.return
}
```

- The callback's routing changes from "the one task" to a lookup:
  every waitable is registered with the task context that owns it, so
  `componentResume(event, waitable, code)` finds the context, runs the
  completion, drains, and answers for *that* task — `EXIT` after its
  `task.return`, or `WAIT | (ctx.set << 4)`.
- `pending` and `pendingCopies` stay global maps (a waitable index is
  instance-global), but each entry records its owning context so the
  post-drain answer is computed against the right task.
- The entry (`main`) becomes just another task, removing the current
  special-casing rather than adding to it.

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
2. Driver generalization to task contexts (`main` becomes task 0) —
   no new surface, all existing tests must stay green.
3. `task.return` with a typed result (canon type aliasing + call
   sites).
4. Export wrapper synthesis for one async export with rich types, and
   the world plumbing to declare it.
5. Instance-grouped exports.
6. The http `service` world end to end — `wasmtime serve` if the
   probe says yes, composition with a Zena client otherwise — then
   provider components for the fixture interfaces.
