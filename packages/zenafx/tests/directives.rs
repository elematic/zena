//! End-to-end tests for guest directives (`cache` and `repeat`) backed by
//! `zenafx:host/scene`'s `create-node` and `set-slot`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use zenafx::loader::{GuestScene, engine};
use zenafx::ui::events::PointerInput;
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{Color, Command, FrameEvent, Quad};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;
const BTN_FILL: Color = Color {
    r: 0.20,
    g: 0.38,
    b: 0.86,
    a: 1.0,
};

fn directives_app() -> GuestScene {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/directives.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `./target/release/zena build ./packages/zenafx:build:directives`",
        wasm.display()
    );
    let engine = engine(false).expect("could not create an engine");
    GuestScene::load(&engine, &wasm).expect("could not load the directives component")
}

fn frame(app: &mut GuestScene) -> Vec<Command> {
    app.frame(FrameEvent {
        time_ms: 0.0,
        width: WIDTH,
        height: HEIGHT,
        scale: 1.0,
    })
}

fn send(app: &mut GuestScene, input: PointerInput) {
    app.pointer(input);
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.undelivered() > 0 {
        assert!(Instant::now() < deadline, "{input:?} was never delivered");
        std::thread::sleep(Duration::from_millis(1));
    }
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

/// The four action buttons, identified by their fill color.
fn button_center(commands: &[Command], index: usize) -> (f32, f32) {
    let quad: Quad = commands
        .iter()
        .filter_map(|c| match c {
            Command::Quad(q) if q.background == Some(BTN_FILL) => Some(*q),
            _ => None,
        })
        .nth(index)
        .unwrap_or_else(|| panic!("no button {index} in {commands:?}"));
    (
        quad.bounds.x + quad.bounds.width / 2.0,
        quad.bounds.y + quad.bounds.height / 2.0,
    )
}

fn glyph_runs(app: &GuestScene, commands: &[Command]) -> Vec<(u32, String, f32)> {
    let text = app.text();
    let text = text.lock().unwrap();
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => {
                let content = text.get(g.run).expect("live run").content().to_owned();
                Some((g.run, content, g.y))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn cache_parks_branch_without_reshaping_and_syncs_on_resume() {
    let mut app = directives_app();
    let first = frame(&mut app);

    let toggle = button_center(&first, 0);
    let update = button_center(&first, 1);

    // Initially details are closed (unvisited branch is never allocated).
    assert!(
        !glyph_runs(&app, &first)
            .iter()
            .any(|(_, s, _)| s == "Initial summary")
    );

    // Open details: mounts branch and shapes "Initial summary".
    press(&mut app, toggle);
    let opened = frame(&mut app);
    let (details_run, _, _) = glyph_runs(&app, &opened)
        .into_iter()
        .find(|(_, s, _)| s == "Initial summary")
        .expect("details should be visible");

    // Close details: parked in host; absent from frame, shaped run still alive.
    let toggle_opened = button_center(&opened, 0);
    press(&mut app, toggle_opened);
    let closed = frame(&mut app);
    assert!(
        !glyph_runs(&app, &closed)
            .iter()
            .any(|(_, s, _)| s == "Initial summary")
    );
    {
        let text = app.text();
        let text = text.lock().unwrap();
        assert_eq!(
            text.get(details_run).expect("parked run stays alive").content(),
            "Initial summary"
        );
    }

    // Update summary while parked: paused effect does not patch the host yet.
    press(&mut app, update);
    let _ = frame(&mut app);
    {
        let text = app.text();
        let text = text.lock().unwrap();
        assert_eq!(
            text.get(details_run).expect("parked run stays alive").content(),
            "Initial summary",
            "paused branch effect should not write while parked"
        );
    }

    // Reopen details: reattaches the exact same parked node & run id, and
    // resumes its effect to sync "Updated summary" in place.
    press(&mut app, toggle);
    let reopened = frame(&mut app);
    let (reopened_run, _, _) = glyph_runs(&app, &reopened)
        .into_iter()
        .find(|(_, s, _)| s == "Updated summary")
        .expect("resumed branch should show updated summary");
    assert_eq!(
        reopened_run, details_run,
        "reopening a cached branch must reuse its parked node and shaped run"
    );
}

#[test]
fn repeat_reorders_without_reshaping_and_drops_removed_rows() {
    let mut app = directives_app();
    let first = frame(&mut app);

    let reverse = button_center(&first, 2);
    let drop_first = button_center(&first, 3);

    let find_rows = |app: &GuestScene, cmds: &[Command]| -> Vec<(u32, String, f32)> {
        glyph_runs(app, cmds)
            .into_iter()
            .filter(|(_, s, _)| matches!(s.as_str(), "Alpha" | "Beta" | "Gamma"))
            .collect()
    };

    let before = find_rows(&app, &first);
    assert_eq!(before.len(), 3);
    assert_eq!(
        before.iter().map(|(_, s, _)| s.as_str()).collect::<Vec<_>>(),
        ["Alpha", "Beta", "Gamma"]
    );
    let (run_a, run_b, run_c) = (before[0].0, before[1].0, before[2].0);

    // Reverse: exact same shaped run ids in reversed order and vertical positions.
    press(&mut app, reverse);
    let reversed = frame(&mut app);
    let after = find_rows(&app, &reversed);
    assert_eq!(after.len(), 3);
    assert_eq!(
        after.iter().map(|(r, _, _)| *r).collect::<Vec<_>>(),
        [run_c, run_b, run_a],
        "reordering keyed rows must preserve each row's shaped text run"
    );
    assert!(after[0].2 < after[1].2 && after[1].2 < after[2].2);

    // Drop first ("Gamma"): its owned host node is dropped and its run freed,
    // while "Beta" and "Alpha" keep their runs.
    press(&mut app, drop_first);
    let dropped = frame(&mut app);
    let remaining = find_rows(&app, &dropped);
    assert_eq!(
        remaining.iter().map(|(r, _, _)| *r).collect::<Vec<_>>(),
        [run_b, run_a]
    );
    let text = app.text();
    let text = text.lock().unwrap();
    assert!(
        text.get(run_c).is_none(),
        "dropped row's shaped text run must be released"
    );
}
