//! The widget-tree application component, loaded and rendered with no
//! window.
//!
//! `examples/zenafx/widgets/` is one component holding three widget
//! classes. It hands the host a tree when it starts, and these assertions
//! are made against what the host solves and paints from that tree: the
//! host primitives do not know or care which side of the canonical ABI
//! their caller is on.

use std::path::PathBuf;

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::paint::Painter;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// The card's own padding and the inset well's, from `widgets/card.zena`.
const CARD_PAD_LEFT: f32 = 22.0;
const WELL_PAD_LEFT: f32 = 18.0;
const WELL_PAD_TOP: f32 = 16.0;

fn frame_at(width: u32, height: u32) -> FrameEvent {
    FrameEvent {
        time_ms: 0.0,
        width,
        height,
        scale: 1.0,
    }
}

/// The `n`th quad in paint order: 0 the page, 1 the card, 2 the card's well.
fn quad(commands: &[Command], n: usize) -> Rect {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) => Some(q.bounds),
            _ => None,
        })
        .nth(n)
        .unwrap_or_else(|| panic!("no quad {n} in {commands:?}"))
}

/// The `n`th glyph run in paint order: 0 the card's title, 1 the label.
fn glyphs(commands: &[Command], n: usize) -> (f32, f32) {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => Some((g.x, g.y)),
            _ => None,
        })
        .nth(n)
        .unwrap_or_else(|| panic!("no glyph run {n} in {commands:?}"))
}

fn widgets() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/widgets.wasm");
    assert!(wasm.exists(), "{} is missing", wasm.display());
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the widgets component")
}

/// The tree is installed before the first frame, so the first frame is the
/// finished picture and nothing is owed after it.
#[test]
fn the_first_frame_is_complete() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    assert!(!commands.is_empty(), "the first frame should draw");
    assert!(!app.wants_another_frame(), "nothing is owed");
}

/// Five commands and no clips: the page, the card, its title, the well,
/// and the label.
#[test]
fn the_tree_paints_five_commands_and_no_clips() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    let shape: Vec<&str> = commands
        .iter()
        .map(|c| match c {
            Command::Quad(_) => "quad",
            Command::Glyphs(_) => "glyphs",
            Command::PushClip(_) => "push",
            Command::PopClip => "pop",
        })
        .collect();
    assert_eq!(
        shape,
        vec!["quad", "quad", "glyphs", "quad", "glyphs"],
        "{commands:?}"
    );
}

/// The card hugs its label, the label is inset by both paddings, and the
/// card is centred.
#[test]
fn the_card_hugs_its_label_and_sits_in_the_middle() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    let card = quad(&commands, 1);
    let well = quad(&commands, 2);
    let (lx, ly) = glyphs(&commands, 1);

    assert!(
        (well.x - (card.x + CARD_PAD_LEFT)).abs() < 1.0,
        "well {well:?} in card {card:?}"
    );
    assert!(
        (lx - (well.x + WELL_PAD_LEFT)).abs() < 1.0,
        "label x {lx}, well {well:?}"
    );
    assert!(
        (ly - (well.y + WELL_PAD_TOP)).abs() < 1.0,
        "label y {ly}, well {well:?}"
    );

    let cx = card.x + card.width / 2.0;
    let cy = card.y + card.height / 2.0;
    assert!((cx - 400.0).abs() < 1.0, "centre x {cx}, {card:?}");
    assert!((cy - 300.0).abs() < 1.0, "centre y {cy}, {card:?}");
}

#[test]
fn the_widget_tree_rasterizes() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    let mut painter = Painter::new(WIDTH as u16, HEIGHT as u16);
    painter.draw(&commands, app.background(), app.text());
    let dark = painter
        .pixels()
        .iter()
        .filter(|px| px.r < 100 && px.g < 100 && px.b < 100)
        .count();
    assert!(dark > 100, "expected glyphs, got {dark} dark pixels");
}

// ---------------------------------------------------------------------
// The retained tree: installed once, then resized for free.
// ---------------------------------------------------------------------

/// A resize costs nothing.
///
/// The component is entered once, at load, to ask what it draws. After
/// that the host owns the tree, and every frame — at any size — is a solve
/// and a paint over it. This is the property the retained scene exists for.
#[test]
fn resizing_never_re_enters_the_component() {
    let mut app = widgets();
    assert_eq!(app.guest_entries(), 1, "`start` is the one entry");
    app.frame(frame_at(WIDTH, HEIGHT));
    assert_eq!(app.guest_entries(), 1, "the first frame does not call in");

    for (w, h) in [(400, 1000), (1200, 300), (800, 600), (640, 480)] {
        let commands = app.frame(frame_at(w, h));
        assert!(!commands.is_empty(), "still draws at {w}x{h}");
    }
    assert_eq!(
        app.guest_entries(),
        1,
        "four resizes should not have entered the component again"
    );
}

/// And the layout really does change — the resize is not a no-op that
/// trivially satisfies the test above.
#[test]
fn the_retained_tree_re_solves_at_each_size() {
    let mut app = widgets();
    app.frame(frame_at(WIDTH, HEIGHT));
    let wide = quad(&app.frame(frame_at(WIDTH, HEIGHT)), 1);
    let tall = quad(&app.frame(frame_at(400, 1000)), 1);

    assert_eq!(wide.width, tall.width, "the card still hugs its content");
    assert!(
        (tall.x + tall.width / 2.0 - 200.0).abs() < 1.0,
        "re-centred horizontally: {tall:?}"
    );
    assert!(
        (tall.y + tall.height / 2.0 - 500.0).abs() < 1.0,
        "re-centred vertically: {tall:?}"
    );
}
