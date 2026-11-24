//! Text in more than one style, with no window.
//!
//! `examples/zenafx/richtext/` is a title, two paragraphs and a note. Each is
//! a flow container: a node whose text children the host lays out as one
//! piece of text. `ui::text` has unit tests for shaping several texts as one,
//! `ui::paint` for the colour each is drawn in, and `ui::scene` for what a
//! flow container does with its children.
//!
//! What these cover is the whole of it through a real component, written in
//! Zena with the helpers a widget uses: that a paragraph of nine text nodes is
//! drawn as one run that wraps at the card's width, and that a word made of
//! three text nodes is one word to select and copy.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::{KeyEvent, Modifiers, PointerInput};
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// The page's first paragraph, from `richtext/main.zena`, where it is nine
/// text nodes.
const FIRST: &str = "Text in a flow container is one piece of text. A phrase can be \
                     set apart, or be in another colour, or be larger, and the lines \
                     still break across all of it.";

/// The card's width less its padding, which is the width a paragraph has.
const COLUMN: f32 = 440.0 - 28.0 - 28.0;

fn page() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/richtext.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:richtext`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the richtext component")
}

fn frame(app: &mut GuestScene) -> Vec<Command> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
}

/// Every run a frame draws: its text, where it is drawn, and how many lines
/// it is broken into.
fn runs(app: &mut GuestScene) -> Vec<(String, f32, f32, usize)> {
    let commands = frame(app);
    let text = app.text();
    let text = text.lock().unwrap();
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => {
                let run = text.get(g.run).expect("a live run");
                Some((run.content().to_owned(), g.x, g.y, run.layout().len()))
            }
            _ => None,
        })
        .collect()
}

fn settle(app: &GuestScene) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "an input was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn press(app: &mut GuestScene, x: f32, y: f32) {
    for down in [true, false] {
        app.pointer(PointerInput::Button {
            x,
            y,
            button: 0,
            down,
        });
        settle(app);
        frame(app);
    }
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

/// The page is four runs, one for each flow container, though it has
/// sixteen text nodes. The first paragraph's nine are joined, and the run
/// wraps at the card's width: it starts where the card's padding ends and is
/// several lines long.
#[test]
fn a_paragraph_of_many_text_nodes_is_one_run_that_wraps() {
    let mut app = page();

    let runs = runs(&mut app);

    let texts: Vec<&str> = runs.iter().map(|(says, ..)| says.as_str()).collect();
    assert_eq!(
        texts,
        [
            "Rich text",
            FIRST,
            "A word that is half bold, like unbelievable, is still one word. \
             Press on it twice.",
            "This note is centred.",
        ]
    );
    let (_, x, _, lines) = &runs[1];
    let card = (WIDTH as f32 - 440.0) / 2.0;
    assert_eq!(*x, card + 28.0, "inside the card's padding");
    assert!(*lines >= 3, "broken into {lines} lines");
    let (_, _, _, lines) = &runs[0];
    assert_eq!(*lines, 1, "the title fits on one");
}

/// A second press on a word that is three text nodes selects the whole
/// word, and copying gives it.
#[test]
fn a_word_of_three_text_nodes_is_selected_as_one() {
    let mut app = page();
    let (run, x, y) = {
        let commands = frame(&mut app);
        let second = commands
            .iter()
            .filter_map(|c| match c {
                Command::Glyphs(g) => Some(*g),
                _ => None,
            })
            .nth(2)
            .expect("the second paragraph");
        (second.run, second.x, second.y)
    };
    // Where the `l` of `believ` is: in the bold text node, in the middle of
    // the word.
    let at = {
        let text = app.text();
        let text = text.lock().unwrap();
        let index = text
            .get(run)
            .expect("a run")
            .content()
            .find("liev")
            .unwrap();
        text.caret(run, index as u32, 0.0).expect("a caret")
    };
    let (px, py) = (x + at.x + 2.0, y + at.y + at.height / 2.0);

    press(&mut app, px, py);
    press(&mut app, px, py);
    control(&mut app, "c");

    assert_eq!(app.clipboard().read().as_deref(), Some("unbelievable"));
}

/// The note is centred: its one line starts in from the left of the column
/// by half the room it leaves.
#[test]
fn a_centred_flow_container_centres_its_line() {
    let mut app = page();
    let runs = runs(&mut app);
    let (_, x, ..) = runs[3];
    let commands = frame(&mut app);
    let note = commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => Some(*g),
            _ => None,
        })
        .nth(3)
        .expect("the note");

    let text = app.text();
    let text = text.lock().unwrap();
    let start = text.caret(note.run, 0, 0.0).expect("a caret").x;
    let end = text
        .caret(note.run, "This note is centred.".len() as u32, 0.0)
        .expect("a caret")
        .x;

    let room = COLUMN - (end - start);
    assert!(room > 100.0, "the note is short: {room} to spare");
    assert!(
        (start - room / 2.0).abs() < 1.0,
        "starts {start} in, of {room}"
    );
    assert_eq!(x, (WIDTH as f32 - 440.0) / 2.0 + 28.0);
}
