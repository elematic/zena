# ZenaFX Platform Component and Native Core Split

## Status

Proposal, with Steps A1–A3 implemented:

- **Step A1 (done):** `packages/zenafx/wit/deps/core/core.wit` defines the
  self-contained `zenafx:core@0.1.0` native-core WIT package (`render`), and
  `packages/zenafx-render/src/core.rs` implements `RenderCore` over a flat,
  slot-free, template-free render tree.
- **Step A2 (done):** `packages/zenafx-platform/` implements the Zena platform
  component (`packages/zenafx/wit/deps/platform/platform.wit`,
  `zenafx:platform@0.1.0` over `zenafx:core/render@0.1.0`) covering templates,
  holes, slots, detached nodes, inherited `cursor`/`unselectable`, stopgap
  `state-style` restyling, and logical event routing, driven in Wasmtime by
  `packages/zenafx/src/loader/platform.rs` and tested end-to-end in
  `packages/zenafx/tests/platform.rs`.
- **Step A3 (done):** `GuestScene` (`packages/zenafx/src/loader/`) routes all
  app and widget components through the Zena platform component into
  `RenderCore`, `packages/zenafx/build.rs` supports `--features bundled`
  embedding of `out/platform.wasm`, and `zfx --platform <FILE>` allows testing
  an upgraded platform component independently of the native binary.
  (`packages/zenafx-render/src/scene.rs` remains temporarily for `zenafx-web`
  until the browser runtime migrates to `RenderCore` + `platform.wasm`.)

## Overview

In the prototype described in [zenafx-ui.md](./zenafx-ui.md), the Rust crate
`packages/zenafx-render` holds both the low-level rendering primitives (`taffy`
layout, `parley` text shaping, `vello_cpu` rasterization, hit testing,
scrolling, selection) and the higher-level UI scene semantics (templates,
bindings, holes, slots, detached nodes, state styles, and widget event
routing). Keeping all of those in the native binary couples UI features to
native binary releases: adding a style rule engine, multi-slot projection, or
better style caches requires shipping a new `zfx` binary.

Splitting ZenaFX into three layers keeps the native binary small and stable
while letting the UI layer evolve independently in WebAssembly:

```
+------------------------------------------------------------------------+
|  App & widget components (user-authored, loaded on the fly, any lang)  |
|  - Own worker thread(s), widget state, signals, event handlers         |
+------------------------------------------------------------------------+
                          | zenafx:platform/scene@X
                          v
+------------------------------------------------------------------------+
|  Platform component (Zena/Wasm, bundled with zfx, versioned/upgraded)  |
|  - Synchronous window-thread store (never blocks on widget threads)    |
|  - Templates, holes, slots (incl. future multi-slot projection)        |
|  - All styling: built-in & custom properties, inheritance, defaults,   |
|    facts, stylesheets, rules, `borrow<style-node>`, caches             |
|  - Logical event routing over slots and widget scopes                  |
+------------------------------------------------------------------------+
                          | zenafx:core/render@0.1.0
                          v
+------------------------------------------------------------------------+
|  Native core (`zfx` / `zenafx-render`, Rust)                           |
|  - `winit` loop, `taffy` layout, `parley` text, `vello` paint          |
|  - Flat retained render tree: boxes, text runs, resolved built-ins     |
|  - Hit testing, scroll offsets, focus order, caret & text selection    |
|  - Per-node `watch-flags` bitmask gating notifications to platform     |
+------------------------------------------------------------------------+
```

## Division of responsibilities

| Concern                   | Native core (`zenafx:core`)                                                                                                   | Platform component (`zenafx:platform`)                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tree topology             | Flat boxes and text runs (`set-children`)                                                                                     | Logical widget tree, templates, holes, slots, detached nodes, future multi-slot projection                                                               |
| Properties and styling    | Flat resolved built-ins (`box`, `layout`, `style`, `cursor`, `focusable`, `editable`, `unselectable`)                         | Built-in and custom property definitions, inheritance, defaults, facts, stylesheets, rules, window-component predicates, style caches                    |
| Layout, text, paint       | `taffy`, `parley`, `vello_cpu` / `vello`, clips, scrollbars                                                                   | Receives size/scroll notifications only for watched nodes                                                                                                |
| Pointer, focus, selection | Hit testing, wheel scroll, pointer capture, caret/selection drawing, word/line selection, clipboard copy, Tab focus traversal | Logical ancestor walks across slots, `hovered`/`pressed`/`focused` propagation, listener matching (`enter`/`leave`/`intercept`/`bubble`), delivery plans |

Two design rules follow from this split:

1. **The native core knows nothing about slots.** Slots are a composition,
   styling, and event concept in the platform component. When slot contents
   change, the platform component flattens the concrete child list of the
   enclosing box and emits a single `set-children` op to the native core.
   Future multi-slot projection (such as rendering one dropdown option in both
   a selected display and a popup list) maps one logical element to two render
   nodes in the platform component without changing the native core.
2. **All property resolution happens in one place.** Built-in and custom
   properties share the same inheritance, default-priority, and rule engine in
   the platform component. The native core receives only the final resolved
   built-in layout and paint values.

## The `zenafx:core@0.1.0` interface

`packages/zenafx/wit/deps/core/core.wit` defines `zenafx:core@0.1.0` as a
self-contained package with no upward imports from `zenafx:ui` or
`zenafx:platform`, so platform components of different versions can target the
same core ABI.

### Batched tree and style writes

Render node IDs are `u32` values chosen by the platform component, so creating
a subtree, assigning children, and setting resolved styles all travel in a
single `apply(ops: list<render-op>)` call with no allocation round-trips:

- `create(id, def)`: allocate a flat render node with resolved `box`, `layout`,
  `style` (`nothing`, `fill`, or `text`), `cursor`, `focusable`, `editable`,
  `unselectable`, and `watch-flags`.
- `remove(id)`: free a render node and release its shaped `parley` run (and
  clear hover/press/focus/selection references if they pointed at it).
- `set-root(option<u32>)`: set or clear the root render node.
- `set-children(parent, list<u32>)`: replace the flat concrete child list of
  `parent` (and reflow a `flow` container when its text children change).
- Fine-grained property patches: `set-box`, `set-layout`, `set-style`,
  `set-content`, `set-text-style`, `set-cursor`, `set-interaction`,
  `set-watched`.

Imperative host-state helpers stay small: `selection(id)`, `select(id, to)`,
`capture-pointer(option<u32>)`, and `focus(option<u32>)`.

### Watched notifications and WIT crossing budget

Every render node carries a `watch-flags` bitmask (`hovered`, `pressed`,
`focused`, `size`, `scroll`). The native core uses it to keep idle and
unwatched frames inside Rust:

- **Pointer moves over unwatched nodes:** Rust hit-tests locally. If the hit
  render node did not change, or if no node on the old or new render ancestor
  chain sets `hovered`, the native core makes zero calls into the platform
  component.
- **Watched hover, press, or focus transitions:** When a target changes and an
  ancestor sets the matching watch bit, the native core sends one batched
  event (`hover-target`, `press-target`, or `focus-target`) carrying the new
  render node ID. The platform component walks its logical ancestor chain
  (slots included), evaluates style rules, and calls `core.apply(ops)` once
  with the resolved style diffs.
- **Resize:** Rust runs `taffy` locally, checks only render nodes with `size`
  watched whose solved `(width, height)` changed, and emits one batched
  `sizes-changed` event. If no condition flips, the platform component sends no
  ops and Rust paints immediately.
- **Scroll:** Rust updates scroll offsets and clamps them locally. If no
  changed scroller sets `scroll`, zero WIT calls occur; otherwise one batched
  `scroll-changed` event notifies the platform component.

## Threading and locking model

App and widget components run on worker thread(s) inside Wasmtime's
`Store::run_concurrent` so timers, network fetches, and event streams never
block the window thread (see `packages/zenafx/src/loader/mod.rs`).

The platform component is never parked in `run_concurrent`. Its `Store` is
entered only for short, synchronous, bounded calls behind an
`Arc<Mutex<PlatformRuntime>>`, mirroring how `UiHostState` already guards
`Arc<Mutex<Scene>>`:

- When a widget component calls `node.render(...)` or `node.set-slot(...)` from
  its worker thread, the loader trampoline locks `PlatformRuntime`, runs the
  platform export (which updates the logical scene/style state and flushes
  `render-op`s into `RenderCore`), releases the lock, and wakes the window.
- When the window thread handles a watched hover, resize, scroll, or input
  event, it locks `PlatformRuntime` briefly, runs the synchronous platform
  hook, and proceeds with layout and paint.

Because a widget component never holds the platform lock while executing its
own code or awaiting I/O, a slow or stuck widget cannot freeze hover feedback,
scrolling, or resizing. The same synchronous model works without modification
in headless `cargo test` suites (no `winit` event loop) and in single-threaded
browser execution (`packages/zenafx-web`).

## Bundling and versioning

`zfx` bundles a default compiled `platform.wasm` component (with a CLI override
such as `--platform <path>` for development and testing).

- An app declares the platform component version it targets. If `zfx` bundles a
  compatible platform component it instantiates it directly; otherwise the
  loader can fetch a matching platform component by version/URL.
- Each platform component imports a specific `zenafx:core/render@X.Y.Z`
  version. WIT package imports express exact semver versions (matched by the
  linker under semver compatibility) rather than arbitrary version ranges;
  resolving wider platform/core compatibility ranges belongs in the app
  manifest and loader metadata.

## Incremental migration

1. **Step A1 (`core.wit` and `RenderCore`):** Define `zenafx:core@0.1.0` in
   `packages/zenafx/wit/deps/core/core.wit` and implement `RenderCore` in
   `packages/zenafx-render/src/core.rs` with unit tests covering batched ops,
   flex/flow layout, hit testing, scrolling, selection, focus, and
   `watch-flags` event emission. Existing `scene.rs` and tests stay unchanged.
2. **Step A2 (`packages/zenafx-platform/`):** Implement the Zena platform
   component importing `zenafx:core/render@0.1.0` and serving templates, holes,
   slots, stopgap `state-style` restyling, and logical event routing. Verify
   with Wasmtime integration tests against `RenderCore`.
3. **Step A3 (Loader switchover and cleanup):** Bundle `platform.wasm` into
   `packages/zenafx`, switch `GuestScene` to route widget components through
   the platform component into `RenderCore`, verify all existing `zfx` and
   `zenafx-web` tests pass, and retire `packages/zenafx-render/src/scene.rs`.
   The full style engine from [zenafx-styles.md](./zenafx-styles.md) is then
   built directly in `packages/zenafx-platform/`.
