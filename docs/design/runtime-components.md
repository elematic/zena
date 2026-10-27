# Loading components as extensions

## Status

- **Status**: Implemented, 2026-10-27: `zena-runtime`'s `extensions`
  module, the `extensions` host interface, `zena:extensions`, and the
  `--allow-extensions` grant; resources across the boundary the same
  day; the build-time check of a program's world against its
  extensions' WIT (`--extension-wit`) the same day
- **Issue**: #593
- **For**: a PDS written in Zena that loads extensions at run time
  ([pds-extensions.md](./pds-extensions.md))

## Overview

An _extension_ is a component a program loads at run time and keeps:
a long-lived instance the program calls through objects, and which
calls the program through objects the program made for it. The program
chooses every interface the extension may import, and serves some of
them itself. The runtime forwards each call as wasmtime values, so
nothing is encoded, and checks at load that the two sides' types agree.

Throughout, the _program_ is what loads, and the _extension_ is what it
loads. The PDS's _installation_, an extension installed by an account
at a version, is served by one loaded extension.

## Ways a program loads a component

The `zena` command's host loads components in two ways today, and a
third is foreseen. The extension API is the one with the most behaviour
of its own, because of how it maps interfaces to objects, so it is
worth placing beside the others.

**Commands.** `zena:wasm`'s `run` instantiates a component with a WASI
context of its own (arguments, environment, preopened directories,
stdio inherited or captured), calls one export by name with no
arguments, reports how it ended (a status, a result as text, a trap, a
time limit, an exit) and drops the instance. The component is a
program; the caller never calls into it again. `zena run` runs the
user's program this way, with the grants the user's flags give it, and
`zena test` runs each test file this way with both grants. The `zena`
binary itself loads the CLI module the same way, trusted: every host
interface linked, every grant held. `run` takes no bindings: a command
gets every interface the host serves, and nothing from its caller
besides the directories and the grants it is passed.

**Extensions**, this document. A component loaded through
`zena:extensions`' `load` stays instantiated and is called many times,
through typed calls the program's own WIT declares. The program
chooses what the extension imports, binding by binding, and serves some
imports itself through objects it makes per extension. Memory and time
are limited per extension, and a failure fails one call. This is for
code the program does not trust as itself: an extension installed by
an account on the PDS.

**Imported components**, not yet designed. A program's WIT import,
`import my:lib/math`, satisfied at run time by a component that exports
it, as a composition tool would satisfy it at build time. One provider
for the import, with the program's functions declared exactly as the
provider's, no objects and no result wrapper, since there is no
identity to carry and the provider is as trusted as the program. Open:
when it is loaded (at start, or at the first call), whether the import
names a specific component or any component exporting the interface,
and whether a failure traps the program as a failed link would. The
runtime pieces are the extension API's: a load with bindings, and the
exact binding an extension-to-extension import already uses; what is
missing is the compiler's side, a way to say that an import is
satisfied this way.

## Detailed design

### Bindings

`load` takes a _binding_ for every interface the extension may import,
and an import without one fails the load, with no exception, not even
for an interface of types alone. A binding says where the interface
comes from:

- `host`: a WASI or `zena-cli:host` interface, served by the runtime.
  The extension gets no preopened directories, arguments or
  environment, and its own `zena:process`, `zena:wasm` and
  `zena:extensions` calls trap, since it holds no grant, bound or not.
- `program(export)`: an interface the program exports, under the name
  `export`, which is usually the import's own name.
- `extension(handle)`: another loaded extension's export of the same
  name. This wires two extensions together without the program
  declaring anything about them.

`load-trusted` is the separate form for a component the program trusts
as itself: every host interface, and every export of the program by
the same name, are bound. It is a different function rather than a
value of the binding list, so that a load written for an extension
always says what it grants, and a reader can tell the trusted loads
from the rest by name.

A loaded extension is named by a handle, a `u32`, never reused within
a run. The handle appears in exactly two places in the program's code:
the argument of `attach`, and the parameter of `create`, below.

### The program's side of a shared interface

A call has to carry its caller's identity, since a function with no
caller argument and no `self` has nowhere to learn it from. In the
Component Model a program cannot hand out a function, only exports,
and a resource's methods are exports too. So the program declares its
side of each interface it shares with extensions as a resource, and
identity is the object: one per extension, made by the program, known
to the runtime, so a method call knows whom it serves. The extension's
WIT is written plainly, with free functions, and the runtime pairs the
two shapes.

**An interface the program serves.** Given the extension's import

```wit
interface storage {
  get: func(key: string) -> option<list<u8>>;
  put: func(key: string, value: list<u8>);
}
```

the program exports, under the same name (or the name its binding
gives),

```wit
interface storage {
  resource storage {
    get: func(key: string) -> option<list<u8>>;
    put: func(key: string, value: list<u8>);
    create: static func(extension: u32) -> own<storage>;
  }
}
```

The rule: one resource of the program's own, whose methods are the
extension's free functions with the same parameters after `self` and
the same results, and whose static `create` the runtime calls once,
the first time the extension calls on that interface, to make the
object for that extension. Every later call from that extension lands
on that object. The factory is a static rather than a free function so
that a program serving several interfaces has a `create` on each
resource, where a module's exported functions share one namespace. In
Zena the resource is an exported `Disposable` class, as any exported
resource is written:

```zena
export class Storage implements Disposable {
  #extension: u32;
  new(ext: u32) : #extension = ext;
  get(key: String): Option<FixedArray<u8>> { ... }
  put(key: String, value: FixedArray<u8>): void { ... }
  static create(ext: u32): Storage { return new Storage(ext); }
  [Disposable.dispose](): void {}
}
```

**An interface the program calls.** Given the extension's export

```wit
interface policy {
  check-write: async func(record: list<u8>) -> result<_, string>;
}
```

the program imports, under the same name,

```wit
interface policy {
  resource policy {
    check-write: async func(record: list<u8>) -> result<result<_, string>, string>;
    attach: static func(extension: u32) -> own<policy>;
  }
}
```

The rule: one resource of the program's own, whose methods are the
extension's functions with the same parameters after `self` and each
result wrapped in `result<T, string>` (or `result<_, string>` where the
extension returns nothing), and whose static `attach` the runtime
serves with an object whose method calls go to that extension's
export. The wrapper is where a
failed call is reported: a trap in the extension, its time limit, or
an extension that was dropped. A failed call is a value the program
inspects, because a host function that returns an error traps the
instance that called it, and a failing extension must not take the
program down. In Zena the resource is the imported class the compiler
synthesizes, so the program writes
`let policy = Policy.attach(ext.handle); await policy.checkWrite(bytes)`.

**Between two extensions.** An import bound to another extension is
checked against that extension's export exactly, functions to
functions, since nothing the program wrote is in between. A failure of
the serving extension traps the calling one, because there is no
wrapper to carry it.

**Resources the interface declares.** Given the extension's import

```wit
interface store {
  resource txn { put: func(key: string, value: u32); commit: func() -> u32; }
  begin: func() -> own<txn>;
  size: func(txn: borrow<txn>) -> u32;
}
```

the program's export keeps `txn` as it is, beside its own resource:

```wit
interface store {
  resource txn { put: func(key: string, value: u32); commit: func() -> u32; }
  resource store {
    begin: func() -> own<txn>;
    size: func(txn: borrow<txn>) -> u32;
    create: static func(extension: u32) -> own<store>;
  }
}
```

The rule: every resource the extension's interface declares is
declared on the program's side under the same name with the same
methods, and the two stand for each other wherever they appear in a
type. On the program's side the resource is a class the program
exports, so `begin` returns a `Txn` of the program's. An interface the
program calls is the same the other way: the extension's resources
appear in the program's view with their methods, results wrapped,
since a call on one goes to the extension. Constructors and statics on
such a resource are refused, having no object to serve them, and so
are resources from outside the interface, streams and futures.

Whether a function is `async` is not compared: the forwarder calls the
other side either way. Types are compared with wasmtime's
`types::Type`, structurally, with paired resources taken as the same.

### Checking the program's world when it is built

The load-time check is against the real extension. The program's
world is also checked when the program is built, against the WIT its
extensions are written to:

```
zena build app.zena -o app.wasm --target component \
  --wit app.wit --world app --extension-wit ext.wit
```

The compiler reads the extension document and compares each interface
it declares that the world imports or exports with the program's view
of it, by the rules above. A view that differs is a build error naming
the interface, the method and what differs, so the two documents
drifting apart is found before anything is loaded. Interfaces the
world does not mention are not checked. The flag repeats, one
document per extension.

The check compares the two documents as parsed, without resolving
them: a type both sides define is compared by structure (records,
variants, enums, flags and aliases), and a type a `use` brings in is
compared by name. Whether a function is `async` is not compared, as
the runtime does not compare it. The check is
`packages/zena-compiler/zena/lib/extension-views.zena`.

An extension written in Zena is checked against the same document
when it is built, by `--wit` and `--world`, so its exports and imports
match the document the program was checked against. An extension
built with other tools is checked when it is loaded.

### Calls back into the program

The program's calls into an extension are async-lowered, so the
program's task yields to the host while a call is in flight, and the
extension's call to the program during that time starts as a new task
in the program's instance. That is the only way in: the Component
Model forbids re-entering an instance from the task already inside it.
Wasmtime enforces the rule by refusing to enter an instance that is on
the calling task's chain of parents (`may_enter` in its
`concurrent.rs`), and a task spawned in the program's store
(`Accessor::spawn`) has no parent, so the runtime serves every call
back by spawning one.

Two more rules of wasmtime's shape the forwarders. A synchronous import
cannot be satisfied with a concurrent host function, so a forwarder for
a function that is not `async` is a blocking host function, which holds
the store while it waits; a call back during that time cannot be served,
and is answered with an error saying so. And lending a host-held handle
as a borrow needs a call in progress, so the proxies a call receives are
made before it as owned handles and released after it.

A consequence the program's code has to respect: a call on an attached
object must be awaited. A program that blocks on it, with `blockOn`,
parks its task in a synchronous `waitable-set.wait`, which keeps its
instance entered; the call back's task queues behind it, the program
waits for the extension and the extension for the program. The PDS's
handlers are async, so this costs nothing there; the API's
documentation states the rule. A program whose method is synchronous
blocks the same way.

### Forwarding

The program's imported resources are defined when the program is
linked, before anything is loaded: `linker_for` walks the program's
component type, and for every import whose instance name is neither
`wasi:…` nor `zena-cli:host/…` it checks the shape, defines the
resource as a host type whose representation is an extension's handle,
defines `attach` to mint one, and defines each method as a concurrent
host function. The method reads the handle from `self`, finds the
extension, sends the remaining arguments to the extension's thread, and
waits for the result while serving the extension's calls to the program
as spawned tasks of the program's store.

The extension's program-served imports are defined when the extension
is loaded, from its component type: each function is a concurrent host
function that sends the call to the program through the channel of the
program's call in flight and waits for the answer. The task that serves
it in the program looks up the object made for that extension on that
interface, calls `create` first if there is none yet, and calls the
method with the object as `self`. An extension that calls such an import
outside any call from the program, say from a task it started itself,
fails that call, since there is no program task to serve it.

An import bound to another extension sends the call to that extension's
thread, with the program's call-back channel along, so that the serving
extension's own calls to the program land in the forwarder that is
waiting. Dropping an extension ends its thread even while another is
bound to it, and the other's calls on that interface then fail. The
objects the program made for the dropped extension through `create`
are dropped as tasks of the program's store, which run when the
program next yields, since their destructors are the program's own
code and cannot run inside the `drop` call.

Values cross as `wasmtime::component::Val`, with one translation for
resources. A handle is an index into one instance's table, so it
cannot be given to another instance as it is. What crosses instead is
a _proxy_: a construction of `zena-runtime`, in Rust, out of a wasmtime
host-defined resource type. The resource the receiving component
imports, `txn` say, is defined in its linker as a host type, so every
`txn` handle that component holds is a host-defined resource whose
representation is an index into a table the runtime keeps per store,
naming the owner (the program, or an extension by handle) and the
owner's own handle; the resource's methods are host functions that
forward. Neither WIT nor Zena has anything to add: the component
declares and uses `txn` as any imported resource, and the Zena compiler
gives it the usual class with the usual methods. Concretely:

- The sender walks a call's arguments (or results) by type. A proxy of
  the receiver's resource becomes the receiver's own handle, and an
  owned one leaves the sender's table, since the handle goes back for
  good. A handle the sender owns itself is sent as it is, with its
  position among the call's resources noted.
- The receiver makes a proxy for each noted handle and keeps the rest,
  which are its own. A proxy for a borrowed argument is released once
  the call returns.
- A method call on a proxy is forwarded to the owner with the mapped
  handle as `self`, through the same channel as any other call.
  Dropping a proxy forwards the drop: to an extension's thread, which
  drops the handle in its store, or to the program's forwarder waiting
  on the call in flight, which drops it before the call returns, so
  the program's destructor has run by the time the program sees the
  result.

### Isolation

Each extension has a store of its own, on a thread of its own with a
current-thread tokio runtime, as a `zena:wasm` run has. Calls to an
extension are serialized: one at a time, in order; a second call waits
for the first. The thread holds the `InstancePre`, so a fresh instance
can be made when the old one is lost.

- **Imports.** The extension's imports are resolved through its
  bindings before instantiation, and the error names the first import
  without one. The linker the extension is instantiated with holds
  every host interface, because `wasmtime-wasi` adds its interfaces by
  proposal and cannot leave one out; the bindings are what keep the
  extension to its list, and that is sufficient because a component's
  imports are fixed by its type, so an interface the linker could serve
  beyond them is out of the extension's reach. The extension inherits
  the program's standard output and error.
- **Memory.** `memory-limit` is enforced with a `ResourceLimiter` on
  the extension's store. Wasmtime consults it for linear memory and for
  the GC heap, which is what a Zena component allocates in, so the
  limit covers both. A growth past the limit fails the allocation, and
  a Zena program then traps.
- **Time.** An extension loaded with `call-timeout` runs on the
  interruptible engine, as a `zena:wasm` run with a time limit does,
  and the thread sets the store's epoch deadline before each call.
- **Failure.** A trap, a time limit, or a memory failure poisons the
  extension's store, so the instance is dropped and the next call
  instantiates the component again, with fresh state. The failed call
  returns its error value; the handle stays valid, and so do the
  objects the program made for it. Proxies the program holds to the
  lost instance's resources point at nothing, and a call on one fails.

### The host interface

In `packages/stdlib/zena/host-wit/host.wit`:

```wit
interface extensions {
  /// Where one of an extension's imports comes from.
  variant source {
    host,
    program(string),
    extension(u32),
  }

  record binding {
    name: string,
    served-by: source,
  }

  record load-options {
    memory-limit: u64,
    call-timeout-nanos: s64,
    debug: bool,
  }

  load: func(path: string, bindings: list<binding>, options: load-options) -> result<u32, string>;
  load-trusted: func(path: string, options: load-options) -> result<u32, string>;
  drop: func(extension: u32);
}
```

### The grant

Loading extensions is granted apart from spawning processes:
`--allow-extensions` on `zena-run` and `zena run`, or
`ZENA_ALLOW_EXTENSIONS=1`. `Grant` in `zena-runtime` has a flag per
capability, keeping the path map and debug setting both use. A run
started through `zena:wasm` passes on each grant its caller holds when
asked to (`grant`, `grantExtensions`), so a test runner with both grants
gives tests both, and a program with only `--allow-extensions` can pass
on only that.

### The Zena API

`zena:extensions`, on the `zena-cli` and `component` targets:

```zena
export type LoadOptions = {
  memoryLimit?: i64,
  callTimeout?: Duration,
  debug?: boolean,
};

/** A loaded extension; `handle` is what `attach` takes. */
export final class Extension implements Disposable {
  handle: u32;
  drop(): void;
}

export let fromHost = (name: String): Binding;
export let fromProgram = (name: String, exported: String | null = null): Binding;
export let fromExtension = (name: String, ext: Extension): Binding;

export let loadExtension = (path: String, bindings: Array<Binding>,
    options: LoadOptions = {}): Result<Extension, String>;
export let loadTrustedExtension = (path: String, options: LoadOptions = {}):
    Result<Extension, String>;
```

The program's side of the extension interfaces is ordinary WIT interop:
it declares a world that imports its views of what extensions export
and exports its views of what they import, implements the exported
resources as classes, and awaits each call on an attached object.

### Tests

The host interface is tested from Zena, in the standard library's
tests beside `zena:wasm`'s: `load` with a missing file, an import
without a binding, a binding to an export the program lacks, and a
trusted load are called from the test directly. The call paths need a
program that declares the views, which a test file cannot, so they run
a fixture program built with `--wit` and `--world` by the package's
`build:fixtures` script, through `zena:wasm`, and check what it
prints: calls with arguments and results, calls back served on the
object made for the extension, a trap and a time limit failing one call
and the next call succeeding, a memory limit, dropping, an export the
program lacks a binding for, a type mismatch, two extensions wired
together with the second's calls back reaching the program, and
resources crossing both ways, with a borrow and with drops that reach
their owners. The fixture program is built with `--extension-wit`
against the extensions' document, and the compiler's
`extension-views_test.zena` covers the build-time check rule by rule.

## Alternatives considered

- **A handle as the first parameter of every function.** The runtime
  adds the extension's handle to each call in both directions, and the
  program keeps a table from handle to its state. It works, and the
  example harness in `packages/zena-runtime/examples` still has this
  shape, but the program's functions had to know the extension system,
  and nothing tied a handle to the code serving it. One object per
  extension puts the identity where the program's code already keeps
  state.
- **A fixed set of interfaces served by the host.** The runtime could
  implement storage and the like itself, which would keep the program's
  interface free of extension concerns. The PDS's storage and account
  reads are its own logic and data, so they stay in Zena, and that
  means the program exports them.
- **A stream of the extension's import requests** in place of calls
  back, for a host that could not enter the program while its call was
  in flight. Not needed: wasmtime allows the new task.
- **Failures as traps.** Simpler types, but a host function's error
  traps the calling instance, so one broken extension would end the
  program. The result wrapper is the cost of keeping the program alive.
- **One store for everything.** Calls would need no threads or
  channels, but a trap poisons a store, so an extension's trap would
  end the program too, and one memory limit would cover all of them. A
  store per extension is what makes the limits and the failure rule per
  extension.

## Open questions

- **Resources shared across three parties.** A proxy can only be
  passed back to its owner: an extension handing the program a proxy of
  another extension's resource, or the other way, fails the call. Routing
  such a handle would need the receiver to proxy a proxy.
- Concurrent calls into one extension: one at a time is enough for
  write policy hooks, and a request handler extension may want more.
  Wasmtime's event loop can run several tasks in one store; the thread
  would then take calls while others are in flight.
- `load` blocks the program while the component compiles and
  instantiates. The compile cache makes a second load fast; an async
  `load` would keep a server responsive during the first.
- Where the compiled form is cached on hosts without a lasting disk
  ([pds-extensions.md](./pds-extensions.md), "Open questions").
- Cancelling a call in flight when the program's task is cancelled.
- `zena:wasm`'s `run` written over `load`, a `call` of one export by
  name, and `drop`, with the WASI context as bindings of a kind. The
  two APIs stay separate for now.

## Related

- [pds-extensions.md](./pds-extensions.md): what the PDS needs from
  this.
- [component-model.md](./component-model.md): WIT interop, the import
  and export shapes the program and extension are written with.
- [component-async-exports.md](./component-async-exports.md): how an
  async export's task yields, which is what lets a call back in.
- [wasi.md](./wasi.md) and
  [component-emission.md](./component-emission.md): the `zena-cli`
  target and its host.
