//! Flat native render core (`zenafx:core/render@0.1.0`).
//!
//! `RenderCore` is the Rust bottom layer of the three-layer ZenaFX stack
//! (`docs/design/zenafx-platform-core.md`). It holds a flat retained render
//! tree of boxes and text runs with already-resolved built-in layout and paint
//! properties, and owns layout (`taffy`), text shaping (`parley`), raster
//! command generation, hit testing, scrolling, focus order, and text
//! selection.
//!
//! It knows nothing about slots, templates, holes, custom properties,
//! inheritance, stylesheets, or style rules — those live in the WebAssembly
//! platform component above it, which drives `RenderCore` through batched
//! [`RenderOp`]s and receives [`CoreEvent`] notifications only for nodes whose
//! [`WatchFlags`] request them.

use std::collections::HashMap;

#[cfg(feature = "wasmtime")]
use wasmtime::component::{ComponentType, Lift, Lower};

use super::events::{KeyEvent, PointerInput};
use super::layout::{Placed, measure_text, place_with};
use super::scene::{Cursor, NodeStyle, TextSelection};
use super::text::TextEngine;
use super::types::{
    Color, Command, Content, Flex, Glyphs, Layout, Measured, Node as FlatNode, Overflow, OwnBox,
    Quad, Rect, Size, TextStyle,
};

/// Scrollbar thumb geometry and colours, matching `scene.rs`.
const THUMB_WIDTH: f32 = 6.0;
const THUMB_INSET: f32 = 3.0;
const THUMB: Color = Color {
    r: 0.0,
    g: 0.0,
    b: 0.0,
    a: 0.28,
};
const CARET_WIDTH: f32 = 1.5;
const SELECTION: Color = Color {
    r: 0.25,
    g: 0.52,
    b: 0.96,
    a: 0.28,
};
const PRESS_AGAIN_WITHIN_MS: f64 = 500.0;
const PRESS_AGAIN_NEAR: f32 = 4.0;

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    0.0
}

// Which host-driven state transitions on a render node should emit a
// `CoreEvent` to the platform component.
#[cfg(feature = "wasmtime")]
wasmtime::component::flags! {
    WatchFlags {
        #[component(name = "hovered")]
        const HOVERED;
        #[component(name = "pressed")]
        const PRESSED;
        #[component(name = "focused")]
        const FOCUSED;
        #[component(name = "size")]
        const SIZE;
        #[component(name = "scroll")]
        const SCROLL;
    }
}

/// Non-wasmtime mirror of [`WatchFlags`] for `wasm32` / browser builds.
#[cfg(not(feature = "wasmtime"))]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchFlags(u8);

#[cfg(not(feature = "wasmtime"))]
impl WatchFlags {
    pub const HOVERED: Self = Self(1 << 0);
    pub const PRESSED: Self = Self(1 << 1);
    pub const FOCUSED: Self = Self(1 << 2);
    pub const SIZE: Self = Self(1 << 3);
    pub const SCROLL: Self = Self(1 << 4);

    pub const fn empty() -> Self {
        Self(0)
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }
}

#[cfg(not(feature = "wasmtime"))]
impl std::ops::BitOr for WatchFlags {
    type Output = Self;
    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

#[cfg(not(feature = "wasmtime"))]
impl std::ops::BitOrAssign for WatchFlags {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

/// Initial resolved definition of a flat render node.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct RenderNodeDef {
    #[cfg_attr(feature = "wasmtime", component(name = "box"))]
    pub own_box: OwnBox,
    pub layout: Layout,
    pub style: NodeStyle,
    pub cursor: Cursor,
    pub focusable: bool,
    pub editable: bool,
    pub unselectable: bool,
    pub watched: WatchFlags,
}

impl Default for RenderNodeDef {
    fn default() -> Self {
        Self {
            own_box: OwnBox::default(),
            layout: Layout::default(),
            style: NodeStyle::Nothing,
            cursor: Cursor::Default,
            focusable: false,
            editable: false,
            unselectable: false,
            watched: WatchFlags::empty(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct CreateOp {
    pub id: u32,
    pub def: RenderNodeDef,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct ChildrenOp {
    pub parent: u32,
    pub children: Vec<u32>,
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct BoxOp {
    pub id: u32,
    #[cfg_attr(feature = "wasmtime", component(name = "box"))]
    pub own_box: OwnBox,
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct LayoutOp {
    pub id: u32,
    pub layout: Layout,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct StyleOp {
    pub id: u32,
    pub style: NodeStyle,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct ContentOp {
    pub id: u32,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct TextStyleOp {
    pub id: u32,
    pub style: TextStyle,
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct CursorOp {
    pub id: u32,
    pub cursor: Cursor,
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct InteractionOp {
    pub id: u32,
    pub focusable: bool,
    pub editable: bool,
    pub unselectable: bool,
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct WatchedOp {
    pub id: u32,
    pub watched: WatchFlags,
}

/// One flat render-tree mutation sent from the platform component.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(variant))]
pub enum RenderOp {
    #[cfg_attr(feature = "wasmtime", component(name = "create"))]
    Create(CreateOp),
    #[cfg_attr(feature = "wasmtime", component(name = "remove"))]
    Remove(u32),
    #[cfg_attr(feature = "wasmtime", component(name = "set-root"))]
    SetRoot(Option<u32>),
    #[cfg_attr(feature = "wasmtime", component(name = "set-children"))]
    SetChildren(ChildrenOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-box"))]
    SetBox(BoxOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-layout"))]
    SetLayout(LayoutOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-style"))]
    SetStyle(StyleOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-content"))]
    SetContent(ContentOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-text-style"))]
    SetTextStyle(TextStyleOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-cursor"))]
    SetCursor(CursorOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-interaction"))]
    SetInteraction(InteractionOp),
    #[cfg_attr(feature = "wasmtime", component(name = "set-watched"))]
    SetWatched(WatchedOp),
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct NodeSize {
    pub id: u32,
    pub width: f32,
    pub height: f32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(record))]
pub struct NodeScroll {
    pub id: u32,
    #[cfg_attr(feature = "wasmtime", component(name = "scroll-x"))]
    pub scroll_x: f32,
    #[cfg_attr(feature = "wasmtime", component(name = "scroll-y"))]
    pub scroll_y: f32,
    #[cfg_attr(feature = "wasmtime", component(name = "reach-x"))]
    pub reach_x: f32,
    #[cfg_attr(feature = "wasmtime", component(name = "reach-y"))]
    pub reach_y: f32,
}

/// Batched host-state notification emitted by [`RenderCore`] back to the
/// platform component when watched states change.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "wasmtime", derive(ComponentType, Lift, Lower))]
#[cfg_attr(feature = "wasmtime", component(variant))]
pub enum CoreEvent {
    #[cfg_attr(feature = "wasmtime", component(name = "hover-target"))]
    HoverTarget(Option<u32>),
    #[cfg_attr(feature = "wasmtime", component(name = "press-target"))]
    PressTarget(Option<u32>),
    #[cfg_attr(feature = "wasmtime", component(name = "focus-target"))]
    FocusTarget(Option<u32>),
    #[cfg_attr(feature = "wasmtime", component(name = "sizes-changed"))]
    SizesChanged(Vec<NodeSize>),
    #[cfg_attr(feature = "wasmtime", component(name = "scroll-changed"))]
    ScrollChanged(Vec<NodeScroll>),
}

/// Outcome of processing a pointer input in [`RenderCore`].
#[derive(Clone, Debug, PartialEq)]
pub struct PointerOutcome {
    /// Hit render node under the pointer (or the captured node while captured).
    pub target: Option<u32>,
    /// Whether the native core changed something that requires a redraw
    /// (scrolling or selection).
    pub needs_redraw: bool,
    /// Watched state transitions to forward to the platform component.
    pub events: Vec<CoreEvent>,
}

struct Solved {
    available: Size,
    scale: f32,
    placed: Vec<Placed>,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum Selecting {
    Field(u32),
    Window,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct Place {
    node: u32,
    index: u32,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct Selected {
    anchor: Place,
    focus: Place,
}

#[derive(Copy, Clone, Debug)]
struct Press {
    at_ms: f64,
    x: f32,
    y: f32,
    count: u8,
}

struct RenderNode {
    own_box: OwnBox,
    layout: Layout,
    style: NodeStyle,
    run: Option<u32>,
    children: Vec<u32>,
    parent: Option<u32>,
    cursor: Cursor,
    focusable: bool,
    editable: bool,
    unselectable: bool,
    watched: WatchFlags,
    scroll: (f32, f32),
    spilled: bool,
    joined: String,
    /// Last reported size for `WatchFlags::SIZE` change detection.
    last_size: Option<(f32, f32)>,
    /// Last reported scroll/reach for `WatchFlags::SCROLL` change detection.
    last_scroll: Option<(f32, f32, f32, f32)>,
}

impl RenderNode {
    fn from_def(def: RenderNodeDef, run: Option<u32>) -> Self {
        Self {
            own_box: def.own_box,
            layout: def.layout,
            style: def.style,
            run,
            children: Vec::new(),
            parent: None,
            cursor: def.cursor,
            focusable: def.focusable,
            editable: def.editable,
            unselectable: def.unselectable,
            watched: def.watched,
            scroll: (0.0, 0.0),
            spilled: false,
            joined: String::new(),
            last_size: None,
            last_scroll: None,
        }
    }
}

/// Flat retained render tree owned by the native core.
#[derive(Default)]
pub struct RenderCore {
    nodes: HashMap<u32, RenderNode>,
    root: Option<u32>,
    pub dirty: bool,
    rects: HashMap<u32, Rect>,
    clips: HashMap<u32, Option<Rect>>,
    reaches: HashMap<u32, Size>,
    painted: Vec<u32>,
    hovered: Option<u32>,
    pressed: Option<u32>,
    captured: Option<u32>,
    focused: Option<u32>,
    pointer: (f32, f32),
    inside: bool,
    solved: Option<Solved>,
    unsolved: bool,
    pub solves: u32,
    selection: Option<Selected>,
    selecting: Option<Selecting>,
    selected_before: Option<Option<Selected>>,
    shift: bool,
    pressed_last: Option<Press>,
    reveal: bool,
    pending_events: Vec<CoreEvent>,
}

impl RenderCore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn root(&self) -> Option<u32> {
        self.root
    }

    pub fn hovered(&self) -> Option<u32> {
        self.hovered
    }

    pub fn pressed(&self) -> Option<u32> {
        self.pressed
    }

    pub fn focused(&self) -> Option<u32> {
        self.focused
    }

    pub fn captured(&self) -> Option<u32> {
        self.captured
    }

    pub fn bounds(&self, id: u32) -> Option<Rect> {
        self.rects.get(&id).copied()
    }

    /// Take watched-state notifications produced during the last `draw` or
    /// state change.
    pub fn take_events(&mut self) -> Vec<CoreEvent> {
        std::mem::take(&mut self.pending_events)
    }

    /// Apply a batch of flat render-tree mutations in order.
    pub fn apply(&mut self, ops: &[RenderOp], text: &mut TextEngine) {
        for op in ops {
            self.apply_one(op, text);
        }
    }

    fn apply_one(&mut self, op: &RenderOp, text: &mut TextEngine) {
        match op {
            RenderOp::Create(CreateOp { id, def }) => {
                // Replacing an existing id frees its previous text run first.
                if let Some(old) = self.nodes.remove(id)
                    && let Some(run) = old.run
                {
                    text.release_run(run);
                }
                let run = match &def.style {
                    NodeStyle::Text(tc) => Some(text.register_run(&tc.content, &tc.style)),
                    NodeStyle::Nothing | NodeStyle::Fill(_) => None,
                };
                self.nodes
                    .insert(*id, RenderNode::from_def(def.clone(), run));
                self.mark_unsolved();
            }
            RenderOp::Remove(id) => {
                let flow_parent = self.flow_above(*id);
                if let Some(node) = self.nodes.remove(id) {
                    if let Some(run) = node.run {
                        text.release_run(run);
                    }
                    // Detach from parent's child list if still referenced.
                    if let Some(parent_id) = node.parent
                        && let Some(parent) = self.nodes.get_mut(&parent_id)
                    {
                        parent.children.retain(|c| c != id);
                    }
                    // Clear parent pointers on former children.
                    for child in node.children {
                        if let Some(c) = self.nodes.get_mut(&child)
                            && c.parent == Some(*id)
                        {
                            c.parent = None;
                        }
                    }
                    if self.root == Some(*id) {
                        self.root = None;
                    }
                    self.rects.remove(id);
                    self.clips.remove(id);
                    self.reaches.remove(id);
                    self.forget_node(*id);
                    if let Some(container) = flow_parent {
                        self.reflow(container, text);
                    }
                    self.mark_unsolved();
                }
            }
            RenderOp::SetRoot(id) => {
                if self.root != *id {
                    self.root = *id;
                    self.mark_unsolved();
                }
            }
            RenderOp::SetChildren(ChildrenOp { parent, children }) => {
                let Some(old_children) = self
                    .nodes
                    .get_mut(parent)
                    .map(|p| std::mem::replace(&mut p.children, children.clone()))
                else {
                    return;
                };
                for old in old_children {
                    if let Some(node) = self.nodes.get_mut(&old)
                        && node.parent == Some(*parent)
                    {
                        node.parent = None;
                    }
                }
                for &child in children {
                    // If the child belonged to another parent, detach it there.
                    let prev_parent = self.nodes.get(&child).and_then(|n| n.parent);
                    if let Some(pp) = prev_parent
                        && pp != *parent
                        && let Some(old_p) = self.nodes.get_mut(&pp)
                    {
                        old_p.children.retain(|c| *c != child);
                    }
                    if let Some(node) = self.nodes.get_mut(&child) {
                        node.parent = Some(*parent);
                    }
                }
                let is_flow = self
                    .nodes
                    .get(parent)
                    .is_some_and(|p| p.layout.flow().is_some());
                if is_flow {
                    // Children of a flow container are shaped jointly on the
                    // container, not individually.
                    for &child in children {
                        if let Some(node) = self.nodes.get_mut(&child)
                            && let Some(run) = node.run.take()
                        {
                            text.release_run(run);
                        }
                    }
                    self.reflow(*parent, text);
                }
                self.mark_unsolved();
            }
            RenderOp::SetBox(BoxOp { id, own_box }) => {
                if let Some(node) = self.nodes.get_mut(id)
                    && node.own_box != *own_box
                {
                    node.own_box = *own_box;
                    self.mark_unsolved();
                }
            }
            RenderOp::SetLayout(LayoutOp { id, layout }) => {
                let was_flow = self
                    .nodes
                    .get(id)
                    .is_some_and(|n| n.layout.flow().is_some());
                let now_flow = layout.flow().is_some();
                if let Some(node) = self.nodes.get_mut(id) {
                    if node.layout == *layout {
                        return;
                    }
                    node.layout = *layout;
                } else {
                    return;
                }
                if now_flow {
                    let children = self.nodes.get(id).map(|n| n.children.clone()).unwrap_or_default();
                    for child in children {
                        if let Some(c) = self.nodes.get_mut(&child)
                            && let Some(run) = c.run.take()
                        {
                            text.release_run(run);
                        }
                    }
                    self.reflow(*id, text);
                } else if was_flow {
                    if let Some(node) = self.nodes.get_mut(id) {
                        if let Some(run) = node.run.take() {
                            text.release_run(run);
                        }
                        node.joined.clear();
                    }
                    let children = self.nodes.get(id).map(|n| n.children.clone()).unwrap_or_default();
                    for child in children {
                        if let Some(c) = self.nodes.get_mut(&child)
                            && c.run.is_none()
                            && let NodeStyle::Text(tc) = &c.style
                        {
                            c.run = Some(text.register_run(&tc.content, &tc.style));
                        }
                    }
                }
                self.mark_unsolved();
            }
            RenderOp::SetStyle(StyleOp { id, style }) => {
                let flow_parent = self.flow_above(*id);
                let Some(node) = self.nodes.get_mut(id) else {
                    return;
                };
                if node.style == *style {
                    return;
                }
                let prev_was_text = matches!(node.style, NodeStyle::Text(_));
                node.style = style.clone();
                if flow_parent.is_none() {
                    match &node.style {
                        NodeStyle::Text(tc) => {
                            if let Some(run) = node.run {
                                text.update_run(run, &tc.content, &tc.style);
                            } else {
                                node.run = Some(text.register_run(&tc.content, &tc.style));
                            }
                            self.mark_unsolved();
                        }
                        NodeStyle::Nothing | NodeStyle::Fill(_) => {
                            if let Some(run) = node.run.take() {
                                text.release_run(run);
                            }
                            if prev_was_text {
                                self.mark_unsolved();
                            } else {
                                // Pure fill/visual style change needs repaint only.
                                self.dirty = true;
                            }
                        }
                    }
                } else if let Some(container) = flow_parent {
                    self.reflow(container, text);
                    self.mark_unsolved();
                }
                self.keep_selection_in_text();
            }
            RenderOp::SetContent(ContentOp { id, content }) => {
                let flow_parent = self.flow_above(*id);
                let Some(node) = self.nodes.get_mut(id) else {
                    return;
                };
                if let NodeStyle::Text(tc) = &mut node.style {
                    if tc.content == *content {
                        return;
                    }
                    tc.content = content.clone();
                    if flow_parent.is_none() {
                        if let Some(run) = node.run {
                            text.update_run(run, &tc.content, &tc.style);
                        } else {
                            node.run = Some(text.register_run(&tc.content, &tc.style));
                        }
                    }
                } else {
                    return;
                }
                if let Some(container) = flow_parent {
                    self.reflow(container, text);
                }
                self.keep_selection_in_text();
                self.mark_unsolved();
            }
            RenderOp::SetTextStyle(TextStyleOp { id, style }) => {
                let flow_parent = self.flow_above(*id);
                let Some(node) = self.nodes.get_mut(id) else {
                    return;
                };
                if let NodeStyle::Text(tc) = &mut node.style {
                    if tc.style == *style {
                        return;
                    }
                    tc.style = style.clone();
                    if flow_parent.is_none() {
                        if let Some(run) = node.run {
                            text.update_run(run, &tc.content, &tc.style);
                        } else {
                            node.run = Some(text.register_run(&tc.content, &tc.style));
                        }
                    }
                } else {
                    return;
                }
                if let Some(container) = flow_parent {
                    self.reflow(container, text);
                }
                self.mark_unsolved();
            }
            RenderOp::SetCursor(CursorOp { id, cursor }) => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.cursor = *cursor;
                }
            }
            RenderOp::SetInteraction(InteractionOp {
                id,
                focusable,
                editable,
                unselectable,
            }) => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.focusable = *focusable;
                    node.editable = *editable;
                    node.unselectable = *unselectable;
                }
            }
            RenderOp::SetWatched(WatchedOp { id, watched }) => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.watched = *watched;
                    if !watched.contains(WatchFlags::SIZE) {
                        node.last_size = None;
                    }
                    if !watched.contains(WatchFlags::SCROLL) {
                        node.last_scroll = None;
                    }
                }
            }
        }
    }

    fn mark_unsolved(&mut self) {
        self.unsolved = true;
        self.dirty = true;
    }

    fn flow_above(&self, id: u32) -> Option<u32> {
        let parent = self.nodes.get(&id)?.parent?;
        self.nodes
            .get(&parent)?
            .layout
            .flow()
            .is_some()
            .then_some(parent)
    }

    fn reflow(&mut self, container: u32, text: &mut TextEngine) {
        let Some((flow, children, existing_run)) = self.nodes.get(&container).and_then(|n| {
            let flow = n.layout.flow()?;
            Some((flow, n.children.clone(), n.run))
        }) else {
            return;
        };
        let parts: Vec<(&str, &TextStyle)> = children
            .iter()
            .filter_map(|child| match &self.nodes.get(child)?.style {
                NodeStyle::Text(tc) => Some((tc.content.as_str(), &tc.style)),
                _ => None,
            })
            .collect();
        let joined: String = parts.iter().map(|(s, _)| *s).collect();
        let new_run = if parts.is_empty() {
            if let Some(run) = existing_run {
                text.release_run(run);
            }
            None
        } else if let Some(run) = existing_run {
            text.update_parts(run, &parts, &flow);
            Some(run)
        } else {
            Some(text.register_parts(&parts, &flow))
        };
        if let Some(node) = self.nodes.get_mut(&container) {
            node.run = new_run;
            node.joined = joined;
        }
    }

    fn forget_node(&mut self, gone: u32) {
        if self.hovered == Some(gone) {
            self.set_hover(None);
        }
        if self.pressed == Some(gone) {
            self.set_press(None);
        }
        if self.captured == Some(gone) {
            self.captured = None;
        }
        if self.focused == Some(gone) {
            self.set_focus(None);
        }
        if self
            .selection
            .is_some_and(|s| s.anchor.node == gone || s.focus.node == gone)
        {
            self.selection = None;
            self.selecting = None;
        }
    }

    /// Solve layout at `available` and return the display list.
    ///
    /// Also detects watched `SIZE` and `SCROLL` changes and hover changes
    /// caused by layout moving boxes under a stationary pointer, queueing them
    /// for [`RenderCore::take_events`].
    pub fn draw(&mut self, available: Size, text: &mut TextEngine) -> Vec<Command> {
        let Some(root) = self.root else {
            self.dirty = false;
            return Vec::new();
        };
        if !self.nodes.contains_key(&root) {
            self.dirty = false;
            return Vec::new();
        }

        // Flatten breadth-first for `place_with`.
        let mut order: Vec<u32> = vec![root];
        let mut children_of: Vec<Vec<u32>> = Vec::new();
        let mut i = 0;
        while i < order.len() {
            let id = order[i];
            let node = &self.nodes[&id];
            // A flow container shapes its text children jointly, so layout
            // treats the flow container itself as a text leaf.
            let children: Vec<u32> = if node.layout.flow().is_some() {
                Vec::new()
            } else {
                node.children
                    .iter()
                    .copied()
                    .filter(|c| self.nodes.contains_key(c))
                    .collect()
            };
            order.extend(children.iter().copied());
            children_of.push(children);
            i += 1;
        }

        let mut position_of: HashMap<u32, u32> = HashMap::with_capacity(order.len());
        for (idx, &id) in order.iter().enumerate() {
            position_of.insert(id, idx as u32);
        }

        let stands = !self.unsolved
            && self
                .solved
                .as_ref()
                .is_some_and(|s| s.available == available && s.scale == text.scale());
        if !stands {
            let flat: Vec<FlatNode> = order
                .iter()
                .zip(&children_of)
                .map(|(&id, children)| {
                    let node = &self.nodes[&id];
                    let first = children
                        .first()
                        .and_then(|c| position_of.get(c).copied())
                        .unwrap_or(0);
                    FlatNode {
                        own_box: node.own_box,
                        content: match (node.run, node.layout) {
                            (Some(run), _) => Content::Text(run),
                            (None, Layout::Flex(flex)) => Content::Box(flex),
                            (None, Layout::Flow(_)) => Content::Box(Flex::default()),
                        },
                        first_child: first,
                        child_count: children.len() as u32,
                    }
                })
                .collect();
            let placed = place_with(&flat, available, |content, query| match content {
                Content::Text(run) => measure_text(text, *run, query),
                _ => Measured {
                    width: 0.0,
                    height: 0.0,
                    baseline: 0.0,
                },
            });
            self.solved = Some(Solved {
                available,
                scale: text.scale(),
                placed,
            });
            self.unsolved = false;
            self.solves += 1;
        }
        let placed = self.solved.as_ref().expect("solved above").placed.clone();

        if std::mem::take(&mut self.reveal) {
            self.bring_caret_into_sight(&placed, &position_of, text);
        }

        let mut parent_of = vec![usize::MAX; order.len()];
        for (idx, children) in children_of.iter().enumerate() {
            for child in children {
                parent_of[position_of[child] as usize] = idx;
            }
        }

        let mut passed_down: Vec<((f32, f32), Option<Rect>)> = Vec::with_capacity(order.len());
        let mut rects: Vec<Rect> = Vec::with_capacity(order.len());
        let mut clips: Vec<Option<Rect>> = Vec::with_capacity(order.len());
        let mut size_changes: Vec<NodeSize> = Vec::new();
        let mut scroll_changes: Vec<NodeScroll> = Vec::new();

        for (idx, &id) in order.iter().enumerate() {
            let (shift, clip) = match parent_of[idx] {
                usize::MAX => ((0.0, 0.0), None),
                p => passed_down[p],
            };
            let Placed {
                rect: solved,
                reach,
            } = placed[idx];
            let rect = Rect {
                x: solved.x - shift.0,
                y: solved.y - shift.1,
                ..solved
            };
            let spills = children_of[idx]
                .iter()
                .any(|child| !contains(solved, placed[position_of[child] as usize].rect));
            let node = self.nodes.get_mut(&id).expect("live node");
            let (over_x, over_y) = (node.own_box.overflow_x, node.own_box.overflow_y);
            let expects_more = over_x != Overflow::Clip || over_y != Overflow::Clip;
            if spills && !expects_more && !node.spilled {
                log::warn!(
                    "content does not fit in render node {id} ({}x{}), and is cut off",
                    solved.width,
                    solved.height,
                );
            }
            node.spilled = spills && !expects_more;
            node.scroll = (
                within(node.scroll.0, reach.width, over_x),
                within(node.scroll.1, reach.height, over_y),
            );
            if node.watched.contains(WatchFlags::SIZE) {
                let sz = (solved.width, solved.height);
                if node.last_size != Some(sz) {
                    node.last_size = Some(sz);
                    size_changes.push(NodeSize {
                        id,
                        width: solved.width,
                        height: solved.height,
                    });
                }
            }
            if node.watched.contains(WatchFlags::SCROLL) {
                let sc = (node.scroll.0, node.scroll.1, reach.width, reach.height);
                if node.last_scroll != Some(sc) {
                    node.last_scroll = Some(sc);
                    scroll_changes.push(NodeScroll {
                        id,
                        scroll_x: node.scroll.0,
                        scroll_y: node.scroll.1,
                        reach_x: reach.width,
                        reach_y: reach.height,
                    });
                }
            }

            let inner_shift = (shift.0 + node.scroll.0, shift.1 + node.scroll.1);
            let border = match &node.style {
                NodeStyle::Fill(style) if style.border_color.is_some() => style.border_width,
                _ => 0.0,
            };
            let inside = Rect {
                x: rect.x + border,
                y: rect.y + border,
                width: (rect.width - 2.0 * border).max(0.0),
                height: (rect.height - 2.0 * border).max(0.0),
            };
            let inner_clip = cut(clip, inside, expects_more || spills);
            passed_down.push((inner_shift, inner_clip));
            rects.push(rect);
            clips.push(clip);
        }

        if !size_changes.is_empty() {
            self.pending_events
                .push(CoreEvent::SizesChanged(size_changes));
        }
        if !scroll_changes.is_empty() {
            self.pending_events
                .push(CoreEvent::ScrollChanged(scroll_changes));
        }

        self.rects.clear();
        self.clips.clear();
        self.reaches.clear();
        for (idx, &id) in order.iter().enumerate() {
            self.rects.insert(id, rects[idx]);
            self.clips.insert(id, clips[idx]);
            self.reaches.insert(id, placed[idx].reach);
        }
        self.painted = order;

        // Re-check what is under a stationary pointer after layout moved boxes.
        if self.inside && self.captured.is_none() {
            let (x, y) = self.pointer;
            let under = self.hit(x, y);
            self.set_hover(under);
        }

        let selected = self.selected_ranges();
        let mut commands = Vec::new();
        let mut open: Option<Rect> = None;

        for (idx, &id) in self.painted.iter().enumerate() {
            let (rect, clip) = (rects[idx], clips[idx]);
            if clip.is_some_and(|c| !overlaps(c, rect)) {
                continue;
            }
            let node = &self.nodes[&id];
            let mut drawn: Vec<Command> = Vec::new();
            if let NodeStyle::Fill(style) = &node.style {
                drawn.push(Command::Quad(Quad {
                    bounds: rect,
                    background: style.background,
                    border_color: style.border_color,
                    border_width: style.border_width,
                    corner_radius: style.corner_radius,
                }));
            }
            match node.run {
                Some(run) => {
                    let (x, y) = (
                        rect.x + node.own_box.padding.left,
                        rect.y + node.own_box.padding.top,
                    );
                    let placed_rect = |r: Rect| Rect {
                        x: r.x + x,
                        y: r.y + y,
                        ..r
                    };
                    let sel = selected
                        .iter()
                        .find(|(text_node, ..)| *text_node == id)
                        .map(|(_, from, to, caret)| (*from, *to, *caret))
                        .filter(|_| !node.editable || self.is_at_or_beneath(id, self.focused));
                    if let Some((from, to, _)) = sel {
                        let covered = text.selection(run, from, to);
                        drawn.extend(covered.into_iter().map(|r| plain(placed_rect(r), SELECTION)));
                    }
                    drawn.push(Command::Glyphs(Glyphs { run, x, y }));
                    let caret = sel
                        .filter(|_| node.editable)
                        .and_then(|(_, _, caret)| caret)
                        .and_then(|at| text.caret(run, at, CARET_WIDTH));
                    if let (Some(caret), NodeStyle::Text(own)) = (caret, &node.style) {
                        drawn.push(plain(placed_rect(caret), own.style.color));
                    }
                }
                None if drawn.is_empty() => continue,
                None => {}
            }
            if clip != open {
                if open.is_some() {
                    commands.push(Command::PopClip);
                }
                if let Some(c) = clip {
                    commands.push(Command::PushClip(c));
                }
                open = clip;
            }
            commands.extend(drawn);
        }
        if open.is_some() {
            commands.push(Command::PopClip);
        }

        // Scrollbar thumbs on top of content.
        for (idx, &id) in self.painted.iter().enumerate() {
            let (rect, clip) = (rects[idx], clips[idx]);
            if clip.is_some_and(|c| !overlaps(c, rect)) {
                continue;
            }
            let node = &self.nodes[&id];
            let reach = placed[idx].reach;
            let across = node.own_box.overflow_x == Overflow::Scroll && reach.width > 0.0;
            let down = node.own_box.overflow_y == Overflow::Scroll && reach.height > 0.0;
            let mut thumbs = Vec::new();
            if down {
                let (at, length) = thumb(rect.height, reach.height, node.scroll.1);
                thumbs.push(Rect {
                    x: rect.x + rect.width - THUMB_INSET - THUMB_WIDTH,
                    y: rect.y + at,
                    width: THUMB_WIDTH,
                    height: length,
                });
            }
            if across {
                let (at, length) = thumb(rect.width, reach.width, node.scroll.0);
                thumbs.push(Rect {
                    x: rect.x + at,
                    y: rect.y + rect.height - THUMB_INSET - THUMB_WIDTH,
                    width: length,
                    height: THUMB_WIDTH,
                });
            }
            if thumbs.is_empty() {
                continue;
            }
            if let Some(c) = clip {
                commands.push(Command::PushClip(c));
            }
            commands.extend(thumbs.into_iter().map(|bounds| {
                Command::Quad(Quad {
                    bounds,
                    background: Some(THUMB),
                    border_color: None,
                    border_width: 0.0,
                    corner_radius: THUMB_WIDTH / 2.0,
                })
            }));
            if clip.is_some() {
                commands.push(Command::PopClip);
            }
        }

        self.dirty = false;
        commands
    }

    /// Process a pointer input natively: hit-test, update hover/press/focus,
    /// handle wheel scrolling and text selection, and return only watched
    /// state transitions.
    pub fn pointer(&mut self, input: PointerInput, text: &TextEngine) -> PointerOutcome {
        self.pointer_at(input, text, now_ms())
    }

    pub fn pointer_at(
        &mut self,
        input: PointerInput,
        text: &TextEngine,
        now_ms: f64,
    ) -> PointerOutcome {
        let mut needs_redraw = false;
        let target = match input {
            PointerInput::Moved { x, y } => {
                self.pointer = (x, y);
                self.inside = true;
                let target = self.captured.or_else(|| self.hit(x, y));
                self.set_hover(target);
                if self.select_with_at(input, text, now_ms) {
                    needs_redraw = true;
                }
                target
            }
            PointerInput::Button {
                x,
                y,
                button,
                down,
            } => {
                self.pointer = (x, y);
                self.inside = true;
                let target = self.captured.or_else(|| self.hit(x, y));
                self.set_hover(target);
                if button == 0 {
                    if down {
                        self.set_press(target);
                        let focus_target = self.nearest_focusable(target);
                        self.set_focus(focus_target);
                    } else {
                        self.set_press(None);
                        if self.captured.is_some() {
                            self.captured = None;
                            let under = self.hit(x, y);
                            self.set_hover(under);
                        }
                    }
                    if self.select_with_at(input, text, now_ms) {
                        needs_redraw = true;
                    }
                }
                target
            }
            PointerInput::Wheel { x, y, dx, dy } => {
                self.pointer = (x, y);
                self.inside = true;
                let target = self.captured.or_else(|| self.hit(x, y));
                if let Some(t) = target
                    && self.scroll_from(t, dx, dy)
                {
                    needs_redraw = true;
                    self.dirty = true;
                }
                target
            }
            PointerInput::Left => {
                self.inside = false;
                if self.captured.is_none() {
                    self.set_hover(None);
                }
                self.captured
            }
        };

        let events = self.take_events();
        PointerOutcome {
            target,
            needs_redraw,
            events,
        }
    }

    pub fn capture_pointer(&mut self, id: Option<u32>) {
        self.captured = id.filter(|i| self.nodes.contains_key(i));
        if let Some(cap) = self.captured {
            self.set_hover(Some(cap));
            self.cancel_selecting();
        }
    }

    pub fn focus(&mut self, id: Option<u32>) -> Vec<CoreEvent> {
        let valid = id.filter(|i| self.nodes.get(i).is_some_and(|n| n.focusable));
        self.set_focus(valid);
        self.take_events()
    }

    pub fn move_focus(&mut self, backwards: bool) -> Vec<CoreEvent> {
        let order = self.focus_order();
        if order.is_empty() {
            return Vec::new();
        }
        let next = match self.focused.and_then(|f| order.iter().position(|id| *id == f)) {
            Some(pos) if backwards => {
                if pos == 0 {
                    order[order.len() - 1]
                } else {
                    order[pos - 1]
                }
            }
            Some(pos) => order[(pos + 1) % order.len()],
            None if backwards => order[order.len() - 1],
            None => order[0],
        };
        self.set_focus(Some(next));
        self.take_events()
    }

    pub fn notice_key(&mut self, key: &KeyEvent) {
        self.shift = key.modifiers.shift;
    }

    pub fn cursor(&self) -> Cursor {
        let mut current = self.captured.or(self.hovered);
        while let Some(id) = current {
            let Some(node) = self.nodes.get(&id) else {
                break;
            };
            if node.cursor != Cursor::Default {
                return node.cursor;
            }
            current = node.parent;
        }
        Cursor::Default
    }

    pub fn selection_in(&self, id: u32) -> Option<TextSelection> {
        let sel = self.selection?;
        if sel.anchor.node == id && sel.focus.node == id {
            Some(TextSelection {
                anchor: sel.anchor.index,
                focus: sel.focus.index,
            })
        } else {
            None
        }
    }

    pub fn select(&mut self, id: u32, to: TextSelection) -> bool {
        let Some(node) = self.nodes.get(&id) else {
            return false;
        };
        let len = self.length_of(id);
        let content = self.content_of(id).unwrap_or("");
        let clamp = |pos: u32| {
            let mut p = pos.min(len) as usize;
            while p > 0 && !content.is_char_boundary(p) {
                p -= 1;
            }
            p as u32
        };
        let next = Selected {
            anchor: Place {
                node: id,
                index: clamp(to.anchor),
            },
            focus: Place {
                node: id,
                index: clamp(to.focus),
            },
        };
        let editable = node.editable;
        let changed = self.set_selection(Some(next));
        if editable {
            self.reveal = true;
            self.dirty = true;
        }
        changed
    }

    pub fn selected_text(&self) -> Option<String> {
        let ranges = self.selected_ranges();
        if ranges.is_empty() {
            return None;
        }
        let mut out = String::new();
        for (idx, (id, from, to, _)) in ranges.iter().enumerate() {
            if idx > 0 {
                out.push('\n');
            }
            if let Some(content) = self.content_of(*id) {
                let start = (*from as usize).min(content.len());
                let end = (*to as usize).min(content.len());
                if start < end {
                    out.push_str(&content[start..end]);
                }
            }
        }
        (!out.is_empty()).then_some(out)
    }

    pub fn select_all_text(&mut self) -> bool {
        let order = self.text_order();
        let (Some(&first), Some(&last)) = (order.first(), order.last()) else {
            return false;
        };
        let end = self.length_of(last);
        self.set_selection(Some(Selected {
            anchor: Place {
                node: first,
                index: 0,
            },
            focus: Place {
                node: last,
                index: end,
            },
        }))
    }

    pub fn cancel_selecting(&mut self) {
        self.selecting = None;
        if let Some(before) = self.selected_before.take() {
            self.set_selection(before);
        }
    }

    pub fn hit(&self, x: f32, y: f32) -> Option<u32> {
        for &id in self.painted.iter().rev() {
            let Some(&rect) = self.rects.get(&id) else {
                continue;
            };
            let inside_rect = x >= rect.x
                && x < rect.x + rect.width
                && y >= rect.y
                && y < rect.y + rect.height;
            if !inside_rect {
                continue;
            }
            if let Some(Some(clip)) = self.clips.get(&id) {
                let inside_clip = x >= clip.x
                    && x < clip.x + clip.width
                    && y >= clip.y
                    && y < clip.y + clip.height;
                if !inside_clip {
                    continue;
                }
            }
            return Some(id);
        }
        None
    }

    fn set_hover(&mut self, next: Option<u32>) {
        if self.hovered == next {
            return;
        }
        let old = self.hovered;
        self.hovered = next;
        if self.watched_on_either_path(old, next, WatchFlags::HOVERED) {
            self.pending_events.push(CoreEvent::HoverTarget(next));
        }
    }

    fn set_press(&mut self, next: Option<u32>) {
        if self.pressed == next {
            return;
        }
        let old = self.pressed;
        self.pressed = next;
        if self.watched_on_either_path(old, next, WatchFlags::PRESSED) {
            self.pending_events.push(CoreEvent::PressTarget(next));
        }
    }

    fn set_focus(&mut self, next: Option<u32>) {
        if self.focused == next {
            return;
        }
        let old = self.focused;
        self.focused = next;
        // Focusing a field whose selection is elsewhere moves the caret to the
        // end of its editable text.
        if let Some(f) = next
            && let Some(field) = self.editable_in(f)
            && self.selection.is_none_or(|s| s.focus.node != field)
        {
            let end = self.length_of(field);
            self.set_selection(Some(Selected {
                anchor: Place {
                    node: field,
                    index: end,
                },
                focus: Place {
                    node: field,
                    index: end,
                },
            }));
            self.reveal = true;
            self.dirty = true;
        }
        if self.watched_on_either_path(old, next, WatchFlags::FOCUSED) {
            self.pending_events.push(CoreEvent::FocusTarget(next));
        }
    }

    fn watched_on_either_path(&self, a: Option<u32>, b: Option<u32>, flag: WatchFlags) -> bool {
        self.path_watches(a, flag) || self.path_watches(b, flag)
    }

    fn path_watches(&self, start: Option<u32>, flag: WatchFlags) -> bool {
        let mut current = start;
        while let Some(id) = current {
            let Some(node) = self.nodes.get(&id) else {
                break;
            };
            if node.watched.contains(flag) {
                return true;
            }
            current = node.parent;
        }
        false
    }

    fn nearest_focusable(&self, start: Option<u32>) -> Option<u32> {
        let mut current = start;
        while let Some(id) = current {
            let node = self.nodes.get(&id)?;
            if node.focusable {
                return Some(id);
            }
            current = node.parent;
        }
        None
    }

    fn focus_order(&self) -> Vec<u32> {
        let mut out = Vec::new();
        if let Some(root) = self.root {
            self.collect_focusable(root, &mut out);
        }
        out
    }

    fn collect_focusable(&self, id: u32, out: &mut Vec<u32>) {
        let Some(node) = self.nodes.get(&id) else {
            return;
        };
        if node.focusable {
            out.push(id);
        }
        for &child in &node.children {
            self.collect_focusable(child, out);
        }
    }

    fn scroll_from(&mut self, target: u32, dx: f32, dy: f32) -> bool {
        let mut current = Some(target);
        let mut scrolled_changes = Vec::new();
        let mut moved = false;
        while let Some(id) = current {
            let Some(reach) = self.reaches.get(&id).copied() else {
                break;
            };
            let Some(node) = self.nodes.get_mut(&id) else {
                break;
            };
            let parent = node.parent;
            let nx = if node.own_box.overflow_x == Overflow::Scroll && reach.width > 0.0 {
                within(node.scroll.0 + dx, reach.width, Overflow::Scroll)
            } else {
                node.scroll.0
            };
            let ny = if node.own_box.overflow_y == Overflow::Scroll && reach.height > 0.0 {
                within(node.scroll.1 + dy, reach.height, Overflow::Scroll)
            } else {
                node.scroll.1
            };
            if nx != node.scroll.0 || ny != node.scroll.1 {
                node.scroll = (nx, ny);
                moved = true;
                if node.watched.contains(WatchFlags::SCROLL) {
                    let sc = (nx, ny, reach.width, reach.height);
                    if node.last_scroll != Some(sc) {
                        node.last_scroll = Some(sc);
                        scrolled_changes.push(NodeScroll {
                            id,
                            scroll_x: nx,
                            scroll_y: ny,
                            reach_x: reach.width,
                            reach_y: reach.height,
                        });
                    }
                }
                break;
            }
            current = parent;
        }
        if !scrolled_changes.is_empty() {
            self.pending_events
                .push(CoreEvent::ScrollChanged(scrolled_changes));
        }
        moved
    }

    fn is_at_or_beneath(&self, node: u32, above: Option<u32>) -> bool {
        let Some(target) = above else {
            return false;
        };
        let mut cur = Some(node);
        while let Some(id) = cur {
            if id == target {
                return true;
            }
            cur = self.nodes.get(&id).and_then(|n| n.parent);
        }
        false
    }

    fn content_of(&self, id: u32) -> Option<&str> {
        let node = self.nodes.get(&id)?;
        if node.layout.flow().is_some() {
            Some(&node.joined)
        } else if let NodeStyle::Text(tc) = &node.style {
            Some(&tc.content)
        } else {
            None
        }
    }

    fn length_of(&self, id: u32) -> u32 {
        self.content_of(id).map_or(0, |s| s.len() as u32)
    }

    fn set_selection(&mut self, to: Option<Selected>) -> bool {
        if self.selection == to {
            return false;
        }
        self.selection = to;
        self.dirty = true;
        true
    }

    fn keep_selection_in_text(&mut self) {
        let Some(sel) = self.selection else {
            return;
        };
        let clamp = |p: Place| -> Option<Place> {
            let content = self.content_of(p.node)?;
            let mut idx = (p.index as usize).min(content.len());
            while idx > 0 && !content.is_char_boundary(idx) {
                idx -= 1;
            }
            Some(Place {
                node: p.node,
                index: idx as u32,
            })
        };
        self.selection = clamp(sel.anchor).zip(clamp(sel.focus)).map(|(anchor, focus)| Selected {
            anchor,
            focus,
        });
    }

    fn is_selectable_text(&self, id: u32) -> bool {
        let Some(node) = self.nodes.get(&id) else {
            return false;
        };
        node.run.is_some() && !node.editable && !node.unselectable
    }

    fn text_order(&self) -> Vec<u32> {
        let mut out = Vec::new();
        if let Some(root) = self.root {
            self.collect_selectable_text(root, &mut out);
        }
        out
    }

    fn collect_selectable_text(&self, id: u32, out: &mut Vec<u32>) {
        let Some(node) = self.nodes.get(&id) else {
            return;
        };
        if self.is_selectable_text(id) {
            out.push(id);
        }
        if node.layout.flow().is_none() {
            for &child in &node.children {
                self.collect_selectable_text(child, out);
            }
        }
    }

    fn selected_ranges(&self) -> Vec<(u32, u32, u32, Option<u32>)> {
        let Some(sel) = self.selection else {
            return Vec::new();
        };
        if sel.anchor.node == sel.focus.node {
            let (from, to) = if sel.anchor.index <= sel.focus.index {
                (sel.anchor.index, sel.focus.index)
            } else {
                (sel.focus.index, sel.anchor.index)
            };
            return vec![(sel.anchor.node, from, to, Some(sel.focus.index))];
        }
        let order = self.text_order();
        let (Some(a_pos), Some(f_pos)) = (
            order.iter().position(|id| *id == sel.anchor.node),
            order.iter().position(|id| *id == sel.focus.node),
        ) else {
            return Vec::new();
        };
        let (start_pos, start_idx, end_pos, end_idx) = if a_pos <= f_pos {
            (a_pos, sel.anchor.index, f_pos, sel.focus.index)
        } else {
            (f_pos, sel.focus.index, a_pos, sel.anchor.index)
        };
        let mut out = Vec::new();
        for (pos, &id) in order[start_pos..=end_pos].iter().enumerate() {
            let abs = start_pos + pos;
            let from = if abs == start_pos { start_idx } else { 0 };
            let to = if abs == end_pos {
                end_idx
            } else {
                self.length_of(id)
            };
            let caret = (id == sel.focus.node).then_some(sel.focus.index);
            out.push((id, from, to, caret));
        }
        out
    }

    fn editable_in(&self, id: u32) -> Option<u32> {
        let node = self.nodes.get(&id)?;
        if node.editable && node.run.is_some() {
            return Some(id);
        }
        for &child in &node.children {
            if let Some(found) = self.editable_in(child) {
                return Some(found);
            }
        }
        None
    }

    fn field_at(&self, target: Option<u32>) -> Option<u32> {
        let mut cur = target;
        while let Some(id) = cur {
            let node = self.nodes.get(&id)?;
            if node.editable && node.run.is_some() {
                return Some(id);
            }
            if node.focusable
                && let Some(ed) = self.editable_in(id)
            {
                return Some(ed);
            }
            cur = node.parent;
        }
        None
    }

    fn place_at(&self, id: u32, x: f32, y: f32, text: &TextEngine) -> Option<Place> {
        let node = self.nodes.get(&id)?;
        let run = node.run?;
        let rect = self.rects.get(&id)?;
        let lx = x - rect.x - node.own_box.padding.left;
        let ly = y - rect.y - node.own_box.padding.top;
        Some(Place {
            node: id,
            index: text.index_at(run, lx, ly),
        })
    }

    fn nearest_place(&self, x: f32, y: f32, text: &TextEngine) -> Option<Place> {
        let mut best: Option<(f32, u32)> = None;
        for &id in &self.painted {
            if !self.is_selectable_text(id) {
                continue;
            }
            let Some(&rect) = self.rects.get(&id) else {
                continue;
            };
            let dx = if x < rect.x {
                rect.x - x
            } else if x > rect.x + rect.width {
                x - (rect.x + rect.width)
            } else {
                0.0
            };
            let dy = if y < rect.y {
                rect.y - y
            } else if y > rect.y + rect.height {
                y - (rect.y + rect.height)
            } else {
                0.0
            };
            let dist = dx * dx + dy * dy;
            if best.is_none_or(|(b, _)| dist < b) {
                best = Some((dist, id));
            }
        }
        let (_, id) = best?;
        self.place_at(id, x, y, text)
    }

    fn select_with_at(&mut self, input: PointerInput, text: &TextEngine, now_ms: f64) -> bool {
        match input {
            PointerInput::Button {
                x,
                y,
                button: 0,
                down: true,
            } => {
                let count = self.count_press(x, y, now_ms);
                self.selecting = None;
                self.selected_before = Some(self.selection);
                let field = self.field_at(self.pressed);
                let at = match (field, self.pressed) {
                    (Some(field), _) => self.place_at(field, x, y, text),
                    (None, Some(target))
                        if self.nodes.get(&target).is_some_and(|n| n.unselectable) =>
                    {
                        return false;
                    }
                    (None, _) => self.nearest_place(x, y, text),
                };
                let Some(at) = at else {
                    return self.set_selection(None);
                };
                let run = self.nodes.get(&at.node).and_then(|n| n.run);
                let ends = |start: u32, end: u32| Selected {
                    anchor: Place {
                        node: at.node,
                        index: start,
                    },
                    focus: Place {
                        node: at.node,
                        index: end,
                    },
                };
                let begun = self.selection.filter(|s| match field {
                    Some(field) => s.anchor.node == field,
                    None => self.is_selectable_text(s.anchor.node),
                });
                let to = match (count, run) {
                    (1, _) => Selected {
                        anchor: match begun {
                            Some(b) if self.shift => b.anchor,
                            _ => at,
                        },
                        focus: at,
                    },
                    (2, Some(run)) => {
                        let (start, end) = text.word_at(run, at.index);
                        ends(start, end)
                    }
                    _ => ends(0, self.length_of(at.node)),
                };
                self.selecting = (count == 1).then_some(match field {
                    Some(field) => Selecting::Field(field),
                    None => Selecting::Window,
                });
                self.set_selection(Some(to))
            }
            PointerInput::Button {
                button: 0,
                down: false,
                ..
            } => {
                self.selecting = None;
                self.selected_before = None;
                false
            }
            PointerInput::Moved { x, y } => {
                let (Some(selecting), Some(selected)) = (self.selecting, self.selection) else {
                    return false;
                };
                let focus = match selecting {
                    Selecting::Field(field) => self.place_at(field, x, y, text),
                    Selecting::Window => self.nearest_place(x, y, text),
                };
                let Some(focus) = focus else {
                    return false;
                };
                self.set_selection(Some(Selected { focus, ..selected }))
            }
            _ => false,
        }
    }

    fn count_press(&mut self, x: f32, y: f32, now_ms: f64) -> u8 {
        let again = self.pressed_last.filter(|last| {
            let elapsed = now_ms - last.at_ms;
            elapsed >= 0.0
                && elapsed <= PRESS_AGAIN_WITHIN_MS
                && (x - last.x).abs() <= PRESS_AGAIN_NEAR
                && (y - last.y).abs() <= PRESS_AGAIN_NEAR
        });
        let count = again.map_or(1, |last| last.count.saturating_add(1));
        self.pressed_last = Some(Press {
            at_ms: now_ms,
            x,
            y,
            count,
        });
        count
    }

    fn bring_caret_into_sight(
        &mut self,
        placed: &[Placed],
        position_of: &HashMap<u32, u32>,
        text: &TextEngine,
    ) {
        let Some(at) = self.selection.map(|s| s.focus) else {
            return;
        };
        let Some(held) = self.nodes.get(&at.node) else {
            return;
        };
        let (Some(run), Some(&pos)) = (held.run, position_of.get(&at.node)) else {
            return;
        };
        let own = placed[pos as usize].rect;
        let Some(caret) = text.caret(run, at.index, CARET_WIDTH) else {
            return;
        };
        let inset = held.own_box.padding;
        let (left, top) = (own.x + inset.left + caret.x, own.y + inset.top + caret.y);
        let (right, bottom) = (left + caret.width, top + caret.height);

        let (mut across, mut down) = (false, false);
        let mut above = held.parent;
        while let Some(id) = above {
            if across && down {
                break;
            }
            let Some(outer) = self.nodes.get_mut(&id) else {
                break;
            };
            above = outer.parent;
            let Some(&outer_pos) = position_of.get(&id) else {
                continue;
            };
            let frame = placed[outer_pos as usize].rect;
            let padding = outer.own_box.padding;
            if !across && outer.own_box.overflow_x != Overflow::Clip {
                let (start, extent) = (
                    frame.x + padding.left,
                    frame.width - padding.left - padding.right,
                );
                outer.scroll.0 = shown(outer.scroll.0, left, right, start, extent);
                across = true;
            }
            if !down && outer.own_box.overflow_y != Overflow::Clip {
                let (start, extent) = (
                    frame.y + padding.top,
                    frame.height - padding.top - padding.bottom,
                );
                outer.scroll.1 = shown(outer.scroll.1, top, bottom, start, extent);
                down = true;
            }
        }
    }
}

fn thumb(extent: f32, reach: f32, scroll: f32) -> (f32, f32) {
    let track = (extent - 2.0 * THUMB_INSET).max(0.0);
    let total = extent + reach;
    let length = (track * extent / total).max(20.0).min(track);
    let travel = (track - length).max(0.0);
    let at = THUMB_INSET + travel * (scroll / reach);
    (at, length)
}

fn within(scroll: f32, reach: f32, overflow: Overflow) -> f32 {
    if overflow == Overflow::Clip || reach <= 0.0 {
        0.0
    } else {
        scroll.clamp(0.0, reach)
    }
}

fn shown(scroll: f32, near: f32, far: f32, start: f32, extent: f32) -> f32 {
    let end = start + extent;
    if far - scroll > end {
        far - end
    } else if near - scroll < start {
        near - start
    } else {
        scroll
    }
}

fn plain(bounds: Rect, color: Color) -> Command {
    Command::Quad(Quad {
        bounds,
        background: Some(color),
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
    })
}

fn contains(outer: Rect, inner: Rect) -> bool {
    const SLOP: f32 = 0.5;
    inner.x + SLOP >= outer.x
        && inner.y + SLOP >= outer.y
        && inner.x + inner.width <= outer.x + outer.width + SLOP
        && inner.y + inner.height <= outer.y + outer.height + SLOP
}

fn cut(clip: Option<Rect>, rect: Rect, narrows: bool) -> Option<Rect> {
    if !narrows {
        return clip;
    }
    Some(match clip {
        None => rect,
        Some(c) => {
            let x = c.x.max(rect.x);
            let y = c.y.max(rect.y);
            let right = (c.x + c.width).min(rect.x + rect.width);
            let bottom = (c.y + c.height).min(rect.y + rect.height);
            Rect {
                x,
                y,
                width: (right - x).max(0.0),
                height: (bottom - y).max(0.0),
            }
        }
    })
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::TextContent;
    use crate::types::{Align, Axis, BoxStyle, Edges, Flow, Justify, Length};

    fn box_def(width: Length, height: Length, bg: Color) -> RenderNodeDef {
        RenderNodeDef {
            own_box: OwnBox {
                width,
                height,
                ..OwnBox::default()
            },
            style: NodeStyle::Fill(BoxStyle {
                background: Some(bg),
                opacity: 1.0,
                ..BoxStyle::default()
            }),
            ..RenderNodeDef::default()
        }
    }

    fn text_def(content: &str) -> RenderNodeDef {
        RenderNodeDef {
            style: NodeStyle::Text(TextContent {
                content: content.to_owned(),
                style: TextStyle::default(),
            }),
            ..RenderNodeDef::default()
        }
    }

    #[test]
    fn batched_create_layout_and_paint_flat_tree() {
        let mut core = RenderCore::new();
        let mut text = TextEngine::new();
        let red = Color::rgb(1.0, 0.0, 0.0);
        let blue = Color::rgb(0.0, 0.0, 1.0);

        core.apply(
            &[
                RenderOp::Create(CreateOp {
                    id: 1,
                    def: RenderNodeDef {
                        own_box: OwnBox {
                            width: Length::Px(200.0),
                            height: Length::Px(100.0),
                            padding: Edges::all(10.0),
                            ..OwnBox::default()
                        },
                        layout: Layout::Flex(Flex {
                            axis: Axis::Row,
                            justify_content: Justify::Start,
                            align_items: Align::Start,
                            gap: 10.0,
                        }),
                        ..RenderNodeDef::default()
                    },
                }),
                RenderOp::Create(CreateOp {
                    id: 2,
                    def: box_def(Length::Px(50.0), Length::Px(40.0), red),
                }),
                RenderOp::Create(CreateOp {
                    id: 3,
                    def: box_def(Length::Px(60.0), Length::Px(40.0), blue),
                }),
                RenderOp::SetChildren(ChildrenOp {
                    parent: 1,
                    children: vec![2, 3],
                }),
                RenderOp::SetRoot(Some(1)),
            ],
            &mut text,
        );

        let viewport = Size {
            width: 400.0,
            height: 300.0,
        };
        let cmds = core.draw(viewport, &mut text);
        assert_eq!(core.solves, 1);
        assert_eq!(
            core.bounds(2),
            Some(Rect {
                x: 10.0,
                y: 10.0,
                width: 50.0,
                height: 40.0
            })
        );
        assert_eq!(
            core.bounds(3),
            Some(Rect {
                x: 70.0,
                y: 10.0,
                width: 60.0,
                height: 40.0
            })
        );
        assert_eq!(cmds.len(), 2);

        // Visual-only style patch repaints without re-solving layout.
        core.apply(
            &[RenderOp::SetStyle(StyleOp {
                id: 2,
                style: NodeStyle::Fill(BoxStyle {
                    background: Some(Color::rgb(0.0, 1.0, 0.0)),
                    opacity: 1.0,
                    ..BoxStyle::default()
                }),
            })],
            &mut text,
        );
        let _ = core.draw(viewport, &mut text);
        assert_eq!(core.solves, 1);
    }

    #[test]
    fn watch_flags_gate_hover_press_focus_and_size_events() {
        let mut core = RenderCore::new();
        let mut text = TextEngine::new();
        let grey = Color::rgb(0.5, 0.5, 0.5);

        let mut watched_btn = box_def(Length::Px(100.0), Length::Px(40.0), grey);
        watched_btn.focusable = true;
        watched_btn.watched = WatchFlags::HOVERED | WatchFlags::PRESSED | WatchFlags::FOCUSED;

        let mut watched_panel = box_def(Length::Percent(100.0), Length::Px(100.0), grey);
        watched_panel.watched = WatchFlags::SIZE;

        let unwatched = box_def(Length::Px(100.0), Length::Px(40.0), grey);

        core.apply(
            &[
                RenderOp::Create(CreateOp {
                    id: 1,
                    def: watched_panel,
                }),
                RenderOp::Create(CreateOp {
                    id: 2,
                    def: watched_btn,
                }),
                RenderOp::Create(CreateOp {
                    id: 3,
                    def: unwatched,
                }),
                RenderOp::SetChildren(ChildrenOp {
                    parent: 1,
                    children: vec![2, 3],
                }),
                RenderOp::SetRoot(Some(1)),
            ],
            &mut text,
        );

        let _ = core.draw(
            Size {
                width: 400.0,
                height: 300.0,
            },
            &mut text,
        );
        assert_eq!(
            core.take_events(),
            vec![CoreEvent::SizesChanged(vec![NodeSize {
                id: 1,
                width: 400.0,
                height: 100.0,
            }])]
        );

        // Moving over unwatched child 3 produces no hover event.
        let out = core.pointer(PointerInput::Moved { x: 20.0, y: 55.0 }, &text);
        assert_eq!(out.target, Some(3));
        assert!(out.events.is_empty());

        // Moving over watched button 2 emits HoverTarget(Some(2)).
        let out = core.pointer(PointerInput::Moved { x: 20.0, y: 20.0 }, &text);
        assert_eq!(out.target, Some(2));
        assert_eq!(out.events, vec![CoreEvent::HoverTarget(Some(2))]);

        // Pressing watched focusable button 2 emits PressTarget and FocusTarget.
        let out = core.pointer(
            PointerInput::Button {
                x: 20.0,
                y: 20.0,
                button: 0,
                down: true,
            },
            &text,
        );
        assert_eq!(
            out.events,
            vec![
                CoreEvent::PressTarget(Some(2)),
                CoreEvent::FocusTarget(Some(2)),
            ]
        );

        // Resizing to same panel width emits no SizesChanged; changing width does.
        let _ = core.draw(
            Size {
                width: 400.0,
                height: 350.0,
            },
            &mut text,
        );
        assert!(core.take_events().is_empty());

        let _ = core.draw(
            Size {
                width: 600.0,
                height: 350.0,
            },
            &mut text,
        );
        assert_eq!(
            core.take_events(),
            vec![CoreEvent::SizesChanged(vec![NodeSize {
                id: 1,
                width: 600.0,
                height: 100.0,
            }])]
        );
    }

    #[test]
    fn scrolling_emits_only_when_watched_and_does_not_resolve() {
        let mut core = RenderCore::new();
        let mut text = TextEngine::new();
        let mut scroller = RenderNodeDef {
            own_box: OwnBox {
                width: Length::Px(100.0),
                height: Length::Px(100.0),
                overflow_y: Overflow::Scroll,
                ..OwnBox::default()
            },
            watched: WatchFlags::SCROLL,
            ..RenderNodeDef::default()
        };
        scroller.style = NodeStyle::Fill(BoxStyle {
            background: Some(Color::rgb(1.0, 1.0, 1.0)),
            opacity: 1.0,
            ..BoxStyle::default()
        });
        let mut tall_child = box_def(Length::Px(100.0), Length::Px(300.0), Color::rgb(0.2, 0.3, 0.4));
        tall_child.own_box.shrink = 0.0;

        core.apply(
            &[
                RenderOp::Create(CreateOp {
                    id: 1,
                    def: scroller,
                }),
                RenderOp::Create(CreateOp {
                    id: 2,
                    def: tall_child,
                }),
                RenderOp::SetChildren(ChildrenOp {
                    parent: 1,
                    children: vec![2],
                }),
                RenderOp::SetRoot(Some(1)),
            ],
            &mut text,
        );

        let vp = Size {
            width: 200.0,
            height: 200.0,
        };
        let _ = core.draw(vp, &mut text);
        assert_eq!(core.solves, 1);
        assert_eq!(
            core.take_events(),
            vec![CoreEvent::ScrollChanged(vec![NodeScroll {
                id: 1,
                scroll_x: 0.0,
                scroll_y: 0.0,
                reach_x: 0.0,
                reach_y: 200.0,
            }])]
        );

        let out = core.pointer(
            PointerInput::Wheel {
                x: 50.0,
                y: 50.0,
                dx: 0.0,
                dy: 48.0,
            },
            &text,
        );
        assert!(out.needs_redraw);
        assert_eq!(
            out.events,
            vec![CoreEvent::ScrollChanged(vec![NodeScroll {
                id: 1,
                scroll_x: 0.0,
                scroll_y: 48.0,
                reach_x: 0.0,
                reach_y: 200.0,
            }])]
        );

        let _ = core.draw(vp, &mut text);
        // Scrolling reuses the cached solve.
        assert_eq!(core.solves, 1);
        assert_eq!(core.bounds(2).unwrap().y, -48.0);
    }

    #[test]
    fn flow_container_reflows_on_child_content_patch() {
        let mut core = RenderCore::new();
        let mut text = TextEngine::new();
        core.apply(
            &[
                RenderOp::Create(CreateOp {
                    id: 1,
                    def: RenderNodeDef {
                        own_box: OwnBox {
                            width: Length::Px(200.0),
                            ..OwnBox::default()
                        },
                        layout: Layout::Flow(Flow::default()),
                        ..RenderNodeDef::default()
                    },
                }),
                RenderOp::Create(CreateOp {
                    id: 2,
                    def: text_def("Hello "),
                }),
                RenderOp::Create(CreateOp {
                    id: 3,
                    def: text_def("world"),
                }),
                RenderOp::SetChildren(ChildrenOp {
                    parent: 1,
                    children: vec![2, 3],
                }),
                RenderOp::SetRoot(Some(1)),
            ],
            &mut text,
        );

        let _ = core.draw(
            Size {
                width: 300.0,
                height: 200.0,
            },
            &mut text,
        );
        assert!(core.select_all_text());
        assert_eq!(core.selected_text().as_deref(), Some("Hello world"));

        core.apply(
            &[RenderOp::SetContent(ContentOp {
                id: 3,
                content: "ZenaFX".to_owned(),
            })],
            &mut text,
        );
        assert!(core.select_all_text());
        assert_eq!(core.selected_text().as_deref(), Some("Hello ZenaFX"));
    }

    #[test]
    fn move_focus_cycles_focusable_nodes() {
        let mut core = RenderCore::new();
        let mut text = TextEngine::new();
        let mut f = RenderNodeDef::default();
        f.focusable = true;
        f.watched = WatchFlags::FOCUSED;
        core.apply(
            &[
                RenderOp::Create(CreateOp {
                    id: 1,
                    def: RenderNodeDef::default(),
                }),
                RenderOp::Create(CreateOp {
                    id: 2,
                    def: f.clone(),
                }),
                RenderOp::Create(CreateOp { id: 3, def: f }),
                RenderOp::SetChildren(ChildrenOp {
                    parent: 1,
                    children: vec![2, 3],
                }),
                RenderOp::SetRoot(Some(1)),
            ],
            &mut text,
        );

        assert_eq!(core.move_focus(false), vec![CoreEvent::FocusTarget(Some(2))]);
        assert_eq!(core.move_focus(false), vec![CoreEvent::FocusTarget(Some(3))]);
        assert_eq!(core.move_focus(false), vec![CoreEvent::FocusTarget(Some(2))]);
        assert_eq!(core.move_focus(true), vec![CoreEvent::FocusTarget(Some(3))]);
    }
}
