use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use walkdir::WalkDir;
use wasmtime::{Engine, Linker, Store, Val};
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::FsPerms;
use zena_runtime::cache::{cwasm_path_for, load_or_compile_module};
use zena_runtime::engine::reserve_gc_heap;
use zena_runtime::{DirMapping, HostState, Spawn};

mod bench;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,

    /// Enable debug mode (disable compiler optimizations/inlining)
    #[arg(short = 'g', long = "debug")]
    debug: bool,

    /// Optimization level: 0, 1, 2, or s (docs/design/optimization-pipeline.md).
    /// Reaches the compiler as ZENA_OPT_LEVEL; setting that env var directly
    /// works too. Default: 1.
    #[arg(short = 'O', long = "opt-level")]
    opt_level: Option<String>,

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

        /// WIT file or directory declaring the component's world
        /// (component target only; passed through to the compiler)
        #[arg(long)]
        wit: Option<String>,

        /// Which world in the --wit document, when it declares several
        #[arg(long)]
        world: Option<String>,
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

        /// Allow the program to spawn host processes via zena:process and
        /// run other Wasm modules via zena:wasm (a deliberate sandbox
        /// escape; ZENA_ALLOW_SPAWN=1 also works)
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

        /// Skip test files matching a glob, repeatable. For holding back
        /// a test that a known bug stops from compiling, where the
        /// alternative is excluding it somewhere the exclusion cannot be
        /// seen from the test.
        #[arg(long = "exclude")]
        exclude: Vec<String>,

        /// Run exactly one test file in-process and exit with its status
        /// (worker mode used by the Zena test orchestrator)
        #[arg(long, hide = true)]
        single: bool,
    },
    /// Extract a package's API documentation as JSON. The path is a
    /// package directory, any directory, or a single .zena file. See
    /// docs/design/zenadoc.md.
    Doc {
        /// Package directory, directory, or .zena file to document
        path: String,

        /// Where to write the JSON (default: stdout)
        #[arg(short, long)]
        output: Option<String>,

        /// Package name, overriding the manifest's or the directory's
        #[arg(long)]
        name: Option<String>,

        /// Compilation target, which decides virtual modules' entry files
        #[arg(short = 't', long, default_value = "zena-cli")]
        target: String,

        /// Document non-exported declarations and #private members
        #[arg(long = "include-private")]
        include_private: bool,
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

/// The -O flag's value, readable from the cache-key and guest-env sites
/// without threading another parameter through every compile signature.
/// Set once in main; the ZENA_OPT_LEVEL env var is the fallback.
static OPT_LEVEL_FLAG: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn effective_opt_level() -> Option<String> {
    OPT_LEVEL_FLAG
        .get()
        .cloned()
        .or_else(|| std::env::var("ZENA_OPT_LEVEL").ok())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(level) = &cli.opt_level {
        let _ = OPT_LEVEL_FLAG.set(level.clone());
    }
    match cli.command {
        Commands::Build { file, output, time, no_cache, target, wit, world } => {
            build_file(&file, &output, cli.verbose, time, no_cache, cli.debug, target.as_deref(), wit.as_deref(), world.as_deref())
        }
        Commands::Run { file, invoke, dirs, time, no_cache, allow_spawn, args } => {
            let allow_spawn = zena_runtime::spawn_allowed(allow_spawn);
            if file.ends_with(".wasm") {
                run_wasm(&file, &invoke, cli.verbose, &dirs, &args, cli.debug, allow_spawn)
            } else {
                compile_and_run(&file, &invoke, cli.verbose, time, no_cache, &dirs, &args, cli.debug, allow_spawn)
            }
        }
        Commands::Test { paths, filter, exclude, single } => {
            if single {
                run_single_test_worker(&paths, cli.verbose, cli.debug)
            } else {
                run_all_tests(&paths, filter.as_deref(), &exclude, cli.verbose, cli.debug)
            }
        }
        Commands::Doc { path, output, name, target, include_private } => {
            run_doc(&path, output.as_deref(), name.as_deref(), &target,
                include_private, cli.verbose, cli.debug)
        }
        Commands::Precompile { file } => precompile_file(&file, cli.debug),
        Commands::Bench { config, out } => {
            bench::run_bench(&config, out.as_deref(), cli.verbose, cli.debug)
        }
        Commands::Sample { file, invoke, n } => bench::run_sample(&file, &invoke, n, cli.verbose, cli.debug),
    }
}

fn precompile_file(file: &str, debug: bool) -> Result<()> {
    let engine = Engine::new(&zena_runtime::engine::config(debug))?;
    let cwasm_path = zena_runtime::cache::precompile(&engine, Path::new(file), debug)?;
    println!("Precompiled {}", cwasm_path.display());
    Ok(())
}

fn build_file(file: &str, output: &str, verbose: bool, time: bool, _no_cache: bool, debug: bool, target: Option<&str>, wit: Option<&str>, world: Option<&str>) -> Result<()> {
    // `build` is an explicit request to compile: invoking it at all expresses
    // the staleness decision, and the build scripts that call it are gated by
    // Wireit's own input tracking. Always compile rather than second-guessing
    // with mtime heuristics.
    let wat = output.ends_with(".wat");
    let cached_wasm_path = compile_to_cache(file, verbose, time, false, false, true, debug, target, wat, wit, world)?;
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
    let cached_wasm_path = compile_to_cache(file, verbose, time, false, !verbose, no_cache, debug, None, false, None, None)?;
    run_wasm(cached_wasm_path.to_str().unwrap(), invoke, verbose, dirs, args, debug, allow_spawn)
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

/// Checks whether a cached wasm artifact is missing, empty (0-byte), or older
/// than either the source file or the compiler wasm.
fn cache_is_stale(
    cached_path: &Path,
    source_path: &Path,
    compiler_wasm: &Path,
    no_cache: bool,
    verbose: bool,
    file_label: &str,
) -> bool {
    if no_cache {
        return true;
    }
    let metadata = match std::fs::metadata(cached_path) {
        Ok(m) => m,
        Err(_) => {
            if verbose {
                println!(
                    "CACHE CHECK [{}]: cached_wasm_path does not exist: {:?}",
                    file_label, cached_path
                );
            }
            return true;
        }
    };
    if metadata.len() == 0 {
        if verbose {
            println!(
                "CACHE CHECK [{}]: cached file is 0 bytes: {:?}",
                file_label, cached_path
            );
        }
        return true;
    }
    let source_mod = std::fs::metadata(source_path).and_then(|m| m.modified()).ok();
    let compiler_mod = std::fs::metadata(compiler_wasm).and_then(|m| m.modified()).ok();
    let cached_mod = metadata.modified().ok();
    if verbose {
        println!(
            "CACHE CHECK [{}]: source={:?}, compiler={:?}, cached={:?}",
            file_label, source_mod, compiler_mod, cached_mod
        );
    }
    match (source_mod, compiler_mod, cached_mod) {
        (Some(s), Some(c), Some(ch)) => s > ch || c > ch,
        _ => true,
    }
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
    wat: bool,
    wit: Option<&str>,
    world: Option<&str>,
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
    wat.hash(&mut hasher);
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
    // The optimization level changes emitted bytes (flag or env form).
    effective_opt_level().unwrap_or_default().hash(&mut hasher);

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
    // A `.wat` output asks the compiler for the text form; the extension
    // is how the compiler-side CLI picks the emitter, so it carries
    // through the cache artifact name (and keys the hash below).
    let cached_wasm_name = if wat {
        format!("{}_{:x}.wat", file_name, hash)
    } else {
        format!("{}_{:x}.wasm", file_name, hash)
    };
    let cached_wasm_path = cache_dir.join(&cached_wasm_name);

    if !cache_is_stale(
        &cached_wasm_path,
        &abs_path,
        &compiler_wasm,
        no_cache,
        verbose,
        file,
    ) {
        return Ok(cached_wasm_path);
    }

    // Compile holding a file lock to serialize concurrent compiles of the
    // same target artifact.
    let lock_path = cached_wasm_path.with_extension("lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)?;
    lock_file.lock()?;

    // Re-check staleness under the lock: another process may have finished
    // writing the file while we waited for the lock.
    if !cache_is_stale(
        &cached_wasm_path,
        &abs_path,
        &compiler_wasm,
        no_cache,
        verbose,
        file,
    ) {
        return Ok(cached_wasm_path);
    }

    let engine = Engine::new(&zena_runtime::engine::config(debug))?;
    let cwasm_path = cwasm_path_for(&compiler_wasm, debug);
    let compiler_module = load_or_compile_module(&engine, &compiler_wasm, &cwasm_path)?;

    let mut linker: Linker<HostState> = Linker::new(&engine);
    zena_runtime::add_to_linker(&mut linker, &engine, &compiler_module, Spawn::Deny)?;

    let stdlib_dir = repo_root.join("packages/stdlib/zena");

    let file_arg = rel_path.to_string_lossy().to_string();

    // Direct compilation output to a temporary file, then atomically rename it
    // into place. This prevents concurrent readers from observing a partial or
    // 0-byte file while the compiler runs.
    let temp_name = if wat {
        format!("{}_{:x}.tmp-{}.wat", file_name, hash, std::process::id())
    } else {
        format!("{}_{:x}.tmp-{}.wasm", file_name, hash, std::process::id())
    };
    let temp_path = cache_dir.join(&temp_name);
    let out_path_arg = temp_path.to_string_lossy().to_string();

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
    // The declared world: the guest resolves both through the `.`
    // preopen, so pass them repo-relative like the source file.
    if let Some(wit) = wit {
        compiler_args.push("--wit".to_string());
        compiler_args.push(wit.to_string());
    }
    if let Some(world) = world {
        compiler_args.push("--world".to_string());
        compiler_args.push(world.to_string());
    }

    if temp_path.exists() {
        std::fs::remove_file(&temp_path).ok();
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

    // `-g` asks for a debuggable module: the compiler emits a name section
    // only when told to, so traps symbolize instead of printing
    // wasm-function[N]. Passed as an env var rather than an argv flag
    // because the checked-in bootstrap compiler predates the flag and would
    // mistake an unknown `-g` for the input filename; an unknown env var it
    // simply ignores. `debug` already keys the compile cache above.
    if debug {
        wasi_builder.env("ZENA_DEBUG_NAMES", "1");
    }
    // -O travels the same way as -g and for the same reason; the env-var
    // form reaches the guest through inherit_env below.
    if let Some(level) = OPT_LEVEL_FLAG.get() {
        wasi_builder.env("ZENA_OPT_LEVEL", level);
    }

        let wasi = wasi_builder
            .inherit_env()
            .args(&compiler_args)
            .preopened_dir(repo_root, ".", FsPerms::ReadWrite)?
            .preopened_dir(stdlib_dir, "/stdlib", FsPerms::ReadWrite)?
            // Give the guest write access directly to the user's absolute cache directory
            .preopened_dir(
                &cache_dir,
                cache_dir.to_str().unwrap(),
                FsPerms::ReadWrite,
            )?
            .build_p1();

        let mut store = Store::new(&engine, HostState { wasi });
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
            std::fs::remove_file(&temp_path).ok();
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

        if !temp_path.exists() {
            anyhow::bail!(
                "Compiler did not emit expected WebAssembly file to {}.",
                temp_path.display()
            );
        }

        if let Err(e) = std::fs::rename(&temp_path, &cached_wasm_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(e.into());
        }

    Ok(cached_wasm_path)
}

fn run_wasm(file: &str, invoke: &str, _verbose: bool, dirs: &[String], args: &[String], debug: bool, allow_spawn: bool) -> Result<()> {
    let engine = Engine::new(&zena_runtime::engine::config(debug))?;
    let module = zena_runtime::cache::load_module(&engine, Path::new(file), debug)?;

    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder.inherit_stdio().inherit_env();

    // The arguments vector expects the first argument to be the program name (e.g., standard convention)
    let mut guest_args = vec![file.to_string()];
    guest_args.extend_from_slice(args);
    wasi_builder.args(&guest_args);

    let repo_root = repo_root()?;

    let mut path_map: zena_runtime::PathMap = Vec::new();
    for dir in dirs {
        let DirMapping { host: host_dir, guest: guest_dir } = DirMapping::parse(dir);
        let host_path = Path::new(&host_dir);
        let host_dir_adjusted = if (std::env::var("ZENA_PROJECT_CACHE").is_ok()
            || std::env::var("ZENA_LOCAL_CACHE").is_ok())
            && host_path.starts_with("/tmp")
        {
            let relative_to_tmp = host_path.strip_prefix("/tmp").unwrap();
            let new_host_path = repo_root.join(".zena/tmp").join(relative_to_tmp);
            std::fs::create_dir_all(&new_host_path)?;
            new_host_path
        } else {
            std::path::PathBuf::from(&host_dir)
        };
        let host_dir_adjusted = std::fs::canonicalize(host_dir_adjusted)?;

        wasi_builder.preopened_dir(&host_dir_adjusted, &guest_dir, FsPerms::ReadWrite)?;
        path_map.push((guest_dir, host_dir_adjusted));
    }
    let spawn = if allow_spawn { Spawn::Allow(zena_runtime::Grant { path_map, debug }) } else { Spawn::Deny };
    let mut linker: Linker<HostState> = Linker::new(&engine);
    zena_runtime::add_to_linker(&mut linker, &engine, &module, spawn)?;

    let wasi = wasi_builder.build_p1();

    let mut store = Store::new(&engine, HostState { wasi });
    reserve_gc_heap(&engine, &mut store)?;

    let instance = linker.instantiate(&mut store, &module).inspect_err(|e| {
        eprintln!("Instantiation failed!");
        zena_runtime::report_trap(e);
    })?;

    match zena_runtime::call_export(&mut store, &instance, invoke) {
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

#[derive(Debug, PartialEq, Eq)]
enum TestStatus {
    Pass,
    Fail,
}

fn run_all_tests(
    paths: &[String],
    filter: Option<&str>,
    exclude: &[String],
    verbose: bool,
    debug: bool,
) -> Result<()> {
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

    if !exclude.is_empty() {
        let patterns = exclude
            .iter()
            .map(|p| {
                glob::Pattern::new(p)
                    .with_context(|| format!("Invalid --exclude pattern '{p}'"))
            })
            .collect::<Result<Vec<_>>>()?;
        let before = test_files.len();
        test_files.retain(|p| !patterns.iter().any(|pat| pat.matches_path(p)));
        let skipped = before - test_files.len();
        if skipped > 0 {
            println!("Excluding {skipped} test file(s) by --exclude");
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
    let engine = Engine::new(&zena_runtime::engine::config(debug))?;
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

/// `zena doc`: runs the zenadoc extractor over a package and writes its
/// API as JSON.
///
/// The extractor runs with the repository root as its working directory,
/// like the other Zena-side tools, so the input path is passed
/// repo-relative when it is inside the checkout — that is also what makes
/// the `root` and `file` paths in the JSON repo-relative, so the output
/// can be checked in. An output path is made absolute instead, because it
/// is relative to wherever the user ran the command.
fn run_doc(
    path: &str,
    output: Option<&str>,
    name: Option<&str>,
    target: &str,
    include_private: bool,
    verbose: bool,
    debug: bool,
) -> Result<()> {
    let absolute = std::fs::canonicalize(path)
        .with_context(|| format!("No such path: {path}"))?;
    let repo_root = repo_root()?;
    let input = match absolute.strip_prefix(&repo_root) {
        Ok(relative) => relative.to_string_lossy().into_owned(),
        Err(_) => absolute.to_string_lossy().into_owned(),
    };

    let mut guest_args = vec![input, "--target".to_string(), target.to_string()];
    if let Some(output) = output {
        let output = std::path::absolute(output)?;
        guest_args.push("-o".to_string());
        guest_args.push(output.to_string_lossy().into_owned());
    }
    if let Some(name) = name {
        guest_args.push("--name".to_string());
        guest_args.push(name.to_string());
    }
    if include_private {
        guest_args.push("--include-private".to_string());
    }

    let code = run_internal_tool(
        "packages/zenadoc/zena/cli/main.zena",
        &guest_args,
        verbose,
        debug,
    )?;
    if code != 0 {
        // The JSON is written either way; a non-zero exit says the package
        // did not check clean.
        std::process::exit(code);
    }
    Ok(())
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
    let cached = compile_to_cache(&src.to_string_lossy(), verbose, false, false, true, false, debug, None, false, None, None)?;
    let engine = Engine::new(&zena_runtime::engine::config(debug))?;
    let cwasm = cwasm_path_for(&cached, debug);
    let module = load_or_compile_module(&engine, &cached, &cwasm)?;

    let mut linker: Linker<HostState> = Linker::new(&engine);
    zena_runtime::add_to_linker(&mut linker, &engine, &module, Spawn::Allow(zena_runtime::Grant {
        path_map: vec![
            (".".to_string(), repo_root()?),
            ("/".to_string(), std::path::PathBuf::from("/")),
        ],
        debug,
    }))?;

    let mut args = vec![src_repo_rel.to_string()];
    args.extend_from_slice(guest_args);
    let repo_root = repo_root()?;
    let wasi = WasiCtxBuilder::new()
        .inherit_stdio()
        .inherit_env()
        .args(&args)
        .preopened_dir(&repo_root, ".", FsPerms::ReadWrite)?
        .preopened_dir("/", "/", FsPerms::ReadWrite)?
        .build_p1();
    let mut store = Store::new(&engine, HostState { wasi });
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
    let cached_wasm_path = compile_to_cache(&test_file.to_string_lossy(), verbose, false, true, true, false, debug, None, false, None, None)?;
    let t_compile = t_start.elapsed();

    let t_load_start = std::time::Instant::now();
    // Run using wasmtime
    let wasm_path = Path::new(&cached_wasm_path);
    let module = zena_runtime::cache::load_module(engine, wasm_path, debug)?;
    let t_load = t_load_start.elapsed();

    let t_inst_start = std::time::Instant::now();
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

    // Repo tests are trusted code (they already get full repo preopens).
    // The path map mirrors the preopens below so spawn cwds translate
    // to host paths — the guest's /tmp is not the host's /tmp when the
    // cache env vars redirect it (and never is on macOS).
    let mut linker: Linker<HostState> = Linker::new(engine);
    zena_runtime::add_to_linker(&mut linker, engine, &module, Spawn::Allow(zena_runtime::Grant {
        path_map: vec![
            (".".to_string(), repo_root.clone()),
            ("/stdlib".to_string(), stdlib_dir.clone()),
            ("/tmp".to_string(), tmp_host_dir.clone()),
        ],
        debug,
    }))?;

    let wasi = WasiCtxBuilder::new()
        .stdout(stdout_pipe.clone())
        .stderr(stderr_pipe.clone())
        .inherit_env()
        .args(&[test_file.to_string_lossy().to_string()])
        .preopened_dir(&repo_root, ".", FsPerms::ReadWrite)?
        .preopened_dir(&stdlib_dir, "/stdlib", FsPerms::ReadWrite)?
        .preopened_dir(&tmp_host_dir, "/tmp", FsPerms::ReadWrite)?
        .build_p1();

    let mut store = Store::new(engine, HostState { wasi });

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

    #[test]
    fn test_cache_is_stale() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("zena-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let src = dir.join("src.zena");
        let compiler = dir.join("compiler.wasm");
        let cached = dir.join("cached.wasm");

        std::fs::write(&src, b"let x = 1;")?;
        std::fs::write(&compiler, b"compiler")?;

        // Cached does not exist -> stale
        assert!(cache_is_stale(&cached, &src, &compiler, false, false, "test"));

        // Cached is 0 bytes -> stale
        std::fs::write(&cached, b"")?;
        assert!(cache_is_stale(&cached, &src, &compiler, false, false, "test"));

        // Cached has content and is newer -> fresh
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&cached, b"\0asm")?;
        assert!(!cache_is_stale(&cached, &src, &compiler, false, false, "test"));

        // no_cache forces stale
        assert!(cache_is_stale(&cached, &src, &compiler, true, false, "test"));

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
