use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use wasmtime::*;
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::{DirPerms, FilePerms};

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Build a Zena source file to WebAssembly
    Build {
        /// The .zena file to compile
        file: String,

        /// Output file path
        #[arg(short, long)]
        output: String,
    },
    /// Run a compiled Zena source file or WASM file
    Run {
        /// The .zena or .wasm file to run
        file: String,

        /// The function to invoke
        #[arg(long, default_value = "main")]
        invoke: String,
    },
}

struct MyState {
    wasi: WasiP1Ctx,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Build { file, output } => build_file(&file, &output, cli.verbose),
        Commands::Run { file, invoke } => {
            if file.ends_with(".wasm") {
                run_wasm(&file, &invoke, cli.verbose)
            } else {
                compile_and_run(&file, &invoke, cli.verbose)
            }
        }
    }
}

fn build_file(file: &str, output: &str, verbose: bool) -> Result<()> {
    let cached_wasm_path = compile_to_cache(file, verbose)?;
    std::fs::copy(&cached_wasm_path, output)?;
    Ok(())
}

fn compile_and_run(file: &str, invoke: &str, verbose: bool) -> Result<()> {
    let cached_wasm_path = compile_to_cache(file, verbose)?;
    run_wasm(cached_wasm_path.to_str().unwrap(), invoke, verbose)
}

fn load_or_compile_module(engine: &Engine, wasm_path: &Path, cwasm_path: &Path) -> Result<Module> {
    let needs_compile = if cwasm_path.exists() {
        let wasm_mod = std::fs::metadata(wasm_path)?.modified()?;
        let cwasm_mod = std::fs::metadata(cwasm_path)?.modified()?;
        wasm_mod > cwasm_mod
    } else {
        true
    };

    if needs_compile {
        let wasm_bytes = std::fs::read(wasm_path)?;
        let serialized = engine.precompile_module(&wasm_bytes)?;
        std::fs::write(cwasm_path, serialized)?;
    }

    unsafe { Ok(Module::deserialize_file(engine, cwasm_path)?) }
}

/// Compiles a `.zena` source file by invoking the pre-built self-hosted compiler (`cli.wasm`)
/// inside a Wasmtime sandbox, returning the path to the cached WebAssembly file.
fn compile_to_cache(file: &str, verbose: bool) -> Result<std::path::PathBuf> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let compiler_wasm = repo_root.join("packages/zena-compiler/zena/out/cli.wasm");

    if !compiler_wasm.exists() {
        anyhow::bail!(
            "Compiler WASM not found at {}. Please build it first.",
            compiler_wasm.display()
        );
    }

    let mut config = Config::new();
    config.wasm_gc(true);
    config.wasm_function_references(true);
    config.wasm_exceptions(true);
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);

    let engine = Engine::new(&config)?;
    let cwasm_path = compiler_wasm.with_extension("cwasm");
    let compiler_module = load_or_compile_module(&engine, &compiler_wasm, &cwasm_path)?;

    let mut linker: Linker<MyState> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;

    let stdlib_dir = repo_root.join("packages/stdlib/zena");

    // Compute deterministic cache path based on absolute file source
    let abs_path = std::fs::canonicalize(file).context("Failed to resolve file path")?;
    let rel_path = abs_path
        .strip_prefix(repo_root)
        .context("File must be inside the Zena repository for now")?;

    // Create an absolute path into the global user cache directory
    let proj_dirs =
        ProjectDirs::from("org", "zena-lang", "zena").context("No home directory found")?;
    let cache_dir = proj_dirs.cache_dir().join("wasm_objects");
    std::fs::create_dir_all(&cache_dir)?;

    let mut hasher = DefaultHasher::new();
    abs_path.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = abs_path.file_stem().unwrap_or_default().to_string_lossy();
    let cached_wasm_name = format!("{}_{:x}.wasm", file_name, hash);
    let cached_wasm_path = cache_dir.join(&cached_wasm_name);

    let file_arg = rel_path.to_string_lossy().to_string();

    // Pass the actual absolute path to the user's cache directory using the `-o` flag
    let out_path_arg = cached_wasm_path.to_string_lossy().to_string();

    let wasi = WasiCtxBuilder::new()
        .inherit_stdio()
        .inherit_env()
        .args(&["zc", &file_arg, "-o", &out_path_arg])
        .preopened_dir(repo_root, ".", DirPerms::all(), FilePerms::all())?
        .preopened_dir(stdlib_dir, "/stdlib", DirPerms::all(), FilePerms::all())?
        // Give the guest write access directly to the user's absolute cache directory
        .preopened_dir(
            &cache_dir,
            cache_dir.to_str().unwrap(),
            DirPerms::all(),
            FilePerms::all(),
        )?
        .build_p1();

    let mut store = Store::new(&engine, MyState { wasi });

    let compiler_instance = linker.instantiate(&mut store, &compiler_module)?;
    let compiler_main = compiler_instance
        .get_func(&mut store, "main")
        .expect("missing main export in cli.wasm");

    let mut compiler_results = vec![Val::I32(0); compiler_main.ty(&store).results().len()];

    if verbose {
        println!("Compiling {}...", file);
    }

    if let Err(e) = compiler_main.call(&mut store, &[], &mut compiler_results) {
        eprintln!("Compiler failed with error: {:?}", e);
        anyhow::bail!("Compilation failed");
    }

    if !cached_wasm_path.exists() {
        anyhow::bail!(
            "Compiler did not emit expected WebAssembly file to {}.",
            cached_wasm_path.display()
        );
    }

    Ok(cached_wasm_path)
}

fn run_wasm(file: &str, invoke: &str, _verbose: bool) -> Result<()> {
    let mut config = Config::new();
    config.wasm_gc(true);
    config.wasm_function_references(true);
    config.wasm_exceptions(true);
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);

    let engine = Engine::new(&config)?;
    let wasm_path = Path::new(file);
    let cwasm_path = wasm_path.with_extension("cwasm");
    let module = load_or_compile_module(&engine, wasm_path, &cwasm_path)?;

    let mut linker: Linker<MyState> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;

    let wasi = WasiCtxBuilder::new()
        .inherit_stdio()
        .inherit_env()
        .inherit_args()
        .build_p1();

    let mut store = Store::new(&engine, MyState { wasi });

    let instance = linker.instantiate(&mut store, &module)?;

    let main_export = instance
        .get_func(&mut store, invoke)
        .with_context(|| format!("failed to find `{}` export", invoke))?;
    let results_count = main_export.ty(&store).results().len();
    let mut results = vec![Val::I32(0); results_count];

    main_export.call(&mut store, &[], &mut results)?;

    if let Some(res) = results.first() {
        match res {
            Val::I32(i) => println!("{}", i),
            Val::I64(i) => println!("{}", i),
            Val::F32(f) => println!("{}", f),
            Val::F64(f) => println!("{}", f),
            _ => println!("{:?}", res),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_test() {
        // Assert that true is true to ensure the test harness is running
        assert!(true);
    }
}
