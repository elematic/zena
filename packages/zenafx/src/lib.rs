//! `zenafx`: the graphical runtime for Zena WebAssembly components.
//!
//! The binary is `zfx` (`src/main.rs`). This library holds the parts worth
//! testing on their own — currently the host primitives in [`ui`].

pub mod loader;
pub mod ui;
