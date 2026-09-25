//! Host side of the `zena-cli` compilation target.
//!
//! A Zena module compiled for the `zena-cli` target imports from its
//! host: WASI preview 1, two `env` functions that back `Error`'s stack
//! traces (`captureStackTrace`, `formatStackTrace`), and, when the
//! program uses them, the `zena_process` module behind `zena:process`
//! and the `zena_wasm` module behind `zena:wasm`, which runs other Wasm
//! modules. This crate implements all of that on wasmtime, plus the engine
//! configuration such a module needs (GC, exception handling, typed
//! function references, tail calls) and a cache of ahead-of-time
//! compiled modules so repeated runs skip Cranelift.
//!
//! It is the Rust counterpart of `packages/runtime`, which does the same
//! job for the `js` target in JavaScript. Two binaries embed it:
//! `zena-run`, a small wrapper that runs one compiled module, and
//! `zena-cli`, which runs the `zena` command's own module, the CLI
//! module.
//!
//! Typical use:
//!
//! ```no_run
//! # fn main() -> anyhow::Result<()> {
//! use wasmtime::{Engine, Linker, Store};
//! use zena_runtime::{HostState, Spawn};
//!
//! let engine = Engine::new(&zena_runtime::engine::config(false))?;
//! let module = zena_runtime::cache::load_module(&engine, "prog.wasm".as_ref(), false)?;
//! let mut linker: Linker<HostState> = Linker::new(&engine);
//! zena_runtime::add_to_linker(&mut linker, &engine, &module, Spawn::Deny)?;
//! let wasi = wasmtime_wasi::WasiCtxBuilder::new().inherit_stdio().build_p1();
//! let mut store = Store::new(&engine, HostState { wasi });
//! let instance = linker.instantiate(&mut store, &module)?;
//! zena_runtime::call_export(&mut store, &instance, "main")?;
//! # Ok(()) }
//! ```

use anyhow::Result;
use wasmtime::{Engine, Instance, Linker, Module, Store, Val};
use wasmtime_wasi::p1::{self, WasiP1Ctx};

pub mod cache;
pub mod engine;
pub mod process;
pub mod stack_trace;
pub mod strings;
pub mod wasm_runner;

pub use process::{PathMap, spawn_allowed};

/// The store data every linker in this crate expects: the WASI preview 1
/// context the guest's `wasi_snapshot_preview1` imports read and write.
pub struct HostState {
    pub wasi: WasiP1Ctx,
}

/// Whether the module may spawn host processes through `zena:process`
/// and run other Wasm modules through `zena:wasm`.
///
/// Both leave the WASI sandbox, so they are granted together, per
/// instantiation.
pub enum Spawn {
    /// Link every `zena_process` and `zena_wasm` import to a stub that
    /// traps with an explanation, so a program that uses neither still
    /// instantiates.
    Deny,
    Allow(Grant),
}

/// What a module granted [`Spawn::Allow`] needs to use the grant.
pub struct Grant {
    /// The guest-to-host directory map, mirroring the module's preopens.
    /// It translates a directory the guest names (a spawn's working
    /// directory, a module path, a directory handed to a run) into a
    /// host path. See [`PathMap`].
    pub path_map: PathMap,
    /// Whether the engine is the debug configuration
    /// ([`engine::config`]). A module started through `zena:wasm` is
    /// cached under the matching `.cwasm` name; see [`cache`].
    pub debug: bool,
}

/// Links everything a `zena-cli`-target module imports: WASI preview 1,
/// the `env` stack-trace functions, `zena_process` and `zena_wasm`.
pub fn add_to_linker(
    linker: &mut Linker<HostState>,
    engine: &Engine,
    module: &Module,
    spawn: Spawn,
) -> Result<()> {
    p1::add_to_linker_sync(linker, |state| &mut state.wasi)?;
    stack_trace::add_to_linker(linker, engine, module)?;
    let grant = match spawn {
        Spawn::Deny => None,
        Spawn::Allow(grant) => Some(grant),
    };
    let (allow, path_map) = match &grant {
        None => (false, Vec::new()),
        Some(grant) => (true, grant.path_map.clone()),
    };
    process::add_to_linker(linker, module, allow, path_map)?;
    wasm_runner::add_to_linker(linker, module, grant)?;
    Ok(())
}

/// Calls a nullary export and returns its results. The error stays a
/// `wasmtime::Error` so callers can still ask it for a backtrace
/// ([`report_trap`]) or the guest's exit status ([`exit_code`]); converting
/// it to `anyhow::Error` first would hide both.
pub fn call_export(
    store: &mut Store<HostState>,
    instance: &Instance,
    name: &str,
) -> Result<Vec<Val>, wasmtime::Error> {
    let func = instance
        .get_func(&mut *store, name)
        .ok_or_else(|| wasmtime::Error::msg(format!("failed to find `{name}` export")))?;
    let mut results = vec![Val::I32(0); func.ty(&*store).results().len()];
    func.call(&mut *store, &[], &mut results)?;
    Ok(results)
}

/// The exit status a guest asked for through WASI's `proc_exit` (Zena's
/// `exit(code)`), when that is what ended the call. Such an error is the
/// program's own result, and a host should exit with the same code.
pub fn exit_code(error: &wasmtime::Error) -> Option<i32> {
    error
        .downcast_ref::<wasmtime_wasi::I32Exit>()
        .map(|exit| exit.0)
}

/// Prints the wasm backtrace attached to an instantiation or call error,
/// if there is one, to stderr.
pub fn report_trap(error: &wasmtime::Error) {
    if let Some(bt) = error.downcast_ref::<wasmtime::WasmBacktrace>() {
        eprintln!("Wasm Backtrace:\n{bt}");
    }
}

/// Formats a scalar result the way `zena run` prints a program's return
/// value; reference results fall back to their debug form.
pub fn format_result(val: &Val) -> String {
    match val {
        Val::I32(i) => i.to_string(),
        Val::I64(i) => i.to_string(),
        Val::F32(f) => f32::from_bits(*f).to_string(),
        Val::F64(f) => f64::from_bits(*f).to_string(),
        other => format!("{other:?}"),
    }
}

/// One `--dir` argument in the wasmtime CLI's syntax: `HOST` or
/// `HOST::GUEST`, mapping a host directory to a guest path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirMapping {
    pub host: String,
    pub guest: String,
}

impl DirMapping {
    pub fn parse(arg: &str) -> DirMapping {
        match arg.split_once("::") {
            Some((host, guest)) => DirMapping {
                host: host.to_string(),
                guest: guest.to_string(),
            },
            None => DirMapping {
                host: arg.to_string(),
                guest: arg.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_mapping_parses_both_forms() {
        assert_eq!(
            DirMapping::parse("/tmp"),
            DirMapping {
                host: "/tmp".into(),
                guest: "/tmp".into()
            }
        );
        assert_eq!(
            DirMapping::parse(".::/work"),
            DirMapping {
                host: ".".into(),
                guest: "/work".into()
            }
        );
    }
}
