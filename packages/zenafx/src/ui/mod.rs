//! The ZenaFX host primitives: the Rust side of `zenafx:host`.
//!
//! Four interfaces, one module each — [`text`] shapes and measures runs,
//! [`layout`] solves flexbox with those measurements inside the solve,
//! [`paint`] rasterizes a display list, and [`surface`] owns the window and
//! decides when a frame happens. [`types`] holds the records they exchange.
//!
//! Nothing here knows about WebAssembly. The loader binds these to a guest's
//! imports; until it exists, [`demo`] drives them directly, which is how the
//! stack is exercised without a component.
//!
//! Designed in `docs/design/zenafx-ui.md` §8.

pub mod demo;
pub mod layout;
pub mod paint;
pub mod scene;
pub mod surface;
pub mod text;
pub mod types;
