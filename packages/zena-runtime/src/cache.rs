//! A cache of ahead-of-time compiled modules (`.cwasm`) kept beside the
//! `.wasm` files they were compiled from, so a module pays for Cranelift
//! once rather than on every run.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use wasmtime::{Engine, Module};

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
/// selects [`crate::engine::interruptible_engine`]'s, whose compiled code
/// differs and so needs its own file.
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

/// Loads a module through its beside-the-file cwasm cache, compiling and
/// writing the cache entry first when it is missing or stale.
pub fn load_module(engine: &Engine, wasm_path: &Path, debug: bool) -> Result<Module> {
    load_or_compile_module(engine, wasm_path, &cwasm_path_for(wasm_path, debug))
}

/// [`load_module`], for either engine configuration; see
/// [`cwasm_path_for_variant`].
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

/// Compiles a module in memory, touching no cache files.
pub fn compile_uncached(engine: &Engine, wasm_path: &Path) -> Result<Module> {
    let bytes = std::fs::read(wasm_path)
        .with_context(|| format!("failed to read {}", wasm_path.display()))?;
    Module::new(engine, &bytes)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("failed to compile {}", wasm_path.display()))
}

/// Writes the cwasm for `wasm_path` (if missing or stale) and returns its
/// path.
pub fn precompile(engine: &Engine, wasm_path: &Path, debug: bool) -> Result<PathBuf> {
    let cwasm_path = cwasm_path_for(wasm_path, debug);
    load_or_compile_module(engine, wasm_path, &cwasm_path)?;
    Ok(cwasm_path)
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
/// The lock serializes concurrent compiles of the same module. Script
/// runners can launch many host processes at once against a stale cache
/// (e.g. a test fan-out right after the compiler was rebuilt), and each
/// Cranelift compile of the compiler module costs on the order of a GiB
/// of RSS. Let one process compile while the rest block on the lock and
/// then reuse its output. `should_compile` is re-checked under the lock:
/// another process may have refreshed the cache while we waited.
pub fn write_cwasm(
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

/// Loads `cwasm_path`, first (re)writing it from `wasm_path` when it is
/// stale or will not deserialize.
pub fn load_or_compile_module(
    engine: &Engine,
    wasm_path: &Path,
    cwasm_path: &Path,
) -> Result<Module> {
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
}
