//! Packages outside the project.
//!
//! A project outside this repository names packages that live elsewhere:
//! a sibling checkout (`../zena/packages/google-cloud/zena`), or a
//! package manager's cache, by absolute path. The compiler reads
//! `zena-packages.json` from its working directory, the project root, and
//! the CLI module gives it the root's absolute path, so a `..` entry is
//! read by its absolute path and an absolute entry as written.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

/// The repository root: this crate is `packages/zena-cli`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// A directory of its own under the system temporary directory, removed
/// on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("zena-{name}-{}-{unique}", std::process::id()));
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

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().expect("a parent directory")).expect("a directory");
    fs::write(path, text).expect("a written file");
}

/// Lays out `scratch` as a project, `project/`, beside two libraries,
/// `libs/near` (named in the package map as `../libs/near`) and
/// `libs/far` (named by its absolute path).
fn layout(scratch: &Scratch) -> PathBuf {
    let project = scratch.path().join("project");
    let far = scratch.path().join("libs/far");
    write(
        &scratch.path().join("libs/near/numbers.zena"),
        "export function two(): i32 { return 2; }\n",
    );
    write(
        &far.join("numbers.zena"),
        "export function three(): i32 { return 3; }\n",
    );
    write(
        &project.join("zena-packages.json"),
        &format!(
            "{{\"packages\": {{\"near\": \"../libs/near\", \"far\": \"{}\"}}}}\n",
            far.display()
        ),
    );
    write(
        &project.join("prog.zena"),
        "import { two } from 'near:numbers';\n\
         import { three } from 'far:numbers';\n\
         export function main(): i32 {\n  \
           return two() * three() - 6;\n\
         }\n",
    );
    write(
        &project.join("numbers_test.zena"),
        "import { suite, test } from 'zena:test';\n\
         import { equal } from 'zena:assert';\n\
         import { two } from 'near:numbers';\n\
         import { three } from 'far:numbers';\n\
         \n\
         export let tests = suite('numbers', () => {\n  \
           test('both packages load', (ctx) => {\n    \
             equal(two() + three(), 5);\n  \
           });\n\
         });\n",
    );
    project
}

/// Runs the zena command in `project` as a project of its own, with a
/// cache in `scratch`.
fn zena_in(project: &Path, scratch: &Scratch, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_zena-cli"));
    command
        .args(args)
        .current_dir(project)
        .env("ZENA_REPO_ROOT", project)
        .env(
            "ZENA_CLI_MODULE",
            repo_root().join("packages/zena-cli/out/zena.wasm"),
        )
        .env("ZENA_STDLIB_DIR", repo_root().join("packages/stdlib/zena"))
        .env("ZENA_CACHE_DIR", scratch.path().join("cache"));
    for name in [
        "ZENA_PROJECT_CACHE",
        "ZENA_LOCAL_CACHE",
        "ZENA_COMPILER_WASM",
        "XDG_CACHE_HOME",
        "ZENA_OPT_LEVEL",
    ] {
        command.env_remove(name);
    }
    command.output().expect("the zena command to start")
}

fn assert_success(what: &str, output: &Output) {
    assert!(
        output.status.success(),
        "{what} failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn run_reads_packages_above_the_project_and_at_absolute_paths() {
    let scratch = Scratch::new("package-map-run");
    let project = layout(&scratch);
    let output = zena_in(&project, &scratch, &["run", "prog.zena"]);
    assert_success("zena run", &output);
}

#[test]
fn test_reads_packages_above_the_project_and_at_absolute_paths() {
    let scratch = Scratch::new("package-map-test");
    let project = layout(&scratch);
    let output = zena_in(&project, &scratch, &["test", "numbers_test.zena"]);
    assert_success("zena test", &output);
}
