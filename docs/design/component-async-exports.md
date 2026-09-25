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

| position           | import side (built)              | export side (needed)           |
| ------------------ | -------------------------------- | ------------------------------ |
| parameter          | lower (Zena value → wire)        | lift (wire → Zena value)       |
| result             | lift from the return area        | lower through `task.return`    |
| resource parameter | pass handle, mark moved          | wrap received handle           |
| stream/future      | `lowerByteStream`/`lowerFutureK` | `liftByteStream`/`liftFutureK` |

None of that is new machinery — `wit-module-synth` already generates
both directions for values, and the pumps and future helpers are
direction-agnostic (a lift helper does not care whether the end
arrived from an import's result or an export's parameter). What is new
is _where the generated code lives_. Import wrappers are synthesized
source in a WIT-typed module the program imports. An export wrapper
wraps the _program's own_ function, which no stdlib or synthesized
module can name — the same reason the entry is built in
`component-adapters` as IR.

Building rich marshaling in `IrBuilder` would rebuild everything the
synthesizer says in Zena, badly. The alternative that keeps the
generated code as source is a _wrapper module_ the compiler writes and
loads beside the entry: source, like a WIT-typed module, importing the
program's function and any types module it needs, whose exported
wrapper is what gets lifted. The host-facing wrapper is then ordinary
Zena: lift the request handle into `Request`, call the program's
`handle`, await it, lower the `Outcome` through `task.return`.

**The mechanism is in place**, with the async entry as its first user
(`lib/component-entry.zena`). `Compiler.compile` decides from the
entry's syntax alone whether a wrapper is needed, writes its source,
and hands it to the loader with the import of the entry _pinned_ to
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
   _B's_ set fires. If B's last host-owed event was already consumed,
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
  future — the host delivers B's FUTURE*READ event, B's callback runs
  \_as B*, finds the stored result, lowers it through `task.return`,
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
  for _that_ task — `EXIT` after its `task.return`, or
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
  requires.
- Every adapter begins a fresh task (`beginTask`) before the
  program's function runs. Without it, a second call in flight in one
  instance reused the first call's context, and wasmtime trapped with
  `task.return called more than once for current task` once two
  requests overlapped in one instance (`wasmtime serve` reuses an
  instance for up to 16 concurrent calls).
- **The self-wake future, landed.** With the timer queue arming one
  host wait for every sleeper, every due sleep completes in the drain
  of whichever task armed that wait, so a request's value routinely
  settles in another task's entry. The wake is a bare `future`
  (`future.*#wake` in the driver, named so a program may declare
  `future.write` at a type of its own): `wake(ctx)` runs when the
  value settles; if the running task is `ctx` nothing is needed, and
  otherwise the pair is created _from the running task_, its readable
  end joined to `ctx`'s set with a read pending, and the writable end
  written at once — the host then re-enters `ctx` with a FUTURE_READ
  event, and its callback finds the return parked. `nextCode` also
  arms one in the task's own entry when its value is pending and it
  has nothing else to wait on, since a WAIT needs a set with something
  in it. Arming on demand rather than only there matters: a task can
  hold waitables of its own that never fire — the `transmitted` future
  of a response the program ignores is one — so "nothing left to wait
  on" never comes, which is exactly how one request in sixteen hung
  before this. The probe question above is answered by the same
  mechanism: waitables one task creates are consumed from another
  task's entry throughout, and wasmtime is fine with it.
- A task that returned its value can linger, driving timers and
  streams other tasks' work registered under it, until they fire; a
  waitable that never fires keeps it alive for the instance's life.
  That is a leak against the instance's concurrent-call cap, not a
  hang, and the `transmitted` futures are the known case.

**To verify against wasmtime before building** (each a small probe,
in the spirit of the timer and stream probes that preceded C6). Two
of the three are already answered:

- ~~whether an export lifted async may call `task.return` from a
  callback re-entry rather than the initial call~~ — **proven**: the
  existing entry does exactly this. `componentResume` calls
  `task.return` from a callback re-entry whenever the drain empties
  the registries, and the timer fixture exercises it in CI.
- ~~whether a subtask or stream end may be _created_ by task A and
  its completion consumed while task B is the running task~~ —
  **yes**: the service under concurrent load does this constantly
  (a request's response stream registered under whichever task's
  drain ran its continuation, the wake future's read issued from the
  settling task for the waiting one), and sixty-four staggered
  requests through one instance all answered.
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
_composition testing_: a Zena provider component implementing
`fixture:geo`/`fixture:store` composed (`wasm-tools compose`) with the
existing consumer fixtures would execute the whole type matrix —
records, variants, enums, borrows — with both sides generated, no
host support required. Today those fixtures stop at "compiles and
validates" because only interfaces wasmtime happens to serve can run.
That also requires instance-grouped exports (`fixture:geo/survey` as an
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
   world plumbing to declare them — landed for a world's _function_
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
5. Instance-grouped exports — landed: a world's `export
wasi:http/handler@0.3.0;` gathers the interface's functions into a
   component instance exported under that name (emitter: an instance
   from inline exports, then an instance export). The functions' named
   types come through the interface's `use`s: the encoder follows a
   `use` to the imported source and aliases the type out of _that_
   instance (`#useSourceOf`), both for the lift's type
   (`encodeExportedInterfaceFuncType`) and for the typed return's
   (`return:wasi:http/handler@0.3.0#result<response, error-code>`). A
   type an exported interface declares itself is still refused. The
   wrapper lifts an owned resource parameter into its synthesized
   class (`new Request(a0)`), imported from the types module, and the
   declared world assigns each export its instance. A declared world
   also gets the manifest's WIT-backed packages spliced in, so
   `import wasi:http/types@0.3.0;` needs no vendoring.
6. The http `service` world end to end — landed through `wasmtime
serve`: `http-service.zena` implements `handle`, builds a
   `Response` around a `Stream<u8>` a background task writes, and the
   e2e fetches a path and reads the body back (the stream is pumped
   after `task.return`, from callback re-entries). Remaining: provider
   components for the fixture interfaces (composition tests), and the
   self-wake future for concurrent tasks.
7. Two Zena components composed — landed as the `compose` fixtures.
   `compose.wit` declares an `oracle` interface whose `ask` is
   `async func(n: s32) -> future<s32>`, a `provider` world exporting
   it and a `consumer` world importing it. The provider's `ask`
   returns a `Future<i32>` a background task completes after a sleep;
   the wrapper lowers it into a canonical future (`future.new`, a
   pump that `future.write`s the settled value), with the helpers
   rendered into the wrapper module and their canon types named
   against the exporting interface, which the encoder now resolves
   whether the interface is imported or exported. The consumer awaits
   the lifted future, so its deferred read starts on that await and
   the value it reads was written by the other component's task in
   the other instance. `wasm-tools compose` wires the two and the e2e
   runs the composition. Three things had to give: a program
   compiled against a declared world can import the document's own
   interfaces by name (the CLI registers each namespace the document
   declares as a WIT-backed package rooted at the document, unless the
   manifest or the stdlib already provides it); a module synthesized
   from such a document gets the compiler's WASI WIT spliced in, as
   the encoder's parse already did, since the document's worlds
   import `wasi:cli` by name; and a declared world's `export main:
async func()` is the entry itself — the wrapper synthesizer skips
   it rather than exporting `main` twice.
8. Synchronous exports, at world level and in exported interfaces —
   landed as the `greeter` fixture. Flat scalars and strings lifted
   already: a program export of those is lifted directly (a string
   result through the IR-built wrapper and its `stringResultArea`),
   and the declared world assigns it to its interface's instance.
   Anything richer now goes through the same wrapper module the async
   exports use, as `<name>_export_sync`: parameters lift as they do
   for an async export, the program's function is called, and the
   result comes back the way a synchronous lift takes one — the one
   core value it flattens to, returned; or, past one, the canonical
   layout written into a return area the wrapper stages, whose address
   is returned. The area and whatever it points into stay staged until
   the host has read them: the wrapper notes the staged range
   (`notePostReturn`), the lift carries `post-return`, and `postReturn`
   releases the range. One pending range suffices, since a synchronous
   lift runs to completion and the host calls `post-return` before
   re-entering. The encoder types the lift from the WIT and decides the
   options from the flattening: memory when anything crosses through
   it, `post-return` when the result flattens past one core value.
9. Rich parameters on wrapped exports — landed as the `params`
   fixture. A wrapped export's parameters arrive as the canonical
   flattening of their types, and the wrapper now lifts any of them:
   `liftFlatExpr` is the mirror of `lowerFlatStmts`, one expression
   per parameter, with a generated `liftFlat<Type>(s0..sN)` helper
   per aggregate (a record's fields from consecutive slots, a
   variant's cases from the discriminant and their prefix of the
   shared payload slots, narrowing a joined `i64` back for an `i32`
   arm) and the list helper split into its pair half and its element
   half so a flat `(ptr, len)` reaches the elements directly. A string
   inside an aggregate is taken whole (`takeStringArgument`, bytes
   copied out and the host's buffer released); a bare string keeps the
   two-statement shape. Past sixteen core values in all, the host
   spills the parameters into memory and the lift takes one address:
   the wrapper then lifts each parameter at its aligned offset through
   the memory lift and frees the buffer. Borrowed handles are refused
   by name: the wrapper cannot hand one to the program without also
   owning its disposal, which is the ownership track's question. The
   async wrapper shares the parameter rendering, so its parameters
   widened at the same time.
10. Types an exported interface declares itself — landed with the
    geo provider, which closes Part 3's composition test: a Zena
    provider of `fixture:geo/survey` composed with the consumer
    fixture runs the whole type matrix with both sides generated.
    The encoder had only aliased an exported interface's types out
    of an imported source through `use`; a type the interface
    declares itself is now encoded at component level on first use
    (`#encodeExportedOwnType`, resolving its named parts against the
    interface the same way) and recorded on the encoded world, and
    the exported instance exports each under its name ahead of its
    functions, so the component reads back as the interface. An
    exported resource is still refused: it is a class of the
    program's, with a representation and a destructor the canon
    `resource.new`/`resource.rep`/`resource.drop` builtins would
    carry. On the source side the wrapper imports the interface's
    own types from the interface's synthesized module, the module
    the program itself gets them from — the wrapper has no
    `selfSpecifier` now, since nothing is local to it. The fixture's
    `finding` variant joins an `f64` payload with `i32` ones, which
    the flat form had refused; the canonical join is spelled now — an
    `f32` beside an `i32` is an `i32` slot, anything else an `i64`, a
    float lowered as its bits and lifted back through the `zena:math`
    reinterpret intrinsics, an integer widened and wrapped — so
    `report(finding)` imports and exports alike.
11. Typed streams — landed as the `gfx` fixtures, for the graphics
    work's event streams (`on-frame: func() -> stream<frame-event>`).
    A `stream<T>` of anything but `u8` is `Stream<T>` in the
    bindings, carried by a generated pair of pumps per element type,
    the mirror of a future's: the five stream builtins declared per
    element (`stream.read#k`, typed `stream:<iface>#<element>` by the
    encoder, with the memory and `realloc` options since an element
    may hold a string), a lift that reads a chunk of elements out of
    a return area through the memory lift and delivers them into a
    `StreamWriter`, and a lower that takes the guest stream's elements
    one at a time with the new `Stream.readOne()` and writes each
    from a staged buffer. Bytes keep `zena:wasi`'s pumps. Both
    directions run composed: the provider's `frames` stream of
    records is read one at a time by the consumer, and the consumer's
    stream of records, one carrying a string, is summed by the
    provider's `sink`.
    Two rules came out of it. A stream or future on a **synchronous**
    export is refused by name: its pump is driven by the host's
    callback re-entries, which a synchronous export never gets, so
    the pump would park forever on its first copy — `frames` is
    `async func`. And the driver's `nextCode` now runs the microtask
    checkpoint again after the typed return: lowering the returned
    value starts the pump, whose first step is a queue hop and whose
    first copy joins the task's set, and deciding EXIT before that hop
    ran left the provider's task gone with its pump parked — the
    composed run hung on the consumer's first read until it did.
12. Spilled parameters on imports — landed as the `spill` fixtures.
    Running the WIT the `zenafx` triangle fixture actually uses
    through the synthesizer (all of `wasi:webgpu/webgpu` and the two
    `wasi-gfx:surface` interfaces) left exactly five functions
    refused, the five the triangle calls: `request-adapter`,
    `request-device`, `create-render-pipeline`, `begin-render-pass`
    and `create-view`. Each takes parameters that flatten past the
    canonical limit — sixteen core values on a synchronous call, four
    on an asynchronous one, a method's `self` handle among them — and
    the ABI then passes every parameter through one address. The
    export side already lifted that shape (step 9); the import
    wrapper now lowers it: one staged buffer laid out like a record,
    the handle first, each parameter stored at its aligned offset
    through the memory lowering, the address as the raw call's one
    argument, and the buffer freed with the wrapper's other staging —
    after the call, or after the subtask has returned. The encoder
    already counted this way, so the declaration check needed nothing.
    Composed: the consumer's seventeen-argument `sum` and `describe`
    (a string among them) and five-argument async `sum-async` run
    against a Zena provider.
