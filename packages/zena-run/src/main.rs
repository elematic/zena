//! `zena-run`: runs one compiled Zena module on wasmtime.
//!
//! This is the smallest host a module built for the `zena-cli` target
//! can run under: wasmtime configured for Zena's output, WASI preview 1,
//! and the imports from `zena-runtime` (stack traces, and `zena:process`
//! when granted). It does not compile Zena source; `zena-cli` bundles the
//! compiler and hands modules it builds to the same runtime crate.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::Path;
use wasmtime::{Engine, Linker, Store};
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};
use zena_runtime::{DirMapping, Grant, HostState, Spawn};

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
    /// other Wasm modules via zena:wasm (a deliberate sandbox escape;
    /// ZENA_ALLOW_SPAWN=1 also works)
    #[arg(long = "allow-spawn")]
    allow_spawn: bool,

    /// Compile the module in memory instead of reading or writing the
    /// ahead-of-time compiled `.cwasm` kept beside it
    #[arg(long = "no-cache")]
    no_cache: bool,

    /// The .wasm (or .wat) file to run
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
            "{} is Zena source; zena-run only runs compiled modules. \
             Build it first with `zena build {} -o <out>.wasm`.",
            cli.file,
            cli.file
        );
    }

    let engine = Engine::new(&zena_runtime::engine::config(cli.debug))?;
    let module = if cli.no_cache {
        zena_runtime::cache::compile_uncached(&engine, path)?
    } else {
        zena_runtime::cache::load_module(&engine, path, cli.debug)?
    };

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

    let spawn = if zena_runtime::spawn_allowed(cli.allow_spawn) {
        Spawn::Allow(Grant {
            path_map,
            debug: cli.debug,
        })
    } else {
        Spawn::Deny
    };
    let mut linker: Linker<HostState> = Linker::new(&engine);
    zena_runtime::add_to_linker(&mut linker, &engine, &module, spawn)?;

    let mut store = Store::new(
        &engine,
        HostState {
            wasi: wasi_builder.build_p1(),
        },
    );
    zena_runtime::engine::reserve_gc_heap(&engine, &mut store)?;

    let instance = linker.instantiate(&mut store, &module).inspect_err(|e| {
        eprintln!("Instantiation failed!");
        zena_runtime::report_trap(e);
    })?;

    match zena_runtime::call_export(&mut store, &instance, &cli.invoke) {
        Ok(results) => {
            if let Some(res) = results.first() {
                println!("{}", zena_runtime::format_result(res));
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
