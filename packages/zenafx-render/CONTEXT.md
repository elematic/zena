# zenafx-render Context

Platform-independent rendering layer split out of `packages/zenafx` so the same retained scene, `taffy` layout solver, `parley` text shaper, and `vello_cpu` rasterizer compile both natively (for `zfx`) and to `wasm32-unknown-unknown` (for `packages/zenafx-web`).

## Cargo features

- `default = []`: Zero OS/wasmtime dependencies; compiles on `wasm32-unknown-unknown`. Fonts are registered explicitly via `TextEngine::register_font`.
- `system-fonts`: Enables `parley/system` for OS font discovery (fontconfig, CoreText, DirectWrite).
- `wasmtime`: Derives `wasmtime::component::{ComponentType, Lift, Lower}` on the WIT types in `types`, `events`, and `scene`.

## Rules

- Keep this crate free of `winit`, `softbuffer`, `tokio`, `arboard`, or unconditional `wasmtime` dependencies so `wasm32-unknown-unknown` always builds.
- Do not add `workspace-hack` to `packages/zenafx-render/Cargo.toml` — `workspace-hack` pulls in native-only wasmtime crates.
