//! Wasmtime engine configuration for compiled Zena modules.

use anyhow::Result;
use wasmtime::{Collector, Config, Engine, Inlining, Linker, Module, Store};

use crate::HostState;

/// The wasmtime `Config` every Zena host uses.
///
/// Zena's output needs GC, exception handling, typed function references
/// and tail calls (`return_call` for `tail return`, see
/// docs/design/tail-calls.md). Since wasmtime 48 all four are on by
/// default, so the only proposal enabled here is wide arithmetic, which the
/// compiler emits under ZENA_WIDE_ARITHMETIC=1 and wasmtime still treats as
/// opt-in. Backtrace details and inlining are off by default and turned on
/// here too. All engines that share cwasm artifacts must agree on these
/// settings: wasmtime refuses to deserialize a cwasm whose compile-affecting
/// flags differ, and the fallback is a silent multi-second in-process
/// recompile.
///
/// `debug` turns off Cranelift's inlining so backtraces name the function
/// that trapped; [`crate::cache`] keeps debug and release cwasm files
/// apart.
///
/// Two environment variables adjust the result: ZENA_PROFILE enables the
/// perf-map profiler, and ZENA_GC picks the collector (see
/// [`apply_gc_config`]).
pub fn config(debug: bool) -> Config {
    let mut config = Config::new();
    config.compiler_inlining(if debug { Inlining::No } else { Inlining::Yes });
    config.wasm_wide_arithmetic(true);
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);
    if std::env::var("ZENA_PROFILE").is_ok() {
        config.profiler(wasmtime::ProfilingStrategy::PerfMap);
    } else {
        config.native_unwind_info(false);
    }
    apply_gc_config(&mut config);
    config
}

/// How often an interruptible engine's epoch advances, and so the
/// resolution of a time limit.
pub const EPOCH_TICK: std::time::Duration = std::time::Duration::from_millis(10);

/// The epoch deadline of a store with no time limit.
///
/// Wasmtime stores `current_epoch + deadline` with a plain add, so the
/// deadline has to leave room for the epoch to grow; `u64::MAX` would
/// wrap to a deadline in the past. Half of it, at one tick per
/// [`EPOCH_TICK`], is out of reach.
pub const NO_DEADLINE: u64 = u64::MAX / 2;

/// The engine that runs modules with a time limit (`zena:wasm`'s
/// `withTimeout`), one per `debug` setting, created on first use.
///
/// It is [`config`] with epoch interruption on: compiled code checks the
/// engine's epoch at function entries and loop back edges, and a ticker
/// thread advances the epoch every [`EPOCH_TICK`]. Those checks cost
/// every call something, so only runs that ask for a limit use this
/// engine; every other module runs on an engine without them. Its
/// modules are cached under their own `.cwasm` name
/// ([`crate::cache::cwasm_path_for_variant`]), because wasmtime refuses a
/// `.cwasm` compiled with different settings.
///
/// Every store on it needs a deadline, or it traps at the first call:
/// set one with `store.set_epoch_deadline`, [`NO_DEADLINE`] for none.
pub fn interruptible_engine(debug: bool) -> Result<Engine> {
    let cell = if debug {
        &INTERRUPTIBLE_DEBUG
    } else {
        &INTERRUPTIBLE_RELEASE
    };
    if let Some(engine) = cell.get() {
        return Ok(engine.clone());
    }
    let mut config = config(debug);
    config.epoch_interruption(true);
    let created = Engine::new(&config)?;
    let mut started_here = false;
    let engine = cell
        .get_or_init(|| {
            started_here = true;
            created
        })
        .clone();
    // One ticker per engine, started by whichever thread created it.
    if started_here {
        let ticked = engine.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(EPOCH_TICK);
                ticked.increment_epoch();
            }
        });
    }
    Ok(engine)
}

static INTERRUPTIBLE_RELEASE: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();
static INTERRUPTIBLE_DEBUG: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();

/// Whether `engine` is one of the [`interruptible_engine`]s. A module run
/// from inside one runs on it too, and is cached under its name.
pub fn is_interruptible(engine: &Engine) -> bool {
    [&INTERRUPTIBLE_RELEASE, &INTERRUPTIBLE_DEBUG]
        .iter()
        .any(|cell| cell.get().is_some_and(|e| Engine::same(e, engine)))
}

/// Selects the wasmtime GC collector via the ZENA_GC env var
/// (null | drc | copying). Defaults to wasmtime's Auto.
pub fn apply_gc_config(config: &mut Config) {
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

/// How many MiB of GC heap headroom to reserve up front (see
/// [`reserve_gc_heap`]). Overridable via the ZENA_GC_RESERVE_MB env var;
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
pub fn reserve_gc_heap(engine: &Engine, store: &mut Store<HostState>) -> Result<()> {
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
    let instance = Linker::<HostState>::new(engine).instantiate(&mut *store, &module)?;
    let balloon = instance.get_typed_func::<i32, ()>(&mut *store, "balloon")?;
    let len = i32::try_from(mb * (1 << 20) / 8).unwrap();
    // A failure here only means less headroom, not incorrectness.
    let _ = balloon.call(&mut *store, len);
    Ok(())
}
