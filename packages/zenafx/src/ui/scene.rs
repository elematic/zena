//! The retained scene: the tree the host holds and draws from.
//!
//! A component installs a tree once. After that a frame is a solve and a
//! paint over what the host already has — no call into any component, which
//! is what makes a resize free. The component is back on the path only when
//! something it draws changes, and then it replaces a subtree.
//!
//! Text is shaped when a node is installed and released when the node is
//! replaced, so a shaped run never crosses the boundary and no component
//! holds one.

use wasmtime::component::{ComponentType, Lift, Lower};

use super::layout::{measure_text, solve_with};
use super::text::TextEngine;
use super::types::{
    BoxLook, Color, Command, Content, Flex, Glyphs, Measured, Node as FlatNode, Quad, Size,
    TextLook,
};

/// A node of the retained tree, as a component sends it.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct TextContent {
    pub content: String,
    pub look: TextLook,
}

/// What a node draws.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Look {
    #[component(name = "nothing")]
    Nothing,
    #[component(name = "fill")]
    Fill(BoxLook),
    #[component(name = "text")]
    Text(TextContent),
}

/// One node of a flat tree, as a component sends it.
#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct SceneNode {
    pub layout: Flex,
    pub look: Look,
    #[component(name = "first-child")]
    pub first_child: u32,
    #[component(name = "child-count")]
    pub child_count: u32,
}

/// A node as the host keeps it: the component's description, plus the run
/// the host shaped for it and the children it resolved.
struct Retained {
    layout: Flex,
    look: Look,
    /// The shaped run for a text node, owned by this node and released when
    /// it is replaced.
    run: Option<u32>,
    children: Vec<u32>,
}

/// The tree, and the arena it lives in.
#[derive(Default)]
pub struct Scene {
    nodes: Vec<Option<Retained>>,
    free: Vec<u32>,
    root: Option<u32>,
    /// Set when the tree changed, so the window knows a frame is owed.
    pub dirty: bool,
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn root(&self) -> Option<u32> {
        self.root
    }

    pub fn is_empty(&self) -> bool {
        self.root.is_none()
    }

    /// Install a flat tree and return the id of its root.
    ///
    /// `parent` hangs it under an existing node; `None` makes it the
    /// scene's root, dropping whatever was there.
    pub fn install(
        &mut self,
        parent: Option<u32>,
        nodes: &[SceneNode],
        text: &mut TextEngine,
    ) -> u32 {
        let installed = self.build(nodes, text);
        match parent {
            Some(p) => {
                if let Some(node) = self.get_mut(p) {
                    node.children.push(installed);
                }
            }
            None => {
                if let Some(old) = self.root.take() {
                    self.drop_subtree(old, text);
                }
                self.root = Some(installed);
            }
        }
        self.dirty = true;
        installed
    }

    /// Replace the subtree rooted at `target` and return the new root's id.
    pub fn replace(&mut self, target: u32, nodes: &[SceneNode], text: &mut TextEngine) -> u32 {
        let installed = self.build(nodes, text);
        // Put the new subtree where the old one hung, then drop the old.
        let parent = self.parent_of(target);
        match parent {
            Some(p) => {
                if let Some(node) = self.get_mut(p) {
                    for child in node.children.iter_mut() {
                        if *child == target {
                            *child = installed;
                        }
                    }
                }
            }
            None => self.root = Some(installed),
        }
        self.drop_subtree(target, text);
        self.dirty = true;
        installed
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
        let mut i = 0;
        while i < order.len() {
            let id = order[i];
            let children = self.get(id).map(|n| n.children.clone()).unwrap_or_default();
            order.extend(children);
            i += 1;
        }
        let mut slot_of = vec![u32::MAX; self.nodes.len()];
        for (index, id) in order.iter().enumerate() {
            slot_of[*id as usize] = index as u32;
        }

        let flat: Vec<FlatNode> = order
            .iter()
            .map(|id| {
                let node = self.get(*id).expect("a live node");
                let first = node
                    .children
                    .first()
                    .map(|c| slot_of[*c as usize])
                    .unwrap_or(0);
                FlatNode {
                    style: node.layout,
                    content: match node.run {
                        Some(run) => Content::Text(run),
                        None => Content::Box,
                    },
                    first_child: first,
                    child_count: node.children.len() as u32,
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
            match (&node.look, node.run) {
                (Look::Fill(look), _) => commands.push(Command::Quad(Quad {
                    bounds: rect,
                    background: look.background,
                    border_color: look.border_color,
                    border_width: look.border_width,
                    corner_radius: look.corner_radius,
                })),
                (Look::Text(_), Some(run)) => commands.push(Command::Glyphs(Glyphs {
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

    /// Turn a flat tree into arena nodes, shaping any text on the way.
    fn build(&mut self, nodes: &[SceneNode], text: &mut TextEngine) -> u32 {
        if nodes.is_empty() {
            return self.alloc(Retained {
                layout: Flex::default(),
                look: Look::Nothing,
                run: None,
                children: Vec::new(),
            });
        }
        // Allocate every node first, so a parent can name children that
        // have not been filled in yet.
        let ids: Vec<u32> = nodes
            .iter()
            .map(|n| {
                let run = match &n.look {
                    Look::Text(t) => Some(text.register_run(&t.content, &t.look)),
                    _ => None,
                };
                self.alloc(Retained {
                    layout: n.layout,
                    look: n.look.clone(),
                    run,
                    children: Vec::new(),
                })
            })
            .collect();
        for (index, node) in nodes.iter().enumerate() {
            let children: Vec<u32> = (node.first_child as usize
                ..node.first_child as usize + node.child_count as usize)
                .filter_map(|c| ids.get(c).copied())
                .collect();
            if let Some(slot) = self.get_mut(ids[index]) {
                slot.children = children;
            }
        }
        ids[0]
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

    fn parent_of(&self, target: u32) -> Option<u32> {
        for (id, slot) in self.nodes.iter().enumerate() {
            if let Some(node) = slot {
                if node.children.contains(&target) {
                    return Some(id as u32);
                }
            }
        }
        None
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::types::{Align, Axis, Justify, Length};

    fn leaf(look: Look) -> SceneNode {
        SceneNode {
            layout: Flex::default(),
            look,
            first_child: 0,
            child_count: 0,
        }
    }

    fn text_node(s: &str) -> SceneNode {
        leaf(Look::Text(TextContent {
            content: s.to_owned(),
            look: TextLook::default(),
        }))
    }

    fn window() -> Size {
        Size {
            width: 800.0,
            height: 600.0,
        }
    }

    #[test]
    fn an_installed_tree_draws_without_anyone_being_asked() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        scene.install(None, &[text_node("hello")], &mut text);
        let commands = scene.draw(window(), &mut text);
        assert_eq!(commands.len(), 1, "{commands:?}");
        assert!(matches!(commands[0], Command::Glyphs(_)));
    }

    /// The property the retained tree exists for: a different window size
    /// re-solves the same nodes, with nothing rebuilt.
    #[test]
    fn resizing_re_solves_the_same_tree() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        // A root that centres one child.
        let centred = Flex {
            justify_content: Justify::Center,
            align_items: Align::Center,
            width: Length::Percent(100.0),
            height: Length::Percent(100.0),
            ..Flex::default()
        };
        scene.install(
            None,
            &[
                SceneNode {
                    layout: centred,
                    look: Look::Nothing,
                    first_child: 1,
                    child_count: 1,
                },
                text_node("hello"),
            ],
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
        let (Command::Glyphs(a), Command::Glyphs(b)) = (&wide[0], &narrow[0]) else {
            panic!("expected glyphs, got {wide:?} {narrow:?}");
        };
        assert!(
            (a.x - b.x).abs() > 1.0 || (a.y - b.y).abs() > 1.0,
            "centring should move the text: {a:?} vs {b:?}"
        );
    }

    #[test]
    fn replacing_a_subtree_frees_its_nodes_and_its_text() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        let root = scene.install(
            None,
            &[
                SceneNode {
                    layout: Flex::default(),
                    look: Look::Nothing,
                    first_child: 1,
                    child_count: 2,
                },
                text_node("one"),
                text_node("two"),
            ],
            &mut text,
        );
        assert_eq!(scene.len(), 3);

        scene.replace(root, &[text_node("just one")], &mut text);
        assert_eq!(scene.len(), 1, "the old three went away");

        let commands = scene.draw(window(), &mut text);
        assert_eq!(commands.len(), 1, "{commands:?}");
    }

    #[test]
    fn a_fill_paints_a_quad_where_the_solve_put_it() {
        let mut text = TextEngine::new();
        let mut scene = Scene::new();
        scene.install(
            None,
            &[SceneNode {
                layout: Flex {
                    width: Length::Px(120.0),
                    height: Length::Px(40.0),
                    ..Flex::default()
                },
                look: Look::Fill(BoxLook {
                    background: Some(Color::rgb(1.0, 0.0, 0.0)),
                    ..BoxLook::default()
                }),
                first_child: 0,
                child_count: 0,
            }],
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
        // root(a(x), b) — pre-order would put x between a and b and break
        // the contiguity `solve` needs.
        let row = Flex {
            axis: Axis::Row,
            ..Flex::default()
        };
        scene.install(
            None,
            &[
                SceneNode {
                    layout: row,
                    look: Look::Nothing,
                    first_child: 1,
                    child_count: 2,
                },
                SceneNode {
                    layout: row,
                    look: Look::Nothing,
                    first_child: 3,
                    child_count: 1,
                },
                text_node("b"),
                text_node("x"),
            ],
            &mut text,
        );
        let commands = scene.draw(window(), &mut text);
        assert_eq!(commands.len(), 2, "both leaves paint: {commands:?}");
    }
}
