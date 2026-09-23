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
#[ignore = "requires graphical display and GPU; run with: cargo test -p zenafx -- --ignored"]
fn runs_triangle_component_smoke_test() {
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/triangle.wasm");
    assert!(fixture.exists(), "fixture {} must exist", fixture.display());

    let mut child = Command::new(env!("CARGO_BIN_EXE_zfx"))
        .arg(&fixture)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn zfx");

    let stdout = child.stdout.take().expect("failed to capture stdout");
    let (tx, rx) = mpsc::channel();

    // Read stdout on a background thread
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                if l.contains("frame event") {
                    let _ = tx.send(true);
                    break;
                }
            }
        }
    });

    // Wait up to 5 seconds for the first frame event
    let frame_rendered = rx.recv_timeout(Duration::from_secs(5));
    let _ = child.kill();
    let _ = child.wait();

    assert!(
        frame_rendered.is_ok(),
        "timed out waiting for 'frame event' from triangle.wasm"
    );
}
