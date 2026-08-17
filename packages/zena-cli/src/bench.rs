//! `zena-cli bench` — cross-binary benchmark orchestration.
//!
//! Orchestration and statistics both live in Zena: `bench-run.zena`
//! parses the config, runs the round-robin sampling loop over
//! `zena:process`, analyzes with `zena:bench`, and writes the report.
//! The host contributes only what WASI cannot do itself:
//!
//! - the `zena_process` capability (process spawning; src/process.rs),
//! - the hidden `sample` worker below, which instantiates a wasm/wat/
//!   zena-compiled module fresh per sample and times one exported call
//!   (instantiation excluded), printing one milliseconds value per line.
//!
//! Sample semantics per variant kind (implemented in bench-run.zena):
//! - `zena` / `wasm` / `wat`: one `sample` worker run per sample.
//! - `command`: one process run per sample; the process self-reports its
//!   measurement (last non-empty stdout line parsing as float ms), with
//!   wall time as a called-out fallback that includes startup.

use super::*;

pub(crate) fn run_bench(
    config_path: &str,
    out: Option<&str>,
    verbose: bool,
    debug: bool,
) -> Result<()> {
    let config_abs = std::fs::canonicalize(config_path)
        .with_context(|| format!("bench config not found: {config_path}"))?;
    let self_exe = std::env::current_exe()?;
    let guest_args = vec![
        config_abs.to_string_lossy().into_owned(),
        out.unwrap_or("-").to_string(),
        self_exe.to_string_lossy().into_owned(),
        if debug { "1" } else { "0" }.to_string(),
    ];
    let code = run_internal_tool("packages/zena-cli/zena/bench-run.zena", &guest_args, verbose, debug)?;
    anyhow::ensure!(code == 0, "bench-run exited with {code}");
    Ok(())
}

/// The `sample` worker: compile/load the module once, then `n` times
/// take one sample — fresh store + instance, timed region is the call
/// only — printing each sample's milliseconds on its own line.
pub(crate) fn run_sample(file: &str, invoke: &str, n: u32, verbose: bool, debug: bool) -> Result<()> {
    let engine = Engine::new(&base_config(debug))?;
    let module = if file.ends_with(".wat") {
        // .wat goes through the same cwasm cache as .wasm (wasmtime's
        // precompile auto-detects text format) so all module variants
        // enter a sample process equally warm. `foo.wat` caches next to
        // itself as `foo.wat.cwasm` to avoid colliding with a sibling
        // `foo.wasm`'s cache.
        let ext = if debug { "wat.debug.cwasm" } else { "wat.cwasm" };
        let cwasm = Path::new(file).with_extension(ext);
        load_or_compile_module(&engine, Path::new(file), &cwasm)?
    } else if file.ends_with(".wasm") {
        let cwasm = cwasm_path_for(Path::new(file), debug);
        load_or_compile_module(&engine, Path::new(file), &cwasm)?
    } else {
        let cached = compile_to_cache(file, verbose, false, false, true, false, debug, None, false, None, None)?;
        let cwasm = cwasm_path_for(&cached, debug);
        load_or_compile_module(&engine, &cached, &cwasm)?
    };
    for _ in 0..n {
        let ms = sample_wasm(&engine, &module, invoke, debug)?;
        println!("{ms:.6}");
    }
    Ok(())
}

/// One sample: fresh store + instance, timed region is the call only.
fn sample_wasm(engine: &Engine, module: &Module, invoke: &str, _debug: bool) -> Result<f64> {
    let mut linker: Linker<MyState> = Linker::new(engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;
    add_stack_trace_helpers(&mut linker, engine, module)?;
    // Measured variants are workloads, not orchestrators: no spawning.
    process::add_process_imports(&mut linker, module, false)?;

    let stdout_pipe = MemoryOutputPipe::new(64 * 1024);
    let stderr_pipe = MemoryOutputPipe::new(64 * 1024);
    let wasi = WasiCtxBuilder::new()
        .stdout(stdout_pipe)
        .stderr(stderr_pipe)
        .args(&["bench-variant".to_string()])
        .build_p1();
    let mut store = Store::new(engine, MyState { wasi });
    reserve_gc_heap(engine, &mut store)?;

    let instance = linker.instantiate(&mut store, module)?;
    let func = instance
        .get_func(&mut store, invoke)
        .with_context(|| format!("failed to find `{invoke}` export"))?;
    let results_count = func.ty(&store).results().len();
    let mut results = vec![Val::I32(0); results_count];

    let t = std::time::Instant::now();
    func.call(&mut store, &[], &mut results)?;
    Ok(t.elapsed().as_secs_f64() * 1000.0)
}
