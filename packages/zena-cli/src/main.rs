//! `zena-cli`: the `zena` command.
//!
//! The command is a Zena program, the CLI module
//! (`packages/zena-cli/zena/main.zena`, built to `out/zena.wasm` as a
//! component), which reads the command line, compiles, runs programs and
//! tests, and builds targets. This binary is its host: it does what
//! `zena-run` does for any component, plus three things the module
//! cannot find out for itself.
//!
//! - Where the module is, and the workspace it works in.
//! - The directory the user ran the command from. The module's working
//!   directory is the workspace's root (`workspace_root_for`), preopened as
//!   `.`, because that is where the compiler finds the workspace's
//!   `zena-package.json`, and the module is told it as
//!   `ZENA_WORKSPACE_ROOT`; the standard library is preopened as
//!   `/stdlib`, and the whole filesystem as `/` for everything else.
//! - How many CPUs there are, which WASI cannot ask.
//!
//! The module may spawn processes and run components (zebra runs build
//! commands, and `zena test` runs each test), so it gets the grant. See
//! docs/design/cli-module.md.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use wasmtime::Store;
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};
use zena_runtime::Grant;
use zena_runtime::component::ComponentState;

include!(concat!(env!("OUT_DIR"), "/stdlib_bundle.rs"));

/// Returns the user's cache directory:
/// $ZENA_CACHE_DIR, $XDG_CACHE_HOME/zena, or $HOME/.cache/zena.
fn user_cache_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("ZENA_CACHE_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    if let Ok(dir) = std::env::var("XDG_CACHE_HOME") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir).join("zena"));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(dir) = std::env::var("LOCALAPPDATA") {
            if !dir.is_empty() {
                return Ok(PathBuf::from(dir).join("zena"));
            }
        }
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        if !home.is_empty() {
            return Ok(PathBuf::from(home).join(".cache").join("zena"));
        }
    }
    anyhow::bail!(
        "Could not determine user cache directory: ZENA_CACHE_DIR, XDG_CACHE_HOME, and HOME are all unset"
    );
}

/// The checkout this binary was built in, if it is still there: where a
/// binary without the bundle finds the standard library and the CLI
/// module, wherever it runs.
fn build_checkout() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| std::fs::canonicalize(p).ok())?;
    if root.join("packages/stdlib/zena").is_dir() && root.join("packages/zena-cli").is_dir() {
        Some(root)
    } else {
        None
    }
}

/// The file that makes a directory a package.
const MANIFEST: &str = "zena-package.json";

/// The workspace a command run in `cwd` acts on, the module's working
/// directory, found as npm and Cargo find theirs. The nearest directory,
/// from `cwd` up, with a `zena-package.json` is the package. The nearest
/// directory above it whose manifest's `workspace.packages` lists it is the
/// workspace's root; when none does, the package is a workspace of its
/// own. With no manifest anywhere above, it is `cwd`. Nothing in the
/// environment decides it, so a variable a shell sets cannot move a
/// command into another workspace.
fn workspace_root_for(cwd: &Path) -> PathBuf {
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let Some(package) = cwd.ancestors().find(|dir| dir.join(MANIFEST).is_file()) else {
        return cwd;
    };
    package
        .ancestors()
        .skip(1)
        .find(|dir| lists_package(dir, package))
        .unwrap_or(package)
        .to_path_buf()
}

/// Whether the manifest in `root` lists `package` in `workspace.packages`,
/// by its path from `root`, or as a directory in a `<dir>/*` entry's
/// `<dir>`, as `package-manager/workspace` reads them. A manifest that is
/// missing or cannot be read lists nothing.
fn lists_package(root: &Path, package: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join(MANIFEST)) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(entries) = manifest
        .pointer("/workspace/packages")
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    entries
        .iter()
        .filter_map(|entry| entry.as_str())
        .any(|entry| match entry.strip_suffix("/*") {
            Some(parent) => package.parent() == Some(root.join(parent).as_path()),
            None => package == root.join(entry),
        })
}

/// Where the standard library and the CLI module come from, short of
/// `ZENA_STDLIB_DIR` and `ZENA_CLI_MODULE`: the workspace when it is a
/// checkout of Zena, as a worktree is, else the checkout the binary was
/// built in, else neither, for the bundled copies.
fn source_root(workspace: &Path, checkout: Option<&Path>) -> Option<PathBuf> {
    if workspace.join("packages/stdlib/zena").is_dir() {
        return Some(workspace.to_path_buf());
    }
    checkout.map(Path::to_path_buf)
}

/// The standard library source directory.
///
/// In repo dev mode, uses `packages/stdlib/zena` directly on disk so edits are live.
/// In standalone mode, unpacks the bundled stdlib into `~/.cache/zena/stdlib/<version>/`.
fn resolve_stdlib_dir(sources: Option<&Path>) -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("ZENA_STDLIB_DIR") {
        if !dir.is_empty() {
            let path = PathBuf::from(&dir);
            if path.is_dir() {
                return std::fs::canonicalize(&path)
                    .with_context(|| format!("Failed to canonicalize ZENA_STDLIB_DIR: {dir}"));
            }
        }
    }
    if let Some(root) = sources {
        let stdlib = root.join("packages/stdlib/zena");
        if stdlib.is_dir() {
            return std::fs::canonicalize(&stdlib).with_context(|| {
                format!("Failed to canonicalize stdlib dir: {}", stdlib.display())
            });
        }
    }

    // Standalone mode: extract bundled stdlib
    if STDLIB_FILES.is_empty() {
        anyhow::bail!(
            "No standard library bundled with this zena binary. \
             Run inside a Zena repository or build a release binary."
        );
    }
    let version = env!("CARGO_PKG_VERSION");
    let cache_dir = user_cache_dir()?.join("stdlib").join(version);
    let ready_file = cache_dir.join(".ready");
    let is_ready = ready_file.is_file()
        && std::fs::read_to_string(&ready_file)
            .map(|s| s == STDLIB_HASH)
            .unwrap_or(false);

    if !is_ready {
        std::fs::create_dir_all(&cache_dir).with_context(|| {
            format!("Failed to create stdlib cache dir: {}", cache_dir.display())
        })?;
        for (rel, bytes) in STDLIB_FILES {
            let dest = cache_dir.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, bytes)
                .with_context(|| format!("Failed to write stdlib file: {}", dest.display()))?;
        }
        std::fs::write(&ready_file, STDLIB_HASH)?;
    }
    std::fs::canonicalize(&cache_dir).with_context(|| {
        format!(
            "Failed to canonicalize stdlib cache dir: {}",
            cache_dir.display()
        )
    })
}

/// The CLI module: ZENA_CLI_MODULE, the one built in the repository,
/// or the bundled module extracted to user cache.
fn cli_module(sources: Option<&Path>) -> Result<PathBuf> {
    if let Ok(path) = std::env::var("ZENA_CLI_MODULE") {
        if !path.is_empty() {
            return std::fs::canonicalize(&path)
                .with_context(|| format!("ZENA_CLI_MODULE does not exist: {path}"));
        }
    }
    if let Some(root) = sources {
        let path = root.join("packages/zena-cli/out/zena.wasm");
        if path.is_file() {
            return std::fs::canonicalize(&path).with_context(|| {
                format!("Failed to canonicalize CLI module path: {}", path.display())
            });
        }
    }
    if let (Some(bytes), Some(hash)) = (BUNDLED_CLI_MODULE, BUNDLED_CLI_HASH) {
        let version = env!("CARGO_PKG_VERSION");
        let cache_dir = user_cache_dir()?;
        let cached_wasm = cache_dir.join(format!("zena-{version}.wasm"));
        let ready_file = cache_dir.join(format!("zena-{version}.ready"));
        let is_ready = ready_file.is_file()
            && cached_wasm.is_file()
            && std::fs::read_to_string(&ready_file)
                .map(|s| s == hash)
                .unwrap_or(false);

        if !is_ready {
            std::fs::create_dir_all(&cache_dir)?;
            std::fs::write(&cached_wasm, bytes)?;
            std::fs::write(&ready_file, hash)?;
        }
        return Ok(std::fs::canonicalize(&cached_wasm)?);
    }
    anyhow::bail!(
        "The zena command's module is not built or bundled. \
         Build it with `npm run build -w @zena-lang/zena-cli`."
    );
}

fn main() -> Result<()> {
    zena_runtime::init_logging();
    zena_runtime::init_signals();
    let cwd = std::env::current_dir()?;
    let checkout = build_checkout();
    let workspace = workspace_root_for(&cwd);
    let sources = source_root(&workspace, checkout.as_deref());
    let stdlib_dir = resolve_stdlib_dir(sources.as_deref())?;
    let module_path = cli_module(sources.as_deref())?;
    if zena_runtime::core_module::is_core_module_file(&module_path)? {
        anyhow::bail!(
            "{} is a core module; the zena command's module is a component, \
             built for the zena-component target.",
            module_path.display()
        );
    }
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    // argv[0] is the program's name; the rest is the user's.
    let mut args = vec!["zena".to_string()];
    args.extend(std::env::args().skip(1));

    let mut host_env = vec![
        ("ZENA_CWD".to_string(), cwd.to_string_lossy().into_owned()),
        (
            "ZENA_CLI_MODULE".to_string(),
            module_path.to_string_lossy().into_owned(),
        ),
        ("ZENA_AVAILABLE_PARALLELISM".to_string(), cpus.to_string()),
        ("ZENA_STDLIB_DIR".to_string(), "/stdlib".to_string()),
        (
            "ZENA_WORKSPACE_ROOT".to_string(),
            workspace.to_string_lossy().into_owned(),
        ),
    ];

    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio()
        .envs(&zena_runtime::inherited_env_with(&host_env))
        .args(&args);

    wasi.preopened_dir(&workspace, ".", FsPerms::ReadWrite)?;

    wasi.preopened_dir(&stdlib_dir, "/stdlib", FsPerms::ReadOnly)?
        .preopened_dir("/", "/", FsPerms::ReadWrite)?;

    let grant_path_map = vec![
        (".".to_string(), workspace.clone()),
        ("/stdlib".to_string(), stdlib_dir.clone()),
        ("/".to_string(), PathBuf::from("/")),
    ];

    // The CLI module holds every grant, and passes on to the programs it
    // runs what their flags ask for.
    let grant = Grant {
        path_map: grant_path_map,
        debug: false,
        spawn: true,
        extensions: true,
    };
    let engine = zena_runtime::engine::shared_component_engine(false)?;
    let component =
        zena_runtime::cache::load_component_variant(&engine, &module_path, false, false)?;
    let linker = zena_runtime::component::linker_for(&engine, &component)?;
    let mut store = Store::new(
        &engine,
        ComponentState::new(&engine, wasi.build(), Some(grant)),
    );
    match zena_runtime::component::run_main(&mut store, &linker, &component, "main") {
        Ok(results) => {
            std::process::exit(zena_runtime::component::exit_status(&results));
        }
        Err(e) => {
            if let Some(code) = zena_runtime::exit_code(&e) {
                std::process::exit(code);
            }
            zena_runtime::report_trap(&e);
            Err(e.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory under the system's temporary directory, made anew.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zena-cli-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("packages/stdlib/zena")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    /// Writes `text` to `dir`'s `zena-package.json`, making `dir`.
    fn manifest(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(MANIFEST), text).unwrap();
    }

    #[test]
    fn the_workspace_is_found_by_walking_up_as_npm_and_cargo_do() {
        let base = scratch("walk");
        // No manifest anywhere above: the directory itself.
        let empty = base.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(workspace_root_for(&empty), empty);
        // A package of its own, from it and from below it.
        let alone = base.join("alone");
        manifest(&alone, r#"{"name": "alone"}"#);
        std::fs::create_dir_all(alone.join("src")).unwrap();
        assert_eq!(workspace_root_for(&alone), alone);
        assert_eq!(workspace_root_for(&alone.join("src")), alone);
        // A workspace, its members by name and by `dir/*`, and a directory
        // in it that no package holds.
        let root = base.join("mono");
        manifest(
            &root,
            r#"{"workspace": {"packages": ["tools/cli", "./packages/*"]}}"#,
        );
        manifest(&root.join("tools/cli"), r#"{"name": "cli"}"#);
        manifest(&root.join("packages/a"), r#"{"name": "a"}"#);
        std::fs::create_dir_all(root.join("packages/a/src")).unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        assert_eq!(workspace_root_for(&root), root);
        assert_eq!(workspace_root_for(&root.join("tools/cli")), root);
        assert_eq!(workspace_root_for(&root.join("packages/a/src")), root);
        assert_eq!(workspace_root_for(&root.join("docs")), root);
        // A package in the workspace's tree that it does not list is a
        // workspace of its own, as is one two levels under a `dir/*`.
        let stray = root.join("tests/package-1");
        manifest(&stray, r#"{"name": "package-1"}"#);
        assert_eq!(workspace_root_for(&stray), stray);
        let deep = root.join("packages/a/vendor/b");
        manifest(&deep, r#"{"name": "b"}"#);
        assert_eq!(workspace_root_for(&deep), deep);
        // A manifest that cannot be read lists nothing.
        let broken = base.join("broken");
        manifest(&broken, "{");
        manifest(&broken.join("inner"), r#"{"name": "inner"}"#);
        assert_eq!(
            workspace_root_for(&broken.join("inner")),
            broken.join("inner")
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_checkout_workspace_supplies_its_own_sources() {
        let checkout = scratch("sources-checkout");
        let project = scratch("sources-project");
        std::fs::remove_dir_all(project.join("packages")).unwrap();
        // A workspace that is a checkout uses its own standard library and
        // module, as a worktree does; any other takes the binary's checkout.
        assert_eq!(source_root(&checkout, None), Some(checkout.clone()));
        assert_eq!(
            source_root(&project, Some(&checkout)),
            Some(checkout.clone())
        );
        assert_eq!(source_root(&project, None), None);
        let _ = std::fs::remove_dir_all(&checkout);
        let _ = std::fs::remove_dir_all(&project);
    }
}
