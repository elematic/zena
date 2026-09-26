//! Rust mirrors of the records `zenafx:host` and `zenafx:ui/style` declare.
//!
//! These are hand-written rather than generated, because the loader binds
//! imports itself (see §6.2 of `docs/design/zenafx-ui.md`) and so never gets
//! a `bindgen!` world to lift them out of. Each type here corresponds one for
//! one to a record in `packages/zenafx/wit/zenafx.wit`; the canonical-ABI
//! conversion happens where the host functions are registered.

/// Non-premultiplied sRGB, each channel 0..1.
#[derive(Copy, Clone, Debug, PartialEq)]
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

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, Default)]
pub struct BoxLook {
    pub background: Option<Color>,
    pub border_color: Option<Color>,
    pub border_width: f32,
    pub corner_radius: f32,
    pub opacity: f32,
}

#[derive(Clone, Debug, PartialEq)]
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

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Length {
    Auto,
    Px(f32),
    Percent(f32),
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum Axis {
    Row,
    #[default]
    Column,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum Justify {
    #[default]
    Start,
    Center,
    End,
    SpaceBetween,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Copy, Clone, Debug, PartialEq, Default)]
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
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Flex {
    pub axis: Axis,
    pub justify_content: Justify,
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
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Measured {
    pub width: f32,
    pub height: f32,
    /// Distance from the top of the run to the first line's baseline.
    pub baseline: f32,
}

/// One node of a tree given in pre-order. Index 0 is the root; a node's
/// children are the `child_count` entries starting at `first_child`.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub style: Flex,
    /// A run registered with the text engine, measured during the solve.
    /// `None` for a box.
    pub run: Option<u32>,
    pub first_child: u32,
    pub child_count: u32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Quad {
    pub bounds: Rect,
    pub background: Option<Color>,
    pub border_color: Option<Color>,
    pub border_width: f32,
    pub corner_radius: f32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Glyphs {
    pub run: u32,
    pub x: f32,
    pub y: f32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Command {
    Quad(Quad),
    Glyphs(Glyphs),
    PushClip(Rect),
    PopClip,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct FrameEvent {
    /// Milliseconds on a monotonic clock since the window opened.
    pub time_ms: f64,
    pub width: u32,
    pub height: u32,
    /// Physical pixels per logical pixel.
    pub scale: f32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PointerEvent {
    pub x: f32,
    pub y: f32,
    pub button: u8,
    pub down: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeyEvent {
    pub code: u32,
    pub down: bool,
    pub text: String,
}
