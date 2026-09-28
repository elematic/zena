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
- **`wasi:cli`**: WASI Preview 2 CLI and stdio.

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
| `paint.rs`   | `zenafx:host/paint`   | `vello_cpu`            |
| `surface.rs` | `zenafx:host/surface` | `winit` + `softbuffer` |

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
interfaces the component imports, instantiates it and calls its `render`
export once per frame. A fresh `Linker` per instance is the shape the design
needs: which imports an instance gets is decided per instance, so that a
component can be given some interfaces and not others, and so that a binding
to another component can go through a host trampoline.

[`examples/zenafx/hello.zena`](../../examples/zenafx/hello.zena) is such a
component — the same card-and-text scene, written in Zena:

```bash
npm run build:example -w @zena-lang/zenafx    # compiles it to out/hello.wasm
npm run zfx -w @zena-lang/zenafx -- --app out/hello.wasm
```

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

### Children and slots

A component embeds another through `zenafx:host/children`: `spawn` returns an
opaque handle, `place` draws that component into a rect, `fill-slot` puts one
component inside another's named hole, and `place-slot` draws whatever was
put there. An embedder holds a handle, never the child's exports.

[`examples/zenafx/`](../../examples/zenafx/) has a three-component demo:
`page.zena` spawns `card.zena` and `label.zena`, and projects the label into
the card's `body` slot. The card draws a title and an inset well so the
boundary is visible on screen — everything outside the well belongs to the
card, everything inside it is the label:

```bash
npm run zfx -w @zena-lang/zenafx -- --app out/page.wasm
```

The card declares a slot and never learns what filled it, yet the card's size
is its padding plus the label's size. That works because the **host** owns the
layout solve: when the solve reaches a slot it calls the filling component's
`measure` export itself. The embedder is suspended inside its own `solve` at
that moment, but it is not on the stack of the call into the child, so no
component is re-entered and no guest ever calls another guest.

The host also clips each child to the box it was given and translates its
display list into it, so a component draws in its own coordinates from its own
origin and cannot paint outside its box or discover where it ended up.

### Widgets inside one component

[`examples/zenafx/widgets/`](../../examples/zenafx/widgets/) is the same
picture built the other way: one component, three widget classes, composed
by constructor argument.

```bash
npm run zfx -w @zena-lang/zenafx -- --app out/widgets.wasm
```

A widget there is an ordinary Zena object with one method, `build(): Box`.
A box says how it looks as well as how it lays out, so the host paints the
same tree it solved — no widget builds a display list, holds a shaped run,
or keeps references to its own nodes. A slot is
`new Card(title, new Label(...))`: the card places the content and knows
nothing else about it.

The tree is installed once through `zenafx:host/scene`, and the host owns it
after that. A resize is solved and painted host-side with **no call into the
component at all** — `tests/app.rs` resizes four times and asserts the entry
count stays at one. A widget that changes replaces its own subtree, which is
the only update there is and the reason a widget keeps one piece of state:
the id of that subtree.

The component exports `zenafx:host/app`, whose `start: func() -> root` hands
the host a resource handle. `render` is a method on that handle, so the
component owns as many widget instances as it likes and shows the host one.

The two shapes draw the same picture — `tests/app.rs` asserts that — and
cost very different amounts:

| | `solve` calls | cross-component `measure` calls | frames to settle |
| --- | --- | --- | --- |
| three components | 6 | 54 | 2 |
| one component, retained | 0 | 0 | 1 |

A component boundary is worth paying for where isolation is wanted. Between
widgets that trust each other it buys nothing and costs 54 guest re-entries
a frame.

### What is not here yet

There is no scene graph. The design has an application importing
`zenafx:ui/scene` from a runtime component that owns one, with the application
driving the frame loop; today each component builds its own flat layout tree
and the host calls the root once a frame. Pointer and keyboard events reach
the window but are not routed to components, so nothing is interactive.
Navigation and asset loading are designed in
[zenafx-navigation-and-assets.md](../../docs/design/zenafx-navigation-and-assets.md)
and not built. Milestone 1 of the UI design says what else that leaves out.

Everything but the window is covered by tests that need no display, including
rasterization: `src/ui/` has unit tests for each primitive, and
`tests/app.rs` loads the hello component and asserts its geometry against the
same numbers the Rust scene is asserted against. The two windowed paths have
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
