# zenafx-render

Platform-independent rendering engine for ZenaFX: retained scene graph, flexbox layout (`taffy`), text shaping (`parley`), and 2D vector/glyph rasterization (`vello_cpu`).

This crate is the shared upper half of the ZenaFX host:

- Compiled natively with `features = ["wasmtime", "system-fonts"]` into `packages/zenafx` (`zfx`).
- Compiled to `wasm32-unknown-unknown` with `default-features = false` into `packages/zenafx-web/engine` for running ZenaFX in the browser.
