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

        /// Directories to pre-open
        #[arg(long = "dir")]
        dirs: Vec<String>,

        /// Arguments to pass to the Wasm program
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

struct MyState {
    wasi: WasiP1Ctx,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Build { file, output } => build_file(&file, &output, cli.verbose),
        Commands::Run { file, invoke, dirs, args } => {
            if file.ends_with(".wasm") {
                run_wasm(&file, &invoke, cli.verbose, &dirs, &args)
            } else {
                compile_and_run(&file, &invoke, cli.verbose, &dirs, &args)
            }
        }
    }
}

fn build_file(file: &str, output: &str, verbose: bool) -> Result<()> {
    let cached_wasm_path = compile_to_cache(file, verbose)?;
    std::fs::copy(&cached_wasm_path, output)?;
    Ok(())
}

fn compile_and_run(file: &str, invoke: &str, verbose: bool, dirs: &[String], args: &[String]) -> Result<()> {
    let cached_wasm_path = compile_to_cache(file, verbose)?;
    run_wasm(cached_wasm_path.to_str().unwrap(), invoke, verbose, dirs, args)
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
    add_stack_trace_helpers(&mut linker, &engine, &compiler_module)?;

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

    let needs_compile = if cached_wasm_path.exists() {
        let source_mod = std::fs::metadata(&abs_path).and_then(|m| m.modified()).ok();
        let compiler_mod = std::fs::metadata(&compiler_wasm).and_then(|m| m.modified()).ok();
        let cached_mod = std::fs::metadata(&cached_wasm_path).and_then(|m| m.modified()).ok();
        match (source_mod, compiler_mod, cached_mod) {
            (Some(s), Some(c), Some(ch)) => s > ch || c > ch,
            _ => true,
        }
    } else {
        true
    };

    if needs_compile {
        if cached_wasm_path.exists() {
            std::fs::remove_file(&cached_wasm_path).ok();
        }

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
    }

    Ok(cached_wasm_path)
}

fn run_wasm(file: &str, invoke: &str, _verbose: bool, dirs: &[String], args: &[String]) -> Result<()> {
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
    add_stack_trace_helpers(&mut linker, &engine, &module)?;

    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder.inherit_stdio().inherit_env();

    // The arguments vector expects the first argument to be the program name (e.g., standard convention)
    let mut guest_args = vec![file.to_string()];
    guest_args.extend_from_slice(args);
    wasi_builder.args(&guest_args);

    for dir in dirs {
        // Handle format `HOST_DIR::GUEST_DIR` standard in wasmtime CLI
        let parts: Vec<&str> = dir.split("::").collect();
        let (host_dir, guest_dir) = if parts.len() == 2 {
            (parts[0], parts[1])
        } else {
            (dir.as_str(), dir.as_str())
        };

        wasi_builder.preopened_dir(host_dir, guest_dir, DirPerms::all(), FilePerms::all())?;
    }

    let wasi = wasi_builder.build_p1();

    let mut store = Store::new(&engine, MyState { wasi });

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
        config.wasm_backtrace(true);
        config.wasm_gc(true);
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
