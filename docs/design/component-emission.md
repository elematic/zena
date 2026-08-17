# Component Emission

## Status

- **Status**: C3 is implemented. `--target component` emits
  components; `zena:time`'s `sleep` is a p3 timer on that target, a
  300 ms sleep costing 310 ms of wall time and 20 ms of CPU; `string`
  crosses an export in both directions (`greet("world")` →
  `"hello, world"`); the WIT type encoder round-trips through
  `wasm-tools component wit` and drives every imported interface's
  types; a memory-using program gets the two-core-module shape of 1.3;
  and **a component prints** — `zena:console` over p2 stdio, the
  write's lowering carrying the canonical memory options — and a
  program can declare its own world with `--wit`/`--world`, which
  emission then follows and disagreements with which are compile
  errors. C4 onward is unbuilt. Every load-bearing claim was verified against
  `wasm-tools 1.252.0` / `wasmtime 46.0.0` on 2026-08-08; the
  corrections that building it turned up are marked **Correction**
  below.
- **Scope**: how Zena emits WebAssembly components from its own backend,
  what the `--target` surface should be, and how p3's async timers land
- **Relationship to [component-model.md](./component-model.md)**: that
  document designs _bindgen_ — WIT → Zena symbols, and the marshaling
  glue for rich types. This one covers **emission**, which is stage 6
  there, listed after bindgen and the canonical ABI. Emission is
  independent of both and should land first. Nothing here changes the
  bindgen design.

---

## Overview

Zena has a unified toolchain: one compiler, one CLI, `nix flake check`
as CI. Component emission belongs inside `BinaryEmitter` alongside core
module emission, not behind a shell-out to `wasm-tools`. Part 4
describes the encoder; Part 1 establishes that the output shape is
already understood, by building it by hand and running it.

Emitting a component is not blocked on bindgen. Bindgen binds WIT
symbols into Zena's type system and generates the marshaling glue for
rich types; a component with flat-scalar imports needs neither. The
WIT parser _is_ needed earlier than expected, but for encoding the
component **type** section rather than for synthesizing Zena symbols —
a distinct job (Part 4).

WASI Preview 3 is reachable only through a component. A core module can
import `wasi_snapshot_preview1` and nothing later: wasmtime rejects a p3
import in a core module outright (1.9). There is no p3 core-module form
to choose between, so the component target _is_ the WASI target. What a
target names is the host, with the output form following from it, which
puts the set at four: `js`, `zena-cli`, `freestanding` and `component`
(Part 3).

The immediate prize is non-blocking timers. p1 can read a clock but can
only wait by blocking. p3's `wait-for`, lowered async, returns
immediately and the host re-enters the guest through a callback when it
fires. Zena's `Clock` interface already has the right shape for this, so
it lands as a host driver rather than as new async semantics (Part 5).

---

## Part 1: Evidence

Each of these was run end-to-end. Nothing below is inference.

The inputs are components written by hand at the component level — the
structure the compiler is meant to emit — assembled with `wasm-tools
parse` and run under `wasmtime`. The two load-bearing ones (1.4, 1.7)
are reproduced in full, so anything here can be re-run from this
document.

When the encoder lands, these become tests. The timer one should assert
**CPU time as well as wall time**: a regression from a real sleep back to
a blocking or spinning wait otherwise shows up only as a test that is
slower than it should be.

> **Not in question**: whether a component can contain a WasmGC core
> module. Components accept any valid core Wasm; the boundary is defined
> by the canonical ABI, not by what the module does internally. What that
> costs us is marshaling between linear memory and GC types at the
> boundary, which is bindgen's problem rather than emission's.
> [component-model#525](https://github.com/WebAssembly/component-model/issues/525),
> "Wasm GC Support in the Canonical ABI", is the pre-proposal that would
> remove the marshaling; it is open, and being implemented in `wasm-tools`
> and `wasmtime` by its author.

### 1.1 Emitting the component ourselves

A component written by hand at the component level, with explicit
`canon lower` / `canon lift` and core-instance wiring around a core
module importing p3 clocks:

```wat
(component
  (core module $m
    (import "clocks" "now" (func $now (result i64)))
    (func (export "run") (result i64) …))
  (import "wasi:clocks/monotonic-clock@0.3.0"
    (instance $c (export "now" (func (result u64)))))
  (alias export $c "now" (func $nowc))
  (core func $nowl (canon lower (func $nowc)))
  (core instance $ci (export "now" (func $nowl)))
  (core instance $mi (instantiate $m (with "clocks" (instance $ci))))
  (func $run (result u64) (canon lift (core func $mi "run")))
  (export "run" (func $run)))
```

Parses, validates (`--features all`), and runs. **304 bytes total**,
including the embedded core module — the component shell is ~150 bytes
of sections.

### 1.2 Minimal interface subsets

`wasm-tools component new` on a single `import wasi:cli/stdout@0.2.8`
produced a 447-line component transcribing `wasi:io/error`,
`wasi:io/poll` and `wasi:io/streams` in full — every method of
`input-stream` and `output-stream`, `pollable`, all of it.

We do not have to do that. An import instance type is satisfied by any
host instance with _at least_ those exports, so declaring only the parts
we call validates and runs. Verified by declaring one method of
`output-stream` and one function of `wasi:cli/stdout` (1.4).

This is the largest cost reduction available to a direct encoder: 447
lines become about twenty.

### 1.3 Module structure without the shim

`wasm-tools` produces components containing **three** core modules — the
main module, a `wit-component-shim-module` holding a 15-entry funcref
table and `call_indirect` trampolines, and a `wit-component-fixup`
module. Some background, since this is surprising on first contact.

**Why core modules at all, inside a component?** A component contains no
executable code of its own. All code lives in core modules nested inside
it; the component contributes types, instantiation, and the canonical
`lift`/`lower` adapters that convert between component-level values and
core-level ones. See the Component Model
[Explainer](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md)
and
[Binary.md](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Binary.md).

**Where do they live, and who instantiates them?** All in one `.wasm`
file, nested inside the component, instantiated by the component's own
core-instance section in declaration order:

```wat
(core instance $wit-component-shim-instance (instantiate $wit-component-shim-module))
(core instance $cm32p2|wasi:io/error@0.2 …)      ;; lowered imports, wired from the shim
…
(core instance $main (instantiate $main …))
(core instance $fixup (instantiate $wit-component-fixup …))
```

**Why the shim exists.** Lowering an import that takes a `string` or
`list` requires the guest's `memory` and `realloc` as canonical options,
because that is where the lifted value gets written. But those live in
the main module, and the main module cannot be instantiated until its
imports — the lowered functions — already exist. That is a cycle, and it
is not hypothetical:

```wat
(core func $fl (canon lower (func $fi) (memory $mem) (realloc $ra)))
…
(core instance $mi (instantiate $m (with "c" (instance $ci))))
(alias core export $mi "memory" (core memory $mem))
```

```
error: unknown core memory: failed to find name `$mem`
```

The shim breaks it with indirection: instantiate a module of
`call_indirect` trampolines through an empty table, instantiate the main
module against those, then instantiate a fixup module whose element
segment fills the table with the real lowered functions.

**Do all components need this?** No. It is a consequence of
componentizing a module that is already finished. `wasm-tools` receives
a core module that defines and exports its own memory, and has no
license to change it, so indirection is the only move left. We are the
compiler, and can put the memory somewhere reachable first:

```wat
(core module $memmod
  (memory (export "memory") 1)
  (func (export "realloc") (param i32 i32 i32 i32) (result i32) …))
(core instance $memi (instantiate $memmod))
(alias core export $memi "memory" (core memory $mem))
(alias core export $memi "realloc" (core func $ra))
(core func $wl (canon lower (func $wi) (memory $mem) (realloc $ra)))
…
(core instance $mi (instantiate $m (with "c" (instance $ci))
                                   (with "mem" (instance $memi))))
```

The main module **imports** its memory instead of defining it, so
nothing needs to exist before the lowering does. This avoids the shim and
fixup modules entirely, and 1.4 confirms it end to end. The only
compiler change is emitting a memory import rather than a memory
definition, at `WasmModule.ensureMemory`.

**Is anyone fixing it upstream?** Not as such, and there is no open issue
proposing to remove the shim — for `wasm-tools` it is not removable,
given the input it is handed. The two shim issues on record are closed
housekeeping PRs ([#853](https://github.com/bytecodealliance/wasm-tools/pull/853),
[#1851](https://github.com/bytecodealliance/wasm-tools/pull/1851)). The
forward-looking item is component-model#525 above: GC support in the
canonical ABI would remove most of the lowerings that need a memory in
the first place.

**How few core modules can we get away with?** One, or two. A component
cannot define a core memory of its own —

```wat
(component
  (core memory (;0;) 1))
```

```
error: expected valid component field
```

— so a memory reaches the component only as the export of a core
instance. That costs nothing in the export direction, because lifting
happens after instantiation: a component that exports but imports
nothing memory-carrying takes `memory` and `realloc` from the program
module's own exports, and one core module is the whole component.

```wat
(component
  (core module $m
    (memory (export "memory") 1)
    (global $bump (mut i32) (i32.const 1024))
    (func $realloc (export "realloc")
        (param $p i32) (param $olds i32) (param $align i32) (param $news i32)
        (result i32)
      (local $r i32)
      (global.set $bump
        (i32.and (i32.add (global.get $bump) (i32.sub (local.get $align) (i32.const 1)))
                 (i32.sub (i32.const 0) (local.get $align))))
      (local.set $r (global.get $bump))
      (global.set $bump (i32.add (global.get $bump) (local.get $news)))
      (if (local.get $p)
        (then (memory.copy (local.get $r) (local.get $p) (local.get $olds))))
      (local.get $r))
    (data $msg "one core module, memory from main")
    (func (export "greet") (result i32)
      (local $s i32) (local $ret i32)
      (local.set $s (call $realloc (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 33)))
      (memory.init $msg (local.get $s) (i32.const 0) (i32.const 33))
      (local.set $ret (call $realloc (i32.const 0) (i32.const 0) (i32.const 4) (i32.const 8)))
      (i32.store (local.get $ret) (local.get $s))
      (i32.store offset=4 (local.get $ret) (i32.const 33))
      (local.get $ret)))
  (core instance $mi (instantiate $m))
  (alias core export $mi "memory" (core memory $mem))
  (alias core export $mi "realloc" (core func $ra))
  (func $greet (result string)
    (canon lift (core func $mi "greet") (memory $mem) (realloc $ra)))
  (export "greet" (func $greet)))
```

```
$ wasmtime run --invoke 'greet()' e2.wasm
"one core module, memory from main"
```

452 bytes, and the host read a guest-allocated string out of the guest's
own memory.

The second module appears when an import is lowered with memory options,
and it brings a consequence for the allocator. The canonical `realloc`
has to be a core function that already exists at the point of lowering,
which is before the program module is instantiated — so it cannot be the
program's own allocator. Two allocators handing out addresses in one
memory is a bug waiting to happen, so the runtime module owns linear
memory and the allocator, and the program module imports both:

```wat
  (core module $rt
    (memory (export "memory") 1)
    (global $bump (mut i32) (i32.const 1024))
    (func $realloc (export "realloc") …))
  (core instance $rti (instantiate $rt))
  (alias core export $rti "memory" (core memory $mem))
  (alias core export $rti "realloc" (core func $ra))
  (core func $wl (canon lower (func $wi) (memory $mem) (realloc $ra)))
  …
  (core module $m
    (import "mem" "memory" (memory 1))
    (import "mem" "realloc" (func $alloc (param i32 i32 i32 i32) (result i32)))
    (import "c" "write" (func $write (param i32 i32 i32 i32)))
    (data $msg "written from memory the program allocated itself\n")
    (func (export "run") (result i32)
      (local $p i32) (local $ret i32)
      (local.set $p (call $alloc (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 49)))
      (memory.init $msg (local.get $p) (i32.const 0) (i32.const 49))
      (call $write (call $getout) (local.get $p) (i32.const 49) (i32.const 16))
      …))
  (func $run (result string)
    (canon lift (core func $mi "run") (memory $mem) (realloc $ra)))
```

```
$ wasmtime run --invoke 'run()' e3.wasm
written from memory the program allocated itself
"written from memory the program allocated itself"
```

One buffer, allocated by the runtime module's allocator, written by the
program, read by the host twice — once through a lowered `list<u8>`
argument and once through the lifted `string` result. The elided import
types are those in 1.4.

Putting `realloc` in the program module instead would mean the runtime
module calling back into a function that does not exist yet, through a
funcref table filled after instantiation. That is the shim, arrived at
from the other direction.

### 1.4 Native p2 stdio beside p3 clocks

1.1–1.3 together. Note how little of `wasi:io/streams` is declared — one
method — and that the main module imports its memory from `$memmod`:

```wat
(component
  (type $t-err (instance (export "error" (type (sub resource)))))
  (import "wasi:io/error@0.2.8" (instance $ioerr (type $t-err)))
  (alias export $ioerr "error" (type $error))
  (type $t-streams (instance
    (alias outer 1 $error (type (;0;)))
    (export (;1;) "error" (type (eq 0)))
    (type (;2;) (own 1))
    (type (;3;) (variant (case "last-operation-failed" 2) (case "closed")))
    (export (;4;) "stream-error" (type (eq 3)))
    (export (;5;) "output-stream" (type (sub resource)))
    (type (;6;) (borrow 5))
    (type (;7;) (list u8))
    (type (;8;) (result (error 4)))
    (type (;9;) (func (param "self" 6) (param "contents" 7) (result 8)))
    (export "[method]output-stream.blocking-write-and-flush" (func (type 9)))))
  (import "wasi:io/streams@0.2.8" (instance $io (type $t-streams)))
  (alias export $io "output-stream" (type $os))
  (type $t-stdout (instance
    (alias outer 1 $os (type (;0;)))
    (export (;1;) "output-stream" (type (eq 0)))
    (type (;2;) (own 1))
    (type (;3;) (func (result 2)))
    (export "get-stdout" (func (type 3)))))
  (import "wasi:cli/stdout@0.2.8" (instance $so (type $t-stdout)))
  (type $t-clock (instance (export "now" (func (result u64)))))
  (import "wasi:clocks/monotonic-clock@0.3.0" (instance $c (type $t-clock)))

  ;; memory lives in its own core module, instantiated first
  (core module $memmod
    (memory (export "memory") 1)
    (func (export "realloc") (param i32 i32 i32 i32) (result i32) (i32.const 1024)))
  (core instance $memi (instantiate $memmod))
  (alias core export $memi "memory" (core memory $mem))
  (alias core export $memi "realloc" (core func $ra))

  (alias export $so "get-stdout" (func $gsi))
  (alias export $io "[method]output-stream.blocking-write-and-flush" (func $wi))
  (alias export $c "now" (func $nowi))
  (core func $gsl (canon lower (func $gsi)))
  (core func $wl  (canon lower (func $wi) (memory $mem) (realloc $ra)))
  (core func $nowl (canon lower (func $nowi)))
  (core instance $ci
    (export "get-stdout" (func $gsl))
    (export "write" (func $wl))
    (export "now" (func $nowl)))

  (core module $m
    (import "c" "get-stdout" (func $getout (result i32)))
    (import "c" "write"      (func $write (param i32 i32 i32 i32)))
    (import "c" "now"        (func $now (result i64)))
    (import "mem" "memory" (memory 1))
    (type $b (struct (field i64)))
    (data $msg "native p2 stdio, no adapter, no shim\n")
    (func (export "run") (result i64)
      (memory.init $msg (i32.const 128) (i32.const 0) (i32.const 37))
      (call $write (call $getout) (i32.const 128) (i32.const 37) (i32.const 16))
      (struct.get $b 0 (struct.new $b (call $now)))))
  (core instance $mi (instantiate $m (with "c" (instance $ci))
                                     (with "mem" (instance $memi))))
  (func $run (result u64) (canon lift (core func $mi "run")))
  (export "run" (func $run)))
```

```
$ wasmtime run -W gc=y,function-references=y -S p3=y --invoke "run()" out.wasm
native p2 stdio, no adapter, no shim
5650236
```

A resource handle, a `list<u8>` lowering, a variant carrying
`own<error>`, and p2 and p3 interfaces in the same component.

### 1.5 p3 imports go through the existing `@external`

```wat
(import "wasi:clocks/monotonic-clock@0.3.0" "now" (func $now (result i64)))
```

which is what a Zena `@external` already compiles to:

```zena
@external("wasi:clocks/monotonic-clock@0.3.0", "now")
declare function monotonicNow(): u64;
```

So no new declaration syntax is needed to _name_ a p3 import, for any
function whose canonical lowering is flat scalars: `u8`–`u64`,
`s8`–`s64`, `f32`, `f64`, `bool`, `char`, `enum`, small `flags`.

### 1.6 Async imports lower to a non-blocking call

`wait-for: async func(how-long: duration)` under `canon lower … async`
becomes core `(param i64) (result i32)`, and calling it returned **17** =
`(subtask 1 << 4) | STARTED`. It handed back a subtask handle rather than
blocking.

Lowered _without_ `async` — which is what `component embed --dummy`
generates — the same function becomes a plain blocking `(param i64)`.
Both are legal; the choice is ours, and it is the difference between a
sleep and a timer.

The same asymmetry applies to exports: an `async` WIT function can be
lifted synchronously, verified via `--dummy` on
`doit: async func() -> u32`, which produced a plain `(func (result i32))`.
`async` in a WIT signature therefore costs us nothing on its own. It is
`stream<T>` and `future<T>` **values** that require the suspension
transform.

### 1.7 A callback-lifted export drives real timers

The complete event-loop shape, and the structure C2 has to emit:

```wat
(component
  (import "wasi:clocks/monotonic-clock@0.3.0"
    (instance $c (export "wait-for" (func async (param "how-long" u64)))))
  (alias export $c "wait-for" (func $wfi))
  (core module $m
    (import "c" "wait-for"         (func $wf    (param i64) (result i32)))
    (import "c" "waitable-set.new" (func $wsnew (result i32)))
    (import "c" "waitable.join"    (func $wjoin (param i32 i32)))
    (import "c" "subtask.drop"     (func $sdrop (param i32)))
    (import "c" "task.return"      (func $tret))
    (global $ws (mut i32) (i32.const 0))
    (global $sub (mut i32) (i32.const 0))
    ;; returns a callback code: EXIT=0, WAIT=2 | (set << 4)
    (func (export "run") (result i32)
      (local $r i32)
      (global.set $ws (call $wsnew))
      (local.set $r (call $wf (i64.const 900000000)))  ;; 900ms
      (if (i32.eq (i32.and (local.get $r) (i32.const 15)) (i32.const 0))
        (then (call $tret) (return (i32.const 0))))    ;; RETURNED already
      (global.set $sub (i32.shr_u (local.get $r) (i32.const 4)))
      (call $wjoin (global.get $sub) (global.get $ws))
      (i32.or (i32.const 2) (i32.shl (global.get $ws) (i32.const 4))))
    ;; (event, waitable, code) -> callback code
    (func (export "cb") (param i32 i32 i32) (result i32)
      (call $sdrop (global.get $sub))
      (call $tret)
      (i32.const 0)))
  (core func $wfl   (canon lower (func $wfi) async))
  (core func $wsnew (canon waitable-set.new))
  (core func $wjoin (canon waitable.join))
  (core func $sdrop (canon subtask.drop))
  (core func $tret  (canon task.return))
  (core instance $ci
    (export "wait-for" (func $wfl))
    (export "waitable-set.new" (func $wsnew))
    (export "waitable.join" (func $wjoin))
    (export "subtask.drop" (func $sdrop))
    (export "task.return" (func $tret)))
  (core instance $mi (instantiate $m (with "c" (instance $ci))))
  (alias core export $mi "run" (core func $runc))
  (alias core export $mi "cb" (core func $cbc))
  (func $run async (canon lift (core func $runc) async (callback $cbc)))
  (export "run" (func $run)))
```

`run` starts the timer and hands the host back `WAIT | (set << 4)`
instead of blocking; the host re-enters through `cb` when it fires, which
drops the subtask and calls `task.return`.

**Correction.** The `(i32.and … 15) (i32.const 0)` test above is
commented "RETURNED already" and is not: the low four bits are a
`CallState`, and `0` is `STARTING` while `RETURNED` is `2`. The branch
never ran here — a 900 ms timer does not complete inside its own
lowering — so the reference was right by never taking it. It matters in
the callback, which is delivered **more than once**: a subtask reports
`STARTED` before it reports `RETURNED`, and dropping one that has not
resolved traps with `cannot drop a subtask which has not yet resolved`.
Anything short of `RETURNED` has to go straight back to waiting.

Two more the running code needed, neither visible in a single-timer
reference:

- **The waitable set is a handle too.** Leaving it alive at
  `task.return` fails the run with `resource not present`, and dropping
  it while a subtask is still joined fails with `resource has children`.
  Drop the subtask, then the set, then return.
- **At most one `wait-for` in flight.** The drain runs more than once
  before the host takes over — once inside the program, once in the
  entry — and a `Clock.waitNs` that arms unconditionally leaves the
  first subtask orphaned in the set, owned and never dropped. The
  second wait is also the one that traps the drop, since the handle the
  driver remembers is no longer the handle that fired.

Measured: a **900 ms** timer completed in **0.919 s** wall with **47 ms**
of user+sys — the process slept. At 200 ms, 0.245 s.

Two syntax notes that cost time: the lifted export's own component type
must be async (`(func $run async (canon lift … async (callback $cb)))`),
and `(callback …)` takes a core func _index_, so the core export must be
aliased first (`(alias core export $mi "cb" (core func $cbc))`).

### 1.8 A p3 command component runs under `wasmtime run`

Exporting the async `run` above as `wasi:cli/run@0.3.0`:

```wat
(func $run async (result (result)) (canon lift (core func $runc) async (callback $cbc)))
(instance $runi (export "run" (func $run)))
(export "wasi:cli/run@0.3.0" (instance $runi))
```

```
$ wasmtime run -S p3=y p3cmd.wasm     # no --invoke
real 0m0.456s   user 0m0.064s
```

So a Zena program that is a command compiles to a component exporting
`wasi:cli/run@0.3.0`, and `wasmtime run` executes it directly, with the
async event loop live through the callback. There is no separate
"command module" to emit.

### 1.9 A core module cannot reach p3

```wat
(module
  (import "wasi:clocks/monotonic-clock@0.3.0" "now" (func $now (result i64)))
  (func (export "_start") (drop (call $now))))
```

```
$ wasmtime run -S p3=y,cli=y coretest.wasm
Error: failed to instantiate "coretest.wasm"
       unknown import: `wasi:clocks/monotonic-clock@0.3.0::now` has not been defined
```

WASI p1 is a core-module ABI: a flat set of `wasi_snapshot_preview1`
function imports, which wasmtime still supplies to core modules. WASI p2
and p3 are defined as WIT interfaces, and a core module has no way to
name one. Emitting a component is therefore not one way to reach p3; it
is the only way.

### 1.10 What does not work

**Custom `--adapt` stubs panic wit-component.** The obvious workaround
for Part 2's blocker — supplying the `env` stack-trace imports from a
hand-written stub module — crashes:

```
thread 'main' panicked at crates/wit-component/src/encoding.rs:2836:34:
internal error: entered unreachable code
```

`--adapt` is for WASI-adapter-shaped modules only. A world declaring an
import the core module never uses hits the same panic, which settles
open question 4 in component-model.md: a dead-code-eliminated import must
not stay in the emitted world. Both stop mattering once we emit
components ourselves.

---

## Part 2: The blocker on the module side

Every Zena module — including `export let main = (): i32 => 7;`, with
nothing else in it — unconditionally imports:

```wat
(import "env" "formatStackTrace" (func (param anyref) (result externref)))
(import "env" "captureStackTrace" (func (result externref)))
```

They come from `stdlib/zena/error.zena` and are not dead-code
eliminated. `externref` and `anyref` have no Component Model
representation, so they cannot be declared in a world, and per 1.10 they
cannot be stubbed by an adapter either.

**Fix**: make the hooks target-conditional, as `zena:console` already is
— `error/stack-host.zena` keeps the two `@external` declarations,
`error/stack-none.zena` returns `null` from both, and `error.zena`
imports them from `'zena:error-stack'`. One file split, one manifest
entry, one import line. The `js` and `zena-cli` targets keep the host
hooks; the `component` target does not get stack traces until there is
somewhere to put them.

---

## Part 3: Targets

### What the target selects

The target string does nothing in codegen. Grepped across the
self-hosted compiler, its only consumer is `ModuleResolver`, selecting
`virtual` entries in the stdlib manifest; `BinaryGenerator` and
`ReachabilityAnalysis` take a `target` and never branch on it. A target
is a choice of standard-library implementations and therefore of import
set. Adding one is a manifest-and-stdlib exercise.

### Import sets today

Measured, `zena-cli build` on `export function main(): i32 { return 7; }`:

| Target     | Imports                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`     | `console.log_i32`, `log_f32`, `log_string`, `info_string`, `warn_string`, `error_string`, `debug_string`; `env.captureStackTrace`, `formatStackTrace` |
| `zena-cli` | `env.captureStackTrace`, `formatStackTrace`; `wasi_snapshot_preview1.fd_write`                                                                        |

Both export `main` and the string helpers `$stringCreate`,
`$stringSetByte`, `$stringGetByte`, `$stringGetLength`; `zena-cli` also
exports `memory`.

**Correction.** Those numbers predate the dead-code-elimination work of
docs/design/binary-size.md. Re-measured on the same program: the floor
is **zero** on both, and the export list is `main` alone — 37 bytes.
What the table describes is a program that _constructs an `Error`_,
which reaches the stack-trace hooks through the constructor; that is
still two imports on a target whose host has them, and zero on
`freestanding` since C0 split them out. The rest of the section stands:
the floor is a property of the target rather than of the program.

A program that calls `logString` imports exactly the same set as one
that prints nothing. The import list is a property of the target, not of
the program, for two reasons: `zena:console` is in the prelude
(`lib/prelude.zena` binds `console` into every module) and the
module-level `export let console = new WasiConsole()` is a root; and the
stack-trace hooks of Part 2 are unconditional. So the floor today is
nine imports on `host` and three on `zena-cli`, for a program that uses
none of them.

### WASI versus the Component Model

The Component Model is a binary format, type system and ABI. WASI is a
set of interfaces. They are separable in principle — a component can
import a purely application-defined world and no WASI at all — but not
in practice at the version boundary:

| WASI    | Form                                       | Reachable from |
| ------- | ------------------------------------------ | -------------- |
| p1      | flat `wasi_snapshot_preview1` core imports | core module    |
| p2 / p3 | WIT interfaces                             | component only |

1.9 is the demonstration. Because there is no p3 core-module form, a
separate "wasi" target and "component" target would always select the
same thing, and the component target is the WASI target.

### Three axes, one flag

Three things vary between outputs:

1. **Output form** — core module or component.
2. **Host imports** — none, the JS runtime, `zena-cli`'s p1 and `env`
   surface, or a WIT world.
3. **String encoding** — how `String` is represented, and how it crosses
   the boundary.

The first two are not independent. p2 and p3 are reachable only from a
component (1.9); the JS runtime's `console.log_string` and `zena-cli`'s
`env` hooks are reachable only from a core module. A second flag would
offer eight combinations, three of which cannot be built at all: a core
module importing a WIT world, and a component importing either host
runtime. The combination it would legitimately add — a component that
imports nothing — is a `component` build whose world has no imports.
**The target names the host; the output form follows from it.**

String encoding is different: it varies _within_ a target, and it is the
one that deserves its own flag.

### Recommendation

```
--target  js | zena-cli | freestanding | component
```

| Target         | Output      | Imports                                                                         |
| -------------- | ----------- | ------------------------------------------------------------------------------- |
| `js`           | core module | `@zena-lang/runtime` — `console.*`, `time.*`, `env.*`; later JS string builtins |
| `zena-cli`     | core module | WASI p1, plus the private `env.*` and `zena_process`                            |
| `freestanding` | core module | none beyond what the program declares with `@external`                          |
| `component`    | component   | WIT interfaces: p3 clocks, p2 stdio, application worlds                         |

Four points this settles:

- **No portable `wasip1` or `wasip2` target.** Zena has no users to keep
  on an older preview, so a portable p1 target would be a second
  supported surface bought with nothing. p1 does not disappear — it stays
  as `zena-cli`'s private business, where the Rust embedder supplies it
  through `wasmtime-wasi`. So the existing p1 standard library
  (`zena:fs`, `zena:cli`, `zena:console`'s WASI variant) is kept, not
  deleted; it just stops being something a portable program targets.
- **A core-module host is not the same as a JS host**, and neither is
  the same as no host. They differ in their whole import set, which is
  exactly what a target is.
- **The name is `freestanding`, not `core`.** Three of the four targets
  emit core modules, so `core` would name the axis that does not
  distinguish them. `freestanding` is the term of art for a target that
  assumes no runtime beneath it.
- **No `--emit` flag.** Output form follows from the target, so the flag
  an earlier draft proposed is unnecessary. That draft also argued
  against naming a target `component` on the grounds that it would be
  ambiguous about which preview it meant. Dropping p1 and p2 as portable
  targets removes the ambiguity and the argument with it.

The remaining flags concern the world, not the target:

- `--wit <path>` — a WIT file, or a directory whose `.wit` files are
  concatenated in name order, defining the world.
- `--world <name>` — which world in it; optional when the document
  declares exactly one.

They are **input**: a world the program is compiled against, not a WIT
generator. Without them the world is _derived_ — the import surface is
whatever `@external` declarations the program reached, typed from the
Zena signatures (or from the WIT the compiler carries, for the WASI
interfaces the standard library binds), and the exports are the
program's own. The derived world is only observable from the binary,
where `wasm-tools component wit` prints it back.

With them, the declared world is the authority, and that means two
things which are really one mechanism:

- **Emission follows the WIT.** The component's type and import
  sections are encoded from the world's interfaces — the encoder's
  original mode — so the component imports exactly what the world
  imports, used by the program or not, plus the `use` dependencies WIT
  implies. This is also what makes user-declared richer types on the
  boundary expressible at all: a Zena declaration is core-shaped and
  cannot spell `own` or `list<u8>`.
- **Disagreements are errors.** Every `@external` must name a function
  of an interface the world explicitly imports, with a core signature
  matching the WIT's canonical flattening (a count-level check: a
  missing return-area pointer, a forgotten parameter, or a sync
  declaration against an async function all fail by name). The export
  surfaces must agree in both directions — a world export the program
  does not provide, a program export the world does not declare, and a
  type or asyncness mismatch on one they share are all compile errors,
  not components that fail at instantiation.

The relationship is the one a declaration file has to an
implementation: the WIT declares the boundary, the Zena program
implements it, and the compiler both emits from and checks against the
declaration. A world may import the WASI interfaces the compiler
carries WIT for (`wasi:cli`/`wasi:io` at 0.2.8) by name without
vendoring them; a document that declares those packages itself
overrides the carried copies.

### The freestanding target

A module for a host that provides nothing: an embedder that instantiates
Zena, calls an export, and offers no imports at all. Its import list
contains only what the program itself declared with `@external`, which
is what makes it a spectrum — the program spans it, rather than a flag.
The floor is zero, and the ceiling is whatever the program writes down.

The guarantee is structural rather than a matter of discipline. A target
that has no `virtual` entry for `zena:console` cannot resolve
`import {logString} from 'zena:console'`, and the program fails to
compile. Nothing silently supplies a host import behind the program's
back.

Its exports are the general-purpose interop surface the measurement
above already shows: `main`, and the string helpers `$stringCreate` /
`$stringSetByte` / `$stringGetByte` / `$stringGetLength`, so a host can
build and read Zena strings without knowing their layout. Array helpers
are the obvious next addition, and the same reasoning applies to them.

Two things stand between HEAD and a zero-import module, both measured
above: the stack-trace hooks, which C0 splits out anyway, and the
prelude's `console` binding.

**Console on freestanding**: drop it from the prelude, so `console.log`
is an unresolved name and a program that wants output declares its own
`@external`. A no-op console is the tempting alternative and it is
worse, because it compiles and then prints nothing. Making the binding
lazy, so that an unused `console` is dead-code eliminated on every
target, is worth doing on its own, but it is a size fix rather than a
guarantee: it would leave the floor depending on what the optimizer
managed rather than on what the target promises.

### String encoding

`String` is a view into a `ByteArray` with an `Encoding` of `WTF8` or
`WTF16` (`stdlib/zena/string.zena`). The enum exists and nothing selects
`WTF16`; literals are emitted as WTF-8 bytes. Three consumers will want
a say:

- The canonical ABI takes a `string-encoding` option — `utf8`, `utf16`,
  `latin1+utf16` — on every lift and lower. Declaring `utf8` against
  WTF-8 literals makes the boundary a copy; anything else transcodes.
- A JS host wants UTF-16, and JS string builtins would make `String` an
  `externref` rather than a GC byte array, which changes the
  representation and not only the boundary.
- A non-JS embedder reading `$stringGetByte` wants to know which it is
  getting.

So `--string-encoding utf8 | utf16`, defaulting per target and
overridable, is a real flag rather than a hypothetical one. It is not
needed before C3, where it becomes a canonical option; `latin1+utf16` is
available in the ABI but not something we can produce without a Latin-1
representation.

C3.1 takes the default and does not encode it: a lift with no
string-encoding option is `utf8`, and the conversions copy a String's
bytes verbatim. That is right for every string a component can build,
because a WTF-16 String comes from JS interop and the `js` target is not
this one — but it is an assumption the flag would make checkable rather
than assumed, and `String` exposes no public `encoding` to check it
against today.

### Where p2 still appears

The `component` target imports **p2 stdio** alongside p3 clocks, because
p3's `wasi:cli/stdout` is `write-via-stream: func(data: stream<u8>) ->
future<…>` and streams need Track G. p2's `blocking-write-and-flush` is
synchronous and available now. 1.4 is exactly this combination in one
component.

This is not a p2 target. It is one component importing the best
available interface for each job, which is normal: worlds mix versions,
and the mixture changes when Track G lands and stdio moves to p3.

---

## Part 4: The encoder

For the component in 1.4 — the realistic target — the full section list
is:

| Section           | Contents                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| header            | `\0asm\0d\00\01\00`                                                                                                            |
| component type    | one instance type per imported interface, minimal subset                                                                       |
| import            | one per interface, referencing its type                                                                                        |
| alias             | `alias export` per imported function and type                                                                                  |
| canon             | `canon lower` per import; `waitable-set.new`, `waitable.join`, `subtask.drop`, `task.return`                                   |
| core module       | the memory module, then the Zena module, embedded verbatim                                                                     |
| core instance     | instantiate the memory module; synthesize the import instance; instantiate the main module                                     |
| alias core export | pull `run` / `cb` back out of the main instance, plus `cabi_realloc`, `cabi_post_return` and `memory` where a `string` crosses |
| canon             | `canon lift` per export, `async (callback …)` where needed                                                                     |
| export            | the component's exports                                                                                                        |

Every one of those is LEB128 and index vectors. `BinaryEmitter` already
has the primitives, and none of this touches ZIR, lowering, or the type
system. Two choices keep it small: minimal interface subsets (1.2) and
the imported memory (1.3). The core module section holds two modules
here, and one for a component that lowers nothing memory-carrying,
against `wasm-tools`'s three plus a funcref table.

### Where the WIT parser is used

The component **type** section is a transcription of the WIT type graph
— instance types, resource declarations, `alias outer` for shared types,
variants, results, lists. Encoding it from resolved WIT is what
`packages/wit-parser` was built to feed and has never been asked to do.

This is not a contradiction of "emission is not blocked on bindgen". Two
different jobs share the name:

- **Type encoding** — resolved WIT → component type section. Needed as
  soon as an import is more than flat scalars. Produces bytes.
- **Bindgen** — WIT → Zena symbols a program can `import`, with
  marshaling glue. That is component-model.md's design, and it is not
  needed to emit a component.

C1 hand-writes the few type encodings it needs — for clocks, which are
flat scalars, that is none. C3 replaces them with the parser-driven
encoder. Bindgen stays downstream of both.

---

## Part 5: Async timers

### Why p3 clocks matter

p1 can read a clock through `clock_time_get`, but the only way it can
wait is `poll_oneoff`, and `stdlib/zena/time/wasi.zena` says so in its
own comment:

> Blocks the module until the deadline, so this always returns true.

p3's `wait-for` and `wait-until` are `async`, and async-lowered they
return immediately (1.6). That is a new capability rather than a nicer
spelling of an existing one.

### Why it unifies with the JS driver

`zena:time`'s `Clock` interface already draws the right line:

```zena
/**
 * … cannot wait, and has instead arranged to re-enter the drain later —
 */
waitNs(ns: i64): boolean;
```

`true` means "I blocked until the deadline"; `false` means "I scheduled a
wake and the drain should unwind; you will be re-entered".

| Driver                | `waitNs` | Re-entry                                 |
| --------------------- | -------- | ---------------------------------------- |
| `time/wasi.zena` (p1) | `true`   | it blocked                               |
| **p3 component**      | `false`  | the lifted callback calls `__zena_drain` |

The p3 timer would be the **only** `Clock` on the `false` path. An
earlier revision of this table listed `time/host.zena` (JS) there, and
that is no longer true: A3 made the JS timer an ordinary host-async
binding over `setTimeout`, so `time/host.zena` installs no `Clock` and
never reaches `queue.zena` ([async.md](async.md) §4, "Timers are not
special"). The path is unused rather than shared — still the right one
to land on, and still no change to `queue.zena`'s park/drain loop, but
p3 would be its first implementation.

### What it costs in the compiler

1. **Async-lowered imports.** A way to mark an `@external` as
   `canon lower … async`. The Zena signature is unaffected; only the
   lowering option changes.
2. **The canon builtins as imports**: `waitable-set.new`,
   `waitable.join`, `subtask.drop`, `task.return`. One `canon` entry and
   one core import each; they are not WIT functions and need no types.
3. **A callback-lifted entry export.** The compiler synthesizes the
   `(event, waitable, code) -> i32` callback: look the waitable up in the
   completer registry, resolve it, call `__zena_drain`, then return
   `WAIT | (set << 4)` if work remains, or `task.return` and `EXIT` if
   not.

This is a new async **host driver**, in the same sense as the JS push
driver, rather than new async semantics. It sits alongside
[concurrency.md](./concurrency.md)'s Track G, and looks easier than the
JSPI driver the implementation plan currently sequences first, because
the push shape already matches.

---

## Part 6: The plan

### C0 — unblock the module. **Done.**

Split the stack-trace hooks out of `zena:error` (Part 2). Rename `host`
to `js` and retire the unused `wasi` manifest key, keeping aliases. No
emission work; this is the prerequisite for all of it.

The same split delivers `--target freestanding`, since a module with no
stack-trace imports and no prelude `console` is a module with no imports
at all. It is a manifest entry and a prelude change on top of work C1
needs regardless, and it is testable by assertion rather than by
inspection: compile a program, and the import section is empty. Nine and
three, from the measurement in Part 3, are the numbers it has to drive
to zero.

### C1 — the encoder, flat scalars only. **Done.**

Emit components from `BinaryEmitter` (Part 4), restricted to flat-scalar
imports and exports, which need no memory, no realloc, and no type
encoding beyond primitives. Ships `--target component` for a program
whose only import is `wasi:clocks/monotonic-clock@0.3.0`. Verifiable as
1.1 was.

### C2 — async timers. **Done.**

Async-lowered imports, the canon builtins, and the callback-lifted
entry (Part 5), plus a `time/p3.zena` `Clock` returning `false`.
`zena:time`'s `sleep` is non-blocking under WASI, on the same code path
as JS. Tested as 1.7 was, asserting wall time against CPU time: 310 ms
wall, 20 ms CPU, for a 300 ms sleep.

Five builtins rather than four — `waitable-set.drop` joins the list, per
the corrections in 1.7. The callback is `zena:time`'s own
`componentResume`, exported and named by the lift, rather than
synthesized: it has to reach the timer queue and the completer registry,
which is Zena code. What the compiler does synthesize is the _entry_,
because that has to call `main`, and nothing in the standard library can
name a program's `main`.

Two restrictions the shape imposes, both loud at compile time:

- A program that links the p3 driver must declare `main(): void`. The
  lifted entry is `async func()`, and an async lift delivers its result
  through `task.return` after the event loop finishes, which is not
  where `main` returned it.
- An async-lowered import declares its Zena return as `i32`, the packed
  subtask handle, and its WIT type carries no result. A WIT function
  that returns something under an async lowering delivers it through the
  subtask, which needs C6's futures.

### C3 — the type encoder, and stdio. Weeks.

Wire `packages/wit-parser` to the component type section and add
memory-carrying `canon lower` options over the imported-memory design
(1.3). This is where the runtime module arrives, carrying linear memory
and the allocator, and where `zena:memory` gains a variant whose
`Allocator` delegates to the imported `realloc` instead of running a
second `FreeListAllocator` over the same addresses. Lift options can
still use an allocator exported by the program module — the constraint
is on lowering — but one owner is worth more than that saving. Ships
`zena:console` over p2 `wasi:cli/stdout`, which is what 1.4 ran, and
`--wit` / `--world` for programs declaring their own world.

Until C3 a component cannot print, which is the argument for reordering
C2 and C3. C2 stays first because timers are the goal and can be tested
on time rather than on output. (C3 delivered: `console.log` on the
component target writes through p2 stdio, and the e2e suite asserts the
printed lines.)

C3 splits along the line 1.3 draws, and the first part is **done**:

#### C3.1 — `string` on exports. **Done.**

The direction that needs no second core module. Lifting happens after
instantiation, so an export can take `memory` and `realloc` from the
program module's own exports and one core module is the whole
component — which is how this shipped, and what made it separable.
(C3.3's memory half has since moved both to the runtime memory module:
lift and lower now name one owner, and the program module no longer
exports `cabi_realloc` or `memory` at all.)

The marshaling is `zena:component-abi`, a standard library module: a
`realloc` over `zena:memory`'s free list, the two string
conversions, and a `postReturn` that frees what a result allocated.
Written in Zena for the reason the p3 callback is — allocating and
copying is something the standard library already says. What the
compiler synthesizes is one wrapper per string-carrying export, in
`ir/component-adapters.zena`, because only it can name a program's
exports. A single `string` result is returned indirectly, since it
flattens to two core values and a lifted function may return one.

The module is loaded by the component target's prelude and bound under
no name, and reachability roots it only when a String actually crosses
an export — so a component that moves no strings links neither it nor
the allocator, and the timer and clock components are emitted exactly as
they were.

Two things it settles that the plan above did not say:

- **A `string` import is not a smaller version of this.** It is the
  case 1.3 describes: the lowering has to exist before the module is
  instantiated, so its memory cannot come from the module. The
  compiler rejects one by name, pointing here.
- **A component's string boundary is not the core module's.** The
  `$string*` exports let an embedder holding the core module build and
  read a guest String; a component's host never sees the core module.
  Conflating the two emitted four exports nothing could call, so the
  evidence flag is now the component's own. Two of the four survive on
  the component target, forced by `ensureExceptionInfra`, which couples
  the exception tag to `$stringCreate` for reasons nothing records —
  worth untangling, and not here.

#### C3.2 — the WIT type encoder. **Encoder done; compiler wiring open.**

Instance types, resources, `own`/`borrow`, records, variants, results,
lists, `alias outer`, driven from `packages/wit-parser`'s resolved AST
rather than hand-written. Plus `--wit` / `--world`. Testable on its own,
by round-tripping an emitted component's types back through
`wasm-tools component wit`.

The encoder is `packages/wit-parser/zena/component-encoder.zena`: a
world's imports become one instance type and one import per interface,
in first-use order with `use` dependencies ahead of their dependents,
plus component-level types and imports for the world's bare functions
and inline interfaces. `test:encoder` round-trips six fixtures through
`wasm-tools` exactly as prescribed — validate, print, compare against a
checked-in golden — and the goldens reproduce the source WIT down to
`use` renames and implicit handles.

Three encoding rules the format hides well, found by probing
`wasm-tools 1.252.0` byte for byte and now load-bearing in the encoder:
a type index in value-type position is a _signed_ LEB128 (the primitive
opcodes are its negative range, so index 79 is two bytes); every
WIT-named type must be **exported** from its instance type, because an
unexported record fails not at validation of the type but at the import
that uses the instance ("instance not valid to be used as import"); and
a resource name in value position is implicitly `own` — including a
`use`d resource, so resource-ness has to survive the alias hops.

The emitter now consumes the encoder for every imported interface:
`wit-imports.zena` renders the shape's `@external` imports as a WIT
document — one interface per namespace, grouped into nested packages,
a synthetic world importing them — and `emitComponent`'s import front
matter is the encoder's pieces verbatim. The encoder reaches codegen as
an _injected closure_ (`BinaryGenerator.importEncoder`, set by the
drivers), not an import: codegen defines mirror classes for the pieces
and never links the WIT parser, so hosts that never emit a component —
the language service compiles the same codegen sources — do not carry
it. (Concretely: linking wit-parser into the LSP graph tripped a latent
ZIR lowering bail in `IterableUtils.all`; see BUGS.md.) For a
flat-scalar interface the bytes come out identical to the hand-written
ones (verified by direct comparison on every fixture), so the change is
what becomes possible: when an interface's true WIT is richer than a
Zena declaration can spell — resources, lists, stdio's case — its real
source substitutes for the derived one and the emitter needs no new
opinion. One name got stricter: an `@external` namespace must now be a
full `ns:pkg/interface[@version]` path, because nothing less derives a
WIT document.

`--wit` / `--world` are built — Part 3 states the contract (the
declared world is the authority; emission follows it; disagreements
are errors, checked in both directions). Still open here: world-level
`use` and type definitions, `include`, cross-document packages, and
fixed-length lists. `future` and `stream` refuse loudly until C6.

#### C3.3 — imported memory, and stdio. **Done.**

The runtime core module, the program module importing its memory rather
than defining it, the allocator delegating to the imported `realloc`,
memory-carrying `canon lower`, and `zena:console` over p2
`wasi:cli/stdout`. This is where a component can print.

The memory half is built, in the shape 1.3 prescribes. A program that
touches linear memory on this target gets a two-core-module component:
the runtime memory module first — `memory` plus a `realloc` with the
canonical contract — instantiated with no arguments, then the program
module, which imports both under the reserved `zena:runtime` namespace.
The lift options now take `memory` and `realloc` from the runtime
instance, and only `cabi_post_return` remains the program's. A program
with no linear memory is emitted exactly as before, one core module and
all.

Three decisions worth recording:

- **The runtime module is compiled from Zena, per build.** Its source is
  `component-memory.zena` in the standard library — a re-export of
  `zena:component-abi`'s `realloc`, built `--target freestanding`,
  where `zena:memory` is the real free-list allocator. The driver runs
  that nested compile (`compileComponentRuntimeModule`) and hands the
  bytes to `BinaryGenerator`; hand-writing a free list in raw bytes
  inside the emitter would restate what the standard library already
  says, in a form nothing can review.
- **`zena:memory` is now a virtual module.** Every target but
  `component` keeps the single implementation; the component entry
  (`memory/component.zena`) holds no allocation state and routes
  `alloc`/`free` through the imported `realloc`, because two free lists
  handing out blocks from the same pages would corrupt each other — the
  runtime module owns the pages, full stop. One visible difference:
  exhaustion traps instead of returning the failure arm, since the
  canonical `realloc` cannot report failure.
- **The import/definition switch lives in `ModuleGenerator`, not
  `WasmModule.ensureMemory`** as the sketch above says. Which form the
  memory takes is a per-target emission decision, and `WasmModule` is
  the target-free structural model; `ensureMemory` still only records
  that a memory exists.

The stdio half is built on top of that. The compiler carries the real
WIT for `wasi:io/error`, `wasi:io/streams`, `wasi:cli/stdout` and
`wasi:cli/stderr` at 0.2.8 (`wasi-interfaces.zena`) — a Zena
declaration is core-shaped and cannot spell `own` or `list<u8>`, so for
these interfaces the baked source substitutes for the derived document,
the encoder emits the true instance types (`wasi:io/error` arrives
transitively, through `use`), and the flattening metadata decides which
lowerings carry `(memory 0) (realloc ...)` — the write does, the
`get-stdout` does not. When a lowering needs them, the runtime memory
module and its two aliases move ahead of the lowering section; when
none does, they stay put and every existing component keeps its bytes.

`zena:console`'s component entry does its own marshaling — copy the
bytes in, call the stream in ≤4096-byte chunks, check the result
discriminant, free — because the imports are declared core-shaped and
the standard library already says allocation and copying well. The
stream handles are fetched once and kept; dropping an `own` handle
waits on the `resource.drop` builtin, which nothing here needs yet.

One deliberate asymmetry: `console` is _importable_ on the component
target, not a prelude binding. A prelude module loads with the entry
and would shift symbol ids for every component build, breaking "the
component embeds the same core module a hostless build emits" for
programs that never print — the ordered-`globalDeclarations` fix is
what would let it join the prelude.

**Correction** (wit-parser): a bare `use error.{...}` inside a nested
package fails to resolve ("interface not found in package") — the
resolver looks in the main package. The baked WIT spells its uses
package-qualified; fixing the resolver retires the workaround.

### C4 — filesystem and CLI. Weeks.

`zena:fs` and `zena:cli` over `wasi:filesystem/*` and
`wasi:cli/environment` for the component target. Larger than stdio, same
shape.

### C5 — bindgen, per component-model.md. Months.

Unchanged, and now strictly downstream: stages 0a–0d (`Result` ✅, narrow
ints, `FixedArray<u8>`, `Disposable`) → first-class WIT imports →
marshaling → p2 HTTP. Each stage becomes testable against a running
component.

### C6 — p3 streams. After Track G.

`stream<T>` and `future<T>`, which move stdio to p3 and bring p3 HTTP.

---

## Open questions

1. ~~Surface syntax for marking an import async-lowered.~~ **Settled
   provisionally**: a third `@external` argument holding a
   comma-separated option list, `@external("wasi:clocks/…", "wait-for",
"async")`. It is the options record in the cheapest spelling the
   grammar already accepts — decorator arguments are string literals —
   and it generalizes to whatever C3 needs. If the options record
   arrives as real syntax later, this is what it replaces. A second
   namespace came with it: `@external("canon", "waitable-set.new")`
   names a canonical builtin, which is a function with no interface to
   be imported from and no type to declare.
2. Should `zena-cli` eventually run components rather than core modules?
   wasmtime supports components natively, so the embedder could drop its
   private `env.*` surface and become an ordinary component host. That
   would collapse two targets into one, at the cost of the marshaling
   that the core-module ABI currently avoids.

   **Direction settled, timing open.** Yes, and it is how the last
   blocking wait leaves the language: `time/wasi.zena` is the one driver
   that stops the module, and the alternative to a component host is a
   thread pool and a completion queue behind zena-cli's `env.*` surface
   — which is what a p3 host already is, over a surface we intend to
   delete. zena-cli's p1 is already implemented on top of wasmtime's p2
   (`-S preview2=y` is the default), so the host is async-capable
   underneath; what blocks the guest is p1's ABI, where the call simply
   does not return.

   Two things gate it, and both point at C3 first:
   - **Everything but timers needs the type encoder.** `wait-for` was
     reachable in C2 because its whole signature is flat scalars.
     `readFile`, argv and stdout move strings, lists and records across
     the canonical ABI, and that is true of a zena-cli-specific world
     just as much as of WASI's. p3's filesystem is genuinely async — 21
     `async func`s, most returning `result<T, error-code>` rather than
     streams — so it needs C3's types and async imports that _return_
     something, but not Track G.
   - **The cost lands on the compiler.** It is the most
     performance-sensitive Zena program we have, it does heavy file I/O
     and string work, and today it hands GC references straight across
     `env.*`. As a component it copies through linear memory at every
     crossing until
     [component-model#525](https://github.com/WebAssembly/component-model/issues/525)
     lands. Measure the self-compile before committing.

   Until then the blocking clock stays as it is. It is not observable on
   zena-cli — timers are the only thing that settles a future there, and
   the drain parks only once nothing else can run — and an interim
   re-entry loop over `env.*` would be built to be thrown away.

3. Which `--string-encoding` each target defaults to, and whether the
   JS-string-builtins path is a value of that flag or a separate one. It
   changes `String`'s representation rather than only its encoding at
   the boundary, which argues for separate.
4. Does the C3 encoder aim directly at `wasi:http/proxy` for `wasmtime
serve`? The measured p2 numbers in component-model.md — 79% of
   functions are resource methods — argue for waiting for bindgen.

## Related

- [component-model.md](./component-model.md) — bindgen and marshaling.
  This document front-runs its stage 6 and settles its open question 4.
- [concurrency.md](./concurrency.md) — Track G. Part 5 adds a host driver
  alongside it, and depends on it only for streams.
- [console-wasi-strategy.md](./console-wasi-strategy.md) — the original
  two-step `embed`/`new` sketch, superseded by Part 4.
- [wit-parser.md](./wit-parser.md) — the parser, which C3 puts on the
  build path as a type encoder.
- [component-model#525](https://github.com/WebAssembly/component-model/issues/525)
  — Wasm GC in the canonical ABI, which would remove the marshaling.
