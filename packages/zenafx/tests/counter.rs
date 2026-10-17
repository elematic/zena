//! Two counters, one template instantiated twice, each advancing on its own
//! `sleep` from `zena:time`.
//!
//! `examples/zenafx/counter/` registers a two-node template, instantiates it
//! per counter, and writes one binding when a counter's sleep comes due. What
//! these assertions cover is the half of the design the widgets example cannot
//! show: that an update patches one node rather than rebuilding a tree, and
//! that the rate belongs to the component rather than to the frame loop.
//!
//! The evidence for "patched, not rebuilt" is the shaped run. A rebuilt node
//! gets a fresh one, so a stable run id whose measurement changes means the
//! node itself survived.
//!
//! ## Why the timing tests are ignored
//!
//! A counter's period comes from `wasi:clocks`, which the host supplies and
//! which runs in real time. There is no way yet to hand a component a clock the
//! test controls, so an assertion about "ten periods have passed" has to wait
//! out ten real periods — seconds of suite time each, and flaky under load.
//! They are `#[ignore]`d until a fake monotonic clock can be substituted for
//! the default, and run by hand with:
//!
//! ```text
//! cargo test -p zenafx --test counter -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Command, FrameEvent, Rect};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

/// The faster of the two periods in `counter/main.zena`.
const FAST: Duration = Duration::from_millis(500);

fn frame_at(time_ms: f64) -> FrameEvent {
    FrameEvent {
        time_ms,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    }
}

fn counter() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/counter.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `npm run build:counter -w @zena-lang/zenafx`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the counter component")
}

fn quads(commands: &[Command]) -> Vec<Rect> {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) => Some(q.bounds),
            _ => None,
        })
        .collect()
}

fn runs(commands: &[Command]) -> Vec<u32> {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => Some(g.run),
            _ => None,
        })
        .collect()
}

/// Draw frames at roughly 60Hz until `how_long` of real time has passed,
/// returning the last frame's commands.
///
/// The pacing matters. A frame holds the scene and text locks for its whole
/// solve and paint, so a loop that draws flat out starves the component's
/// thread of the locks it needs to write a binding — the counters then advance
/// a handful of times in five seconds instead of ten. At 60Hz a frame is a
/// couple of milliseconds out of sixteen and the component gets the rest.
fn run_for(app: &mut GuestScene, how_long: Duration) -> Vec<Command> {
    let started = Instant::now();
    let mut commands = app.frame(frame_at(0.0));
    while started.elapsed() < how_long {
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        commands = app.frame(frame_at(elapsed));
        std::thread::sleep(Duration::from_millis(16));
    }
    commands
}

/// The template was instantiated twice under one page, so the first frame
/// draws three quads — the page and two dials — and two glyph runs.
#[test]
fn the_first_frame_draws_both_instances() {
    let mut app = counter();
    let commands = app.frame(frame_at(0.0));
    assert_eq!(quads(&commands).len(), 3, "page and two dials: {commands:?}");
    assert_eq!(runs(&commands).len(), 2, "two sets of digits: {commands:?}");
}

/// `main` is the one call into the component.
///
/// Writing a binding later does not re-enter it: the host re-enters the
/// entry's *task* through its callback, which is not another call to `main`.
#[test]
fn the_entry_is_called_once() {
    let mut app = counter();
    assert_eq!(app.guest_entries(), 1, "`main` is the one entry");
    app.frame(frame_at(0.0));
    assert_eq!(app.guest_entries(), 1, "a frame does not call `main` again");
}

/// A counter with a sleep armed leaves its task running, so the host knows it
/// owes another frame without being told what changed.
#[test]
fn a_counting_component_owes_another_frame() {
    let mut app = counter();
    app.frame(frame_at(0.0));
    assert!(
        app.wants_another_frame(),
        "a counter is always waiting on its next period"
    );
}

/// Neither counter ever adds a node. The tree is the page and two instances
/// from the first frame to the last.
#[test]
#[ignore = "waits out real sleeps; needs a substitutable clock"]
fn counting_does_not_grow_the_tree() {
    let mut app = counter();
    let started = Instant::now();
    while started.elapsed() < 2 * FAST {
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let commands = app.frame(frame_at(elapsed));
        assert_eq!(
            (quads(&commands).len(), runs(&commands).len()),
            (3, 2),
            "frame at {elapsed}ms drew {commands:?}"
        );
        std::thread::sleep(Duration::from_millis(16));
    }
}

/// Writing a binding leaves the node and its shaped run in place.
///
/// Both run ids are the same after ten periods, so neither text node was
/// rebuilt, and the fast counter's run measures wider once it reaches two
/// digits, so it really was reshaped.
#[test]
#[ignore = "waits out real sleeps; needs a substitutable clock"]
fn a_binding_write_keeps_the_node_and_reshapes_its_run() {
    let mut app = counter();

    let first = app.frame(frame_at(0.0));
    let early = runs(&first);
    let early_width = app.text().lock().unwrap().measure_run(early[0], None).width;

    // Ten periods of the fast counter, so it reads "10" — two digits.
    let late_commands = run_for(&mut app, 10 * FAST + Duration::from_millis(300));
    let late = runs(&late_commands);
    let late_width = app.text().lock().unwrap().measure_run(late[0], None).width;

    assert_eq!(
        early, late,
        "a run id changed, so a node was rebuilt rather than patched"
    );
    assert!(
        late_width > early_width + 1.0,
        "one digit then two should measure wider: {early_width} then {late_width}"
    );
}

/// Each counter advances on its own period.
///
/// After ten periods of the 500ms counter it reads "10" and the 1500ms counter
/// reads "3", so the first measures two characters wide and the second one —
/// which it could not if both advanced on the same clock.
#[test]
#[ignore = "waits out real sleeps; needs a substitutable clock"]
fn each_counter_keeps_its_own_rate() {
    let mut app = counter();

    let commands = run_for(&mut app, 10 * FAST + Duration::from_millis(300));
    let later = runs(&commands);
    let fast = app.text().lock().unwrap().measure_run(later[0], None).width;
    let slow = app.text().lock().unwrap().measure_run(later[1], None).width;

    assert!(
        fast > slow + 1.0,
        "two digits should measure wider than one: {fast} against {slow}"
    );
}

/// The two dials sit side by side, and the one whose digits are wider is
/// wider, so a binding write goes through layout rather than around it.
#[test]
#[ignore = "waits out real sleeps; needs a substitutable clock"]
fn the_wider_counter_gets_the_wider_dial() {
    let mut app = counter();

    let commands = run_for(&mut app, 10 * FAST + Duration::from_millis(300));
    let dials = quads(&commands);
    let (fast_dial, slow_dial) = (dials[1], dials[2]);

    assert!(
        fast_dial.width > slow_dial.width + 1.0,
        "two digits should make a wider dial: {fast_dial:?} against {slow_dial:?}"
    );
    assert!(
        (fast_dial.y - slow_dial.y).abs() < 1.0,
        "the dials sit in a row: {fast_dial:?} against {slow_dial:?}"
    );
}
