//! Rust mirrors of the records `zenafx:host` and `zenafx:ui/style` declare.
//!
//! These are hand-written rather than generated, because the loader binds
//! imports itself (see §6.2 of `docs/design/zenafx-ui.md`) and so never gets
//! a `bindgen!` world to lift them out of. Each type here corresponds one for
//! one to a record in `packages/zenafx/wit/zenafx.wit`; the canonical-ABI
//! conversion happens where the host functions are registered.
//!
//! The `ComponentType` derive names a field or case after its Rust
//! identifier verbatim, so every name WIT spells with a hyphen carries an
//! explicit `#[component(name = ...)]`. A mismatch is caught when the
//! linker typechecks the import against the component, not at runtime.

use wasmtime::component::{ComponentType, Lift, Lower};

/// Non-premultiplied sRGB, each channel 0..1.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const fn rgb(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: 1.0 }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, Default, ComponentType, Lift, Lower)]
#[component(record)]
pub struct BoxLook {
    pub background: Option<Color>,
    #[component(name = "border-color")]
    pub border_color: Option<Color>,
    #[component(name = "border-width")]
    pub border_width: f32,
    #[component(name = "corner-radius")]
    pub corner_radius: f32,
    pub opacity: f32,
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct TextLook {
    pub family: String,
    pub size: f32,
    pub weight: u16,
    pub italic: bool,
    pub color: Color,
}

impl Default for TextLook {
    fn default() -> Self {
        Self {
            family: "system-ui".to_owned(),
            size: 16.0,
            weight: 400,
            italic: false,
            color: Color::rgb(0.0, 0.0, 0.0),
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Length {
    #[component(name = "auto")]
    Auto,
    #[component(name = "px")]
    Px(f32),
    #[component(name = "percent")]
    Percent(f32),
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum Axis {
    #[component(name = "row")]
    Row,
    #[default]
    #[component(name = "column")]
    Column,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum Justify {
    #[default]
    #[component(name = "start")]
    Start,
    #[component(name = "center")]
    Center,
    #[component(name = "end")]
    End,
    #[component(name = "space-between")]
    SpaceBetween,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum Align {
    #[default]
    #[component(name = "start")]
    Start,
    #[component(name = "center")]
    Center,
    #[component(name = "end")]
    End,
    #[component(name = "stretch")]
    Stretch,
}

#[derive(Copy, Clone, Debug, PartialEq, Default, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Edges {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl Edges {
    pub const fn all(v: f32) -> Self {
        Self {
            top: v,
            right: v,
            bottom: v,
            left: v,
        }
    }
}

/// Geometry only. Nothing here affects painting, and nothing in a look
/// affects measurement.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Flex {
    pub axis: Axis,
    #[component(name = "justify-content")]
    pub justify_content: Justify,
    #[component(name = "align-items")]
    pub align_items: Align,
    pub gap: f32,
    pub padding: Edges,
    pub width: Length,
    pub height: Length,
    pub grow: f32,
    pub shrink: f32,
}

impl Default for Flex {
    fn default() -> Self {
        Self {
            axis: Axis::Column,
            justify_content: Justify::Start,
            align_items: Align::Start,
            gap: 0.0,
            padding: Edges::default(),
            width: Length::Auto,
            height: Length::Auto,
            grow: 0.0,
            // CSS's default, and taffy's: a flex item may shrink below its
            // basis before it overflows.
            shrink: 1.0,
        }
    }
}

/// What a shaped run occupies at some width.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Measured {
    pub width: f32,
    pub height: f32,
    /// Distance from the top of the run to the first line's baseline.
    pub baseline: f32,
}

/// The space a solve offers on one axis.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Available {
    #[component(name = "definite")]
    Definite(f32),
    #[component(name = "min-content")]
    MinContent,
    #[component(name = "max-content")]
    MaxContent,
}

/// One question a solve asks about a leaf.
///
/// Layout is a recursive query rather than one pass down and one pass up: a
/// leaf is asked several times per solve, and which questions it gets depend
/// on the styles above it. A `known` dimension is one the parent has already
/// fixed, and the solve is asking what the other becomes at that size.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct MeasureRequest {
    #[component(name = "known-width")]
    pub known_width: Option<f32>,
    #[component(name = "known-height")]
    pub known_height: Option<f32>,
    #[component(name = "available-width")]
    pub available_width: Available,
    #[component(name = "available-height")]
    pub available_height: Available,
}

/// What a leaf holds.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Content {
    /// Sized by its own style and its children.
    #[component(name = "box")]
    Box,
    /// A run registered with the text engine.
    #[component(name = "text")]
    Text(u32),
}

/// One node of a tree given in pre-order. Index 0 is the root; a node's
/// children are the `child_count` entries starting at `first_child`.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Node {
    pub style: Flex,
    pub content: Content,
    #[component(name = "first-child")]
    pub first_child: u32,
    #[component(name = "child-count")]
    pub child_count: u32,
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Quad {
    pub bounds: Rect,
    pub background: Option<Color>,
    #[component(name = "border-color")]
    pub border_color: Option<Color>,
    #[component(name = "border-width")]
    pub border_width: f32,
    #[component(name = "corner-radius")]
    pub corner_radius: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Glyphs {
    pub run: u32,
    pub x: f32,
    pub y: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Command {
    #[component(name = "quad")]
    Quad(Quad),
    #[component(name = "glyphs")]
    Glyphs(Glyphs),
    #[component(name = "push-clip")]
    PushClip(Rect),
    #[component(name = "pop-clip")]
    PopClip,
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct FrameEvent {
    /// Milliseconds on a monotonic clock since the window opened.
    #[component(name = "time-ms")]
    pub time_ms: f64,
    pub width: u32,
    pub height: u32,
    /// Physical pixels per logical pixel.
    pub scale: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct PointerEvent {
    pub x: f32,
    pub y: f32,
    pub button: u8,
    pub down: bool,
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct KeyEvent {
    pub code: u32,
    pub down: bool,
    pub text: String,
}
