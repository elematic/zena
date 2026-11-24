//! A scene built in Rust, so the rendering primitives can be run without a
//! guest component — both natively (`zfx --ui`) and on the web.
//!
//! Builds "Hello, world" in a padded rounded card, centred in the viewport by
//! a flexbox layout.

use crate::layout::solve;
use crate::text::TextEngine;
use crate::types::{
    Align, Axis, BoxStyle, Color, Command, Content, Edges, Flex, Glyphs, Justify, Length, Node,
    Quad, Size, TextStyle,
};

/// A flat scene: layout nodes in pre-order, with a style for each.
pub struct FlatScene {
    pub nodes: Vec<Node>,
    pub styles: Vec<Option<BoxStyle>>,
}

impl FlatScene {
    /// Solve at `available` and walk the result into a display list.
    pub fn display_list(&self, available: Size, text: &mut TextEngine) -> Vec<Command> {
        let rects = solve(&self.nodes, available, text);
        let mut commands = Vec::with_capacity(rects.len());
        for (i, rect) in rects.iter().enumerate() {
            if let Some(style) = self.styles.get(i).copied().flatten() {
                commands.push(Command::Quad(Quad {
                    bounds: *rect,
                    background: style.background,
                    border_color: style.border_color,
                    border_width: style.border_width,
                    corner_radius: style.corner_radius,
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

/// "Hello, world" in a card, centred in the viewport.
pub fn hello(text: &mut TextEngine, message: &str) -> FlatScene {
    let run = text.register_run(
        message,
        &TextStyle {
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
                layout: Flex {
                    axis: Axis::Column,
                    justify_content: Justify::Center,
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
                layout: Flex {
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
                layout: Flex::default(),
                content: Content::Text(run),
                first_child: 0,
                child_count: 0,
            },
        ],
        styles: vec![
            None,
            Some(BoxStyle {
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

#[cfg(all(test, feature = "system-fonts"))]
mod tests {
    use super::*;
    use crate::paint::Painter;
    use crate::types::Rect;

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

    #[test]
    fn the_frame_rasterizes_a_card_with_dark_text_on_it() {
        let mut text = TextEngine::new();
        let scene = hello(&mut text, "Hello, world");
        let commands = scene.display_list(WINDOW, &mut text);
        let card = bounds_of(&commands).0.unwrap();

        let mut painter = Painter::new(WINDOW.width as u16, WINDOW.height as u16);
        painter.draw(&commands, PAGE, &text);

        let at = |x: f32, y: f32| painter.pixels()[y as usize * 800 + x as usize];

        let page = at(4.0, 4.0);
        assert_eq!((page.r, page.g, page.b), (255, 255, 255));

        let fill = at(card.x + 6.0, card.y + 6.0);
        assert_eq!(
            (fill.r, fill.g, fill.b),
            (237, 242, 250),
            "expected the card background"
        );

        let dark = painter
            .pixels()
            .iter()
            .filter(|px| px.r < 100 && px.g < 100 && px.b < 100)
            .count();
        assert!(dark > 100, "expected glyph coverage, got {dark} dark pixels");
    }
}
