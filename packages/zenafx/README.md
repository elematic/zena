# zenafx (`zfx`)

An experimental runtime for running graphical WebAssembly components with
Wasmtime, `wasi-gfx`, and `wasi:webgpu`.

```bash
zfx app.wasm
zfx --invoke start app.wasm
zfx -g app.wasm             # turn off Cranelift inlining for readable backtraces
zfx --ui                    # the ZenaFX host primitives, no component
```

## Overview

`zenafx` (`zfx`) runs WebAssembly components that target graphical interfaces.
It provides host-side support for:

- **`wasi:webgpu`**: GPU compute, shader modules, pipelines, command buffers,
  and render passes (backed by `wasi-webgpu-wasmtime` and `wgpu-core`).
- **`wasi-gfx:surface`**: OS window creation, sizing, and event handling
  (`on-frame`, `on-pointer-down`, `on-resize`, etc., backed by
  `surface-wasmtime` and `winit`).
- **`surface-webgpu`**: Presentation context connecting a `Surface` to a WebGPU
  `Device` to present rendered textures.
- **`frame-buffer-wasmtime`**: 2D software framebuffer presentation.
- **`wasi:cli`**: WASI 0.3 CLI and stdio, the same surface the zena host links.

Design document:
[docs/design/graphical-runtime.md](../../docs/design/graphical-runtime.md).

## The ZenaFX UI stack

A second, independent layer is being built alongside the `wasi-gfx` path: a
retained-mode UI whose applications are trees of components linked at run
time. Its interfaces are declared in [`wit/zenafx.wit`](wit/zenafx.wit) and
designed in [docs/design/zenafx-ui.md](../../docs/design/zenafx-ui.md).

`src/ui/` holds the Rust side — the four `zenafx:host` primitives:

| Module       | Serves                | Built on               |
| ------------ | --------------------- | ---------------------- |
| `text.rs`    | `zenafx:host/text`    | `parley`               |
| `layout.rs`  | `zenafx:host/layout`  | `taffy`                |
| `paint.rs`   | the host alone        | `vello_cpu`            |
| `surface.rs` | `zenafx:host/surface` | `winit` + `softbuffer` |

`paint.rs` serves no interface. Rasterizing and presenting belong to the host
alone: a component changes what is on screen by changing its nodes, and the
host walks the tree it already holds into a display list. Nothing a component
can call takes a display list or pixels.

Text measurement happens _inside_ the layout solve, because how tall a run is
depends on the width flexbox gives it. `layout::solve` hands taffy a closure
over the text engine, so a container that is too narrow makes its label wrap
and the solve sees the new height.

This stack does not use `wasi-gfx:surface`, which wakes every surface 60 times
a second whether or not anything changed. `ui::surface` runs its own `winit`
loop under `ControlFlow::Wait`: a frame happens when a redraw was requested,
and never otherwise.

`src/loader/` loads an application component and runs it in that window. It
compiles the component, builds a `Linker` for it, defines the `zenafx:host`
interfaces the component imports, instantiates it and asks it once what it
draws. A fresh `Linker` per instance is the shape the design needs: which
imports an instance gets is decided per instance, so that a component can be
given some interfaces and not others, and so that a binding to another
component can go through a host trampoline.

```bash
npm run build:widgets -w @zena-lang/zenafx    # compiles it to out/widgets.wasm
npm run zfx -w @zena-lang/zenafx -- --app out/widgets.wasm
```

There is one build script per example, so `build:widgets` compiles only the
widgets and `build:counter` only the counter. `build:examples` does both, and is
what `npm test` depends on.

`zfx --ui` shows the same scene assembled in Rust by `ui::demo`, with no Wasm
in the picture:

```bash
npm run zfx -w @zena-lang/zenafx -- --ui       # builds, then opens the window
npm run zfx -w @zena-lang/zenafx -- --ui 'Hello from ZenaFX'
cargo run -p zenafx -- --ui                    # unoptimised, no Wireit
```

A window opens showing the message in a rounded card, centred by a flexbox
layout. Resizing it re-solves and repaints; the layout is recomputed from the
new size rather than scaled. Close the window to exit. Nothing is drawn
between frames — the loop waits, and a frame happens only when a redraw was
requested.

### Widgets inside one component

[`examples/zenafx/widgets/`](../../examples/zenafx/widgets/) is one
component holding three widget classes, composed in the language: a page of
three cards, each with its own title, accent colour and content, and one of
them holding two labels in its slot.

Instances are what carry that variation. `Card` keeps its title and accent
as instance fields and reads them in `build`, so three cards in one tree
draw three titles; the shared constants — the card's fill, its border, its
corner radius — stay module-level, because every card draws them the same
way. `tests/app.rs` measures the three title runs and asserts they differ,
which is the assertion a module-level title fails.

A widget there is an ordinary Zena object with one method, `build(): Rendering`,
which names the template to show, one value per hole in it, and the widgets for
each of its slots. The template is module-level, built once per widget class, and
a box tree is written with nested calls and flattened into the flat node list the
host takes. Options are a record with every field optional, so a box names what it
cares about and nothing else.

```zena
let cardTemplate = template(
  box({style: cardStyle, align: Align.Stretch, gap: 10.0, padding: cardPadding}, [
    text('', titleStyle(surface)),
    box({style: wellStyle, padding: wellPadding}, [slot()]),
  ]),
  [new Binding(1 as u32, BindingTarget.Content),
   new Binding(1 as u32, BindingTarget.Style)],
);
```

The title is a hole rather than a value, which is what lets three cards share one
template. The well is a box _around_ the slot because a slot is not a box: it
contributes no geometry, so its content lays out in whatever contains the slot —
the same reason a `<slot>` gets wrapped in a styled `<div>`.

A box says how it looks as well as how it lays out, so the host paints the same
tree it solved — no widget builds a display list and none handles a shaped run.

The component exports `zenafx:host/app`, which is one function:

```wit
main: async func();
```

It builds its root widget, renders it, and calls `ready`. `async func` is about
the lift rather than the body: it is what lets the host re-enter a component that
started work, so an ordinary synchronous `main` can arm a timer and return — see
`examples/zenafx/counter/`. A component that starts nothing never needs
re-entering.

Building the tree goes through `zenafx:host/scene`, whose whole write surface is
one method:

```wit
resource node {
  render: func(template: template-ref, holes: list<hole>);
  content: func(slot: u32, count: u32) -> list<own<node>>;
}
```

`render` creates, patches or replaces, and the host decides which by comparing
template identity against what the node already shows — the guest never says
which it meant. Node 0 of a template _is_ the node rendered into, so a widget is
one box; the rest is its interior. `content` is how a parent gives each of its
children a node, and the only place a child is added or removed. A template's
definition travels with its first use and afterwards only its id does.

The host owns the tree from there. A resize is solved and painted host-side with
**no call into the component at all** — `tests/app.rs` resizes four times and
asserts the entry count stays at one, and `tests/counter.rs` makes the same
assertion for a component that is still working: re-entering the entry's task
through its callback is not another call to `main`.

### Updating what is on screen

[`examples/zenafx/counter/`](../../examples/zenafx/counter/) is the other half:
two counters in a row, one template used twice, each advancing on its own timer.

The rate belongs to the widget. A counter arms a `sleep` from `zena:time` over
`wasi:clocks` — 500ms for one and 1500ms for the other — and ZenaFX declares no
timer interface of its own; the display's refresh rate has nothing to do with
either. When a period comes due the counter advances its count and calls
`refresh`, and because the template has not changed, the only thing that crosses
the boundary is the digit string.

```bash
npm run build:counter -w @zena-lang/zenafx    # compiles it to out/counter.wasm
npm run zfx -w @zena-lang/zenafx -- --app out/counter.wasm
```

The host then patches that one node, keeping its id and the run it shaped for it.
`tests/counter.rs` is the evidence: the run id is the same after ten periods, so
nothing was rebuilt, while the run measures wider once the count reaches two
digits, so it really was reshaped. Four of those tests wait out real sleeps and
are `#[ignore]`d until a clock can be substituted for `wasi:clocks`; run them with
`cargo test -p zenafx --test counter -- --ignored`.

### Hearing the pointer

[`examples/zenafx/button/`](../../examples/zenafx/button/) is a count and a
button that adds one to it. The button changes colour while the pointer is over
it and while it is pressed, and a press anywhere else on the page sets the
count back to zero.

```bash
./target/release/zena build ./packages/zenafx:build:button   # compiles it to out/button.wasm
./target/release/zfx --app packages/zenafx/out/button.wasm
```

A handler is a function, and a function cannot cross to the host. So a widget
describes each one: which node of its template hears, and which kind of event.

```zena
return shows(buttonTemplate, [new BindingValueContent(this.#label)]).hearing([
  on(PointerKind.Down, () => {
    this.#pressed();
  })
]);
```

Each becomes one call when the template is built. The call adds a listener in
the host and returns a stream:

```wit
resource node {
  listen-pointer: func(target: u32, kind: pointer-kind, in-scope: scope, at: phase)
      -> stream<delivery>;
}

record delivery { event: pointer-event, reply: option<reply> }
resource reply { stop-propagation: func(); }
```

The host writes each event the listener hears to its stream. The framework
reads the stream in a loop and calls the handler with each event. Dropping the
stream removes the listener. When the node goes away, the host removes the
listener and ends the stream, and the framework's loop finishes. A widget has
no cleanup of its own to do for its listeners.

The host remembers the layout: the rectangle each node was given in the last
frame. From those rectangles it finds the node under the pointer, and from the
listeners it holds it finds which of them an input reaches, before it writes
anything to the component. An input that reaches none does not wake the
component.
`tests/button.rs` moves the pointer across the page, onto the button and about
inside it, and asserts that no event is written until the button is pressed.

A `down`, `up` or `move` is offered along the path between the root and the node
under the pointer, to one listener at a time. It comes with a `reply`. The next
listener is offered the event when this one drops the reply, and no listener is
if this one called `stop-propagation` first. A press on the button reaches the
button, which stops its propagation, so the page's listener does not set the
count back to zero.

`enter` and `leave` tell a listener that its scope gained or lost the pointer,
so a button hears nothing when the pointer moves from its padding onto its
label. They carry no reply. A position is measured from the listening node's
own box.

The handlers run on the component's thread, after the window's thread has moved
on. When one changes the tree, the `render` that changes it wakes the window for
a frame.

### How a node looks under the pointer

The button has no handler for the pointer arriving or leaving, and no field
saying whether it is hovered. Its template says how its box looks in each case,
beside its bindings:

```zena
[new StateStyle(0 as u32, State.Hovered, 0 as u32, new RestyleFill(hoveredStyle)),
 new StateStyle(0 as u32, State.Pressed, 0 as u32, new RestyleFill(pressedStyle))]
```

```wit
record state-style {
  node: u32,      // the node that changes
  when: state,    // hovered, pressed
  of: u32,        // the node whose state is read
  style: restyle, // a box-style, or a text-style
}
```

The host already knows which node the pointer is over, since it is what finds
it, so it draws whichever look holds. A hover or a press that only changes how
something looks costs a frame and wakes nobody: `tests/button.rs` takes the
button from resting to hovered to pressed and back, and the only event written
to the component is the `down` it listens for.

`node` and `of` are separate because a label can change while the button round
it is hovered. A state holds for a node when the pointer is over it or anything
beneath it, so the button stays hovered while the pointer is on its label.

A frame also notices when the tree moved and the pointer did not. If a layout
change slides a different node under a still pointer, the frame that solves the
new layout draws that node hovered, and the `enter` and `leave` calls that
follow from it are delivered afterwards.

### Scrolling

[`examples/zenafx/scroll/`](../../examples/zenafx/scroll/) is forty rows in a
box that shows six, under a line saying which row was pressed.

```bash
./target/release/zena build ./packages/zenafx:build:scroll   # compiles it to out/scroll.wasm
./target/release/zfx --app packages/zenafx/out/scroll.wasm
```

The list scrolls because its box says so, and for no other reason:

```zena
box({style: listStyle, align: Align.Stretch, width: new LengthPx(280.0),
     height: new LengthPx(240.0), overflowY: Overflow.Scroll}, [slot()])
```

```wit
enum overflow { clip, hidden, scroll }

record flex {
  // ...
  overflow-x: overflow,
  overflow-y: overflow,
}
```

Content that does not fit in a box is cut off at the box's edge, whichever of
the three the box says. Nothing is drawn outside a box. The values are CSS's,
with CSS's meanings, and CSS's `visible` is left out.

- `clip` is the default, for a box whose content is expected to fit. The box
  is never laid out smaller than its content. If the content still does not
  fit, because the box was given a size, it is cut off and the host logs a
  warning.
- `hidden` is for a box meant to hold more than fits. It may be laid out
  smaller than its content.
- `scroll` is `hidden`, and the wheel moves the content as far as it reaches.

A box whose content fits is drawn with no clip, so cutting off by default
costs nothing where there is nothing to cut.

How far a box has scrolled is the host's to keep, as what the pointer is over
is. The component has no handler for the wheel and holds no position:
`tests/scroll.rs` wheels the list to its end and back, and no event is written
to the component.

The rows say `shrink: 0.0`, because a box in a column otherwise gives up height
before it overflows, and forty rows that each gave up a little would fit.

What is cut off entirely is not drawn, so a frame costs the rows that show. It
is not under the pointer either: a press below the list reaches no row, though
rows are laid out there, and a press after scrolling reaches the row drawn under
it. The frame after a scroll tests the pointer again, so the row that scrolled
under a still pointer is the one drawn hovered.

The wheel goes to the nearest box under the pointer that scrolls that way and
has further to go, so a list at its last row passes the wheel to the page.

A box with further to scroll shows a thumb along its edge: as long, against the
box, as the box is against its content, and as far along.

A frame after a scroll solves no layout. The solver's answer stands until the
component writes the tree or the window changes size, and scrolling and
hovering do neither, so those frames are a walk of the tree and a paint.

### What is not here yet

A window shows one component. Embedding one component in another is designed
in [Interior and content](../../docs/design/zenafx-ui.md#interior-and-content) and
not implemented: an earlier prototype did it by
having each component export `render` and `measure`, which fixed one widget
to one component, and that was removed. Whatever replaces it will embed
components of this shape, each holding as many widgets as it likes.

That prototype was also where the cost of a component boundary was measured —
three components drawing one card came to 6 solves and 54 cross-component
`measure` calls per frame, against 0 and 0 for the retained tree. Those
numbers are no longer reproducible from this tree.

Keyboard events reach the window but are not routed to the component, and there
is no focus. A press does not capture the pointer, so the `up` that ends a drag
goes to whatever the pointer is over by then. A scroll thumb cannot be dragged
or styled, a component cannot read or set how far a box has scrolled, and a
box's content is cut off at a rectangle, so it shows in the corners of a box
with rounded ones.
Navigation and asset loading are
designed in
[zenafx-navigation-and-assets.md](../../docs/design/zenafx-navigation-and-assets.md)
and not built. Milestone 1 of the UI design says what else that leaves out.

Everything but the window is covered by tests that need no display, including
rasterization: `src/ui/` has unit tests for each primitive, and
`tests/app.rs` loads the widgets component and asserts its geometry against
the same numbers the Rust scene is asserted against. The two windowed paths have
`#[ignore]`d smoke tests that watch for the first presented frame:

```bash
npm test -w @zena-lang/zenafx             # headless; builds the component first
npm run test:gui -w @zena-lang/zenafx     # opens windows
```

## Threading Architecture

Operating systems (specifically macOS/AppKit) require window management and OS
events to run on the main process thread. WebAssembly execution under the
Component Model async ABI runs cooperatively on an asynchronous executor.

`zfx` separates these responsibilities across two threads:

1. **Main Thread**: Runs the `winit` window event loop via
   `surface_wasmtime::winit::create_wasi_winit_event_loop()`.
2. **Background Thread**: Runs a Tokio runtime that initializes Wasmtime,
   instantiates the guest component, and executes its asynchronous entry point.
3. **Cross-Thread Dispatch**: `WasiWinitEventLoopProxy` forwards window
   creation, resizing, and input events across threads without blocking the main
   event loop.

## Engine Configuration

The Wasmtime `Engine` inherits Zena's base configuration from `zena-runtime`
(backtrace details, GC collector settings, and compiler inlining) and enables the
Component Model with async support (`wasm_component_model` and
`wasm_component_model_async`).

## Building and Testing

```bash
cargo build --release -p zenafx            # builds target/release/zfx
cargo test -p zenafx                       # runs CLI integration tests (headless-safe)
npm test -w @zena-lang/zenafx              # runs test suite via Wireit

# Run the end-to-end graphical smoke test (opens native window, requires display & GPU):
cargo test -p zenafx -- --ignored
npm run test:gui -w @zena-lang/zenafx
```

## Running the Demo Component

To run the reference WebGPU triangle component:

```bash
./target/release/zfx packages/zenafx/fixtures/triangle.wasm
```
