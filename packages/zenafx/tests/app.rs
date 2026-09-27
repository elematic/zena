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
