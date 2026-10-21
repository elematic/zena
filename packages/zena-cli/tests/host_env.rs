//! The variables the host sets for the CLI module, as against the
//! shell's.
//!
//! The host gives the CLI module the shell's environment and then sets
//! `ZENA_STDLIB_DIR`, `ZENA_REPO_ROOT` and others for it. WASI keeps every
//! entry it is given, and a lookup returns the first. So when the shell
//! has `ZENA_STDLIB_DIR` too, the module must still see the host's
//! `/stdlib`, the directory the standard library is preopened as. If it
//! sees the shell's path instead, it compiles against the standard
//! library by that path, and `zena:http`'s `Response` resolves to a
//! different class ("Expected 1 arguments, got 0").
//!
//! The same holds one level down: `zena test` runs each file in a copy of
//! the CLI module, which gets the shell's environment and the variables
//! the module passes on.

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

/// Runs the zena command in `scratch` as a project of its own, as a
/// repository outside this one uses it: `ZENA_REPO_ROOT` is `scratch`,
/// `ZENA_STDLIB_DIR` is this repository's standard library, and the
/// cache is in `scratch`.
fn zena_with_stdlib_dir(scratch: &Scratch, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_zena-cli"));
    command
        .args(args)
        .current_dir(scratch.path())
        .env("ZENA_REPO_ROOT", scratch.path())
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
fn run_compiles_against_the_preopened_stdlib_when_the_shell_names_one() {
    let scratch = Scratch::new("host-env-run");
    fs::write(
        scratch.path().join("prog.zena"),
        "import { Response } from 'zena:http';\n\
         export function main(): i32 {\n  \
           return new Response().statusCode - 404;\n\
         }\n",
    )
    .expect("a written program");

    let output = zena_with_stdlib_dir(&scratch, &["run", "prog.zena"]);
    assert_success("zena run", &output);
}

#[test]
fn test_copies_compile_against_the_preopened_stdlib_when_the_shell_names_one() {
    let scratch = Scratch::new("host-env-test");
    fs::write(
        scratch.path().join("http_test.zena"),
        "import { suite, test } from 'zena:test';\n\
         import { equal } from 'zena:assert';\n\
         import { Response } from 'zena:http';\n\
         \n\
         export let tests = suite('zena:http', () => {\n  \
           test('a new Response is a 404', (ctx) => {\n    \
             equal(new Response().statusCode, 404);\n  \
           });\n\
         });\n",
    )
    .expect("a written test file");

    let output = zena_with_stdlib_dir(&scratch, &["test", "http_test.zena"]);
    assert_success("zena test", &output);
}
