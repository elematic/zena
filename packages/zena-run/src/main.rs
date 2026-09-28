//! `zena-run`: runs one compiled Zena component, or a core module, on
//! wasmtime.
//!
//! This is the smallest host a component built for the `zena-cli` target
//! can run under: wasmtime configured for Zena's output, WASI 0.3, and
//! the `zena-cli:host` interfaces from `zena-runtime` (stack traces, and
//! `zena:process` and `zena:wasm` when granted). A core module — a
//! `freestanding` build, hand-written `.wat` — runs with no imports, so
//! `--dir`, `--allow-spawn` and the arguments do not reach it. It does
//! not compile Zena source; `zena-cli` bundles the compiler and hands
//! programs it builds to the same runtime crate.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::Path;
use wasmtime::Store;
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};
use zena_runtime::component::ComponentState;
use zena_runtime::{DirMapping, Grant};

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    /// Turn off the wasmtime compiler's inlining, so backtraces name the
    /// function that trapped. Uses a separate `.debug.cwasm` cache file.
    #[arg(short = 'g', long = "debug")]
    debug: bool,

    /// Directory to pre-open for the guest, as HOST or HOST::GUEST
    /// (repeatable)
    #[arg(long = "dir", value_name = "HOST[::GUEST]")]
    dirs: Vec<String>,

    /// The exported function to call
    #[arg(long, default_value = "main")]
    invoke: String,

    /// Allow the program to spawn host processes via zena:process and run
    /// other components via zena:wasm (a deliberate sandbox escape;
    /// ZENA_ALLOW_SPAWN=1 also works)
    #[arg(long = "allow-spawn")]
    allow_spawn: bool,

    /// Compile the component in memory instead of reading or writing the
    /// ahead-of-time compiled `.cwasm` kept beside it
    #[arg(long = "no-cache")]
    no_cache: bool,

    /// The .wasm (or .wat) component or core module to run
    file: String,

    /// Arguments passed to the program
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = Path::new(&cli.file);
    if path.extension().is_some_and(|e| e == "zena") {
        anyhow::bail!(
            "{} is Zena source; zena-run only runs compiled components. \
             Build it first with `zena build {} -o <out>.wasm`.",
            cli.file,
            cli.file
        );
    }
    if zena_runtime::core_module::is_core_module_file(path)? {
        return run_core_module(&cli, path);
    }

    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder.inherit_stdio().inherit_env();
    // argv[0] is the program, by the usual convention.
    let mut guest_args = vec![cli.file.clone()];
    guest_args.extend_from_slice(&cli.args);
    wasi_builder.args(&guest_args);

    let mut path_map: zena_runtime::PathMap = Vec::new();
    for dir in &cli.dirs {
        let mapping = DirMapping::parse(dir);
        let host = std::fs::canonicalize(&mapping.host)
            .with_context(|| format!("--dir {}: no such directory", mapping.host))?;
        wasi_builder.preopened_dir(&host, &mapping.guest, FsPerms::ReadWrite)?;
        path_map.push((mapping.guest, host));
    }

    let grant = if zena_runtime::spawn_allowed(cli.allow_spawn) {
        Some(Grant {
            path_map,
            debug: cli.debug,
        })
    } else {
        None
    };

    let engine = zena_runtime::engine::shared_component_engine(cli.debug)?;
    let component = if cli.no_cache {
        zena_runtime::cache::compile_component_uncached(&engine, path)?
    } else {
        zena_runtime::cache::load_component_variant(&engine, path, cli.debug, false)?
    };
    let linker = zena_runtime::component::linker(&engine)?;
    let mut store = Store::new(
        &engine,
        ComponentState::new(&engine, wasi_builder.build(), grant),
    );
    match zena_runtime::component::run_main(&mut store, &linker, &component, &cli.invoke) {
        Ok(results) => {
            if let Some(res) = results.first() {
                println!("{}", zena_runtime::component::format_val(res));
            }
            Ok(())
        }
        Err(e) => {
            // The guest ended itself with `exit(n)`; end with the same
            // status.
            if let Some(code) = zena_runtime::exit_code(&e) {
                std::process::exit(code);
            }
            zena_runtime::report_trap(&e);
            Err(e.into())
        }
    }
}

/// Runs a core module: no imports, and its first result printed the way
/// a component's is.
fn run_core_module(cli: &Cli, path: &Path) -> Result<()> {
    let engine = zena_runtime::engine::shared_component_engine(cli.debug)?;
    let module = if cli.no_cache {
        zena_runtime::cache::compile_module_uncached(&engine, path)?
    } else {
        zena_runtime::cache::load_module_variant(&engine, path, cli.debug, false)?
    };
    let mut store = Store::new(&engine, ());
    zena_runtime::engine::reserve_gc_heap(&engine, &mut store)?;
    match zena_runtime::core_module::call_export(&mut store, &module, &cli.invoke) {
        Ok(results) => {
            if let Some(res) = results.first() {
                println!("{}", zena_runtime::core_module::format_val(res));
            }
            Ok(())
        }
        Err(e) => {
            zena_runtime::report_trap(&e);
            Err(e.into())
        }
    }
}
