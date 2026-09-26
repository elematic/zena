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

Nothing here loads a component yet. `zfx --ui` drives the primitives from
`ui::demo`, a scene assembled in Rust, which is how the stack is exercised
before the loader and the runtime component exist.

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

Everything but the window is covered by unit tests, including rasterization,
so `cargo test -p zenafx` checks the stack headless. The window itself has an
`#[ignore]`d smoke test that watches for the first presented frame:

```bash
cargo test -p zenafx --test run -- --ignored ui_demo_presents_a_frame
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
