//! Every cursor, pointed at with no window.
//!
//! `examples/zenafx/cursors/` is a tile for each cursor, each naming its own.
//! `ui::scene` has unit tests for which node's cursor shows, and
//! `ui::surface` checks that each cursor is the platform's cursor of the same
//! name. What this covers is the names going through a real component: that
//! each of CSS's keywords, as the interface spells it and a component in Zena
//! writes it, arrives as the cursor it names.

use std::path::PathBuf;

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::PointerInput;
use zenafx::ui::scene::Cursor;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

fn cursors() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/cursors.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:cursors`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the cursors component")
}

/// Draw a frame and return its tiles, in the order they are drawn, which is
/// the order the example lists the cursors in. A tile is a box with an edge,
/// and the page has none.
fn tiles(app: &mut GuestScene) -> Vec<Rect> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
    .iter()
    .filter_map(|c| match c {
        Command::Quad(q) if q.border_color.is_some() => Some(q.bounds),
        _ => None,
    })
    .collect()
}

/// There is a tile for every cursor, and the pointer over each shows the
/// cursor the tile names. Over the page between the tiles it is the default
/// one. The component hears none of it.
#[test]
fn each_tile_shows_the_cursor_it_names() {
    let mut app = cursors();
    let tiles = tiles(&mut app);
    assert_eq!(tiles.len(), Cursor::ALL.len(), "a tile for every cursor");
    assert_eq!(app.cursor(), Cursor::Default, "the pointer is nowhere yet");

    for (tile, cursor) in tiles.iter().zip(Cursor::ALL) {
        app.pointer(PointerInput::Moved {
            x: tile.x + tile.width / 2.0,
            y: tile.y + tile.height / 2.0,
        });
        assert_eq!(app.cursor(), cursor);
    }

    app.pointer(PointerInput::Moved { x: 2.0, y: 2.0 });
    assert_eq!(app.cursor(), Cursor::Default, "the page names none");
    assert_eq!(app.events_delivered(), 0, "no listener heard the pointer");
}
