//! Which `stdlib_bundle.rs` the binary compiles against, decided by the
//! `bundled` feature rather than by what happens to be on disk.
//!
//! Without the feature the bundle is always the stub: no standard library and
//! no CLI module embedded, which is what an in-repository binary wants — it
//! reads both from the repository (see `resolve_stdlib_dir` and `cli_module`
//! in main.rs), so the embedded copies would be dead weight.
//!
//! With the feature the real bundle is required, and its absence is an error.
//! This used to be a file-existence check that silently fell back to the stub,
//! so `cargo build -p zena-cli` on a fresh clone produced a binary that
//! claimed to be a release build and shipped an empty standard library.

use std::path::PathBuf;

const STUB: &str = r#"
pub static STDLIB_HASH: &str = "";
pub static STDLIB_FILES: &[(&str, &[u8])] = &[];
pub static BUNDLED_CLI_HASH: Option<&str> = None;
pub static BUNDLED_CLI_MODULE: Option<&'static [u8]> = None;
"#;

fn main() {
    println!("cargo:rerun-if-changed=out/stdlib_bundle.rs");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target = out_dir.join("stdlib_bundle.rs");

    if std::env::var_os("CARGO_FEATURE_BUNDLED").is_none() {
        std::fs::write(&target, STUB).expect("Failed to write stub stdlib_bundle.rs to OUT_DIR");
        return;
    }

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let bundle_file = manifest_dir.join("out/stdlib_bundle.rs");
    if !bundle_file.is_file() {
        panic!(
            "--features bundled needs {}, which bundle.zena generates. \
             Build it with `npm run build -w @zena-lang/zena-cli`, or drop the \
             feature for a binary that reads the standard library from the \
             repository.",
            bundle_file.display()
        );
    }
    std::fs::copy(&bundle_file, &target).expect("Failed to copy out/stdlib_bundle.rs to OUT_DIR");
}
