//! Text selected, copied and pasted with no window.
//!
//! `examples/zenafx/selection/` is a title, two paragraphs, a button and a
//! text field. Nothing in the component is about selecting or the clipboard:
//! the host keeps the window's selection, moves it with the pointer, copies
//! it and pastes into the field. `ui::scene` has unit tests for what the
//! pointer selects, and `ui::clipboard` for the clipboard a scene has when
//! it has no window, which is the one used here.
//!
//! What these cover is the whole of it through a real component: that a drag
//! over the page's text writes nothing to the component, that what is copied
//! is what was selected, that a press on the button keeps the selection and
//! still presses the button, and that pasting and cutting change the field's
//! text, which is the component's.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::{KeyEvent, Modifiers, PointerInput};
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// The page's two paragraphs, from `selection/main.zena`.
const FIRST: &str = "Text in a ZenaFX window can be selected, as it can on a web page. \
                     Drag across it, or press twice on a word and three times for a paragraph.";
const SECOND: &str = "Control with C copies what is selected, to paste anywhere. \
                      The component that drew this text is told none of it.";

fn page() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/selection.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:selection`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the selection component")
}

fn frame(app: &mut GuestScene) -> Vec<Command> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
}

/// Every piece of text a frame draws, and where.
fn texts(app: &mut GuestScene) -> Vec<(String, f32, f32)> {
    let commands = frame(app);
    let text = app.text();
    let text = text.lock().unwrap();
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => {
                let says = text.get(g.run).expect("a live run").content().to_owned();
                Some((says, g.x, g.y))
            }
            _ => None,
        })
        .collect()
}

/// Where the text that starts with `starts` is drawn.
fn find(app: &mut GuestScene, starts: &str) -> (f32, f32) {
    let (_, x, y) = texts(app)
        .into_iter()
        .find(|(says, ..)| says.starts_with(starts))
        .unwrap_or_else(|| panic!("no text starting {starts:?}"));
    (x, y)
}

/// Whether a frame draws any text that is exactly `says`.
fn says(app: &mut GuestScene, says: &str) -> bool {
    texts(app).iter().any(|(text, ..)| text == says)
}

/// The boxes a frame draws that have no edge and are no taller than a few
/// lines: the highlights over selected text.
fn highlights(app: &mut GuestScene) -> Vec<Rect> {
    frame(app)
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) if q.border_color.is_none() && q.corner_radius == 0.0 => {
                Some(q.bounds)
            }
            _ => None,
        })
        .filter(|r| r.height < 60.0 && r.width > 2.0)
        .collect()
}

fn settle(app: &GuestScene) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "an input was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn button(app: &mut GuestScene, x: f32, y: f32, down: bool) {
    app.pointer(PointerInput::Button {
        x,
        y,
        button: 0,
        down,
    });
    settle(app);
    frame(app);
}

fn press(app: &mut GuestScene, x: f32, y: f32) {
    button(app, x, y, true);
    button(app, x, y, false);
}

fn drag(app: &mut GuestScene, from: (f32, f32), to: (f32, f32)) {
    button(app, from.0, from.1, true);
    app.pointer(PointerInput::Moved { x: to.0, y: to.1 });
    settle(app);
    button(app, to.0, to.1, false);
}

/// A letter going down with Control held.
fn control(app: &mut GuestScene, letter: &str) {
    app.key(KeyEvent {
        down: true,
        key: letter.to_owned(),
        code: String::new(),
        modifiers: Modifiers {
            control: true,
            ..Modifiers::default()
        },
        repeat: false,
        text: None,
    });
    settle(app);
    frame(app);
}

/// A drag from the first paragraph's start to the end of the second's last
/// line selects both, and Control with `c` puts them on the clipboard with a
/// line break between. The component hears none of it.
#[test]
fn a_drag_selects_text_and_control_c_copies_it() {
    let mut app = page();
    let first = find(&mut app, "Text in a ZenaFX");
    let second = find(&mut app, "Control with C");
    let heard = app.events_delivered();
    let writes = app.writes();

    // The button comes after the second paragraph, 14 below it, and its
    // label is 9 inside it. So this is in the paragraph's last line, and to
    // the right of where that line ends.
    let label = find(&mut app, "Pressed 0 times");
    drag(
        &mut app,
        (first.0 + 1.0, first.1 + 5.0),
        (second.0 + 455.0, label.1 - 9.0 - 14.0 - 6.0),
    );
    assert!(highlights(&mut app).len() >= 2, "a highlight for each line");
    control(&mut app, "c");

    assert_eq!(app.clipboard().read(), Some(format!("{FIRST}\n{SECOND}")));
    assert_eq!(app.events_delivered(), heard, "no event written");
    assert_eq!(app.writes(), writes, "and nothing written back");
}

/// A second press on a word selects it, and copying then gives the word.
#[test]
fn pressing_twice_selects_a_word_to_copy() {
    let mut app = page();
    let title = find(&mut app, "Select any");

    press(&mut app, title.0 + 5.0, title.1 + 10.0);
    press(&mut app, title.0 + 5.0, title.1 + 10.0);
    control(&mut app, "c");

    assert_eq!(app.clipboard().read().as_deref(), Some("Select"));
}

/// Control with `a` selects all the text that can be selected: the title,
/// the paragraphs and the notes, and not the button's label or the field.
#[test]
fn control_a_selects_all_the_text() {
    let mut app = page();

    control(&mut app, "a");
    control(&mut app, "c");

    let copied = app.clipboard().read().expect("something copied");
    let lines: Vec<&str> = copied.lines().collect();
    assert_eq!(
        lines,
        [
            "Select any of this",
            FIRST,
            SECOND,
            "Paste here",
            "The field is empty."
        ]
    );
}

/// A press on the button presses the button, and leaves what was selected
/// selected: its label is not text to select.
#[test]
fn pressing_the_button_keeps_the_selection() {
    let mut app = page();
    let title = find(&mut app, "Select any");
    let label = find(&mut app, "Pressed 0 times");
    press(&mut app, title.0 + 5.0, title.1 + 10.0);
    press(&mut app, title.0 + 5.0, title.1 + 10.0);

    press(&mut app, label.0 + 10.0, label.1 + 8.0);

    assert!(says(&mut app, "Pressed 1 times"), "the button was pressed");
    control(&mut app, "c");
    assert_eq!(app.clipboard().read().as_deref(), Some("Select"));
}

/// Control with `v` pastes into the field with the focus: the text on the
/// clipboard, with its line break made a space, becomes the field's text,
/// which the component then echoes. Control with `x` on a selected word
/// takes it out of the field and puts it on the clipboard.
#[test]
fn pasting_and_cutting_change_the_fields_text() {
    let mut app = page();
    let placeholder = find(&mut app, "Control with V pastes");
    app.clipboard().write("two\nlines");

    press(&mut app, placeholder.0 + 5.0, placeholder.1 + 8.0);
    control(&mut app, "v");
    assert!(says(&mut app, "two lines"), "the field's text");
    assert!(says(&mut app, "The field says: two lines"));

    let field = find(&mut app, "two lines");
    // Away from where the field was first pressed, so that it is a first
    // press again and the next one is the second.
    press(&mut app, field.0 + 60.0, field.1 + 8.0);
    press(&mut app, field.0 + 60.0, field.1 + 8.0);
    control(&mut app, "x");

    assert_eq!(app.clipboard().read().as_deref(), Some("lines"));
    assert!(says(&mut app, "The field says: two "));
}
