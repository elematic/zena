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

use super::layout::{measure_text, solve_with};
use super::text::TextEngine;
use super::types::{
    BoxStyle, Color, Command, Content, Flex, Glyphs, Length, Measured, Node as FlatNode, Quad, Size,
    TextStyle,
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
            self.drop_subtree(gone, text);
        }
        while children.len() < count as usize {
            children.push(self.alloc(Retained::empty()));
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
            self.drop_subtree(child, text);
        }
        if let Some(held) = self.get_mut(node) {
            let gone = held.run.take();
            *held = Retained::empty();
            if let Some(run) = gone {
                text.release_run(run);
            }
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
        self.dirty = false;
        commands
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
        self.free.push(id);
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
    use crate::ui::types::{Align, Axis, Justify, Length};

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
}

