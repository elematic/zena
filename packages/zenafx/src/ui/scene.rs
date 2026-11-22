//! The retained scene: the tree of trees the host holds and draws from.
//!
//! Every widget occupies one node. Beneath it are its **interior** — the nodes
//! its own template describes — and, in the slots that interior declares, the
//! **content** its parent put there. Those are a node's two child axes, and
//! [`Scene::render`] writes only the first: what a node renders replaces its
//! interior and leaves whatever is hanging in its slots alone.
//!
//! [`Scene::render`] is the whole write surface. It takes a template and a
//! sparse list of holes, and the host decides what that means by comparing
//! template identity against what the node already shows: nothing, build it;
//! the same, patch the holes; a different one, drop what was there and build
//! the new one. The guest never says which it meant.
//!
//! A frame after that is a solve and a paint over what the host already has —
//! no call into any component, which is what makes a resize free.
//!
//! Text is shaped when a node is built and released when the node goes away, so
//! a shaped run never crosses the boundary and no component holds one. Patching
//! a text node's content reshapes under the same run id, which is what keeps a
//! patch distinguishable from a rebuild.

use wasmtime::component::{ComponentType, Lift, Lower};

use super::events::{
    Call, Delivery, Listener, Phase, PointerEvent, PointerInput, PointerKind, Scope,
};
use super::layout::{Placed, measure_text, place_with};
use super::text::TextEngine;
use super::types::{
    BoxStyle, Color, Command, Content, Flex, Glyphs, Length, Measured, Node as FlatNode, Overflow,
    Quad, Rect, Size, TextStyle,
};

/// A node of the retained tree, as a component sends it.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct TextContent {
    pub content: String,
    pub style: TextStyle,
}

/// What a node draws.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Appearance {
    #[component(name = "nothing")]
    Nothing,
    #[component(name = "fill")]
    Fill(BoxStyle),
    #[component(name = "text")]
    Text(TextContent),
}

/// One node of a template, as a component describes it.
///
/// Node 0 describes the node being rendered into; the rest are its interior.
/// `first_child`/`child_count` index the same list they arrive in: they are
/// positions in a description, never scene identities.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct NodeDef {
    pub layout: Flex,
    pub appearance: Appearance,
    #[component(name = "first-child")]
    pub first_child: u32,
    #[component(name = "child-count")]
    pub child_count: u32,
    /// Whether content goes here instead of interior.
    #[component(name = "is-slot")]
    pub is_slot: bool,
}

/// Which property of a node a binding writes.
#[derive(Copy, Clone, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum BindingTarget {
    #[component(name = "content")]
    Content,
    #[component(name = "style")]
    Style,
    #[component(name = "layout")]
    Layout,
}

/// One bound property of a template, named by the template node it belongs
/// to. A binding is identified by its index in the template's list.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Binding {
    pub node: u32,
    pub target: BindingTarget,
}

/// The value a binding carries.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum BindingValue {
    #[component(name = "content")]
    Content(String),
    #[component(name = "style")]
    Style(BoxStyle),
    #[component(name = "text-style")]
    TextStyle(TextStyle),
    #[component(name = "layout")]
    Layout(Flex),
}

/// One hole and what to put in it.
///
/// The guest sends only the holes whose values changed, so a list of these is
/// sparse and says nothing about the holes it leaves out.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Hole {
    pub binding: u32,
    pub value: BindingValue,
}

/// Something true of a node because of where the pointer is.
#[derive(Copy, Clone, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum State {
    /// The node the pointer is over is this node or one beneath it.
    #[component(name = "hovered")]
    Hovered,
    /// The primary button went down over this node or one beneath it, and
    /// has not come up since.
    #[component(name = "pressed")]
    Pressed,
}

/// How a node looks while a state holds.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Restyle {
    #[component(name = "fill")]
    Fill(BoxStyle),
    #[component(name = "text")]
    Text(TextStyle),
}

/// One node's look while a state holds, as a template describes it: `node`
/// changes, `of` is the node whose state is read, and both are positions in
/// the template.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct StateStyle {
    pub node: u32,
    pub when: State,
    pub of: u32,
    pub style: Restyle,
}

/// A template the first time it is used. The id is the guest's.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct TemplateDef {
    pub id: u32,
    pub nodes: Vec<NodeDef>,
    pub bindings: Vec<Binding>,
    pub states: Vec<StateStyle>,
}

/// A template the host may not have seen.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum TemplateRef {
    #[component(name = "known")]
    Known(u32),
    #[component(name = "fresh")]
    Fresh(TemplateDef),
}

impl TemplateRef {
    fn id(&self) -> u32 {
        match self {
            TemplateRef::Known(id) => *id,
            TemplateRef::Fresh(def) => def.id,
        }
    }
}

/// A registered template: the interior it describes, and where its holes are.
struct Template {
    nodes: Vec<NodeDef>,
    bindings: Vec<Binding>,
    states: Vec<StateStyle>,
}

/// One answer from the solver, and the question it answers: the window's
/// size and the text scale. The tree is the rest of the question, and
/// `Scene::unsolved` says when that has changed.
struct Solved {
    available: Size,
    scale: f32,
    placed: Vec<Placed>,
}

/// A [`StateStyle`] on the node it changes, with `of` resolved to the scene
/// node whose state is read.
struct Look {
    when: State,
    of: u32,
    style: Restyle,
}

/// What a node currently shows.
///
/// `nodes` is parallel to the template's `nodes`, so a binding's node index
/// resolves to a scene id and a slot's position resolves to the node content
/// hangs under. `nodes[0]` is the node itself, because a template's root *is*
/// the node it was rendered into.
struct Interior {
    template: u32,
    nodes: Vec<u32>,
}

/// A node as the host keeps it: the component's description, plus the run
/// the host shaped for it and the children it resolved.
struct Retained {
    layout: Flex,
    appearance: Appearance,
    /// The shaped run for a text node, owned by this node and released when
    /// it is replaced.
    run: Option<u32>,
    children: Vec<u32>,
    /// A slot contributes no geometry of its own: layout splices its children
    /// into its parent. See `node-def.is-slot` in `wit/zenafx.wit`.
    is_slot: bool,
    /// What this node currently shows, once something has rendered into it. A
    /// node with none is one nobody has rendered into yet — a fresh slot's
    /// content, or the root before the first render.
    interior: Option<Interior>,
    /// The node this one hangs under, slots included, which makes the path
    /// an event travels the tree's own and not layout's. `None` for the root.
    parent: Option<u32>,
    /// What this node hears. Registered by the widget whose interior the node
    /// belongs to, and dropped with that interior.
    listeners: Vec<Listener>,
    /// The looks this node takes while a state holds, in the template's
    /// order. The last one whose state holds is the one drawn.
    looks: Vec<Look>,
    /// Whether some node's look depends on this node being hovered, and on
    /// its being pressed. The pointer coming or going here is then worth a
    /// frame, and anywhere else it is not.
    watched: [bool; 2],
    /// The style a text node's run is shaped with when that is one of its
    /// `looks`. `None` when it is the node's own.
    shaped_as: Option<TextStyle>,
    /// How far this node's content is scrolled, right and down. Moved by the
    /// wheel on an axis whose overflow is `scroll`, and kept within how far
    /// the content reaches each time a frame solves.
    scroll: (f32, f32),
    /// Whether the last frame found content sticking out of this node when
    /// its content was expected to fit. Kept so that it is logged when it
    /// starts and not on every frame after.
    spilled: bool,
}

impl Retained {
    /// A node with nothing in it: what the root is before the first render, and
    /// what a slot's content is before its widget renders.
    fn empty() -> Self {
        Self {
            layout: Flex::default(),
            appearance: Appearance::Nothing,
            run: None,
            children: Vec::new(),
            is_slot: false,
            interior: None,
            parent: None,
            listeners: Vec::new(),
            looks: Vec::new(),
            watched: [false; 2],
            shaped_as: None,
            scroll: (0.0, 0.0),
            spilled: false,
        }
    }

    /// An empty node hanging under `parent`.
    fn under(parent: u32) -> Self {
        Self {
            parent: Some(parent),
            ..Self::empty()
        }
    }
}

/// The tree, and the arena it lives in.
#[derive(Default)]
pub struct Scene {
    nodes: Vec<Option<Retained>>,
    free: Vec<u32>,
    root: Option<u32>,
    /// Keyed by the guest's own template id, so a definition can travel with
    /// the first render that uses it and needs no round trip.
    templates: std::collections::HashMap<u32, Template>,
    /// Set when the tree changed, so the window knows a frame is owed.
    pub dirty: bool,
    /// Where the last solve put each node, indexed by node id. `None` for a
    /// slot, which has no box, and for a node made since that solve, which
    /// the pointer cannot be over until a frame has placed it.
    rects: Vec<Option<Rect>>,
    /// The nodes the last frame painted, in the order it painted them. A hit
    /// test reads it backwards, so the node it finds is the one on top.
    painted: Vec<u32>,
    /// The node the pointer was over after the last input, which is what the
    /// next input's `enter` and `leave` are worked out against.
    hovered: Option<u32>,
    /// The node the pointer was over when the primary button went down,
    /// until the button comes up.
    pressed: Option<u32>,
    /// Where the pointer last was, for a `leave` that arrives with no
    /// position because the pointer left the window.
    pointer: (f32, f32),
    /// Whether the pointer is in the window, and so over something.
    inside: bool,
    /// `enter` and `leave` calls a frame found it owed: the tree moved under
    /// a pointer that did not, so no input arrived to deliver them with.
    owed: Vec<Delivery>,
    /// What the last frame cut each node off at, indexed by node id: the
    /// boxes of the clipping and scrolling nodes it sits in, intersected.
    /// `None` for a node nothing cuts off.
    clips: Vec<Option<Rect>>,
    /// How far each node's content could be scrolled at the last solve,
    /// indexed by node id.
    reaches: Vec<Size>,
    /// What layout was last solved for, and what it answered. A frame that
    /// would ask the same question again uses the answer: scrolling and
    /// hovering change where and how things are drawn, and not where the
    /// solve puts them.
    solved: Option<Solved>,
    /// Set when the tree was written since the last solve, so the answer
    /// kept in `solved` is to a question nobody is asking any more.
    unsolved: bool,
    /// How many times layout has been solved, for tests of what a frame costs.
    pub solves: u32,
    /// The node each listener is on, by the listener's id, so that one can
    /// be removed without a search.
    listening: std::collections::HashMap<u32, u32>,
    /// Listeners whose nodes have gone since this was last taken. Whoever
    /// holds the other end of each one ends it.
    ended: Vec<u32>,
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    /// The scene's root, creating it on first ask.
    ///
    /// An empty node until something renders into it, which is what the first
    /// `render` does. Until then it fills the window on both axes, because the
    /// root *is* the viewport. A root template's node 0 then says how the
    /// application's own box lays out, and `100%` there means the window.
    pub fn root(&mut self) -> u32 {
        match self.root {
            Some(id) => id,
            None => {
                let id = self.alloc(Retained {
                    layout: Flex {
                        width: Length::Percent(100.0),
                        height: Length::Percent(100.0),
                        ..Flex::default()
                    },
                    ..Retained::empty()
                });
                self.root = Some(id);
                id
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.root.is_none()
    }

    /// Show `template` at `node`, with `holes` applied: node 0 of the template
    /// becomes `node`'s own box, and the rest become its interior.
    ///
    /// One operation for creating and for updating, because the host can tell
    /// which is which. Nothing there yet: build the template and apply every
    /// hole given. The same template already there: write the holes and leave
    /// the rest, content in its slots included. A different template: drop what
    /// was there — content with it, since none of it belongs to the new
    /// interior — and build the new one.
    pub fn render(
        &mut self,
        node: u32,
        template: &TemplateRef,
        holes: &[Hole],
        text: &mut TextEngine,
    ) {
        if let TemplateRef::Fresh(def) = template {
            self.templates.entry(def.id).or_insert_with(|| Template {
                nodes: def.nodes.clone(),
                bindings: def.bindings.clone(),
                states: def.states.clone(),
            });
        }
        let id = template.id();
        let Some(def) = self.templates.get(&id) else {
            return;
        };

        let showing = self
            .get(node)
            .and_then(|n| n.interior.as_ref())
            .map(|i| i.template);
        if showing != Some(id) {
            let (nodes, bindings, states) =
                (def.nodes.clone(), def.bindings.clone(), def.states.clone());
            self.build_interior(node, id, &nodes, &bindings, &states, holes, text);
            return;
        }

        let bindings = def.bindings.clone();
        for hole in holes {
            self.write_hole(node, &bindings, hole, text);
        }
        self.changed();
    }

    /// Record that the tree was written: a frame is owed, and the frame has
    /// to solve layout again. A hole can change what a node says or how it
    /// lays out, and the scene does not look to see which.
    fn changed(&mut self) {
        self.dirty = true;
        self.unsolved = true;
    }

    /// The nodes hanging in slot `index` of `node`'s interior, made exactly
    /// `count` long.
    ///
    /// Growing creates empty nodes, shrinking drops the ones past the end with
    /// everything beneath them, and the nodes that stay keep their identity and
    /// their subtrees — so a parent whose child list is unchanged hands its
    /// children back the same nodes, and the diffing each one does still holds.
    ///
    /// Slots are numbered by the order they appear in the template, skipping
    /// node 0, which is the widget's own box. Returns `None` for a node with no
    /// interior yet, or an index past its slots — a guest bug rather than
    /// something to paper over.
    pub fn content(
        &mut self,
        node: u32,
        index: u32,
        count: u32,
        text: &mut TextEngine,
    ) -> Option<Vec<u32>> {
        let slot = self.slot(node, index)?;
        let mut children = self.get(slot)?.children.clone();
        while children.len() > count as usize {
            let gone = children.pop().expect("a child to drop");
            self.forget_pointer_in(gone);
            self.drop_subtree(gone, text);
        }
        while children.len() < count as usize {
            children.push(self.alloc(Retained::under(slot)));
        }
        self.get_mut(slot)?.children = children.clone();
        self.changed();
        Some(children)
    }

    /// The node that is slot `index` of `node`'s interior.
    fn slot(&self, node: u32, index: u32) -> Option<u32> {
        let interior = self.get(node)?.interior.as_ref()?;
        let template = self.templates.get(&interior.template)?;
        template
            .nodes
            .iter()
            .enumerate()
            .skip(1)
            .filter(|(_, def)| def.is_slot)
            .nth(index as usize)
            .and_then(|(position, _)| interior.nodes.get(position).copied())
    }

    /// Reconfigure `node` from a template's node 0 and build the rest beneath
    /// it, dropping whatever was there.
    fn build_interior(
        &mut self,
        node: u32,
        template: u32,
        defs: &[NodeDef],
        bindings: &[Binding],
        states: &[StateStyle],
        holes: &[Hole],
        text: &mut TextEngine,
    ) {
        // Everything under the node goes: a different template shares nothing
        // with the old one, and content sat in the old one's slots.
        let old: Vec<u32> = self.get(node).map(|n| n.children.clone()).unwrap_or_default();
        for child in old {
            self.forget_pointer_in(child);
            self.drop_subtree(child, text);
        }
        if let Some(held) = self.get_mut(node) {
            let gone = held.run.take();
            // Its listeners and looks go with the rest: they came with the
            // template that is being replaced. Where it hangs does not change.
            let listeners = std::mem::take(&mut held.listeners);
            *held = Retained {
                parent: held.parent,
                ..Retained::empty()
            };
            if let Some(run) = gone {
                text.release_run(run);
            }
            self.end(&listeners);
        }
        if defs.is_empty() {
            self.changed();
            return;
        }

        // Apply the holes to the description before it reaches the arena, so a
        // text node is shaped once with the content it is going to show.
        let mut filled = defs.to_vec();
        for hole in holes {
            if let Some(binding) = bindings.get(hole.binding as usize) {
                if let Some(target) = filled.get_mut(binding.node as usize) {
                    apply(target, binding.target, &hole.value);
                }
            }
        }

        // Index 0 is the node itself, which is what makes a widget one box
        // rather than a box inside a box.
        let mut ids = vec![node];
        for def in &filled[1..] {
            let run = self.shape(def, text);
            ids.push(self.alloc(Retained {
                layout: def.layout,
                appearance: def.appearance.clone(),
                run,
                is_slot: def.is_slot,
                ..Retained::empty()
            }));
        }
        let run = self.shape(&filled[0], text);
        if let Some(held) = self.get_mut(node) {
            held.layout = filled[0].layout;
            held.appearance = filled[0].appearance.clone();
            held.run = run;
        }

        for (index, def) in filled.iter().enumerate() {
            let children: Vec<u32> = (def.first_child as usize
                ..def.first_child as usize + def.child_count as usize)
                .filter_map(|c| ids.get(c).copied())
                .collect();
            for child in &children {
                if let Some(held) = self.get_mut(*child) {
                    held.parent = Some(ids[index]);
                }
            }
            if let Some(held) = self.get_mut(ids[index]) {
                held.children = children;
            }
        }

        // A state style names two positions in the template. Both are nodes
        // of this interior now: the one that changes keeps the look, and the
        // one whose state is read is marked, so that the pointer coming or
        // going there is known to need a frame.
        for state in states {
            let (Some(changes), Some(read)) = (
                ids.get(state.node as usize).copied(),
                ids.get(state.of as usize).copied(),
            ) else {
                continue;
            };
            if let Some(held) = self.get_mut(changes) {
                held.looks.push(Look {
                    when: state.when,
                    of: read,
                    style: state.style.clone(),
                });
            }
            if let Some(held) = self.get_mut(read) {
                held.watched[state.when as usize] = true;
            }
        }

        if let Some(held) = self.get_mut(node) {
            held.interior = Some(Interior {
                template,
                nodes: ids,
            });
        }
        self.changed();
    }

    /// Shape a node's text, if it has any. The run belongs to the node from
    /// here on, and is released when the node goes away.
    fn shape(&self, def: &NodeDef, text: &mut TextEngine) -> Option<u32> {
        match &def.appearance {
            Appearance::Text(t) => Some(text.register_run(&t.content, &t.style)),
            _ => None,
        }
    }

    /// Write one hole into a node that already shows the right template.
    fn write_hole(
        &mut self,
        node: u32,
        bindings: &[Binding],
        hole: &Hole,
        text: &mut TextEngine,
    ) {
        let Some(binding) = bindings.get(hole.binding as usize) else {
            return;
        };
        let Some(interior) = self.get(node).and_then(|n| n.interior.as_ref()) else {
            return;
        };
        let Some(id) = interior.nodes.get(binding.node as usize).copied() else {
            return;
        };
        let target = binding.target;

        let Some(held) = self.get_mut(id) else {
            return;
        };
        match (target, &hole.value) {
            (BindingTarget::Content, BindingValue::Content(content)) => {
                if let Appearance::Text(text_content) = &mut held.appearance {
                    text_content.content = content.clone();
                    // The style the run has now, which is a look's while a
                    // state holds.
                    let style = held
                        .shaped_as
                        .clone()
                        .unwrap_or_else(|| text_content.style.clone());
                    // Reshaping under the same id is what keeps the run the
                    // node already has, rather than releasing and allocating.
                    if let Some(run) = held.run {
                        text.update_run(run, content, &style);
                    }
                }
            }
            (BindingTarget::Style, BindingValue::Style(style)) => {
                held.appearance = Appearance::Fill(*style);
            }
            (BindingTarget::Style, BindingValue::TextStyle(style)) => {
                if let Appearance::Text(text_content) = &mut held.appearance {
                    text_content.style = style.clone();
                    let content = text_content.content.clone();
                    // A run that is showing a look keeps it: this is the
                    // style for when no state holds.
                    if let (Some(run), None) = (held.run, &held.shaped_as) {
                        text.update_run(run, &content, style);
                    }
                }
            }
            (BindingTarget::Layout, BindingValue::Layout(layout)) => {
                held.layout = *layout;
            }
            _ => {}
        }
    }

    /// Solve the tree at `available` and walk it into a display list.
    ///
    /// Nothing here touches a component. This is the whole of a frame once
    /// the tree is installed.
    pub fn draw(&mut self, available: Size, text: &mut TextEngine) -> Vec<Command> {
        let Some(root) = self.root else {
            return Vec::new();
        };

        // Flatten breadth first, which is what `solve` needs: a node's
        // children contiguous and after it.
        let mut order: Vec<u32> = vec![root];
        let mut children_of: Vec<Vec<u32>> = Vec::new();
        let mut i = 0;
        while i < order.len() {
            let children = self.layout_children(order[i]);
            order.extend(children.iter().copied());
            children_of.push(children);
            i += 1;
        }
        let mut position_of = vec![u32::MAX; self.nodes.len()];
        for (index, id) in order.iter().enumerate() {
            position_of[*id as usize] = index as u32;
        }

        // Text first, because a look can change how wide a run is and the
        // solve has to measure the run it is going to draw.
        self.reshape_for_states(&order, text);

        // The solve is the costly part of a frame, and most frames have no
        // need of one: nothing the solver reads has changed when the pointer
        // moved or a box scrolled. The last answer stands until the tree is
        // written, the window changes size, or the text scale does.
        let stands = !self.unsolved
            && self
                .solved
                .as_ref()
                .is_some_and(|s| s.available == available && s.scale == text.scale());
        if !stands {
            let flat: Vec<FlatNode> = order
                .iter()
                .zip(&children_of)
                .map(|(id, children)| {
                    let node = self.get(*id).expect("a live node");
                    let first = children
                        .first()
                        .map(|c| position_of[*c as usize])
                        .unwrap_or(0);
                    FlatNode {
                        layout: node.layout,
                        content: match node.run {
                            Some(run) => Content::Text(run),
                            None => Content::Box,
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

        // The solve places everything as if nothing were scrolled. A node is
        // drawn that far from where the solve put it as the nodes it sits in
        // have scrolled between them, and is cut off at their boxes. A parent
        // comes before its children in `order`, so what a node passes down
        // is known by the time its children are reached.
        let mut parent_of = vec![usize::MAX; order.len()];
        for (index, children) in children_of.iter().enumerate() {
            for child in children {
                parent_of[position_of[*child as usize] as usize] = index;
            }
        }
        // For each node: how far its children are shifted, and what they are
        // cut off at.
        let mut passed_down: Vec<((f32, f32), Option<Rect>)> = Vec::with_capacity(order.len());
        let mut rects: Vec<Rect> = Vec::with_capacity(order.len());
        let mut clips: Vec<Option<Rect>> = Vec::with_capacity(order.len());
        for (index, id) in order.iter().enumerate() {
            let (shift, clip) = match parent_of[index] {
                usize::MAX => ((0.0, 0.0), None),
                parent => passed_down[parent],
            };
            let Placed {
                rect: solved,
                reach,
            } = placed[index];
            let rect = Rect {
                x: solved.x - shift.0,
                y: solved.y - shift.1,
                ..solved
            };
            // A box whose content is expected to fit is cut off at only when
            // a child's box sticks out of it. What sticks out of a child is
            // the child's to cut off, so the children are all there is to
            // look at.
            let spills = children_of[index]
                .iter()
                .any(|child| !contains(solved, placed[position_of[*child as usize] as usize].rect));
            let held = self.get_mut(*id).expect("a live node");
            let (over_x, over_y) = (held.layout.overflow_x, held.layout.overflow_y);
            let expects_more = over_x != Overflow::Clip || over_y != Overflow::Clip;
            if spills && !expects_more && !held.spilled {
                log::warn!(
                    "content does not fit in node {id}, which is {} by {}, and is cut off; \
                     a box meant to hold more than fits says `hidden` or `scroll`",
                    solved.width,
                    solved.height,
                );
            }
            held.spilled = spills && !expects_more;
            // Content that shrank, or a window that grew, can leave a node
            // scrolled further than its content now reaches.
            held.scroll = (
                within(held.scroll.0, reach.width, over_x),
                within(held.scroll.1, reach.height, over_y),
            );
            let inner_shift = (shift.0 + held.scroll.0, shift.1 + held.scroll.1);
            // Content is cut off inside the border, so a list's rows scroll
            // under its border and not over it.
            let border = match &held.appearance {
                Appearance::Fill(style) if style.border_color.is_some() => style.border_width,
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

        // Keep where everything went: the pointer is tested against what the
        // last frame showed, which is what the person was pointing at.
        self.rects.clear();
        self.rects.resize(self.nodes.len(), None);
        self.clips.clear();
        self.clips.resize(self.nodes.len(), None);
        self.reaches.clear();
        self.reaches.resize(
            self.nodes.len(),
            Size {
                width: 0.0,
                height: 0.0,
            },
        );
        for (index, id) in order.iter().enumerate() {
            self.rects[*id as usize] = Some(rects[index]);
            self.clips[*id as usize] = clips[index];
            self.reaches[*id as usize] = placed[index].reach;
        }
        self.painted = order;

        // The solve may have moved something under a pointer that has not
        // moved, or out from under it. No input will arrive to say so, which
        // makes this the only place it can be noticed.
        let restyled = self.inside && {
            let (x, y) = self.pointer;
            self.hover(self.hit(x, y))
        };
        // A fill's look is drawn below, in this frame, from the states as
        // they now are. A text node's look can change how wide its run is,
        // so it is shaped before the solve, and one that changed just now is
        // shaped here for the next frame to lay out. Only then is another
        // frame owed: a list of rows with hovered fills scrolls in one frame
        // a notch.
        let late = restyled && {
            let painted = std::mem::take(&mut self.painted);
            let reshaped = self.reshape_for_states(&painted, text);
            self.painted = painted;
            reshaped
        };

        let (hovered, pressed) = (self.path(self.hovered), self.path(self.pressed));
        let mut commands = Vec::new();
        // The clip the commands being added are inside. Nodes are painted
        // level by level, so one node's subtree is not a run of commands and
        // a clip is opened and closed round each stretch that shares one.
        let mut open: Option<Rect> = None;
        for (index, id) in self.painted.iter().enumerate() {
            let (rect, clip) = (rects[index], clips[index]);
            // What is cut off entirely is not drawn, which is what keeps a
            // long list scrolled to its middle from costing its whole length.
            if clip.is_some_and(|clip| !overlaps(clip, rect)) {
                continue;
            }
            let node = self.get(*id).expect("a live node");
            let look = node.looks.iter().rev().find_map(|l| match &l.style {
                Restyle::Fill(style) if holds(l, &hovered, &pressed) => Some(style),
                _ => None,
            });
            let command = match (look, &node.appearance, node.run) {
                (Some(style), _, None) | (None, Appearance::Fill(style), _) => {
                    Command::Quad(Quad {
                        bounds: rect,
                        background: style.background,
                        border_color: style.border_color,
                        border_width: style.border_width,
                        corner_radius: style.corner_radius,
                    })
                }
                (_, Appearance::Text(_), Some(run)) => Command::Glyphs(Glyphs {
                    run,
                    x: rect.x,
                    y: rect.y,
                }),
                _ => continue,
            };
            if clip != open {
                if open.is_some() {
                    commands.push(Command::PopClip);
                }
                if let Some(clip) = clip {
                    commands.push(Command::PushClip(clip));
                }
                open = clip;
            }
            commands.push(command);
        }
        if open.is_some() {
            commands.push(Command::PopClip);
        }

        // Last, and so on top of everything: a thumb in each box that has
        // further to scroll, showing how much of the content the box shows
        // and where in it. It is cut off where the box itself is.
        for (index, id) in self.painted.iter().enumerate() {
            let (rect, clip) = (rects[index], clips[index]);
            if clip.is_some_and(|clip| !overlaps(clip, rect)) {
                continue;
            }
            let node = self.get(*id).expect("a live node");
            let reach = placed[index].reach;
            let across = node.layout.overflow_x == Overflow::Scroll && reach.width > 0.0;
            let down = node.layout.overflow_y == Overflow::Scroll && reach.height > 0.0;
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
            if let Some(clip) = clip {
                commands.push(Command::PushClip(clip));
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

        self.dirty = late;
        commands
    }

    /// Shape each text node's run with the look that holds for it, or with
    /// its own style when none does. Only a node whose look changed since it
    /// was last shaped costs anything. Returns whether any did.
    fn reshape_for_states(&mut self, order: &[u32], text: &mut TextEngine) -> bool {
        let (hovered, pressed) = (self.path(self.hovered), self.path(self.pressed));
        let mut reshaped = false;
        for id in order {
            let Some(held) = self.get_mut(*id) else {
                continue;
            };
            let (Some(run), Appearance::Text(own)) = (held.run, &held.appearance) else {
                continue;
            };
            let look = held.looks.iter().rev().find_map(|l| match &l.style {
                Restyle::Text(style) if holds(l, &hovered, &pressed) => Some(style.clone()),
                _ => None,
            });
            if look != held.shaped_as {
                text.update_run(run, &own.content, look.as_ref().unwrap_or(&own.style));
                held.shaped_as = look;
                reshaped = true;
            }
        }
        // A run that changed can measure differently, so the last solve's
        // answer no longer stands.
        self.unsolved |= reshaped;
        reshaped
    }

    /// Make `target` the node the pointer is over. Returns whether that
    /// changes how anything looks.
    ///
    /// The `enter` and `leave` calls the change leads to are kept in `owed`
    /// for whoever delivers them, because a frame can be what finds the
    /// change and a frame makes no calls.
    fn hover(&mut self, target: Option<u32>) -> bool {
        if target == self.hovered {
            return false;
        }
        let crossing = self.crossing(self.hovered, target, self.pointer);
        self.owed.push(crossing);
        let restyled = self.watched_between(self.hovered, target, State::Hovered);
        self.hovered = target;
        restyled
    }

    /// Make `target` the node the primary button is down on, or none.
    /// Returns whether that changes how anything looks.
    fn press(&mut self, target: Option<u32>) -> bool {
        if target == self.pressed {
            return false;
        }
        let restyled = self.watched_between(self.pressed, target, State::Pressed);
        self.pressed = target;
        restyled
    }

    /// Whether some look depends on `state` at a node that is on the path
    /// from one of these targets and not the other, which are the nodes the
    /// state starts or stops holding for.
    fn watched_between(&self, old: Option<u32>, new: Option<u32>, state: State) -> bool {
        let (old, new) = (self.path(old), self.path(new));
        let watched = |id: &u32| self.get(*id).is_some_and(|n| n.watched[state as usize]);
        old.iter().filter(|id| !new.contains(id)).any(watched)
            || new.iter().filter(|id| !old.contains(id)).any(watched)
    }

    /// The `enter` and `leave` calls frames have found owed since this was
    /// last asked.
    pub fn take_owed(&mut self) -> Vec<Delivery> {
        let mut owed = std::mem::take(&mut self.owed);
        owed.retain(|d| !d.calls.is_empty());
        owed
    }

    /// Hear `listener`'s kind of event at position `target` of the template
    /// `node` shows. Position 0 is `node` itself.
    ///
    /// Returns whether there was such a position: a node that shows nothing
    /// yet has none, and a guest naming one has a bug.
    ///
    /// The listener lasts until [`Scene::unlisten`] removes it or the node
    /// it is on goes away, which [`Scene::take_ended`] reports.
    pub fn listen(&mut self, node: u32, target: u32, listener: Listener) -> bool {
        let Some(id) = self
            .get(node)
            .and_then(|n| n.interior.as_ref())
            .and_then(|i| i.nodes.get(target as usize).copied())
        else {
            return false;
        };
        match self.get_mut(id) {
            Some(held) => {
                held.listeners.push(listener);
                self.listening.insert(listener.id, id);
                true
            }
            None => false,
        }
    }

    /// Remove the listener with this id. Nothing happens if it has
    /// already been removed.
    pub fn unlisten(&mut self, id: u32) {
        let Some(node) = self.listening.remove(&id) else {
            return;
        };
        if let Some(held) = self.get_mut(node) {
            held.listeners.retain(|l| l.id != id);
        }
    }

    /// The ids of the listeners that ended, since this was last asked,
    /// because the node they were on went away.
    pub fn take_ended(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.ended)
    }

    /// Record that these listeners' node has gone.
    fn end(&mut self, listeners: &[Listener]) {
        for listener in listeners {
            self.listening.remove(&listener.id);
            self.ended.push(listener.id);
        }
    }

    /// What one pointer input leads to: the listeners to call, in order.
    ///
    /// The target is the node the last frame painted on top at that point.
    /// When it differs from the last input's target, every listener whose
    /// scope stopped containing the target hears `leave` and every one whose
    /// scope started to hears `enter`. Then the input's own event travels the
    /// path between the root and the target.
    ///
    /// Nothing here calls a component. The registrations are the host's, so
    /// which listeners an event reaches is known before anything is entered,
    /// and an input that reaches none returns an empty list.
    ///
    /// The input also moves the `hovered` and `pressed` states. When that
    /// changes how some node looks, `dirty` is set and a frame is owed.
    pub fn pointer(&mut self, input: PointerInput) -> Vec<Delivery> {
        let (position, press) = match input {
            PointerInput::Moved { x, y } | PointerInput::Wheel { x, y, .. } => (Some((x, y)), None),
            PointerInput::Button { x, y, button, down } => (Some((x, y)), Some((button, down))),
            PointerInput::Left => (None, None),
        };
        if let Some(at) = position {
            self.pointer = at;
        }
        self.inside = position.is_some();
        let at = self.pointer;
        let target = position.and_then(|(x, y)| self.hit(x, y));

        let mut restyled = self.hover(target);
        // The primary button alone presses. A press ends when the button
        // comes up, wherever the pointer is by then.
        match press {
            Some((0, true)) => restyled |= self.press(target),
            Some((0, false)) => restyled |= self.press(None),
            _ => {}
        }
        // The wheel is the scene's own business. What moves is a number the
        // scene keeps, and the frame that follows finds for itself what the
        // content brought under the pointer, so no listener hears of it.
        let wheel = match (input, target) {
            (PointerInput::Wheel { dx, dy, .. }, Some(target)) => {
                restyled |= self.scroll_from(target, dx, dy);
                true
            }
            (PointerInput::Wheel { .. }, None) => true,
            _ => false,
        };
        self.dirty |= restyled;

        let mut deliveries = std::mem::take(&mut self.owed);
        if let (Some(target), Some(_), false) = (target, position, wheel) {
            let (kind, button) = match press {
                Some((button, true)) => (PointerKind::Down, button),
                Some((button, false)) => (PointerKind::Up, button),
                None => (PointerKind::Move, 0),
            };
            deliveries.push(self.along_path(target, kind, button, at));
        }
        deliveries.retain(|d| !d.calls.is_empty());
        deliveries
    }

    /// Scroll by `dx`, `dy` from `target`: on each axis, the nearest node at
    /// or above it that scrolls on that axis and has further to go that way.
    /// Returns whether anything moved.
    ///
    /// A node already at its end passes the wheel to the one it sits in, so
    /// a list scrolled to its last row scrolls the page. The two axes look
    /// separately, since the row that scrolls sideways and the page that
    /// scrolls down are often different nodes.
    fn scroll_from(&mut self, target: u32, dx: f32, dy: f32) -> bool {
        let path = self.path(Some(target));
        let mut moved = false;
        for (by, vertical) in [(dx, false), (dy, true)] {
            if by == 0.0 {
                continue;
            }
            for id in &path {
                // A node no frame has placed has nowhere to scroll to yet.
                let placed = self.rects.get(*id as usize).copied().flatten().is_some();
                let reach = match (placed, self.reaches.get(*id as usize)) {
                    (true, Some(reach)) if vertical => reach.height,
                    (true, Some(reach)) => reach.width,
                    _ => 0.0,
                };
                let Some(held) = self.get_mut(*id) else {
                    continue;
                };
                let (overflow, at) = if vertical {
                    (held.layout.overflow_y, &mut held.scroll.1)
                } else {
                    (held.layout.overflow_x, &mut held.scroll.0)
                };
                let to = within(*at + by, reach, overflow);
                if to != *at {
                    *at = to;
                    moved = true;
                    break;
                }
            }
        }
        moved
    }

    /// The node painted last at a point, which is the one on top there. A
    /// node is only there where it is drawn, so not where a node it sits in
    /// cuts it off.
    fn hit(&self, x: f32, y: f32) -> Option<u32> {
        let at = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        self.painted.iter().rev().copied().find(|id| {
            let rect = self.rects.get(*id as usize).copied().flatten();
            let clip = self.clips.get(*id as usize).copied().flatten();
            rect.is_some_and(at) && clip.is_none_or(at)
        })
    }

    /// `node` and everything it hangs under, nearest first, ending at the root.
    fn path(&self, node: Option<u32>) -> Vec<u32> {
        let mut path = Vec::new();
        let mut next = node;
        while let Some(id) = next {
            let Some(held) = self.get(id) else {
                break;
            };
            path.push(id);
            next = held.parent;
        }
        path
    }

    /// The calls for the target changing from `old` to `new`.
    ///
    /// A `subtree` listener hears about its node's subtree gaining or losing
    /// the target, so moving between two children of a button tells the
    /// button nothing. A `node` listener hears about its own node becoming or
    /// ceasing to be the target. Leaves come first, nearest the old target
    /// first, and then enters, nearest the root first.
    fn crossing(&self, old: Option<u32>, new: Option<u32>, at: (f32, f32)) -> Delivery {
        let (old_path, new_path) = (self.path(old), self.path(new));
        let mut calls = Vec::new();
        for id in &old_path {
            let left = !new_path.contains(id);
            self.offer(*id, PointerKind::Leave, 0, at, &mut calls, |l| {
                match l.scope {
                    Scope::Subtree => left,
                    Scope::Node => Some(*id) == old,
                }
            });
        }
        for id in new_path.iter().rev() {
            let entered = !old_path.contains(id);
            self.offer(*id, PointerKind::Enter, 0, at, &mut calls, |l| {
                match l.scope {
                    Scope::Subtree => entered,
                    Scope::Node => Some(*id) == new,
                }
            });
        }
        Delivery {
            calls,
            stops_when_handled: false,
        }
    }

    /// The calls for a `down`, `up` or `move` at `target`: `intercept`
    /// listeners from the root down to it, then `bubble` listeners from it
    /// back up.
    fn along_path(&self, target: u32, kind: PointerKind, button: u8, at: (f32, f32)) -> Delivery {
        let path = self.path(Some(target));
        let in_scope = |id: u32, l: &Listener| l.scope == Scope::Subtree || id == target;
        let mut calls = Vec::new();
        for id in path.iter().rev() {
            self.offer(*id, kind, button, at, &mut calls, |l| {
                l.phase == Phase::Intercept && in_scope(*id, l)
            });
        }
        for id in &path {
            self.offer(*id, kind, button, at, &mut calls, |l| {
                l.phase == Phase::Bubble && in_scope(*id, l)
            });
        }
        Delivery {
            calls,
            stops_when_handled: true,
        }
    }

    /// Add a call for each of `node`'s listeners of this kind that `wanted`
    /// accepts, with the position measured from `node`'s own box.
    fn offer(
        &self,
        node: u32,
        kind: PointerKind,
        button: u8,
        at: (f32, f32),
        calls: &mut Vec<Call>,
        wanted: impl Fn(&Listener) -> bool,
    ) {
        let Some(held) = self.get(node) else {
            return;
        };
        let (left, top) = self.origin(node);
        for listener in held
            .listeners
            .iter()
            .filter(|l| l.kind == kind && wanted(l))
        {
            calls.push(Call {
                listener: listener.id,
                event: PointerEvent {
                    kind,
                    x: at.0 - left,
                    y: at.1 - top,
                    button,
                },
            });
        }
    }

    /// The top left corner of `node`'s box, or of the nearest box it hangs
    /// under when it has none of its own, as a slot does not.
    fn origin(&self, node: u32) -> (f32, f32) {
        self.path(Some(node))
            .into_iter()
            .find_map(|id| self.rects.get(id as usize).copied().flatten())
            .map(|r| (r.x, r.y))
            .unwrap_or((0.0, 0.0))
    }

    /// Stop treating anything in `gone`'s subtree as under the pointer or
    /// pressed, since it is about to be dropped and its id reused. What
    /// `gone` hung under takes its place, so the next input, or the next
    /// frame, is compared against a node that still exists.
    fn forget_pointer_in(&mut self, gone: u32) {
        let above = self.get(gone).and_then(|n| n.parent);
        if self.path(self.hovered).contains(&gone) {
            self.hovered = above;
        }
        if self.path(self.pressed).contains(&gone) {
            self.pressed = above;
        }
    }

    /// A node's children as layout sees them, with slots spliced out.
    ///
    /// A slot contributes no geometry — it is `display: contents` — so what
    /// hangs in it lays out as a child of whatever contains the slot. That is
    /// what keeps one box per widget: the widget's own node is a box, and the
    /// slot its parent put it in is not.
    fn layout_children(&self, id: u32) -> Vec<u32> {
        let Some(node) = self.get(id) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(node.children.len());
        for child in &node.children {
            match self.get(*child) {
                Some(held) if held.is_slot => out.extend(self.layout_children(*child)),
                Some(_) => out.push(*child),
                None => {}
            }
        }
        out
    }

    fn alloc(&mut self, node: Retained) -> u32 {
        match self.free.pop() {
            Some(id) => {
                self.nodes[id as usize] = Some(node);
                // The id's last holder may have had a box. This node has none
                // until a frame gives it one.
                if let Some(rect) = self.rects.get_mut(id as usize) {
                    *rect = None;
                }
                id
            }
            None => {
                self.nodes.push(Some(node));
                (self.nodes.len() - 1) as u32
            }
        }
    }

    fn get(&self, id: u32) -> Option<&Retained> {
        self.nodes.get(id as usize).and_then(Option::as_ref)
    }

    fn get_mut(&mut self, id: u32) -> Option<&mut Retained> {
        self.nodes.get_mut(id as usize).and_then(Option::as_mut)
    }

    /// Free a subtree and the text it shaped.
    fn drop_subtree(&mut self, id: u32, text: &mut TextEngine) {
        let Some(node) = self.nodes.get_mut(id as usize).and_then(Option::take) else {
            return;
        };
        if let Some(run) = node.run {
            text.release_run(run);
        }
        // Its box goes with it, so a pointer input that arrives before the
        // next frame cannot land on a node that is no longer there.
        if let Some(rect) = self.rects.get_mut(id as usize) {
            *rect = None;
        }
        self.free.push(id);
        self.end(&node.listeners);
        for child in node.children {
            self.drop_subtree(child, text);
        }
    }

    /// How many nodes are live, for tests and diagnostics.
    pub fn len(&self) -> usize {
        self.nodes.iter().filter(|n| n.is_some()).count()
    }
}

/// Whether a look's state holds, given the paths from the node the pointer is
/// over and from the node the button went down on. A state holds for every
/// node on its path, which is what makes it true of a button when the pointer
/// is over the button's label.
fn holds(look: &Look, hovered: &[u32], pressed: &[u32]) -> bool {
    match look.when {
        State::Hovered => hovered.contains(&look.of),
        State::Pressed => pressed.contains(&look.of),
    }
}

/// How wide a scroll thumb is, how far it sits from the box's edge, and the
/// shortest it gets however long the content.
pub const THUMB_WIDTH: f32 = 6.0;
const THUMB_INSET: f32 = 3.0;
const THUMB_SHORTEST: f32 = 24.0;

/// A grey that shows over light content and dark. Every thumb looks like
/// this: nothing styles one yet.
const THUMB: Color = Color {
    r: 0.45,
    g: 0.47,
    b: 0.52,
    a: 0.55,
};

/// Where a scroll thumb starts along a box `extent` long, and how long it
/// is, when the content runs `reach` past the box and is scrolled `scroll`
/// into it.
///
/// The thumb is to its track as the box is to the content, and sits as far
/// along the track as the box is through the content.
fn thumb(extent: f32, reach: f32, scroll: f32) -> (f32, f32) {
    let track = (extent - 2.0 * THUMB_INSET).max(0.0);
    let length = (track * extent / (extent + reach))
        .max(THUMB_SHORTEST)
        .min(track);
    let along = if reach > 0.0 { scroll / reach } else { 0.0 };
    (THUMB_INSET + (track - length) * along, length)
}

/// A scroll position kept within what is allowed: nowhere on an axis that
/// does not scroll, and otherwise between the content's near edge and as far
/// as it reaches.
fn within(scroll: f32, reach: f32, overflow: Overflow) -> f32 {
    match overflow {
        Overflow::Scroll => scroll.clamp(0.0, reach.max(0.0)),
        Overflow::Clip | Overflow::Hidden => 0.0,
    }
}

/// Whether `inner` lies wholly inside `outer`. Layout rounds to whole
/// pixels, so the slack is for arithmetic and not for a visible overlap.
fn contains(outer: Rect, inner: Rect) -> bool {
    const SLACK: f32 = 0.01;
    inner.x >= outer.x - SLACK
        && inner.y >= outer.y - SLACK
        && inner.x + inner.width <= outer.x + outer.width + SLACK
        && inner.y + inner.height <= outer.y + outer.height + SLACK
}

/// What a node's children are cut off at: what the node itself is cut off
/// at, narrowed to the node's own box when `narrows`.
///
/// Every box cuts off content that does not fit in it, on both axes. Most
/// boxes hold content that fits, and narrowing the clip for those would
/// change nothing drawn and cost a clip in the paint, so the caller asks for
/// it only where something sticks out or the box scrolls.
fn cut(clip: Option<Rect>, rect: Rect, narrows: bool) -> Option<Rect> {
    if !narrows {
        return clip;
    }
    let Some(outer) = clip else {
        return Some(rect);
    };
    let (left, top) = (outer.x.max(rect.x), outer.y.max(rect.y));
    let right = (outer.x + outer.width).min(rect.x + rect.width);
    let bottom = (outer.y + outer.height).min(rect.y + rect.height);
    Some(Rect {
        x: left,
        y: top,
        width: (right - left).max(0.0),
        height: (bottom - top).max(0.0),
    })
}

/// Whether two boxes share any area.
fn overlaps(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/// Unused today; kept so the background a scene draws on has one home.
pub const PAGE: Color = Color::rgb(1.0, 1.0, 1.0);

/// Write one binding's value into a template node, before the node reaches
/// the arena.
fn apply(node: &mut NodeDef, target: BindingTarget, value: &BindingValue) {
    match (target, value) {
        (BindingTarget::Content, BindingValue::Content(content)) => {
            if let Appearance::Text(held) = &mut node.appearance {
                held.content = content.clone();
            }
        }
        (BindingTarget::Style, BindingValue::Style(style)) => {
            node.appearance = Appearance::Fill(*style);
        }
        (BindingTarget::Style, BindingValue::TextStyle(style)) => {
            if let Appearance::Text(held) = &mut node.appearance {
                held.style = style.clone();
            }
        }
        (BindingTarget::Layout, BindingValue::Layout(layout)) => {
            node.layout = *layout;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::types::{Align, Axis, Edges, Justify, Length};

    /// Template ids are the guest's, so these pick their own. Distinct ids are
    /// distinct templates, which is what decides patch against replace.
    const DIAL: u32 = 7;
    const OTHER: u32 = 8;

    /// A plain box: no children, nothing drawn, sized by its content.
    fn blank() -> NodeDef {
        NodeDef {
            layout: Flex::default(),
            appearance: Appearance::Nothing,
            first_child: 0,
            child_count: 0,
            is_slot: false,
        }
    }

    fn text_node(s: &str) -> NodeDef {
        NodeDef {
            appearance: Appearance::Text(TextContent {
                content: s.to_owned(),
                style: TextStyle::default(),
            }),
            ..blank()
        }
    }

    fn row() -> Flex {
        Flex {
            axis: Axis::Row,
            ..Flex::default()
        }
    }

    fn fresh(id: u32, nodes: Vec<NodeDef>, bindings: Vec<Binding>) -> TemplateRef {
        with_states(id, nodes, bindings, vec![])
    }

    fn with_states(
        id: u32,
        nodes: Vec<NodeDef>,
        bindings: Vec<Binding>,
        states: Vec<StateStyle>,
    ) -> TemplateRef {
        TemplateRef::Fresh(TemplateDef {
            id,
            nodes,
            bindings,
            states,
        })
    }

    /// A one-node template: the node it is rendered into *is* the text, which
    /// is the one-box rule at its smallest.
    fn just_text(id: u32, s: &str) -> TemplateRef {
        fresh(id, vec![text_node(s)], vec![])
    }

    fn content_binding(node: u32) -> Binding {
        Binding {
            node,
            target: BindingTarget::Content,
        }
    }

    fn content(binding: u32, s: &str) -> Hole {
        Hole {
            binding,
            value: BindingValue::Content(s.to_owned()),
        }
    }

    fn window() -> Size {
        Size {
            width: 800.0,
            height: 600.0,
        }
    }

    fn glyphs(commands: &[Command]) -> Vec<Glyphs> {
        commands
            .iter()
            .filter_map(|c| match c {
                Command::Glyphs(g) => Some(*g),
                _ => None,
            })
            .collect()
    }

    /// The first render on the root installs the tree, and a frame after that
    /// asks nobody anything.
    #[test]
    fn a_rendered_tree_draws_without_anyone_being_asked() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(root, &just_text(DIAL, "hello"), &[], &mut text);

        let commands = scene.draw(window(), &mut text);
        assert_eq!(commands.len(), 1, "{commands:?}");
        assert!(matches!(commands[0], Command::Glyphs(_)));
        assert_eq!(scene.len(), 1, "a one-node template makes one node");
    }

    /// A template definition travels with its first use and never again: the
    /// second render names the same id and the host already has it.
    #[test]
    fn a_known_template_needs_no_definition() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(DIAL, vec![text_node("")], vec![content_binding(0)]),
            &[content(0, "one")],
            &mut text,
        );
        let before = scene.len();

        scene.render(
            root,
            &TemplateRef::Known(DIAL),
            &[content(0, "two")],
            &mut text,
        );

        assert_eq!(scene.len(), before, "a patch does not change the tree");
        assert_eq!(scene.draw(window(), &mut text).len(), 1);
    }

    /// The property the retained tree exists for: a different window size
    /// re-solves the same nodes, with nothing rebuilt.
    #[test]
    fn resizing_re_solves_the_same_tree() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    // The application's own box: fills the window and centres
                    // its one child on both axes.
                    NodeDef {
                        layout: Flex {
                            justify_content: Justify::Center,
                            align_items: Align::Center,
                            width: Length::Percent(100.0),
                            height: Length::Percent(100.0),
                            ..Flex::default()
                        },
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    text_node("hello"),
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        let before = scene.len();

        let wide = scene.draw(window(), &mut text);
        let narrow = scene.draw(
            Size {
                width: 400.0,
                height: 1000.0,
            },
            &mut text,
        );

        assert_eq!(scene.len(), before, "nothing was rebuilt");
        let (a, b) = (glyphs(&wide)[0], glyphs(&narrow)[0]);
        assert!(
            (a.x - b.x).abs() > 1.0 || (a.y - b.y).abs() > 1.0,
            "centring should move the text: {a:?} vs {b:?}"
        );
    }

    /// A different template shares nothing with the one before it, so what was
    /// there goes away — nodes and shaped text both — and the node it was
    /// rendered into is reconfigured rather than replaced.
    #[test]
    fn a_different_template_frees_the_old_nodes_and_their_text() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    NodeDef {
                        first_child: 1,
                        child_count: 2,
                        ..blank()
                    },
                    text_node("one"),
                    text_node("two"),
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        assert_eq!(scene.len(), 3, "the root and its two interior nodes");

        scene.render(root, &just_text(OTHER, "just one"), &[], &mut text);
        assert_eq!(scene.len(), 1, "the interior went away with the template");
        assert_eq!(scene.draw(window(), &mut text).len(), 1);
    }

    /// Writing a hole patches the node in place: same id, same shaped run,
    /// reshaped to the new content.
    #[test]
    fn a_hole_write_keeps_the_node_and_reshapes_its_run() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(DIAL, vec![text_node("")], vec![content_binding(0)]),
            &[content(0, "1")],
            &mut text,
        );

        let before = glyphs(&scene.draw(window(), &mut text))[0];
        let narrow = text.measure_run(before.run, None).width;

        scene.render(
            root,
            &TemplateRef::Known(DIAL),
            &[content(0, "100")],
            &mut text,
        );
        let after = glyphs(&scene.draw(window(), &mut text))[0];
        let wide = text.measure_run(after.run, None).width;

        assert_eq!(before.run, after.run, "the node was rebuilt, not patched");
        assert!(
            wide > narrow + 1.0,
            "'100' should measure wider: {narrow} then {wide}"
        );
    }

    /// The two child axes, which is the whole of the tree of trees: a parent
    /// renders its own interior, asks for the content of a slot it declared, and
    /// each child renders its interior into the node it was handed. Neither
    /// names a node inside the other.
    ///
    /// The slot itself is not a box: both children sit in the *parent's* row,
    /// side by side, which they could not if the slot laid them out.
    #[test]
    fn content_hangs_in_the_slot_its_parent_declared() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    NodeDef {
                        layout: row(),
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    NodeDef {
                        is_slot: true,
                        ..blank()
                    },
                ],
                vec![],
            ),
            &[],
            &mut text,
        );

        let children = scene
            .content(root, 0, 2, &mut text)
            .expect("the template declares one slot");
        assert_eq!(children.len(), 2);
        scene.render(children[0], &just_text(OTHER, "left"), &[], &mut text);
        scene.render(children[1], &just_text(OTHER, "right"), &[], &mut text);

        let drawn = glyphs(&scene.draw(window(), &mut text));
        assert_eq!(drawn.len(), 2, "both children draw");
        assert!(
            drawn[1].x > drawn[0].x && (drawn[0].y - drawn[1].y).abs() < 1.0,
            "a slot adds no box, so these lay out in the parent's row: {drawn:?}"
        );
        assert!(
            scene.content(root, 1, 1, &mut text).is_none(),
            "there is only one slot"
        );
    }

    /// Asking for fewer children drops the ones past the end, with everything
    /// beneath them. The only place a child is ever removed, and it is the
    /// parent's own call that does it.
    #[test]
    fn shrinking_a_slot_drops_what_is_past_the_end() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    NodeDef {
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    NodeDef {
                        is_slot: true,
                        ..blank()
                    },
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        let children = scene.content(root, 0, 2, &mut text).expect("one slot");
        for child in &children {
            scene.render(*child, &just_text(OTHER, "x"), &[], &mut text);
        }
        let kept = children[0];
        assert_eq!(scene.len(), 4, "the root, its slot, and two children");

        let left = scene.content(root, 0, 1, &mut text).expect("one slot");

        assert_eq!(left, vec![kept], "the first child keeps its identity");
        assert_eq!(scene.len(), 3, "the second child went away");
        assert_eq!(glyphs(&scene.draw(window(), &mut text)).len(), 1);
    }

    /// Re-rendering the same template leaves the content in its slots alone, so
    /// a parent that patches a hole does not disturb what a child put there.
    #[test]
    fn patching_a_parent_leaves_its_content_in_place() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        let page = fresh(
            DIAL,
            vec![
                NodeDef {
                    layout: row(),
                    first_child: 1,
                    child_count: 2,
                    ..blank()
                },
                text_node(""),
                NodeDef {
                    is_slot: true,
                    ..blank()
                },
            ],
            vec![content_binding(1)],
        );
        scene.render(root, &page, &[content(0, "title")], &mut text);
        let child = scene.content(root, 0, 1, &mut text).expect("one slot")[0];
        scene.render(child, &just_text(OTHER, "child"), &[], &mut text);
        let before = scene.len();

        scene.render(
            root,
            &TemplateRef::Known(DIAL),
            &[content(0, "new title")],
            &mut text,
        );

        assert_eq!(scene.len(), before, "the child survived the patch");
        assert_eq!(
            glyphs(&scene.draw(window(), &mut text)).len(),
            2,
            "the title and the child both still draw"
        );
    }

    #[test]
    fn a_fill_paints_a_quad_where_the_solve_put_it() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![NodeDef {
                    layout: Flex {
                        width: Length::Px(120.0),
                        height: Length::Px(40.0),
                        ..Flex::default()
                    },
                    appearance: Appearance::Fill(BoxStyle {
                        background: Some(Color::rgb(1.0, 0.0, 0.0)),
                        ..BoxStyle::default()
                    }),
                    ..blank()
                }],
                vec![],
            ),
            &[],
            &mut text,
        );
        let commands = scene.draw(window(), &mut text);
        let Command::Quad(q) = &commands[0] else {
            panic!("expected a quad, got {commands:?}");
        };
        assert_eq!((q.bounds.width, q.bounds.height), (120.0, 40.0));
    }

    /// A node deep in the tree keeps its place: children are contiguous and
    /// after their parent however the tree is shaped, because the flatten
    /// is breadth first.
    #[test]
    fn a_branching_tree_flattens_correctly() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        // host(a(x), b) — pre-order would put x between a and b and break the
        // contiguity `solve` needs.
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    NodeDef {
                        layout: row(),
                        first_child: 1,
                        child_count: 2,
                        ..blank()
                    },
                    NodeDef {
                        layout: row(),
                        first_child: 3,
                        child_count: 1,
                        ..blank()
                    },
                    text_node("b"),
                    text_node("x"),
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        let commands = scene.draw(window(), &mut text);
        assert_eq!(commands.len(), 2, "both leaves paint: {commands:?}");
    }

    const PANEL: u32 = 9;

    /// A box of a fixed size, for a test that needs to know where things are.
    fn sized(width: f32, height: f32) -> NodeDef {
        NodeDef {
            layout: Flex {
                width: Length::Px(width),
                height: Length::Px(height),
                ..Flex::default()
            },
            ..blank()
        }
    }

    fn hears(kind: PointerKind, scope: Scope, phase: Phase, id: u32) -> Listener {
        Listener {
            kind,
            scope,
            phase,
            id,
        }
    }

    fn moved(x: f32, y: f32) -> PointerInput {
        PointerInput::Moved { x, y }
    }

    fn pressed(x: f32, y: f32) -> PointerInput {
        PointerInput::Button {
            x,
            y,
            button: 0,
            down: true,
        }
    }

    /// The listener ids of every call, in the order the calls are made.
    fn heard(deliveries: &[Delivery]) -> Vec<u32> {
        deliveries
            .iter()
            .flat_map(|d| d.calls.iter().map(|c| c.listener))
            .collect()
    }

    /// A panel in the window's top left corner holding two buttons side by
    /// side, each 100 by 40, with 10 of padding round them:
    ///
    /// ```text
    /// template position   0 panel   1 left button   2 right button
    /// left button         x 10..110, y 10..50
    /// right button        x 110..210, y 10..50
    /// ```
    fn two_buttons(text: &mut TextEngine) -> (Scene, u32) {
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                PANEL,
                vec![
                    NodeDef {
                        layout: Flex {
                            axis: Axis::Row,
                            padding: Edges::all(10.0),
                            ..Flex::default()
                        },
                        first_child: 1,
                        child_count: 2,
                        ..blank()
                    },
                    sized(100.0, 40.0),
                    sized(100.0, 40.0),
                ],
                vec![],
            ),
            &[],
            text,
        );
        scene.draw(window(), text);
        (scene, root)
    }

    /// Nothing is hit before a frame has said where things are, and after
    /// one the node on top is the target: the button and not the panel
    /// under it.
    #[test]
    fn the_target_is_the_node_painted_on_top() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        let any = PointerKind::Down;
        assert!(scene.listen(root, 0, hears(any, Scope::Node, Phase::Bubble, 1)));
        assert!(scene.listen(root, 1, hears(any, Scope::Node, Phase::Bubble, 2)));
        assert!(scene.listen(root, 2, hears(any, Scope::Node, Phase::Bubble, 3)));

        assert_eq!(heard(&scene.pointer(pressed(50.0, 30.0))), vec![2]);
        assert_eq!(heard(&scene.pointer(pressed(150.0, 30.0))), vec![3]);
        assert_eq!(
            heard(&scene.pointer(pressed(5.0, 5.0))),
            vec![1],
            "the padding is the panel's own"
        );
        assert!(
            scene.pointer(pressed(700.0, 500.0)).is_empty(),
            "the panel is as large as its content, and this is outside it"
        );
    }

    /// An input over nodes that hear nothing makes no call at all, which is
    /// what keeps a pointer crossing the window from entering the component.
    #[test]
    fn an_input_nothing_hears_makes_no_delivery() {
        let mut text = TextEngine::new();
        let (mut scene, _) = two_buttons(&mut text);
        assert!(scene.pointer(moved(50.0, 30.0)).is_empty());
        assert!(scene.pointer(pressed(50.0, 30.0)).is_empty());
        assert!(scene.pointer(PointerInput::Left).is_empty());
    }

    /// Scope is what lets a container hear its children: a `subtree`
    /// listener on the panel hears a press on a button, and a `node` listener
    /// on the panel does not.
    #[test]
    fn scope_decides_whether_a_node_hears_what_is_beneath_it() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        scene.listen(
            root,
            0,
            hears(PointerKind::Down, Scope::Subtree, Phase::Bubble, 1),
        );
        scene.listen(
            root,
            0,
            hears(PointerKind::Down, Scope::Node, Phase::Bubble, 2),
        );

        assert_eq!(heard(&scene.pointer(pressed(50.0, 30.0))), vec![1]);
        assert_eq!(heard(&scene.pointer(pressed(5.0, 5.0))), vec![1, 2]);
    }

    /// The order along the path: `intercept` listeners from the root down to
    /// the target, then `bubble` listeners from the target back up. The
    /// delivery stops at the first listener that handles it.
    #[test]
    fn a_press_is_offered_down_the_path_and_then_back_up() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        let down = PointerKind::Down;
        scene.listen(root, 0, hears(down, Scope::Subtree, Phase::Bubble, 1));
        scene.listen(root, 1, hears(down, Scope::Subtree, Phase::Bubble, 2));
        scene.listen(root, 0, hears(down, Scope::Subtree, Phase::Intercept, 3));
        scene.listen(root, 1, hears(down, Scope::Subtree, Phase::Intercept, 4));

        let deliveries = scene.pointer(pressed(50.0, 30.0));
        assert_eq!(heard(&deliveries), vec![3, 4, 2, 1]);
        assert!(deliveries[0].stops_when_handled);
    }

    /// A listener is told where the pointer is in its own node's box, so the
    /// same press reads (40, 20) to the button and (50, 30) to the panel.
    #[test]
    fn a_position_is_measured_from_the_listening_node() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        let down = PointerKind::Down;
        scene.listen(root, 1, hears(down, Scope::Subtree, Phase::Bubble, 1));
        scene.listen(root, 0, hears(down, Scope::Subtree, Phase::Bubble, 2));

        let deliveries = scene.pointer(pressed(50.0, 30.0));
        let at: Vec<(f32, f32)> = deliveries[0]
            .calls
            .iter()
            .map(|c| (c.event.x, c.event.y))
            .collect();
        assert_eq!(at, vec![(40.0, 20.0), (50.0, 30.0)]);
    }

    /// `enter` and `leave` report a scope gaining and losing the target.
    /// Moving from one button to the other leaves the first and enters the
    /// second, and says nothing to the panel, whose subtree the pointer never
    /// left. Leaving the window leaves everything.
    #[test]
    fn enter_and_leave_report_a_scope_gaining_and_losing_the_target() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        let (enter, leave) = (PointerKind::Enter, PointerKind::Leave);
        scene.listen(root, 0, hears(enter, Scope::Subtree, Phase::Bubble, 10));
        scene.listen(root, 0, hears(leave, Scope::Subtree, Phase::Bubble, 11));
        scene.listen(root, 1, hears(enter, Scope::Subtree, Phase::Bubble, 20));
        scene.listen(root, 1, hears(leave, Scope::Subtree, Phase::Bubble, 21));
        scene.listen(root, 2, hears(enter, Scope::Subtree, Phase::Bubble, 30));
        scene.listen(root, 2, hears(leave, Scope::Subtree, Phase::Bubble, 31));

        let into_left = scene.pointer(moved(50.0, 30.0));
        assert_eq!(
            heard(&into_left),
            vec![10, 20],
            "the panel, then the button in it"
        );
        assert!(!into_left[0].stops_when_handled);

        assert!(
            scene.pointer(moved(60.0, 30.0)).is_empty(),
            "moving within one node crosses nothing"
        );
        assert_eq!(heard(&scene.pointer(moved(150.0, 30.0))), vec![21, 30]);
        assert_eq!(
            heard(&scene.pointer(PointerInput::Left)),
            vec![31, 11],
            "the button, then the panel it is in"
        );
    }

    /// With `node` scope the panel hears the pointer reach and leave its own
    /// box, which moving onto one of its buttons does.
    #[test]
    fn a_node_scope_hears_its_own_box_gaining_and_losing_the_target() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        scene.listen(
            root,
            0,
            hears(PointerKind::Enter, Scope::Node, Phase::Bubble, 1),
        );
        scene.listen(
            root,
            0,
            hears(PointerKind::Leave, Scope::Node, Phase::Bubble, 2),
        );

        assert_eq!(heard(&scene.pointer(moved(5.0, 5.0))), vec![1]);
        assert_eq!(heard(&scene.pointer(moved(50.0, 30.0))), vec![2]);
        assert_eq!(heard(&scene.pointer(moved(5.0, 5.0))), vec![1]);
    }

    /// A parent hears its content through the slot it declared, without
    /// holding the child: the path an event travels is the tree's, and the
    /// slot is on it though it has no box.
    #[test]
    fn a_listener_on_a_slot_hears_the_content_hanging_in_it() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    NodeDef {
                        layout: Flex {
                            padding: Edges::all(10.0),
                            ..Flex::default()
                        },
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    NodeDef {
                        is_slot: true,
                        ..blank()
                    },
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        let child = scene.content(root, 0, 1, &mut text).expect("one slot")[0];
        scene.render(
            child,
            &fresh(OTHER, vec![sized(100.0, 40.0)], vec![]),
            &[],
            &mut text,
        );
        scene.draw(window(), &mut text);
        scene.listen(
            root,
            1,
            hears(PointerKind::Down, Scope::Subtree, Phase::Bubble, 1),
        );

        let deliveries = scene.pointer(pressed(50.0, 30.0));
        assert_eq!(heard(&deliveries), vec![1]);
        let event = deliveries[0].calls[0].event;
        assert_eq!(
            (event.x, event.y),
            (50.0, 30.0),
            "a slot has no box, so the position is in the box that contains it"
        );
    }

    /// Listeners belong to the interior they were registered in. A patch
    /// keeps them, and a different template drops them with everything else
    /// the old one had.
    #[test]
    fn a_listener_lasts_as_long_as_its_interior() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        let button = |id| {
            fresh(
                id,
                vec![
                    NodeDef {
                        first_child: 1,
                        child_count: 1,
                        ..sized(100.0, 40.0)
                    },
                    text_node(""),
                ],
                vec![content_binding(1)],
            )
        };
        scene.render(root, &button(DIAL), &[content(0, "one")], &mut text);
        scene.listen(
            root,
            0,
            hears(PointerKind::Down, Scope::Subtree, Phase::Bubble, 1),
        );
        scene.draw(window(), &mut text);
        assert_eq!(heard(&scene.pointer(pressed(50.0, 20.0))), vec![1]);

        scene.render(
            root,
            &TemplateRef::Known(DIAL),
            &[content(0, "two")],
            &mut text,
        );
        scene.draw(window(), &mut text);
        assert_eq!(
            heard(&scene.pointer(pressed(50.0, 20.0))),
            vec![1],
            "a patch keeps it"
        );

        scene.render(root, &button(OTHER), &[content(0, "three")], &mut text);
        scene.draw(window(), &mut text);
        assert!(
            scene.pointer(pressed(50.0, 20.0)).is_empty(),
            "a different template starts with no listeners"
        );
    }

    /// A node dropped while the pointer is over it cannot be left later: its
    /// id is free to be reused, and a `leave` sent to whatever reuses it would
    /// be about a node the pointer was never over.
    #[test]
    fn a_dropped_node_is_no_longer_under_the_pointer() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                DIAL,
                vec![
                    NodeDef {
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    NodeDef {
                        is_slot: true,
                        ..blank()
                    },
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        let leaf = fresh(OTHER, vec![sized(100.0, 40.0)], vec![]);
        let first = scene.content(root, 0, 1, &mut text).expect("one slot")[0];
        scene.render(first, &leaf, &[], &mut text);
        scene.draw(window(), &mut text);
        scene.pointer(moved(50.0, 20.0));

        scene.content(root, 0, 0, &mut text);
        assert!(
            scene.pointer(pressed(50.0, 20.0)).is_empty(),
            "nothing is there until a frame places something"
        );
        let second = scene.content(root, 0, 1, &mut text).expect("one slot")[0];
        assert_eq!(
            second, first,
            "the id is reused, which is what makes this matter"
        );
        scene.render(second, &leaf, &[], &mut text);
        scene.listen(
            second,
            0,
            hears(PointerKind::Leave, Scope::Subtree, Phase::Bubble, 1),
        );
        scene.listen(
            second,
            0,
            hears(PointerKind::Enter, Scope::Subtree, Phase::Bubble, 2),
        );
        scene.draw(window(), &mut text);

        assert_eq!(
            heard(&scene.pointer(moved(50.0, 20.0))),
            vec![2],
            "the new node is entered, and was never left"
        );
    }

    fn released(x: f32, y: f32) -> PointerInput {
        PointerInput::Button {
            x,
            y,
            button: 0,
            down: false,
        }
    }

    fn filled(r: f32) -> BoxStyle {
        BoxStyle {
            background: Some(Color::rgb(r, 0.0, 0.0)),
            ..BoxStyle::default()
        }
    }

    /// The red of each quad's fill, in paint order, scroll thumbs aside.
    fn reds(commands: &[Command]) -> Vec<f32> {
        commands
            .iter()
            .filter_map(|c| match c {
                Command::Quad(q) if q.background != Some(THUMB) => q.background.map(|c| c.r),
                _ => None,
            })
            .collect()
    }

    const PLAIN: f32 = 0.1;
    const HOVERED: f32 = 0.5;
    const PRESSED: f32 = 0.9;

    fn look(node: u32, when: State, of: u32, style: Restyle) -> StateStyle {
        StateStyle {
            node,
            when,
            of,
            style,
        }
    }

    /// [`two_buttons`] with a fill on each button, a look for each while it
    /// is hovered and another while it is pressed, and a hole for the left
    /// button's layout.
    fn two_styled_buttons(text: &mut TextEngine) -> (Scene, u32) {
        let button = || NodeDef {
            appearance: Appearance::Fill(filled(PLAIN)),
            ..sized(100.0, 40.0)
        };
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &with_states(
                PANEL,
                vec![
                    NodeDef {
                        layout: Flex {
                            axis: Axis::Row,
                            padding: Edges::all(10.0),
                            ..Flex::default()
                        },
                        first_child: 1,
                        child_count: 2,
                        ..blank()
                    },
                    button(),
                    button(),
                ],
                vec![Binding {
                    node: 1,
                    target: BindingTarget::Layout,
                }],
                vec![
                    look(1, State::Hovered, 1, Restyle::Fill(filled(HOVERED))),
                    look(1, State::Pressed, 1, Restyle::Fill(filled(PRESSED))),
                    look(2, State::Hovered, 2, Restyle::Fill(filled(HOVERED))),
                    look(2, State::Pressed, 2, Restyle::Fill(filled(PRESSED))),
                ],
            ),
            &[],
            text,
        );
        scene.draw(window(), text);
        (scene, root)
    }

    /// A look is drawn while its state holds and at no other time, with
    /// nobody called: the template said how the button looks hovered and
    /// pressed, and the scene knows which of those it is.
    #[test]
    fn a_look_is_drawn_while_its_state_holds() {
        let mut text = TextEngine::new();
        let (mut scene, _) = two_styled_buttons(&mut text);
        let mut after = |scene: &mut Scene, input| {
            let deliveries = scene.pointer(input);
            assert!(deliveries.is_empty(), "nothing listens: {deliveries:?}");
            assert!(scene.dirty, "{input:?} changed a look and owes a frame");
            reds(&scene.draw(window(), &mut text))
        };

        assert_eq!(after(&mut scene, moved(50.0, 30.0)), vec![HOVERED, PLAIN]);
        assert_eq!(after(&mut scene, pressed(50.0, 30.0)), vec![PRESSED, PLAIN]);
        assert_eq!(
            after(&mut scene, moved(150.0, 30.0)),
            vec![PRESSED, HOVERED],
            "a press lasts until the button comes up, wherever the pointer goes"
        );
        assert_eq!(
            after(&mut scene, released(150.0, 30.0)),
            vec![PLAIN, HOVERED]
        );
        assert_eq!(after(&mut scene, PointerInput::Left), vec![PLAIN, PLAIN]);
    }

    /// The pointer moving where no look depends on it owes no frame. The
    /// panel's padding has no look, and neither does moving about inside one
    /// button.
    #[test]
    fn the_pointer_owes_a_frame_only_where_a_look_depends_on_it() {
        let mut text = TextEngine::new();
        let (mut scene, _) = two_styled_buttons(&mut text);

        scene.pointer(moved(5.0, 5.0));
        assert!(!scene.dirty, "the padding looks the same hovered");
        scene.pointer(moved(50.0, 30.0));
        assert!(scene.dirty, "the button does not");
        scene.draw(window(), &mut text);
        scene.pointer(moved(60.0, 30.0));
        assert!(!scene.dirty, "it was already hovered");
        scene.pointer(PointerInput::Button {
            x: 60.0,
            y: 30.0,
            button: 2,
            down: true,
        });
        assert!(!scene.dirty, "only the primary button presses");
    }

    /// A look can read another node's state. A label takes a look while the
    /// button it is in is hovered, so it changes when the pointer is on the
    /// button's padding and not on the label at all.
    #[test]
    fn a_look_can_read_the_state_of_another_node() {
        let quiet = TextStyle::default();
        let loud = TextStyle {
            size: quiet.size * 2.0,
            ..quiet.clone()
        };
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &with_states(
                DIAL,
                vec![
                    NodeDef {
                        layout: Flex {
                            padding: Edges::all(10.0),
                            ..Flex::default()
                        },
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    text_node("go"),
                ],
                vec![content_binding(1)],
                vec![look(1, State::Hovered, 0, Restyle::Text(loud.clone()))],
            ),
            &[],
            &mut text,
        );
        let run = glyphs(&scene.draw(window(), &mut text))[0].run;
        let style = |text: &TextEngine| text.get(run).expect("a live run").style().clone();
        assert_eq!(style(&text), quiet);

        scene.pointer(moved(2.0, 2.0));
        let hovered = glyphs(&scene.draw(window(), &mut text))[0];
        assert_eq!(hovered.run, run, "the node is restyled, not rebuilt");
        assert_eq!(style(&text), loud);

        // A hole written while the look is showing changes what the node
        // says and leaves how it looks.
        scene.render(
            root,
            &TemplateRef::Known(DIAL),
            &[content(0, "stop")],
            &mut text,
        );
        scene.draw(window(), &mut text);
        assert_eq!(text.get(run).expect("a live run").content(), "stop");
        assert_eq!(style(&text), loud);

        scene.pointer(PointerInput::Left);
        scene.draw(window(), &mut text);
        assert_eq!(style(&text), quiet);
    }

    /// The tree can move under a pointer that does not. The left button
    /// shrinks to nothing and the right one slides under the pointer, with no
    /// input to say so: the frame that solves the new layout is what notices,
    /// draws the right button hovered, and keeps the `leave` and `enter` it
    /// found owed for whoever delivers them.
    #[test]
    fn a_frame_notices_what_moved_under_a_still_pointer() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_styled_buttons(&mut text);
        scene.listen(
            root,
            1,
            hears(PointerKind::Leave, Scope::Subtree, Phase::Bubble, 1),
        );
        scene.listen(
            root,
            2,
            hears(PointerKind::Enter, Scope::Subtree, Phase::Bubble, 2),
        );
        scene.pointer(moved(50.0, 30.0));
        assert_eq!(reds(&scene.draw(window(), &mut text)), vec![HOVERED, PLAIN]);
        assert!(scene.take_owed().is_empty());

        scene.render(
            root,
            &TemplateRef::Known(PANEL),
            &[Hole {
                binding: 0,
                value: BindingValue::Layout(Flex {
                    width: Length::Px(0.0),
                    height: Length::Px(40.0),
                    ..Flex::default()
                }),
            }],
            &mut text,
        );
        let drawn = scene.draw(window(), &mut text);

        assert_eq!(reds(&drawn), vec![PLAIN, HOVERED]);
        assert_eq!(heard(&scene.take_owed()), vec![1, 2]);
        assert!(
            !scene.dirty,
            "a fill's look is drawn in the frame that finds it, so none follows"
        );
    }

    /// A text node's look can change how wide its run is, so a frame that
    /// finds one changed cannot lay it out: the solve is over. It shapes the
    /// run with the new look and owes one more frame, which lays it out.
    #[test]
    fn a_text_look_found_by_a_frame_is_laid_out_in_the_next() {
        let quiet = TextStyle::default();
        let loud = TextStyle {
            size: quiet.size * 2.0,
            ..quiet.clone()
        };
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &with_states(
                PANEL,
                vec![
                    NodeDef {
                        layout: row(),
                        first_child: 1,
                        child_count: 2,
                        ..blank()
                    },
                    sized(100.0, 40.0),
                    text_node("go"),
                ],
                vec![Binding {
                    node: 1,
                    target: BindingTarget::Layout,
                }],
                vec![look(2, State::Hovered, 2, Restyle::Text(loud.clone()))],
            ),
            &[],
            &mut text,
        );
        let before = glyphs(&scene.draw(window(), &mut text))[0];
        scene.pointer(moved(5.0, 5.0));
        scene.draw(window(), &mut text);
        assert!(
            !scene.dirty,
            "the pointer is over the box, which has no look"
        );

        // The box shrinks to nothing and the text slides under the pointer.
        scene.render(
            root,
            &TemplateRef::Known(PANEL),
            &[Hole {
                binding: 0,
                value: BindingValue::Layout(Flex {
                    width: Length::Px(0.0),
                    height: Length::Px(40.0),
                    ..Flex::default()
                }),
            }],
            &mut text,
        );
        scene.draw(window(), &mut text);
        assert_eq!(text.get(before.run).expect("a live run").style(), &loud);
        assert!(scene.dirty, "the run changed size after the solve");

        scene.draw(window(), &mut text);
        assert!(
            !scene.dirty,
            "and the frame that lays it out finds nothing new"
        );
    }

    /// A pointer that has left the window is over nothing, so a frame does
    /// not put it back over whatever is at the place it left from.
    #[test]
    fn a_pointer_outside_the_window_is_over_nothing() {
        let mut text = TextEngine::new();
        let (mut scene, _) = two_styled_buttons(&mut text);
        scene.pointer(moved(50.0, 30.0));
        scene.pointer(PointerInput::Left);

        assert_eq!(reds(&scene.draw(window(), &mut text)), vec![PLAIN, PLAIN]);
        assert!(!scene.dirty);
    }

    /// A removed listener hears nothing more, and the others on its node
    /// are left as they were. Removing one twice, or one that never was,
    /// does nothing.
    #[test]
    fn a_removed_listener_hears_nothing_more() {
        let mut text = TextEngine::new();
        let (mut scene, root) = two_buttons(&mut text);
        let down = PointerKind::Down;
        scene.listen(root, 1, hears(down, Scope::Subtree, Phase::Bubble, 1));
        scene.listen(root, 1, hears(down, Scope::Subtree, Phase::Bubble, 2));

        scene.unlisten(1);
        scene.unlisten(1);
        scene.unlisten(99);

        assert_eq!(heard(&scene.pointer(pressed(50.0, 30.0))), vec![2]);
        assert!(scene.take_ended().is_empty(), "nothing ended on its own");
    }

    /// A listener ends when its node goes away, and the scene says which
    /// ended so that whoever holds the other end of each can end it too. A
    /// node goes away when its interior is replaced or its slot shrinks. A
    /// listener on the node a template is rendered into goes with that
    /// template, though the node stays.
    #[test]
    fn the_scene_reports_the_listeners_whose_nodes_went_away() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        let page = |id| {
            fresh(
                id,
                vec![
                    NodeDef {
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    NodeDef {
                        is_slot: true,
                        ..blank()
                    },
                ],
                vec![],
            )
        };
        let any = |id| hears(PointerKind::Down, Scope::Subtree, Phase::Bubble, id);
        scene.render(root, &page(DIAL), &[], &mut text);
        scene.listen(root, 0, any(1));
        let children = scene.content(root, 0, 2, &mut text).expect("one slot");
        for (child, id) in children.iter().zip([2, 3]) {
            scene.render(*child, &just_text(OTHER, "x"), &[], &mut text);
            scene.listen(*child, 0, any(id));
        }
        assert!(scene.take_ended().is_empty());

        scene.content(root, 0, 1, &mut text);
        assert_eq!(scene.take_ended(), vec![3], "the second child went");
        assert!(scene.take_ended().is_empty(), "and is reported once");

        scene.render(root, &page(PANEL), &[], &mut text);
        let mut ended = scene.take_ended();
        ended.sort();
        assert_eq!(ended, vec![1, 2], "the page's own, and its other child's");
    }

    const LIST: u32 = 11;

    /// A row of a list: 100 by 40, and as tall as that however little room
    /// there is. A flex item gives up height before it overflows unless it
    /// is told not to, and a list whose rows did would never need to scroll.
    fn list_row(red: f32) -> NodeDef {
        NodeDef {
            layout: Flex {
                shrink: 0.0,
                ..sized(100.0, 40.0).layout
            },
            appearance: Appearance::Fill(filled(red)),
            ..blank()
        }
    }

    /// A list in the window's top left corner: a box 100 by 100 holding five
    /// rows of 40, so twice as much as fits. Position 1 is the list and
    /// positions 2 to 6 its rows, each with a look for when it is hovered.
    fn a_list(text: &mut TextEngine, overflow_y: Overflow) -> (Scene, u32) {
        let mut scene = Scene::new();
        let root = scene.root();
        let mut nodes = vec![
            NodeDef {
                first_child: 1,
                child_count: 1,
                ..blank()
            },
            NodeDef {
                layout: Flex {
                    overflow_y,
                    ..sized(100.0, 100.0).layout
                },
                first_child: 2,
                child_count: 5,
                ..blank()
            },
        ];
        nodes.extend((0..5).map(|_| list_row(PLAIN)));
        let looks = (2..7)
            .map(|at| look(at, State::Hovered, at, Restyle::Fill(filled(HOVERED))))
            .collect();
        scene.render(root, &with_states(LIST, nodes, vec![], looks), &[], text);
        scene.draw(window(), text);
        (scene, root)
    }

    /// Draw until a frame owes no other, and return the last one. A frame
    /// that finds a new row under the pointer is followed by one more.
    fn settled(scene: &mut Scene, text: &mut TextEngine) -> Vec<Command> {
        let mut commands = scene.draw(window(), text);
        for _ in 0..4 {
            if !scene.dirty {
                break;
            }
            commands = scene.draw(window(), text);
        }
        assert!(!scene.dirty, "the scene never stopped asking for frames");
        commands
    }

    fn wheel(dy: f32) -> PointerInput {
        PointerInput::Wheel {
            x: 50.0,
            y: 10.0,
            dx: 0.0,
            dy,
        }
    }

    /// The top of each row a frame draws, in paint order.
    fn tops(commands: &[Command]) -> Vec<f32> {
        commands
            .iter()
            .filter_map(|c| match c {
                Command::Quad(q) if q.background != Some(THUMB) => Some(q.bounds.y),
                _ => None,
            })
            .collect()
    }

    /// The scroll thumbs a frame draws.
    fn thumbs(commands: &[Command]) -> Vec<Rect> {
        commands
            .iter()
            .filter_map(|c| match c {
                Command::Quad(q) if q.background == Some(THUMB) => Some(q.bounds),
                _ => None,
            })
            .collect()
    }

    /// Content past the edge of a scrolling box is cut off there. The rows
    /// that show are drawn inside a clip of the list's own box, and the two
    /// that are wholly past it are not drawn at all.
    #[test]
    fn content_past_a_scrolling_box_is_cut_off() {
        let mut text = TextEngine::new();
        let (mut scene, _) = a_list(&mut text, Overflow::Scroll);
        let commands = scene.draw(window(), &mut text);

        let list = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        assert_eq!(commands.first(), Some(&Command::PushClip(list)));
        assert_eq!(tops(&commands), vec![0.0, 40.0, 80.0]);
        assert_eq!(
            commands[4],
            Command::PopClip,
            "the clip closes after the three rows"
        );
    }

    /// A box with further to scroll shows a thumb down its right edge: as
    /// long, against its track, as the box is against the content, and as far
    /// along. The list is 100 tall over 200 of rows, so the thumb is half of
    /// a 94 long track, at its top and then at its bottom. A box whose
    /// content fits shows none.
    #[test]
    fn a_thumb_shows_how_much_shows_and_where() {
        let mut text = TextEngine::new();
        let (mut scene, _) = a_list(&mut text, Overflow::Scroll);

        let at_the_top = thumbs(&scene.draw(window(), &mut text));
        assert_eq!(
            at_the_top,
            vec![Rect {
                x: 100.0 - 3.0 - THUMB_WIDTH,
                y: 3.0,
                width: THUMB_WIDTH,
                height: 47.0,
            }]
        );

        scene.pointer(wheel(1000.0));
        let at_the_bottom = thumbs(&settled(&mut scene, &mut text));
        assert_eq!(at_the_bottom[0].y, 100.0 - 3.0 - 47.0);

        let (mut hidden, _) = a_list(&mut text, Overflow::Hidden);
        assert!(thumbs(&hidden.draw(window(), &mut text)).is_empty());
    }

    /// A frame solves layout only when the answer could differ. Scrolling
    /// and hovering change where and how things are drawn and not where the
    /// solve puts them, so the frames after them reuse the last answer. A
    /// write to the tree, or a window of another size, asks again.
    #[test]
    fn scrolling_and_hovering_solve_nothing() {
        let mut text = TextEngine::new();
        let (mut scene, root) = a_list(&mut text, Overflow::Scroll);
        let solves = scene.solves;

        scene.pointer(moved(50.0, 10.0));
        scene.draw(window(), &mut text);
        scene.pointer(wheel(40.0));
        scene.draw(window(), &mut text);
        scene.draw(window(), &mut text);
        assert_eq!(scene.solves, solves, "nothing the solver reads changed");

        let wider = Size {
            width: 900.0,
            height: 600.0,
        };
        scene.draw(wider, &mut text);
        assert_eq!(scene.solves, solves + 1, "the window changed size");

        scene.render(root, &TemplateRef::Known(LIST), &[], &mut text);
        scene.draw(wider, &mut text);
        assert_eq!(scene.solves, solves + 2, "the component wrote the tree");
    }

    /// The wheel moves the content, as far as its last row's bottom edge
    /// reaching the list's and no further, and back as far as the top.
    /// Nothing is told about it: the scene keeps how far a node is scrolled.
    #[test]
    fn the_wheel_scrolls_as_far_as_the_content_reaches() {
        let mut text = TextEngine::new();
        let (mut scene, _) = a_list(&mut text, Overflow::Scroll);
        // Bring the pointer over the list first, so that what follows is the
        // wheel's doing and not the pointer arriving.
        scene.pointer(moved(50.0, 10.0));
        settled(&mut scene, &mut text);

        assert!(
            scene.pointer(wheel(50.0)).is_empty(),
            "no listener hears the wheel"
        );
        assert!(scene.dirty, "the content moved, so a frame is owed");
        assert_eq!(
            tops(&settled(&mut scene, &mut text)),
            vec![-10.0, 30.0, 70.0],
            "the first row is wholly above the list now, and not drawn"
        );

        scene.pointer(wheel(1000.0));
        assert_eq!(
            tops(&settled(&mut scene, &mut text)),
            vec![-20.0, 20.0, 60.0],
            "200 of rows in 100 of list scroll 100"
        );
        scene.pointer(wheel(10.0));
        assert!(!scene.dirty, "it is at its end, so nothing moved");

        scene.pointer(wheel(-1000.0));
        assert_eq!(tops(&settled(&mut scene, &mut text)), vec![0.0, 40.0, 80.0]);
    }

    /// The pointer is over what is drawn under it. After the list scrolls,
    /// a press at the same place lands on the row that moved there, and a
    /// press below the list lands on nothing, though a row is laid out there.
    #[test]
    fn a_press_lands_on_what_scrolled_under_it_and_not_on_what_is_cut_off() {
        let mut text = TextEngine::new();
        let (mut scene, root) = a_list(&mut text, Overflow::Scroll);
        for at in 2..7 {
            scene.listen(
                root,
                at,
                hears(PointerKind::Down, Scope::Node, Phase::Bubble, at),
            );
        }
        assert_eq!(heard(&scene.pointer(pressed(50.0, 10.0))), vec![2]);
        assert!(
            scene.pointer(pressed(50.0, 130.0)).is_empty(),
            "the fourth row is laid out here and cut off"
        );

        scene.pointer(wheel(100.0));
        scene.draw(window(), &mut text);

        assert_eq!(heard(&scene.pointer(pressed(50.0, 10.0))), vec![4]);
        let deliveries = scene.pointer(pressed(50.0, 30.0));
        assert_eq!(heard(&deliveries), vec![5]);
        assert_eq!(
            deliveries[0].calls[0].event.y, 10.0,
            "measured from where the row is drawn"
        );
    }

    /// A row scrolled under a pointer that did not move is hovered, in the
    /// frame that draws it there: the frame after a scroll tests the pointer
    /// against where things now are.
    #[test]
    fn the_row_scrolled_under_the_pointer_is_hovered() {
        let mut text = TextEngine::new();
        let (mut scene, _) = a_list(&mut text, Overflow::Scroll);
        scene.pointer(moved(50.0, 10.0));
        assert_eq!(
            reds(&scene.draw(window(), &mut text)),
            vec![HOVERED, PLAIN, PLAIN]
        );

        scene.pointer(wheel(40.0));
        assert_eq!(
            reds(&scene.draw(window(), &mut text)),
            vec![HOVERED, PLAIN, PLAIN],
            "the second row is the first one drawn now, and under the pointer"
        );
        assert_eq!(
            tops(&scene.draw(window(), &mut text)),
            vec![0.0, 40.0, 80.0]
        );
    }

    /// A box that cuts its content off without scrolling ignores the wheel.
    #[test]
    fn only_a_scrolling_box_scrolls() {
        let mut text = TextEngine::new();
        for cuts in [Overflow::Hidden, Overflow::Clip] {
            let (mut list, _) = a_list(&mut text, cuts);
            list.pointer(moved(50.0, 10.0));
            settled(&mut list, &mut text);
            list.pointer(wheel(50.0));
            assert!(!list.dirty, "{cuts:?}");
            assert_eq!(
                tops(&list.draw(window(), &mut text)),
                vec![0.0, 40.0, 80.0],
                "{cuts:?}"
            );
        }
    }

    /// Rows that do not fit in a box are cut off at it though the box says
    /// nothing about overflow: nothing is drawn outside a box. The part of a
    /// row that is cut off is not under the pointer either.
    #[test]
    fn content_that_does_not_fit_is_cut_off_by_default() {
        let mut text = TextEngine::new();
        let (mut list, root) = a_list(&mut text, Overflow::default());
        list.listen(
            root,
            5,
            hears(PointerKind::Down, Scope::Node, Phase::Bubble, 5),
        );

        let commands = list.draw(window(), &mut text);

        assert_eq!(tops(&commands), vec![0.0, 40.0, 80.0]);
        assert!(
            commands.contains(&Command::PushClip(Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            })),
            "the list cuts its rows off at its own box"
        );
        assert!(
            heard(&list.pointer(pressed(50.0, 130.0))).is_empty(),
            "where the fourth row would have been"
        );
    }

    /// A box whose content fits is not given a clip, so cutting off by
    /// default costs the paint nothing where there is nothing to cut.
    #[test]
    fn a_box_whose_content_fits_is_drawn_with_no_clip() {
        let mut text = TextEngine::new();
        let (mut scene, _) = two_styled_buttons(&mut text);

        let commands = scene.draw(window(), &mut text);

        assert!(!commands.iter().any(|c| matches!(c, Command::PushClip(_))));
    }

    /// A node already at its end passes the wheel to the one it sits in. The
    /// inner list has 20 further to go and the outer one 100: three turns of
    /// 20 scroll the inner once and then the outer twice.
    #[test]
    fn a_scroller_at_its_end_passes_the_wheel_outward() {
        let scrolls = |height| Flex {
            overflow_y: Overflow::Scroll,
            shrink: 0.0,
            ..sized(100.0, height).layout
        };
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.root();
        scene.render(
            root,
            &fresh(
                LIST,
                vec![
                    NodeDef {
                        first_child: 1,
                        child_count: 1,
                        ..blank()
                    },
                    // The outer list: 100 tall, holding 100 of inner list and
                    // 100 of footer.
                    NodeDef {
                        layout: scrolls(100.0),
                        first_child: 2,
                        child_count: 2,
                        ..blank()
                    },
                    // The inner list: 100 tall, holding three rows of 40.
                    NodeDef {
                        layout: scrolls(100.0),
                        first_child: 4,
                        child_count: 3,
                        ..blank()
                    },
                    NodeDef {
                        layout: Flex {
                            shrink: 0.0,
                            ..sized(100.0, 100.0).layout
                        },
                        ..blank()
                    },
                    list_row(PLAIN),
                    list_row(PLAIN),
                    list_row(PLAIN),
                ],
                vec![],
            ),
            &[],
            &mut text,
        );
        scene.draw(window(), &mut text);
        let mut turn = |scene: &mut Scene| {
            scene.pointer(wheel(20.0));
            tops(&scene.draw(window(), &mut text))
        };

        assert_eq!(
            turn(&mut scene),
            vec![-20.0, 20.0, 60.0],
            "the inner list scrolled"
        );
        assert_eq!(
            turn(&mut scene),
            vec![0.0, 40.0],
            "it had no further to go, so the outer one took it 20 up"
        );
        assert_eq!(turn(&mut scene), vec![-20.0, 20.0]);
    }
}

