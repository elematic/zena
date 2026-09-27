//! End-to-end checks of the `zfx` binary CLI.

use std::process::{Command, Output};

fn zfx(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zfx"))
        .args(args)
        .output()
        .expect("failed to launch zfx")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn prints_help_on_flag() {
    let out = zfx(&["--help"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let text = stdout(&out);
    assert!(text.contains("Graphical runtime for Zena components"));
    assert!(text.contains("Usage: zfx"));
}

#[test]
fn reports_error_on_missing_file() {
    let out = zfx(&["non_existent_file.wasm"]);
    assert!(!out.status.success());
    let err = stderr(&out);
    assert!(err.contains("File not found: non_existent_file.wasm"));
}

#[test]
fn reports_error_when_given_nothing_to_run() {
    let out = zfx(&[]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("No .wasm component given"));
}

/// The ZenaFX host primitives with no Wasm in the picture: `--ui` builds a
/// scene in Rust, solves it with taffy, rasterizes it with vello_cpu and
/// presents it through softbuffer. Reaching the first frame means all four
/// worked against a real window.
#[test]
#[ignore = "requires a graphical display; run with: cargo test -p zenafx -- --ignored"]
fn ui_demo_presents_a_frame() {
    assert!(
        wait_for_line(&["--ui"], "presented frame 1"),
        "timed out waiting for the first frame from --ui"
    );
}

/// The same scene as `--ui`, but built by a WebAssembly component: `zfx`
/// binds the component's `zenafx:host` imports, instantiates it, and calls
/// its `render` export once a frame.
#[test]
#[ignore = "requires a graphical display; run with: cargo test -p zenafx -- --ignored"]
fn app_component_presents_a_frame() {
    use std::path::PathBuf;

    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/hello.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `npm run build:example -w @zena-lang/zenafx`",
        wasm.display()
    );
    assert!(
        wait_for_line(&["--app", wasm.to_str().unwrap()], "presented frame 1"),
        "timed out waiting for the first frame from the hello component"
    );
}

#[test]
#[ignore = "requires graphical display and GPU; run with: cargo test -p zenafx -- --ignored"]
fn runs_triangle_component_smoke_test() {
    use std::path::PathBuf;

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/triangle.wasm");
    assert!(fixture.exists(), "fixture {} must exist", fixture.display());

    assert!(
        wait_for_line(&[fixture.to_str().unwrap()], "frame event"),
        "timed out waiting for 'frame event' from triangle.wasm"
    );
}

/// Run `zfx` with `args` and wait up to five seconds for a line containing
/// `needle` on either stream, then kill it. Both streams are watched because
/// `wasi-gfx` prints to stdout while `zfx`'s own logging goes to stderr.
fn wait_for_line(args: &[&str], needle: &str) -> bool {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;

    let mut child = Command::new(env!("CARGO_BIN_EXE_zfx"))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn zfx");

    let (tx, rx) = mpsc::channel();
    let watch = |stream: Box<dyn Read + Send>| {
        let tx = tx.clone();
        let needle = needle.to_owned();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if line.contains(&needle) {
                    let _ = tx.send(());
                    return;
                }
            }
        });
    };
    watch(Box::new(child.stdout.take().expect("no stdout")));
    watch(Box::new(child.stderr.take().expect("no stderr")));
    drop(tx);

    let found = rx.recv_timeout(Duration::from_secs(5)).is_ok();
    let _ = child.kill();
    let _ = child.wait();
    found
}
