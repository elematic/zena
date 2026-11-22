//! Two disclosures, worked from the keyboard and the pointer with no window.
//!
//! `examples/zenafx/disclosure/` is two summaries, each showing and hiding the
//! lines under it. A summary can have the focus, opens and closes on `Enter`
//! and on a space while it has it, and on a press.
//!
//! `ui::scene` has unit tests for where the focus goes and which listeners a
//! key reaches. What these cover is the same thing through a real component:
//! that `Tab` moves the focus without the component hearing of it, that a key
//! reaches the handlers of the summary with the focus and no other, that a
//! key a handler passes on is still the host's to act on, and that a press
//! moves the focus as well as being heard.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::{KeyEvent, Modifiers, PointerInput};
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Color, Command, FrameEvent, Quad};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// The colour of a summary's edge while it has the focus, from
/// `disclosure/main.zena`.
const RING: Color = Color {
    r: 0.20,
    g: 0.38,
    b: 0.86,
    a: 1.0,
};

fn disclosures() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/disclosure.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:disclosure`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the disclosure component")
}

fn frame(app: &mut GuestScene) -> Vec<Command> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
}

/// The two summaries' boxes. The page paints first, and nothing else in the
/// example has a fill.
fn summaries(commands: &[Command]) -> [Quad; 2] {
    let quads: Vec<Quad> = commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) => Some(*q),
            _ => None,
        })
        .skip(1)
        .collect();
    quads
        .try_into()
        .unwrap_or_else(|quads| panic!("two summaries, not {quads:?}"))
}

/// Which of the two summaries shows the focus ring.
fn ringed(app: &mut GuestScene) -> [bool; 2] {
    summaries(&frame(app)).map(|q| q.border_color == Some(RING))
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
/// its listeners, and through what the host does with a key afterwards.
fn settle(app: &GuestScene) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "an input was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// A key going down, with `Shift` held or not.
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
}

fn press(app: &mut GuestScene, x: f32, y: f32) {
    for down in [true, false] {
        app.pointer(PointerInput::Button {
            x,
            y,
            button: 0,
            down,
        });
    }
    settle(app);
}

/// `Tab` moves the focus from one summary to the next and round, and back
/// with `Shift`. The first `Tab` wakes nobody: nothing has the focus, so the
/// key reaches no listener and the host acts on it there and then.
#[test]
fn tab_moves_the_focus_between_the_summaries() {
    let mut app = disclosures();
    assert_eq!(ringed(&mut app), [false, false]);

    key(&mut app, "Tab", false);
    assert_eq!(ringed(&mut app), [true, false]);
    assert_eq!(
        app.events_delivered(),
        0,
        "no listener was on the key's path"
    );

    key(&mut app, "Tab", false);
    assert_eq!(ringed(&mut app), [false, true]);
    key(&mut app, "Tab", false);
    assert_eq!(ringed(&mut app), [true, false], "round to the first");
    key(&mut app, "Tab", true);
    assert_eq!(ringed(&mut app), [false, true], "and backwards to the last");
}

/// `Enter` opens the summary with the focus and no other, and a space closes
/// it again. The lines under it are there while it is open.
#[test]
fn a_key_opens_the_summary_with_the_focus() {
    let mut app = disclosures();
    assert_eq!(texts(&mut app), ["▸ Shipping", "▸ Returns"]);

    key(&mut app, "Tab", false);
    key(&mut app, "Enter", false);
    assert_eq!(
        texts(&mut app),
        [
            "▾ Shipping",
            "Sent within two working days.",
            "Tracked, and signed for on arrival.",
            "▸ Returns",
        ]
    );

    key(&mut app, " ", false);
    assert_eq!(texts(&mut app), ["▸ Shipping", "▸ Returns"]);

    key(&mut app, "Tab", false);
    key(&mut app, "Enter", false);
    assert_eq!(
        texts(&mut app),
        ["▸ Shipping", "▾ Returns", "Within thirty days, in its box."]
    );
}

/// A key a handler passes on is still the host's. The summary with the focus
/// hears `Tab`, since it listens for keys, and passes it on, and the focus
/// moves all the same.
#[test]
fn a_key_the_component_passes_on_is_still_acted_on() {
    let mut app = disclosures();
    key(&mut app, "Tab", false);
    let before = app.events_delivered();

    key(&mut app, "Tab", false);

    assert_eq!(
        app.events_delivered() - before,
        2,
        "the summary's two key listeners were each offered the key"
    );
    assert_eq!(ringed(&mut app), [false, true], "and neither prevented it");
}

/// A press on a summary opens it and gives it the focus, so the keyboard
/// carries on from where the pointer left off.
#[test]
fn a_press_opens_a_summary_and_gives_it_the_focus() {
    let mut app = disclosures();
    let [_, second] = summaries(&frame(&mut app));
    let (x, y) = (
        second.bounds.x + second.bounds.width / 2.0,
        second.bounds.y + second.bounds.height / 2.0,
    );

    press(&mut app, x, y);
    assert_eq!(ringed(&mut app), [false, true]);
    assert_eq!(
        texts(&mut app),
        ["▸ Shipping", "▾ Returns", "Within thirty days, in its box."]
    );

    key(&mut app, "Enter", false);
    assert_eq!(texts(&mut app), ["▸ Shipping", "▸ Returns"]);
}
