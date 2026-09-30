//! `zena-cli`: the `zena` command.
//!
//! The command is a Zena program, the CLI module
//! (`packages/zena-cli/zena/main.zena`, built to `out/zena.wasm` as a
//! component), which reads the command line, compiles, runs programs and
//! tests, and builds targets. This binary is its host: it does what
//! `zena-run` does for any component, plus three things the module
//! cannot find out for itself.
//!
//! - Where the module is, and the repository it works in.
//! - The directory the user ran the command from. The module's working
//!   directory is the repository root (or current directory if standalone),
//!   preopened as `.`, because that is where the compiler finds
//!   `zena-packages.json`; the standard library is preopened as `/stdlib`,
//!   and the whole filesystem is preopened as `/` for everything else.
//! - How many CPUs there are, which WASI cannot ask.
//!
//! The module may spawn processes and run components (zb runs build
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

/// The repository root: if running within a Zena repository checkout,
/// returns that path.
///
/// In standalone mode (outside a repository checkout), returns `None`.
fn repo_root() -> Result<Option<PathBuf>> {
    if let Ok(root) = std::env::var("ZENA_REPO_ROOT") {
        if root.is_empty() {
            return Ok(None);
        }
        let path = std::fs::canonicalize(&root)
            .with_context(|| format!("ZENA_REPO_ROOT does not exist: {root}"))?;
        return Ok(Some(path));
    }
    if let Ok(dev_root) = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(std::fs::canonicalize)
        .transpose()
    {
        if let Some(dev_root) = dev_root {
            if dev_root.join("packages/stdlib/zena").is_dir()
                && dev_root.join("packages/zena-cli").is_dir()
            {
                return Ok(Some(dev_root));
            }
        }
    }
    Ok(None)
}

/// The standard library source directory.
///
/// In repo dev mode, uses `packages/stdlib/zena` directly on disk so edits are live.
/// In standalone mode, unpacks the bundled stdlib into `~/.cache/zena/stdlib/<version>/`.
fn resolve_stdlib_dir(repo_root: Option<&Path>) -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("ZENA_STDLIB_DIR") {
        if !dir.is_empty() {
            let path = PathBuf::from(&dir);
            if path.is_dir() {
                return std::fs::canonicalize(&path)
                    .with_context(|| format!("Failed to canonicalize ZENA_STDLIB_DIR: {dir}"));
            }
        }
    }
    if let Some(root) = repo_root {
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
fn cli_module(repo_root: Option<&Path>) -> Result<PathBuf> {
    if let Ok(path) = std::env::var("ZENA_CLI_MODULE") {
        if !path.is_empty() {
            return std::fs::canonicalize(&path)
                .with_context(|| format!("ZENA_CLI_MODULE does not exist: {path}"));
        }
    }
    if let Some(root) = repo_root {
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
    let repo_root = repo_root()?;
    let stdlib_dir = resolve_stdlib_dir(repo_root.as_deref())?;
    let module_path = cli_module(repo_root.as_deref())?;
    if zena_runtime::core_module::is_core_module_file(&module_path)? {
        anyhow::bail!(
            "{} is a core module; the zena command's module is a component, \
             built for the zena-cli target.",
            module_path.display()
        );
    }
    let cwd = std::env::current_dir()?;
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    // argv[0] is the program's name; the rest is the user's.
    let mut args = vec!["zena".to_string()];
    args.extend(std::env::args().skip(1));

    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio()
        .inherit_env()
        .args(&args)
        .env("ZENA_CWD", cwd.to_string_lossy())
        .env("ZENA_CLI_MODULE", module_path.to_string_lossy())
        .env("ZENA_AVAILABLE_PARALLELISM", cpus.to_string())
        .env("ZENA_STDLIB_DIR", "/stdlib");

    if let Some(ref root) = repo_root {
        wasi.env("ZENA_REPO_ROOT", root.to_string_lossy())
            .preopened_dir(root, ".", FsPerms::ReadWrite)?;
    } else {
        wasi.preopened_dir(&cwd, ".", FsPerms::ReadWrite)?;
    }

    wasi.preopened_dir(&stdlib_dir, "/stdlib", FsPerms::ReadOnly)?
        .preopened_dir("/", "/", FsPerms::ReadWrite)?;

    let grant_path_map = vec![
        (
            ".".to_string(),
            repo_root.clone().unwrap_or_else(|| cwd.clone()),
        ),
        ("/stdlib".to_string(), stdlib_dir.clone()),
        ("/".to_string(), PathBuf::from("/")),
    ];

    let grant = Grant {
        path_map: grant_path_map,
        debug: false,
    };
    let engine = zena_runtime::engine::shared_component_engine(false)?;
    let component =
        zena_runtime::cache::load_component_variant(&engine, &module_path, false, false)?;
    let linker = zena_runtime::component::linker(&engine)?;
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
