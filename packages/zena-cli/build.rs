use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=out/stdlib_bundle.rs");

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let bundle_file = manifest_dir.join("out/stdlib_bundle.rs");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target = out_dir.join("stdlib_bundle.rs");

    if bundle_file.is_file() {
        std::fs::copy(&bundle_file, &target)
            .expect("Failed to copy out/stdlib_bundle.rs to OUT_DIR");
    } else {
        // Fallback stub for initial bootstrap build before bundle.zena runs.
        let stub = r#"
pub static STDLIB_HASH: &str = "";
pub static STDLIB_FILES: &[(&str, &[u8])] = &[];
pub static BUNDLED_CLI_HASH: Option<&str> = None;
pub static BUNDLED_CLI_MODULE: Option<&'static [u8]> = None;
"#;
        std::fs::write(&target, stub).expect("Failed to write stub stdlib_bundle.rs to OUT_DIR");
    }
}
