//! What a component build's cache entry depends on.
//!
//! A component embeds a second core module — the runtime memory module,
//! `wasi/memory.zena` compiled `freestanding` — which the driver keeps
//! between builds rather than compiling on every one. The program's own
//! sources say nothing about that module. `wasi/memory.zena` is not in
//! the standard library's manifest, so nothing can import it, and it is
//! the one source the runtime module reads that the program does not —
//! `wasi/abi.zena`, which it imports, the program reads for itself. So
//! that one path is what says whether the driver recorded anything.
//!
//! Recording the module's compiled *output* instead looks equivalent and
//! is not. Nothing re-evaluates whether that output should change, so a
//! program whose own sources were untouched reads fresh and is served
//! embedding an allocator that no longer matches its source. These tests
//! drive the real command against a copy of the standard library it may
//! edit, so the second half fails for that version and passes for this
//! one.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// The repository root: this crate is `packages/zena-cli`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// A directory of its own under the system temporary directory, removed
/// by `Scratch`'s `Drop`.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("zena-{name}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).expect("a scratch directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("a destination directory");
    for entry in fs::read_dir(from).expect("a readable directory") {
        let entry = entry.expect("a directory entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("a file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("a copied file");
        }
    }
}

/// A scratch standard library the test may edit, and a cache of its own.
struct Fixture {
    scratch: Scratch,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let scratch = Scratch::new(name);
        copy_tree(
            &repo_root().join("packages/stdlib/zena"),
            &scratch.path().join("stdlib"),
        );
        fs::write(
            scratch.path().join("prog.zena"),
            "export function main(): i32 { return 0; }\n",
        )
        .expect("a written program");
        Self { scratch }
    }

    fn stdlib_root(&self) -> PathBuf {
        self.scratch.path().join("stdlib")
    }

    fn cache_dir(&self) -> PathBuf {
        self.scratch.path().join("cache/wasm_objects")
    }

    /// Compiles and runs `prog.zena` through the cache, as `zena run`
    /// does, and returns the cache entry's module.
    fn run(&self) -> PathBuf {
        let mut command = Command::new(env!("CARGO_BIN_EXE_zena-cli"));
        command
            .arg("run")
            .arg(self.scratch.path().join("prog.zena"))
            .env("ZENA_STDLIB_DIR", self.stdlib_root())
            .env("ZENA_CACHE_DIR", self.scratch.path().join("cache"));
        // Otherwise the developer's own settings decide where the cache
        // is and which compiler fills it. `.envrc` sets the first of
        // these, so this test would read the repository's cache.
        for name in [
            "ZENA_PROJECT_CACHE",
            "ZENA_LOCAL_CACHE",
            "ZENA_COMPILER_WASM",
            "XDG_CACHE_HOME",
            "ZENA_OPT_LEVEL",
        ] {
            command.env_remove(name);
        }
        let output = command.output().expect("the zena command to start");
        assert!(
            output.status.success(),
            "zena run failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        self.cached_module()
    }

    fn cached_module(&self) -> PathBuf {
        let mut found: Option<PathBuf> = None;
        for entry in fs::read_dir(self.cache_dir()).expect("a cache directory") {
            let path = entry.expect("a cache entry").path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with("prog_") && name.ends_with(".wasm") {
                assert!(found.is_none(), "two cache entries for one program");
                found = Some(path);
            }
        }
        found.expect("a cache entry for prog.zena")
    }

    /// The source paths the entry beside `module` lists.
    fn dependency_paths(&self, module: &Path) -> Vec<String> {
        let deps = module.with_extension("deps");
        let text = fs::read_to_string(&deps).expect("a readable .deps file");
        let paths: Vec<String> = text
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| {
                // "<modified> <size> <path>"; the path may contain spaces.
                line.splitn(3, ' ')
                    .nth(2)
                    .unwrap_or_else(|| panic!("a .deps line without two spaces: {line}"))
                    .to_string()
            })
            .collect();
        assert!(!paths.is_empty(), "the entry listed no sources at all");
        paths
    }
}

fn modified(path: &Path) -> SystemTime {
    fs::metadata(path)
        .expect("a module to stat")
        .modified()
        .expect("a modification time")
}

#[test]
fn component_entry_depends_on_the_runtime_memory_module_sources() {
    let fixture = Fixture::new("deps");
    let module = fixture.run();
    let paths = fixture.dependency_paths(&module);

    assert!(
        paths.iter().any(|path| path.ends_with("/wasi/memory.zena")),
        "the entry does not list wasi/memory.zena, the runtime memory \
         module's entry point; it listed {paths:?}",
    );

    for path in &paths {
        assert!(
            !path.ends_with(".wasm"),
            "the entry lists a compiled module, {path}, where it should list \
             the sources behind it: nothing would re-evaluate whether that \
             module should change",
        );
    }
}

#[test]
fn a_change_only_the_runtime_memory_module_reads_invalidates_the_program() {
    let fixture = Fixture::new("stale");
    let module = fixture.run();
    let before = modified(&module);

    // Nothing a program can import reaches this file, so only the
    // runtime memory module's own compile reads it.
    let source = fixture.stdlib_root().join("wasi/memory.zena");
    let text = fs::read_to_string(&source).expect("the runtime memory module's source");
    fs::write(&source, format!("{text}\n// A change the program cannot see.\n"))
        .expect("an edited source");

    let again = fixture.run();
    assert_eq!(again, module, "the cache key changed, which is not the point");
    assert_ne!(
        modified(&module),
        before,
        "the program was served from the cache after a change to the \
         allocator it embeds",
    );
}
