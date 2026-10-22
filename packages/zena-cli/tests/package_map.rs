//! Packages outside the workspace, as the `zena` command finds them.
//!
//! How a workspace's manifests and lockfile resolve imports is the
//! compiler's, and tested in Zena (`zena-compiler/zena/test/workspace_test`
//! and `package-manifest_test`). What these tests vary is what only the
//! command supplies: the workspace's absolute path, which the CLI module
//! gives the compiler so that a path dependency outside the workspace
//! (`../zena/packages/google-cloud/zena`) is read by its absolute path, and
//! the package cache, where `zena fetch` unpacks the published packages
//! `zena-lock.json` pins (docs/design/package-manifest.md).
//!
//! The fetch tests run `tests/fixtures/fetch-pds.zena` as the package's PLC
//! directory and PDS.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Lays out `scratch` as a workspace, `workspace/`, beside two packages:
/// `libs/near` (a path dependency `../libs/near`) and `libs/far` (by its
/// absolute path).
fn layout(scratch: &Scratch) -> PathBuf {
    let workspace = scratch.path().join("workspace");
    let near = scratch.path().join("libs/near");
    let far = scratch.path().join("libs/far");
    write(&near.join("zena-package.json"), r#"{"name": "near"}"#);
    write(
        &near.join("numbers.zena"),
        "export function two(): i32 { return 2; }\n",
    );
    write(&far.join("zena-package.json"), r#"{"name": "far"}"#);
    write(
        &far.join("numbers.zena"),
        "export function three(): i32 { return 3; }\n",
    );
    write(
        &workspace.join("zena-package.json"),
        &format!(
            "{{\"dependencies\": {{\"near\": {{\"path\": \"../libs/near\"}}, \"far\": {{\"path\": \"{}\"}}}}}}\n",
            far.display()
        ),
    );
    write(
        &workspace.join("prog.zena"),
        "import { two } from 'near:numbers';\n\
         import { three } from 'far:numbers';\n\
         export function main(): i32 {\n  \
           return two() * three() - 6;\n\
         }\n",
    );
    write(
        &workspace.join("numbers_test.zena"),
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
    workspace
}

/// Runs the zena command in `workspace` as a workspace of its own, with a
/// cache in `scratch`.
fn zena_in(workspace: &Path, scratch: &Scratch, args: &[&str]) -> Output {
    zena_command(workspace, &scratch.path().join("cache"), args)
        .output()
        .expect("the zena command to start")
}

/// The zena command, run in `workspace` as a workspace of its own, with its
/// caches in `cache`.
fn zena_command(workspace: &Path, cache: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_zena-cli"));
    command
        .args(args)
        .current_dir(workspace)
        .env("ZENA_REPO_ROOT", workspace)
        .env(
            "ZENA_CLI_MODULE",
            repo_root().join("packages/zena-cli/out/zena.wasm"),
        )
        .env("ZENA_STDLIB_DIR", repo_root().join("packages/stdlib/zena"))
        .env("ZENA_CACHE_DIR", cache);
    for name in [
        "ZENA_PROJECT_CACHE",
        "ZENA_LOCAL_CACHE",
        "ZENA_COMPILER_WASM",
        "XDG_CACHE_HOME",
        "ZENA_OPT_LEVEL",
        "ZENA_PLC_DIRECTORY",
    ] {
        command.env_remove(name);
    }
    command
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
fn run_reads_packages_outside_the_workspace_and_at_absolute_paths() {
    let scratch = Scratch::new("package-map-run");
    let workspace = layout(&scratch);
    let output = zena_in(&workspace, &scratch, &["run", "prog.zena"]);
    assert_success("zena run", &output);
}

#[test]
fn test_reads_packages_outside_the_workspace_and_at_absolute_paths() {
    let scratch = Scratch::new("package-map-test");
    let workspace = layout(&scratch);
    let output = zena_in(&workspace, &scratch, &["test", "numbers_test.zena"]);
    assert_success("zena test", &output);
}

/// Lays out `scratch` as a workspace that uses a published package,
/// `router`, which uses another, `json`, by a name of its own. Both are
/// pinned in `zena-lock.json` and in the package cache as `zena fetch`
/// leaves them: each source archive unpacked under
/// `cache/packages/sources/<CID>`.
fn published_layout(scratch: &Scratch) -> PathBuf {
    let workspace = scratch.path().join("workspace");
    let sources = scratch.path().join("cache/packages/sources");
    write(
        &sources.join("bafkreirouter/match.zena"),
        "import { parse } from 'json:parse';\n\
         export function route(): i32 { return parse() + 1; }\n",
    );
    write(
        &sources.join("bafkreijson/parse.zena"),
        "export function parse(): i32 { return 41; }\n",
    );
    write(
        &workspace.join("zena-package.json"),
        r#"{"dependencies": {"router": {"did": "did:plc:router", "version": "1.4.2"}}}"#,
    );
    write(
        &workspace.join("zena-lock.json"),
        r#"{
  "resolved": {
    "did:plc:router@1": {
      "version": "1.4.2",
      "release": "bafyreirouter",
      "source": "bafkreirouter",
      "dependencies": {"json": "did:web:json.example.com@2"}
    },
    "did:web:json.example.com@2": {
      "version": "2.1.0",
      "release": "bafyreijson",
      "source": "bafkreijson"
    }
  }
}
"#,
    );
    write(
        &workspace.join("prog.zena"),
        "import { route } from 'router:match';\n\
         export function main(): i32 {\n  \
           return route() - 42;\n\
         }\n",
    );
    workspace
}

#[test]
fn run_reads_published_packages_from_the_package_cache() {
    let scratch = Scratch::new("package-map-published");
    let workspace = published_layout(&scratch);
    let output = zena_in(&workspace, &scratch, &["run", "prog.zena"]);
    assert_success("zena run", &output);
}

#[test]
fn a_package_missing_from_the_cache_says_to_fetch_it() {
    let scratch = Scratch::new("package-map-missing");
    let workspace = published_layout(&scratch);
    fs::remove_dir_all(scratch.path().join("cache/packages/sources/bafkreijson"))
        .expect("removed json's source");
    let output = zena_in(&workspace, &scratch, &["run", "prog.zena"]);
    assert!(
        !output.status.success(),
        "compiled without json in the cache"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("did:web:json.example.com@2") && stderr.contains("zena fetch"),
        "unexpected error:\n{stderr}"
    );
}

/// A child process killed when this is dropped, so a failed assertion does
/// not leave it running.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Starts `tests/fixtures/fetch-pds.zena`, which serves one published
/// package, and waits until it has written a workspace root depending on
/// it and the lockfile pinning it.
/// Returns the server and the PLC directory's origin.
fn start_fake_pds(scratch: &Scratch) -> (KillOnDrop, String) {
    let out = scratch.path().join("pds");
    fs::create_dir_all(&out).expect("a directory for the fake PDS");
    let log = fs::File::create(scratch.path().join("pds.log")).expect("a log file");
    let mapping = format!("{}::/out", out.display());
    let child = zena_command(
        &repo_root(),
        &scratch.path().join("pds-cache"),
        &[
            "run",
            "--dir",
            &mapping,
            "packages/zena-cli/tests/fixtures/fetch-pds.zena",
        ],
    )
    .stdout(Stdio::null())
    .stderr(log)
    .spawn()
    .expect("the fake PDS to start");
    let mut server = KillOnDrop(child);
    let plc = out.join("plc.txt");
    let deadline = Instant::now() + Duration::from_secs(300);
    while !plc.exists() {
        if let Ok(Some(status)) = server.0.try_wait() {
            panic!(
                "the fake PDS exited ({status}):\n{}",
                fs::read_to_string(scratch.path().join("pds.log")).unwrap_or_default()
            );
        }
        assert!(Instant::now() < deadline, "the fake PDS did not start");
        std::thread::sleep(Duration::from_millis(200));
    }
    let origin = fs::read_to_string(&plc).expect("the PLC directory's origin");
    (server, origin)
}

#[test]
fn fetch_downloads_pinned_packages_that_the_compiler_then_reads() {
    let scratch = Scratch::new("package-map-fetch");
    let (_server, plc) = start_fake_pds(&scratch);
    let workspace = scratch.path().join("workspace");
    fs::create_dir_all(&workspace).expect("a workspace directory");
    for file in ["zena-package.json", "zena-lock.json"] {
        fs::copy(scratch.path().join("pds").join(file), workspace.join(file))
            .expect("the fake PDS's workspace files");
    }
    write(
        &workspace.join("prog.zena"),
        "import { route } from 'router:match';\n\
         export function main(): i32 {\n  \
           return route() - 42;\n\
         }\n",
    );
    let cache = scratch.path().join("cache");
    let fetch = || {
        zena_command(&workspace, &cache, &["fetch"])
            .env("ZENA_PLC_DIRECTORY", &plc)
            .output()
            .expect("zena fetch to start")
    };

    let first = fetch();
    assert_success("zena fetch", &first);
    let stdout = String::from_utf8_lossy(&first.stdout);
    assert!(stdout.contains("1 fetched"), "unexpected output:\n{stdout}");

    let second = fetch();
    assert_success("a second zena fetch", &second);
    let stdout = String::from_utf8_lossy(&second.stdout);
    assert!(
        stdout.contains("1 already in the cache"),
        "unexpected output:\n{stdout}"
    );

    let run = zena_in(&workspace, &scratch, &["run", "prog.zena"]);
    assert_success("zena run", &run);
}

#[test]
fn fetch_refuses_a_release_that_differs_from_its_pin() {
    let scratch = Scratch::new("package-map-fetch-changed");
    let (_server, plc) = start_fake_pds(&scratch);
    let workspace = scratch.path().join("workspace");
    fs::create_dir_all(&workspace).expect("a workspace directory");
    // Pin a release record CID the PDS does not serve.
    let pinned =
        fs::read_to_string(scratch.path().join("pds/zena-lock.json")).expect("the lockfile");
    let start = pinned.find("\"release\": \"").expect("a release pin") + 12;
    let end = start + pinned[start..].find('"').expect("the pin's end");
    let changed = format!(
        "{}bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm{}",
        &pinned[..start],
        &pinned[end..]
    );
    write(&workspace.join("zena-lock.json"), &changed);
    let output = zena_command(&workspace, &scratch.path().join("cache"), &["fetch"])
        .env("ZENA_PLC_DIRECTORY", &plc)
        .output()
        .expect("zena fetch to start");
    assert!(
        !output.status.success(),
        "zena fetch accepted a changed release"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("changed after it was pinned"),
        "unexpected error:\n{stderr}"
    );
    assert!(
        !scratch.path().join("cache/packages/sources").exists()
            || fs::read_dir(scratch.path().join("cache/packages/sources"))
                .expect("the sources directory")
                .next()
                .is_none(),
        "zena fetch stored a package it refused"
    );
}
