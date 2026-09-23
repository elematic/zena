//! `zena-cli`: the `zena` command.
//!
//! The command is a Zena program, the CLI module
//! (`packages/zena-cli/zena/main.zena`, built to `out/zena.wasm`), which
//! reads the command line, compiles, runs programs and tests, and builds
//! targets. This binary is its host: it does what `zena-run` does for any
//! module, plus three things the module cannot find out for itself.
//!
//! - Where the module is, and the repository it works in.
//! - The directory the user ran the command from. The module's working
//!   directory is the repository root, preopened as `.`, because that is
//!   where the compiler finds `zena-packages.json` and the standard
//!   library; the whole filesystem is preopened as `/` for everything
//!   else.
//! - How many CPUs there are, which WASI cannot ask.
//!
//! The module may spawn processes and run modules (zb runs build
//! commands, and `zena test` runs each test), so it gets the grant. See
//! docs/design/cli-module.md.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use wasmtime::{Engine, Linker, Store, Val};
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};
use zena_runtime::{Grant, HostState, Spawn};

/// The repository root: the compiler, the standard library and the CLI
/// module hang off it. Defaults to the checkout this binary was built in
/// (CARGO_MANIFEST_DIR is baked in at compile time); ZENA_REPO_ROOT points
/// a binary at another checkout, or at an installed copy.
fn repo_root() -> Result<PathBuf> {
    if let Ok(root) = std::env::var("ZENA_REPO_ROOT") {
        return std::fs::canonicalize(&root)
            .with_context(|| format!("ZENA_REPO_ROOT does not exist: {root}"));
    }
    Ok(std::fs::canonicalize(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    )?)
}

/// The CLI module: ZENA_CLI_MODULE, or the one built in the repository.
fn cli_module(repo_root: &Path) -> Result<PathBuf> {
    let path = match std::env::var("ZENA_CLI_MODULE") {
        Ok(path) => PathBuf::from(path),
        Err(_) => repo_root.join("packages/zena-cli/out/zena.wasm"),
    };
    if !path.is_file() {
        anyhow::bail!(
            "The zena command's module is not built: {} does not exist. \
             Build it with `npm run build -w @zena-lang/zena-cli`.",
            path.display()
        );
    }
    Ok(std::fs::canonicalize(path)?)
}

fn main() -> Result<()> {
    let repo_root = repo_root()?;
    let module_path = cli_module(&repo_root)?;
    let cwd = std::env::current_dir()?;
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    let engine = Engine::new(&zena_runtime::engine::config(false))?;
    let module = zena_runtime::cache::load_module(&engine, &module_path, false)?;

    // argv[0] is the program's name; the rest is the user's.
    let mut args = vec!["zena".to_string()];
    args.extend(std::env::args().skip(1));

    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio()
        .inherit_env()
        .args(&args)
        .env("ZENA_REPO_ROOT", repo_root.to_string_lossy())
        .env("ZENA_CWD", cwd.to_string_lossy())
        .env("ZENA_CLI_MODULE", module_path.to_string_lossy())
        .env("ZENA_AVAILABLE_PARALLELISM", cpus.to_string())
        // The repository first: relative paths resolve against the first
        // preopen.
        .preopened_dir(&repo_root, ".", FsPerms::ReadWrite)?
        .preopened_dir("/", "/", FsPerms::ReadWrite)?;

    let spawn = Spawn::Allow(Grant {
        path_map: vec![
            (".".to_string(), repo_root.clone()),
            ("/".to_string(), PathBuf::from("/")),
        ],
        debug: false,
    });
    let mut linker: Linker<HostState> = Linker::new(&engine);
    zena_runtime::add_to_linker(&mut linker, &engine, &module, spawn)?;

    let mut store = Store::new(
        &engine,
        HostState {
            wasi: wasi.build_p1(),
        },
    );
    zena_runtime::engine::reserve_gc_heap(&engine, &mut store)?;

    let instance = linker.instantiate(&mut store, &module).inspect_err(|e| {
        eprintln!("Instantiation failed!");
        zena_runtime::report_trap(e);
    })?;

    match zena_runtime::call_export(&mut store, &instance, "main") {
        Ok(results) => {
            let code = match results.first() {
                Some(Val::I32(code)) => *code,
                _ => 0,
            };
            std::process::exit(code);
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
