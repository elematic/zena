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
/// The gap the page puts between cards, from `widgets/main.zena`.
const PAGE_GAP: f32 = 18.0;

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

/// The `n`th glyph run's shaped-run id, for measuring what it holds.
fn glyph_run(commands: &[Command], n: usize) -> u32 {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => Some(g.run),
            _ => None,
        })
        .nth(n)
        .unwrap_or_else(|| panic!("no glyph run {n} in {commands:?}"))
}

/// Where the `n`th glyph run in paint order was placed. Runs 0..3 are the
/// three cards' titles; 3.. are the labels in their slots.
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

/// No clips, and one quad or glyph run per node that draws: the page, three
/// cards and three wells; three titles and four labels.
///
/// Clips are what the host puts round an embedded component. Widgets in one
/// component need none, so there are none.
#[test]
fn the_tree_paints_every_node_once_and_clips_nothing() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    let mut quads = 0;
    let mut runs = 0;
    for c in &commands {
        match c {
            Command::Quad(_) => quads += 1,
            Command::Glyphs(_) => runs += 1,
            other => panic!("unexpected clip command {other:?}"),
        }
    }
    assert_eq!((quads, runs), (7, 7), "{commands:?}");
}

/// Each `Card` drew its own title, so the three title runs measure three
/// different widths.
///
/// This is the assertion a `Card` keeping its title on the module rather
/// than the instance would fail — three cards would draw one title. Card
/// *width* would not catch it, because a card is sized by its label rather
/// than its title, so that stays different either way.
#[test]
fn each_card_instance_draws_its_own_title() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    // The first three glyph runs are the three cards' titles.
    let runs: Vec<u32> = (0..3).map(|n| glyph_run(&commands, n)).collect();
    let widths: Vec<f32> = runs
        .iter()
        .map(|run| app.text().lock().unwrap().measure_run(*run, None).width)
        .collect();

    for (a, b) in [(0, 1), (0, 2), (1, 2)] {
        assert!(
            (widths[a] - widths[b]).abs() > 1.0,
            "titles {a} and {b} measure the same, so a title is shared: {widths:?}"
        );
    }
}

/// Each card is sized around the label in its own slot, so the three come
/// out at three different widths.
#[test]
fn three_card_instances_each_size_to_their_own_content() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    let first = quad(&commands, 1);
    let second = quad(&commands, 2);
    let third = quad(&commands, 3);

    // The second card's label is the longest, the first card's the shortest.
    assert!(
        second.width > first.width,
        "second {second:?} should be wider than first {first:?}"
    );
    assert!(
        second.width > third.width,
        "second {second:?} should be wider than third {third:?}"
    );

    // Stacked top to bottom, in tree order, with the page's gap between.
    assert!(first.y < second.y, "{first:?} above {second:?}");
    assert!(second.y < third.y, "{second:?} above {third:?}");
    assert!(
        (second.y - (first.y + first.height) - PAGE_GAP).abs() < 1.0,
        "gap between {first:?} and {second:?}"
    );

    // Each is centred horizontally despite the differing widths.
    for card in [first, second, third] {
        let cx = card.x + card.width / 2.0;
        assert!((cx - 400.0).abs() < 1.0, "centre x {cx}, {card:?}");
    }
}

/// Two labels in one slot stack inside the well, so a slot takes a list and
/// not just one child.
#[test]
fn a_slot_holds_more_than_one_child() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    let third_well = quad(&commands, 6);
    let (_, first_y) = glyphs(&commands, 5);
    let (_, second_y) = glyphs(&commands, 6);

    assert!(
        first_y < second_y,
        "the slot's two labels should stack: {first_y} then {second_y}"
    );
    assert!(
        first_y >= third_well.y && second_y < third_well.y + third_well.height,
        "both labels inside the well {third_well:?}: {first_y}, {second_y}"
    );
}

/// Every card insets its well by its own padding, and its label by the
/// well's.
#[test]
fn each_card_insets_its_own_well_and_label() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    // Quads run page, card, card, card, well, well, well; the labels follow
    // the three titles in the glyph runs.
    for n in 0..3 {
        let card = quad(&commands, 1 + n);
        let well = quad(&commands, 4 + n);
        let (lx, ly) = glyphs(&commands, 3 + n);

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
    }
}

/// The three cards together are centred in the window.
#[test]
fn the_stack_of_cards_is_centred() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));

    let top = quad(&commands, 1);
    let bottom = quad(&commands, 3);
    let cy = (top.y + bottom.y + bottom.height) / 2.0;
    assert!((cy - 300.0).abs() < 1.0, "centre y {cy}, {top:?}..{bottom:?}");
}

#[test]
fn the_widget_tree_rasterizes() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    let mut painter = Painter::new(WIDTH as u16, HEIGHT as u16);
    painter.draw(&commands, app.background(), &app.text().lock().unwrap());
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
    let wide = app.frame(frame_at(WIDTH, HEIGHT));
    let narrow = app.frame(frame_at(400, 1000));

    // The stack of three, top edge to bottom edge.
    let height_of = |commands: &[Command]| {
        let top = quad(commands, 1);
        let bottom = quad(commands, 3);
        bottom.y + bottom.height - top.y
    };
    assert!(
        height_of(&narrow) > height_of(&wide),
        "the longest label should wrap in a narrower window: {} then {}",
        height_of(&wide),
        height_of(&narrow)
    );

    let top = quad(&narrow, 1);
    let bottom = quad(&narrow, 3);
    assert!(
        (top.x + top.width / 2.0 - 200.0).abs() < 1.0,
        "re-centred horizontally: {top:?}"
    );
    let cy = (top.y + bottom.y + bottom.height) / 2.0;
    assert!((cy - 500.0).abs() < 1.0, "re-centred vertically: {cy}");
}
