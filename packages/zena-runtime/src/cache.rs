//! A cache of ahead-of-time compiled components and core modules
//! (`.cwasm`) kept beside the `.wasm` or `.wat` files they were compiled
//! from, so each pays for Cranelift once rather than on every run.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use wasmtime::component::Component;
use wasmtime::{Engine, Module};

/// Which kind of WebAssembly a file holds; they compile and serialize
/// through different wasmtime entry points.
#[derive(Clone, Copy)]
pub enum Kind {
    Component,
    CoreModule,
}

/// The cwasm path for a wasm (or wat) file under the given config variant.
///
/// Debug (no-inlining) engines cannot reuse release cwasm and vice versa,
/// so each variant gets its own file instead of the two thrashing one
/// path. A `.wat` file caches as `foo.wat.cwasm` so it does not collide
/// with a sibling `foo.wasm`'s cache.
pub fn cwasm_path_for(wasm_path: &Path, debug: bool) -> PathBuf {
    cwasm_path_for_variant(wasm_path, debug, false)
}

/// [`cwasm_path_for`], for either engine configuration: `interruptible`
/// selects [`crate::engine::interruptible_component_engine`]'s, whose
/// compiled code differs and so needs its own file.
pub fn cwasm_path_for_variant(wasm_path: &Path, debug: bool, interruptible: bool) -> PathBuf {
    let mut suffix = String::new();
    if wasm_path.extension().is_some_and(|e| e == "wat") {
        suffix.push_str("wat.");
    }
    if interruptible {
        suffix.push_str("interruptible.");
    }
    if debug {
        suffix.push_str("debug.");
    }
    suffix.push_str("cwasm");
    wasm_path.with_extension(suffix)
}

/// True when the cached cwasm is missing or older than its source wasm.
pub fn cwasm_is_stale(wasm_path: &Path, cwasm_path: &Path) -> bool {
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
/// The lock serializes concurrent compiles of the same component. Script
/// runners can launch many host processes at once against a stale cache
/// (e.g. a test fan-out right after the compiler was rebuilt), and each
/// Cranelift compile of the compiler costs on the order of a GiB of
/// RSS. Let one process compile while the rest block on the lock and
/// then reuse its output. `should_compile` is re-checked under the lock:
/// another process may have refreshed the cache while we waited.
pub fn write_cwasm(
    engine: &Engine,
    wasm_path: &Path,
    cwasm_path: &Path,
    kind: Kind,
    mut should_compile: impl FnMut() -> bool,
) -> Result<()> {
    let lock_path = cwasm_path.with_extension("lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)?;
    lock_file.lock()?;
    if should_compile() {
        let wasm_bytes = std::fs::read(wasm_path)?;
        let serialized = match kind {
            Kind::Component => engine.precompile_component(&wasm_bytes)?,
            Kind::CoreModule => engine.precompile_module(&wasm_bytes)?,
        };
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

/// Loads a component through its beside-the-file cwasm cache, compiling
/// and writing the cache entry first when it is missing or stale;
/// `interruptible` and `debug` pick the cache file, see
/// [`cwasm_path_for_variant`].
pub fn load_component_variant(
    engine: &Engine,
    wasm_path: &Path,
    debug: bool,
    interruptible: bool,
) -> Result<Component> {
    load_or_compile_component(
        engine,
        wasm_path,
        &cwasm_path_for_variant(wasm_path, debug, interruptible),
    )
}

/// Writes the cwasm for the component at `wasm_path` (if missing or
/// stale) and returns its path.
pub fn precompile_component(engine: &Engine, wasm_path: &Path, debug: bool) -> Result<PathBuf> {
    let cwasm_path = cwasm_path_for(wasm_path, debug);
    load_or_compile_component(engine, wasm_path, &cwasm_path)?;
    let _ = std::fs::remove_file(cwasm_path.with_extension("lock"));
    Ok(cwasm_path)
}

/// Compiles a component in memory, touching no cache files.
pub fn compile_component_uncached(engine: &Engine, wasm_path: &Path) -> Result<Component> {
    let bytes = std::fs::read(wasm_path)
        .with_context(|| format!("failed to read {}", wasm_path.display()))?;
    Component::new(engine, &bytes)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("failed to compile {}", wasm_path.display()))
}

/// Loads `cwasm_path`, first (re)writing it from `wasm_path` when it is
/// stale or will not deserialize. A fresh-looking cwasm that will not
/// deserialize was produced by an incompatible engine (different
/// wasmtime version, config, or host CPU features); it is recompiled in
/// place, and concurrent callers try deserializing again under the file
/// lock so only the first one compiles.
pub fn load_or_compile_component(
    engine: &Engine,
    wasm_path: &Path,
    cwasm_path: &Path,
) -> Result<Component> {
    load_or_compile(
        engine,
        wasm_path,
        cwasm_path,
        Kind::Component,
        |e, p| unsafe { Component::deserialize_file(e, p) }.map_err(anyhow::Error::from),
        compile_component_uncached,
    )
}

/// [`load_component_variant`], for a core module.
pub fn load_module_variant(
    engine: &Engine,
    wasm_path: &Path,
    debug: bool,
    interruptible: bool,
) -> Result<Module> {
    load_or_compile_module(
        engine,
        wasm_path,
        &cwasm_path_for_variant(wasm_path, debug, interruptible),
    )
}

/// [`precompile_component`], for a core module.
pub fn precompile_module(engine: &Engine, wasm_path: &Path, debug: bool) -> Result<PathBuf> {
    let cwasm_path = cwasm_path_for(wasm_path, debug);
    load_or_compile_module(engine, wasm_path, &cwasm_path)?;
    let _ = std::fs::remove_file(cwasm_path.with_extension("lock"));
    Ok(cwasm_path)
}

/// [`compile_component_uncached`], for a core module.
pub fn compile_module_uncached(engine: &Engine, wasm_path: &Path) -> Result<Module> {
    let bytes = std::fs::read(wasm_path)
        .with_context(|| format!("failed to read {}", wasm_path.display()))?;
    Module::new(engine, &bytes)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("failed to compile {}", wasm_path.display()))
}

/// [`load_or_compile_component`], for a core module.
pub fn load_or_compile_module(
    engine: &Engine,
    wasm_path: &Path,
    cwasm_path: &Path,
) -> Result<Module> {
    load_or_compile(
        engine,
        wasm_path,
        cwasm_path,
        Kind::CoreModule,
        |e, p| unsafe { Module::deserialize_file(e, p) }.map_err(anyhow::Error::from),
        compile_module_uncached,
    )
}

fn load_or_compile<T>(
    engine: &Engine,
    wasm_path: &Path,
    cwasm_path: &Path,
    kind: Kind,
    deserialize: impl Fn(&Engine, &Path) -> Result<T>,
    compile_uncached: impl Fn(&Engine, &Path) -> Result<T>,
) -> Result<T> {
    if cwasm_is_stale(wasm_path, cwasm_path) {
        if let Err(e) = write_cwasm(engine, wasm_path, cwasm_path, kind, || {
            cwasm_is_stale(wasm_path, cwasm_path)
        }) {
            eprintln!(
                "WARNING: could not write {}: {e:#}; compiling in memory",
                cwasm_path.display()
            );
            return compile_uncached(engine, wasm_path);
        }
    }
    match deserialize(engine, cwasm_path) {
        Ok(loaded) => Ok(loaded),
        Err(first_err) => {
            let mut refreshed = None;
            if let Err(e) = write_cwasm(engine, wasm_path, cwasm_path, kind, || {
                match deserialize(engine, cwasm_path) {
                    Ok(loaded) => {
                        refreshed = Some(loaded);
                        false
                    }
                    Err(_) => {
                        eprintln!(
                            "WARNING: recompiling {}: deserialization failed: {:?}",
                            cwasm_path.display(),
                            first_err
                        );
                        true
                    }
                }
            }) {
                eprintln!(
                    "WARNING: could not rewrite {}: {e:#}; compiling in memory",
                    cwasm_path.display()
                );
                return compile_uncached(engine, wasm_path);
            }
            if let Some(loaded) = refreshed {
                return Ok(loaded);
            }
            match deserialize(engine, cwasm_path) {
                Ok(loaded) => Ok(loaded),
                Err(e) => {
                    eprintln!("WARNING: deserialization of cwasm failed again: {:?}", e);
                    compile_uncached(engine, wasm_path)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwasm_paths_keep_variants_apart() {
        let wasm = Path::new("out/prog.wasm");
        assert_eq!(cwasm_path_for(wasm, false), Path::new("out/prog.cwasm"));
        assert_eq!(
            cwasm_path_for(wasm, true),
            Path::new("out/prog.debug.cwasm")
        );
        let wat = Path::new("out/prog.wat");
        assert_eq!(cwasm_path_for(wat, false), Path::new("out/prog.wat.cwasm"));
        assert_eq!(
            cwasm_path_for(wat, true),
            Path::new("out/prog.wat.debug.cwasm")
        );
        // The interruptible engine compiles different code, so it never
        // shares a file with the ordinary one.
        assert_eq!(
            cwasm_path_for_variant(wasm, false, true),
            Path::new("out/prog.interruptible.cwasm")
        );
        assert_eq!(
            cwasm_path_for_variant(wat, true, true),
            Path::new("out/prog.wat.interruptible.debug.cwasm")
        );
    }

    #[test]
    fn stale_when_missing_or_older() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("zena-cwasm-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let wasm = dir.join("m.wasm");
        let cwasm = dir.join("m.cwasm");
        std::fs::write(&wasm, b"\0asm")?;
        assert!(cwasm_is_stale(&wasm, &cwasm));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&cwasm, b"cwasm")?;
        assert!(!cwasm_is_stale(&wasm, &cwasm));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&wasm, b"\0asm2")?;
        assert!(cwasm_is_stale(&wasm, &cwasm));
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn incompatible_component_cwasm_refreshed_under_lock_is_reused_without_recompiling()
    -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "zena-cwasm-component-recovery-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;

        let host_engine = crate::engine::shared_component_engine(false)?;
        let other_engine = crate::engine::shared_component_engine(true)?;
        let valid_cwasm = host_engine.precompile_component(b"(component)")?;
        let incompatible_cwasm = other_engine.precompile_component(b"(component)")?;

        let wasm = dir.join("m.wasm");
        let cwasm = dir.join("m.cwasm");
        // Unusable source bytes prove the waiting caller reuses the refreshed
        // .cwasm instead of running Cranelift a second time.
        std::fs::write(&wasm, b"not valid wasm")?;
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&cwasm, &incompatible_cwasm)?;
        assert!(!cwasm_is_stale(&wasm, &cwasm));

        let lock_file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(cwasm.with_extension("lock"))?;
        lock_file.lock()?;

        let engine = host_engine.clone();
        let wasm_for_worker = wasm.clone();
        let cwasm_for_worker = cwasm.clone();
        let worker = std::thread::spawn(move || {
            load_or_compile_component(&engine, &wasm_for_worker, &cwasm_for_worker)
        });

        // Give the worker time to fail the initial deserialize and block on .lock,
        // then replace .cwasm as the lock-holding process would.
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&cwasm, &valid_cwasm)?;
        drop(lock_file);

        let result = worker.join().expect("worker panicked");
        let _ = std::fs::remove_dir_all(&dir);
        result.map(|_| ())
    }

    #[test]
    fn incompatible_module_cwasm_refreshed_under_lock_is_reused_without_recompiling() -> Result<()>
    {
        let dir =
            std::env::temp_dir().join(format!("zena-cwasm-module-recovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;

        let host_engine = crate::engine::shared_component_engine(false)?;
        let other_engine = crate::engine::shared_component_engine(true)?;
        let valid_cwasm = host_engine.precompile_module(b"(module)")?;
        let incompatible_cwasm = other_engine.precompile_module(b"(module)")?;

        let wasm = dir.join("m.wasm");
        let cwasm = dir.join("m.cwasm");
        std::fs::write(&wasm, b"not valid wasm")?;
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&cwasm, &incompatible_cwasm)?;
        assert!(!cwasm_is_stale(&wasm, &cwasm));

        let lock_file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(cwasm.with_extension("lock"))?;
        lock_file.lock()?;

        let engine = host_engine.clone();
        let wasm_for_worker = wasm.clone();
        let cwasm_for_worker = cwasm.clone();
        let worker = std::thread::spawn(move || {
            load_or_compile_module(&engine, &wasm_for_worker, &cwasm_for_worker)
        });

        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&cwasm, &valid_cwasm)?;
        drop(lock_file);

        let result = worker.join().expect("worker panicked");
        let _ = std::fs::remove_dir_all(&dir);
        result.map(|_| ())
    }
}
