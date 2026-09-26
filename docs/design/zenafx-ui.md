# ZenaFX UI Runtime

## Status

- **Status**: Proposed
- **Date**: 2026-09-25
- **Scope**: a retained-mode UI system whose applications are trees of
  WebAssembly components linked at run time; which parts of it are written in
  Zena and which stay in Rust; the WIT interface at each seam; and the path to
  a window showing centred text.
- **Relationship to [graphical-runtime.md](./graphical-runtime.md)**: that
  document designs `zfx`, the host binary that runs graphical components,
  and the `wasi-gfx` and `wasi:webgpu` interfaces it serves today. ZenaFX
  is a layer above it and adds host interfaces of its own. `zfx` stays the
  binary; ZenaFX is the UI architecture it serves.

## Contents

This list defines the numbers the `§` cross-references in this document use.

1. Status
2. Overview
3. Terms
4. Prior art
5. Division of labour between Zena and Rust — 5.1 The rule, 5.2 The split,
   5.3 What the split costs
6. Component and process structure — 6.1 The component graph, 6.2 Runtime
   linking and import interposition, 6.3 The root drives the frame,
   6.4 Call direction within a frame, 6.5 Serialization across components
7. The scene interface — 7.1 The viewport is the capability, 7.2 Feed-forward
   mutation, 7.3 `zenafx:ui` in WIT, 7.4 Events: talking upward,
   7.5 Context: values that inherit down the tree
8. Host primitives — 8.1 Layout with measurement inside the solve, 8.2 Text,
   8.3 Paint, 8.4 Surface, frames and demand-driven redraw,
   8.5 `zenafx:host` in WIT
9. Widgets, templates and updates — 9.1 Widgets and templates, 9.2 Moving the
   component boundary
10. Scheduling
11. Reactive state
12. Capabilities and isolation
13. Tiers beyond boxes and text
14. Compiler prerequisites — 14.1 What already works, 14.2 What is missing
15. Milestones — 15.1 Milestone 1, 15.2 Later milestones
16. Repository layout
17. Alternatives considered
18. Open questions
19. Related

## Overview

ZenaFX is a UI system in which an application is a tree of WebAssembly
components that share one window. Each component holds private state and
private nodes, receives the authority to draw from its parent, and cannot
reach into its parent's or its children's nodes.

Rendering is retained: a component builds a tree of boxes and text once and
then mutates it, instead of re-issuing drawing commands every frame. Painting
is demand-driven: a frame happens because something was invalidated, not
because 16 ms elapsed.

Composition happens at run time, the way a web page's does. The host fetches a
component, reads the imports its component type declares, binds each one to
something it chooses, and instantiates it — with nothing linked ahead of time
and no build step that fuses an application to its dependencies. That is what
lets a document name a component by URL, and it is what puts the host in
position to decide, per instance, which interfaces that component reaches at
all. §6.2 describes the mechanism.

Two further consequences of the structure shape the rest of the design. A
component reaches a child by importing the child's WIT world, so there is no
registry mapping a name like `my-button` to an implementation, and two libraries
that both supply a button coexist. A component draws only inside the box its
parent gave it, and the compositor clips it there in hardware, so many mutually
untrusted components can share one window.

The division of labour is the other half of the design. The scene graph, the
widget model, the scheduler and the capability bookkeeping are written in Zena,
in a component. Layout solving, text shaping, vector rasterization, GPU access
and the OS event loop stay in Rust, behind narrow WIT interfaces. §5 gives the
rule that produced that split and what it costs.

## Terms

- **Component** always means a WebAssembly component in the sense of the
  [Component Model][component-model]. It never means a UI widget.
- **Widget** is the unit of UI: private state, a template, and an update
  function. A widget may be a component of its own or one of many inside a
  component, and §9.2 is about why that choice is free.
- **Viewport** is the region a widget paints into and the authority to do so.
  Fuchsia calls the child's end of the same link a *view*; this document uses
  "viewport" for both ends and reserves "view" for quoting Flatland.
- **Node** is an entry in the retained tree: a box, a text run, a slot, a
  canvas, or a GPU viewport. Nodes are what layout and paint operate on.
- **Display list** is a flat sequence of paint commands for one frame:
  rounded quads, glyph runs, clip pushes and pops.
- **Runtime component** is the Zena component that implements the scene
  interface. It is one component in the graph, not part of the host.

[component-model]: https://github.com/WebAssembly/component-model

## Prior art

Three systems supply the main ideas.

**Fuchsia's [Flatland][flatland]**, the 2D composition API of
[Scenic][scenic], puts the scene graph in a service that clients talk to over
an IPC interface, gives each client a view bounded by its parent, and clips
clients to their bounds so a misbehaving one cannot draw over its neighbours.
ZenaFX takes the bounded-view model, the parent-grants-authority rule, and the
compositor-enforced clip.

**[Lit][lit]** treats a widget as a function from state to a
[template][lit-templates], separates the template's fixed structure from its
changing values, and sends only the changed values on update. ZenaFX takes
that, for a reason specific to the component boundary: sending a whole tree
across a [canonical ABI][canonical-abi] call per frame would be the dominant
cost, and sending a handful of values is not.

**The web** supplies two mechanisms ZenaFX replaces with ordinary lexical
imports. [`customElements.define('my-button', ...)`][custom-elements] writes
into one global table, so two libraries that both define `my-button` cannot be
loaded together. A CSS rule written in one stylesheet changes how an element
defined in another file renders, because [the cascade][cascade] is resolved
document-wide, so styling is not a local property of the code that wrote it.

[flatland]: https://fuchsia.dev/fuchsia-src/concepts/ui/scenic/flatland
[scenic]: https://fuchsia.dev/fuchsia-src/concepts/ui/scenic
[lit]: https://lit.dev
[lit-templates]: https://lit.dev/docs/templates/overview/
[canonical-abi]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md
[custom-elements]: https://developer.mozilla.org/en-US/docs/Web/API/CustomElementRegistry/define
[cascade]: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Cascade

## Division of labour between Zena and Rust

### The rule

Rust holds the algorithms that have large, correct existing implementations,
plus the OS handles. Zena holds the data structures and the policy over them.

Two examples show where the line falls. Text layout is thousands of lines of
Unicode tables, bidi, OpenType feature application and glyph outline
extraction, and [`parley`][parley] already has them — it composes
[`fontique`][parley] for font enumeration and fallback,
[`harfrust`][harfrust] for shaping and [`skrifa`][skrifa] for outlines.
Writing that in Zena would take months and produce a worse result. A retained
node tree with dirty bits is a few hundred lines of bookkeeping with no
external dependency, and writing it in Zena exercises the language on a real
program.

[parley]: https://github.com/linebender/parley
[harfrust]: https://github.com/harfbuzz/harfrust
[skrifa]: https://github.com/googlefonts/fontations

### The split

| Concern | Where | Reason |
| --- | --- | --- |
| Window, OS input, vsync | Rust, in `zfx` | [`winit`][winit]; macOS requires the event loop on the main thread |
| Text layout, shaping, line breaking | Rust | [`parley`][parley]: Unicode and OpenType tables |
| Flexbox and grid solving | Rust | [`taffy`][taffy] |
| Vector and glyph rasterization | Rust | [`vello_cpu`][vello-cpu] first, [`vello`][vello] on the GPU later |
| GPU pipelines for Tier 3 | Rust | [`wgpu`][wgpu], already served through [`wasi:webgpu`][wasi-webgpu] |
| Retained node tree | Zena | bookkeeping over data the host never needs to see |
| Dirty tracking, incremental layout and paint | Zena | policy: deciding when to call the solver, and on which subtree |
| Widget instances, props, dirty checking, lifecycle | Zena | application semantics; no external dependency |
| Templates and slot updates | Zena | the target `html` blocks lower to |
| Frame scheduling | Zena | ordering policy over the widget tree |
| Hit testing | Zena | arithmetic over rects the runtime already holds |
| Slot projection and shadow subtrees | Zena | tree bookkeeping |
| Capability bookkeeping and attenuation | Zena | the runtime is what issues and checks node ids |

[winit]: https://github.com/rust-windowing/winit
[taffy]: https://github.com/DioxusLabs/taffy
[vello]: https://github.com/linebender/vello
[vello-cpu]: https://docs.rs/vello_cpu
[wgpu]: https://wgpu.rs
[wasi-webgpu]: https://github.com/WebAssembly/wasi-webgpu

The host therefore holds no scene graph. It holds a font cache, a glyph cache,
a table of registered text runs, a `taffy` tree it rebuilds per solve, and one
window. Everything with a parent pointer lives in Zena.

### What the split costs

Putting the scene graph in a component adds a boundary between an application
and its pixels that would not exist if the scene graph were in the host. Two
boundaries have to stay cheap.

**Application to runtime component.** An application sends the values that
changed rather than its tree. A widget whose re-render changes three hole values
sends three operations in one `apply` call, and building a subtree of N nodes
also costs one `apply` call rather than N calls. §7.2 covers the batch
operation and §9 covers where the three values come from.

**Runtime component to host.** Per frame the runtime makes one `solve` call
per dirty subtree and one `present` call. `solve` is proportional to the dirty
subtree rather than the whole scene, and `present` is proportional to what is
visible. The traffic to avoid is a host call per node, which is why the host
has no node-shaped API at all.

The `present` call as specified in §8.5 sends the whole frame's display list
each time. For the first milestones that is the right simplification; a scene
with tens of thousands of quads will want a retained display list with
per-node invalidation, which is a change to `zenafx:host/paint` and not to
`zenafx:ui`.

## Component and process structure

### The component graph

```
+-----------------------------------------------------------------------+
|  zfx (Rust host)                                                      |
|                                                                       |
|  winit event loop (main thread)      taffy     parley     vello_cpu   |
|        |                               \          |           /       |
|        |                               +----------+-----------+       |
|        |                                          |                   |
|  fetches components, binds their imports one instance at a time,      |
|  serves zenafx:host/{surface, layout, text, paint} and                |
|         wasi:webgpu, wasi-gfx:surface, wasi:cli                       |
+-----------------------------------------------------------------------+
            ^                                  ^
            | zenafx:host/*                    | zenafx:host/*
            |                                  |
   +--------------------+            +---------------------------+
   |  Application root  |            |  Runtime component        |
   |  (Zena)            |            |  (Zena)                   |
   |                    |  scene     |                           |
   |  imports scene ----+----------->|  exports zenafx:ui/scene  |
   |  drives the frame  |            |  retained tree, layout    |
   |  loop              |            |  policy, paint walk       |
   +--------------------+            +---------------------------+
            |
            | child's own world
            v
   +--------------------+
   |  Child component   |
   |  (any language)    |
   |  imports scene     |
   +--------------------+
```

The runtime component is passive: it exports the scene interface and imports
the host primitives. It never calls an application. The arrow marked `scene` is
a binding the host makes at load time, not a link baked into either binary.

### Runtime linking and import interposition

Every component arrives as its own `.wasm` file, named by a URL. Nothing is
composed ahead of time. For each component the host:

1. **Fetches and compiles it.** `Component::from_binary` against the shared
   `Engine`, with the compiled artifact cached by content hash so a second
   visit to the same URL skips compilation.
2. **Reads what it asks for.** `component.component_type().imports(&engine)`
   enumerates the import names and their `ComponentItem` types. This is the
   component's own declaration of what it needs, available before it runs.
3. **Decides what each import gets.** An import is checked against the policy
   for this instance. Anything not permitted is a load error, so a component
   that wants an interface it may not have fails before instantiation rather
   than at the first call.
4. **Binds each permitted import.** Either to a host implementation, attenuated
   for this instance, or to a trampoline that forwards to another instance's
   export.
5. **Instantiates.**

Two details make this work per instance rather than per process.

**A fresh `Linker` per instance.** `wasmtime::component::Linker` is keyed by
import name, so one shared linker gives every component the same bindings. A
linker built for one instance can bind `zenafx:host/paint` to a paint proxy
scoped to that component's viewport, and bind nothing at all where the policy
says no. The blanket registrations — `wasmtime_wasi::p2::add_to_linker_sync`
and friends — are still usable for the baseline that every component gets, and
are simply not called for an instance that is not entitled to that surface.
Building a `WasiCtx` per instance covers the rest: stdio, environment and
preopens differ by instance because the context differs, not because the linker
does.

**Dynamically typed host functions.** Binding an import the host was not
compiled against needs `Linker::instance(name)` and `func_new`, which take
`Val` arguments and a runtime signature, rather than the typed functions
`bindgen!` generates. Reading the import's `ComponentItem::ComponentFunc` gives
the parameter and result types to work against. `zenafx:ui` and `zenafx:host`
are known at build time and can use generated bindings; a guest→guest binding
between two components the host has never seen cannot, and needs the dynamic
path.

A guest→guest binding is a host function that lowers the caller's arguments,
calls the callee instance's export, and lifts the result back. The host is on
the path for every such call, which is what makes attenuation and proxying
possible at all, and also what makes them cost something — §5.3 bounds how
often the frame path crosses one.

None of this is speculative. A server-side component runner outside this
repository already does it — a fresh `Linker` per execution, a pre-instantiation
check of `component_type().imports()` against an allowlist that fails closed,
host functions registered through `root.instance(name)?.func_new(...)` with
return values shaped from the import's own declared result type, and a `WasiCtx`
whose stdio, environment and preopens vary by how far the component is trusted.
ZenaFX needs the same five steps with a different set of interfaces and a window
on the end of it.

### The root drives the frame

The frame loop lives in the application root:

```
await for each frame event from zenafx:host/surface:
    run this component's pending widget updates
    call each dirty child component's update export
    call scene.flush()          // runtime solves layout and presents
```

`scene.flush()` is where the runtime component does its work: it walks its
dirty set, calls `layout.solve` for each dirty subtree, builds the display
list, and calls `paint.present`.

### Call direction within a frame

Runtime linking makes a cyclic binding expressible. Build-time composition does
not: `wac` and `wasm-tools compose` both require a DAG. But a host trampoline
resolves its target when the call happens rather than when the importer is
instantiated, so the host can instantiate the runtime component and an
application and then bind each to the other. A design where the runtime owns the
loop and calls each widget's `render` is therefore available.

ZenaFX does not use it, for two reasons that belong to the design rather than to
the linker.

The first is ordering. §10 gets its guarantee about update order from the frame
being a single pass in one direction: the root updates, then calls its dirty
children, which update and call theirs. A runtime that called back into
applications would be choosing the order in which widgets update, and would have
to reconstruct the tree ordering that the call graph gives for free.

The second is that a synchronous export cannot be re-entered, and whether a
component can be re-entered at all depends on how its exports are lifted. The
three cases are visible in wasmtime 48.0.2's
`src/runtime/component/concurrent.rs`:

- **A synchronous lift** holds the flag for the whole call. `enter_instance`
  sets `do_not_enter` on the callee instance, described as an instance "which
  does not support more than one concurrent, stackful activation, meaning it
  cannot be entered again until the next call returns". A queued guest call
  whose target has the flag set is not ready and waits; a synchronous task that
  tries to block instead gets `Trap::CannotBlockSyncTask`.
- **A callback-less (stackful) `async` lift** does not set the flag at all. The
  code guards it with `if !async_`, over the comment "unless this is a
  callback-less (i.e. stackful) async-lifted export, we need to record that the
  instance cannot be entered until the call returns". Such a task gets its own
  `StoreFiber`, so a second activation runs on a fresh stack while the first
  stays parked on its own.
- **A callback (stackless) `async` lift** holds the flag only for the duration
  of each callback invocation and clears it on return. Between callbacks the
  guest has no stack parked at all; its state lives in its own heap.

So a synchronous lift is a mutual-exclusion region over the instance, which is
the property that lets a guest hold non-reentrant invariants across a call —
and the property that makes A→B→A impossible while A's synchronous activation is
on the stack. Zena's async is stackless, which puts a Zena component in the
third case and is why the resolution below works at all.

Two things in Zena's own runtime say that a re-entered activation would not be
safe even where the ABI allowed one:

- `runFuture` in `zena:async` drains the microtask queue to a standstill, and is
  documented as top-level only: "calling it from inside a task would re-enter
  the drain and break run-to-completion"
  ([future.zena](../../packages/stdlib/zena/async/future.zena)). A nested
  activation that drains would be running the outer activation's queued work
  from inside its own suspended call.
- A synchronous Zena export is never re-entered by construction, and the
  compiler depends on it. `renderSyncExportWrapper` refuses a `stream` or
  `future` on a synchronous export with the reason that "a stream or future is
  pumped by callback re-entries, which a synchronous export never gets; declare
  the export `async func`"
  ([wit-module-synth.zena](../../packages/zena-compiler/zena/lib/wit-module-synth.zena)).

The same two facts show the way out. A synchronous activation has no way to
yield, so anything requiring the guest to make progress while an outer call is
suspended cannot make progress. An `async`-lifted export does have a way: it
returns a task, and the host re-enters through the callback once the outer call
has returned, which is how Zena already pumps streams and futures across a
component boundary.

ZenaFX therefore adopts a rule. **A guest→guest call on the
frame path must run to completion without suspending.** `apply`, `flush`,
`bounds` and the rest of §7.3 are synchronous and do exactly that: the callee
mutates its own state, returns, and is not on the stack when anything else calls
it. Anything that needs to await belongs in an `async`-lifted export, where
re-entry happens by callback after a return instead of by nesting.

Breaking the rule fails loudly rather than quietly, which decides how careful
the loader has to be. A host that calls back into an instance whose synchronous
activation is still on the stack has built a deadlock: the inner call waits on
`do_not_enter`, the outer call waits on the host, and the host waits on the
inner call. The runtime reports that rather than running a second activation
over the first one's memory.

This is being relaxed upstream.
[wasmtime#14146][wasmtime-14146] ("align multithreading and trap behavior with
CM spec", merged 2026-08-31) replaces the task-level `may_block` tracking with
instance-level tracking, allows reentrancy except after a trap, and makes
trapping lazy: a synchronous function may call an async one, and traps only if
the call actually blocks with no other thread eligible to run. The symbols that
PR introduces are absent from the vendored 48.0.2 source while the machinery it
replaces is present, so it arrives in a later release. It widens what works
without changing the rule above — a call that genuinely has to block while an
outer call is suspended still has nothing to run.

[wasmtime-14146]: https://github.com/bytecodealliance/wasmtime/pull/14146

The call direction is therefore fixed: parents call children, and applications
call the runtime. The root is the only thing the host enters. The consequence
§10 depends on is that the call graph of a frame is the component tree, walked
top-down.

### Serialization across components

Every component in one window lives in one wasmtime `Store`, and a `Store` is
entered by one thread at a time. Components in a ZenaFX window therefore do not
run in parallel with each other, however many cores the machine has.

The fix for that is the shared-everything-threads proposal, which would let
several OS threads enter one instance. Asked directly about the timeline on the
Bytecode Alliance Zulip, Alex Crichton put "fully parallel shared-everything
threads" at "the timescale of years, definitely not months", and Lann Martin
gave the same answer; the advice for CPU parallelism today was to run multiple
instances in multiple stores and synchronise between them through a host API
(#general, "Parallelism (multi-threading) in the CM and Wasmtime?", 2026-09).

Two things follow. The first is that §6.3's single top-down pass gives up no
parallelism that was available — serialising the frame costs nothing, because the
components could not have run concurrently anyway. The second is that a slow
component is a problem with no parallel escape, which §12 takes up.

A store per component is the alternative, and it buys real parallelism at a
price: cross-store calls cannot pass component-model resource handles directly,
and everything crossing between them has to be copied through the host. For a
scene graph whose whole point is cheap incremental mutation from many
components, that is the wrong trade today. It becomes interesting if a component
wants a worker for computation rather than for drawing, which is a separate
store and a separate question from the frame path.

## The scene interface

### The viewport is the capability; nodes are ids inside it

A [WIT][wit] `resource` is a handle in the holder's own table: it cannot be
forged, cannot be guessed, and its destructor tells the provider when the holder
lets go. One resource per node would put a handle-table entry behind every box
and text run in the tree, and make every parent/child edge a handle crossing.
One resource per *viewport* gets the same security for a fraction of that.

So `viewport` is a resource — the authority to build under one node — and a
`node` is a plain `u32` **chosen by the holder** and meaningful only relative to
the viewport it is used with. Forging one buys nothing: the worst a component can
reach is another node in a viewport it already holds. The unforgeable thing is
the viewport.

Flatland works this way, which is the reason to trust the shape:
`fuchsia.ui.composition` has the client pick every `TransformId` and
`ContentId`, scoped to the client's own session. Letting the caller name the id
also removes a round trip — `create` has nothing to return, which §7.2 turns
into a property of the whole interface.

A component receives its viewport from its parent and can `derive` narrower ones
to hand on. Slot projection falls out of the same handle rather than needing a
mechanism: a child creates a node in its own subtree, derives a viewport rooted
at it, and returns that to its parent. The parent then fills the slot with its
own content, the child decides where the slot sits, and neither can enumerate or
mutate the other's nodes. §12 has the rest of the capability story.

[wit]: https://component-model.bytecodealliance.org/design/wit.html

### Feed-forward mutation

Every scene call crosses a component boundary, so one call per node is the wrong
shape and `apply` takes a list of operations instead. With the caller naming its
own ids, `apply` has nothing to return — which matters for more than batching.

A function with no result can be delivered late. The host can queue the call,
return immediately, and run it when the callee is safe to enter, and the caller
cannot tell the difference. That is what makes the deferred dispatch in §7.4
possible, and it is why the operation list has no `create` that answers with an
id and no single-operation convenience functions that do either. Flatland calls
the same property feed-forward: operations accumulate and take effect at
`Present`.

Two functions on `viewport` do return values: `bounds`, which reads back
geometry after a layout pass, and `derive`, which mints a viewport. Both are
called downward — a component asking the runtime, or a parent asking a child —
so neither needs deferral.

### `zenafx:ui` in WIT

Verified against `wasm-tools 1.252.0`: this package and the `zenafx:host`
package in §8.5 both resolve, and `wasm-tools component wit` round-trips them.

```wit
package zenafx:ui@0.1.0;

interface geometry {
  record size { width: f32, height: f32 }
  record rect { x: f32, y: f32, width: f32, height: f32 }
}

interface style {
  /// Non-premultiplied sRGB; each channel runs 0..1.
  record color { r: f32, g: f32, b: f32, a: f32 }

  record box-look {
    background: option<color>,
    border-color: option<color>,
    border-width: f32,
    corner-radius: f32,
    opacity: f32,
  }

  record text-look {
    family: string,
    size: f32,
    weight: u16,
    italic: bool,
    color: color,
  }

  variant length { auto, px(f32), percent(f32) }
  enum axis { row, column }
  enum justify { start, center, end, space-between }
  enum align { start, center, end, stretch }
  record edges { top: f32, right: f32, bottom: f32, left: f32 }

  /// Geometry only. Nothing here affects painting, and nothing in
  /// `box-look` or `text-look` affects measurement.
  record flex {
    axis: axis,
    justify-content: justify,
    align-items: align,
    gap: f32,
    padding: edges,
    width: length,
    height: length,
    grow: f32,
    shrink: f32,
  }
}

interface scene {
  use geometry.{rect};
  use style.{box-look, text-look, flex, color, length};

  /// A node within one viewport, named by whoever holds that viewport.
  /// Node 0 is the viewport's own root and already exists. An id means
  /// nothing outside the viewport it is used with.
  type node = u32;

  record box-op { id: node, parent: node, layout: flex, look: box-look }
  record text-op { id: node, parent: node, content: string, layout: flex,
                   look: text-look }
  record layout-op { target: node, layout: flex }
  record look-op { target: node, look: box-look }
  record content-op { target: node, content: string }

  /// A value that inherits down the tree (§7.5). The set is closed on
  /// purpose: these are the things a theme carries. Anything richer is
  /// bound by the loader instead.
  variant inherited {
    color(color),
    length(length),
    scalar(f32),
    flag(bool),
    name(string),
  }

  /// Provide `key` at `target` for the subtree beneath it. `none`
  /// withdraws, so the subtree sees whatever an ancestor provides.
  record provide-op { target: node, key: string, value: option<inherited> }

  variant op {
    make-box(box-op),
    make-text(text-op),
    set-layout(layout-op),
    set-look(look-op),
    set-content(content-op),
    provide(provide-op),
    /// Removes the node and its descendants, and frees the ids.
    remove(node),
  }

  /// What a viewport permits. A derived viewport may drop grants and
  /// never add them.
  flags grants {
    pointer,
    keyboard,
  }

  /// The authority to build nodes under one node of the scene. Holding
  /// it is the only way to name a node; dropping it discards the
  /// subtree.
  resource viewport {
    /// Apply a batch of operations in order. Returns nothing, so the
    /// call may be delivered after the caller's own call returns.
    apply: func(ops: list<op>);

    /// The node's box after the most recent layout pass, in window
    /// coordinates. Zero-sized before the first pass.
    bounds: func(target: node) -> rect;

    /// The value of `key` in effect at `target`: from the nearest node at
    /// or above it that provides one, including nodes belonging to other
    /// components. `none` when nothing provides it.
    inherited: func(target: node, key: string) -> option<inherited>;

    /// A viewport rooted at one of this viewport's nodes, carrying at
    /// most the grants this one holds. Handing it to another component
    /// is how a parent gives a child somewhere to draw, and how a child
    /// offers a slot back to its parent.
    derive: func(container: node, permitted: grants) -> viewport;

    /// Mark this subtree as needing layout and paint, and ask the host
    /// for a frame.
    invalidate: func();
  }

  /// Solve layout for every dirty subtree and present one frame. Called
  /// by whoever drives the frame loop (§6.3), once per frame.
  flush: func();
}

/// How the root viewport enters the graph. Only the loader calls this —
/// no component imports it, which is what stops a component from
/// helping itself to the root instead of being handed a subtree.
interface session {
  use scene.{viewport};

  root-viewport: func() -> viewport;
}
```

`flex` describes geometry and `box-look` describes appearance, with no field
in either affecting the other. That separation is what lets the runtime skip a
layout solve when only colours changed, and skip re-measuring text when only a
parent's background changed.

### Events: talking upward

§6.4 fixes the call direction: parents call children, components call the
runtime, and nothing calls back into a component whose activation is still on
the stack. That covers every edge of a frame except one. A child telling its
parent something — a button was pressed, a size settled — runs against the
direction of the tree, and a direct call would re-enter the parent that is
mid-call inside it.

Upward communication is therefore an **event**, and events are asynchronous, as
they are on the web. The frame protocol gets that by inverting the call: **the
parent polls.** A child accumulates what it has to report and exposes
`take-events: func() -> list<event>`, with `event` a variant it declares itself.
During the pass the parent reads that list, handles it, and then updates the
child. Nothing calls upward at any point.

Four properties follow, and the fourth is the reason to prefer polling over a
push the host defers:

1. **Safe by construction.** `take-events` is a downward call on a tree edge, so
   §6.4's reentrancy question never arises and no dispatch machinery is needed.
2. **Typed.** The child declares its own `variant event`; nothing degrades to a
   `list<u8>` envelope.
3. **Asynchronous, with the web's shape.** An event raised while handling input
   in frame N is read at the start of the next pass.
4. **Independent of where the component boundary falls.** A parent widget polling a
   child widget in-language and a parent component polling a child component's
   export have the same shape and the same latency, so moving the boundary does
   not change behaviour. §9.2 relies on this.

Polling every child every frame would be waste, so a child that raises an event
marks itself dirty through the same `invalidate` path a node mutation uses, and
the parent polls only the children it already knows are dirty.

Some bindings are not part of the frame protocol — a component reaching a
service that happens to be another component rather than the host. For those a
push is the natural shape, and the loader decides whether it can be deferred:

- **Every function return-free.** The binding is *deferrable*. The host keeps a
  stack of the instances it has entered and not yet returned from; when a
  trampoline fires against a target on that stack, it records the call and
  returns, running it once the target's activation has unwound.
- **Any function with a result.** The binding is *direct only* — the caller is
  waiting for a value, so there is nothing to defer. A re-entrant call on such a
  binding reaches `do_not_enter` and fails as §6.4 describes.

Both are decided from `ComponentFunc::results()` at bind time, so the loader
knows which bindings are safe on which edges without an annotation, a manifest,
or any trust in what a component claims about itself. Zena compiles async to
stackless state machines and can be re-entered; a component whose exports are all
plain `func` cannot. Neither has to know what the other is written in, because the
decision is the host's. One consequence for anyone designing a pushed interface:
**its functions return nothing**, or it cannot be deferred.

```wit
// A child's own package. It reports upward by being read, so every edge
// in the frame protocol points down the tree.
package demo:counter@0.1.0;

interface events {
  record size { width: f32, height: f32 }

  variant event {
    pressed(u32),
    measured(size),
  }
}

world counter {
  use zenafx:ui/scene@0.1.0.{viewport};
  use events.{event};

  import zenafx:ui/scene@0.1.0;

  /// Where to draw, handed over by the parent.
  export mount: func(host: viewport);
  /// A slot the parent may fill: the child positions it, the parent
  /// decides what goes inside.
  export label-slot: func() -> viewport;
  /// One input, called downward on a tree edge, so it may return.
  export set-step: func(step: u32);
  /// Everything raised since the last call, oldest first.
  export take-events: func() -> list<event>;
}
```

A component with only synchronous exports can be polled, mounted and updated
like any other, which is the point: nothing in the frame protocol asks a
component to tolerate being re-entered. What such a component cannot do is ask
its parent a question and wait for the answer — the answer arrives as an input on
a later call, `set-step` above rather than a `get-step` it calls itself. For a UI
that is usually what was wanted, since a reply changes props and schedules a
render regardless.

Handling an event can raise more of them, because a parent responding to a child
may update and cause another child to report. The pass therefore runs to a
quiescent state or to a budget, and anything outstanding rides to the next frame
— the same budget §18 needs for a slow component.

### Context: values that inherit down the tree

Events handle one child talking to one parent. The harder direction is one
provider reaching a whole subtree: a theme, a locale, a text direction, a density
setting. Threading those down as props fails because the components in between
do not know about them and should not have to forward them.

The web has no real mechanism for this. The [context protocol][context-protocol]
that Lit and others implement emulates one: a consumer dispatches a
`context-request` event, an ancestor catches it **synchronously** and invokes a
callback carried in the event. Both halves are unavailable here: the synchronous
upward call is what §6.4 rules out, and a callback inside the payload is not
something WIT data carries.

ZenaFX does not need to, because the runtime holds the whole tree, including
nodes belonging to other components. Resolving a context value is a walk up its
own scene graph. No component talks to another component at all: the consumer
asks the runtime, which is a downward call on a tree edge and may therefore
return a value.

So a provider writes one op — `provide(target, key, value)` — and any node
beneath it reads `viewport.inherited(target, key)`. The walk crosses component
boundaries without either side gaining access to the other's nodes, because it
happens inside the runtime where the tree already is.

This is the same mechanism as inherited style properties, which is the second
reason to build it rather than emulate it. On the web, `color` and `font-family`
inherit down the DOM while application context needs a bespoke protocol; here
both are a keyed value resolved at the nearest providing ancestor. The style
records can take `inherit` as a case for the fields where that makes sense, and
resolve through the same lookup a theme value does.

The value domain is closed — colors, lengths, scalars, flags, names — and that
is a deliberate scope rather than a limitation to route around. Those are the
things a theme carries. Richer context, such as a document model, an auth token
or a service, is **bound by the loader instead**: when a parent instantiates a
child, §6.2 already decides what the child's imports resolve to, so "the nearest
provider" is settled once, statically, at full type fidelity, with no lookup and
no upward call. The web's context protocol conflates those two cases, which is
part of why it needs callbacks; splitting them lets each use the mechanism that
fits.

Invalidation is coarse: changing a provided value marks every component beneath
that node dirty, and each re-reads on its next update. Tracking which consumer
read which key would be finer, and a theme switch is rare enough that it is not
worth the bookkeeping until something shows otherwise.

[context-protocol]: https://lit.dev/docs/data/context/

## Host primitives

### Layout with measurement inside the solve

Flexbox needs the intrinsic size of a text run, and the intrinsic size of a
text run depends on the width it is given: the same string is one line at
600 px and three lines at 200 px. A solver therefore has to be able to measure
at a width it discovers mid-solve, which means measurement cannot be an input
computed beforehand.

`layout.solve` therefore runs in Rust with the text engine reachable from
inside it. The guest hands over a tree whose text leaves carry a run id
registered with `zenafx:host/text`, and the measure closure that
[`TaffyTree::compute_layout_with_measure`][taffy-measure] takes calls the text
engine directly. The guest never measures anything.

[taffy-measure]: https://docs.rs/taffy/latest/taffy/tree/struct.TaffyTree.html#method.compute_layout_with_measure

The tree is passed flat, in pre-order, with each node naming the index of its
first child and how many children it has. WIT has no recursive types outside
resources, so a record cannot contain a list of itself: `wasm-tools 1.252.0`
rejects the recursive spelling with ``type `…` depends on itself``. The flat
form also suits the call — one list crosses the boundary as one allocation, and
the indices into it are already the keys the result list uses.

A pluggable layout algorithm written as a guest component is possible later, and
needs the same shape plus an import it can call to measure: `measure(run,
available-width) -> measured`, called mid-solve. That works because the
implementation of `measure` is in the host: the guest solver makes an ordinary
synchronous host call and gets an answer back. It would stop working if
measurement were delegated to a *second* guest component, because the solver
would then be suspended at a guest→guest call while the callee ran — the case
§6.4 rules out. Text measurement staying in the host is what keeps guest layout
tractable. The first milestones use `taffy` in the host; §13 has the rest.

### Text

Text is registered, not passed per frame. `register-run` shapes a string under
a `text-look` and returns an id; the id then stands for the shaped run through
measurement, painting and hit testing until `release-run`. A widget that changes
a label calls `update-run`, which reshapes in place and keeps the id.

This is what keeps the per-frame display list small: a glyph run in the display
list is an id and a position, not a string and a font.

### Paint

`present` takes a display list and draws it. The commands are rounded quads,
glyph runs, and clip push/pop. Clips are what enforce the compositor's part of
the capability model in §12: the runtime emits a clip for each component's
bounds, and the rasterizer discards anything outside it.

### Surface, frames and demand-driven redraw

`zenafx:host/surface` provides the window, input event streams, and a stream
of frame events. A frame event is produced when a redraw was requested, and at
no other time. `request-redraw` coalesces, so a hundred invalidations before
the next frame produce one frame.

ZenaFX does not use [`wasi-gfx:surface`][wasi-gfx] for this, for a concrete
reason: [`surface-wasmtime`][wasi-gfx-runtime] spawns a thread that calls
`animation_frame()` on every surface and then sleeps 16 ms, whether or not
anything was invalidated (`crates/surface-wasmtime/src/winit.rs:53-57` in the
pinned revision). The interval is a constant with no option to change or
disable it, so a ZenaFX application on that path would wake 60 times a second
while idle. `zfx` runs its own `winit` loop under
[`ControlFlow::Wait`][control-flow] for ZenaFX and keeps `wasi-gfx:surface`
available for components that want a raw surface.

[wasi-gfx]: https://wasi-gfx.dev/
[wasi-gfx-runtime]: https://github.com/wasi-gfx/wasi-gfx-runtime
[control-flow]: https://docs.rs/winit/latest/winit/event_loop/enum.ControlFlow.html#variant.Wait

### `zenafx:host` in WIT

A cross-package `use` has to carry the version — `wasm-tools` reports
"package 'zenafx:ui' not found" for an unversioned path even with the
package present in `deps/`.

```wit
package zenafx:host@0.1.0;

interface text {
  use zenafx:ui/style@0.1.0.{text-look};

  record measured { width: f32, height: f32, baseline: f32 }

  /// Shape `content` under `look` and keep it. The id is valid until
  /// `release-run`.
  register-run: func(content: string, look: text-look) -> u32;
  update-run: func(run: u32, content: string, look: text-look);
  release-run: func(run: u32);

  /// Shape at a width. `none` asks for the unconstrained size.
  measure-run: func(run: u32, available-width: option<f32>) -> measured;
}

interface layout {
  use zenafx:ui/style@0.1.0.{flex};
  use zenafx:ui/geometry@0.1.0.{size, rect};

  /// One node of a tree given in pre-order. Index 0 is the root; a
  /// node's children are the `child-count` entries starting at
  /// `first-child`. The tree is flat because WIT records cannot recurse.
  record node {
    style: flex,
    /// A run from `text`, measured during the solve. `none` for a box.
    run: option<u32>,
    first-child: u32,
    child-count: u32,
  }

  /// Solve one tree. The result is parallel to `nodes`, and each rect is
  /// in the root's coordinate space.
  solve: func(nodes: list<node>, available: size) -> list<rect>;
}

interface paint {
  use zenafx:ui/geometry@0.1.0.{rect};
  use zenafx:ui/style@0.1.0.{color};

  record quad {
    bounds: rect,
    background: option<color>,
    border-color: option<color>,
    border-width: f32,
    corner-radius: f32,
  }

  record glyphs { run: u32, x: f32, y: f32 }

  variant command {
    quad(quad),
    glyphs(glyphs),
    push-clip(rect),
    pop-clip,
  }

  /// Draw the frame and present it.
  present: func(commands: list<command>);
}

interface surface {
  record frame-event {
    /// Milliseconds on a monotonic clock since the window opened.
    time-ms: f64,
    width: u32,
    height: u32,
    /// Physical pixels per logical pixel.
    scale: f32,
  }
  record pointer-event { x: f32, y: f32, button: u8, down: bool }
  record key-event { code: u32, down: bool, text: string }

  /// One event per requested redraw, and none otherwise.
  frames: func() -> stream<frame-event>;
  pointer: func() -> stream<pointer-event>;
  keys: func() -> stream<key-event>;

  /// Ask for one more frame. Coalesced.
  request-redraw: func();
}

world runtime {
  import text;
  import layout;
  import paint;
  import surface;

  export zenafx:ui/scene@0.1.0;
  /// Called by the loader only, to mint the root viewport it hands to
  /// the application.
  export zenafx:ui/session@0.1.0;
}
```

Typed record streams of exactly this shape already cross a composed boundary
in both directions in
[gfx-provider.zena](../../packages/zena-compiler/test-files/component/gfx-provider.zena)
and its consumer, so the event streams need no new compiler work.

## Widgets, templates and updates

### Widgets and templates

A widget is a class with private state and public inputs. Its node structure is
declared once, as a template with numbered holes, and afterwards only the hole
values change:

```zena
final class Greeting {
  #label: String;
  #nodes: TemplateInstance;

  /** The widget's one input. Assigning the value it already holds does nothing. */
  name: String {
    get { return this.#label; }
    set(value) {
      if (value == this.#label) { return; }
      this.#label = value;
      this.#nodes.update([value]);
    }
  }

  new(host: Viewport, label: String) {
    this.#label = label;
    // A centred column holding one text node, with the label in hole 0.
    this.#nodes = host.instantiate(greetingTemplate, [label]);
  }
}
```

`instantiate` takes a template and its initial hole values and issues one
`apply` call for the whole structure. `update` compares each new hole value
against the one the instance holds and sends an operation only for the holes
that differ — one `set-text` or `set-layout` when a single hole changed, one
`apply` when several did.

The comparison in the setter is what makes forwarding cheap. A parent that
re-renders and hands a child the string it already had causes no node mutation,
and a parent that hands a child component the props it already had makes no
call into that component at all.

Templates written by hand as node structures are workable for a demo and
tedious past that. [declarative.md](./declarative.md) designs the syntax that
replaces them: `html <box>...</box>` blocks in `.zena`, with `${expr}` holes
compiling to numbered slots. ZenaFX's template representation is what that
syntax lowers to, so the two designs have to agree on three things — holes are
positional, a hole carries a value rather than a subtree, and a hole holding a
child widget is a distinct kind of slot.

### Moving the component boundary

A widget and a component are different things (§3), and which widgets get their own
component is a deployment decision rather than a structural one. An application
of three hundred widgets can be one component, one component per widget, or
anything between, and it behaves the same. That is a requirement, not an
observation: a team should be able to develop against fine-grained components and
ship a bundle, or promote one widget to its own component because it came from
somewhere else, without rewriting the widgets on either side.

Four things make it hold, and each is a property of an earlier decision rather
than new machinery:

- **Viewports.** `derive` is a method on `viewport` and says nothing about who
  receives the result. A widget holds a derived viewport exactly as a child
  component does, with the same clipping and the same attenuation, so the
  authority structure does not change when the boundary moves.
- **Context.** §7.5 resolves against nodes in the runtime's tree, not against
  components. A widget's nodes sit at the same place in that tree either way, so
  `inherited` returns the same value.
- **Events.** A parent widget calling a child widget's `takeEvents()` in-language and
  a parent component calling a child component's `take-events` export have the
  same shape and the same one-pass latency. This is what §7.4 buys by polling: a
  host-deferred push would be asynchronous across a component boundary and
  synchronous within one, so fusing two components would silently change when
  handlers run.
- **Feed-forward ops.** `apply` batches the same way at any granularity. A fused
  application issues fewer, larger batches, which is faster and not different.

What makes all four hold is a constraint on interposition rather than a ban on
it.

**The host may interpose on any binding, including one between two widgets.**
That is deliberate. A deployment that mixes widgets from sources which do not
trust each other equally needs the host between them, deciding per call what is
allowed to pass, and §6.2's per-instance binding is what supplies it. A policy
that wants to mediate every userland call can have exactly that.

**Keeping components unbundled is therefore itself a security choice.** Bundling
two widgets into one component removes the host from between them: no binding is
left to mediate, the two share a memory, and nothing remains for a policy to
check. So whether a given pair of widgets *may* be bundled is a question for
policy, not for whoever is optimising the build. Within one trust domain the
boundary is free to move; across one it is mandatory, and the separation is the
feature rather than an overhead to remove.

**Interposition must not change an interface's semantics.** This is the
constraint that lets the two coexist. A mediator may refuse to bind, deny a
call, or transform the values that cross it — everything mediation is for. What
it may not do is change when a call runs relative to its caller, because that is
what would make one source tree behave differently depending on how it was
packaged.

That constraint is the real reason §7.4's frame protocol polls. `take-events`
returns a list, so a mediator can drop or rewrite entries and the caller cannot
tell whether one sat between them, while a bundled widget's in-language
`takeEvents()` means exactly the same thing. A pushed event that the host defers
cannot be made transparent that way, which is why §7.4 confines the deferred-push
binding to return-free interfaces: the absence of a result is what says the caller
is not waiting, so there is no synchronous expectation for deferral to violate.

Two things still do not survive bundling.

**Isolation does not**, which is the same point from the other side. Widgets in
one component share one linear memory and one GC heap, so §12's guarantees hold
between components and not inside one. A widget from a third party stays its own
component, and that is a decision about trust rather than about performance.

**The total update order does not.** §10's invariant holds either way: a parent
widget updates before anything beneath it. The full ordering does not. Separate,
a parent component's deepest widgets update before a child component's shallowest
ones, because the parent's update is one call; bundled, a single depth-ordered
queue interleaves them. Sibling widgets are independent by construction — neither
is an ancestor of the other — so nothing observable should depend on which runs
first, and a widget that does depend on it is relying on something the design
never offered.

`wac` and `wasm-tools compose` sit between the two options, and the difference
matters for the same reason. Their output is one file containing several
sub-component instances, so the widgets keep their separate memories and their
isolation. What they lose is the host: the bindings are wired statically inside
the composed component, so nothing can mediate them any more. A policy that needs
to see every call between two widgets therefore rules out static composition as
well as bundling, even though static composition preserves the memory boundary.

A true merge into one instance is a build-time decision rather than a linking
one: it needs both widgets compiled from source by a single toolchain, which is
available for Zena widgets and not across languages.

## Scheduling

Updating widgets in the order their invalidations arrived causes two problems.

**Shearing.** A parent and its child both read a shared value. The value
changes; the child updates first, so it renders with the new shared value and
the parent's old forwarded prop. The frame shows an inconsistent mixture. The
[TC39 signals proposal][signals] calls the same hazard a glitch, and rules it
out the same way, by ordering the graph.

**Duplicate work.** The parent then updates, forwards a new prop, and the
child updates a second time in the same frame.

ZenaFX updates widgets in tree order instead, and gets that ordering from two
places.

Ordering across components costs nothing, because §6.3 already fixed the call
direction: a frame is a single top-down pass in which the root updates, then
calls its dirty children, which update and call theirs. A component's update is
one call, so nothing outside it observes a half-updated component. Every widget
in the pass reads shared state at the same point in the frame, and a mutation
made during the pass is queued for the next frame rather than applied mid-pass.

Within a component the widgets need an explicit order, because invalidations
arrive from event handlers in arbitrary order. The scheduler keeps a queue
keyed by the widget's depth in its own widget tree and pops the shallowest first.
When a parent's update removes a child from the tree, the child is dropped
from the queue rather than updated and discarded.

One case stays outside this ordering, and shearing remains possible in it. A
value owned by a third component, imported directly by both a parent and its
child, is never forwarded by the parent, so the ordering above says nothing
about which of the two reads it first. An application avoids it by reading
shared state at the root and forwarding it down, which is the advice Lit gives
for [context][lit-context] on the web. A library avoids it by exposing the
shared state as a `stream<T>` the root reads and forwards, rather than as a
value each consumer imports.

[signals]: https://github.com/tc39/proposal-signals
[lit-context]: https://lit.dev/docs/data/context/

## Reactive state

Shared state inside one component is a Zena-level signal: a typed value with
a set of dependent widgets, invalidating them on change. It needs no WIT and no
host support, and it stays typed.

Shared state across components is a typed interface the owning component
exports — a `stream<T>` of a record, or a function returning the current value
plus a stream of changes. This is the shape the repository already exercises:
[gfx-provider.zena](../../packages/zena-compiler/test-files/component/gfx-provider.zena)
hands out a `stream<frame-event>` that a consumer in another component reads
one record at a time, and
[compose.wit](../../packages/zena-compiler/test-files/component/compose.wit)
has a consumer awaiting a `future<s32>` that a different component settles.

A host-side signal resource carrying a dynamically-typed
`variant value { bool, int, float, text, bytes }` is the alternative, and it is
worth naming because it is the obvious design. It is rejected: it erases the
element type at every read, so every consumer needs a runtime check and a
failure path for a case that the type system could have ruled out, and Zena
has no `any` precisely so that this does not happen.

## Capabilities and isolation

A freshly instantiated component has no window, no node, and no input. It
receives a viewport from its parent, and that is its entire authority to draw.

**Bounds.** A viewport is scoped to one node. The runtime rejects any mutation
naming a node outside the caller's viewport, and the compositor emits a clip
for the viewport's box, so a component that computes a rect at (9999, 9999)
has its pixels discarded by the rasterizer rather than trusted not to draw
them.

**Attenuation.** A parent derives a sub-viewport from its own for each child,
optionally narrower: a smaller box, no pointer input, no keyboard focus. A
child cannot widen what it was given, because the runtime records what each
viewport permits at the point it was derived.

**Slots.** A component that wants its parent to supply content exposes a slot
node. The parent assigns nodes from *its own* viewport to the slot; the child
positions the slot but cannot read or mutate what is inside it. This is how
a panel gets its buttons from its parent without either side gaining access to
the other's tree.

**Why the ids are safe.** A `node` is a `u32` the holder picks, so it is
forgeable by construction — and it does not matter, because an id is only
meaningful relative to the `viewport` handle it is passed with. The handle is the
capability: it lives in the holder's own component-model handle table, cannot be
forged or guessed, and the worst a forged id reaches is a node in a viewport the
caller already holds. Dropping the handle drops the subtree, and the runtime
learns it happened because it owns the resource's destructor.

**What the loader adds.** The scene is one capability among several. A component
reaches `zenafx:host/paint` or a network interface only if the loader bound it
(§6.2), and the check runs before instantiation, so a component asking for
something it may not have fails to load rather than failing at its first call.

**What none of this stops.** A component cannot draw outside its box, read its
parent's nodes, or reach an interface the loader did not bind. It can still
spend an unbounded amount of time inside a call it was legitimately asked to
make, and §6.5 says no other component runs while it does. A loop in one
component freezes the window.

The tools for that are wasmtime's epoch deadlines and fuel, and the useful
detail is that neither has to be fatal. `Store::epoch_deadline_trap` aborts, but
with async enabled `epoch_deadline_async_yield_and_update` yields back to the
host at the deadline and resumes later, and `fuel_async_yield_interval` does the
same on an instruction count. So a component that overruns its share of a frame
can be suspended and resumed on the next one instead of being killed — which is
the mechanism §18's frame-budget question needs, and is unbuilt.

## Tiers beyond boxes and text

A node is a rectangle with a transform and a clip. What happens inside it is
the component's choice among three tiers.

**Tier 1, retained boxes and text**, is what §7 and §8 describe: the host does
layout, shaping and high-DPI scaling, and the nodes are available for hit
testing and accessibility.

**Tier 2, a 2D vector canvas.** A canvas node carries a retained display list
of path commands that the component builds and mutates. The host rasterizes it
with the same renderer that draws Tier 1, which is why `zenafx:host/paint`'s
command list is the natural place for it to grow: adding `fill-path` and
`stroke-path` to `command` makes a canvas node a display list the component
owns rather than a separate mechanism.

**Tier 3, a WebGPU viewport.** A GPU viewport node gets a texture sized to its
box; the component renders into it through [`wasi:webgpu`][wasi-webgpu], which
tracks the [W3C WebGPU][webgpu] API, and presents it; the compositor maps the
texture into the scene with the right z-order and scissor.

[webgpu]: https://www.w3.org/TR/webgpu/
`zfx` already serves `wasi:webgpu` and the surface-to-device bridge
([graphical-runtime.md](./graphical-runtime.md)), so Tier 3 is mostly a matter
of giving a node a texture rather than new host machinery.

Pluggable layout algorithms belong here too: a component exporting a layout
interface, imported lexically by the component that wants it, with a
host-implemented `measure` import for text. The interface is the one in §8.5
plus that import, and §8.1 says why `measure` has to stay in the host rather
than be delegated to a third component.

## Compiler prerequisites

### What already works

The fixtures named here live under
`packages/zena-compiler/test-files/component/`. Unless marked otherwise they
are compiled, composed and run by
`npm run test:component -w @zena-lang/zena-compiler`; the ones marked
compile-level are asserted by `component-emission_test.zena` instead.

These fixtures are linked by `wasm-tools compose` rather than at run time,
because that is what the existing harness does. What they establish is that the
two sides' interfaces line up and that every value in them survives the
canonical ABI in both directions — which is the part ZenaFX depends on, and
which is independent of when the binding is made. The linking mechanism ZenaFX
uses is §6.2's.

- Components are emitted directly by `BinaryEmitter`; a program declares its
  world with `--wit`/`--world`, and disagreements with the world are compile
  errors ([component-emission.md](./component-emission.md)).
- A WIT-backed package is declared in a manifest as `{"wit": "./path"}`, and
  `import {...} from 'zenafx:ui/scene'` then resolves to the `scene`
  interface of the `zenafx:ui` package found there.
- **The whole type matrix across a composed boundary, with both sides
  written in Zena.** `geo-provider.zena` exports `fixture:geo/survey` and
  `geo-wit.zena` imports it; the consumer's `main` calls twelve of the
  provider's functions with records, variants, enums, options, lists, tuples
  and results going both ways, and the composed component returns 49. This is
  the shape `zenafx:ui/scene` needs, including a variant nested inside a
  record parameter.
- Exported interfaces of both synchronous and async functions
  (`greeter.wit`, `service.wit`), including results that flatten past one core
  value and come back through a return area.
- `stream<T>` of records in both directions between two Zena components
  (`gfx-provider.zena`, `gfx-consumer.zena`) — the shape the frame, pointer
  and key streams take.
- Two Zena components composed with `wasm-tools compose`, one awaiting a
  `future<s32>` the other settles (`compose-provider.zena`,
  `compose-consumer.zena`).
- Imported resources with methods, statics and constructors, and a borrowed
  resource inside a record parameter `use`d from another WIT package
  (`gfx-configure.zena`, compile-level).

Taken together these cover every construct the milestone 1 interfaces use.

### What the compiler still has to build

The interfaces above are designed against what WasmGC and WASI p3 permit, not
against what the Zena compiler emits today. Zena's one standing limit is that it
cannot be multi-threaded; everything else here is compiler work with a known
shape, so this is a work list rather than a set of constraints on the design.

**Providing a resource.** `viewport` is a resource the runtime component
exports, which needs `resource.new`, `resource.rep` and a destructor export
alongside the `resource.drop` the compiler already emits for imported handles.
Nothing else in §7 works without it, so it is the first item.

**An async world export alongside an interface that declares a resource.**
Compiling a program against a world that imports `zenafx:ui/scene` and exports
`main: async func()` fails with "the component target cannot export
'main$asyncEntry': it has no declaration to read a signature from", where the
same world without the scene import compiles. The entry wrapper and the
synthesized handle class interact somewhere; this is the first thing to
diagnose, because every milestone-1 program has that shape.

**Passing an imported resource handle between components.** A parent holds a
`viewport` it got from the runtime and hands it to a child through the child's
`mount`. Both components import the same resource type from the same instance,
so the handle is transferable; the lowering has to move it out of one handle
table and into the other rather than copying a representation.

**Deferrable exports.** §7.4's deferred delivery is the host's doing, but a
Zena component on either end has to tolerate it: an exported return-free
function that the host may call at a time of its choosing, and an imported one
whose call returns before the callee has run.

**Ergonomics of building records.** A `flex` value has nine fields, so every
call site that wants "a centred column" writes all nine. The demo below works
and reads badly. [record-presence.md](./record-presence.md) designs the
presence-optional fields that would fix it; until those land, a thin Zena
package over the raw WIT calls supplies the defaults.

## Milestones

### Milestone 1: text centred in a window

`zfx` loads two Zena components, binds the application's `zenafx:ui/scene`
import to the runtime component's export, and opens a window showing
"Hello, world" centred by a flexbox layout.

[softbuffer]: https://github.com/rust-windowing/softbuffer

New work, in order:

1. **WIT.** `packages/zenafx/wit/` holding `zenafx-ui.wit` and
   `zenafx-host.wit` from §7.3 and §8.5. Both are read as one document,
   because `readWitSource` concatenates a directory's `.wit` files in name
   order.
2. **Host: surface.** A `winit` loop in `zfx` under `ControlFlow::Wait`, one
   window, and `zenafx:host/surface` over it: `frames` written only after
   `request-redraw`, `pointer` and `keys` from `WindowEvent`.
3. **Host: text.** [`parley`][parley] behind `register-run` / `measure-run`,
   which brings `fontique`, `harfrust` and `skrifa` with it. A run id indexes a
   slab holding the shaped layout and its glyph raster cache.
4. **Host: layout.** [`taffy`][taffy] 0.14, rebuilt per `solve` from the flat
   node list, with the `compute_layout_with_measure` closure calling the text
   engine from step 3.
5. **Host: paint.** [`vello_cpu`][vello-cpu] rasterizing the display list into
   a buffer presented through [`softbuffer`][softbuffer], which the workspace
   already resolves at 0.4.8 by way of `frame-buffer-wasmtime`. `vello_cpu`
   0.2.0 re-exports [`vello_common`][vello]'s `color`, `kurbo` and `peniko`,
   which the GPU renderer shares, so the geometry and brush types the display
   list is built from survive a move to the GPU. Whether the renderer-facing
   scene API also survives it is worth checking when the versions are pinned.
6. **Host: the loader.** The §6.2 path, at its smallest: compile both
   components, read each one's imports, bind `zenafx:host/*` to the host
   implementations and the application's `zenafx:ui/scene` import to a
   trampoline over the runtime instance's export, then instantiate both and
   call the application's `main`. Two components and one guest→guest binding is
   enough to need a fresh `Linker` per instance, so the shape is the real one
   from the start; fetching over the network, caching and the policy check come
   in milestone 4.
7. **Runtime component.** `packages/zenafx-ui/zena/`: the node arena, the
   dirty set, the id table keyed by viewport, `flush` calling `solve` then
   `present`, and the paint walk. Compiled against `world runtime`.
8. **The application.** `examples/zenafx/hello.zena` and its world.
9. **Build wiring.** Two separate mechanisms have to be set up, and confusing
   them is the likely first stumble. A Zena `import {...} from
   'zenafx:ui/scene'` resolves through a **package manifest** entry, which is
   what makes the specifier's `zenafx` namespace WIT-backed:

   ```json
   {"packages": {"zenafx": {"wit": "./packages/zenafx/wit"}}}
   ```

   The **world** a component is checked against and emitted for comes from
   `--wit` and `--world` instead, pointing at a document that declares it.
   Then:

   ```bash
   zena build packages/zenafx-ui/zena/scene.zena -o runtime.wasm \
       --target component --wit packages/zenafx/wit --world runtime
   zena build examples/zenafx/hello.zena -o hello.wasm \
       --target component --wit examples/zenafx --world app
   zfx hello.wasm --provide zenafx:ui/scene=runtime.wasm
   ```

   The two `.wasm` files stay separate. `--provide` names which component
   satisfies an import; later it is a document that does, and later still a URL
   rather than a path.

   The world document can `import zenafx:ui/scene@0.1.0` by name without the
   `zenafx` WIT sitting beside it: when the target emits a component, the CLI
   collects the source of every WIT-backed package in the manifest and splices
   it into the declared world's document before parsing
   ([cli/main.zena](../../packages/zena-compiler/zena/cli/main.zena), the
   `packagesWit` collection).

The world the application is checked against:

```wit
// examples/zenafx/hello.wit
package demo:hello@0.1.0;

world app {
  use zenafx:ui/scene@0.1.0.{viewport};

  import zenafx:ui/scene@0.1.0;
  import zenafx:host/surface@0.1.0;

  /// The loader mints the root viewport and passes it in. Nothing an
  /// application imports can obtain one otherwise.
  export main: async func(host: viewport);
}
```

And the application itself. The spellings follow the WIT-typed module
conventions the compiler already uses: a `record` becomes a case class, a
`variant` a sealed class whose cases are named for the variant and the case
together, and an `option<T>` becomes `Option<T>` with `some`/`none` from
`zena:core` — as in
[geo-wit.zena](../../packages/zena-compiler/test-files/component/geo-wit.zena).

```zena
// examples/zenafx/hello.zena — world: demo:hello/app
import {Viewport, BoxOp, TextOp, OpMakeBox, OpMakeText, flush}
    from 'zenafx:ui/scene';
import {Flex, BoxLook, TextLook, Color, Edges, Axis, Justify, Align,
    LengthAuto, LengthPercent} from 'zenafx:ui/style';
import {frames, FrameEvent} from 'zenafx:host/surface';
import {Future} from 'zena:async';
import {Some, some, none} from 'zena:core';

/** Node ids are ours to choose. 0 is the viewport's root. */
let PAGE = 1 as u32;
let LABEL = 2 as u32;

let noPadding = new Edges(0.0, 0.0, 0.0, 0.0);
let paper = new Color(0.99, 0.99, 0.98, 1.0);
let ink = new Color(0.10, 0.10, 0.12, 1.0);

/** A column that fills its parent and centres its one child. */
let centred = new Flex(Axis.Column, Justify.Center, Align.Center, 0.0,
    noPadding, new LengthPercent(100.0), new LengthPercent(100.0), 1.0, 1.0);
/** A node sized by its own content. */
let intrinsic = new Flex(Axis.Row, Justify.Start, Align.Start, 0.0,
    noPadding, new LengthAuto(), new LengthAuto(), 0.0, 0.0);

export async function main(widget: Viewport): Future<void> {
  // The whole tree in one feed-forward batch: no ids come back, because
  // we named them.
  widget.apply([
    new OpMakeBox(new BoxOp(PAGE, 0 as u32, centred,
        new BoxLook(some(paper), none, 0.0, 0.0, 1.0))),
    new OpMakeText(new TextOp(LABEL, PAGE, 'Hello, world', intrinsic,
        new TextLook('system-ui', 48.0, 400 as u16, false, ink))),
  ]);
  widget.invalidate();

  let tick = frames();
  var open = true;
  while (open) {
    let event = await tick.readOne();
    if (event is Some<FrameEvent>) {
      flush();
    } else {
      open = false;
    }
  }
}
```

One `apply` for the whole tree, because naming our own ids means the second
operation can refer to the first without a round trip. The `while` loop is what
a template and a scheduler (§9, §10) replace.

Milestone 1 is done when `zfx` shows the window, and when resizing it
re-centres the text — which proves the layout solve, the measure callback and
the demand-driven redraw are all on the path.

### Later milestones

**Milestone 2: input and hit testing.** The pointer stream reaches the
application; the runtime hit-tests a point against the retained tree and
reports the node; an event handler changes a colour and the frame that follows
shows it. This is the first milestone where `bounds` earns its place.

**Milestone 3: widgets, templates and the scheduler.** `TemplateInstance`,
positional slots, per-widget dirty checking, the depth-ordered queue. A counter
whose label updates on click, making exactly one `apply` call per click.

**Milestone 4: a second component, fetched.** The root imports a child
component's world, derives a viewport for it, fills the slot the child offers
back, and receives an event from it over a deferred binding — three instances in
the graph, with the child named by URL, fetched, cached by content hash, and
checked against a policy before instantiation. This is the milestone that tests
§7.4, §7.5 and the capability model rather than describing them. The child should
be written in something other than Zena, so that the dispatch choice in §7.4 is
exercised rather than assumed.

**Milestone 5: Tier 2 and Tier 3.** Path commands in the display list, and a
GPU viewport node backed by `wasi:webgpu`. The existing `zfx` triangle fixture
becomes a node inside a ZenaFX tree instead of owning the window.

## Repository layout

```
packages/zenafx/
  wit/
    zenafx-ui.wit             # zenafx:ui@0.1.0
    zenafx-host.wit           # zenafx:host@0.1.0
  src/
    main.rs                   # existing: engine, wasi-gfx
    loader/
      mod.rs                  # fetch, compile, cache by content hash
      link.rs                 # per-instance Linker, import binding, policy
      bridge.rs               # guest->guest trampolines over func_new
    ui/
      mod.rs                  # registration for zenafx:host
      surface.rs              # winit loop, ControlFlow::Wait, event streams
      text.rs                 # parley, run table and glyph cache
      layout.rs               # taffy, flat tree in, rects out
      paint.rs                # vello_cpu + softbuffer
packages/zenafx-ui/
  package.json                # @zena-lang/zenafx-ui
  zena/
    scene.zena                # the exported scene interface
    tree.zena                 # node arena, dirty set, viewports
    flush.zena                # layout pass, paint walk
    template.zena             # milestone 3
    schedule.zena             # milestone 3
examples/zenafx/
  hello.zena
  hello.wit
```

The runtime component goes in its own package rather than under `zenafx`,
because it is a Zena program compiled to a component and has nothing to do
with the Rust crate beyond sharing the WIT directory.

## Alternatives considered

**A retained scene graph in Rust, with the Zena work deferred.** The host
would own the node tree and serve `zenafx:ui/scene` directly, and milestone 1
would need no runtime component and no guest-to-guest binding. It was rejected on total
work: a retained tree, dirty set, viewport table and paint walk in Rust is
about the same size as the same thing in Zena, and it is then either discarded
or maintained as a second implementation. The host as specified holds no tree
at all, so its share of milestone 1 is smaller than it would be here.

The structure does keep the alternative available at low cost, because
`zenafx:ui/scene` is a WIT interface rather than a Zena API. A host
implementation of it would be swappable with the component implementation
without any change to an application. That is worth preserving as a
performance escape hatch, and worth not building now.

**Layout as a guest component from the start.** Measurement is what rules it
out for milestone 1: a guest solver needs a re-entrant call into the host text
engine mid-solve, which is more machinery than calling `taffy` in the host, and
it buys nothing until someone writes a custom layout. §13 describes the shape
it takes then.

**Signals as a host resource.** Rejected in §11: a `variant value` erases the
value's type at every read.

**A global registry, so a template can name a child widget by tag.** Rejected
because it reintroduces the collision described in §4: a component that wants
a child imports that child's world, and two libraries that each supply a
button then coexist.

## Open questions

1. **Whether the loader should refuse a cyclic binding outright.** §6.4 settles
   what happens when one is exercised — `do_not_enter` and
   `Trap::CannotBlockSyncTask`, so a deadlock rather than corruption. What is
   undecided is whether the loader should detect the cycle when it binds and
   refuse, or bind it and let the trap report it. Refusing needs a definition of
   which bindings count as cyclic given that the host sits between every pair,
   and that definition is not obvious; the trap arrives with a component-model
   backtrace and no false positives. A probe would settle the ergonomics: a
   component exporting `ping` and importing `host-call`, with `ping` calling
   `host-call` and the host calling `ping` again, run under the wasmtime the
   workspace pins.
2. **Component identity.** Two documents naming the same URL: one instance
   shared, or one per document? Sharing makes a component a channel between
   documents, which the isolation story has to account for. A separate instance
   per document costs memory and loses warm state. The compiled artifact can be
   cached by content hash either way; this question is about instances.
3. **Integrity and versioning of a fetched component.** A URL is not a
   version, and a component that changes under the same URL changes an
   application's behaviour silently. Whether a document pins a content hash
   alongside the URL, and what happens when the fetched bytes do not match, is
   undecided.
4. **Cost of the dynamic binding path.** A guest→guest call goes through a
   host function that lowers and lifts through `Val`. On the frame path that is
   `apply` and `flush` once per frame, which should be immaterial, but it has
   not been measured. If it is not immaterial, `zenafx:ui` is known at build
   time and can use generated bindings for those two calls while everything
   else stays dynamic.
5. **Coordinate spaces.** `bounds` returns window coordinates, so a component
   can learn where it sits on screen. Viewport-local coordinates would hide
   that, and would then need pointer positions translated into each
   component's own space before they are dispatched.
6. **Retained display lists.** At what scene size does
   `present(list<command>)` stop being adequate, and what replaces it — a
   retained list with per-node invalidation, or damage rectangles plus a full
   list for the damaged area? The answer needs a measurement on a real scene.
7. **Text runs and reflow.** A run is shaped at registration and measured at
   a width during the solve. Whether the measured layout at the final width is
   reused for painting, or the run is reshaped once layout settles, decides
   whether a wrapped paragraph costs one shaping pass per frame or none.
8. **Accessibility.** A retained tree of boxes and text with known bounds is
   most of what an accessibility tree needs. Whether the host derives one from
   the scene, or components describe one explicitly, is undecided.
9. **Per-component frame budget.** A component that takes 50 ms in its update
   stalls the frame for everyone: the frame is one synchronous top-down pass,
   and §6.5 rules out running the others meanwhile. §12 names the mechanism —
   an async epoch deadline or a fuel interval yields out of the overrunning
   component and resumes it later. What that should mean for the frame is
   undecided: composite the slow component from its previous frame and carry
   its update into the next one, or hold the whole frame until it finishes.
   The first choice needs the scene graph to keep a component's last-good
   subtree, which it does not today.

## Related

- [graphical-runtime.md](./graphical-runtime.md) — `zfx`, the host binary,
  and the `wasi-gfx` / `wasi:webgpu` interfaces it serves today
- [component-model.md](./component-model.md) — WIT interop: what an
  `import ... from` a WIT means, resource lifetime, and the type mapping
- [component-emission.md](./component-emission.md) — how components are
  emitted, and the `--wit`/`--world` surface
- [declarative.md](./declarative.md) — the `html <tag>` syntax that becomes
  ZenaFX's template authoring surface
- [capabilities.md](./capabilities.md) — capability-based I/O in the language,
  of which viewports are one instance
- [streams.md](./streams.md) — `Stream<T>` and the rendezvous core the event
  streams ride on
- [record-presence.md](./record-presence.md) — presence-optional record
  fields, which the style records want
