use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use walkdir::WalkDir;
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime::*;
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::{DirPerms, FilePerms};

mod bench;
mod process;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,

    /// Enable debug mode (disable compiler optimizations/inlining)
    #[arg(short = 'g', long = "debug")]
    debug: bool,

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

        /// Print timing results of compiler phases
        #[arg(long)]
        time: bool,

        /// Disable compiler caching and force rebuild
        #[arg(long = "no-cache")]
        no_cache: bool,

        /// Compilation target, passed through to the compiler
        /// (it validates the value; currently 'zena-cli' or 'host')
        #[arg(short = 't', long)]
        target: Option<String>,
    },
    /// Run a compiled Zena source file or WASM file
    Run {
        /// The .zena or .wasm file to run
        file: String,

        /// The function to invoke
        #[arg(long, default_value = "main")]
        invoke: String,

        /// Directories to pre-open
        #[arg(long = "dir")]
        dirs: Vec<String>,

        /// Print timing results of compiler phases
        #[arg(long)]
        time: bool,

        /// Disable compiler caching and force rebuild
        #[arg(long = "no-cache")]
        no_cache: bool,

        /// Allow the program to spawn host processes via zena:process
        /// (a deliberate sandbox escape; ZENA_ALLOW_SPAWN=1 also works)
        #[arg(long = "allow-spawn")]
        allow_spawn: bool,

        /// Arguments to pass to the Wasm program
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Run test suites in `.zena` files
    Test {
        /// The paths or glob patterns to the test files or directories
        #[arg(required = true)]
        paths: Vec<String>,

        /// Filter tests matching a pattern
        #[arg(short, long)]
        filter: Option<String>,

        /// Run exactly one test file in-process and exit with its status
        /// (worker mode used by the Zena test orchestrator)
        #[arg(long, hide = true)]
        single: bool,
    },
    /// Ahead-of-time compile a .wasm file to a .cwasm beside it, so later
    /// invocations skip the in-process Cranelift compile. Build scripts run
    /// this right after producing a compiler wasm.
    Precompile {
        /// The .wasm file to precompile
        file: String,
    },
    /// Run a Tachometer-style benchmark comparing wasm/wat/zena/command
    /// variants round-robin. Orchestration and statistics live in Zena
    /// (bench-run.zena + zena:bench); the host contributes process
    /// spawning and the `sample` worker. See docs/design/benchmarking.md.
    Bench {
        /// Path to a bench config JSON
        config: String,

        /// Where to write the report JSON (default: <suite>.results.json
        /// beside the config)
        #[arg(short, long)]
        out: Option<String>,
    },
    /// Take timing samples of a wasm/wat/zena module: fresh instance per
    /// sample, one timed call each, one ms value printed per line
    /// (worker mode used by the Zena bench orchestrator)
    #[command(hide = true)]
    Sample {
        /// The .zena, .wasm, or .wat file to sample
        file: String,

        /// The exported function to time
        #[arg(long, default_value = "main")]
        invoke: String,

        /// Number of samples to take
        #[arg(short, default_value = "1")]
        n: u32,
    },
}

struct MyState {
    wasi: WasiP1Ctx,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Build { file, output, time, no_cache, target } => {
            build_file(&file, &output, cli.verbose, time, no_cache, cli.debug, target.as_deref())
        }
        Commands::Run { file, invoke, dirs, time, no_cache, allow_spawn, args } => {
            let allow_spawn = process::spawn_allowed(allow_spawn);
            if file.ends_with(".wasm") {
                run_wasm(&file, &invoke, cli.verbose, &dirs, &args, cli.debug, allow_spawn)
            } else {
                compile_and_run(&file, &invoke, cli.verbose, time, no_cache, &dirs, &args, cli.debug, allow_spawn)
            }
        }
        Commands::Test { paths, filter, single } => {
            if single {
                run_single_test_worker(&paths, cli.verbose, cli.debug)
            } else {
                run_all_tests(&paths, filter.as_deref(), cli.verbose, cli.debug)
            }
        }
        Commands::Precompile { file } => precompile_file(&file, cli.debug),
        Commands::Bench { config, out } => {
            bench::run_bench(&config, out.as_deref(), cli.verbose, cli.debug)
        }
        Commands::Sample { file, invoke, n } => bench::run_sample(&file, &invoke, n, cli.verbose, cli.debug),
    }
}

/// Builds the wasmtime Config shared by every zena-cli engine. All engines
/// that touch the same cwasm artifacts must agree on these settings: wasmtime
/// refuses to deserialize a cwasm whose compile-affecting flags differ, and
/// the fallback is a silent multi-second in-process recompile.
fn base_config(debug: bool) -> Config {
    let mut config = Config::new();
    config.cranelift_opt_level(wasmtime::OptLevel::Speed);
    config.compiler_inlining(if debug { Inlining::No } else { Inlining::Yes });
    config.wasm_gc(true);
    config.wasm_function_references(true);
    config.wasm_exceptions(true);
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);
    if std::env::var("ZENA_PROFILE").is_ok() {
        config.profiler(wasmtime::ProfilingStrategy::PerfMap);
    } else {
        config.native_unwind_info(false);
    }
    apply_gc_config(&mut config);
    config
}

/// The cwasm cache path for a wasm file under the given config variant.
/// Debug (no-inlining) engines cannot reuse release cwasm and vice versa, so
/// each variant gets its own file instead of the two thrashing one path.
fn cwasm_path_for(wasm_path: &Path, debug: bool) -> std::path::PathBuf {
    if debug {
        wasm_path.with_extension("debug.cwasm")
    } else {
        wasm_path.with_extension("cwasm")
    }
}

fn precompile_file(file: &str, debug: bool) -> Result<()> {
    let engine = Engine::new(&base_config(debug))?;
    let wasm_path = Path::new(file);
    let cwasm_path = cwasm_path_for(wasm_path, debug);
    let _ = load_or_compile_module(&engine, wasm_path, &cwasm_path)?;
    println!("Precompiled {}", cwasm_path.display());
    Ok(())
}

fn build_file(file: &str, output: &str, verbose: bool, time: bool, _no_cache: bool, debug: bool, target: Option<&str>) -> Result<()> {
    // `build` is an explicit request to compile: invoking it at all expresses
    // the staleness decision, and the build scripts that call it are gated by
    // Wireit's own input tracking. Always compile rather than second-guessing
    // with mtime heuristics.
    let cached_wasm_path = compile_to_cache(file, verbose, time, false, false, true, debug, target)?;
    // Output directories like zena/out/ are gitignored, so a clean checkout
    // does not have them.
    if let Some(parent) = std::path::Path::new(output).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::copy(&cached_wasm_path, output)?;
    Ok(())
}

fn compile_and_run(file: &str, invoke: &str, verbose: bool, time: bool, no_cache: bool, dirs: &[String], args: &[String], debug: bool, allow_spawn: bool) -> Result<()> {
    // Capture the compiler's own output rather than inheriting stdout:
    // `run` prints the program's output, and a compile that happens to
    // miss the cache must not change what the program appears to print.
    // On failure the captured text is replayed to stderr; `-v` streams
    // it live instead.
    let cached_wasm_path = compile_to_cache(file, verbose, time, false, !verbose, no_cache, debug, None)?;
    run_wasm(cached_wasm_path.to_str().unwrap(), invoke, verbose, dirs, args, debug, allow_spawn)
}

/// True when the cached cwasm is missing or older than its source wasm.
fn cwasm_is_stale(wasm_path: &Path, cwasm_path: &Path) -> bool {
    if !cwasm_path.exists() {
        return true;
    }
    let wasm_meta = std::fs::metadata(wasm_path);
    let cwasm_meta = std::fs::metadata(cwasm_path);
    match (wasm_meta, cwasm_meta) {
        (Ok(w), Ok(c)) => match (w.modified(), c.modified()) {
            (Ok(w_time), Ok(c_time)) => w_time > c_time,
            _ => true,
        },
        _ => true,
    }
}

/// Compiles wasm_path to cwasm_path atomically, holding a file lock.
///
/// The lock serializes concurrent compiles of the same module. Script runners
/// can launch many zena-cli processes at once against a stale cache (e.g. a
/// test fan-out right after the compiler was rebuilt), and each Cranelift
/// compile of the compiler module costs on the order of a GiB of RSS. Let one
/// process compile while the rest block on the lock and then reuse its
/// output. `should_compile` is re-checked under the lock: another process may
/// have refreshed the cache while we waited.
fn write_cwasm(
    engine: &Engine,
    wasm_path: &Path,
    cwasm_path: &Path,
    should_compile: impl Fn() -> bool,
) -> Result<()> {
    let lock_path = cwasm_path.with_extension("lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)?;
    lock_file.lock()?;
    if should_compile() {
        let wasm_bytes = std::fs::read(wasm_path)?;
        let serialized = engine.precompile_module(&wasm_bytes)?;
        let temp_path = cwasm_path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temp_path, serialized)?;
        if let Err(e) = std::fs::rename(&temp_path, cwasm_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(e.into());
        }
    }
    // The lock is released when lock_file drops.
    Ok(())
}

fn load_or_compile_module(engine: &Engine, wasm_path: &Path, cwasm_path: &Path) -> Result<Module> {
    if cwasm_is_stale(wasm_path, cwasm_path) {
        write_cwasm(engine, wasm_path, cwasm_path, || {
            cwasm_is_stale(wasm_path, cwasm_path)
        })?;
    }

    match unsafe { Module::deserialize_file(engine, cwasm_path) } {
        Ok(m) => Ok(m),
        Err(first_err) => {
            // A fresh-looking cwasm that will not deserialize was produced by
            // an incompatible engine (different wasmtime version or config).
            // Recompile it in place; without this, every invocation would
            // silently repeat the multi-second in-process compile.
            eprintln!(
                "WARNING: recompiling {}: deserialization failed: {:?}",
                cwasm_path.display(),
                first_err
            );
            write_cwasm(engine, wasm_path, cwasm_path, || true)?;
            match unsafe { Module::deserialize_file(engine, cwasm_path) } {
                Ok(m) => Ok(m),
                Err(e) => {
                    eprintln!("WARNING: deserialization of cwasm failed again: {:?}", e);
                    let wasm_bytes = std::fs::read(wasm_path)?;
                    Module::new(engine, &wasm_bytes)
                        .map_err(anyhow::Error::from)
                        .context("Failed to compile module from WASM bytes")
                }
            }
        }
    }
}

/// The repository root that compiler wasm, stdlib, and cache paths hang off.
/// Defaults to the checkout this binary was built in (CARGO_MANIFEST_DIR is
/// baked in at compile time), so a binary built in one checkout serves
/// another — a git worktree, a second clone — only via the ZENA_REPO_ROOT
/// environment variable.
fn repo_root() -> Result<std::path::PathBuf> {
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

/// Compiles a `.zena` source file by invoking the pre-built self-hosted compiler (`cli.wasm`)
/// inside a Wasmtime sandbox, returning the path to the cached WebAssembly file.
fn compile_to_cache(
    file: &str,
    verbose: bool,
    time: bool,
    test_mode: bool,
    capture_output: bool,
    no_cache: bool,
    debug: bool,
    target: Option<&str>,
) -> Result<std::path::PathBuf> {
    let repo_root = repo_root()?;
    let compiler_wasm = std::env::var("ZENA_COMPILER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| repo_root.join("packages/zena-compiler/zena/out/cli.wasm"));

    if !compiler_wasm.exists() {
        anyhow::bail!(
            "Compiler WASM not found at {}. Please build it first.",
            compiler_wasm.display()
        );
    }

    // Compute deterministic cache path based on absolute file source
    let abs_path = std::fs::canonicalize(file).context("Failed to resolve file path")?;
    let rel_path = abs_path
        .strip_prefix(&repo_root)
        .context("File must be inside the Zena repository for now")?;

    // Create an absolute path into the cache directory
    let cache_dir = if std::env::var("ZENA_PROJECT_CACHE").is_ok()
        || std::env::var("ZENA_LOCAL_CACHE").is_ok()
    {
        repo_root.join(".zena/cache")
    } else {
        let proj_dirs =
            ProjectDirs::from("org", "zena-lang", "zena").context("No home directory found")?;
        proj_dirs.cache_dir().join("wasm_objects")
    };
    std::fs::create_dir_all(&cache_dir)?;
    let cache_dir = std::fs::canonicalize(cache_dir)?;

    let mut hasher = DefaultHasher::new();
    abs_path.hash(&mut hasher);
    test_mode.hash(&mut hasher);
    debug.hash(&mut hasher);
    // The target changes the emitted bytes, so it must key the cache.
    target.hash(&mut hasher);
    // Identify the compiler by (mtime, len) rather than hashing all of its
    // bytes: reading tens of MiB on every invocation is measurable, and a
    // rebuilt-but-identical compiler only costs one spurious recompile.
    if let Ok(metadata) = std::fs::metadata(&compiler_wasm) {
        if let Ok(modified) = metadata.modified() {
            modified.hash(&mut hasher);
        }
        metadata.len().hash(&mut hasher);
    }

    // Env vars that change compiler output must key the cache, or toggling
    // them serves stale artifacts.
    std::env::var("ZENA_BACKEND").unwrap_or_default().hash(&mut hasher);

    // The package manifest steers module resolution, so its content keys the
    // cache too (mtime+len, same identity scheme as the compiler wasm).
    if let Ok(metadata) = std::fs::metadata(repo_root.join("zena-packages.json")) {
        if let Ok(modified) = metadata.modified() {
            modified.hash(&mut hasher);
        }
        metadata.len().hash(&mut hasher);
    }

    // Walk packages/stdlib to include standard library files
    let stdlib_dir = repo_root.join("packages/stdlib");
    for entry in WalkDir::new(&stdlib_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "zena"))
    {
        entry.path().hash(&mut hasher);
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                modified.hash(&mut hasher);
            }
            metadata.len().hash(&mut hasher);
        }
    }

    // If the file is inside the repo's packages directory, hash that package's zena files
    if let Ok(rel_to_repo) = abs_path.strip_prefix(&repo_root) {
        let mut components = rel_to_repo.components();
        if let Some(std::path::Component::Normal(first)) = components.next() {
            if first == "packages" {
                if let Some(std::path::Component::Normal(pkg_name)) = components.next() {
                    let pkg_dir = repo_root.join("packages").join(pkg_name);
                    // Walk only the package directory recursively
                    for entry in WalkDir::new(&pkg_dir)
                        .into_iter()
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().extension().map_or(false, |ext| ext == "zena"))
                    {
                        entry.path().hash(&mut hasher);
                        if let Ok(metadata) = entry.metadata() {
                            if let Ok(modified) = metadata.modified() {
                                modified.hash(&mut hasher);
                            }
                            metadata.len().hash(&mut hasher);
                        }
                    }
                }
            }
        }
    }

    let hash = hasher.finish();
    let file_name = abs_path.file_stem().unwrap_or_default().to_string_lossy();
    let cached_wasm_name = format!("{}_{:x}.wasm", file_name, hash);
    let cached_wasm_path = cache_dir.join(&cached_wasm_name);

    let needs_compile = if no_cache {
        true
    } else if cached_wasm_path.exists() {
        let source_mod = std::fs::metadata(&abs_path).and_then(|m| m.modified()).ok();
        let compiler_mod = std::fs::metadata(&compiler_wasm).and_then(|m| m.modified()).ok();
        let cached_mod = std::fs::metadata(&cached_wasm_path).and_then(|m| m.modified()).ok();
        if verbose {
            println!(
                "CACHE CHECK [{}]: source={:?}, compiler={:?}, cached={:?}",
                file, source_mod, compiler_mod, cached_mod
            );
        }
        match (source_mod, compiler_mod, cached_mod) {
            (Some(s), Some(c), Some(ch)) => s > ch || c > ch,
            _ => true,
        }
    } else {
        if verbose {
            println!("CACHE CHECK [{}]: cached_wasm_path does not exist: {:?}", file, cached_wasm_path);
        }
        true
    };

    if !needs_compile {
        return Ok(cached_wasm_path);
    }

    let engine = Engine::new(&base_config(debug))?;
    let cwasm_path = cwasm_path_for(&compiler_wasm, debug);
    let compiler_module = load_or_compile_module(&engine, &compiler_wasm, &cwasm_path)?;

    let mut linker: Linker<MyState> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;
    add_stack_trace_helpers(&mut linker, &engine, &compiler_module)?;

    let stdlib_dir = repo_root.join("packages/stdlib/zena");

    let file_arg = rel_path.to_string_lossy().to_string();

    // Pass the actual absolute path to the user's cache directory using the `-o` flag
    let out_path_arg = cached_wasm_path.to_string_lossy().to_string();

    let mut compiler_args = vec!["zc".to_string(), file_arg, "-o".to_string(), out_path_arg];
    if let Some(target) = target {
        compiler_args.push("-t".to_string());
        compiler_args.push(target.to_string());
    }
    if time {
        compiler_args.push("--time".to_string());
    }
    if test_mode {
        compiler_args.push("--test".to_string());
    }

    if cached_wasm_path.exists() {
        std::fs::remove_file(&cached_wasm_path).ok();
    }

    let (wasi_stdout, wasi_stderr) = if capture_output {
        (
            Some(MemoryOutputPipe::new(1024 * 1024)),
            Some(MemoryOutputPipe::new(1024 * 1024)),
        )
    } else {
        (None, None)
    };

    let mut wasi_builder = WasiCtxBuilder::new();
    if let Some(ref out) = wasi_stdout {
        wasi_builder.stdout(out.clone());
    } else {
        wasi_builder.inherit_stdout();
    }
    if let Some(ref err) = wasi_stderr {
        wasi_builder.stderr(err.clone());
    } else {
        wasi_builder.inherit_stderr();
    }

        let wasi = wasi_builder
            .inherit_env()
            .args(&compiler_args)
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
        reserve_gc_heap(&engine, &mut store)?;

        let compiler_instance = linker.instantiate(&mut store, &compiler_module)?;
        let compiler_main = compiler_instance
            .get_func(&mut store, "main")
            .expect("missing main export in cli.wasm");

        let mut compiler_results = vec![Val::I32(0); compiler_main.ty(&store).results().len()];

        if verbose && !test_mode {
            println!("Compiling {}...", file);
        }
        let compiler_res = compiler_main.call(&mut store, &[], &mut compiler_results);

        if let Err(e) = compiler_res {
            eprintln!("Compiler failed with error: {:?}", e);
            if let Some(bt) = e.downcast_ref::<wasmtime::WasmBacktrace>() {
                eprintln!("Wasm Backtrace:\n{}", bt);
            }
            if let Some(err_pipe) = wasi_stderr {
                let bytes = err_pipe.contents();
                let err_str = String::from_utf8_lossy(&bytes);
                eprintln!("Compiler Stderr:\n{}", err_str);
            }
            if let Some(out_pipe) = wasi_stdout {
                let bytes = out_pipe.contents();
                let out_str = String::from_utf8_lossy(&bytes);
                eprintln!("Compiler Stdout:\n{}", out_str);
            }
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

/// How many MiB of GC heap headroom to reserve up front (see
/// `reserve_gc_heap`). Overridable via the ZENA_GC_RESERVE_MB env var;
/// 0 disables the reservation.
const DEFAULT_GC_RESERVE_MB: u64 = 0;

/// Pre-grows the store's GC heap by allocating, and immediately
/// dropping, one large dummy array.
///
/// Wasmtime's copying collector only grows the GC heap when an
/// allocation still does not fit after a full collection, so the heap
/// hovers just above the size of the live set and allocation-heavy
/// programs (like the self-hosted compiler) spend most of their time
/// collecting: roughly one full live-set copy per live-set's worth of
/// allocation. The GC heap never shrinks, so one oversized allocation
/// up front leaves every later collection with ample headroom. The
/// balloon array is dead as soon as the helper returns; only the
/// grown heap capacity remains.
///
/// The allocation is done by a tiny auxiliary wasm module using
/// `array.new_default` because the host-side `ArrayRef::new`
/// initializes elements one `Val` at a time (~2.4s/GiB, versus
/// memset speed here).
fn reserve_gc_heap(engine: &Engine, store: &mut Store<MyState>) -> Result<()> {
    let mb: u64 = match std::env::var("ZENA_GC_RESERVE_MB") {
        Ok(v) => v
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("ZENA_GC_RESERVE_MB must be an integer, got {v:?}"))?,
        Err(_) => DEFAULT_GC_RESERVE_MB,
    };
    // The GC heap is an i32-indexed memory capped at 4 GiB and split
    // into two equal semi-spaces, and the balloon must fit in one
    // semi-space. Above this cap the growth request would exceed the
    // 4 GiB maximum and wasmtime would skip growing entirely.
    let mb = mb.min(1900);
    if mb == 0 {
        return Ok(());
    }
    let wat = r#"(module
      (type $balloon (array (mut i64)))
      (func (export "balloon") (param $len i32)
        (drop (array.new_default $balloon (local.get $len)))))"#;
    let module = Module::new(engine, wat)?;
    let instance = Linker::<MyState>::new(engine).instantiate(&mut *store, &module)?;
    let balloon = instance.get_typed_func::<i32, ()>(&mut *store, "balloon")?;
    let len = i32::try_from(mb * (1 << 20) / 8).unwrap();
    // A failure here only means less headroom, not incorrectness.
    let _ = balloon.call(&mut *store, len);
    Ok(())
}

/// Selects the wasmtime GC collector via the ZENA_GC env var
/// (null | drc | copying). Defaults to wasmtime's Auto.
fn apply_gc_config(config: &mut Config) {
    match std::env::var("ZENA_GC").as_deref() {
        Ok("null") => {
            config.collector(Collector::Null);
        }
        Ok("drc") => {
            config.collector(Collector::DeferredReferenceCounting);
        }
        Ok("copying") => {
            config.collector(Collector::Copying);
        }
        _ => {}
    }
}

fn run_wasm(file: &str, invoke: &str, _verbose: bool, dirs: &[String], args: &[String], debug: bool, allow_spawn: bool) -> Result<()> {
    let engine = Engine::new(&base_config(debug))?;
    let wasm_path = Path::new(file);
    let cwasm_path = cwasm_path_for(wasm_path, debug);
    let module = load_or_compile_module(&engine, wasm_path, &cwasm_path)?;

    let mut linker: Linker<MyState> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;
    add_stack_trace_helpers(&mut linker, &engine, &module)?;
    process::add_process_imports(&mut linker, &module, allow_spawn)?;

    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder.inherit_stdio().inherit_env();

    // The arguments vector expects the first argument to be the program name (e.g., standard convention)
    let mut guest_args = vec![file.to_string()];
    guest_args.extend_from_slice(args);
    wasi_builder.args(&guest_args);

    let repo_root = repo_root()?;

    for dir in dirs {
        // Handle format `HOST_DIR::GUEST_DIR` standard in wasmtime CLI
        let parts: Vec<&str> = dir.split("::").collect();
        let (host_dir, guest_dir) = if parts.len() == 2 {
            (parts[0], parts[1])
        } else {
            (dir.as_str(), dir.as_str())
        };

        let host_path = Path::new(host_dir);
        let host_dir_adjusted = if (std::env::var("ZENA_PROJECT_CACHE").is_ok()
            || std::env::var("ZENA_LOCAL_CACHE").is_ok())
            && host_path.starts_with("/tmp")
        {
            let relative_to_tmp = host_path.strip_prefix("/tmp").unwrap();
            let new_host_path = repo_root.join(".zena/tmp").join(relative_to_tmp);
            std::fs::create_dir_all(&new_host_path)?;
            new_host_path
        } else {
            std::path::PathBuf::from(host_dir)
        };
        let host_dir_adjusted = std::fs::canonicalize(host_dir_adjusted)?;

        wasi_builder.preopened_dir(&host_dir_adjusted, guest_dir, DirPerms::all(), FilePerms::all())?;
    }

    let wasi = wasi_builder.build_p1();

    let mut store = Store::new(&engine, MyState { wasi });
    reserve_gc_heap(&engine, &mut store)?;

    let instance = match linker.instantiate(&mut store, &module) {
        Ok(inst) => inst,
        Err(e) => {
            eprintln!("Instantiation failed!");
            if let Some(bt) = e.downcast_ref::<wasmtime::WasmBacktrace>() {
                eprintln!("Wasm Backtrace:\n{}", bt);
            }
            return Err(e.into());
        }
    };

    let main_export = instance
        .get_func(&mut store, invoke)
        .with_context(|| format!("failed to find `{}` export", invoke))?;
    let results_count = main_export.ty(&store).results().len();
    let mut results = vec![Val::I32(0); results_count];

    if let Err(e) = main_export.call(&mut store, &[], &mut results) {
        if let Some(bt) = e.downcast_ref::<wasmtime::WasmBacktrace>() {
            eprintln!("Wasm Backtrace:\n{}", bt);
        }
        return Err(e.into());
    }

    if let Some(res) = results.first() {
        match res {
            Val::I32(i) => println!("{}", i),
            Val::I64(i) => println!("{}", i),
            Val::F32(f) => println!("{}", f32::from_bits(*f)),
            Val::F64(f) => println!("{}", f64::from_bits(*f)),
            _ => println!("{:?}", res),
        }
    }

    Ok(())
}

fn add_stack_trace_helpers(
    linker: &mut Linker<MyState>,
    engine: &Engine,
    module: &Module,
) -> Result<()> {
    // 1. getStackTrace
    let get_stack_trace_ty = module
        .imports()
        .find(|i| i.module() == "env" && i.name() == "getStackTrace")
        .and_then(|i| i.ty().func().cloned())
        .unwrap_or_else(|| wasmtime::FuncType::new(engine, [], [wasmtime::ValType::EXTERNREF]));
    linker.func_new("env", "getStackTrace", get_stack_trace_ty,
        |mut caller: wasmtime::Caller<'_, MyState>, _params, results| {
            let bt = wasmtime::WasmBacktrace::capture(&caller);
            let str_bt = format!("{}", bt);
            if str_bt.is_empty() {
                results[0] = wasmtime::Val::ExternRef(None);
                return Ok(());
            }

            let create = caller.get_export("$stringCreate").and_then(|e| e.into_func());
            let set_byte = caller.get_export("$stringSetByte").and_then(|e| e.into_func());

            if let (Some(create), Some(set_byte)) = (create, set_byte) {
                let bytes = str_bt.as_bytes();
                let mut cr_res = vec![wasmtime::Val::I32(0)];
                create.call(&mut caller, &[wasmtime::Val::I32(bytes.len() as i32)], &mut cr_res)?;

                let str_ref = cr_res[0].clone();
                for (i, &byte) in bytes.iter().enumerate() {
                    set_byte.call(
                        &mut caller,
                        &[
                            str_ref.clone(),
                            wasmtime::Val::I32(i as i32),
                            wasmtime::Val::I32(byte as i32),
                        ],
                        &mut [],
                    )?;
                }

                results[0] = str_ref;
            } else {
                results[0] = wasmtime::Val::ExternRef(None);
            }
            Ok(())
        },
    )?;

    // 2. captureStackTrace
    let capture_stack_trace_ty = module
        .imports()
        .find(|i| i.module() == "env" && i.name() == "captureStackTrace")
        .and_then(|i| i.ty().func().cloned())
        .unwrap_or_else(|| wasmtime::FuncType::new(engine, [], [wasmtime::ValType::EXTERNREF]));
    linker.func_new("env", "captureStackTrace", capture_stack_trace_ty,
        |mut caller: wasmtime::Caller<'_, MyState>, _params, results| {
            let bt = wasmtime::WasmBacktrace::capture(&caller);
            let ext_ref = wasmtime::ExternRef::new(&mut caller, bt)?;
            results[0] = wasmtime::Val::ExternRef(Some(ext_ref));
            Ok(())
        },
    )?;

    // 3. formatStackTrace
    let format_stack_trace_ty = module
        .imports()
        .find(|i| i.module() == "env" && i.name() == "formatStackTrace")
        .and_then(|i| i.ty().func().cloned())
        .unwrap_or_else(|| wasmtime::FuncType::new(engine, [wasmtime::ValType::EXTERNREF], [wasmtime::ValType::EXTERNREF]));
    linker.func_new("env", "formatStackTrace", format_stack_trace_ty,
        |mut caller: wasmtime::Caller<'_, MyState>, params, results| {
            let bt_ref = match &params[0] {
                wasmtime::Val::ExternRef(Some(r)) => r.clone(),
                wasmtime::Val::AnyRef(Some(anyref)) => {
                    wasmtime::ExternRef::convert_any(&mut caller, anyref.clone())?
                }
                wasmtime::Val::ExternRef(None) | wasmtime::Val::AnyRef(None) => {
                    results[0] = wasmtime::Val::ExternRef(None);
                    return Ok(());
                }
                _ => {
                    return Err(wasmtime::Error::msg(format!("formatStackTrace: Expected ExternRef or AnyRef, got {:?}", params[0])));
                }
            };
            let bt = match bt_ref.data(&caller)?.and_then(|any| any.downcast_ref::<wasmtime::WasmBacktrace>()) {
                Some(bt) => bt,
                None => {
                    return Err(wasmtime::Error::msg("formatStackTrace: Failed to downcast ExternRef data to WasmBacktrace"));
                }
            };
            let str_bt = format!("{}", bt);
            if str_bt.is_empty() {
                results[0] = wasmtime::Val::ExternRef(None);
                return Ok(());
            }

            let create = caller.get_export("$stringCreate").and_then(|e| e.into_func());
            let set_byte = caller.get_export("$stringSetByte").and_then(|e| e.into_func());

            if let (Some(create), Some(set_byte)) = (create, set_byte) {
                let bytes = str_bt.as_bytes();
                let mut cr_res = vec![wasmtime::Val::I32(0)];
                create.call(&mut caller, &[wasmtime::Val::I32(bytes.len() as i32)], &mut cr_res)?;

                let str_ref = cr_res[0].clone();
                for (i, &byte) in bytes.iter().enumerate() {
                    set_byte.call(
                        &mut caller,
                        &[
                            str_ref.clone(),
                            wasmtime::Val::I32(i as i32),
                            wasmtime::Val::I32(byte as i32),
                        ],
                        &mut [],
                    )?;
                }

                results[0] = str_ref;
            } else {
                results[0] = wasmtime::Val::ExternRef(None);
            }
            Ok(())
        },
    )?;

    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum TestStatus {
    Pass,
    Fail,
}

fn run_all_tests(paths: &[String], filter: Option<&str>, verbose: bool, debug: bool) -> Result<()> {
    let mut test_files = Vec::new();

    for path_str in paths {
        if path_str.contains('*') || path_str.contains('?') || path_str.contains('[') {
            // Treat as glob pattern
            match glob::glob(path_str) {
                Ok(entries) => {
                    for entry in entries {
                        if let Ok(p) = entry {
                            if p.is_file() && p.extension().map_or(false, |ext| ext == "zena") {
                                test_files.push(p);
                            }
                        }
                    }
                }
                Err(e) => {
                    anyhow::bail!("Invalid glob pattern '{}': {}", path_str, e);
                }
            }
        } else {
            let target_path = Path::new(path_str);
            if target_path.is_file() {
                if target_path.extension().map_or(false, |ext| ext == "zena") {
                    test_files.push(target_path.to_path_buf());
                }
            } else if target_path.is_dir() {
                for entry in WalkDir::new(target_path) {
                    let entry = entry?;
                    let p = entry.path();
                    if p.is_file() {
                        let filename = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
                        if filename.ends_with("_test.zena") {
                            test_files.push(p.to_path_buf());
                        }
                    }
                }
            } else {
                anyhow::bail!("Path not found: {}", path_str);
            }
        }
    }

    if let Some(f) = filter {
        test_files.retain(|p| p.to_string_lossy().contains(f));
    }

    test_files.sort();

    if test_files.is_empty() {
        anyhow::bail!("No tests found matching the path/filter.");
    }

    println!("Running {} tests...", test_files.len());

    // Orchestration lives in Zena (test-run.zena): it spawns this binary
    // back in `test --single` worker mode via zena:process, one process
    // per test, with a bounded pool. Compiling the orchestrator first
    // also warms the compiler cwasm before workers race to reuse it.
    let parallelism = std::env::var("ZENA_TEST_PARALLELISM")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(4)
                .min(8)
        });
    let self_exe = std::env::current_exe()?;
    let mut guest_args = vec![
        self_exe.to_string_lossy().into_owned(),
        parallelism.to_string(),
        if debug { "1" } else { "0" }.to_string(),
    ];
    for f in &test_files {
        guest_args.push(std::fs::canonicalize(f)?.to_string_lossy().into_owned());
    }
    let code = run_internal_tool("packages/zena-cli/zena/test-run.zena", &guest_args, verbose, debug)?;
    if code != 0 {
        anyhow::bail!("Some tests failed");
    }
    Ok(())
}

/// `test --single <file>` worker mode: run one test in-process, mirror
/// its captured output, and exit 0/1. The Zena orchestrator captures
/// both streams via zena:process and decides what to display.
fn run_single_test_worker(paths: &[String], verbose: bool, debug: bool) -> Result<()> {
    anyhow::ensure!(paths.len() == 1, "test --single takes exactly one file");
    let engine = Engine::new(&base_config(debug))?;
    match run_single_test(&engine, Path::new(&paths[0]), verbose, debug) {
        Ok((TestStatus::Pass, stdout, _stderr, _msg)) => {
            print!("{stdout}");
            Ok(())
        }
        Ok((TestStatus::Fail, stdout, stderr, msg)) => {
            print!("{stdout}");
            eprint!("{stderr}");
            if let Some(m) = msg {
                eprintln!("{m}");
            }
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Error: {e:?}");
            std::process::exit(1);
        }
    }
}

/// Compiles and runs one of zena-cli's own orchestrator programs
/// (`packages/zena-cli/zena/*.zena`) with the spawn capability, inherited
/// stdio, and a full host-root preopen — these are repo tooling, not
/// sandboxed guests. Returns the program's i32 exit code.
fn run_internal_tool(
    src_repo_rel: &str,
    guest_args: &[String],
    verbose: bool,
    debug: bool,
) -> Result<i32> {
    let src = repo_root()?.join(src_repo_rel);
    let cached = compile_to_cache(&src.to_string_lossy(), verbose, false, false, true, false, debug, None)?;
    let engine = Engine::new(&base_config(debug))?;
    let cwasm = cwasm_path_for(&cached, debug);
    let module = load_or_compile_module(&engine, &cached, &cwasm)?;

    let mut linker: Linker<MyState> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;
    add_stack_trace_helpers(&mut linker, &engine, &module)?;
    process::add_process_imports(&mut linker, &module, true)?;

    let mut args = vec![src_repo_rel.to_string()];
    args.extend_from_slice(guest_args);
    let wasi = WasiCtxBuilder::new()
        .inherit_stdio()
        .inherit_env()
        .args(&args)
        .preopened_dir("/", "/", DirPerms::all(), FilePerms::all())?
        .build_p1();
    let mut store = Store::new(&engine, MyState { wasi });
    reserve_gc_heap(&engine, &mut store)?;

    let instance = linker.instantiate(&mut store, &module)?;
    let func = instance
        .get_func(&mut store, "main")
        .with_context(|| format!("{src_repo_rel} has no main export"))?;
    let mut results = vec![Val::I32(0)];
    func.call(&mut store, &[], &mut results)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("{src_repo_rel} failed"))?;
    match results.first() {
        Some(Val::I32(code)) => Ok(*code),
        _ => Ok(0),
    }
}

fn run_single_test(
    engine: &Engine,
    test_file: &Path,
    verbose: bool,
    debug: bool,
) -> Result<(TestStatus, String, String, Option<String>)> {
    let t_start = std::time::Instant::now();
    // Compile to cache (always capture compiler output during tests to prevent log flooding)
    let cached_wasm_path = compile_to_cache(&test_file.to_string_lossy(), verbose, false, true, true, false, debug, None)?;
    let t_compile = t_start.elapsed();

    let t_load_start = std::time::Instant::now();
    // Run using wasmtime
    let wasm_path = Path::new(&cached_wasm_path);
    let cwasm_path = wasm_path.with_extension("cwasm");
    let module = load_or_compile_module(engine, wasm_path, &cwasm_path)?;
    let t_load = t_load_start.elapsed();

    let t_inst_start = std::time::Instant::now();
    let mut linker: Linker<MyState> = Linker::new(engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;
    add_stack_trace_helpers(&mut linker, engine, &module)?;
    // Repo tests are trusted code (they already get full repo preopens).
    process::add_process_imports(&mut linker, &module, true)?;

    let repo_root = repo_root()?;
    let stdlib_dir = std::fs::canonicalize(repo_root.join("packages/stdlib/zena"))?;

    // Setup in-memory stdout and stderr capture
    let stdout_pipe = MemoryOutputPipe::new(1024 * 1024);
    let stderr_pipe = MemoryOutputPipe::new(1024 * 1024);

    let tmp_host_dir = if std::env::var("ZENA_PROJECT_CACHE").is_ok()
        || std::env::var("ZENA_LOCAL_CACHE").is_ok()
    {
        let dir = repo_root.join(".zena/tmp");
        std::fs::create_dir_all(&dir)?;
        dir
    } else {
        std::path::PathBuf::from("/tmp")
    };
    let tmp_host_dir = std::fs::canonicalize(tmp_host_dir)?;

    let wasi = WasiCtxBuilder::new()
        .stdout(stdout_pipe.clone())
        .stderr(stderr_pipe.clone())
        .inherit_env()
        .args(&[test_file.to_string_lossy().to_string()])
        .preopened_dir(&repo_root, ".", DirPerms::all(), FilePerms::all())?
        .preopened_dir(&stdlib_dir, "/stdlib", DirPerms::all(), FilePerms::all())?
        .preopened_dir(&tmp_host_dir, "/tmp", DirPerms::all(), FilePerms::all())?
        .build_p1();

    let mut store = Store::new(engine, MyState { wasi });

    let instance = match linker.instantiate(&mut store, &module) {
        Ok(inst) => inst,
        Err(e) => {
            let stderr_bytes = stderr_pipe.contents();
            let stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();
            return Ok((
                TestStatus::Fail,
                String::new(),
                stderr_str,
                Some(format!("Instantiation failed: {:?}", e)),
            ));
        }
    };
    let t_inst = t_inst_start.elapsed();

    let t_run_start = std::time::Instant::now();
    let main_export = match instance.get_func(&mut store, "main") {
        Some(func) => func,
        None => {
            return Ok((
                TestStatus::Fail,
                String::new(),
                String::new(),
                Some("Failed to find `main` export".to_string()),
            ));
        }
    };

    let results_count = main_export.ty(&store).results().len();
    let mut results = vec![Val::I32(0); results_count];

    let call_res = main_export.call(&mut store, &[], &mut results);
    let t_run = t_run_start.elapsed();

    if verbose {
        println!(
            "TIMING [{}]: compile={:?}, load={:?}, inst={:?}, run={:?}",
            test_file.display(),
            t_compile,
            t_load,
            t_inst,
            t_run
        );
    }

    let stdout_bytes = stdout_pipe.contents();
    let stdout_str = String::from_utf8_lossy(&stdout_bytes).into_owned();

    let stderr_bytes = stderr_pipe.contents();
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();

    if let Err(e) = call_res {
        let mut msg = format!("Execution failed: {:?}", e);
        if let Some(bt) = e.downcast_ref::<wasmtime::WasmBacktrace>() {
            msg.push_str(&format!("\nWasm Backtrace:\n{}", bt));
        }
        return Ok((TestStatus::Fail, stdout_str, stderr_str, Some(msg)));
    }

    let returned_zero = if let Some(res) = results.first() {
        match res {
            Val::I32(0) => true,
            _ => false,
        }
    } else {
        true
    };

    if returned_zero && !stdout_str.contains("FAIL") {
        Ok((TestStatus::Pass, stdout_str, stderr_str, None))
    } else {
        let msg = if !returned_zero {
            format!("Suite returned non-zero code: {:?}", results.first())
        } else {
            "Suite reported failure in output".to_string()
        };
        Ok((TestStatus::Fail, stdout_str, stderr_str, Some(msg)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockString {
        data: Vec<u8>,
    }

    #[test]
    fn test_stack_trace_capture_and_format() -> Result<()> {
        let mut config = Config::new();
        config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);
        config.wasm_gc(true);
        apply_gc_config(&mut config);
        let engine = Engine::new(&config)?;

        let wat = r#"
            (module
                (import "env" "captureStackTrace" (func $capture (result externref)))
                (import "env" "formatStackTrace" (func $format (param externref) (result externref)))
                (import "env" "mockStringCreate" (func $create (param i32) (result externref)))
                (import "env" "mockStringSetByte" (func $set_byte (param externref i32 i32)))
                
                (func (export "$stringCreate") (param i32) (result externref)
                    local.get 0
                    call $create
                )
                
                (func (export "$stringSetByte") (param externref i32 i32)
                    local.get 0
                    local.get 1
                    local.get 2
                    call $set_byte
                )
                
                (func $test_stack_trace (export "test_stack_trace") (export "main") (result externref)
                    call $capture
                    call $format
                )
            )
        "#;

        let module = Module::new(&engine, wat)?;
        let mut linker = Linker::<MyState>::new(&engine);

        // Register stack trace helpers
        add_stack_trace_helpers(&mut linker, &engine, &module)?;

        // Register string mocks
        linker.func_wrap("env", "mockStringCreate", |mut caller: Caller<'_, MyState>, len: i32| {
            let mock = MockString { data: vec![0; len as usize] };
            let ext = ExternRef::new(&mut caller, Mutex::new(mock))?;
            Ok(Some(ext))
        })?;

        linker.func_wrap("env", "mockStringSetByte", |caller: Caller<'_, MyState>, ext_ref: Option<Rooted<ExternRef>>, index: i32, val: i32| {
            let ext = ext_ref.ok_or_else(|| wasmtime::Error::msg("mockStringSetByte: expected non-null ExternRef"))?;
            let cell = ext.data(&caller)?.ok_or_else(|| wasmtime::Error::msg("mockStringSetByte: missing data"))?
                .downcast_ref::<Mutex<MockString>>().ok_or_else(|| wasmtime::Error::msg("mockStringSetByte: expected Mutex<MockString>"))?;
            cell.lock().unwrap().data[index as usize] = val as u8;
            Ok(())
        })?;

        // Instantiate
        let wasi_ctx = WasiCtxBuilder::new().build_p1();
        let mut store = Store::new(&engine, MyState { wasi: wasi_ctx });
        let instance = linker.instantiate(&mut store, &module)?;

        // Call "test_stack_trace"
        let func = instance.get_typed_func::<(), Option<Rooted<ExternRef>>>(&mut store, "test_stack_trace")?;
        let result_ref = func.call(&mut store, ())?;

        let ext = result_ref.ok_or_else(|| wasmtime::Error::msg("test_stack_trace returned null"))?;
        let cell = ext.data(&store)?.ok_or_else(|| wasmtime::Error::msg("expected string data in returned ExternRef"))?
            .downcast_ref::<Mutex<MockString>>().ok_or_else(|| wasmtime::Error::msg("expected Mutex<MockString>"))?;
        let bytes = &cell.lock().unwrap().data;
        let stack_trace = String::from_utf8(bytes.clone())?;

        println!("Captured stack trace:\n{}", stack_trace);

        // Verify the backtrace has frames pointing to Wasm execution
        assert!(stack_trace.contains("test_stack_trace"));

        Ok(())
    }
}
