# ZenaFX UI Runtime

## Status

- **Status**: Proposed, and partly built. `zfx --app` loads a Zena component,
  binds its `zenafx:host` imports and shows the window it draws. Text, flexbox
  layout, painting and the window are real ([Host primitives](#host-primitives)),
  and so is the retained tree: templates, holes, slots and one box per widget,
  driven by `examples/zenafx/counter/` and `examples/zenafx/widgets/`.
  [Implementation status of the protocol](#implementation-status-of-the-protocol)
  says which parts of [The scene protocol](#the-scene-protocol) are built.
  The host holds the node tree, and
  [The node tree in the host](#the-node-tree-in-the-host) says why. An earlier
  version of this design put the tree in a Zena component;
  [The runtime component design](#the-runtime-component-design) keeps that
  version, which is not built. Pointer events
  reach a component's listeners, driven by `examples/zenafx/button/`, and
  [Implementation status of events](#implementation-status-of-events) says how
  that differs from the design. A template can declare state styles for hovered
  and pressed, which the host draws without entering the component:
  [State styles](#state-styles). Keys reach the listeners of the node that has
  the focus, and the host moves the focus:
  [The keyboard and the focus](#the-keyboard-and-the-focus). A text field is a
  widget in the component, with the host drawing its caret:
  [Text fields](#text-fields). Widget-defined events, context, style rules,
  navigation and assets do not exist. The authoring surface in
  [zenafx-widget-authoring.md](./zenafx-widget-authoring.md) does not exist, so a
  widget is written by hand against the protocol.
- **Date**: 2026-10-02
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

- [ZenaFX UI Runtime](#zenafx-ui-runtime)
  - [Status](#status)
  - [Contents](#contents)
  - [Overview](#overview)
  - [Terms](#terms)
  - [Prior art](#prior-art)
  - [Division of labour between Zena and Rust](#division-of-labour-between-zena-and-rust)
    - [The rule](#the-rule)
    - [The split](#the-split)
    - [The node tree in the host](#the-node-tree-in-the-host)
    - [What the split costs](#what-the-split-costs)
  - [Component and process structure](#component-and-process-structure)
    - [The component graph](#the-component-graph)
    - [Runtime linking and import interposition](#runtime-linking-and-import-interposition)
    - [The host drives the frame](#the-host-drives-the-frame)
    - [Call direction within a frame](#call-direction-within-a-frame)
    - [Serialization across components](#serialization-across-components)
  - [Events and context](#events-and-context)
    - [Geometry and style types](#geometry-and-style-types)
    - [Events: input, and what a widget reports](#events-input-and-what-a-widget-reports)
      - [Handlers stay in the guest; registrations cross](#handlers-stay-in-the-guest-registrations-cross)
      - [Scope, not per-type bubbling](#scope-not-per-type-bubbling)
      - [Why this survives the boundary moving](#why-this-survives-the-boundary-moving)
      - [Pushed bindings elsewhere](#pushed-bindings-elsewhere)
      - [WIT](#wit)
      - [Implementation status of events](#implementation-status-of-events)
      - [State styles](#state-styles)
      - [Scrolling](#scrolling)
      - [Drawing outside a box](#drawing-outside-a-box)
      - [Pointer capture](#pointer-capture)
      - [Cursors](#cursors)
      - [The keyboard and the focus](#the-keyboard-and-the-focus)
      - [Text fields](#text-fields)
      - [Selecting text and the clipboard](#selecting-text-and-the-clipboard)
    - [Context: values that inherit down the tree](#context-values-that-inherit-down-the-tree)
  - [Host primitives](#host-primitives)
    - [Layout with measurement inside the solve](#layout-with-measurement-inside-the-solve)
      - [Layout is a recursive query, not two passes](#layout-is-a-recursive-query-not-two-passes)
    - [Text](#text)
    - [Paint](#paint)
    - [Surface, frames and demand-driven redraw](#surface-frames-and-demand-driven-redraw)
    - [`zenafx:host` in WIT](#zenafxhost-in-wit)
  - [The scene protocol](#the-scene-protocol)
    - [Reasons for a retained tree](#reasons-for-a-retained-tree)
    - [Templates, nodes and bindings](#templates-nodes-and-bindings)
    - [One box per widget](#one-box-per-widget)
    - [Interior and content](#interior-and-content)
    - [Detached nodes and slot assignment](#detached-nodes-and-slot-assignment)
    - [Identity and host state](#identity-and-host-state)
    - [Batching and the frame](#batching-and-the-frame)
    - [Implementation status of the protocol](#implementation-status-of-the-protocol)
    - [Moving the component boundary](#moving-the-component-boundary)
  - [Scheduling](#scheduling)
  - [Reactive state](#reactive-state)
  - [Capabilities and isolation](#capabilities-and-isolation)
  - [Tiers beyond boxes and text](#tiers-beyond-boxes-and-text)
  - [Compiler prerequisites](#compiler-prerequisites)
    - [What already works](#what-already-works)
    - [What the compiler still has to build](#what-the-compiler-still-has-to-build)
  - [Milestones](#milestones)
    - [Milestone 1: text centred in a window](#milestone-1-text-centred-in-a-window)
    - [Later milestones](#later-milestones)
  - [Repository layout](#repository-layout)
  - [Prior implementations](#prior-implementations)
  - [The runtime component design](#the-runtime-component-design)
    - [The viewport is the capability; nodes are ids inside it](#the-viewport-is-the-capability-nodes-are-ids-inside-it)
    - [Feed-forward mutation](#feed-forward-mutation)
    - [`zenafx:ui` in WIT](#zenafxui-in-wit)
    - [The root drives the frame](#the-root-drives-the-frame)
  - [Alternatives considered](#alternatives-considered)
  - [Open questions](#open-questions)
  - [Related](#related)

Cross-references in this document link to these headings. They are not
numbered: a number shifts silently when a section is inserted or moved, and a
link either resolves or visibly does not.

## Overview

ZenaFX is a UI system in which an application is a graph of WebAssembly
components that share one window. Each component holds private state and
private UI nodes: the boxes and runs of text that layout positions and paint
draws. A widget — a button, a card, a label — occupies one node and owns what
hangs beneath it. A component receives the authority to draw from whoever
granted it, and cannot reach into another component's nodes.

Rendering is retained: a component builds its nodes once and then writes values
into them, instead of re-issuing drawing commands every frame. Painting
is demand-driven: a frame happens because something was invalidated, not
because 16 ms elapsed.

Composition happens at run time, the way a web page's does. The host fetches a
component, reads the imports its component type declares, binds each one to
something it chooses, and instantiates it — with nothing linked ahead of time
and no build step that fuses an application to its dependencies. That is what
lets a document name a component by URL, and it is what puts the host in
position to decide, per instance, which interfaces that component reaches at
all. [Runtime linking](#runtime-linking-and-import-interposition) describes the mechanism.

Two further consequences of the structure shape the rest of the design. A
component reaches a child by importing the child's WIT world, so a child is
named by the interface it implements, and two libraries that each supply a
button coexist. A component draws only inside the box its parent gave it, and
the compositor clips it there in hardware, so many mutually untrusted components
can share one window.

The division of labour is the other half of the design. There are two trees.
The widget tree, with each widget's state, its handlers and the order widgets
update in, is written in Zena and lives in the component that owns the widgets.
The node tree, with layout, text shaping, hit testing, painting and the OS event
loop, is held by the Rust host behind one WIT interface, `zenafx:host/scene`.
[Division of labour](#division-of-labour-between-zena-and-rust) gives the rule
that produced that split and what it costs.

## Terms

- **Component** always means a WebAssembly component in the sense of the
  [Component Model][component-model]. It never means a UI widget. An instance of
  one is a running program holding any number of widget definitions and widget
  instances, with no I/O it was not granted.
- **Widget** is the unit of UI: private state, a template, and an update
  function. A widget may be a component of its own or one of many inside a
  component, and [Moving the component boundary](#moving-the-component-boundary) is
  about why that choice is free.
- **Node** is an entry in the retained tree: a box, a text run, a slot, a
  canvas, or a GPU viewport. Nodes are what layout and paint operate on.
- **Node tree** is the tree of nodes for one window. The host holds it. A
  component reaches a node only through a `node` handle the host gave it, and
  the handle is its authority over that node and what is beneath it.
- **Widget tree** is the tree of widget instances inside one component. The
  host never sees it. It has one entry per widget, where the node tree has one
  per box and text run.
- **Display list** is a flat sequence of paint commands for one frame:
  rounded quads, glyph runs, clip pushes and pops. The host builds it from the
  node tree, and no component sees one.
- **Viewport** and **runtime component** belong to
  [The runtime component design](#the-runtime-component-design), an earlier
  version of this document in which a Zena component held the node tree. A
  viewport was the authority to build nodes under one node, and the `node`
  handle has that role now.

[component-model]: https://github.com/WebAssembly/component-model

## Prior art

Three systems supply the main ideas, and the web supplies two mechanisms ZenaFX
replaces.

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
cost, and sending a handful of values is not. ZenaFX also adopts Lit's
guest-side directive model (`cache`, `repeat`) over detachable nodes, keeping
branch caching and keyed list reconciliation in guest libraries instead of in
the host protocol.

**[Solid][solid]** runs a component once and routes every later change through a
fine-grained subscription, so writing a piece of state updates the one place that
reads it with no re-run and no tree comparison. ZenaFX takes that for the same
reason it takes Lit's templates: a change that arrives as one value is a change
that costs one small call across the boundary.

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
[solid]: https://www.solidjs.com
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
Writing that in Zena would take months and produce a worse result. A widget
tree with state, handlers and an update queue is bookkeeping with no external
dependency, and writing it in Zena exercises the language on a real program.

A second rule decides the cases the first leaves open. **Work that needs the
nodes' rectangles, or that has to happen on a frame without entering a
component, belongs with the node tree.** Hit testing needs rectangles. A hover
style, a scroll and a resize each have to reach the screen while a component is
busy or has nothing to say. [The node tree in the host](#the-node-tree-in-the-host)
applies the two rules to the tree itself.

[parley]: https://github.com/linebender/parley
[harfrust]: https://github.com/harfbuzz/harfrust
[skrifa]: https://github.com/googlefonts/fontations

### The split

| Concern                                     | Where          | Reason                                                              |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Window, OS input, vsync                     | Rust, in `zfx` | [`winit`][winit]; macOS requires the event loop on the main thread  |
| Text layout, shaping, line breaking         | Rust           | [`parley`][parley]: Unicode and OpenType tables                     |
| Flexbox and grid solving                    | Rust           | [`taffy`][taffy]                                                    |
| Vector and glyph rasterization              | Rust           | [`vello_cpu`][vello-cpu] first, [`vello`][vello] on the GPU later   |
| GPU pipelines for Tier 3                    | Rust           | [`wgpu`][wgpu], already served through [`wasi:webgpu`][wasi-webgpu] |
| Retained node tree, slots and their content | Rust           | layout, paint and hit testing all read it on every frame            |
| Dirty tracking, when to solve and paint     | Rust           | follows from holding the tree                                       |
| Hit testing, hover and pressed state        | Rust           | needs rectangles; runs on pointer moves that reach no listener      |
| Scroll offsets, transitions, text editing   | Rust           | have to reach the screen without entering a component               |
| The accessibility tree                      | Rust           | derived from the node tree, sent to the OS by the host              |
| Which component may reach which node        | Rust           | the host mints every `node` handle                                  |
| Widget instances, props, state, lifecycle   | Zena           | application semantics; no external dependency                       |
| Templates and which holes changed           | Zena           | the target `html` blocks lower to                                   |
| Update order among widgets                  | Zena           | ordering policy over the widget tree                                |
| Event handlers, key bindings, focus policy  | Zena           | closures and policy; the host delivers events as data               |
| The widget library                          | Zena           | versioned with the application that uses it                         |

Transitions, text editing and the accessibility tree are not built. The table
says where each goes.

[winit]: https://github.com/rust-windowing/winit
[taffy]: https://github.com/DioxusLabs/taffy
[vello]: https://github.com/linebender/vello
[vello-cpu]: https://docs.rs/vello_cpu
[wgpu]: https://wgpu.rs
[wasi-webgpu]: https://github.com/WebAssembly/wasi-webgpu

### The node tree in the host

The host holds the node tree, in `Scene` in
[`ui/scene.rs`](../../packages/zenafx/src/ui/scene.rs). A component holds its
widget tree. The two are different trees and neither is a copy of the other:

|              | Widget tree, in a component                                 | Node tree, in the host                                    |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------- |
| Entries      | one per widget instance                                     | one per box, text run or slot                             |
| Holds        | state, handlers, the template shown, each hole's last value | layout, style, rectangles, shaped text, hover, listeners  |
| Changes when | an event or a timer runs the component's code               | a write arrives, the window resizes, or the pointer moves |

The overlap is what a component needs in order to send only changes: the last
value of each hole, and how many children each slot has.

An earlier version of this document put the node tree in a Zena component,
described under [The runtime component design](#the-runtime-component-design).
The reasons it is in the host:

- **Every frame reads it.** The solve, the paint walk and the hit test each
  visit nodes. With the tree in a component, each of those is a call into that
  component, or the host keeps a second copy of the tree and the two have to
  agree.
- **A frame should not need a component.** A resize, a pointer moving over
  nodes that hear nothing, a hover style and a scroll are all handled from the
  tree and a rectangle. `resizing_never_re_enters_the_component` and the hover
  tests in `packages/zenafx/tests/button.rs` assert that these enter no
  component. A component that is busy or stuck then cannot freeze the window.
- **The libraries are Rust and take a tree.** `taffy` and `parley` are in the
  host already. Text editing, the accessibility tree and overlay placement come
  from Rust libraries that read nodes and rectangles directly:
  [zenafx-libraries-and-examples.md](./zenafx-libraries-and-examples.md).
- **Size.** A retained tree, a dirty set and a paint walk are about as long in
  Rust as in Zena, so the first rule does not choose between them.

What the runtime component design offered is that the scene's behaviour could
be versioned with an application. A component would ship the scene it was
tested against, and a newer host could not change how it behaves. That goal
stays, and the interface carries it:

- **The interface is versioned.** `zenafx:host/scene` is a WIT package with a
  version in its name. [Runtime linking](#runtime-linking-and-import-interposition)
  builds a linker for each instance, so the host can bind one component to
  `@0.1` and another to `@0.2` over one tree.
- **An old version can leave the host.** The interface is WIT, so a Zena
  component can serve `@0.1` to an old application by calling `@0.3`. Only old
  applications pay for the extra component, and the host does not accumulate
  versions. This is not built, and it depends on every later version being able
  to express what an earlier one could.
- **What changes often is already in the component.** The widget model,
  reactivity, the widget library and key bindings are Zena, linked into the
  application and versioned with it. The web has the same split: a page ships
  its framework and not the DOM.
- **A version is defined by tests.** "The behaviour of `@0.1`" is a claim that
  can be checked only against examples with asserted geometry and event order.
  The tests in `packages/zenafx/tests/` are the start of that suite.

Two things are not pinned by any of this. `taffy` and `parley` are in the host
in either design, so a layout or a line break can change when the host updates
them. And a version of the interface the host no longer serves needs the
adapter above, which does not exist yet.

### What the split costs

One boundary lies between a widget and its pixels: the component's calls to
`zenafx:host/scene`. It has to stay cheap.

A component sends the values that changed and not its tree. A widget whose
update changes three holes sends three values, and
[Batching and the frame](#batching-and-the-frame) puts a frame's writes in one
call. Building a subtree costs one `render` for each widget in it, since a
template carries a widget's whole interior.

The host calls a component only to deliver an event a listener asked for.
Layout, painting and hit testing make no calls, because the host has everything
they read.

The host walks the whole tree into a display list for every frame. For the
first milestones that is the right simplification. A scene with tens of
thousands of quads will want a retained display list with per-node
invalidation, which is a change inside the host and not to any interface, since
nothing a component calls carries a display list.

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
|  the node tree: solve, paint, hit test, hover, listeners              |
|                                                                       |
|  fetches components, binds their imports one instance at a time,      |
|  serves zenafx:host/{scene, events} and                               |
|         wasi:webgpu, wasi-gfx:surface, wasi:cli                       |
+-----------------------------------------------------------------------+
            ^                                  ^
            | zenafx:host/scene                | zenafx:host/scene
            |                                  |
   +--------------------+            +---------------------------+
   |  Application root  |  child's   |  Child component          |
   |  (Zena)            |  own world |  (any language)           |
   |                    +----------->|                           |
   |  widget tree,      |            |  its own widgets,         |
   |  framework library |            |  rendered into the nodes  |
   |                    |            |  its parent handed it     |
   +--------------------+            +---------------------------+
```

Each component writes to the host's tree through the `node` handles it holds.
The arrow between the two components is a binding the host makes at load time,
not a link baked into either binary. One component in a window is built. A
child component is designed in [Interior and content](#interior-and-content)
and not built.

The arrows are a graph and not always a tree. A `node` handle is a value, so an
instance can be handed nodes by several parents and sit at several places in the
node tree. The loader does not require the bindings between components to be
acyclic; what happens when a cycle is exercised is under
[Call direction](#call-direction-within-a-frame), and whether to reject one at
bind time is open.

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
linker built for one instance can bind `zenafx:host/scene` to an implementation
scoped to that component's nodes, at the version of the interface that
component was built against, and bind nothing at all where the policy says no.
The blanket registrations — `wasmtime_wasi::p3::add_to_linker`
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
possible at all, and also what makes them cost something — [What the split costs](#what-the-split-costs) bounds how
often the frame path crosses one.

None of this is speculative. A server-side component runner outside this
repository already does it — a fresh `Linker` per execution, a pre-instantiation
check of `component_type().imports()` against an allowlist that fails closed,
host functions registered through `root.instance(name)?.func_new(...)` with
return values shaped from the import's own declared result type, and a `WasiCtx`
whose stdio, environment and preopens vary by how far the component is trusted.
ZenaFX needs the same five steps with a different set of interfaces and a window
on the end of it.

### The host drives the frame

A frame is the host's work. When the tree was written, the window resized or a
hover state changed, the host solves the layout, tests the pointer against the
new rectangles, and paints. It calls no component to do so.

A component runs at other times: when its `main` starts, when an event it
listens for arrives, and when a timer or a fetch it started completes. What it
does then is write to the tree, and each write asks the host for a frame.

### Call direction within a frame

No component is called during a frame, so the calls this section constrains are
the ones between components: a parent calling an export of a child it embeds, or
a component calling a service that is another component.

Runtime linking makes a cyclic binding between components expressible.
Build-time composition does not: `wac` and `wasm-tools compose` both require a
DAG. But a host trampoline resolves its target when the call happens and not
when the importer is instantiated, so the host can instantiate two components
and then bind each to the other.

Whether such a cycle can run depends on re-entry. A synchronous export cannot be
re-entered, and whether a component can be re-entered at all depends on how its
exports are lifted. The three cases are visible in wasmtime 48.0.2's
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
  ([wit-module-synth.zena](../../packages/compiler/src/lib/wit-module-synth.zena)).

The same two facts show the way out. A synchronous activation has no way to
yield, so anything requiring the guest to make progress while an outer call is
suspended cannot make progress. An `async`-lifted export does have a way: it
returns a task, and the host re-enters through the callback once the outer call
has returned, which is how Zena already pumps streams and futures across a
component boundary.

ZenaFX therefore adopts a rule. **A synchronous guest→guest call must run to
completion without suspending.** The callee changes its own state, returns, and
is not on the stack when anything else calls it. Anything that needs to await
belongs in an `async`-lifted export, where re-entry happens by callback after a
return instead of by nesting. Calls from a component to `zenafx:host/scene` are
not guest→guest calls: the host does the work and returns.

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

The call direction between components is therefore fixed: a parent calls into
the child it handed a node to, and a child reaches its parent through an event
the host delivers ([Events](#events-input-and-what-a-widget-reports)). Every
component calls the host, and the host calls a component only to start it and to
deliver an event.

Whether a frame enters a component at all is what decides how a slow or blocked
component affects the window, so it is a property to settle before trusting one
less than fully. With the tree in the host and no component on the frame path,
a component stuck in a loop leaves its last-written values on screen and the
window keeps repainting; `the_entry_is_called_once` asserts that a frame does not
re-enter a component that is still running work. The exposure that remains is
host work the component asked for, since the scene and text locks are held for
the duration of a `render` call and shaping happens inside it — bounded by what
one call costs rather than by how long a guest runs. A guest layout solver from
[Tiers beyond boxes and text](#tiers-beyond-boxes-and-text) puts a guest back on
the frame path and gives that property up for the subtree it lays out.

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

Two things follow. The first is that the window's thread is not in that store.
It solves and paints from the host's tree while a component runs, and takes the
scene's lock only for the length of a write. The second is that one slow
component holds up every other component in the window, though not the frame,
which [Capabilities and isolation](#capabilities-and-isolation) takes up.

A store per component is the alternative, and it buys real parallelism at a
price: cross-store calls cannot pass component-model resource handles directly,
and everything crossing between them has to be copied through the host. For a
scene graph whose whole point is cheap incremental mutation from many
components, that is the wrong trade today. It becomes interesting if a component
wants a worker for computation rather than for drawing, which is a separate
store and a separate question from the frame path.

## Events and context

The node tree is written through [The scene protocol](#the-scene-protocol).
This section covers the two things that travel along the tree and are not
writes to it: events, which go up, and inherited values, which go down.

### Geometry and style types

`zenafx:host/scene` takes its geometry and style records from the `zenafx:ui`
package in [`zenafx.wit`](../../packages/zenafx/wit/zenafx.wit):

```wit
package zenafx:ui@0.1.0;

interface geometry {
  record size { width: f32, height: f32 }
  record rect { x: f32, y: f32, width: f32, height: f32 }
}

interface style {
  /// Non-premultiplied sRGB; each channel runs 0..1.
  record color { r: f32, g: f32, b: f32, a: f32 }

  record box-style {
    background: option<color>,
    border-color: option<color>,
    border-width: f32,
    corner-radius: f32,
    opacity: f32,
  }

  record text-style {
    family: string,
    size: f32,
    weight: u16,
    italic: bool,
    color: color,
  }

  /// `percent` is a CSS percentage of the containing block: 100.0 is full,
  /// not 1.0.
  variant length { auto, px(f32), percent(f32) }
  enum axis { row, column }
  enum justify { start, center, end, space-between }
  enum align { start, center, end, stretch }
  record edges { top: f32, right: f32, bottom: f32, left: f32 }

  /// A node's own box. Geometry only: nothing here affects painting, and
  /// nothing in `box-style` or `text-style` affects measurement.
  record box {
    width: length,
    height: length,
    grow: f32,
    shrink: f32,
    padding: edges,
    overflow-x: overflow,
    overflow-y: overflow,
  }

  /// How a node lays out its children: as items in a row or a column, or
  /// as text in lines. Each case holds its own fields.
  variant layout { flex(flex), flow(flow) }

  record flex {
    axis: axis,
    justify-content: justify,
    align-items: align,
    gap: f32,
  }

  /// [zenafx-text-flow.md](./zenafx-text-flow.md).
  record flow { align: text-align, line-height: option<f32> }
}
```

`box` and `layout` describe geometry and `box-style` describes paint style,
with no field in one affecting the other. That separation is what lets the host skip a
layout solve when only colours changed, and skip re-measuring text when only a
parent's background changed.

### Events: input, and what a widget reports

[Call direction](#call-direction-within-a-frame) fixes the call direction: parents call children, components call the
host, and nothing calls back into a component whose activation is still on the
stack. Two things run against that.

Input arrives from outside the tree and has to reach whoever owns what was
pointed at, which the sender cannot know. And a child telling its parent
something — a button was pressed, a size settled — runs against the direction of
the tree, where a direct call would re-enter the parent that is mid-call inside
it.

They are the same problem, and the host answers both by **dispatching**. A
component registers interest in an event type on a node it owns; the registration
is data the host keeps; the host finds the target, walks the scene path, and calls
each registered owner in turn. No component calls another, in either direction,
so [Call direction](#call-direction-within-a-frame)'s reentrancy question does not arise for either.

#### Handlers stay in the guest; registrations cross

A handler cannot cross a boundary, because WIT carries no function type — the
same limit [Context](#context-values-that-inherit-down-the-tree) notes about the web's context protocol, that a callback inside
the payload is not something WIT data carries. That rules out sending the
handler, and nothing more:

- the closure stays in a table the component's framework keeps, keyed by node;
- what crosses is a **registration**: a node, an event type, a scope and a phase;
- the host calls one exported entry point per component, naming the node;
- the framework looks the node up and invokes the closure.

An author writes a handler on a node, and the funcref never leaves the component.

The registration being host-side data is what makes propagation cheap: the host
knows, before it calls anything, which nodes on the path are registered for this
type, so a path with none costs nothing. This is the property that decides
against the alternative of a child accumulating events for its parent to poll —
a poll pays for a call to discover there was nothing to report, and pays it per
parent per frame.

#### Scope, not per-type bubbling

An ancestor listening for a pointer crossing usually wants its own boxes and not
every descendant's. The DOM meets that need by having two event types,
`mouseenter` beside `mouseover`, and a table of which types bubble. Here it is a
**scope on the registration**:

- **self** — deliver only when this node is the target;
- **subtree** — deliver when this node or any node beneath it is the target.

One event type can then be heard either way by different listeners, the host
filters by scope before it calls anything, and there is no per-type table to
remember. Scope is a degenerate predicate, so the selector algebra in
[zenafx-widget-authoring.md](./zenafx-widget-authoring.md#selectors-as-data)
could express more of it later without a second mechanism.

A **phase** on the registration covers interception — a modal that swallows
clicks, a scroll container claiming a drag that began on a child. Those want the
event before the target and the ability to stop it, which is a different
registration rather than a flag on every listener that mostly wants the default.

Two properties of the DOM model disappear rather than being decided. Propagation
has no composed-versus-local distinction, because the scene path _is_ the
composed path and there is no second tree. And an event type is identified by a
WIT type rather than a string: a widget that raises one declares it in an
interface, a widget that listens imports the same interface, and the loader
assigns the identity when it links them. Matching is static and a misspelling is
a compile error.

#### Why this survives the boundary moving

[Moving the component boundary](#moving-the-component-boundary) requires that interposition not change when a call runs relative to its
caller, since that is what would make one source tree behave differently
depending on how it was packaged. Dispatch satisfies it directly: the
registration is the host's either way, so a listener in the same component and a
listener in another are both reached by a synchronous call from the host, in the
same order, with the same latency. Fusing two components removes a boundary
crossing and changes nothing observable.

A mediator keeps its powers. It may refuse to bind, deny a delivery, or rewrite a
payload, and the components on either side cannot tell it was there.

#### Pushed bindings elsewhere

Some bindings are not part of the frame protocol — a component reaching a service
that happens to be another component rather than the host. For those a push is
the natural shape, and the loader decides whether it can be deferred:

- **Every function return-free.** The binding is _deferrable_. The host keeps a
  stack of the instances it has entered and not yet returned from; when a
  trampoline fires against a target on that stack, it records the call and
  returns, running it once the target's activation has unwound.
- **Any function with a result.** The binding is _direct only_ — the caller is
  waiting for a value, so there is nothing to defer. A re-entrant call on such a
  binding reaches `do_not_enter` and fails as [Call direction](#call-direction-within-a-frame) describes.

Both are decided from `ComponentFunc::results()` at bind time, so the loader
knows which bindings are safe on which edges without an annotation, a manifest,
or any trust in what a component claims about itself. Zena compiles async to
stackless state machines and can be re-entered; a component whose exports are all
plain `func` cannot. Neither has to know what the other is written in, because the
decision is the host's. One consequence for anyone designing a pushed interface:
**its functions return nothing**, or it cannot be deferred.

#### WIT

```wit
interface events {
  use scene.{node};

  /// Which targets a registration wants.
  enum scope {
    /// Only when this node is the target.
    self,
    /// When this node or any node beneath it is the target.
    subtree,
  }

  /// When a registration is offered the event.
  enum phase {
    /// After the target, walking up. The default.
    bubble,
    /// Before the target, walking down, with the option to stop it.
    intercept,
  }

  /// Register interest. `kind` is the identity the loader assigned to an event
  /// type declared in WIT, not a name matched at run time. Returns nothing, so
  /// it can be batched with a frame's writes ([Batching and the frame](#batching-and-the-frame)).
  listen: func(target: node, kind: u32, in-scope: scope, at: phase);
  unlisten: func(target: node, kind: u32);

  /// Raise a widget-defined event at one of this component's own nodes. The
  /// host queues it and dispatches after the current delivery returns.
  raise: func(source: node, kind: u32, payload: list<u8>);
}

/// What a component exports so the host can deliver to it. One entry point
/// rather than one per handler: the framework dispatches from `target`.
interface handler {
  use scene.{node};

  /// Whether the event was handled, which stops propagation.
  handle: func(target: node, kind: u32, payload: list<u8>) -> bool;
}
```

`handle` returns a value, so by the rule above it is direct rather than
deferrable. That is sound because it is called off the frame path and the host
never has an activation of the target outstanding when it calls: deliveries are
sequential, and an event raised while handling one is queued rather than nested.

The `payload: list<u8>` is the one place this falls short of the typing described
above, and [Open questions](#open-questions) keeps it. The candidates are a
closed variant of built-in input events with an opaque tail for widget-defined
ones, which keeps the common cases typed and gives up on the rest, and a
generated interface per event type, which is fully typed and grows the world with
every event a program declares.

Handling an event can raise more of them, because a parent responding to a child
may update and cause another child to report. The pass therefore runs to a
quiescent state or to a budget, and anything outstanding rides to the next frame
— the same budget [Open questions](#open-questions) needs for a slow component.

#### Implementation status of events

Pointer events are built, against the tree the host holds: `listen-pointer` is a
method of the `node` resource in `zenafx:host/scene`, and the event types are in
`zenafx:host/events`. `examples/zenafx/button/` has three listeners on a
button's box and one on the page it sits in, and
`packages/zenafx/tests/button.rs` presses and hovers it with no window.

The host remembers the rectangle that layout gave each node in the last frame.
The target of a pointer input is the node that frame painted last under the
pointer. The host then lists the listeners the input reaches from the ones it
holds, and an input that reaches none ends there: in that test the pointer
crosses the page and moves about inside the button without the component being
woken.

The interface is this, and five things in it differ from the one under
[WIT](#wit) above.

```wit
interface events {
  resource reply { stop-propagation: func(); }
  record delivery { event: pointer-event, reply: option<reply> }
}

resource node {
  listen-pointer: func(target: u32, kind: pointer-kind, in-scope: scope, at: phase)
      -> stream<delivery>;
}
```

- **Each listener has a stream.** `listen-pointer` adds a listener and returns
  a `stream<delivery>`. The host writes the listener's events to the stream,
  where the design has the host call an exported `handle`, and the component
  reads them in a loop that calls the handler. The component needs no table
  from a listener's name to its handler. Dropping the stream removes the
  listener, which is the design's `unlisten`. The host removes the listener
  and ends the stream when the node the listener is on goes away, and the
  component has no cleanup to do then: its loop finishes. A listener is added
  at a position in a template, as a binding is, so it lasts as long as the
  interior it was added in: a patch keeps it and a different template removes
  it.
- **A method listens for one family of events.** The design's `listen` takes
  any kind of event, as a `u32`, and delivers an untyped payload. A stream has
  one element type, so here each family of events whose payload has a shape of
  its own gets a method that returns a stream of that payload:
  `listen-pointer` for the five pointer kinds, and later ones for keys, for
  the wheel and for events a widget defines. The alternative that keeps one
  `listen` is a `variant` of every payload as the stream's element. Every
  listener would then test a discriminant, and adding a family would change
  the type every listener reads.
- **A listener answers through a resource the event carries.** The design's
  `handle` returns whether the event was handled, and a stream has no return
  value. A `down`, `up` or `move` therefore comes with a `reply`. The host
  offers the event to the next listener on its path when this one drops the
  reply, and to none if `stop-propagation` was called first, so each listener
  still sees the tree as the one before it left it. An `enter` or a `leave` carries no reply,
  since nothing a listener does with one changes who else hears it. What
  happened is a record, read without a call, and only the answer is a resource.
- **The payload is a `pointer-event` record** and the kind is an enum of `down`,
  `up`, `move`, `enter` and `leave`. This is the typed half of the closed variant
  that the third open question describes. `raise` and widget-defined events are
  not built, so nothing yet needs the opaque half.
- **A position is measured from the listening node's box.** A component
  therefore does not learn where its nodes sit in the window, which is the
  second choice in the open question about coordinate spaces.

A stream for every listener costs more than a table entry for every listener. A
component with one stream on its root takes about 3µs to go from a press to its
answer. With 10,000 streams on that node, of which the first stops the press,
it takes about 43µs. Starting those 10,000 adds about 30ms to the component's
start, and the process grows by about 4kB for each. These are from a probe
component on one machine, and they are the reason a list of thousands of rows
would listen once, on the node that holds the rows.

The host does not take the component reading its stream again as an answer. A
stream is read ahead: the read for the next event is under way before the
handler for this one has run. A version that answered on the next read let a
press through to the page before the button had stopped it, which
`a_press_the_button_stops_does_not_reach_the_page` in that test now covers. A
listener that keeps a reply therefore holds up the events behind it, in its own
component.

A component that reads a listener's stream has work outstanding for as long as
it listens, so its `main` never finishes. The window used to redraw for as long
as a component was running. It now redraws when the tree is written, and a
running component owes no frame on that account.

`enter` and `leave` use scope in a way the design does not spell out. They
report a listener's scope gaining or losing the target, and they do not
propagate. A `subtree` listener on a button hears `enter` when the pointer comes
onto the button from outside it, and nothing when the pointer moves between the
button's label and its padding. A `node` listener hears its own box becoming and
ceasing to be the target. One pair of kinds covers what the DOM splits into
`mouseenter` and `mouseover`.

A listener's events are written, and its answers waited for, on the component's
own thread, some time after the input that led to them, so the window's thread
never waits on a component. When a handler changes the tree, the `render` call
that changes it asks the window for a frame.

Keys arrive the same way, on a stream per listener, and
[The keyboard and the focus](#the-keyboard-and-the-focus) describes them.

Not built: a `wheel` listener, and a budget for a pass of handlers that keep
raising events.

#### State styles

A node is **hovered** while the pointer's target is that node or one beneath
it, and **pressed** from the primary button going down there until it comes up.
A template specifies a node's style while one of these holds, in a `states` list
beside its `bindings`:

```wit
record state-style {
  node: u32,      // the node that changes
  when: state,    // hovered, pressed, focused
  of: u32,        // the node whose state is read
  style: restyle, // fill(box-style), or text(text-style)
}
```

The scene applies them when it draws. `examples/zenafx/button/` has a hovered
and a pressed fill, and `packages/zenafx/tests/button.rs` takes the button
through both with one event written to the component, the `down` it listens
for.

A component could derive hover from `enter` and `leave`, and the first version
of the button did: two listeners, a field, and a hole for the fill. The states
are resolved where the tree is for four reasons.

- **The scene already has the fact.** It tracks the node under the pointer in
  order to send `enter` and `leave`. Sending that to a component so that the
  component can send a style back passes one fact across the boundary twice.
- **A pointer that has not moved.** A layout change, a scroll or a node
  appearing can change what is under the pointer with no pointer event. Only
  the holder of the rectangles can notice, so the scene tests the pointer again
  after each solve. `a_frame_notices_what_moved_under_a_still_pointer` in
  `ui/scene.rs` shrinks one button so that the next slides under the pointer.
- **A slow component.** Handlers run on the component's thread, in order. A
  component that is busy, or stuck, would freeze its own hover feedback. The
  scene's is drawn on the window's thread from data.
- **What comes next.** A transition between two styles, and the cursor's shape,
  both follow these states and both have to be driven by the frame.

State resolution needs the tree's parent links, its rectangles and its styles,
so it lives with the tree, in the host. It is one of the reasons the tree is
there ([The node tree in the host](#the-node-tree-in-the-host)). With the tree
in a Zena component, every pointer move would enter that component to be
hit-tested, where a move over nodes that hear nothing enters none today. A stuck
application would also stall that component, since
[Serialization across components](#serialization-across-components) puts them in
one store.

`node` and `of` are separate so that one node can follow another's state: a
label that changes colour while its button is hovered names itself in `node`
and position 0 in `of`. Both are positions in one template, so a widget can
restyle only its own interior. This is the `in-state` fact from
[Selectors as data](./zenafx-widget-authoring.md#selectors-as-data) with the
predicate fixed to "this node, or that node of the same template". The rule
sets designed there would replace the list.

A fill's state style is drawn in the frame that finds its state. A text node's
state style is shaped before the solve, because it can change how wide the run
is. When a frame finds a text node's state changed after it has solved, it
shapes the run for the next frame to lay out and owes that one frame more. A
frame that finds only fills changed owes none. A state style is the same for
every instance of a template: no hole writes one yet.

#### Scrolling

How far a box has scrolled is state of the same kind as what the pointer is
over, and it is kept in the same place. A box's layout says what becomes of
content that does not fit, on each axis:

```wit
enum overflow { clip, hidden, scroll }
```

All three cut the content off at the box, and
[Drawing outside a box](#drawing-outside-a-box) says why there is no fourth.
`clip` is the default, for a box whose content is expected to fit. `hidden` is
for a box meant to hold more than fits. `scroll` is `hidden`, and lets the
wheel move the content. The scene keeps the offset on the node, moves it when the wheel turns
over the box, and holds it within how far the content reaches each time it
solves. `examples/zenafx/scroll/` is forty rows in a box that shows six, and
`packages/zenafx/tests/scroll.rs` wheels it to its end and back with no event
written to the component.

Nothing is delivered for the wheel. A component could be told, and move its own
content by writing a layout hole, but each notch would then be an event to the
component and a write back, for a number the component has no other use for.
The reasons under [State styles](#state-styles) apply unchanged: the scene has
the rectangles, a busy component would freeze its own scrolling, and the frame
after a scroll has to find what is now under the pointer in any case. A `wheel`
listener for a component that wants one, such as a map that zooms, is not
built.

Three things follow from the offset being the scene's.

- **The solve does not know about it.** Layout places everything as if nothing
  were scrolled, and reports how far each box's content runs past it. The scene
  shifts each node by what the boxes it sits in have scrolled, and cuts it off
  at their edges, when it walks the solved tree. A scroll therefore changes
  nothing the solver reads, and the frame after one does not solve. The scene
  keeps the solver's last answer and uses it until the component writes the
  tree, the window changes size or the text scale does.
  `scrolling_and_hovering_solve_nothing` in `ui/scene.rs` counts the solves.
- **What is cut off is not there.** A node wholly outside the box it is cut
  off at is not drawn, so a frame costs what shows and not what the list holds.
  The pointer is not over it either: the hit test reads the same clip the paint
  does.
- **A box at its end passes the wheel on.** The wheel goes to the nearest box
  under the pointer that scrolls on that axis and has further to go, so a list
  at its last row scrolls the page it is in.

`overflow` is in `box` because it changes layout as well as paint. A `clip`
box is never laid out smaller than its content. A `hidden` or a `scroll` box
can be, which is what lets a list take the room it is given and scroll the
rest. `a_hidden_or_scrolling_box_can_be_smaller_than_its_content` in
`ui/layout.rs` has a 300 tall box in a 100 tall column each way. The names and
the meanings are CSS's and taffy's, so the host passes them through.

Nodes are painted level by level, so a box's content is not one run of commands
and a clip cannot be opened before a box and closed after it. The scene works
out the clip each node is under and opens and closes one round each stretch of
commands that share it. Painting a node's whole subtree before its next
sibling's would give one clip per box, and is the order overlapping content
will need.

A box with further to scroll shows a thumb, drawn by the scene over everything
else: as long, against the box, as the box is against its content. Every thumb
looks the same, and the pointer cannot drag one, which waits on pointer
capture.

Not built: reading or setting a box's offset from a component, which restoring
a position and scrolling a row into view both need, a clip that follows rounded
corners, a thumb that can be dragged or styled, and momentum.

#### Drawing outside a box

Nothing is drawn outside a box. Content that does not fit in a box is cut off
at the box's edge, and what is cut off is not under the pointer.

CSS draws such content outside the box unless the box says otherwise, with
`overflow: visible` as the default. That one default serves three purposes,
and each is better served by something that says what it is for.

**Content that was not meant to overflow.** A label too long for a button of a
fixed width. CSS draws it over whatever is beside the button. Here it is cut
off at the button, and the host logs a warning the first time, since the
author most likely did not intend it. This part is built. A box whose content
fits is drawn with no clip: the scene compares each child's box with its
parent's after a solve and narrows the clip only where one sticks out, so the
default costs the paint nothing in the usual case.
`content_that_does_not_fit_is_cut_off_by_default` and
`a_box_whose_content_fits_is_drawn_with_no_clip` in `ui/scene.rs` have both
cases. What a box cuts off also adds nothing to how far a box above it
scrolls, which `what_a_box_cuts_off_does_not_scroll_the_box_above` in
`ui/layout.rs` checks.

**Decorations.** A shadow, or a ring round the node with the focus, is drawn
beyond a box's edge. It belongs to the box's style, and how far it extends is
known from its declaration: a shadow's offset and blur, a ring's width. A
decoration is never under the pointer and takes no part in layout. A `clip`
box does not cut off the decorations of the nodes inside it, so a box that
fits tightly round a card does not cut the card's shadow. A `hidden` or a
`scroll` box does. Not built: a box has no shadow yet.

One choice is open. CSS draws a shadow with its own box, so it can fall on a
sibling drawn earlier. If a parent drew its children's shadows before any of
the children, a shadow would fall on the parent's background and never on a
sibling.

**Content placed outside on purpose.** A badge on the corner of an avatar,
controls that appear over a row while the pointer is on it, a menu under a
button. For these a node can have boxes beside its main one. Not built. The
design is:

- A node has a main box, which is the one layout places among its siblings,
  and any number of **extra boxes**. An extra box is placed against the main
  box: at a corner or along an edge, with an offset. It takes no room among
  the node's siblings and never changes their sizes.
- An extra box is a box like any other for hit testing and for working out
  what to repaint. Nothing is drawn outside it either.
- An extra box belongs to its node. The node is hovered while the pointer is
  over any of its boxes, so controls that show while a row is hovered stay
  when the pointer moves onto them. An event in an extra box travels through
  the node, as one in its interior does.
- An extra box is beside the main box and not inside it. If the node scrolls
  or cuts off its content, its extra boxes are not part of that content.
- An extra box is cut off by the nearest `hidden` or `scroll` box above its
  node, so a badge on a row scrolls under a header with the row. A `clip` box
  between the two does not cut it, for the reason it does not cut a shadow.
  An extra box can instead be in the window's top layer, above everything and
  cut off by the window alone, which is what a menu and a tooltip need.
- An extra box is drawn above the content of the box that cuts it off, so a
  later sibling does not cover a badge.
- An extra box is laid out by itself after the main solve, and then placed.

The anchor of an extra box is always its own node's main box, so a widget
never names a node it does not own.

Two alternatives were considered for content placed outside. A node could
declare how far it extends past its box on each side, which makes the author
state a bound the host can find for itself. And a node could be anchored to
any other node, as CSS anchor positioning allows, which needs a way to name a
node in another widget.

Not designed: whether an extra box past the end of a scrolling box's content
adds to how far it scrolls, moving a menu that does not fit to the other side
of its anchor, and a box drawn larger than it is laid out, as one that grows
under the pointer is.

#### Pointer capture

A drag needs pointer capture: the pointer leaves a divider the moment it moves,
and may leave the window before the button comes up. A listener captures the
pointer on the reply an event came with, as `setPointerCapture` does in the
DOM:

```wit
resource reply {
  stop-propagation: func();
  capture: func();
}
```

From that answer until the primary button comes up, the node the listener is on
is the target of every `move` and `up`, and stays the node the pointer is over.
It stays hovered and pressed, nothing else becomes hovered, and a frame that
moves other nodes under the pointer changes none of that. The release is
delivered to it and then ends the capture.

`capture` takes effect while the primary button is down: on the reply to a
`down`, and on the reply to a `move` that follows one. The second is how a
press becomes a drag only once the pointer has moved some way, so that a press
and release on a list row is a click and a press and pull is a drag. On the
reply to an `up` it does nothing, since the button is already up. The method is
on every reply because one type of reply serves every event a listener answers.
A `capture` function taking a node, callable at any time, would have to be
checked against the same condition and would no longer say which event it
answers.

`examples/zenafx/split/` is two panels and a divider. Its divider captures the
pointer, and `packages/zenafx/tests/split.rs` drags it past the edge of the
window.

The answer arrives some time after the press, when the component drops the
reply, so a move can reach the scene before the pointer is captured. Such a
move goes to whatever is under the pointer. Nothing is captured if the button
has come up by the time the answer arrives.

Three things came out of building the example.

- **A drag is heard on the box that stays still.** A listener is told where the
  pointer is in its own node's box, and the divider's box moves with every
  write. A position in it is the pointer's distance from where the divider was
  drawn last, which is wrong by however many moves arrived since that frame.
  So the divider starts the drag and the split, whose box does not move, hears
  the moves. Events aimed at a node the pointer is captured for still travel
  its path, which is what lets the split hear them.
- **A drag's listeners should hear nothing else.** A `move` listener on the
  split would be written an event for every move of the pointer across either
  panel, dragging or not. A third scope, `captured`, hears only while the
  pointer is captured for a node at or beneath the listener's. In the test the
  pointer crosses the panels five times with no event written, and each move
  of a drag is one event and one write.
- **Limits can come from layout.** The component cannot keep the left panel
  from growing past the window, because it never learns the window's width.
  The right panel starts at its minimum width, grows, and does not shrink, so
  the layout stops the left one. A box has no minimum or maximum of its own
  yet. Those wait on layout becoming a list of declarations, since `box`
  would gain a field on every node for each.

Each move of a drag is an event in and a `box` hole out, on the component's
thread, and a solve. That is the cost the split was built to find. It has not
been measured against a frame budget. If it shows, the alternative is a drag
the host runs: the component says that a node's size follows the pointer
between two limits, and hears the result.

[Understory][understory]'s `understory_responder` builds the same sequence the
scene does, capture then target then bubble, from hits it is given, and
routes to a captured node when one is set. Going by its README, it could
replace the scene's path walk and its capture override, some forty lines, and
would not replace the scope filter or the list of listeners per node. Its API
has not been read. Taking it would be a change inside `ui/scene.rs` with no
interface behind it.

Not built: capturing the pointer for a button other than the primary one,
releasing a capture before the button comes up, and dragging a scroll thumb.

#### The keyboard and the focus

One node in a window has the **focus**, or none does, and the keyboard goes to
it. Which node has it is state of the same kind as which node the pointer is
over, and the scene keeps it for the same reasons. A node says whether it can
have the focus, as its `cursor` is a field of the node, and a template sets its
focused style:

```wit
record node-def {
  // ...
  focusable: bool,
}

enum state { hovered, pressed, focused }
```

A node is `focused` while the node with the focus is that node or one beneath
it, as it is `hovered` while the pointer is, so a box can show a ring for a
node inside it.

The scene moves the focus on two inputs.

- **`Tab`** moves it to the next node that can have it, and `Shift` with `Tab`
  to the one before, going round at the ends. The order is the tree's: a node,
  then what is beneath it, then its next sibling, with content where its slot
  is. A template cannot give another order.
- **A press** of the primary button gives it to the nearest node that can have
  it at or above the node pressed, and takes it from every node when there is
  none.

`examples/zenafx/disclosure/` is two summaries that can have the focus. Its
template says so and gives the focused style, and `Tab` moves a ring between
them with nothing written to the component, as hovering the button changes its
fill with nothing written.

A component hears keys on a stream of their own:

```wit
resource node {
  listen-keys: func(target: u32, at: phase) -> stream<key-delivery>;
}

record key-event {
  down: bool,
  key: string,
  code: string,
  modifiers: modifiers,
  repeat: bool,
}

record key-delivery { event: key-event, reply: reply }
```

A key travels the path a press does, with the node that has the focus as its
target: `intercept` listeners from the root down to it, then `bubble` listeners
from it back up. A listener therefore hears the keys pressed while the focus is
at its node or beneath it. With no node focused the target is the root, so a
listener there hears every key the window is given, which is where a shortcut
for the whole window goes. Each listener is offered the key in turn and answers
on the reply, as for a `down`.

Five decisions are in that interface.

- **A stream of keys is separate from a stream of pointer events.**
  `listen-pointer` could have been one `listen` that takes two more kinds,
  `key-down` and `key-up`. A pointer event
  carries a position measured from the listener's node, and a key has none, so
  one record for both would have fields that mean nothing for half its events.
  The alternative that keeps one method is a `variant` event. That costs every
  pointer listener a discriminant to test, and a key listener differs in another
  way too: it takes no `scope`, since a key's target is always the node with
  the focus.
- **One stream carries every key, down and up.** A listener is not added for
  one key. The handler compares `key` and passes on what it does not want,
  so each key pressed while the focus is in a widget is an event to each key
  listener on the path. The disclosure has two listeners on each summary, one
  for `Enter` and one for a space, and `tests/disclosure.rs` counts two events
  for a `Tab` it passes on. Registering for a list of keys would let the scene
  skip the component for the others. That waits on a measurement of typing
  into a text field, which is the case with many keys.
- **Keys are named as the W3C names them.** `key` is what a key means on the
  user's layout with the modifiers held (`a`, `A`, a space, `Enter`,
  `ArrowDown`), and `code` is which key it is on the keyboard (`KeyA`,
  `Space`). These are the strings of the UI Events specification, which winit
  already uses, so the window passes its names on with two exceptions written
  out in `ui/surface.rs`. An `enum` in WIT would be checked by the compiler,
  and would need a case for each of a few hundred names and a new version of
  the interface for each new one.
- **What the host does with a key comes after the listeners.** `Tab` moves the
  focus unless a listener called `prevent-default` on the key's reply. An
  editor that indents with `Tab` calls it, and the focus stays where it is.
  `prevent-default` and `stop-propagation` are separate methods, as they are
  in the DOM: stopping propagation keeps later listeners from hearing the key
  and the focus still moves, and preventing the default leaves the later
  listeners their turn. `loader/mod.rs` has a test for each. The cost of
  acting afterwards is that the move waits for the
  component: answers arrive on the component's thread, so a component that is
  busy, and has a key listener on the path, delays its own `Tab`. A key that
  reaches no listener is acted on at once, on the window's thread. Acting
  first and telling the component afterwards would never wait, and would leave
  a widget no way to keep `Tab`. There is no time limit on an answer yet, which
  is the budget [Open questions](#open-questions) asks for.
- **A press moves the focus before its listeners hear it.** A listener cannot
  keep a press from moving the focus, as a DOM handler can by cancelling
  `mousedown`. A toolbar button that should leave the focus in the editor it
  acts on needs that, and it is not built.

The focus is on a node, which is not what
[Identity and host state](#identity-and-host-state) proposes: there the focus is on a
resource the component creates and a node points at, so that it outlives the
node. Here it lasts as long as the node's interior does. Writing a hole keeps
it, and so does rendering the node again with the template it has. Rendering
it with another template, or removing it, drops the focus to no node.
`key_listeners_and_the_focus_go_with_their_node` in `ui/scene.rs` has both
cases. That is enough for a button and too little for a text field in a list
that reorders, which is when the resource becomes worth building.

Not built:

- **Moving the focus from a component.** A menu that moves the focus between
  its items with the arrow keys hears the arrows and has no way to say where
  the focus goes. Neither can a dialog take the focus when it opens or give it
  back when it closes. This is the next thing the keyboard needs.
- **Keeping the focus within part of the tree**, which a dialog needs while it
  is open.
- **Bringing the focused node into view.** A node can get the focus while it
  is scrolled out of sight, and stays there.
- **A ring only for the keyboard.** A press gives a node the focused style as
  `Tab` does, where a browser shows a ring only after a key.
- **Text from an input method.** [Text fields](#text-fields) has what a field
  gets today.
- **The window's own focus.** The focused style stays while another window is
  in front.

#### Text fields

A text field is a widget in the component. `examples/zenafx/input/` has one,
in Zena. The work is divided in two.

**The text is the component's**, and so is what each key does to it.
`input/editing.zena` takes a text and a selection and says what a key makes of
them. It has no host in it and is tested by itself.

**The selection is the host's.** A window has one selection, and the scene
keeps it as it keeps the focus and what the pointer is over. A text node says
whether a person edits it, in `node-def.editable` beside `focusable`, and in
such a node the host does everything the pointer does:

- A press anywhere in the field puts the caret at the place in the text
  nearest the pointer, and dragging from there selects.
- A press with Shift held moves the end of the selection to the pointer.
- A second press in the same place selects the word there, and a third all
  the field's text.
- A field that gets the focus when the selection is somewhere else gets the
  caret, at the end of its text.

None of that calls the component, for the reasons hover does not: the scene
has the shaped text and the rectangles, a busy component would otherwise
freeze its own selection, and the gestures are then the same in every field
of every application. `tests/input.rs` presses and drags in the built example
and counts no event written to it.

The host draws the caret and a highlight over what is selected, while the
node with the keyboard focus is the text node or one above it. A field shows
no caret once the focus leaves it, and the component is not told. A caret
and a highlight look the same in every field for now, as a scroll thumb does.

The host keeps the caret in sight. When the selection moves, or the text it
is in changes, the next frame scrolls the nearest `hidden` or `scroll` box
above the text until the caret shows, and no further. It happens once for
each change, so a person who then scrolls the caret away with the wheel is
not pulled back. A `hidden` box is scrolled by the host alone, as in CSS,
which is what a one-line field wants: it follows the caret and shows no
thumb.

The component edits when it hears a key, with two calls and one field of the
key event:

```wit
resource node {
  selection: func(target: u32) -> option<text-selection>;
  select: func(target: u32, to: text-selection);
}

record text-selection { anchor: u32, focus: u32 }

record key-event {
  // ...
  text: option<string>,
}
```

It asks where the selection is, works out the text and the selection the key
leads to, writes the text into its hole, and says where the caret now is.
`anchor` is where a selection began and `focus` where it ends, which is where
the caret is. The names are the DOM's. `key-event.text` is the text a key
press produces on the keyboard's layout, with dead keys applied. It is `none`
for a key that types nothing and for a letter pressed with Control or Meta.

A field is the nearest node that can have the focus round an editable text
node. A press on the field's padding, or on a placeholder beside its text, is
a press in the field: the caret goes to the nearest place in the editable
text, which is one of its ends.

Five decisions are in that.

- **Where the editing lives.** The other place is the host. Parley, the
  library that shapes text, has an editor of its own, and an editable text
  node could do its own editing and report its text when it changes. That
  gives every component in any language a field for nothing. It also puts a
  widget's behaviour in the host: what Enter does, which characters a field
  accepts and how a value is formatted as it is typed would each need an
  option on the node or an event to ask the component. Here the component
  decides those in its own code.
- **The component asks for the selection and keeps no copy.** The pointer
  moves the selection without telling the component, so a copy would be out
  of date by the next key. Two alternatives were considered. The host could
  write each change to a stream, which is an event for every move of a drag,
  and leaves the order of a selection event and a key event on two streams to
  be got right. Or the component could own the selection and be sent the
  place of each press, which is what an earlier version did: it put the
  gestures in the component, where a second press and Shift were left
  undone. Asking costs one call for each key a field uses.
- **The selection is set by a call and is not a hole.** A hole is a value the
  component owns, and the framework sends one only when it differs from the
  last it sent. The pointer may have moved the selection since, so the same
  value again is not the same selection.
- **A place in a text is a count of UTF-8 bytes.** It is Parley's unit, so the
  host passes a place on as it is. Zena turns one into a position in a
  `String` in constant time, since its strings are stored as UTF-8. The DOM
  counts UTF-16 units, and a component in a language whose strings are UTF-16
  would convert. A place is always between two characters as a reader sees
  them: the host moves one that is not, and the field steps by grapheme.
- **`text` is on the key event.** The W3C's keyboard events report typed text
  in a separate `input` event, and `key` holds the character for a key that
  types one. `key` alone cannot be told apart from a name: nothing says
  whether `Enter` is a key or five characters. A separate event is where text
  from an input method would arrive, and that is not built, so for now one
  field on the event a field already hears is the smaller interface.

A single-line field needs no new layout. Its box is a row, and a row lays its
items out at their full width, so text that is told not to shrink is one line
however long it is. An empty text node is still one line high, so an empty
field keeps its height. A text node's padding is inside its box, and its
glyphs, its caret and the place of a press are all measured from inside it.

A key that changes the text is two calls, the text and then the selection,
and the window may draw between them. The frame in between shows the new text
with the caret where it was, held within the text. Batching a component's
writes into one frame is not built.

A press moves the selection before any listener on the press's path has
answered, as it moves the focus. A listener cannot yet keep a press from
doing either.

Not built:

- **Text from an input method**, and with it the candidate text an input
  method shows while composing, and telling the platform where the caret is.
- **Dragging by words** after a second press.
- **A caret that blinks.** The window draws only when something changes.
- **Undo**, which is the component's to add.
- **More than one line.** The caret is kept in sight on both axes and a place
  is found in wrapped text, but the editing has no up or down.

#### Selecting text and the clipboard

Any text in a window can be selected and copied, as on a web page. The
component that drew it does nothing for that and is told nothing.
`examples/zenafx/selection/` is a page of text with no code about either.

This is what the host holding the tree gives for nothing. The scene has every
text and where it was drawn, so the pointer can select across widgets, and
across components once there is more than one, without any of them learning
what the others say. A toolkit that hands the host pixels or a display list
each frame has to build selection in every widget that wants it, which is why
text in most native applications cannot be selected.

The selection is the one a text field uses: one for the window, kept by the
scene, with a place in a text node at each end.

- **A press and a drag** select from the place nearest where the press landed
  to the place nearest the pointer. A selection from one text node to another
  takes in the rest of the first, the start of the last and all of every text
  node between them, in the order the nodes come in the tree. That is the
  order a reader meets them in for text laid out in a column, and may not be
  for columns side by side.
- **A pointer away from any text** is nearest some text: the text above or
  below it before the text beside it. A drag that ends between two paragraphs
  or past the last still ends somewhere.
- **A second press** selects a word and a third the whole text node.
- **Control or Meta with `a`** selects all of it, unless a listener prevents
  that, which a text field does by selecting its own text.
- **A highlight** shows what is selected. There is no caret outside a text
  field, and a selection in ordinary text shows whether or not anything has
  the focus.

A node that says `unselectable` has its text left out, with the text of
everything beneath it, as `user-select: none` does in CSS. Text left out is not
selected by a drag over it or by selecting everything, and a press on it
leaves the selection as it was. A button leaves its label out, so pressing it
keeps what was selected. A text field's text is left out of a selection made
in the text round it, and the other way round: a selection is in one field or
in ordinary text.

A press begins a selection at once, before any listener on its path has
answered. If a listener then captures the pointer, it is dragging something of
its own, and the selection is put back as it was before the press.

The clipboard is the host's, and no component is handed it.

- **Copy.** Control or Meta with `c` puts what is selected on the clipboard,
  with a line break between one text node's text and the next. It is done
  when the key goes down, before any listener hears the key.
- **Cut.** Control or Meta with `x` copies in the same way. Taking the text
  out is the field's to do, since the text is the field's: the field hears the
  key after the copy and deletes what is selected.
- **Paste.** Control or Meta with `v` is followed by a second key, named
  `Paste`, whose `text` is the text on the clipboard. A field inserts a key's
  `text` whatever the key, so it is pasted into with no code for pasting.
  `Paste` is one of the W3C's key names, for the key some keyboards have.

A window uses the platform's clipboard, through the `arboard` crate. A scene
with no window, which is what a test has, has one of its own.

Three alternatives were considered.

- **A clipboard interface for components**, with a read and a write. A
  component could then read what the person last copied anywhere, at any
  time. The web gates that behind a permission. Here a component gets pasted
  text only when the person pastes into it, and needs no permission.
- **Copying as something a listener can prevent**, as a `copy` event is on
  the web, where a page can put its own text on the clipboard in place of the
  selection. It needs the copy to wait for the component, and a way for the
  component to supply the text. It is the natural next step and is not built.
- **Selecting off unless a template asks for it**, as native toolkits have
  it. Most text would then not be selectable, which is the state of things
  this is meant to end.

Not built:

- **A component's own copy**: text put on the clipboard that is not what is
  selected, such as a table copied as rows of tab-separated cells.
- **Anything but text** on the clipboard.
- **Scrolling while a drag is past the edge** of a scrolling box. The box
  scrolls to keep the selection's end in sight, and stops when the pointer
  does.
- **A context menu**, which is where copy and paste are found without a
  keyboard.
- **A style for the highlight** that a template chooses.

[understory]: https://github.com/forest-rs/understory

#### Cursors

A node names the cursor to show while the pointer is over it:

```wit
record node-def {
  // ...
  cursor: option<cursor>,
}
```

It is a field of the node, beside its layout and style, because it is
part of how the node is styled. `none` leaves the choice to the node above, as
`cursor` inherits in CSS, and the window shows `default` where no node names
one. So the host shows the cursor named by the nearest node at or above the one
the pointer is over, which during a drag is the node the pointer is captured
for.

`cursor` is an enum of CSS's 34 `cursor` keywords, each meaning what it means
there. `examples/zenafx/cursors/` is a tile for each.

**The platform draws the cursor.** The host draws none and has no cursor
images. It tells the window which of the platform's own cursors to show, by
name, when the node under the pointer changes. Three things follow.

- A cursor is the one the person's system shows everywhere else, at the size,
  colour and theme they chose, which matters to someone who has made theirs
  large.
- The platform moves it with the pointer, in its own compositor. It does not
  wait for a frame of the window, so it does not lag when a frame is late.
- No component code runs when the cursor changes. The host knows the node
  under the pointer and that node's cursor.

The host's part is one function in `ui/surface.rs` that turns each name into
the window library's cursor of the same name. winit takes its names from CSS
too, so the list is one to one, and a test holds the two lists together.

What the enum cannot do is name a cursor the platform does not have. That takes
an image: a component gives pixels and the point in them that is the pointer's
tip, the host hands them to the platform as a custom cursor (winit's
`CustomCursor`), and the platform still does the drawing and the moving. With
that, the set of cursors is open to a component with no change to the host, and
a design system can ship its own. `cursor` would become a variant of a name or
an image.

Not built: image cursors, and a cursor among a node's [state
styles](#state-styles). Until then a cursor that changes with state, such as
`grab` becoming `grabbing` while pressed, needs a new render.

### Context: values that inherit down the tree

[zenafx-styles.md](./zenafx-styles.md#one-mechanism-for-values-that-go-down-the-tree)
proposes that the values here and its inheriting properties are one
mechanism: a key that is a symbol, a type for each value, a declaration in
place of `provide`, and a watcher in place of `inherited`.

Events handle one child talking to one parent. The harder direction is one
provider reaching a whole subtree: a theme, a locale, a text direction, a density
setting. Threading those down as props fails because the components in between
do not know about them and should not have to forward them.

The web has no real mechanism for this. The [context protocol][context-protocol]
that Lit and others implement emulates one: a consumer dispatches a
`context-request` event, an ancestor catches it **synchronously** and invokes a
callback carried in the event. Both halves are unavailable here: the synchronous
upward call is what [Call direction](#call-direction-within-a-frame) rules out, and a callback inside the payload is not
something WIT data carries.

ZenaFX does not need to, because the host holds the whole tree, including
nodes belonging to other components. Resolving a context value is a walk up the
host's own tree. No component talks to another component at all: the consumer
asks the host, which can return a value.

So a provider writes one value on a node it holds, `provide(key, value)`, and
any node beneath it reads `inherited(key)`. The walk crosses component
boundaries without either side gaining access to the other's nodes, because it
happens in the host where the tree already is. Neither function is in
`zenafx:host/scene` yet. The `inherited` variant they carry is declared in
[`zenafx.wit`](../../packages/zenafx/wit/zenafx.wit): a colour, a length, a
scalar, a flag or a name.

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
child, [Runtime linking](#runtime-linking-and-import-interposition) already decides what the child's imports resolve to, so "the nearest
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
inside it. The scene hands over its tree, whose text leaves carry the id of a
shaped run, and the measure closure that
[`TaffyTree::compute_layout_with_measure`][taffy-measure] takes calls the text
engine directly. A component never measures anything.

[taffy-measure]: https://docs.rs/taffy/latest/taffy/tree/struct.TaffyTree.html#method.compute_layout_with_measure

#### Layout is a recursive query, not two passes

A layout system where constraints go down and sizes come back up, once each,
is the model Flutter uses. CSS does not work that way, and neither does
taffy. A parent asks a child questions, possibly several, and which questions
it asks depend on the parent's own style. Taffy carries them in `LayoutInput`:
`known_dimensions` are dimensions the parent has already fixed,
`available_space` is `Definite(px)` or `MinContent` or `MaxContent` per axis,
and `run_mode` says whether the answer needs to be a full layout or only a
size.

What one text leaf is actually asked, recorded from
`ui::layout`'s own tests:

```
shrink-to-fit parent (row, align-start, no width):
  known None      available MaxContent          how wide would you like to be?
  known None      available MinContent          how narrow could you be?
  known 280.27    available Definite(280.27)    at 280.27 wide, how tall?
  known None      available Definite(280.27)    final placement

fixed-width parent (160px):
  known None      available Definite(160.0)     x3
  known None      available Definite(149.71)    final, at the measured width
```

So the intrinsic size does travel upward, but as two different numbers —
min-content, every soft break taken, and max-content, none taken — and a
parent that already knows the width never asks for either. `zenafx:host/layout`
exposes this as `measure-request`, which is taffy's question with taffy's
vocabulary removed.

Two consequences for the rest of this document. A leaf is measured four or
more times per frame, so measurement must be cheap and side-effect free —
which is why a run is registered once and referred to by id ([Text](#text)), and why
`measure_run` re-breaks only when the width it is asked about differs from the
one it holds. And when a leaf is a child _component_ ([The scene protocol](#the-scene-protocol)), those four
questions are four calls into that component.

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
measurement were delegated to a _second_ guest component, because the solver
would then be suspended at a guest→guest call while the callee ran — the case
[Call direction](#call-direction-within-a-frame) rules out. Text measurement staying in the host is what keeps guest layout
tractable. The first milestones use `taffy` in the host; [Tiers beyond boxes and text](#tiers-beyond-boxes-and-text) has the rest.

### Text

Text is registered, not passed per frame. `register-run` shapes a string under
a `text-style` and returns an id; the id then stands for the shaped run through
measurement, painting and hit testing until `release-run`. A widget that changes
a label calls `update-run`, which reshapes in place and keeps the id.

This is what keeps the per-frame display list small: a glyph run in the display
list is an id and a position, not a string and a font.

A text node is one string in one style. [zenafx-text-flow.md](./zenafx-text-flow.md)
proposes text in several styles: a node whose children are laid out together
as one piece of text.

### Paint

The painter takes a display list and draws it. The commands are rounded quads,
glyph runs, and clip push/pop. The scene builds the list by walking its tree,
and no interface a component can call carries one. Clips are what enforce the
compositor's part of the capability model in
[Capabilities and isolation](#capabilities-and-isolation): the scene emits a
clip for the box a component was given, and the rasterizer discards anything
outside it. The scene emits a clip for a node whose `overflow` asks for one
([Scrolling](#scrolling)). It does not yet clip a child component to its box,
since no child component is built.

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

The interface an application imports is `zenafx:host/scene`, under
[The scene protocol](#the-scene-protocol). The three below are the primitives
beneath it. The scene calls `text` and `layout` as Rust functions, in
`ui/text.rs` and `ui/layout.rs`. They are also declared in WIT, and the loader
binds them, for a component that lays out a subtree itself
([Tiers beyond boxes and text](#tiers-beyond-boxes-and-text)). No example
imports them. `surface` is declared and not served: frames are the host's, and
input reaches a component through listeners.

A cross-package `use` has to carry the version — `wasm-tools` reports
"package 'zenafx:ui' not found" for an unversioned path even with the
package present in `deps/`.

```wit
package zenafx:host@0.1.0;

interface text {
  use zenafx:ui/style@0.1.0.{text-style};

  record measured { width: f32, height: f32, baseline: f32 }

  /// Shape `content` under `style` and keep it. The id is valid until
  /// `release-run`.
  register-run: func(content: string, style: text-style) -> u32;
  update-run: func(run: u32, content: string, style: text-style);
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

```

Typed record streams of exactly this shape already cross a composed boundary
in both directions in
[gfx-provider.zena](../../packages/compiler/test-files/component/gfx-provider.zena)
and its consumer, so the event streams need no new compiler work.

## The scene protocol

The host holds the tree. A component describes what it draws once, and afterwards
sends only the values that changed. `zenafx:host/scene` is that interface.

Nothing in it names a signal, a closure, a component or a widget. A framework of
any shape has to be able to target it, and the test applied throughout is whether
a framework that re-renders, such as lit or React in any language, can drive this
protocol as well as one built on fine-grained subscriptions. Both write holes.
They differ in how many they write and when.

### Reasons for a retained tree

Sending a display list or a node tree every frame puts the whole picture through
the canonical ABI every frame, and the ABI copies every value. A tree of a few
hundred nodes at 120Hz is a large copy, repeated. Holding the tree in the host
moves that cost to the first frame, and later frames carry the changed values
only.

Layout is the second reason, and it was measured. A solve needs the size of a text
run, and the run belongs to whoever owns the text. An earlier implementation gave
every widget its own component and asked each one to measure itself. One frame of
a card containing a label cost:

|                           | `solve` calls | cross-component `measure` calls |
| ------------------------- | ------------- | ------------------------------- |
| one component per widget  | 6             | 54                              |
| retained tree in the host | 0             | 0                               |

Taffy queries a text leaf four or more times per solve, every component boundary
turns each of those into a call, and each embedded component then solves its own
subtree. With the tree in the host the same question needs no call, because the
host already holds the text. `solve` reaches zero as well, because the component
describes a tree and the host solves it.

A resize costs nothing in the guest for the same reason.
`resizing_never_re_enters_the_component` resizes four times and asserts the entry
count stays at one; `the_entry_is_called_once` asserts the same for a component
that is still running work.

One component per widget is finer than any real deployment would be, so those
numbers are an upper bound on what a boundary costs. What they support is putting
a component boundary where isolation is wanted and nowhere else. Widgets that trust each other
compose in the language, inside one component, and
[Moving the component boundary](#moving-the-component-boundary) is why that choice
is free.

### Templates, nodes and bindings

A **node** is an entry in the retained tree: a layout box with a style,
which is `nothing`, `fill` or `text`. Style travels with geometry, so the
host paints the tree it solved. No component builds a display list, and none
handles a shaped text run.

A **template** is a flat list of node descriptions plus a list of **bindings**.
The list is flat because WIT value types cannot recurse. `first-child` and
`child-count` index that same list, in breadth-first order, which keeps a
node's children contiguous and after it.

A **binding** is one property of one template node that a value arrives at on
mount or on update. The template stores `bindings: Vec<Binding>` once (a node
index and a target property, roughly 8 bytes per entry), shared by every
instance of that template with zero per-instance host allocation. On the wire,
a binding update (`record hole` in the current WIT) is an index into the
template's binding list paired with a `binding-value`, carrying no name. One-shot
bindings written on mount and never updated again cost zero bytes on subsequent
frames.

```wit
enum binding-target { content, style, box, layout }

record binding { node: u32, target: binding-target }
record hole { binding: u32, value: binding-value }

record template-def {
  id: template-id,
  nodes: list<node-def>,
  bindings: list<binding>,
}
variant template-ref { known(template-id), fresh(template-def) }

resource node {
  render: func(template: template-ref, holes: list<hole>);
  content: func(slot: u32, nodes: u32) -> list<own<node>>;
  set-slot: func(slot: u32, children: list<borrow<node>>);
}

create-node: func() -> own<node>;
root: func() -> own<node>;
ready: func();
```

`render` creates, patches and replaces. The host compares the template it is given
against what the node already shows. Nothing there yet: build the template and
fill every hole. The same template: write the holes it was given and leave the
rest, including whatever hangs in the node's slots. A different template: drop
what was there and build the new one. Template identity is what decides, and the
guest never states which case it meant. lit-html resolves patch against replace
the same way.

Holes are sparse. A guest sends the ones whose values changed and says nothing
about the others.

A `template-ref` is `fresh(def)` the first time a template is used and `known(id)`
afterwards, so a definition travels with the first render that needs it and
nothing is registered up front. The guest tracks what it has sent; the host's
table lives and dies with the component instance. A component with a dozen
templates and one on screen has sent one.

`ready` says the tree is worth drawing. The host waits for it rather than for the
entry to return, because a component that keeps working never returns — see
[Scheduling](#scheduling).

### One box per widget

Node 0 of a template describes the node being rendered into, which is the box CSS
would reach with `:host`. Nodes 1 and up are its interior and hang beneath it. A
widget therefore occupies exactly one box in the tree.

A slot contributes no geometry. `<slot>` in shadow DOM defaults to
`display: contents`, and a ZenaFX slot behaves the same way: layout splices what
hangs in a slot into whatever contains the slot, so a parent's row lays out its
children's own boxes. To give content a panel, put the slot inside a box and style
that box.

`content_hangs_in_the_slot_its_parent_declared` renders two children into one slot
of a row and asserts they sit side by side rather than stacked, which holds only
when the slot is spliced out. Taffy has no `display: contents` and needs none: the
host builds the flat list it hands taffy, so leaving a node out of that list is the
whole implementation.

### Interior and content

A widget's **interior** is what its own template describes. Its **content** is
what its parent put in it. The two never mix: a widget authors its interior, is
handed its content, and can name a node in neither of the other's.

`content(slot, nodes)` gives a parent one node per child to render into. It makes
the slot exactly `nodes` long: growing creates empty nodes, shrinking drops the
ones past the end along with everything beneath them, and the nodes that stay keep
their identity and their subtrees. `shrinking_a_slot_drops_what_is_past_the_end`
holds the kept node's identity and counts the arena.

Slots are numbered in the order a template declares them. A caller pairs its own
property names against that order at compile time, so no slot name reaches the
protocol.

A parent reaches only its own slots. It is handed a node per child and can read
nothing the child renders there. Shadow DOM uses the same arrangement, and it is
the only one the ownership rule permits: neither side has an id for the other's
nodes, and the host holds both.

The solve walks into content like any other subtree, so sizing a slot needs no call
to whoever filled it. The subtree is clipped to the box the declaring widget's
layout chose, so content cannot paint outside what it was given, which is the
compositor half of [Capabilities and isolation](#capabilities-and-isolation).

Dropping a node handle releases the handle and nothing else. A node belongs to
whoever's interior it sits in, so a child cannot delete a slot its parent declared;
a node goes away when the interior holding it is rebuilt. The host therefore keeps
no table for node handles: the scene id is the resource representation, and two
handles onto one node are sound because the destructor does nothing.

### Detached nodes and slot assignment

Dynamic child holes — conditional branches, tabs, and reordered lists — need to
detach a subtree without destroying it and to reorder existing nodes inside a
slot. One pair of operations covers both:

```wit
create-node: func() -> own<node>;

resource node {
  set-slot: func(slot: u32, children: list<borrow<node>>);
}
```

A node created with `create-node` starts detached: it holds its rendered
interior and shaped text runs in the host, and layout, paint, and hit testing
skip it until a parent places it in a slot with `set-slot`. Removing a node
from a slot detaches it again while keeping its interior and shaped runs alive
for as long as the guest holds the `own<node>` handle. Dropping the handle
frees the node and its interior in the host.

Passing a child widget a non-owning handle preserves the ownership rule from
[Interior and content](#interior-and-content): only the creator holds the
owning handle, so a child cannot destroy a slot node its parent owns.

Two guest-side directives build directly on this primitive, with no protocol
support of their own:

- **Branch caching (`cache`).** A guest keeps a map from template identity (or
  an explicit key) to a parked `own<node>` and its signal effects. Switching
  branches calls `set-slot` to swap the active node in and pauses the parked
  branch's effects. Returning to a branch calls `set-slot` again with no
  rebuild and no text re-shaping. Unvisited branches are never allocated.
- **Keyed list reordering (`repeat`).** A guest keeps a map from item key to
  each row's `own<node>`. Reordering a list calls `set-slot` once with the
  handles in the new order, leaving every row's interior, bindings, and shaped
  text intact.

Under the feed-forward id model in [Open questions](#open-questions), the same
operations become `set-slot` and `remove` variants inside `apply`, so creation,
detachment, reordering, and hole writes batch into one call.

### Identity and host state

The guest states node identity and the host never infers it. A parent either
asks `content` for positional slot nodes or creates `own<node>` handles and
places them with `set-slot`; a child renders into the node it was handed.
Nothing in the protocol matches a description against an existing node, so
there is no host-side reconciliation.

Keys are what React, Flutter and Solid use to decide which existing instance a
new description refers to. Two properties keep keys out of the host protocol.
Guest-side widget state is reached by ordinary references rather than by
position in a framework tree, so recreating a node loses no state. And the host
holds nothing on a node that it could not rebuild: a node carries its layout,
its style, its children and a shaped text run, and the run is a cache.

The second property has to be maintained deliberately, because a UI eventually
needs focus, text selection, scroll offsets, animations in flight and media
playback, and none of those can be rebuilt from a description. The rule is that
no host-side state lives on a render-tree node. A stateful thing is its own
resource, and a node points at one:

```wit
resource text-field { … }   // its string, selection and IME state
resource scroll-view { … }  // its offset
resource media { … }        // its decoder
```

A guest creates a `text-field`, holds the handle for as long as that widget
lives, and renders a node that shows it. Rebuilding that node, rendering a
different template, or reordering the list it sits in leaves the field's cursor
alone, because the cursor was never in the node. Focus becomes a request naming
a focusable resource, which also gives the host the arbitration it needs: it
chooses among focusables it was handed, and one component cannot name
another's.

When a guest wants keyed reordering to avoid rebuilding row subtrees and
re-shaping text, a guest-side `repeat` directive holds each row's `own<node>`
and permutes them with `set-slot` ([Detached nodes and slot
assignment](#detached-nodes-and-slot-assignment)).

### Batching and the frame

`render`, `content` and `create-node` return handles (or take a fresh template
definition), so they are ordinary calls. Hole writes are the frame-by-frame
traffic and return nothing, so they batch:

```wit
record write { node: borrow<node>, holes: list<hole> }
apply: func(writes: list<write>);
```

A guest driven by fine-grained subscriptions would otherwise call once per
changed value. Marking nodes dirty and flushing one `apply` per frame makes the
cost proportional to the frame rather than to the number of values changed,
which puts the frame scheduler inside this design rather than on top of it.
Writes in one `apply` cannot be split across frames; writes in two calls can.

Reads go the other way and do not batch. Geometry read back reports the
previous solve, and there is no way to ask for a synchronous one, so layout
thrashing cannot be expressed.

### Implementation status of the protocol

`render`, `content`, `root` and `ready` are built, with the `node` resource and
one-box-per-widget. `examples/zenafx/counter/` and `examples/zenafx/widgets/`
drive them.

`create-node`, `set-slot`, `apply`, and the state resources are designed and
not built. A guest today writes a hole with `render(known(id), holes)`, which
is what `apply` batches.

### Moving the component boundary

A widget and a component are different things ([Terms](#terms)), and which widgets get their own
component is a deployment decision rather than a structural one. An application
of three hundred widgets can be one component, one component per widget, or
anything between, and it behaves the same. That is a requirement, not an
observation: a team should be able to develop against fine-grained components and
ship a bundle, or promote one widget to its own component because it came from
somewhere else, without rewriting the widgets on either side.

Four things make it hold, and each is a property of an earlier decision rather
than new machinery:

- **Nodes.** `content` gives a parent one `node` handle per child and says
  nothing about who renders into it. A widget in the same component holds that
  handle exactly as a child component would, with the same clipping, so the
  authority structure does not change when the boundary moves.
- **Context.** [Context](#context-values-that-inherit-down-the-tree) resolves against nodes in the host's tree, not against
  components. A widget's nodes sit at the same place in that tree either way, so
  `inherited` returns the same value.
- **Events.** A registration is the host's either way, so a listener in the same
  component and a listener in another are reached by the same synchronous
  dispatch, in the same order, with the same latency. Fusing two components
  removes a boundary crossing and changes nothing observable. This is why
  [Events](#events-input-and-what-a-widget-reports) dispatches rather than having
  a parent poll its children: a poll is a direct in-language call on one side of
  a boundary and a host-mediated one on the other, which matches in synchrony but
  not in cost.
- **Batched writes.** `apply` batches the same way at any granularity. A fused
  application issues fewer, larger batches, which is faster and not different.

What makes all four hold is a constraint on interposition rather than a ban on
it.

**The host may interpose on any binding, including one between two widgets.**
That is deliberate. A deployment that mixes widgets from sources which do not
trust each other equally needs the host between them, deciding per call what is
allowed to pass, and [Runtime linking](#runtime-linking-and-import-interposition)'s per-instance binding is what supplies it. A policy
that wants to mediate every userland call can have exactly that.

**Keeping components unbundled is therefore itself a security choice.** Bundling
two widgets into one component removes the host from between them: no binding is
left to mediate, the two share a memory, and nothing remains for a policy to
check. So whether a given pair of widgets _may_ be bundled is a question for
policy, not for whoever is optimising the build. Within one trust domain the
boundary is free to move; across one it is mandatory, and the separation is the
feature rather than an overhead to remove.

**Interposition must not change an interface's semantics.** This is the
constraint that lets the two coexist. A mediator may refuse to bind, deny a
call, or transform the values that cross it — everything mediation is for. What
it may not do is change when a call runs relative to its caller, because that is
what would make one source tree behave differently depending on how it was
packaged.

That constraint is what event dispatch is built to satisfy. The host holds every
registration and makes every delivery, so a mediator can deny a delivery or
rewrite a payload and neither side can tell it was there, and bundling two
components changes which boundary is crossed rather than when a handler runs.

It is also why [Events](#events-input-and-what-a-widget-reports) confines the
deferred-push binding to return-free interfaces: the absence of a result is what
says the caller is not waiting, so there is no synchronous expectation for
deferral to violate.

Three things still do not survive bundling.

**Isolation does not**, which is the same point from the other side. Widgets in
one component share one linear memory and one GC heap, so [Capabilities and isolation](#capabilities-and-isolation)'s guarantees hold
between components and not inside one. A widget from a third party stays its own
component, and that is a decision about trust rather than about performance.

**The total update order does not.** [Scheduling](#scheduling)'s invariant holds either way: a parent
widget updates before anything beneath it. The full ordering does not. Separate,
a parent component's deepest widgets update before a child component's shallowest
ones, because the parent's update is one call; bundled, a single depth-ordered
queue interleaves them. Sibling widgets are independent by construction — neither
is an ancestor of the other — so nothing observable should depend on which runs
first, and a widget that does depend on it is relying on something the design
never offered.

**A widget whose public properties are not WIT-expressible cannot be split
out at all.** The four properties above are about what stays the same when a
boundary moves; this one is about whether it can move. A widget's inputs cross a
component boundary as WIT, so `title: String` survives extraction and a property
whose type is a closure, or a rich Zena object with methods, does not. Nothing
stops such a widget being written — within one component its inputs are ordinary
Zena values — and nothing reports the problem until someone tries to extract it,
at which point the fix is a change to its public interface rather than to the
build.

That makes "which widgets get their own component is a deployment decision"
conditional rather than free. A widget meant to be extractable should say so, so
that its properties can be checked against WIT expressibility when it is
compiled rather than when it is split. The check is the same one
[Compiler prerequisites](#compiler-prerequisites) already needs for a component's
exported interface; what is missing is applying it to a widget that is not yet a
component.

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

Ordering across components comes from the call direction
([Call direction](#call-direction-within-a-frame)). A parent that forwards a
value to a child component does it by calling the child, so the child updates
inside the parent's update and after the parent has its own new value. The
writes of one `apply` reach the tree together
([Batching and the frame](#batching-and-the-frame)), so a frame does not show
half of one component's update.

A frame can show one component's update without another's. The host paints when
it has a frame to paint, and it does not wait for every component to finish
responding to an event. Two components that each respond to the same event may
therefore land in different frames. Whether that needs a mechanism, such as a
write the host holds until a named set of components has answered, is under
[Open questions](#open-questions).

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

State inside one component is a Zena-level signal: a typed cell with the holes
that read it. Writing one marks those holes dirty, and the frame flush sends them.
Signals need no WIT and no host support, because a hole is already addressable
from the guest — see [Batching and the frame](#batching-and-the-frame) — and they
are what makes the guest side of
[widget authoring](zenafx-widget-authoring.md) work without re-running a build
function.

Shared state across components is a typed interface the owning component
exports — a `stream<T>` of a record, or a function returning the current value
plus a stream of changes. This is the shape the repository already exercises:
[gfx-provider.zena](../../packages/compiler/test-files/component/gfx-provider.zena)
hands out a `stream<frame-event>` that a consumer in another component reads
one record at a time, and
[compose.wit](../../packages/compiler/test-files/component/compose.wit)
has a consumer awaiting a `future<s32>` that a different component settles.

A host-side signal resource carrying a dynamically-typed
`variant value { bool, int, float, text, bytes }` is the alternative, and it is
worth naming because it is the obvious design. It is rejected: it erases the
element type at every read, so every consumer needs a runtime check and a
failure path for a case that the type system could have ruled out, and Zena
has no `any` precisely so that this does not happen.

## Capabilities and isolation

A freshly instantiated component has no window, no node, and no input. It
receives a `node` handle, from the host for the root or from its parent for
anything else, and that is its entire authority to draw.

**Bounds.** A `node` handle reaches one node and the interior the holder
renders into it. No function takes a node by number, so there is nothing for a
component to forge. The host clips a subtree to the box its parent's layout
gave it, so a component cannot paint outside that box whatever it renders.
[Paint](#paint) says how much of the clip is built.

**The handle is the capability.** A WIT `resource` handle lives in the holder's
own component-model handle table. It cannot be forged or guessed, and the host
minted it. A parent gets a handle for each child from `content`, and a
component cannot obtain a handle for a node it was not given.

**Slots.** A widget that wants its parent to supply content declares a slot in
its template. The parent fills the slot through `content`. The widget decides
where the slot sits and cannot read or change what is put there, and the parent
cannot read the widget's interior. This is how a panel gets its buttons from
its parent without either side gaining access to the other's nodes.
[Interior and content](#interior-and-content) has the mechanism.

**Attenuation.** A parent should be able to hand a child a node with less than
it holds: no pointer input, or no keyboard focus. The runtime component design
had `grants` on a viewport for this. Node handles have no equivalent yet, and
it is needed before a component embeds one it trusts less than itself.

**What the loader adds.** The scene is one capability among several. A component
reaches `zenafx:host/scene` or a network interface only if the loader bound it
([Runtime linking](#runtime-linking-and-import-interposition)), and the check runs before instantiation, so a component asking for
something it may not have fails to load rather than failing at its first call.

**What none of this stops.** A component cannot draw outside its box, read its
parent's nodes, or reach an interface the loader did not bind. It can still
spend an unbounded amount of time inside a call it was legitimately asked to
make, and [Serialization across components](#serialization-across-components) says no other component runs while it does. A loop in one
component stops every component in the window from responding. The window
itself keeps painting, resizing and showing hover styles, because those need no
component.

The tools for that are wasmtime's epoch deadlines and fuel, and the useful
detail is that neither has to be fatal. `Store::epoch_deadline_trap` aborts, but
with async enabled `epoch_deadline_async_yield_and_update` yields back to the
host at the deadline and resumes later, and `fuel_async_yield_interval` does the
same on an instruction count. So a component that overruns its share of a frame
can be suspended and resumed on the next one instead of being killed — which is
the mechanism [Open questions](#open-questions)'s frame-budget question needs, and is unbuilt.

## Tiers beyond boxes and text

A node is a rectangle with a transform and a clip. What happens inside it is
the component's choice among three tiers.

Every tier above the first is opt-in twice: the node kind has to be asked for,
and the interface that fills it has to be bound by the loader. A component that
shows boxes and text imports `zenafx:host/scene` and meets no painting concept
at all — no display list, no surface, no renderer — and the scene protocol reads
the same whether a higher tier is in use or not. What a higher tier changes is
what a node's content can be, which is why each one arrives through `render`
rather than through an interface of its own. Removing `zenafx:host/paint` is
what bought that: a component gets at painting by holding a node that paints,
not by being able to paint.

**Tier 1, retained boxes and text**, is what [The scene protocol](#the-scene-protocol) and [Host primitives](#host-primitives) describe: the host does
layout, shaping and high-DPI scaling, and the nodes are available for hit
testing and accessibility.

**Tier 2, a 2D vector canvas.** A canvas node carries a retained list of path
commands, and the host rasterizes it with the same renderer that draws Tier 1.
The paths arrive the way every other node property does: a node kind whose
style is a path list, written by `render` and patched by a hole. That keeps
the rule that a component changes what is on screen by changing its nodes, so a
canvas is a node with richer content rather than a second way to draw.

**Tier 3, a WebGPU viewport.** This is the tier where a component paints for
itself. A GPU viewport node gets a texture sized to its box; the component
renders into it through [`wasi:webgpu`][wasi-webgpu], which tracks the
[W3C WebGPU][webgpu] API, and presents it; the compositor maps the texture into
the scene with the right z-order and scissor. Reaching it needs `wasi:webgpu`
bound, so which components may paint is the loader's decision rather than a
property of the scene.

A Tier-3 node has its own producer and so its own cadence. The compositor draws
whatever the texture last held, which means a component that misses its frame
delays nothing but itself — the property
[Call direction](#call-direction-within-a-frame) wants for a component trusted
less than fully, arriving here for free.

[webgpu]: https://www.w3.org/TR/webgpu/

`zfx` already serves `wasi:webgpu` and the surface-to-device bridge
([graphical-runtime.md](./graphical-runtime.md)), so Tier 3 is mostly a matter
of giving a node a texture rather than new host machinery.

Pluggable layout algorithms belong here too: a component exporting a layout
interface, imported lexically by the component that wants it, with a
host-implemented `measure` import for text. The interface is the one in [`zenafx:host` in WIT](#zenafxhost-in-wit)
plus that import, and [Layout](#layout-with-measurement-inside-the-solve) says why `measure` has to stay in the host rather
than be delegated to a third component.

## Compiler prerequisites

### What already works

The fixtures named here live under
`packages/compiler/test-files/component/`. Unless marked otherwise they
are compiled, composed and run by
`npm run test:component -w @zena-lang/compiler-zena`; the ones marked
compile-level are asserted by `component-emission_test.zena` instead.

These fixtures are linked by `wasm-tools compose` rather than at run time,
because that is what the existing harness does. What they establish is that the
two sides' interfaces line up and that every value in them survives the
canonical ABI in both directions — which is the part ZenaFX depends on, and
which is independent of when the binding is made. The linking mechanism ZenaFX
uses is [Runtime linking](#runtime-linking-and-import-interposition)'s.

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
- **Resources a Zena program provides**, with both sides of the boundary
  generated. `gfx-surface.wit` declares two resources; `gfx-surface-provider`
  exports them as ordinary Zena classes behind compiler-written wrappers, and
  `gfx-surface-consumer` imports them and constructs a `surface`, calls a
  sync method, an `async func(...) -> stream<frame-event>`, a
  string-returning method and a static, and passes a `borrow<surface>` both
  to another resource's constructor and to a free function, then drops a
  handle, which reaches the provider's destructor. The composed pair runs
  and returns 104. That is the shape of the `node` resource, almost construct
  for construct. The class behind a provided resource implements `Disposable`,
  and its `dispose` is what the destructor means.
- A world whose only export is `main: async func()` — no result — which is
  the shape of every milestone-1 program (`async-void-main.zena`).
- **An exported interface of synchronous functions, with no `main`**, which
  is what every ZenaFX component is. The wrapper a declared world synthesizes
  roots the p3 async driver whether or not anything is async, and the
  component target used to reject a program in that state; `greeter` did not
  cover it because one of its exports is `async`. `sync-only.zena`.
- **A result that flattens past one core value from an exported interface**,
  such as `func() -> size`: it comes back through a return area, which lives
  in linear memory, so the lift needs the memory options even with no string
  or list in the signature (`sync-only.zena`'s `split`).

Taken together these cover every construct the milestone 1 interfaces use.

### What the compiler still has to build

The interfaces above are designed against what WasmGC and WASI p3 permit, not
against what the Zena compiler emits today. Zena's one standing limit is that it
cannot be multi-threaded; everything else here is compiler work with a known
shape, so this is a work list rather than a set of constraints on the design.

**Forwarding an imported handle to a third component.** The consumer fixture
above passes a `borrow` back to the component it imported the resource from,
which is one handle table and a borrow. Embedding a child component needs the
other case: a parent holds an owned `node` it got from `content` and hands it to
a child through the child's `mount`. Both components import the same resource
type from the host, so the handle is transferable, but it has to move out of
the parent's table and into the child's rather than being copied as a
representation — and the host, not either guest, owns it.

**Binding a WIT `result` to a variable.** `let r = spawn(name);` fails with
`typeToValType: unsupported type: (true, u32, _)`. A `result<T, E>` arrives
as a tuple of (ok, value, error) and can only be destructured where it is
produced — `if (let (true, handle, _) = spawn(name))`. Every call site that
handles a fallible import is shaped around this.

**A world-level export whose parameter is a named record.** `export measure:
func(request: measure-request) -> size` at world level is refused with "the
named type 'measure-request' waits on the interop stages". The same signature
inside an exported _interface_ works, which is why `zenafx:host/app` is an
interface rather than a world-level function. That is the better shape
anyway, so this costs nothing today.

**An exported resource.** A component that exports an interface containing a
`resource` compiles, but the component it emits does not validate: "unknown
type 13: type index out of bounds", in the instance section that groups the
exported interface's types. Replacing the resource with a plain function over
the same types validates. Until this is fixed the host cannot hold a handle
to anything inside a component, which is why `zenafx:host/app` hands back a
tree rather than a root widget, and why the method-less form — which fails
earlier still, with "Type 'Root' not found" — is untested.

**A `use` that brings in what it depends on.** `use scene.{node}` puts `node`
in scope but not the types `node` is made of, so the build fails with
"declares no type 'axis'" until every transitive type is named by hand.

**Deferrable exports.** [Events](#events-input-and-what-a-widget-reports)'s deferred delivery is the host's doing, but a
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

`zfx` loads a Zena component, binds its `zenafx:host/scene` import to the tree
the host holds, and opens a window showing text centred by a flexbox layout.

[softbuffer]: https://github.com/rust-windowing/softbuffer

The work, in the order it was done. Step 6 is done for one component.

1. ~~**WIT.**~~ `packages/zenafx/wit/zenafx.wit` holds both packages, with
   `zenafx:host` nested inside `zenafx:ui`: `wasm-tools` wants one top-level
   package per directory plus nested ones, and `readWitSource` concatenates
   the directory's `.wit` files.
2. ~~**Host: surface.**~~ A `winit` loop under `ControlFlow::Wait`, one
   window, presenting through `softbuffer`. A frame happens on
   `RedrawRequested` and at no other time. Input is delivered to a `Scene`,
   which is the seam the loader will sit behind; the WIT-facing `stream`s
   arrive with the loader, since there is nothing to stream to yet.
3. ~~**Host: text.**~~ [`parley`][parley] behind `register_run` /
   `measure_run`, which brings `fontique`, `harfrust` and `skrifa` with it. A
   run id indexes a table of shaped layouts; a layout is re-broken only when
   the width it is asked about differs from the one it holds.
4. ~~**Host: layout.**~~ [`taffy`][taffy] 0.14, rebuilt per `solve` from the
   flat node list, with the `compute_layout_with_measure` closure calling the
   text engine from step 3. Taffy reports each node relative to its parent,
   so the solve ends with a pre-order walk that puts every rect in the root's
   space.
5. ~~**Host: paint.**~~ [`vello_cpu`][vello-cpu] rasterizing the display list
   into a buffer presented through [`softbuffer`][softbuffer], which the
   workspace already resolved at 0.4.8 by way of `frame-buffer-wasmtime`.
   `vello_cpu` 0.2.0 re-exports [`vello_common`][vello]'s `color`, `kurbo` and
   `peniko`, which the GPU renderer shares, so the geometry and brush types
   the display list is built from survive a move to the GPU. Whether the
   renderer-facing scene API also survives it is worth checking when the
   versions are pinned.
6. **Host: the loader**, partly. The [Runtime linking](#runtime-linking-and-import-interposition) path, at its smallest: compile the
   component, read its imports, bind `zenafx:host/*` to the host
   implementations with a fresh `Linker`, instantiate it and call its `main`.
   A binding between two components, fetching over the network, caching and the
   policy check come in milestone 4.
7. ~~**Host: the scene.**~~ `ui/scene.rs`: the node arena, templates and their
   holes, slots and their content, the walk that builds the flat list the solve
   takes, and the walk that builds the display list.
8. ~~**The application.**~~ `examples/zenafx/widgets/` and
   `examples/zenafx/counter/`, with their worlds.
9. ~~**Build wiring.**~~ Two separate mechanisms have to be set up, and
   confusing them is the likely first stumble. A Zena `import {...} from
'zenafx:host/scene'` resolves through a **package manifest** entry, which is
   what makes the specifier's `zenafx` namespace WIT-backed:

   ```json
   {"dependencies": {"zenafx": {"wit": "./packages/zenafx/wit"}}}
   ```

   The **world** a component is checked against and emitted for comes from
   `--wit` and `--world` instead, pointing at a document that declares it.
   Then:

   ```bash
   zena build examples/zenafx/widgets/main.zena -o widgets.wasm \
       --target component --wit examples/zenafx/widgets.wit --world app
   zfx --app widgets.wasm
   ```

   The world document can `import zenafx:host/scene@0.1.0` by name without the
   `zenafx` WIT sitting beside it: when the target emits a component, the CLI
   collects the source of every WIT-backed package in the manifest and splices
   it into the declared world's document before parsing
   ([cli/main.zena](../../packages/compiler/src/cli/main.zena), the
   `packagesWit` collection).

The world the application is checked against:

```wit
// examples/zenafx/widgets.wit
package example:widgets@0.1.0;

world app {
  import zenafx:host/scene@0.1.0;

  export zenafx:host/app@0.1.0;
}
```

The application is written against [The scene protocol](#the-scene-protocol).
`examples/zenafx/widgets/` is the one that centres text in a window;
`examples/zenafx/counter/` adds a value that changes over time. The spellings
follow the WIT-typed module conventions the compiler already uses: a `record`
becomes a case class, a `variant` a sealed class whose cases are named for the
variant and the case together, and an `option<T>` becomes `Option<T>` with
`some`/`none` from `zena:core` — as in
[geo-wit.zena](../../packages/compiler/test-files/component/geo-wit.zena).
A WIT `resource` becomes a `final class` implementing `Disposable`, which is how
`node` reaches Zena.

Milestone 1 is done: `zfx --app packages/zenafx/out/widgets.wasm` shows the
window and re-centres on resize, which puts the layout solve, the measure
callback and the demand-driven redraw all on the path. `tests/app.rs` asserts
the component's geometry against the same numbers `ui::demo`'s tests assert, so
the Rust-only scene and the component-driven one are known to agree.

### Later milestones

**Milestone 2: input and hit testing.** The host hit-tests a point against the
tree it holds and delivers the event to the listeners it reaches; a handler
changes a colour and the frame that follows shows it.

This is done: [Implementation status of events](#implementation-status-of-events)
for the pointer, [Scrolling](#scrolling) for the wheel,
[Pointer capture](#pointer-capture) for a drag, and
[The keyboard and the focus](#the-keyboard-and-the-focus). Text input is not.

**Milestone 3: widgets, templates and the scheduler.** Template registration,
positional bindings, per-widget dirty checking, the depth-ordered queue. A counter
whose label updates on click, making exactly one `apply` call per click.
Templates and bindings are built; the queue and `apply` are not.

**Milestone 4: a second component, fetched.** The root imports a child
component's world, hands it a node from one of its slots, fills the slot the
child declares, and receives an event from it — two instances in
the graph, with the child named by URL, fetched, cached by content hash, and
checked against a policy before instantiation. This is the milestone that tests
[Events](#events-input-and-what-a-widget-reports), [Context](#context-values-that-inherit-down-the-tree) and the capability model rather than describing them. The child should
be written in something other than Zena, so that the dispatch choice in [Events](#events-input-and-what-a-widget-reports) is
exercised rather than assumed.

**Milestone 5: Tier 2 and Tier 3.** Path commands in the display list, and a
GPU viewport node backed by `wasi:webgpu`. The existing `zfx` triangle fixture
becomes a node inside a ZenaFX tree instead of owning the window.

## Repository layout

```
packages/zenafx/
  wit/
    zenafx.wit                # zenafx:ui@0.1.0, zenafx:host@0.1.0 nested
  src/
    main.rs                   # engine, wasi-gfx, and `--ui`
    lib.rs
    loader/
      mod.rs                  # compile, instantiate, run a component
      link.rs                 # per-instance Linker, import binding
      listeners.rs            # a stream per listener, and its replies
    ui/
      mod.rs
      types.rs                # Rust mirrors of the WIT records
      surface.rs              # winit loop, ControlFlow::Wait
      scene.rs                # the node tree: templates, slots, hit test, draw
      events.rs               # pointer events and which listeners hear them
      text.rs                 # parley, the run table
      layout.rs               # taffy, flat tree in, rects out
      paint.rs                # vello_cpu + softbuffer
      demo.rs                 # a scene built in Rust, for `--ui`
examples/zenafx/
  framework.zena              # widgets, templates and holes over the protocol
  widgets.wit, counter.wit, button.wit
  widgets/                    # main, widget, card, label
  counter/
  button/
```

`framework.zena` is the widget side of the design: the widget tree, and the code
that turns a widget's `build` into `render` and `content` calls. It is a library
each example links in, so it is versioned with the application. It becomes a
package when the authoring surface in
[zenafx-widget-authoring.md](./zenafx-widget-authoring.md) replaces it.

## Prior implementations

Things that were built and then removed. They are recorded because the design
above is shaped by them, and because a reader who finds them in the history
deserves to know why they went rather than inferring that nobody thought about
it. [Alternatives considered](#alternatives-considered) covers designs rejected
on paper; these were running code.

**One widget per component.** A component exported `zenafx:host/widget` —
`render(width, height)` and `measure(request)` — so a component _was_ a widget.
`zenafx:host/children` embedded one in another: `spawn` by filename, `fill-slot`
by string name, `place` into a rect, `place-slot` to draw what was put there.
`layout.content` had `child` and `slot` cases so a solve could reach a leaf
belonging to someone else, and the host called that component's `measure` to size
it.

It worked, and
[Reasons for a retained tree](#reasons-for-a-retained-tree) has the
measurement: three components drawing one card cost 6 solves and 54
cross-component `measure` calls per frame, where one retained component cost
nothing. It was removed because the unit was wrong rather than because the
numbers were bad — a widget and a component are different things, and a component
that wants isolation still wants many widgets inside it.

Removed with it: the `render`/`measure` interface, the `children` interface, the
`child` and `slot` content cases, the host's widget table, clip and origin stack,
spawn queue and cross-boundary counters, and the three-component example that
produced the numbers. `UiHostState` went from eleven fields to four.

**Polling for upward events.** [Events](#events-input-and-what-a-widget-reports)
previously inverted upward communication into a poll: a child accumulated events
and exposed `take-events`, and its parent read the list during the pass. The
reasoning about call direction survives and is still in that section; the
mechanism does not, because the host can dispatch to both sides and then neither
calls the other, and because a poll pays for a call to discover there was nothing
to report.

**A handle to a subtree.** A `content` resource, minted by `viewport.seal`, let a
container hold a subtree it could not read. It was never built, and it is recorded
here because it is the obvious reach and it is unnecessary: the host does the
projection, so a container is handed a node per child and nothing else. See
[Interior and content](#interior-and-content).

**Returning the tree from the entry.** `zenafx:host/app` exported
`start: func() -> list<node>`, so a component described its whole tree once and
the host installed it. That cannot express an update, since there is no node the
component can name afterwards, so the entry is now `main: async func()` and the
component renders into the nodes `zenafx:host/scene` hands it.

An exported interface containing a `resource` also could not be compiled at the
time, which
[What the compiler still has to build](#what-the-compiler-still-has-to-build)
records. Importing one works, which is how `node` reaches a guest.

## The runtime component design

This section keeps an earlier version of the design, in which a Zena component
held the node tree. It is not built and is not the plan.
[The node tree in the host](#the-node-tree-in-the-host) gives the reasons. It
is kept because the WIT for it is still in
[`zenafx.wit`](../../packages/zenafx/wit/zenafx.wit), as the `scene` and
`session` interfaces of `zenafx:ui`, and because two of its ideas are still
open: ids a guest chooses, and writes that return nothing.

In that design the host served only primitives: `text`, `layout`, a `present`
call taking a display list, and the window. A **runtime component**, written in
Zena, imported those and exported `zenafx:ui/scene`. It held the node arena, a
dirty set and the hit test. An application imported `zenafx:ui/scene`, and the
host bound that import to the runtime component's export.

### The viewport is the capability; nodes are ids inside it

A [WIT][wit] `resource` is a handle in the holder's own table: it cannot be
forged, cannot be guessed, and its destructor tells the provider when the holder
lets go. One resource per node puts a handle-table entry behind every node a
component holds. One resource per _viewport_ would give the same security for
fewer handles.

So `viewport` was a resource, the authority to build under one node, and a
`node` was a plain `u32` chosen by the holder and meaningful only relative to
the viewport it was used with. Forging one buys nothing: the worst a component
can reach is another node in a viewport it already holds.

Flatland works this way: `fuchsia.ui.composition` has the client pick every
`TransformId` and `ContentId`, scoped to the client's own session. Letting the
caller name the id also removes a round trip, since `create` has nothing to
return.

A component received its viewport from its parent and could `derive` narrower
ones to hand on, each carrying at most the `grants` (pointer, keyboard) of the
one it came from. A child offered its parent a slot by deriving a viewport
rooted at one of its own nodes and returning it.

[wit]: https://component-model.bytecodealliance.org/design/wit.html

### Feed-forward mutation

Every scene call crossed a component boundary, so `viewport.apply` took a list
of operations: `make-box`, `make-text`, `set-layout`, `set-style`,
`set-content`, `provide` and `remove`. With the caller naming its own ids,
`apply` had nothing to return.

A function with no result can be delivered late. The host can queue the call,
return immediately, and run it when the callee is safe to enter, and the caller
cannot tell the difference. Flatland calls the same property feed-forward:
operations accumulate and take effect at `Present`.

The protocol that is built keeps this for hole writes
([Batching and the frame](#batching-and-the-frame)) and gives it up for
creation: `render` and `content` return handles the host minted. The first
entry under [Open questions](#open-questions) is whether to take ids chosen by
the guest back.

### `zenafx:ui` in WIT

The `scene` interface of `zenafx:ui` declares `viewport` with `apply`, `bounds`,
`inherited`, `derive` and `invalidate`, and a free function `flush`. The
`session` interface declares `root-viewport`, which only the loader called. The
`runtime` world in `zenafx:host` is what the runtime component was compiled
against. All three are in
[`zenafx.wit`](../../packages/zenafx/wit/zenafx.wit) and nothing implements
them.

### The root drives the frame

The frame loop lived in the application root:

```
await for each frame event from zenafx:host/surface:
    run this component's pending widget updates
    call each dirty child component's update export
    call scene.flush()          // runtime solves layout and presents
```

A frame was then one pass from the root down through components, which fixed
the order widgets in different components updated in. The cost was that every
frame entered the root, and a resize, a hover or a scroll entered at least two
components.

## Alternatives considered

**A runtime component holding the tree.**
[The runtime component design](#the-runtime-component-design) describes it and
[The node tree in the host](#the-node-tree-in-the-host) says why the host holds
the tree. The case that would reopen it is a host that cannot be changed, such
as a browser, where the primitives would be all a host offers and the scene
would have to ship with the application.

**A Zena component between applications and the host**, holding no nodes. It
would serve a stable interface to applications and translate it to the host's,
so that the host's interface could change freely. Not adopted now, because a
library linked into each application gives the same versioning with no extra
call per write. It is the shape the adapter for an old interface version takes
([The node tree in the host](#the-node-tree-in-the-host)), and it may be needed
when several components share a window and something has to order their
updates.

**An immediate-mode interface, with the guest sending the picture each frame.**
Rejected on the canonical ABI's copy cost, measured in
[Reasons for a retained tree](#reasons-for-a-retained-tree).

**Re-rendering with reconciliation, as React and Flutter do.** A guest would
re-run a build function and the framework would match new descriptions against
existing instances. Rejected because it needs machinery that this protocol makes
unnecessary: keys to decide which instance a description refers to, a framework
tree of instances to match against, and a split between stateless and stateful
widgets so that the framework knows what survives a rebuild. The guest here
subscribes a hole instead, and writes it when the value changes.

**Positional state, as React hooks and Jetpack Compose do.** State would live in a
slot table keyed by call position. Rejected because the ordering rules that make it
sound — no state declared inside a condition or a loop — are not expressible in the
type system, so they would be a convention enforced by a lint Zena does not have.

**A signal resource in the host.** Rejected in
[Reactive state](#reactive-state): a `variant value` erases the value's type at
every read.

**Layout as a guest component from the start.** Measurement is what rules it
out for milestone 1: a guest solver needs a re-entrant call into the host text
engine mid-solve, which is more machinery than calling `taffy` in the host, and
it buys nothing until someone writes a custom layout. [Tiers beyond boxes and text](#tiers-beyond-boxes-and-text) describes the shape
it takes then.

**A `choice` node kind in templates.** An earlier version of this design put a
`choice` node kind and an `active` hole into `zenafx:host/scene`, compiling
`if` and `match` into a fixed list of pre-allocated branch subtrees (like
SwiftUI's `_ConditionalContent` or Wiz's `one-of`). Rejected because it eagerly
allocates nodes for branches that may never be visited, cannot cache
dynamically keyed views (such as data-driven tabs or routes), and bakes
branch-retention policy into the host protocol. [Detached nodes and slot
assignment](#detached-nodes-and-slot-assignment) replaces it with `create-node`
and `set-slot`, which let guest directives implement lazy `cache()` and keyed
`repeat()` with one smaller host primitive.

**A global registry, so a template can name a child widget by tag.** Rejected
because it reintroduces the collision described in [Prior art](#prior-art): a component that wants
a child imports that child's world, and two libraries that each supply a
button then coexist.

## Open questions

1. **Whether a guest should name its own nodes.** `render`, `content` and
   `create-node` hand back `own<node>` handles the host minted, so creating
   nodes takes a call that returns. A guest naming its own ids under a handle
   it holds would make every scene call return nothing, so writes, creation,
   detachment and reordering would all batch into one `apply`, as in
   [Feed-forward mutation](#feed-forward-mutation). The handle would still be
   the authority, so a forged id could only reach the forger's own subtree.
   What host-minted handles give is that a guest cannot name a node it was
   never given, with no check in the host. This is a question about the shape
   of `zenafx:host/scene`, and it is worth settling before that interface gets
   a version applications depend on.
2. **Resource retention for detached subtrees.** Moving branch caching into a
   guest `cache()` directive ([Detached nodes and slot
   assignment](#detached-nodes-and-slot-assignment)) lets the guest pause and
   resume signal effects while a branch is detached, which avoids writing holes
   to hidden nodes. What remains open is whether the host should keep shaped
   text runs for every detached node indefinitely or evict cached glyph layouts
   under memory pressure and re-shape on reattachment.
3. **What WIT type an event payload has.** The `handle` export in
   [Events](#events-input-and-what-a-widget-reports) takes `list<u8>`, which is
   the untyped envelope the rest of that section argues against. A closed variant
   of built-in input events with an opaque tail for widget-defined ones keeps the
   common cases typed and gives up on the rest. A generated dispatch interface per
   event type is fully typed and grows the world with every event a program
   declares. Neither is obviously right, and the choice is visible to every
   widget that raises or listens.
4. **Whether the loader should refuse a cyclic binding outright.** [Call direction](#call-direction-within-a-frame) settles
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
5. **Component identity.** Two documents naming the same URL: one instance
   shared, or one per document? Sharing makes a component a channel between
   documents, which the isolation story has to account for. A separate instance
   per document costs memory and loses warm state. The compiled artifact can be
   cached by content hash either way; this question is about instances.
6. **Integrity and versioning of a fetched component.** A URL is not a
   version, and a component that changes under the same URL changes an
   application's behaviour silently. Whether a document pins a content hash
   alongside the URL, and what happens when the fetched bytes do not match, is
   undecided.
7. **Cost of the dynamic binding path.** A guest→guest call goes through a
   host function that lowers and lifts through `Val`. No frame makes such a
   call, so the cost falls on a parent calling a child and on an adapter serving
   an old version of `zenafx:host/scene`, where it is paid on every write. It
   has not been measured.
8. **Coordinate spaces.** A pointer event's position is measured from the
   listening node's box, so a component does not learn where it sits on screen.
   No function reads a node's rectangle back yet. Whether one should exist, and
   in which space it answers, is undecided; overlay placement needs something
   like it.
9. **Retained display lists.** The host walks the whole tree into a display list
   every frame. At what scene size does that stop being adequate, and what
   replaces it — a retained list with per-node invalidation, or damage
   rectangles plus a full list for the damaged area? The answer needs a
   measurement on a real scene.
10. **Text runs and reflow.** A run is shaped at registration and measured at
    a width during the solve. Whether the measured layout at the final width is
    reused for painting, or the run is reshaped once layout settles, decides
    whether a wrapped paragraph costs one shaping pass per frame or none.
11. **Accessibility.** A retained tree of boxes and text with known bounds is
    most of what an accessibility tree needs. The host derives one from the
    scene, since it holds the tree. What a component has to add, a role and a
    label on a node, is not in `node-def` yet.
12. **Per-component time budget.** A component that takes 50 ms to handle an
    event does not delay a frame, which the host paints from the tree it has.
    It delays every other component in the window, since
    [Serialization across components](#serialization-across-components) rules out running the others meanwhile. [Capabilities and isolation](#capabilities-and-isolation) names the mechanism —
    an async epoch deadline or a fuel interval yields out of the overrunning
    component and resumes it later. When to yield, and whether a component that
    overruns repeatedly is told, is undecided.
13. **Frames that show part of an update.** Two components that respond to one
    event write to the tree at different times, and the host may paint between
    them ([Scheduling](#scheduling)). The runtime component design avoided this
    by passing every frame through the root. Whether it matters in practice,
    and whether the answer is a write the host holds back until a set of
    components has answered, is undecided.
14. **Versions of the scene interface.**
    [The node tree in the host](#the-node-tree-in-the-host) proposes that the
    host serve more than one version of `zenafx:host/scene`, and that an old
    version move into a Zena adapter component. Neither is built. The adapter
    has to export an interface whose `node` is a resource, and
    [What the compiler still has to build](#what-the-compiler-still-has-to-build)
    records a case of that which does not validate yet.
15. **Capabilities of a shared instance.** An instance's I/O — network,
    filesystem, clocks — is bound once, at instantiation, so an instance
    reachable from two importers has one set of it. If those importers would
    grant different sets, the instance can hold the intersection, which denies
    one importer something it wanted to allow, or there can be an instance per
    importer, which gives up the sharing that makes a graph worth having. The
    union is not available: it would let the instance act on one importer's
    authority while serving the other's request. This is the same question as
    **Component identity** above, reached from the capability side rather than
    the memory side.

    Scene authority is not affected. An instance holds a `node` handle from
    each parent that gave it one, so nothing has to be intersected; the
    question is only about what the loader binds at instantiation, which is
    where [Capabilities and isolation](#capabilities-and-isolation) already runs
    its check.

## Related

- [graphical-runtime.md](./graphical-runtime.md) — `zfx`, the host binary,
  and the `wasi-gfx` / `wasi:webgpu` interfaces it serves today
- [component-model.md](./component-model.md) — WIT interop: what an
  `import ... from` a WIT means, resource lifetime, and the type mapping
- [component-emission.md](./component-emission.md) — how components are
  emitted, and the `--wit`/`--world` surface
- [declarative.md](./declarative.md) — unified node literals (`Type { ... }`),
  tagged node literals (`@ui Box { ... }`), `$(...)` bindings, and markup sugar
- [zenafx-widget-authoring.md](./zenafx-widget-authoring.md) — what a widget
  looks like written with `@ui` tagged node literals and `$(...)` bindings, how
  signals and guest directives (`cache`, `repeat`) drive the scene protocol,
  and selectors shipped as data. An exploration; nothing in it is built.
- [capabilities.md](./capabilities.md) — capability-based I/O in the language,
  of which viewports are one instance
- [streams.md](./streams.md) — `Stream<T>` and the rendezvous core the event
  streams ride on
- [record-presence.md](./record-presence.md) — presence-optional record
  fields, which the style records want
- [zenafx-navigation-and-assets.md](./zenafx-navigation-and-assets.md) —
  how a window names what it shows, and how a component names an image it
  did not compile into itself. Both are unbuilt.
- [zenafx-libraries-and-examples.md](./zenafx-libraries-and-examples.md) —
  the Rust libraries to take for input, focus, overlays, text editing and
  accessibility, and the example programs to write after the milestones
  above. A proposal.
