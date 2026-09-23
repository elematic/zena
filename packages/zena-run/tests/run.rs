//! End-to-end checks of the `zena-run` binary on small hand-written
//! modules: WASI output, the printed return value, the guest's exit
//! status, and the `env` imports a `zena-cli`-target module declares.

use std::path::PathBuf;
use std::process::{Command, Output};

/// Writes `wat` into a fresh temp directory and returns its path. Each
/// test gets its own directory so the `.wat.cwasm` cache files the runner
/// writes beside the module never collide.
fn module_file(test: &str, wat: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zena-run-test-{}-{test}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("m.wat");
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

const HELLO: &str = r#"(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "hello\n")
  (func (export "main") (result i32)
    ;; one iovec at address 0: pointer 8, length 6
    (i32.store (i32.const 0) (i32.const 8))
    (i32.store (i32.const 4) (i32.const 6))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 20)))
    (i32.const 42)))"#;

#[test]
fn prints_wasi_output_then_the_result() {
    let path = module_file("hello", HELLO);
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "hello\n42\n");
    // A second run reads the cache written by the first.
    let cwasm = path.with_extension("wat.cwasm");
    assert!(
        cwasm.exists(),
        "expected {} beside the module",
        cwasm.display()
    );
    let again = zena_run(&[path.to_str().unwrap()]);
    assert_eq!(stdout(&again), "hello\n42\n");
}

#[test]
fn no_cache_leaves_no_cwasm_behind() {
    let path = module_file("nocache", HELLO);
    let out = zena_run(&["--no-cache", path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "hello\n42\n");
    assert!(!path.with_extension("wat.cwasm").exists());
}

#[test]
fn guest_exit_code_becomes_the_process_status() {
    let path = module_file(
        "exit",
        r#"(module
          (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
          (memory (export "memory") 1)
          (func (export "main") (call $exit (i32.const 3))))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
    assert_eq!(stderr(&out), "");
}

#[test]
fn links_the_stack_trace_imports() {
    // The shape every zena-cli-target module has: `Error`'s constructor
    // captures a trace, and formatting it needs the string helpers.
    let path = module_file(
        "stack",
        r#"(module
          (import "env" "captureStackTrace" (func $capture (result externref)))
          (import "env" "formatStackTrace" (func $format (param externref) (result externref)))
          (memory (export "memory") 1)
          (func (export "$stringCreate") (param i32) (result externref) (ref.null extern))
          (func (export "$stringSetByte") (param externref i32 i32))
          (func (export "main") (result i32)
            (drop (call $format (call $capture)))
            (i32.const 7)))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "7\n");
}

#[test]
fn process_imports_trap_without_the_grant() {
    let path = module_file(
        "spawn",
        r#"(module
          (import "zena_process" "cmd_new" (func $cmd_new (result externref)))
          (memory (export "memory") 1)
          (func (export "main") (drop (call $cmd_new))))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("--allow-spawn"),
        "expected the grant hint in: {}",
        stderr(&out)
    );
    let allowed = zena_run(&["--allow-spawn", path.to_str().unwrap()]);
    assert!(allowed.status.success(), "stderr: {}", stderr(&allowed));
}

#[test]
fn wasm_imports_trap_without_the_grant() {
    // Running a module is granted with spawning; the real imports are
    // exercised end to end by packages/stdlib/tests/wasm, which runs
    // under the grant.
    let path = module_file(
        "run-module",
        r#"(module
          (import "zena_wasm" "run_new" (func $run_new (param externref) (result externref)))
          (memory (export "memory") 1)
          (func (export "main") (drop (call $run_new (ref.null extern)))))"#,
    );
    let out = zena_run(&[path.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("zena:wasm needs the same explicit grant"),
        "expected the grant hint in: {}",
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
