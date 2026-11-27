//! Platform-independent ZenaFX rendering engine.
//!
//! This crate holds the upper half of the ZenaFX host — everything above the
//! platform window/event loop and WebAssembly component runtime:
//!
//! - [`types`] — Rust mirrors of the `zenafx:ui` and `zenafx:host` WIT types
//! - [`events`] — pointer input, listener registrations, and delivery plans
//! - [`text`] — shaped text runs backed by [`parley`]
//! - [`layout`] — flexbox layout backed by [`taffy`] with mid-solve text measurement
//! - [`scene`] — the retained template/slot/hole tree, state styles, scrolling, and hit testing
//! - [`paint`] — 2D vector and glyph rasterization backed by [`vello_cpu`]
//! - [`demo`] — built-in Rust demo scene for testing without a guest component
//!
//! It compiles both natively (linked into `zfx` with the `wasmtime` and
//! `system-fonts` features) and to `wasm32-unknown-unknown` (linked into
//! `packages/zenafx-web` for running ZenaFX in the browser).

pub mod core;
pub mod demo;
pub mod events;
pub mod layout;
pub mod paint;
pub mod scene;
pub mod text;
pub mod types;
