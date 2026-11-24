# zenafx-web

Prototype web runner for **ZenaFX**: runs the exact same unmodified `.wasm`
ZenaFX application components (`widgets.wasm`, `button.wasm`, `counter.wasm`,
`scroll.wasm`) in a browser or Node.js v26+.

## Architecture

ZenaFX's Rust host is split into two layers:

1. **Shared rendering layer (`packages/zenafx-render`)**: platform-independent
   Rust crate holding the retained scene graph (`Scene`), flexbox solver
   (`taffy`), text shaper (`parley`), and 2D vector/glyph rasterizer
   (`vello_cpu`).
   - Compiled natively with `features = ["wasmtime", "system-fonts"]` into
     `packages/zenafx` (`zfx`).
   - Compiled to `wasm32-unknown-unknown` with `default-features = false` into
     `packages/zenafx-web/engine` (`out/zenafx_web_engine.wasm`, ~2.5 MB raw /
     ~880 KB gzipped).
2. **Web bottom layer (`packages/zenafx-web/src/`)**:
   - `component-parser.js` — runtime parser for WebAssembly Component Model
     binaries (extracts embedded `zena:runtime` and app WasmGC core modules with
     no ahead-of-time transpilation).
   - `cabi.js` — Component Model Canonical ABI reader/writer for `zenafx:host`
     records, variants, and `stream<delivery>` items.
   - `engine-bridge.js` — typed wrapper around `zenafx_web_engine.wasm`.
   - `component-runner.js` — runtime Component Model Async host (`canon`
     waitable sets, subtasks, wake futures, `stream<delivery>`, resource drops,
     `wasi:clocks/monotonic-clock@0.3.0`) with fresh per-instance capability
     imports and sequential propagation-aware event delivery.
   - `surface.js` — browser `<canvas>` surface with demand-driven
     `requestAnimationFrame` redraw (idle = 0 frames, matching native
     `ControlFlow::Wait`), `ResizeObserver` + `devicePixelRatio`, pointer/wheel
     input, and both **Canvas 2D** (`putImageData`) and **WebGPU**
     (`writeTexture` + fullscreen WGSL blit) presenters.

## Quick start

```bash
# Build the wasm32 rendering engine and all ZenaFX example components, and run the tests
./target/release/zena run ./packages/zenafx-web:test

# Start the interactive web demo server (http://127.0.0.1:8787)
./target/release/zena run ./packages/zenafx-web:demo
```

Open `http://127.0.0.1:8787` in a browser with WebAssembly GC support (Chrome,
Firefox, Safari) to switch between `button`, `widgets`, `counter`, `scroll`, the
built-in Rust `hello` demo, or load any local `.wasm` ZenaFX component file.

## Alignment with upcoming ZenaFX branches

This prototype targets `main` while aligning with the in-flight ZenaFX branches:

- **`zenafx-host-holds-tree`**: The retained scene tree lives in
  `zenafx-render::scene::Scene`, so native and web both solve, clip, scroll, and
  hover without re-entering guest components.
- **`zenafx-styles-design`**: Host-side fact/condition evaluation belongs in
  `zenafx-render::scene`, so both native and web inherit conditional styles
  automatically.
- **`zenafx-selection` (pointer capture, keyboard focus, text input, selection,
  clipboard)**:
  - Pointer capture, focus routing, caret/selection geometry, and `listen-keys`
    are pure `zenafx-render` logic and compile directly to `wasm32`.
  - The platform `Clipboard` trait maps to `arboard` natively and
    `navigator.clipboard` (with in-memory fallback) on the web.
  - `key-event` already uses W3C `KeyboardEvent.key` / `KeyboardEvent.code`
    names, mapping 1:1 from DOM `keydown`/`keyup`.
  - Cursor hints map directly to `canvas.style.cursor`.
- **Future web platform integration**: Because `zenafx-render` cleanly separates
  the scene graph from rasterization, a future web backend can project
  text/interactive nodes into a parallel DOM/ARIA accessibility tree or swap the
  rasterizer without changing guest components.
