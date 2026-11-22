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
use super::layout::{measure_text, solve_with};
use super::text::TextEngine;
use super::types::{
    BoxStyle, Color, Command, Content, Flex, Glyphs, Length, Measured, Node as FlatNode, Quad,
    Rect, Size, TextStyle,
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

/// A template the first time it is used. The id is the guest's.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct TemplateDef {
    pub id: u32,
    pub nodes: Vec<NodeDef>,
    pub bindings: Vec<Binding>,
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
    /// Where the pointer last was, for a `leave` that arrives with no
    /// position because the pointer left the window.
    pointer: (f32, f32),
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
            let (nodes, bindings) = (def.nodes.clone(), def.bindings.clone());
            self.build_interior(node, id, &nodes, &bindings, holes, text);
            return;
        }

        let bindings = def.bindings.clone();
        for hole in holes {
            self.write_hole(node, &bindings, hole, text);
        }
        self.dirty = true;
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
            self.stop_hovering(gone);
            self.drop_subtree(gone, text);
        }
        while children.len() < count as usize {
            children.push(self.alloc(Retained::under(slot)));
        }
        self.get_mut(slot)?.children = children.clone();
        self.dirty = true;
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
        holes: &[Hole],
        text: &mut TextEngine,
    ) {
        // Everything under the node goes: a different template shares nothing
        // with the old one, and content sat in the old one's slots.
        let old: Vec<u32> = self.get(node).map(|n| n.children.clone()).unwrap_or_default();
        for child in old {
            self.stop_hovering(child);
            self.drop_subtree(child, text);
        }
        if let Some(held) = self.get_mut(node) {
            let gone = held.run.take();
            // Its listeners go with the rest: they were registered against the
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
            self.dirty = true;
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
        if let Some(held) = self.get_mut(node) {
            held.interior = Some(Interior {
                template,
                nodes: ids,
            });
        }
        self.dirty = true;
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
                    let style = text_content.style.clone();
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
                    if let Some(run) = held.run {
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

        let rects = solve_with(&flat, available, |content, query| match content {
            Content::Text(run) => measure_text(text, *run, query),
            _ => Measured {
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
            },
        });

        let mut commands = Vec::new();
        for (index, id) in order.iter().enumerate() {
            let rect = rects[index];
            let node = self.get(*id).expect("a live node");
            match (&node.appearance, node.run) {
                (Appearance::Fill(style), _) => commands.push(Command::Quad(Quad {
                    bounds: rect,
                    background: style.background,
                    border_color: style.border_color,
                    border_width: style.border_width,
                    corner_radius: style.corner_radius,
                })),
                (Appearance::Text(_), Some(run)) => commands.push(Command::Glyphs(Glyphs {
                    run,
                    x: rect.x,
                    y: rect.y,
                })),
                _ => {}
            }
        }

        // Keep where everything went: the pointer is tested against what the
        // last frame showed, which is what the person was pointing at.
        self.rects.clear();
        self.rects.resize(self.nodes.len(), None);
        for (index, id) in order.iter().enumerate() {
            self.rects[*id as usize] = Some(rects[index]);
        }
        self.painted = order;

        self.dirty = false;
        commands
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
    pub fn pointer(&mut self, input: PointerInput) -> Vec<Delivery> {
        let (position, press) = match input {
            PointerInput::Moved { x, y } => (Some((x, y)), None),
            PointerInput::Button { x, y, button, down } => (Some((x, y)), Some((button, down))),
            PointerInput::Left => (None, None),
        };
        if let Some(at) = position {
            self.pointer = at;
        }
        let at = self.pointer;
        let target = position.and_then(|(x, y)| self.hit(x, y));

        let mut deliveries = Vec::new();
        if target != self.hovered {
            deliveries.push(self.crossing(self.hovered, target, at));
            self.hovered = target;
        }
        if let (Some(target), Some(_)) = (target, position) {
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

    /// The node painted last at a point, which is the one on top there.
    fn hit(&self, x: f32, y: f32) -> Option<u32> {
        self.painted.iter().rev().copied().find(|id| {
            self.rects
                .get(*id as usize)
                .copied()
                .flatten()
                .is_some_and(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
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

    /// Stop treating anything in `gone`'s subtree as under the pointer, since
    /// it is about to be dropped and its id reused. What `gone` hung under
    /// becomes the node the pointer is over, so the next input is compared
    /// against a node that still exists.
    fn stop_hovering(&mut self, gone: u32) {
        if self.path(self.hovered).contains(&gone) {
            self.hovered = self.get(gone).and_then(|n| n.parent);
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
        TemplateRef::Fresh(TemplateDef {
            id,
            nodes,
            bindings,
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
}

