//! Host side of the `zena-cli` compilation target.
//!
//! A Zena program compiled for the `zena-cli` target is a WebAssembly
//! component that imports WASI 0.3 and the `zena-cli:host` interfaces
//! (`packages/stdlib/zena/host-wit/host.wit`): stack traces for `Error`,
//! process spawning behind `zena:process`, and running other programs
//! behind `zena:wasm`. This crate implements all of that on wasmtime
//! ([`component`]), plus the engine configuration such a component needs
//! ([`engine`]) and a cache of ahead-of-time compiled components and
//! core modules so repeated runs skip Cranelift ([`cache`]). A core
//! module — a `freestanding` Zena build, hand-written `.wat`, another
//! language's `wasm32-unknown-unknown` output — runs with no imports
//! ([`core_module`]).
//!
//! It is the Rust counterpart of `packages/runtime`, which does the same
//! job for the `js` target in JavaScript. Two binaries embed it:
//! `zena-run`, a small wrapper that runs one compiled component, and
//! `zena-cli`, which runs the `zena` command's own component, the CLI
//! module.
//!
//! Typical use:
//!
//! ```no_run
//! # fn main() -> anyhow::Result<()> {
//! use wasmtime::Store;
//! use zena_runtime::component::ComponentState;
//!
//! let engine = zena_runtime::engine::shared_component_engine(false)?;
//! let component =
//!     zena_runtime::cache::load_component_variant(&engine, "prog.wasm".as_ref(), false, false)?;
//! let linker = zena_runtime::component::linker(&engine)?;
//! let wasi = wasmtime_wasi::WasiCtxBuilder::new().inherit_stdio().build();
//! let mut store = Store::new(&engine, ComponentState::new(&engine, wasi, None));
//! zena_runtime::component::run_main(&mut store, &linker, &component, "main")?;
//! # Ok(()) }
//! ```

pub mod cache;
pub mod component;
pub mod core_module;
pub mod engine;

/// Whether this invocation may spawn processes and run components. The
/// `--allow-spawn` flag comes through here so that ZENA_ALLOW_SPAWN=1
/// grants it too.
pub fn spawn_allowed(flag: bool) -> bool {
    flag || std::env::var("ZENA_ALLOW_SPAWN").is_ok_and(|v| v == "1")
}

/// Guest-to-host directory mappings, mirroring the invocation's WASI
/// preopens. The guest names paths by its preopen layout ('.', '/tmp'),
/// but children spawn on the host, where those directories may live
/// elsewhere (a sandboxed temp dir, the repo root) — so a spawn cwd
/// must be translated before it reaches the OS.
pub type PathMap = Vec<(String, std::path::PathBuf)>;

/// What a component granted spawning needs to use the grant. Both
/// `zena:process` and `zena:wasm` leave the WASI sandbox, so they are
/// granted together, per instantiation; without a grant their imports
/// trap with an explanation.
pub struct Grant {
    /// The guest-to-host directory map, mirroring the component's
    /// preopens. It translates a directory the guest names (a spawn's
    /// working directory, a component's path, a directory handed to a
    /// run) into a host path. See [`PathMap`].
    pub path_map: PathMap,
    /// Whether the engine is the debug configuration. A component
    /// started through `zena:wasm` is cached under the matching
    /// `.cwasm` name; see [`cache`].
    pub debug: bool,
}

/// The exit status a guest asked for through WASI's `exit` (Zena's
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
