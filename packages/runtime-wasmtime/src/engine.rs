//! Wasmtime engine configuration for compiled Zena components.

use anyhow::Result;
use wasmtime::{Collector, Config, Engine, Inlining, Store};

/// The core-wasm part of the wasmtime `Config` every Zena host uses;
/// [`component_config`] adds the Component Model on top, and `zenafx`
/// adds its own component and graphics settings.
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
    } else if !cfg!(windows) {
        // Windows requires SEH unwind tables (`native_unwind_info`) for trap handling.
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

/// Whether `engine` is one of the [`interruptible_component_engine`]s. A
/// component run from inside one runs on it too, and is cached under its
/// name.
pub fn is_interruptible(engine: &Engine) -> bool {
    [
        &COMPONENT_INTERRUPTIBLE_RELEASE,
        &COMPONENT_INTERRUPTIBLE_DEBUG,
    ]
    .iter()
    .any(|cell| cell.get().is_some_and(|e| Engine::same(e, engine)))
}

/// The wasmtime `Config` every Zena host uses: [`config`] plus the
/// Component Model with its async ABI, since a Zena component's `main`
/// may be lifted async and its imports include streams and futures.
pub fn component_config(debug: bool) -> Config {
    let mut config = config(debug);
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    config
}

/// The engine every ordinary run shares, one per `debug` setting,
/// created on first use. A run started through `zena:wasm` with its
/// caller's debug setting shares the caller's engine; one with the
/// other setting takes the other engine.
pub fn shared_component_engine(debug: bool) -> Result<Engine> {
    let cell = if debug {
        &COMPONENT_SHARED_DEBUG
    } else {
        &COMPONENT_SHARED_RELEASE
    };
    if let Some(engine) = cell.get() {
        return Ok(engine.clone());
    }
    let created = Engine::new(&component_config(debug))?;
    Ok(cell.get_or_init(|| created).clone())
}

/// The engine that runs components with a time limit (`zena:wasm`'s
/// `timeout`), one per `debug` setting, created on first use.
///
/// It is [`component_config`] with epoch interruption on: compiled code
/// checks the engine's epoch at function entries and loop back edges,
/// and a ticker thread advances the epoch every [`EPOCH_TICK`]. Those
/// checks cost every call something, so only runs that ask for a limit
/// use this engine; every other component runs on an engine without
/// them. Its components are cached under their own `.cwasm` name
/// ([`crate::cache::cwasm_path_for_variant`]), because wasmtime refuses
/// a `.cwasm` compiled with different settings.
///
/// Every store on it needs a deadline, or it traps at the first call:
/// set one with `store.set_epoch_deadline`, [`NO_DEADLINE`] for none.
pub fn interruptible_component_engine(debug: bool) -> Result<Engine> {
    let cell = if debug {
        &COMPONENT_INTERRUPTIBLE_DEBUG
    } else {
        &COMPONENT_INTERRUPTIBLE_RELEASE
    };
    if let Some(engine) = cell.get() {
        return Ok(engine.clone());
    }
    let mut config = component_config(debug);
    config.epoch_interruption(true);
    let created = Engine::new(&config)?;
    let mut started_here = false;
    let engine = cell
        .get_or_init(|| {
            started_here = true;
            created
        })
        .clone();
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

static COMPONENT_SHARED_RELEASE: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();
static COMPONENT_SHARED_DEBUG: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();
static COMPONENT_INTERRUPTIBLE_RELEASE: std::sync::OnceLock<Engine> =
    std::sync::OnceLock::new();
static COMPONENT_INTERRUPTIBLE_DEBUG: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();

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

/// The reserve [`reserve_gc_heap_or`] gives the store that runs the
/// compiler when ZENA_GC_RESERVE_MB does not name one, in MiB.
///
/// Compiling a three-line program allocates about 120 MiB. With no
/// reserve the heap starts small and is collected at every doubling,
/// which was two thirds of that compile's 0.75 s; with this reserve
/// nothing is collected and it takes 0.25 s. A larger compile gains
/// less as its live set nears the reserve, and needs a larger one to
/// gain more, which the repository's build scripts set themselves.
///
/// `zena test` compiles in up to eight stores at once, each of which
/// can hold twice the reserve, so the size is a trade between their
/// time and their memory: the standard library's tests take 43 s and
/// 1.8 GiB with no reserve, 23 s and 2.9 GiB at 128, and 23 s and
/// 4.8 GiB at 256. The measurements are in
/// docs/design/compiler-memory.md, "The heap reserve".
pub const COMPILER_GC_RESERVE_MB: u64 = 128;

/// [`reserve_gc_heap_or`] with no reserve unless ZENA_GC_RESERVE_MB
/// names one: for a store that runs a program, which may be long-lived
/// and should not hold more garbage than it has to.
pub fn reserve_gc_heap<T>(store: &mut Store<T>) -> Result<()> {
    reserve_gc_heap_or(store, 0)
}

/// Grows the store's GC heap so that a collection has
/// ZENA_GC_RESERVE_MB of room to allocate in before the next one, or
/// `default_mb` when the variable is not set.
///
/// Wasmtime's copying collector grows the GC heap only when what
/// survived a collection, plus the allocation that asked for it, fills
/// half the heap. Until then it collects, so the heap stays just above
/// the live set and an allocation-heavy program, such as the compiler,
/// spends most of its time copying the same live objects. The heap
/// never shrinks, so growing it once up front leaves every later
/// collection that much headroom.
///
/// The heap is two equal semi-spaces and only one is allocated into at
/// a time, so the heap grows to twice the reserve. Growing reserves
/// address space; a page becomes resident when an allocation first
/// reaches it, so a program that allocates little pays nothing for a
/// large reserve.
pub fn reserve_gc_heap_or<T>(store: &mut Store<T>, default_mb: u64) -> Result<()> {
    let mb = match std::env::var(GC_RESERVE_VARIABLE) {
        Ok(value) => parse_reserve(&value)?,
        Err(_) => default_mb,
    };
    grow_gc_heap_for_reserve(store, mb)
}

/// [`reserve_gc_heap`] for a run started through `zena:wasm`, whose
/// environment is `env`: a ZENA_GC_RESERVE_MB the run was given decides,
/// and this process's does otherwise. So a program can give a run it
/// starts a reserve of its own, as `zena test` gives the copies of
/// itself that compile the test files.
pub fn reserve_gc_heap_for_run<T>(store: &mut Store<T>, env: &[(String, String)]) -> Result<()> {
    match env.iter().find(|(name, _)| name == GC_RESERVE_VARIABLE) {
        Some((_, value)) => grow_gc_heap_for_reserve(store, parse_reserve(value)?),
        None => reserve_gc_heap(store),
    }
}

const GC_RESERVE_VARIABLE: &str = "ZENA_GC_RESERVE_MB";

fn parse_reserve(value: &str) -> Result<u64> {
    value
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("{GC_RESERVE_VARIABLE} must be an integer, got {value:?}"))
}

fn grow_gc_heap_for_reserve<T>(store: &mut Store<T>, mb: u64) -> Result<()> {
    // The GC heap is an i32-indexed memory, so both semi-spaces
    // together stay under 4 GiB.
    let wanted = 2 * mb.min(1900) * (1 << 20);
    let capacity = store.gc_heap_capacity() as u64;
    if wanted > capacity {
        store.gc_heap_grow(wanted - capacity)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_configs_build_engines() -> Result<()> {
        Engine::new(&config(false))?;
        Engine::new(&config(true))?;
        Engine::new(&component_config(false))?;
        Engine::new(&component_config(true))?;
        Ok(())
    }

    #[test]
    fn a_reserve_grows_the_heap_to_twice_its_size() -> Result<()> {
        let engine = Engine::new(&config(false))?;
        let mut store = Store::new(&engine, ());
        grow_gc_heap_for_reserve(&mut store, 4)?;
        let grown = store.gc_heap_capacity();
        assert!(grown >= 8 << 20, "capacity {grown}");
        // A smaller reserve leaves the heap as it is.
        grow_gc_heap_for_reserve(&mut store, 1)?;
        assert_eq!(store.gc_heap_capacity(), grown);
        Ok(())
    }

    #[test]
    fn a_run_takes_the_reserve_its_environment_names() -> Result<()> {
        let engine = Engine::new(&config(false))?;
        let mut store = Store::new(&engine, ());
        let env = vec![(GC_RESERVE_VARIABLE.to_string(), "4".to_string())];
        reserve_gc_heap_for_run(&mut store, &env)?;
        assert!(store.gc_heap_capacity() >= 8 << 20);
        let bad = vec![(GC_RESERVE_VARIABLE.to_string(), "lots".to_string())];
        assert!(reserve_gc_heap_for_run(&mut store, &bad).is_err());
        Ok(())
    }
}
