//! Two panels and a divider, dragged with no window.
//!
//! `examples/zenafx/split/` is a left panel, a divider and a right panel. The
//! divider captures the pointer when it is pressed, and the split hears each
//! move of the drag and writes the left panel's width.
//!
//! `ui::scene` has unit tests for pointer capture. What these cover is the
//! same thing through a real component, where the answer that captures the
//! pointer arrives on a reply the component drops: that a drag follows the
//! pointer past the divider and past the window, that each move costs the
//! component one event and one write, and that a pointer crossing the panels
//! when nothing is being dragged costs it nothing.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::PointerInput;
use zenafx::ui::scene::Cursor;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Color, Command, FrameEvent, Quad};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// From `split/main.zena`: the divider's width, the narrowest a panel gets,
/// and the divider's fill while it is held.
const DIVIDER: f32 = 8.0;
const NARROWEST: f32 = 120.0;
const HELD: Color = Color {
    r: 0.20,
    g: 0.38,
    b: 0.86,
    a: 1.0,
};

fn split() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/split.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:split`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the split component")
}

/// Draw a frame and return its three panels: left, divider, right.
fn panels(app: &mut GuestScene) -> [Quad; 3] {
    let commands = app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    });
    let quads: Vec<Quad> = commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) => Some(*q),
            _ => None,
        })
        .collect();
    quads
        .try_into()
        .unwrap_or_else(|quads| panic!("three panels, not {quads:?}"))
}

/// Give the component an input and wait until it has been through its
/// listeners, and through the answer of a listener that captures the pointer.
fn send(app: &mut GuestScene, input: PointerInput) {
    app.pointer(input);
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "{input:?} was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn move_to(app: &mut GuestScene, x: f32) {
    send(app, PointerInput::Moved { x, y: 300.0 });
}

fn button(app: &mut GuestScene, x: f32, down: bool) {
    send(
        app,
        PointerInput::Button {
            x,
            y: 300.0,
            button: 0,
            down,
        },
    );
}

/// The divider follows the pointer for as long as the button is down, and
/// the divider stays where the pointer took hold of it: pressed 4 in from its
/// left edge, it is always 4 to the left of the pointer.
#[test]
fn the_divider_follows_the_pointer() {
    let mut app = split();
    let [left, divider, right] = panels(&mut app);
    assert_eq!(
        (left.bounds.width, divider.bounds.x, right.bounds.x),
        (240.0, 240.0, 240.0 + DIVIDER)
    );

    button(&mut app, 244.0, true);
    move_to(&mut app, 400.0);
    let [left, divider, right] = panels(&mut app);
    assert_eq!(left.bounds.width, 396.0);
    assert_eq!(divider.bounds.x, 396.0);
    assert_eq!(right.bounds.width, WIDTH as f32 - 396.0 - DIVIDER);

    move_to(&mut app, 300.0);
    assert_eq!(panels(&mut app)[1].bounds.x, 296.0);

    button(&mut app, 300.0, false);
    move_to(&mut app, 500.0);
    assert_eq!(
        panels(&mut app)[1].bounds.x,
        296.0,
        "the button came up, so the divider stays"
    );
}

/// Each move of a drag costs the component one event and one write. The
/// press is one event more, and the release none: nothing listens for it.
#[test]
fn a_move_of_a_drag_is_one_event_and_one_write() {
    let mut app = split();
    panels(&mut app);

    button(&mut app, 244.0, true);
    assert_eq!(app.events_delivered(), 1, "the divider heard the press");
    let writes = app.writes();

    for (moves, x) in [300.0, 350.0, 420.0, 380.0].into_iter().enumerate() {
        move_to(&mut app, x);
        let moves = moves as u32 + 1;
        assert_eq!(app.events_delivered(), 1 + moves);
        assert_eq!(app.writes(), writes + moves);
    }

    button(&mut app, 380.0, false);
    assert_eq!(app.events_delivered(), 5);
    assert_eq!(
        app.guest_entries(),
        1,
        "`main` is the one call the host made"
    );
}

/// A pointer crossing the panels when nothing is being dragged wakes nobody:
/// the split listens for moves only while the pointer is captured.
#[test]
fn a_pointer_crossing_the_panels_costs_the_component_nothing() {
    let mut app = split();
    panels(&mut app);
    let writes = app.writes();

    for x in [100.0, 244.0, 500.0, 244.0, 700.0] {
        app.pointer(PointerInput::Moved { x, y: 300.0 });
    }

    assert_eq!(app.undelivered(), 0);
    assert_eq!(app.events_delivered(), 0);
    assert_eq!(app.writes(), writes);
}

/// Neither panel gets narrower than its minimum, and the component works
/// out only one of the two. It holds the left panel at 120. The right panel
/// does not shrink below its own 120, so the layout is what stops the left
/// one, at a width the component never learns: the window's.
#[test]
fn neither_panel_goes_below_its_minimum() {
    let mut app = split();
    panels(&mut app);

    button(&mut app, 244.0, true);
    move_to(&mut app, 10.0);
    assert_eq!(panels(&mut app)[0].bounds.width, NARROWEST);

    // Past the right edge of the window, which a captured pointer can be.
    move_to(&mut app, WIDTH as f32 + 200.0);
    let [left, divider, right] = panels(&mut app);
    assert_eq!(right.bounds.width, NARROWEST);
    assert_eq!(left.bounds.width, WIDTH as f32 - DIVIDER - NARROWEST);
    assert_eq!(divider.bounds.x, left.bounds.width);
}

/// While the pointer is captured for the divider it stays held, and the
/// cursor stays the one for a sideways drag, though the pointer is over the
/// right panel. Both go back when the button comes up.
#[test]
fn the_divider_stays_held_for_the_whole_drag() {
    let mut app = split();
    panels(&mut app);
    assert_eq!(app.cursor(), Cursor::Default);

    app.pointer(PointerInput::Moved { x: 244.0, y: 300.0 });
    assert_eq!(app.cursor(), Cursor::ColResize, "over the divider");

    button(&mut app, 244.0, true);
    move_to(&mut app, 600.0);
    move_to(&mut app, 700.0);
    let [_, divider, _] = panels(&mut app);
    assert_eq!(divider.background, Some(HELD));
    assert_eq!(app.cursor(), Cursor::ColResize, "over the right panel");

    button(&mut app, 300.0, false);
    assert_ne!(panels(&mut app)[1].background, Some(HELD));
    assert_eq!(app.cursor(), Cursor::Default);
}
