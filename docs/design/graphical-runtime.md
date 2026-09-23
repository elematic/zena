# Graphical Runtime Design

## Overview

This document designs `zenafx` (command: `zfx`), an experimental runtime for
graphical Zena programs.

Zena separates execution into targeted tools:

- `zena-cli`: bundles the compiler, test orchestrator, benchmark runner, and
  documentation generator.
- `zena-run`: runs one compiled core Wasm module for the `zena-cli` target with
  minimal host imports (WASI Preview 1, stack traces, and process spawning).
- `zfx` (`zenafx`): runs WebAssembly components that interact with the host
  window manager and GPU.

The runtime builds upon the `wasi-gfx` and `wasi:webgpu` specifications,
implemented via host crates from the
[wasi-gfx-runtime](https://github.com/wasi-gfx/wasi-gfx-runtime) project.

---

## Host Architecture

### Wasmtime Integration

`wasi-gfx` is not a separate virtual machine. It is a collection of host-side
Rust crates that register graphics capabilities with a Wasmtime component
`Linker`:

- `wasi-webgpu-wasmtime`: host implementation of the `wasi:webgpu` interface,
  backed by `wgpu-core`.
- `surface-wasmtime`: host implementation of `wasi-gfx:surface`, backed by
  `winit` for window management and event loops.
- `frame-buffer-wasmtime`: host implementation of 2D software framebuffers.

Both Zena and `wasi-gfx-runtime` use Wasmtime 48.

`zenafx` wraps Wasmtime, combining Zena's engine configuration with the
`wasi-gfx` host extensions.

### Threading and Event Loops

Operating systems (specifically macOS/AppKit) require window management and OS
event processing to run on the main process thread. WebAssembly execution under
the Component Model async ABI runs cooperatively on an asynchronous executor.

`zfx` separates these responsibilities across two threads:

```
Main Thread:
  winit Event Loop (surface-wasmtime)
    │
    │  WasiWinitEventLoopProxy (channel)
    ▼
Background Thread (Tokio):
  Wasmtime Engine + Store (WasmGC + Async Components)
    └─ Guest Component execution
```

1. **Main Thread**: Runs the `winit` event loop created by
   `surface_wasmtime::winit::create_wasi_winit_event_loop()`.
2. **Background Thread**: Runs a Tokio runtime. It instantiates the Wasm
   component and executes its async start function.
3. **Communication**: `surface-wasmtime` provides `WasiWinitEventLoopProxy`,
   which forwards window creation, resizing, and input event dispatch across
   threads without blocking the main event loop.

### Engine Configuration

The Wasmtime `Engine` inherits Zena's base settings from
`zena-runtime::engine::config` (backtraces, GC collector options, inlining) and
enables the Component Model with async execution (`wasm_component_model` and
`wasm_component_model_async`).

---

## Interface Separation

Graphical execution relies on two distinct interfaces.

### `wasi:webgpu`

`wasi:webgpu` defines GPU compute and 3D rendering capabilities based on the
W3C WebGPU specification. It provides:

- Hardware adapter and device acquisition (`gpu`, `gpu-adapter`, `gpu-device`)
- Shader module creation (WGSL)
- Render and compute pipeline construction
- Command encoders and command buffers
- Buffer and texture allocations

`wasi:webgpu` has no concept of windows, monitors, or display surfaces. It
renders exclusively into textures.

### `wasi-gfx:surface`

`wasi-gfx:surface` defines OS windowing, surface presentation, and input events:

- Window lifecycle and sizing (`surface`)
- Event subscriptions (`on-pointer-down`, `on-pointer-up`, `on-resize`,
  `on-frame`)
- Context configuration bridges:
  - `surface-webgpu`: connects a `surface` to a `wasi:webgpu` device and
    presents rendered textures.
  - `surface-frame-buffer`: connects a `surface` to a 2D byte array for
    software rendering.

A full graphical application uses both interfaces: `wasi:webgpu` generates the
rendered frames, and `wasi-gfx:surface` presents them to the user.

---

## Guest Compiler Prerequisites

The reference guest application is the `triangle` example from
`wasi-gfx-runtime` (`examples/apps/triangle/src/lib.rs`). Compiling this
application in Zena directly via `--target component` requires compiler features
currently being completed under Zena's Component Model track (described in
`docs/design/component-model.md`).

### 1. Async Methods on Resources

In `webgpu.wit`, the entry point for device acquisition is asynchronous:

```wit
resource gpu {
  request-adapter: async func(options: option<gpu-request-adapter-options>) -> option<gpu-adapter>;
}

resource gpu-adapter {
  request-device: async func(descriptor: option<gpu-device-descriptor>) -> result<gpu-device, request-device-error>;
}
```

Zena's component lowering currently supports free async functions
(`async func(...) -> T`), but async methods defined on resources are marked as
pending in `packages/zena-compiler/zena/lib/wit-module-synth.zena`:

```zena
if (func.isAsync) {
  if (!freeMode) {
    return "an async resource function waits on the interop stages";
  }
}
```

The compiler must lower and synthesize async methods on resource classes.

### 2. Typed Streams of Records

The event loop in `wasi-gfx:surface` uses typed event streams:

```wit
resource surface {
  on-frame: func() -> stream<frame-event>;
  on-pointer-down: func() -> stream<pointer-event>;
  on-resize: func() -> stream<resize-event>;
}
```

Zena's `Stream<T>` supports `stream<u8>` for byte I/O. Non-`u8` stream elements
require canonical lowering and lifting of record payloads across the stream
boundary.

### 3. Borrowed Resource Arguments Across Packages

`surface-webgpu` configures the presentation context using a borrowed device
from `wasi:webgpu`:

```wit
resource context {
  configure: func(desc: context-configuration);
}

record context-configuration {
  device: borrow<device>,
  format: gpu-texture-format,
  ...
}
```

The compiler must handle borrowed resource handles that cross between imported
WIT packages.

---

## Implementation Plan

The work is split into two phases to allow progress on the runtime while
compiler prerequisites land.

### Phase 1: Host Runtime (`zenafx` / `zfx`)

1. **Crate Creation**:
   - Create `packages/zenafx` in the Cargo workspace (binary: `zfx`).
   - Configure dependencies on `wasi-webgpu-wasmtime`, `surface-wasmtime`,
     `frame-buffer-wasmtime`, `winit`, `tokio`, and `zena-runtime`.
2. **Runtime Binary**:
   - Implement `main.rs` with the `winit` event loop on the main thread and
     Tokio executor on a worker thread.
   - Configure Wasmtime engine with Zena's GC and Component Model settings.
   - Link `wasi-webgpu-wasmtime`, `surface-wasmtime`, `frame-buffer-wasmtime`,
     and `wasmtime_wasi::p2`.
3. **Host Verification**:
   - Build the reference `triangle` example from Rust into a component.
   - Run the component with `zfx` and confirm native window creation,
     event handling, and GPU rendering on macOS.

### Phase 2: Compiler Interop and Zena Guest

Once the required component model features land in the compiler:

1. **WIT Package Registration**:
   - Add `wasi:webgpu` and `wasi-gfx:surface` WIT packages to the compiler's
     package mapping.
2. **Guest Translation**:
   - Port `triangle` to Zena syntax (`packages/zenafx/examples/triangle.zena`).
   - Import `wasi:webgpu` and `wasi-gfx:surface`.
3. **End-to-End Verification**:
   - Compile `triangle.zena` with `zena-cli build --target component`.
   - Run the emitted component with `zfx`.
