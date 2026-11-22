//! A button that hears the pointer, pressed and hovered with no window.
//!
//! `examples/zenafx/button/` is a count, a button that adds one to it, and a
//! page that sets it back to zero. The button listens on its own box for
//! `down`, `enter` and `leave`, and the page for `down`. These tests feed the
//! loader the inputs a window would and look at what the next frame draws.
//!
//! What they cover is the path between the two halves that have unit tests of
//! their own: `ui::scene` works out which listeners an input reaches, and
//! this checks that each listener's stream carries its events to the handler
//! the component gave it, that what the handler changes is on the next frame,
//! that a listener's answer decides whether the next one hears the event, and
//! that an input reaching no listener does not wake the component.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::PointerInput;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Color, Command, FrameEvent, Quad};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// The two fills in `button/main.zena`.
const RESTING: Color = Color {
    r: 0.20,
    g: 0.38,
    b: 0.86,
    a: 1.0,
};
const HOVERED: Color = Color {
    r: 0.31,
    g: 0.49,
    b: 0.95,
    a: 1.0,
};

fn button() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/button.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:button`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the button component")
}

fn frame(app: &mut GuestScene) -> Vec<Command> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
}

/// The button's quad. The page paints first and the button is the only other
/// box with a fill.
fn button_quad(commands: &[Command]) -> Quad {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) => Some(*q),
            _ => None,
        })
        .nth(1)
        .unwrap_or_else(|| panic!("no button in {commands:?}"))
}

/// The middle of the button, which is over its label.
fn on_the_button(commands: &[Command]) -> (f32, f32) {
    let b = button_quad(commands).bounds;
    (b.x + b.width / 2.0, b.y + b.height / 2.0)
}

/// The count's shaped run and what it says. The count paints before the
/// button's label.
fn count(app: &GuestScene, commands: &[Command]) -> (u32, String) {
    let run = commands
        .iter()
        .find_map(|c| match c {
            Command::Glyphs(g) => Some(g.run),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no text in {commands:?}"));
    let text = app.text();
    let text = text.lock().unwrap();
    (run, text.get(run).expect("a live run").content().to_owned())
}

/// Give the component an input and wait until it has been through its
/// listeners.
///
/// The loader hands an input to the component's thread and returns, since a
/// window does not wait on a component. A test has to. For a press this
/// waits for the listeners themselves, because each one's answer is what the
/// component's thread waits for. An `enter` or a `leave` has no answer, so
/// for those this waits only until the event is written, and
/// [`fill_becomes`] waits for what the listener does with it.
fn send(app: &mut GuestScene, input: PointerInput) {
    app.pointer(input);
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "{input:?} was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn move_to(app: &mut GuestScene, (x, y): (f32, f32)) {
    send(app, PointerInput::Moved { x, y });
}

fn press(app: &mut GuestScene, (x, y): (f32, f32)) {
    send(
        app,
        PointerInput::Button {
            x,
            y,
            button: 0,
            down: true,
        },
    );
}

/// Draw frames until the button's fill is `wanted`.
fn fill_becomes(app: &mut GuestScene, wanted: Color, why: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let fill = button_quad(&frame(app)).background;
        if fill == Some(wanted) {
            return;
        }
        assert!(Instant::now() < deadline, "{why}: the fill stayed {fill:?}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// A press on the button reaches the handler the button registered, and the
/// frame after it shows the count that handler wrote.
///
/// The run id is the same before and after, so the count's node was patched
/// in place: one hole crossed, and nothing was rebuilt.
#[test]
fn a_press_adds_one_to_the_count() {
    let mut app = button();
    let first = frame(&mut app);
    let (run, before) = count(&app, &first);
    assert_eq!(before, "0");

    press(&mut app, on_the_button(&first));
    press(&mut app, on_the_button(&first));

    let second = frame(&mut app);
    let (same_run, after) = count(&app, &second);
    assert_eq!(after, "2");
    assert_eq!(same_run, run, "the count's node was rebuilt, not patched");
}

/// A listener's answer decides whether the next one hears the event.
///
/// The page hears `down` anywhere in it and sets the count to zero. A press
/// on the button is offered to the button first, and the button stops it, so
/// the count survives and one event was written where two listeners were on
/// the path. A press beside the button reaches the page.
#[test]
fn a_press_the_button_stops_does_not_reach_the_page() {
    let mut app = button();
    let first = frame(&mut app);
    // Come onto the button first, so that the presses are the only events
    // counted below.
    move_to(&mut app, on_the_button(&first));
    let before = app.events_delivered();

    press(&mut app, on_the_button(&first));
    press(&mut app, on_the_button(&first));
    let after_two = frame(&mut app);
    assert_eq!(count(&app, &after_two).1, "2", "the page reset the count");
    assert_eq!(
        app.events_delivered() - before,
        2,
        "the page was offered a press the button stopped"
    );

    move_to(&mut app, (5.0, 5.0));
    let before = app.events_delivered();
    press(&mut app, (5.0, 5.0));
    let after_reset = frame(&mut app);
    assert_eq!(count(&app, &after_reset).1, "0");
    assert_eq!(app.events_delivered() - before, 1);
}

/// The button's fill follows the pointer onto it and off again, which is two
/// listeners each writing one hole.
#[test]
fn the_fill_changes_while_the_pointer_is_over_the_button() {
    let mut app = button();
    let first = frame(&mut app);
    assert_eq!(button_quad(&first).background, Some(RESTING));

    move_to(&mut app, on_the_button(&first));
    fill_becomes(&mut app, HOVERED, "the pointer came onto the button");

    move_to(&mut app, (5.0, 5.0));
    fill_becomes(&mut app, RESTING, "the pointer moved off the button");

    move_to(&mut app, on_the_button(&first));
    fill_becomes(&mut app, HOVERED, "the pointer came back");
    send(&mut app, PointerInput::Left);
    fill_becomes(&mut app, RESTING, "leaving the window leaves the button");
}

/// An event is written for each listener an input reaches, and an input that
/// reaches none wakes nobody.
///
/// Registrations are the host's, so it knows which nodes hear what before it
/// writes anything. The pointer crossing the page, and moving about inside
/// the button once it is there, are both settled without the component.
/// `main` stays the only call the host ever makes.
#[test]
fn an_input_no_listener_hears_does_not_wake_the_component() {
    let mut app = button();
    let first = frame(&mut app);
    let (x, y) = on_the_button(&first);

    app.pointer(PointerInput::Moved { x: 5.0, y: 5.0 });
    app.pointer(PointerInput::Moved { x: 9.0, y: 9.0 });
    assert_eq!(app.undelivered(), 0, "nothing on the page hears a move");
    assert_eq!(app.events_delivered(), 0);

    move_to(&mut app, (x, y));
    assert_eq!(app.events_delivered(), 1, "the button heard `enter`");

    app.pointer(PointerInput::Moved { x: x + 2.0, y });
    assert_eq!(app.undelivered(), 0, "the button hears no `move`");
    assert_eq!(app.events_delivered(), 1);

    press(&mut app, (x, y));
    assert_eq!(app.events_delivered(), 2, "the button heard `down`");
    assert_eq!(app.guest_entries(), 1, "`main` is the one call");
}

/// A listener that changes the tree asks the window for a frame.
///
/// The window sleeps until its next input, and the listener runs on another
/// thread some time after the input that led to it, so nothing else would
/// bring the window round to draw what changed.
#[test]
fn a_handler_that_changes_the_tree_asks_for_a_frame() {
    let mut app = button();
    let first = frame(&mut app);
    let asked = Arc::new(AtomicU32::new(0));
    let count = asked.clone();
    app.woken_by(Arc::new(move || {
        count.fetch_add(1, Ordering::Relaxed);
    }));

    app.pointer(PointerInput::Moved { x: 5.0, y: 5.0 });
    assert_eq!(asked.load(Ordering::Relaxed), 0, "nothing changed");
    assert!(
        !app.wants_another_frame(),
        "a component reading its streams is running, and owes no frame for it"
    );

    press(&mut app, on_the_button(&first));
    assert!(
        asked.load(Ordering::Relaxed) > 0,
        "the count changed and nobody was told"
    );
}
