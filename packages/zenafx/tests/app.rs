//! The hello-world application component, loaded and rendered with no
//! window.
//!
//! `examples/zenafx/hello.zena` builds the same scene that `ui::demo` builds
//! in Rust, so these assertions are the ones in `ui::demo::tests` made
//! against a component instead. Agreeing on the geometry is the point: the
//! host primitives do not know or care which side of the canonical ABI their
//! caller is on.

use std::path::PathBuf;

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::paint::Painter;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

fn app() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("out/hello.wasm");
    assert!(
        wasm.exists(),
        "{} is missing. It is built by `npm test -w @zena-lang/zenafx`, \
         or on its own by `npm run build:example -w @zena-lang/zenafx`.",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the hello component")
}

fn frame_at(width: u32, height: u32) -> FrameEvent {
    FrameEvent {
        time_ms: 0.0,
        width,
        height,
        scale: 1.0,
    }
}

/// The quad and the glyph run the component emitted, in that order.
fn card_and_text(commands: &[Command]) -> (Rect, (f32, f32)) {
    let mut quad = None;
    let mut glyphs = None;
    for c in commands {
        match c {
            Command::Quad(q) => quad = Some(q.bounds),
            Command::Glyphs(g) => glyphs = Some((g.x, g.y)),
            other => panic!("unexpected command {other:?}"),
        }
    }
    (
        quad.expect("the component should paint a card"),
        glyphs.expect("the component should paint a glyph run"),
    )
}

#[test]
fn the_component_centres_its_card_and_puts_the_text_inside_it() {
    let mut app = app();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    assert_eq!(commands.len(), 2, "{commands:?}");

    let (card, (gx, gy)) = card_and_text(&commands);
    let cx = card.x + card.width / 2.0;
    let cy = card.y + card.height / 2.0;
    assert!((cx - 400.0).abs() < 1.0, "card centre x {cx}, {card:?}");
    assert!((cy - 300.0).abs() < 1.0, "card centre y {cy}, {card:?}");

    // Inset by the padding the component asked for.
    assert!((gx - (card.x + 40.0)).abs() < 1.0, "text x {gx}, {card:?}");
    assert!((gy - (card.y + 24.0)).abs() < 1.0, "text y {gy}, {card:?}");
}

/// The card hugs its text, so its width comes from a `measure-run` the host
/// answered during `solve` — which the component never sees.
#[test]
fn the_card_is_wider_than_its_padding() {
    let mut app = app();
    let (card, _) = card_and_text(&app.frame(frame_at(WIDTH, HEIGHT)));
    assert!(
        card.width > 80.0,
        "80 is the padding alone; the text should add to it: {card:?}"
    );
    assert!(card.height > 48.0, "{card:?}");
}

#[test]
fn a_new_window_size_recentres_the_card() {
    let mut app = app();
    let (wide, _) = card_and_text(&app.frame(frame_at(WIDTH, HEIGHT)));
    let (tall, _) = card_and_text(&app.frame(frame_at(400, 1000)));

    assert_eq!(wide.width, tall.width, "the card hugs its text either way");
    assert!((tall.x + tall.width / 2.0 - 200.0).abs() < 1.0, "{tall:?}");
    assert!((tall.y + tall.height / 2.0 - 500.0).abs() < 1.0, "{tall:?}");
}

/// The run id the component holds survives between frames: it registers on
/// the first and reuses it after, so the second frame refers to the same run.
#[test]
fn the_text_run_is_registered_once() {
    let mut app = app();
    let first = card_and_text(&app.frame(frame_at(WIDTH, HEIGHT)));
    let second = card_and_text(&app.frame(frame_at(WIDTH, HEIGHT)));
    assert_eq!(first, second);

    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    let Command::Glyphs(g) = commands[1] else {
        panic!("expected a glyph run, got {:?}", commands[1]);
    };
    assert_eq!(g.run, 0, "a re-registered run would have a new id");
}

/// End to end without a window: the component's display list, rasterized.
#[test]
fn the_components_frame_rasterizes_a_card_with_dark_text() {
    let mut app = app();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    let (card, _) = card_and_text(&commands);

    let mut painter = Painter::new(WIDTH as u16, HEIGHT as u16);
    painter.draw(&commands, app.background(), app.text());

    let at = |x: f32, y: f32| painter.pixels()[y as usize * WIDTH as usize + x as usize];

    let page = at(4.0, 4.0);
    assert_eq!((page.r, page.g, page.b), (255, 255, 255), "page background");

    let fill = at(card.x + 6.0, card.y + 6.0);
    assert_eq!((fill.r, fill.g, fill.b), (237, 242, 250), "card background");

    let dark = painter
        .pixels()
        .iter()
        .filter(|px| px.r < 100 && px.g < 100 && px.b < 100)
        .count();
    assert!(dark > 100, "expected glyph coverage, got {dark} dark pixels");
}

// ---------------------------------------------------------------------
// Three components: a page embedding a card, with a label projected into
// the card's slot.
// ---------------------------------------------------------------------

fn page() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/page.wasm");
    assert!(wasm.exists(), "{} is missing", wasm.display());
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the page component")
}

/// The card's own padding and the inset well's, from `card.zena`.
const CARD_PAD_LEFT: f32 = 22.0;
const CARD_PAD_TOP: f32 = 18.0;
const WELL_PAD_LEFT: f32 = 18.0;
const WELL_PAD_TOP: f32 = 16.0;

/// A frame with the children in place. The first frame only spawns them.
fn settled(page: &mut GuestScene) -> Vec<Command> {
    page.frame(frame_at(WIDTH, HEIGHT));
    page.frame(frame_at(WIDTH, HEIGHT))
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

/// A spawn is promised during a frame and instantiated after it, so the
/// children appear on the second frame. The window is told to expect one.
#[test]
fn children_appear_on_the_frame_after_the_spawn() {
    let mut page = page();
    assert!(page.frame(frame_at(WIDTH, HEIGHT)).is_empty(), "first frame");
    assert!(page.wants_another_frame(), "the window is owed a frame");
    assert!(!page.frame(frame_at(WIDTH, HEIGHT)).is_empty(), "second frame");
}

/// What three nested components paint, in order: the page's background,
/// then the card's chrome inside a clip, then the label inside a clip of
/// its own. The clips are the host's, not the components' — each one is put
/// round a child so it cannot draw outside the box it was given.
#[test]
fn the_tree_paints_page_then_card_then_label_each_clipped() {
    let mut page = page();
    let commands = settled(&mut page);

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
        vec![
            "quad",   // the page's background
            "push",   // the host clips the card
            "quad",   // the card's panel
            "glyphs", // its title
            "quad",   // the well round its slot
            "push",   // the host clips the slot
            "glyphs", // the label, a component the card cannot see
            "pop",
            "pop",
        ],
        "{commands:?}"
    );
}

/// The card's size comes from a component it cannot see.
///
/// `card.zena` draws a title and a well and declares a slot; the well's
/// interior is whatever fills that slot, which the host discovers by asking
/// the label — during the card's `solve`, while the page is suspended
/// inside its own. This is the assertion the whole arrangement exists for.
#[test]
fn the_card_is_sized_by_the_label_projected_into_it() {
    let mut page = page();
    let commands = settled(&mut page);
    let (card, well) = (quad(&commands, 1), quad(&commands, 2));
    let (lx, ly) = glyphs(&commands, 1);

    // The well sits inside the card, inset by the card's padding.
    assert!(
        (well.x - (card.x + CARD_PAD_LEFT)).abs() < 1.0,
        "well {well:?} in card {card:?}"
    );
    // And the label sits inside the well, inset by the well's padding.
    assert!(
        (lx - (well.x + WELL_PAD_LEFT)).abs() < 1.0,
        "label x {lx}, well {well:?}"
    );
    assert!(
        (ly - (well.y + WELL_PAD_TOP)).abs() < 1.0,
        "label y {ly}, well {well:?}"
    );

    // The card hugs what it was given: wider than its own chrome, and not
    // the whole window.
    assert!(
        card.width > 2.0 * (CARD_PAD_LEFT + WELL_PAD_LEFT)
            && card.width < WIDTH as f32,
        "the card should hug the label: {card:?}"
    );
    assert!(card.height > CARD_PAD_TOP + WELL_PAD_TOP, "{card:?}");
}

/// The card's title is the card's own, drawn above the well and outside it.
#[test]
fn the_cards_title_is_outside_the_slot() {
    let mut page = page();
    let commands = settled(&mut page);
    let (card, well) = (quad(&commands, 1), quad(&commands, 2));
    let (tx, ty) = glyphs(&commands, 0);

    assert!(
        (tx - (card.x + CARD_PAD_LEFT)).abs() < 1.0,
        "title x {tx}, card {card:?}"
    );
    assert!(ty < well.y, "the title {ty} should sit above the well {well:?}");
    assert!(ty >= card.y, "the title {ty} should be inside the card {card:?}");
}

#[test]
fn the_card_is_centred_in_the_window() {
    let mut page = page();
    let commands = settled(&mut page);
    let card = quad(&commands, 1);
    let cx = card.x + card.width / 2.0;
    let cy = card.y + card.height / 2.0;
    assert!((cx - 400.0).abs() < 1.0, "centre x {cx}, {card:?}");
    assert!((cy - 300.0).abs() < 1.0, "centre y {cy}, {card:?}");
}

/// The host clips each child to its box, so a component cannot paint
/// outside what its embedder gave it.
#[test]
fn each_childs_clip_is_the_box_it_was_given() {
    let mut page = page();
    let commands = settled(&mut page);

    let clips: Vec<Rect> = commands
        .iter()
        .filter_map(|c| match c {
            Command::PushClip(r) => Some(*r),
            _ => None,
        })
        .collect();
    assert_eq!(clips.len(), 2, "one clip per placed component");

    let (card, well) = (quad(&commands, 1), quad(&commands, 2));
    assert_eq!(clips[0], card, "the card's clip is its own box");

    let slot = clips[1];
    assert!(
        slot.x >= well.x && slot.y >= well.y
            && slot.x + slot.width <= well.x + well.width + 0.5
            && slot.y + slot.height <= well.y + well.height + 0.5,
        "the slot's clip {slot:?} should be inside the well {well:?}"
    );
}

/// End to end: three components, rasterized.
#[test]
fn the_three_component_tree_rasterizes() {
    let mut page = page();
    let commands = settled(&mut page);

    let mut painter = Painter::new(WIDTH as u16, HEIGHT as u16);
    painter.draw(&commands, page.background(), page.text());
    let dark = painter
        .pixels()
        .iter()
        .filter(|px| px.r < 100 && px.g < 100 && px.b < 100)
        .count();
    assert!(dark > 100, "expected the label's glyphs, got {dark} dark pixels");
}

// ---------------------------------------------------------------------
// One component, several widgets: composition in the language rather than
// across the component boundary.
// ---------------------------------------------------------------------

fn widgets() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/widgets.wasm");
    assert!(wasm.exists(), "{} is missing", wasm.display());
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the widgets component")
}

/// Nothing is spawned, so there is nothing to wait for: the first frame is
/// the finished picture. The component version needs two.
#[test]
fn the_first_frame_is_complete() {
    let mut app = widgets();
    let commands = app.frame(frame_at(WIDTH, HEIGHT));
    assert!(!commands.is_empty(), "the first frame should draw");
    assert!(!app.wants_another_frame(), "nothing is owed");
}

/// Five commands and no clips. The component version of the same picture
/// draws nine, four of which are the clips the host puts round each child
/// — isolation nobody asked for between widgets that trust each other.
#[test]
fn one_component_paints_the_same_picture_without_clips() {
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

/// A frame crosses the boundary not at all.
///
/// The component does not even call `solve`: it installed a tree, and the
/// host solves and paints that on its own. Both counters are host-side
/// tallies of calls that cross the component boundary, and both are zero.
#[test]
fn a_frame_costs_no_boundary_crossings() {
    let mut app = widgets();
    app.frame(frame_at(WIDTH, HEIGHT));
    assert_eq!(app.last_frame_calls(), (0, 0));
}

/// The same picture as the three-component version, to within a pixel: the
/// card hugs its label, the label is inset by both paddings, and the card
/// is centred. Composition moved into the language; the layout did not
/// change.
#[test]
fn the_widget_tree_lays_out_like_the_component_tree() {
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

/// The same picture across three components, counted at the boundary.
///
/// The one-component version does it in one solve and no cross-component
/// measures. Here every widget boundary is a component boundary, so the
/// host has to re-enter a guest for each of taffy's layout queries, and
/// each embedded component solves its own subtree on top of that.
#[test]
fn three_components_cost_far_more_boundary_traffic() {
    let mut page = page();
    settled(&mut page);
    let (solves, measures) = page.last_frame_calls();

    let mut one = widgets();
    one.frame(frame_at(WIDTH, HEIGHT));
    let (one_solve, one_measure) = one.last_frame_calls();

    println!("three components: {solves} solves, {measures} cross-component measures");
    println!("one component:    {one_solve} solves, {one_measure} cross-component measures");

    assert!(solves > one_solve, "{solves} vs {one_solve}");
    assert!(measures > 0, "the component tree should cross the boundary");
    assert_eq!(
        (one_solve, one_measure),
        (0, 0),
        "a retained tree crosses the boundary not at all"
    );
}

// ---------------------------------------------------------------------
// The retained tree: installed once, then resized for free.
// ---------------------------------------------------------------------

/// A resize costs nothing.
///
/// The component is entered once, to mount. After that the host owns the
/// tree, and every frame — at any size — is a solve and a paint over it.
/// This is the property the retained scene exists for.
#[test]
fn resizing_never_re_enters_the_component() {
    let mut app = widgets();
    app.frame(frame_at(WIDTH, HEIGHT));
    assert_eq!(app.guest_entries(), 1, "mounting is the one entry");

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
