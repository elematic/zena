//! A list that scrolls, wheeled and pressed with no window.
//!
//! `examples/zenafx/scroll/` is forty rows in a box that shows six, under a
//! line saying which row was pressed. The list's box says its content
//! scrolls, and the component does nothing else about it.
//!
//! `ui::scene` has unit tests for the clip, the wheel and the hit test. What
//! these cover is the same thing through a real component: that a list of
//! widgets in a slot scrolls as a list of boxes does, that scrolling writes
//! no event to the component, and that a press after scrolling reaches the
//! row the person can see under the pointer.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::PointerInput;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// How many rows `scroll/main.zena` makes.
const ROWS: usize = 40;

fn list() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/scroll.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:scroll`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the scroll component")
}

/// Draw until a frame owes no other, and return the last one. A frame that
/// finds a new row under the pointer is followed by one more.
fn frame(app: &mut GuestScene) -> Vec<Command> {
    let event = FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    };
    let mut commands = app.frame(event);
    for _ in 0..4 {
        if !app.wants_another_frame() {
            break;
        }
        commands = app.frame(event);
    }
    commands
}

/// The box the rows are cut off at, which is the list's own inside its border.
fn list_box(commands: &[Command]) -> Rect {
    commands
        .iter()
        .find_map(|c| match c {
            Command::PushClip(r) => Some(*r),
            _ => None,
        })
        .unwrap_or_else(|| panic!("nothing is cut off in {commands:?}"))
}

/// Every piece of text a frame draws, with where it put it.
fn texts(app: &GuestScene, commands: &[Command]) -> Vec<(String, f32, f32)> {
    let text = app.text();
    let text = text.lock().unwrap();
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => {
                let content = text.get(g.run).expect("a live run").content().to_owned();
                Some((content, g.x, g.y))
            }
            _ => None,
        })
        .collect()
}

/// The rows a frame draws, by their numbers, top to bottom.
fn rows(app: &GuestScene, commands: &[Command]) -> Vec<u32> {
    texts(app, commands)
        .iter()
        .filter_map(|(content, _, _)| content.strip_prefix("Row ")?.parse().ok())
        .collect()
}

/// What the line above the list says.
fn chosen(app: &GuestScene, commands: &[Command]) -> String {
    texts(app, commands)
        .into_iter()
        .map(|(content, _, _)| content)
        .find(|content| !content.starts_with("Row "))
        .expect("the line above the list")
}

/// Draw a frame and say which rows it drew.
fn rows_now(app: &mut GuestScene) -> Vec<u32> {
    let commands = frame(app);
    rows(app, &commands)
}

/// Draw a frame and say what the line above the list says in it.
fn chosen_now(app: &mut GuestScene) -> String {
    let commands = frame(app);
    chosen(app, &commands)
}

fn wheel(app: &mut GuestScene, list: Rect, dy: f32) -> bool {
    app.pointer(PointerInput::Wheel {
        x: list.x + list.width / 2.0,
        y: list.y + list.height / 2.0,
        dx: 0.0,
        dy,
    })
}

/// Press, and wait for the listeners it reaches to answer.
fn press(app: &mut GuestScene, x: f32, y: f32) {
    app.pointer(PointerInput::Button {
        x,
        y,
        button: 0,
        down: true,
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "the press was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// The list draws the rows that show and no others: forty were made, the
/// first few are drawn, and they are drawn inside the list's box.
#[test]
fn only_the_rows_that_show_are_drawn() {
    let mut app = list();
    let commands = frame(&mut app);
    let shown = rows(&app, &commands);

    assert_eq!(shown.first(), Some(&1));
    assert!(
        shown.len() > 3 && shown.len() < ROWS / 2,
        "a 240 tall list shows a handful of {ROWS} rows, not {shown:?}"
    );
    assert_eq!(shown, (1..=shown.len() as u32).collect::<Vec<_>>());
    // The list is 280 by 240 with a border of 1, and its rows are cut off
    // inside the border.
    let list = list_box(&commands);
    assert_eq!((list.width, list.height), (278.0, 238.0));
}

/// The wheel brings later rows into the list and takes the first ones out,
/// stops when the last row is at the bottom, and none of it is the
/// component's business: no event is written to it, and `main` stays the
/// only call it was ever made.
#[test]
fn the_wheel_scrolls_the_list_without_the_component() {
    let mut app = list();
    let first = frame(&mut app);
    let list = list_box(&first);
    let shown = rows(&app, &first).len() as u32;

    assert!(
        wheel(&mut app, list, 200.0),
        "the rows moved, so a frame is owed"
    );
    let scrolled = rows_now(&mut app);
    assert!(scrolled[0] > 1, "row 1 is still drawn: {scrolled:?}");
    assert!(
        scrolled.last() > Some(&shown),
        "no later row came into view: {scrolled:?}"
    );

    wheel(&mut app, list, 100_000.0);
    let at_the_end = rows_now(&mut app);
    assert_eq!(at_the_end.last(), Some(&(ROWS as u32)));
    assert!(
        !wheel(&mut app, list, 100.0),
        "the list is at its end, so nothing moved and no frame is owed"
    );

    wheel(&mut app, list, -100_000.0);
    assert_eq!(rows_now(&mut app)[0], 1);
    assert_eq!(app.events_delivered(), 0, "scrolling woke the component");
    assert_eq!(app.guest_entries(), 1);
}

/// A press lands on the row drawn under the pointer, wherever the list has
/// scrolled to. The row's label says which it is, and the line above the
/// list says which row heard the press.
#[test]
fn a_press_reaches_the_row_that_scrolled_under_it() {
    let mut app = list();
    let first = frame(&mut app);
    let list = list_box(&first);
    assert_eq!(chosen(&app, &first), "Nothing chosen");

    wheel(&mut app, list, 330.0);
    let scrolled = frame(&mut app);
    // The third label drawn, which is well inside the list.
    let (label, x, y) = texts(&app, &scrolled)
        .into_iter()
        .filter(|(content, _, _)| content.starts_with("Row "))
        .nth(2)
        .expect("a third row");
    let number = label.strip_prefix("Row ").unwrap();
    assert_ne!(number, "3", "the list did not scroll");

    press(&mut app, x + 4.0, y + 4.0);

    let after = frame(&mut app);
    assert_eq!(chosen(&app, &after), format!("Chose row {number}"));
}

/// A press below the list reaches no row, though rows are laid out there:
/// what is cut off is not under the pointer.
#[test]
fn a_press_beside_the_list_reaches_no_row() {
    let mut app = list();
    let first = frame(&mut app);
    let list = list_box(&first);

    press(
        &mut app,
        list.x + list.width / 2.0,
        list.y + list.height + 30.0,
    );

    assert_eq!(app.events_delivered(), 0);
    assert_eq!(chosen_now(&mut app), "Nothing chosen");
}
