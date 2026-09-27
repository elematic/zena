//! A scene built in Rust, so the host primitives can be run before there is
//! a component to drive them.
//!
//! This is the milestone-1 target — "Hello, world" in a box, centred in the
//! window by a flexbox layout — with the runtime component's job done here
//! instead: hold a tree, solve it, and walk the result into a display list.
//! It is a stand-in, not a design: the tree is fixed, there is no dirty set,
//! and it is thrown away once `packages/zenafx-ui` exists and the loader can
//! bind a real `zenafx:ui/scene` to it.
//!
//! What it does establish is that the four host primitives compose, which is
//! the part the component cannot tell us.

use super::layout::solve;
use super::surface::Scene;
use super::text::TextEngine;
use super::types::{
    Align, Axis, BoxLook, Color, Command, Content, Edges, Flex, FrameEvent, Glyphs, Length, Node,
    Quad, Size, TextLook,
};

/// A flat scene: layout nodes in pre-order, with a look for each.
///
/// Parallel arrays rather than a tree of structs, because that is the shape
/// `zenafx:host/layout` takes and the shape the paint walk wants back.
pub struct FlatScene {
    pub nodes: Vec<Node>,
    pub looks: Vec<Option<BoxLook>>,
}

impl FlatScene {
    /// Solve at `available` and walk the result into a display list.
    pub fn display_list(&self, available: Size, text: &mut TextEngine) -> Vec<Command> {
        let rects = solve(&self.nodes, available, text);
        let mut commands = Vec::with_capacity(rects.len());
        for (i, rect) in rects.iter().enumerate() {
            if let Some(look) = self.looks.get(i).copied().flatten() {
                commands.push(Command::Quad(Quad {
                    bounds: *rect,
                    background: look.background,
                    border_color: look.border_color,
                    border_width: look.border_width,
                    corner_radius: look.corner_radius,
                }));
            }
            if let Content::Text(run) = self.nodes[i].content {
                commands.push(Command::Glyphs(Glyphs {
                    run,
                    x: rect.x,
                    y: rect.y,
                }));
            }
        }
        commands
    }
}

const INK: Color = Color::rgb(0.10, 0.11, 0.13);
const CARD: Color = Color::rgb(0.93, 0.95, 0.98);
const EDGE: Color = Color::rgb(0.76, 0.81, 0.88);
pub const PAGE: Color = Color::rgb(1.0, 1.0, 1.0);

/// "Hello, world" in a card, centred in the window.
///
/// Three nodes: a root that fills the window and centres its one child on
/// both axes, a padded card, and the text.
pub fn hello(text: &mut TextEngine, message: &str) -> FlatScene {
    let run = text.register_run(
        message,
        &TextLook {
            family: "system-ui".to_owned(),
            size: 32.0,
            weight: 500,
            italic: false,
            color: INK,
        },
    );

    FlatScene {
        nodes: vec![
            Node {
                style: Flex {
                    axis: Axis::Column,
                    justify_content: super::types::Justify::Center,
                    align_items: Align::Center,
                    width: Length::Percent(100.0),
                    height: Length::Percent(100.0),
                    ..Flex::default()
                },
                content: Content::Box,
                first_child: 1,
                child_count: 1,
            },
            Node {
                style: Flex {
                    padding: Edges {
                        top: 24.0,
                        right: 40.0,
                        bottom: 24.0,
                        left: 40.0,
                    },
                    ..Flex::default()
                },
                content: Content::Box,
                first_child: 2,
                child_count: 1,
            },
            Node {
                style: Flex::default(),
                content: Content::Text(run),
                first_child: 0,
                child_count: 0,
            },
        ],
        looks: vec![
            None,
            Some(BoxLook {
                background: Some(CARD),
                border_color: Some(EDGE),
                border_width: 1.0,
                corner_radius: 12.0,
                opacity: 1.0,
            }),
            None,
        ],
    }
}

/// The [`Scene`] the window runs: builds [`hello`] once, then re-solves it at
/// whatever size each frame arrives with.
pub struct HelloScene {
    message: String,
    text: TextEngine,
    scene: Option<FlatScene>,
}

impl HelloScene {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            text: TextEngine::new(),
            scene: None,
        }
    }
}

impl Scene for HelloScene {
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        let message = self.message.clone();
        let text = &mut self.text;
        let scene = self.scene.get_or_insert_with(|| hello(text, &message));
        scene.display_list(
            Size {
                width: frame.width as f32,
                height: frame.height as f32,
            },
            text,
        )
    }

    fn text(&self) -> &TextEngine {
        &self.text
    }

    fn text_mut(&mut self) -> &mut TextEngine {
        &mut self.text
    }

    fn background(&self) -> Color {
        PAGE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::paint::Painter;
    use crate::ui::types::Rect;

    const WINDOW: Size = Size {
        width: 800.0,
        height: 600.0,
    };

    fn bounds_of(commands: &[Command]) -> (Option<Rect>, Option<(f32, f32)>) {
        let mut quad = None;
        let mut glyphs = None;
        for c in commands {
            match c {
                Command::Quad(q) => quad = Some(q.bounds),
                Command::Glyphs(g) => glyphs = Some((g.x, g.y)),
                _ => {}
            }
        }
        (quad, glyphs)
    }

    #[test]
    fn the_card_is_centred_and_the_text_sits_inside_it() {
        let mut text = TextEngine::new();
        let scene = hello(&mut text, "Hello, world");
        let commands = scene.display_list(WINDOW, &mut text);

        let (card, glyphs) = bounds_of(&commands);
        let card = card.expect("the card should paint a quad");
        let (gx, gy) = glyphs.expect("the label should paint a glyph run");

        let cx = card.x + card.width / 2.0;
        let cy = card.y + card.height / 2.0;
        assert!((cx - 400.0).abs() < 1.0, "card centre x {cx}, {card:?}");
        assert!((cy - 300.0).abs() < 1.0, "card centre y {cy}, {card:?}");

        // The text is inside the card, inset by its padding.
        assert!((gx - (card.x + 40.0)).abs() < 1.0, "text x {gx}, {card:?}");
        assert!((gy - (card.y + 24.0)).abs() < 1.0, "text y {gy}, {card:?}");
    }

    #[test]
    fn a_different_window_size_recentres_without_rebuilding() {
        let mut text = TextEngine::new();
        let scene = hello(&mut text, "Hello, world");
        let wide = bounds_of(&scene.display_list(WINDOW, &mut text)).0.unwrap();
        let tall = bounds_of(
            &scene.display_list(
                Size {
                    width: 400.0,
                    height: 1000.0,
                },
                &mut text,
            ),
        )
        .0
        .unwrap();

        assert_eq!(wide.width, tall.width, "the card hugs its text either way");
        assert!((tall.x + tall.width / 2.0 - 200.0).abs() < 1.0, "{tall:?}");
        assert!((tall.y + tall.height / 2.0 - 500.0).abs() < 1.0, "{tall:?}");
    }

    /// End to end with no window: build, solve, rasterize, and check that the
    /// card and the text actually landed on the pixels.
    #[test]
    fn the_frame_rasterizes_a_card_with_dark_text_on_it() {
        let mut text = TextEngine::new();
        let scene = hello(&mut text, "Hello, world");
        let commands = scene.display_list(WINDOW, &mut text);
        let card = bounds_of(&commands).0.unwrap();

        let mut painter = Painter::new(WINDOW.width as u16, WINDOW.height as u16);
        painter.draw(&commands, PAGE, &text);

        let at = |x: f32, y: f32| painter.pixels()[y as usize * 800 + x as usize];

        // A corner of the page is still the background.
        let page = at(4.0, 4.0);
        assert_eq!((page.r, page.g, page.b), (255, 255, 255));

        // Just inside the card's top-left, above the text, is the card fill.
        let fill = at(card.x + 6.0, card.y + 6.0);
        assert_eq!(
            (fill.r, fill.g, fill.b),
            (237, 242, 250),
            "expected the card background"
        );

        // The text is somewhere in the card's middle band.
        let dark = painter
            .pixels()
            .iter()
            .filter(|px| px.r < 100 && px.g < 100 && px.b < 100)
            .count();
        assert!(dark > 100, "expected glyph coverage, got {dark} dark pixels");
    }
}
