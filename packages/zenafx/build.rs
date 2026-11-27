//! Embeds `out/platform.wasm` when built with `--features bundled`, or emits a
//! stub `None` for in-repo development and tests that load `out/platform.wasm`
//! directly from disk.

use std::path::PathBuf;

const STUB: &str = "pub static BUNDLED_PLATFORM: Option<&'static [u8]> = None;\n";

fn main() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target = out_dir.join("platform_bundle.rs");

    if std::env::var_os("CARGO_FEATURE_BUNDLED").is_none() {
        println!("cargo:rerun-if-changed=build.rs");
        std::fs::write(&target, STUB).expect("failed to write stub platform_bundle.rs");
        return;
    }

    println!("cargo:rerun-if-changed=out/platform.wasm");
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let wasm = manifest_dir.join("out/platform.wasm");
    if !wasm.is_file() {
        panic!(
            "--features bundled needs {}. Build it with `zebra run ./packages/zenafx:build:platform`.",
            wasm.display()
        );
    }
    let code = format!(
        "pub static BUNDLED_PLATFORM: Option<&'static [u8]> = Some(include_bytes!({:?}));\n",
        wasm.to_string_lossy()
    );
    std::fs::write(&target, code).expect("failed to write platform_bundle.rs");
}
