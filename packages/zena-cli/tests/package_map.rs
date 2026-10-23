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
//! The fetch, add and login tests run a fixture under `tests/fixtures/` as
//! the PLC directory and PDS. Signing in is here too, since what it varies
//! is the command's configuration directory and its terminal.

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
        "ZENA_DNS_OVER_HTTPS",
        "ZENA_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "ZENA_APP_PASSWORD",
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

/// Starts `tests/fixtures/<fixture>`, which serves published packages, and
/// waits until it has written the PLC directory's origin. Returns the
/// server and that origin.
fn start_fake_pds(scratch: &Scratch, fixture: &str) -> (KillOnDrop, String) {
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
            &format!("packages/zena-cli/tests/fixtures/{fixture}"),
        ],
    )
    .stdout(Stdio::null())
    .stderr(log)
    .spawn()
    .expect("the fake PDS to start");
    let mut server = KillOnDrop(child);
    let plc = out.join("plc.txt");
    let deadline = Instant::now() + Duration::from_secs(300);
    // The file can be read between its creation and the write, so wait
    // for the whole origin, which ends in "/plc".
    loop {
        if let Ok(origin) = fs::read_to_string(&plc)
            && origin.ends_with("/plc")
        {
            return (server, origin);
        }
        if let Ok(Some(status)) = server.0.try_wait() {
            panic!(
                "the fake PDS exited ({status}):\n{}",
                fs::read_to_string(scratch.path().join("pds.log")).unwrap_or_default()
            );
        }
        assert!(Instant::now() < deadline, "the fake PDS did not start");
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn fetch_downloads_pinned_packages_that_the_compiler_then_reads() {
    let scratch = Scratch::new("package-map-fetch");
    let (_server, plc) = start_fake_pds(&scratch, "fetch-pds.zena");
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
    let (_server, plc) = start_fake_pds(&scratch, "fetch-pds.zena");
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

/// The zena command in the workspace `workspace`, run from `dir`, finding
/// packages through the fake PDS whose PLC directory is `plc`.
fn zena_with_pds(
    workspace: &Path,
    dir: &Path,
    scratch: &Scratch,
    plc: &str,
    args: &[&str],
) -> Output {
    let dns = format!("{}/dns-query", plc.trim_end_matches("/plc"));
    zena_command(workspace, &scratch.path().join("cache"), args)
        .current_dir(dir)
        .env("ZENA_PLC_DIRECTORY", plc)
        .env("ZENA_DNS_OVER_HTTPS", dns)
        .output()
        .expect("the zena command to start")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn add_and_update_select_pin_and_fetch_dependencies() {
    let scratch = Scratch::new("package-map-add");
    let (_server, plc) = start_fake_pds(&scratch, "add-pds.zena");
    let workspace = scratch.path().join("workspace");
    let manifest = workspace.join("zena-package.json");
    let lockfile = workspace.join("zena-lock.json");
    write(
        &workspace.join("prog.zena"),
        "import { route } from 'router:match';\n\
         export function main(): i32 {\n  \
           return route() - 42;\n\
         }\n",
    );

    // Add router at a version, by its scoped name, to a workspace with no
    // manifest yet. Its dependency, json, is selected and fetched with it.
    let add = zena_with_pds(
        &workspace,
        &workspace,
        &scratch,
        &plc,
        &["add", "@acme/router@1.4.2"],
    );
    assert_success("zena add", &add);
    let text = read(&manifest);
    assert!(
        text.contains("\"router\"") && text.contains("1.4.2"),
        "{text}"
    );
    let pins = read(&lockfile);
    assert!(
        pins.contains("did:plc:routerrouterrouterrouter@1")
            && pins.contains("did:plc:jsonjsonjsonjsonjsonjson@2")
            && pins.contains("2.1.0"),
        "{pins}"
    );
    let stdout = String::from_utf8_lossy(&add.stdout);
    assert!(stdout.contains("2 fetched"), "unexpected output:\n{stdout}");
    assert_success(
        "zena run",
        &zena_in(&workspace, &scratch, &["run", "prog.zena"]),
    );

    // Update to the latest version that is not yanked: 1.5.0, not 1.6.0.
    let update = zena_with_pds(&workspace, &workspace, &scratch, &plc, &["update"]);
    assert_success("zena update", &update);
    let stdout = String::from_utf8_lossy(&update.stdout);
    assert!(
        stdout.contains("1.4.2 -> 1.5.0"),
        "unexpected output:\n{stdout}"
    );
    let text = read(&manifest);
    assert!(text.contains("1.5.0") && !text.contains("1.6.0"), "{text}");
    assert_success(
        "zena run",
        &zena_in(&workspace, &scratch, &["run", "prog.zena"]),
    );

    // Give the workspace a package, lib, and add json 2.0.0 to it from its
    // directory. Only lib's manifest changes, and the lockfile still pins
    // json 2.1.0, which router needs: one version for the whole workspace.
    write(
        &manifest,
        &text.replacen('{', r#"{"workspace": {"packages": ["packages/*"]},"#, 1),
    );
    let lib = workspace.join("packages/lib");
    write(&lib.join("zena-package.json"), r#"{"name": "lib"}"#);
    let before = read(&manifest);
    let add_to_lib = zena_with_pds(
        &workspace,
        &lib,
        &scratch,
        &plc,
        &["add", "@acme/json@2.0.0"],
    );
    assert_success("zena add in a workspace package", &add_to_lib);
    let lib_text = read(&lib.join("zena-package.json"));
    assert!(
        lib_text.contains("\"json\"") && lib_text.contains("2.0.0"),
        "{lib_text}"
    );
    assert_eq!(read(&manifest), before);
    let pins = read(&lockfile);
    assert!(pins.contains("2.1.0") && !pins.contains("2.0.0"), "{pins}");

    // Add json to the root without a version: its latest, under the name
    // its profile suggests.
    let add_json = zena_with_pds(
        &workspace,
        &workspace,
        &scratch,
        &plc,
        &["add", "@acme/json"],
    );
    assert_success("zena add without a version", &add_json);
    let text = read(&manifest);
    assert!(
        text.contains("\"json\"") && text.contains("2.1.0"),
        "{text}"
    );

    // A name that does not resolve is an error, and changes nothing.
    let missing = zena_with_pds(
        &workspace,
        &workspace,
        &scratch,
        &plc,
        &["add", "@acme/nothing"],
    );
    assert!(
        !missing.status.success(),
        "zena add accepted a package that does not exist"
    );
    assert_eq!(read(&manifest), text);
}

/// The zena command in a workspace of its own, signing in through the fake
/// PDS whose PLC directory is `plc`, with its configuration in `config`.
fn zena_login(scratch: &Scratch, plc: &str, config: &Path, args: &[&str]) -> Command {
    let workspace = scratch.path().join("workspace");
    fs::create_dir_all(&workspace).expect("a workspace directory");
    let dns = format!("{}/dns-query", plc.trim_end_matches("/plc"));
    let mut command = zena_command(&workspace, &scratch.path().join("cache"), args);
    command
        .env("ZENA_PLC_DIRECTORY", plc)
        .env("ZENA_DNS_OVER_HTTPS", dns)
        .env("ZENA_CONFIG_DIR", config);
    command
}

/// Runs `command` with `input` as its stdin.
fn with_stdin(mut command: Command, input: &str) -> Output {
    use std::io::Write;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the zena command to start");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.as_bytes())
        .expect("the password written");
    child
        .wait_with_output()
        .expect("the zena command to finish")
}

#[test]
fn login_keeps_a_private_session_and_logout_ends_it() {
    let scratch = Scratch::new("package-map-login");
    let (_server, plc) = start_fake_pds(&scratch, "login-pds.zena");
    let config = scratch.path().join("config");
    let session = config.join("session.json");

    // A wrong password is refused, and nothing is stored.
    let wrong = with_stdin(
        zena_login(
            &scratch,
            &plc,
            &config,
            &["login", "alice.test", "--password-stdin"],
        ),
        "not-it\n",
    );
    assert!(
        !wrong.status.success(),
        "zena login accepted a wrong password"
    );
    let stderr = String::from_utf8_lossy(&wrong.stderr);
    assert!(
        stderr.contains("AuthenticationRequired"),
        "unexpected error:\n{stderr}"
    );
    assert!(!session.exists(), "a refused login stored a session");

    // A session file left readable by others is made private.
    fs::create_dir_all(&config).expect("a config directory");
    fs::write(&session, "{}").expect("an old session");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&session, fs::Permissions::from_mode(0o644)).expect("mode 0644");
    }

    let login = with_stdin(
        zena_login(
            &scratch,
            &plc,
            &config,
            &["login", "alice.test", "--password-stdin"],
        ),
        "app-password\n",
    );
    assert_success("zena login", &login);
    let stdout = String::from_utf8_lossy(&login.stdout);
    assert!(
        stdout.contains("Signed in as alice.test (did:plc:alicealicealicealicealic)"),
        "unexpected output:\n{stdout}"
    );
    let stored = read(&session);
    assert!(
        stored.contains("did:plc:alicealicealicealicealic") && stored.contains("refreshJwt"),
        "{stored}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&session)
            .expect("the session")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the session is readable by others");
    }

    // With no password given and no terminal, it says how to give one.
    let no_terminal = with_stdin(
        zena_login(&scratch, &plc, &config, &["login", "alice.test"]),
        "",
    );
    assert!(!no_terminal.status.success());
    let stderr = String::from_utf8_lossy(&no_terminal.stderr);
    assert!(
        stderr.contains("--password-stdin") && stderr.contains("ZENA_APP_PASSWORD"),
        "unexpected error:\n{stderr}"
    );

    // The password can come from the environment.
    let mut from_env = zena_login(
        &scratch,
        &plc,
        &config,
        &["login", "did:plc:alicealicealicealicealic"],
    );
    from_env.env("ZENA_APP_PASSWORD", "app-password");
    assert_success(
        "zena login with ZENA_APP_PASSWORD",
        &from_env.output().expect("zena login"),
    );

    let logout = zena_login(&scratch, &plc, &config, &["logout"])
        .output()
        .expect("zena logout");
    assert_success("zena logout", &logout);
    assert!(
        String::from_utf8_lossy(&logout.stdout).contains("Signed out alice.test"),
        "unexpected output"
    );
    assert!(!session.exists(), "zena logout kept the session");
}
