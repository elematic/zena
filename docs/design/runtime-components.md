# Loading components at run time

## Status

- **Status**: Proposed; the spike in "Calls back into the caller" ran
  on 2026-10-26
- **Issue**: #593
- **For**: a PDS written in Zena that loads extensions at run time
  ([pds-extensions.md](./pds-extensions.md))

## Overview

`zena:wasm` runs a component as a program: it instantiates the
component in a store of its own, calls one export with no arguments,
reports the result as text, and drops the instance. A program that
wants to use another component as a library needs more: an instance
that lives across calls, calls with typed arguments and results, a say
in which imports the other component gets, and a way to serve some of
those imports itself.

This document adds that to `zena-runtime` as a second host interface
beside `wasm`, named `components`. A component loaded through it is an
_installation_: an instance the loading program calls through its own
WIT imports, and which calls the loading program through the program's
WIT exports. The runtime forwards each call as wasmtime values, so
nothing is encoded, and checks at load time that the two sides' types
agree.

Throughout, the _caller_ is the program that loads, and the _child_ is
the component it loads.

## Calls back into the caller

The part that decides the design is a child calling one of its imports
while the caller is waiting on a call into the child, with the host
forwarding that import to an export of the caller. In the Component
Model a component instance may not be re-entered by the task that is
already inside it: a synchronous call into the caller while the caller
is in a synchronous call out would trap. With WASI 0.3 the caller's
call is async-lowered, so the caller's task yields to the host while
the call is in flight, and the call back can start as a new task in the
caller's instance.

The spike checks that wasmtime 48 allows this. It is
`packages/zena-runtime/examples/components_spike.rs`, with its two
components in `examples/components-spike/`:

- The child exports `spike:child/ops`, whose `compute: async func(x:
s32) -> s32` calls the child's import `spike:child/callbacks`'s
  `lookup: async func(key: s32) -> s32` and doubles the answer.
- The caller imports `ops` and exports `callbacks`, each function with
  an installation handle as its first parameter, and its `main` calls
  `compute` twice and prints the results.

The harness runs the child in a store of its own, on a thread of its
own with its own event loop. The caller's import is a concurrent host
function (`func_new_concurrent`): it sends the call to the child's
thread over a channel and then waits on two channels at once, the
child's result and the child's calls back. A call back is served by a
task the host function spawns in the caller's store
(`Accessor::spawn`), which calls the caller's export with the handle
prepended and sends the result to the child's thread, where the
child's import host function is waiting on it.

Built from the repository root with

```text
cargo build --release -p zena-runtime --example components_spike
./target/release/zena-cli build packages/zena-runtime/examples/components-spike/child.zena \
    --target component --wit packages/zena-runtime/examples/components-spike/child.wit \
    --world child -o packages/zena-runtime/examples/components-spike/out/child.wasm
./target/release/zena-cli build packages/zena-runtime/examples/components-spike/caller.zena \
    --target component --wit packages/zena-runtime/examples/components-spike/caller.wit \
    --world caller -o packages/zena-runtime/examples/components-spike/out/caller.wasm
./target/release/examples/components_spike \
    packages/zena-runtime/examples/components-spike/out/caller.wasm \
    packages/zena-runtime/examples/components-spike/out/child.wasm
```

it prints

```text
lookup from installation 1: 5
compute(5) = 210
lookup from installation 1: 7
compute(7) = 214
done
```

Each `lookup` line is printed by the caller's export, called while the
caller's `compute` call was in flight. So wasmtime allows the call
back, and the fallback (a typed stream of the child's import requests)
is not needed.

Two more runs of the same harness set the rules the design follows:

- **The spawn is what makes the entry a new task.** Wasmtime refuses a
  call into an instance when that instance is on the calling task's
  chain of parents (`may_enter` in its `concurrent.rs`). A concurrent
  host function is polled once in the calling guest task's context,
  and after that from the store's event loop with no parent. With
  `SPIKE_DIRECT=1` the harness calls the caller's export from the host
  function itself instead of spawning, and that works too, because the
  call back only ever arrives after the function's first await. A call
  before the first await would trap. Spawning a task does not depend
  on where the await points are, so the runtime spawns.
- **The caller must await, not block.** `caller-blocking.zena` is the
  caller with `blockOn(compute(1, 5))` in a synchronous `main`.
  `blockOn` parks the task in a synchronous `waitable-set.wait`, which
  keeps the caller's instance entered, so the call back's task queues
  behind it and the run hangs: the caller waits for the child, the
  child waits for the caller. A program that calls an installation
  which may call back has to `await` the call. The PDS's handlers are
  async, so this costs nothing there; it is a rule the API's
  documentation states.

## Detailed design

### Installations and handles

`load` reads a component, checks it (below), instantiates it, and
returns a handle, a `u32`. The caller passes that handle as the first
argument of every call it forwards to the installation. An installation
lives until `unload` or the end of the caller's run. Handles are never
reused within a run, so a call with a stale handle fails with a message
instead of reaching another installation.

The handle is a plain integer rather than a WIT resource so that the
extension interfaces a program and its extensions share depend on no
host package: `spike:child/ops` above is written with `installation:
u32`, and the same WIT file serves any host that follows the
convention.

### The pairing convention

The caller and the child each declare the interfaces between them in
their own WIT. The runtime pairs them by name and checks the types at
load time.

- An import of the caller whose instance name is neither `wasi:…` nor
  `zena-cli:host/…` is an _extension interface_. For each function in
  it, the child must export an instance of the same name with a
  function of the same name. The caller's function has one more
  parameter than the child's, a `u32` first; the rest match in order
  and type. The caller's result is `result<T, string>` where the
  child's is `T`, or `result<_, string>` where the child has none. The
  `string` is why a call failed: a trap in the child, its time limit,
  or an installation that no longer exists. A failed call is a value
  the caller inspects, because a host function that returns an error
  traps the instance that called it, and a failing extension must not
  take the program down.
- An import of the child whose instance name is not in the load's
  allow list and is not `wasi:…` or `zena-cli:host/…` must be an
  export of the caller: same instance name, same function names, the
  caller's function with the `u32` handle first and otherwise the same
  parameters and results. A call fails the child's call with the
  caller's error when the caller's export traps, which is the
  caller's own bug.

Whether a function is `async` is not compared: the forwarder calls
the other side through wasmtime's concurrent API either way. A caller
whose import is synchronous blocks its task until the child returns,
and a call back during that time deadlocks as `blockOn` does above.

Types at the boundary are checked by walking the two `ComponentFunc`
types from `Component::component_type()` and comparing them
structurally after dropping the handle and the result wrapper.
Resources, streams and futures are refused at load with a message
naming the function, since forwarding them would need the runtime to
map handles between tables; the PDS's extension WIT uses none.

### Forwarding

The caller's extension imports are defined when the caller is linked,
before anything is loaded: `linker` walks the caller's component type
and defines a concurrent host function for every function of every
extension interface. The function reads the handle from its first
argument, finds the installation, sends the remaining arguments to the
installation's thread, and waits for the result while serving calls
back as spawned tasks of the caller's store, as the spike does. With
no installation for the handle it returns the error value.

The child's extension imports are defined when the child is loaded,
from the child's component type: each is a concurrent host function
that sends the call to the caller through the channel of the
caller's call in flight and waits for the answer. A child that calls
an extension import outside any call from the caller, say from a task
it started itself, fails that call, since there is no caller task to
serve it.

Values cross as `wasmtime::component::Val`, unchanged.

### Isolation

Each installation has a store of its own, on a thread of its own with
a current-thread tokio runtime, as a `zena:wasm` run has. Calls to an
installation are serialized: one at a time, in order; a second call
waits for the first. The thread holds the `InstancePre`, so a fresh
instance can be made when the old one is lost.

- **Imports.** The child's linker is the full host linker, and its
  imports are checked against the load's allow list before
  instantiation: every import must be listed, or be an extension
  interface the caller exports. The error names the first import that
  is neither. The child gets no preopened directories, no arguments
  and no environment, and inherits the caller's standard output and
  error. A child's own `zena:process`, `zena:wasm` and `components`
  calls trap, since it has no grant.
- **Memory.** `memory-limit` is enforced with a `ResourceLimiter` on
  the installation's store. Wasmtime consults it for linear memory and
  for the GC heap, which is what a Zena component allocates in, so the
  limit covers both. A growth past the limit fails the allocation, and
  a Zena program then traps.
- **Time.** An installation loaded with `call-timeout` runs on the
  interruptible engine, as a `zena:wasm` run with a time limit does,
  and the thread sets the store's epoch deadline before each call.
- **Failure.** A trap, a time limit, or a memory failure poisons the
  installation's store, so the instance is dropped and the next call
  instantiates the component again, with fresh state. The failed call
  returns its error value; the installation stays loaded.

### The host interface

Added to `packages/stdlib/zena/host-wit/host.wit`:

```wit
/// Loading other components as installations: long-lived instances the
/// program calls through its own imports, and which call back through
/// the program's exports. Granted on its own (`--allow-components`).
interface components {
  record load-options {
    /// Host interfaces the component may import, by name with version,
    /// such as `wasi:clocks/monotonic-clock@0.3.0`. An import that is
    /// neither listed nor an interface this program exports fails the
    /// load.
    imports: list<string>,
    /// The most memory the instance may hold, linear memory and GC heap
    /// together, in bytes; no limit when 0.
    memory-limit: u64,
    /// The most time one call may take, in nanoseconds; no limit when
    /// not positive.
    call-timeout-nanos: s64,
    /// Run with inlining off, so a trap's backtrace names every
    /// function; the caller's own setting if false.
    debug: bool,
  }

  /// Loads `path`, in the caller's view of the file system, checks its
  /// types against this program's, and instantiates it. The result is
  /// the installation's handle, or why it could not be loaded.
  load: func(path: string, options: load-options) -> result<u32, string>;

  /// Drops the installation. A call in flight fails.
  unload: func(installation: u32);
}
```

### The grant

Loading components is granted apart from spawning processes:
`--allow-components` on `zena-run` and `zena run`, or
`ZENA_ALLOW_COMPONENTS=1`. `Grant` in `zena-runtime` gains a flag per
capability, keeping the path map and debug setting both use. A run
started through `zena:wasm` with `grant: true` passes on what its
caller holds, so a test runner with both grants gives tests both, and a
program with only `--allow-components` passes on only that.

### The Zena API

`zena:components`, on the `zena-cli` target only, as `zena:wasm` is:

```zena
import { Duration } from 'zena:time';

export type LoadOptions = {
  imports?: Array<String>,
  memoryLimit?: i64,
  callTimeout?: Duration,
  debug?: boolean,
};

/** An installation; `handle` is what the program's imports take first. */
export final class Installation implements Disposable {
  handle: u32;
  dispose(): void;  // unloads
}

export let loadComponent = (path: String, options: LoadOptions = {}):
    Result<Installation, String>;
```

The program's side of the extension interfaces is ordinary WIT interop:
it imports the caller's copy of each interface, declares a world that
imports and exports them, and awaits each call.

### Tests

The host interface is tested from Zena, in the standard library's
tests beside `zena:wasm`'s: `load` with a missing file, a refused
import, and a type mismatch are called from the test directly. The call
paths need a program that imports an extension interface, which a test
file cannot declare, so they run a fixture caller built with `--wit`
and `--world` by the package's `build:fixtures` script, through
`zena:wasm`, and check what it prints: calls with arguments and
results, calls back, a trap and a time limit failing one call and the
next call succeeding, a memory limit, and `unload`.

## Alternatives considered

- **The handle as a `borrow<installation>` resource.** Typed, and the
  runtime could map it through the resource table, but every extension
  interface would then `use` the host's WIT package, and the Zena
  compiler renders a resource with an owned handle only for interfaces
  on a fixed list it keeps for the bootstrap's sake. A `u32` keeps the
  extension WIT self-contained.
- **Failures as traps.** Simpler types, but a host function's error
  traps the calling instance, so one broken extension would end the
  program. The result wrapper is the cost of keeping the caller alive.
- **One store for everything.** Calls would need no threads or
  channels, but a trap poisons a store, so a child's trap would end
  the caller too, and one memory limit would cover all of them. A
  store per installation is what makes the limits and the failure
  rule per installation.

## Open questions

- Concurrent calls into one installation: one at a time is enough for
  write policy hooks, and a request handler extension may want more.
  Wasmtime's event loop can run several tasks in one store; the thread
  would then take calls while others are in flight.
- `load` blocks the caller while the component compiles and
  instantiates. The compile cache makes a second load fast; an async
  `load` would keep a server responsive during the first.
- Where the compiled form is cached on hosts without a lasting disk
  ([pds-extensions.md](./pds-extensions.md), "Open questions").
- Cancelling a call in flight when the caller's task is cancelled.

## Related

- [pds-extensions.md](./pds-extensions.md): what the PDS needs from
  this.
- [component-model.md](./component-model.md): WIT interop, the import
  and export shapes the caller and child are written with.
- [component-async-exports.md](./component-async-exports.md): how an
  async export's task yields, which is what lets a call back in.
- [wasi.md](./wasi.md) and
  [component-emission.md](./component-emission.md): the `zena-cli`
  target and its host.
