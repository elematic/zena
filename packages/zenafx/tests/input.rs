//! Two text fields, typed into and pointed at with no window.
//!
//! `examples/zenafx/input/` is two text fields written in Zena. The text and
//! what each key does to it are the component's, and have their own tests in
//! `input/editing_test.zena`. The selection is the host's: the pointer moves
//! it with no call to the component, the host draws the caret and the
//! highlight, and it scrolls a field to keep its caret in sight. `ui::scene`
//! and `ui::text` have unit tests for each of those.
//!
//! What these cover is the two halves working through a real component: that
//! typed text reaches the field with the focus and no other, that a key edits
//! where the pointer left the selection, that the pointer selects without
//! the component hearing of it, and that a field holding more than it shows
//! follows its caret.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::{KeyEvent, Modifiers, PointerInput};
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Color, Command, FrameEvent, Glyphs, Quad, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// From `input/text-input.zena`: the colour of the edge of the field with the
/// focus, and how far inside a field its text starts.
const RING: Color = Color {
    r: 0.20,
    g: 0.38,
    b: 0.86,
    a: 1.0,
};
const INSET: f32 = 12.0;

fn fields() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/input.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:input`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the input component")
}

fn frame(app: &mut GuestScene) -> Vec<Command> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
}

/// What one frame shows of one field.
#[derive(Debug)]
struct Field {
    /// The field's own box.
    edge: Quad,
    /// What it says, and where the text starts.
    says: String,
    text_at: f32,
    /// What it says beside its text, which is something while it is empty.
    placeholder: String,
    /// The caret and the highlight, when the field has the focus.
    caret: Option<Rect>,
    highlight: Option<Rect>,
}

/// Draw a frame and read the two fields off it.
///
/// A field's box is the only thing with an edge. Two runs are drawn inside
/// it, its text and then its placeholder, and a box with no edge inside it
/// is the highlight if it is wider than a caret and the caret if not.
fn shown(app: &mut GuestScene) -> [Field; 2] {
    let commands = frame(app);
    let text = app.text();
    let text = text.lock().unwrap();
    let within = |outer: Rect, x: f32, y: f32| {
        x >= outer.x - 400.0
            && x < outer.x + outer.width
            && y >= outer.y
            && y < outer.y + outer.height
    };
    let edges: Vec<Quad> = commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) if q.border_color.is_some() => Some(*q),
            _ => None,
        })
        .collect();
    let fields: Vec<Field> = edges
        .into_iter()
        .map(|edge| {
            let inside = |r: Rect| within(edge.bounds, r.x, r.y + r.height / 2.0);
            let runs: Vec<Glyphs> = commands
                .iter()
                .filter_map(|c| match c {
                    Command::Glyphs(g) if within(edge.bounds, g.x, g.y) => Some(*g),
                    _ => None,
                })
                .collect();
            let said = |run: &Glyphs| text.get(run.run).expect("a live run").content().to_owned();
            // The placeholder comes after the text, so text longer than the
            // field pushes it out of sight, and it is not drawn then.
            assert!(!runs.is_empty(), "a field's text");
            let plain: Vec<Rect> = commands
                .iter()
                .filter_map(|c| match c {
                    Command::Quad(q) if q.border_color.is_none() && inside(q.bounds) => {
                        Some(q.bounds)
                    }
                    _ => None,
                })
                // The page is a box with no edge too, and far taller than a line.
                .filter(|r| r.height < 60.0)
                .collect();
            Field {
                edge,
                says: said(&runs[0]),
                text_at: runs[0].x,
                placeholder: runs.get(1).map(said).unwrap_or_default(),
                caret: plain.iter().copied().find(|r| r.width <= 2.0),
                highlight: plain.iter().copied().find(|r| r.width > 2.0),
            }
        })
        .collect();
    fields
        .try_into()
        .unwrap_or_else(|fields| panic!("two fields, not {fields:?}"))
}

/// Every piece of text a frame draws.
fn texts(app: &mut GuestScene) -> Vec<String> {
    let commands = frame(app);
    let text = app.text();
    let text = text.lock().unwrap();
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => Some(text.get(g.run).expect("a live run").content().to_owned()),
            _ => None,
        })
        .collect()
}

/// Wait until everything handed to the component's thread has been through
/// its listeners.
fn settle(app: &GuestScene) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "an input was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// A key going down that types nothing, with `Shift` held or not.
fn key(app: &mut GuestScene, name: &str, shift: bool) {
    app.key(KeyEvent {
        down: true,
        key: name.to_owned(),
        code: name.to_owned(),
        modifiers: Modifiers {
            shift,
            ..Modifiers::default()
        },
        repeat: false,
        text: None,
    });
    settle(app);
    frame(app);
}

/// Type `text`, a key for each character.
fn type_in(app: &mut GuestScene, text: &str) {
    for typed in text.chars() {
        app.key(KeyEvent {
            down: true,
            key: typed.to_string(),
            code: String::new(),
            modifiers: Modifiers::default(),
            repeat: false,
            text: Some(typed.to_string()),
        });
        settle(app);
    }
    frame(app);
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

/// Press and release at a point.
fn press(app: &mut GuestScene, x: f32, y: f32) {
    button(app, x, y, true);
    button(app, x, y, false);
}

/// The middle of a field's height, which is on its line of text.
fn line_of(field: &Field) -> f32 {
    field.edge.bounds.y + field.edge.bounds.height / 2.0
}

/// A press gives a field the focus and a caret, and what is typed then goes
/// into that field and to whoever asked to hear it change. The other field
/// shows its placeholder throughout.
#[test]
fn typing_fills_the_field_with_the_focus() {
    let mut app = fields();
    let [name, message] = shown(&mut app);
    assert_eq!(
        (name.says.as_str(), name.placeholder.as_str()),
        ("", "Your name")
    );
    assert!(name.caret.is_none() && message.caret.is_none());

    // On the placeholder, which is beside the text and not part of it.
    press(&mut app, name.edge.bounds.x + 60.0, line_of(&name));
    let [name, _] = shown(&mut app);
    assert_eq!(name.edge.border_color, Some(RING));
    let caret = name.caret.expect("a caret in the field with the focus");
    assert!(
        (caret.x - (name.edge.bounds.x + INSET)).abs() < 1.0,
        "at the start of an empty field, before its placeholder: {caret:?}"
    );

    type_in(&mut app, "Ada");
    let [name, message] = shown(&mut app);
    assert_eq!((name.says.as_str(), name.placeholder.as_str()), ("Ada", ""));
    assert_eq!(message.placeholder, "Enter sends it");
    assert!(message.caret.is_none());
    assert!(texts(&mut app).contains(&"Hello, Ada.".to_owned()));
}

/// The arrows, Home, End and Backspace edit where the caret is, and the
/// caret drawn moves with them.
#[test]
fn the_caret_moves_and_edits_where_it_is() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    press(&mut app, name.edge.bounds.x + 100.0, line_of(&name));
    type_in(&mut app, "Ada");
    let at_the_end = shown(&mut app)[0].caret.expect("a caret").x;

    key(&mut app, "ArrowLeft", false);
    let one_back = shown(&mut app)[0].caret.expect("a caret").x;
    assert!(one_back < at_the_end, "{one_back} is left of {at_the_end}");

    type_in(&mut app, "n");
    assert_eq!(shown(&mut app)[0].says, "Adna");
    key(&mut app, "Backspace", false);
    assert_eq!(shown(&mut app)[0].says, "Ada");

    key(&mut app, "Home", false);
    type_in(&mut app, "L");
    key(&mut app, "End", false);
    type_in(&mut app, "!");
    assert_eq!(shown(&mut app)[0].says, "LAda!");
}

/// Shift with an arrow selects, the selection is drawn as a highlight, and
/// what is typed next takes its place.
#[test]
fn a_selection_is_drawn_and_typed_over() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    press(&mut app, name.edge.bounds.x + 100.0, line_of(&name));
    type_in(&mut app, "hello");
    assert!(shown(&mut app)[0].highlight.is_none());

    key(&mut app, "ArrowLeft", true);
    key(&mut app, "ArrowLeft", true);
    let [name, _] = shown(&mut app);
    let highlight = name.highlight.expect("a highlight over what is selected");
    let caret = name.caret.expect("a caret");
    assert!(
        (caret.x - highlight.x).abs() < 1.0,
        "the caret is at the moving end"
    );

    type_in(&mut app, "p");
    let [name, _] = shown(&mut app);
    assert_eq!(name.says, "help");
    assert!(name.highlight.is_none());
}

/// `Tab` is passed on by the field and moves the focus to the next one.
/// Enter in the second field sends what it holds, and the first keeps what
/// was typed into it.
#[test]
fn tab_moves_to_the_next_field_and_enter_sends() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    press(&mut app, name.edge.bounds.x + 100.0, line_of(&name));
    type_in(&mut app, "Ada");

    key(&mut app, "Tab", false);
    let [name, message] = shown(&mut app);
    assert_ne!(name.edge.border_color, Some(RING));
    assert_eq!(message.edge.border_color, Some(RING));
    assert!(name.caret.is_none() && message.caret.is_some());

    type_in(&mut app, "hi");
    assert!(texts(&mut app).contains(&"Nothing sent yet.".to_owned()));
    key(&mut app, "Enter", false);
    assert!(texts(&mut app).contains(&"Sent: hi".to_owned()));
    let [name, message] = shown(&mut app);
    assert_eq!((name.says.as_str(), message.says.as_str()), ("Ada", "hi"));
}

/// A press puts the caret at the place in the text nearest it: at the start
/// when it lands on the field's leading padding, at the end when it lands
/// past the text, and between two letters when it lands between them.
#[test]
fn a_press_puts_the_caret_where_it_lands() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    let (left, y) = (name.edge.bounds.x, line_of(&name));
    press(&mut app, left + 100.0, y);
    type_in(&mut app, "world");
    let after_the_o = {
        key(&mut app, "Home", false);
        key(&mut app, "ArrowRight", false);
        key(&mut app, "ArrowRight", false);
        shown(&mut app)[0].caret.expect("a caret").x
    };

    press(&mut app, left + 3.0, y);
    type_in(&mut app, "[");
    assert_eq!(shown(&mut app)[0].says, "[world");

    press(&mut app, left + 250.0, y);
    type_in(&mut app, "]");
    assert_eq!(shown(&mut app)[0].says, "[world]");

    // Where the caret stood after "wo", moved along by the "[" now before it.
    let bracket = shown(&mut app)[0].text_at;
    key(&mut app, "Home", false);
    key(&mut app, "ArrowRight", false);
    let moved_along = shown(&mut app)[0].caret.expect("a caret").x - bracket;
    press(&mut app, after_the_o + moved_along + 1.0, y);
    type_in(&mut app, "-");
    assert_eq!(shown(&mut app)[0].says, "[wo-rld]");
}

/// A press that is dragged selects from where it began to where the pointer
/// is, also once the pointer has left the field. The host does it: the
/// component is written no event for the press, the drag or the release.
/// What is typed then replaces the selection, since the component asks
/// where the selection is before it edits.
#[test]
fn a_drag_selects_what_it_passes_over() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    let (left, y) = (name.edge.bounds.x, line_of(&name));
    press(&mut app, left + 100.0, y);
    type_in(&mut app, "hello world");
    let heard = app.events_delivered();

    button(&mut app, left + 3.0, y, true);
    app.pointer(PointerInput::Moved {
        x: left + 600.0,
        y: y + 200.0,
    });
    settle(&app);
    let [name, _] = shown(&mut app);
    let highlight = name.highlight.expect("a highlight");
    assert!(
        (highlight.x - (left + INSET)).abs() < 1.0,
        "from the start: {highlight:?}"
    );
    assert!(highlight.width > 50.0, "to the end: {highlight:?}");
    button(&mut app, left + 600.0, y + 200.0, false);
    assert_eq!(app.events_delivered(), heard, "the pointer wrote nothing");

    type_in(&mut app, "x");
    assert_eq!(shown(&mut app)[0].says, "x");
}

/// A second press in the same place selects the word there, and what is
/// typed next takes the word's place.
#[test]
fn pressing_twice_selects_a_word() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    let (left, y) = (name.edge.bounds.x, line_of(&name));
    press(&mut app, left + 200.0, y);
    type_in(&mut app, "hello world");

    press(&mut app, left + INSET + 8.0, y);
    assert!(shown(&mut app)[0].highlight.is_none());
    press(&mut app, left + INSET + 8.0, y);
    let highlight = shown(&mut app)[0].highlight.expect("the word, selected");
    assert!((highlight.x - (left + INSET)).abs() < 1.0, "{highlight:?}");

    type_in(&mut app, "goodbye");
    assert_eq!(shown(&mut app)[0].says, "goodbye world");
}

/// A press with `Shift` held moves the end of the selection to the pointer
/// and leaves where it began.
#[test]
fn shift_with_a_press_extends_the_selection() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    let (left, y) = (name.edge.bounds.x, line_of(&name));
    press(&mut app, left + 200.0, y);
    type_in(&mut app, "hello world");

    press(&mut app, left + 3.0, y);
    key(&mut app, "Shift", false);
    press(&mut app, left + 250.0, y);

    let highlight = shown(&mut app)[0].highlight.expect("all of it, selected");
    assert!((highlight.x - (left + INSET)).abs() < 1.0, "{highlight:?}");
    type_in(&mut app, "x");
    assert_eq!(shown(&mut app)[0].says, "x");
}

/// A field holding more text than it shows is scrolled so that its caret
/// shows: the text starts left of the field while the caret is at its end,
/// and back where it began once the caret is at the start.
#[test]
fn a_full_field_follows_its_caret() {
    let mut app = fields();
    let [name, _] = shown(&mut app);
    let bounds = name.edge.bounds;
    press(&mut app, bounds.x + 100.0, line_of(&name));
    let at_rest = shown(&mut app)[0].text_at;

    type_in(
        &mut app,
        "a name far longer than any field is going to be wide",
    );
    let [name, _] = shown(&mut app);
    assert!(name.text_at < bounds.x, "the text has moved left: {name:?}");
    let caret = name.caret.expect("a caret");
    assert!(
        caret.x > bounds.x && caret.x + caret.width <= bounds.x + bounds.width,
        "the caret is in the field: {caret:?} in {bounds:?}"
    );

    key(&mut app, "Home", false);
    let [name, _] = shown(&mut app);
    assert_eq!(name.text_at, at_rest, "back where it began");
}
