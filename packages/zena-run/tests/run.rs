//! End-to-end checks of the `zena-run` binary on small hand-written
//! components and core modules: the printed return value, the guest's
//! exit status, a reported trap, the cache beside the file, and what it
//! refuses.
//!
//! Everything is in the text format, which wasmtime reads, so the tests
//! need no compiler. Each component is a core module lifted at the
//! component level; a function that never blocks may be lifted
//! synchronously.

use std::path::PathBuf;
use std::process::{Command, Output};

/// Writes `wat` into a fresh temp directory and returns its path. Each
/// test gets its own directory so the `.wat.cwasm` cache files the runner
/// writes beside the component never collide.
fn component_file(test: &str, wat: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zena-run-test-{}-{test}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("c.wat");
    std::fs::write(&path, wat).unwrap();
    path
}

fn zena_run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zena-run"))
        .args(args)
        .output()
        .expect("failed to launch zena-run")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

const RETURNS: &str = r#"(component
  (core module $m
    (func (export "main") (result i32) (i32.const 42)))
  (core instance $i (instantiate $m))
  (func (export "main") (result s32) (canon lift (core func $i "main"))))"#;

#[test]
fn prints_the_result() {
    let path = component_file("returns", RETURNS);
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "42\n");
    // A second run reads the cache written by the first.
    let cwasm = path.with_extension("wat.cwasm");
    assert!(
        cwasm.exists(),
        "expected {} beside the component",
        cwasm.display()
    );
    let again = zena_run(&[path.to_str().unwrap()]);
    assert_eq!(stdout(&again), "42\n");
}

#[test]
fn no_cache_leaves_no_cwasm_behind() {
    let path = component_file("nocache", RETURNS);
    let out = zena_run(&["--no-cache", path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "42\n");
    assert!(!path.with_extension("wat.cwasm").exists());
}

#[test]
fn guest_exit_code_becomes_the_process_status() {
    // `exit-with-code` from wasi:cli 0.3, lowered into the core module.
    let path = component_file(
        "exit",
        r#"(component
          (import "wasi:cli/exit@0.3.0" (instance $exit
            (export "exit-with-code" (func (param "status-code" u8)))))
          (core func $exit (canon lower (func $exit "exit-with-code")))
          (core module $m
            (import "wasi:cli/exit@0.3.0" "exit-with-code" (func $exit (param i32)))
            (func (export "main") (call $exit (i32.const 3))))
          (core instance $i (instantiate $m
            (with "wasi:cli/exit@0.3.0" (instance (export "exit-with-code" (func $exit))))))
          (func (export "main") (canon lift (core func $i "main"))))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
    assert_eq!(stderr(&out), "");
}

#[test]
fn a_trap_is_reported() {
    let path = component_file(
        "trap",
        r#"(component
          (core module $m
            (func (export "main") (result i32) (unreachable)))
          (core instance $i (instantiate $m))
          (func (export "main") (result s32) (canon lift (core func $i "main"))))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("unreachable"),
        "expected the trap in: {}",
        stderr(&out)
    );
}

#[test]
fn refuses_zena_source() {
    let dir = std::env::temp_dir().join(format!("zena-run-test-{}-source", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("prog.zena");
    std::fs::write(&path, "let x = 1;").unwrap();
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("zena build"), "got: {}", stderr(&out));
}

#[test]
fn runs_a_core_module() {
    let path = component_file(
        "core",
        r#"(module (func (export "main") (result i32) (i32.const 5)))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "5\n");
}

#[test]
fn a_core_module_import_it_never_calls_links_to_a_trap() {
    // AssemblyScript output declares `env.abort` whether or not anything
    // calls it; the host provides no imports, and must still run it.
    let path = component_file(
        "core-import",
        r#"(module
          (import "env" "abort" (func $abort (param i32 i32 i32 i32)))
          (func (export "main") (result i32) (i32.const 6)))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "6\n");

    let calls = component_file(
        "core-import-called",
        r#"(module
          (import "env" "abort" (func $abort (param i32 i32 i32 i32)))
          (func (export "main") (result i32)
            (call $abort (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
            (i32.const 6)))"#,
    );
    let out = zena_run(&[calls.to_str().unwrap()]);
    assert!(!out.status.success(), "calling an unprovided import should trap");
}
