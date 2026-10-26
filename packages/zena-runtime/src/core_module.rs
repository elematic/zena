//! Running a core module: WebAssembly in the format that predates
//! components, such as a hand-written `.wat` benchmark, an AssemblyScript
//! or Rust `wasm32-unknown-unknown` build, or a Zena program built for
//! the `freestanding` target.
//!
//! The host gives a core module no imports. WASI and the `zena-cli:host`
//! interfaces are for components, and a core module that needs them is
//! built for the wrong target. An import the module declares is linked
//! to a function that traps when called, so a module that declares an
//! import it never calls (AssemblyScript's `env.abort`) still runs.

use std::path::Path;
use std::time::Instant;
use wasmtime::{Engine, Linker, Module, Store, Trap, Val};

use crate::component::{Outcome, RunConfig, RunFinished};
use crate::engine::{EPOCH_TICK, NO_DEADLINE};

/// Whether the file at `path` holds a core module rather than a
/// component. In the binary format the two share the wasm magic and
/// differ in the layer field after the version: 0 for a core module, 1
/// for a component. In the text format the first form says which it is:
/// `(module` or `(component`.
pub fn is_core_module_file(path: &Path) -> std::io::Result<bool> {
    let bytes = std::fs::read(path)?;
    if bytes.starts_with(b"\0asm") {
        return Ok(bytes.len() >= 8 && bytes[6] == 0 && bytes[7] == 0);
    }
    Ok(match std::str::from_utf8(&bytes) {
        Ok(text) => first_form(text) == Some("module"),
        Err(_) => false,
    })
}

/// The keyword that opens the first form of a text-format file, skipping
/// whitespace, `;;` line comments and `(; ... ;)` block comments.
fn first_form(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if text[i..].starts_with(";;") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if text[i..].starts_with("(;") {
            let mut depth = 0;
            while i < bytes.len() {
                if text[i..].starts_with("(;") {
                    depth += 1;
                    i += 2;
                } else if text[i..].starts_with(";)") {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            continue;
        }
        break;
    }
    if i >= bytes.len() || bytes[i] != b'(' {
        return None;
    }
    let start = i + 1;
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
        end += 1;
    }
    Some(&text[start..end])
}

/// Instantiates `module` with every import it declares linked to a trap,
/// and calls its export `name`, which must take no parameters. Returns
/// the export's results; the error stays a `wasmtime::Error` so a caller
/// can still ask it for a backtrace.
pub fn call_export<T>(
    store: &mut Store<T>,
    module: &Module,
    name: &str,
) -> wasmtime::Result<Vec<Val>> {
    let mut linker: Linker<T> = Linker::new(store.engine());
    linker.define_unknown_imports_as_traps(module)?;
    let instance = linker.instantiate(&mut *store, module)?;
    let func = instance
        .get_func(&mut *store, name)
        .ok_or_else(|| wasmtime::format_err!("failed to find `{name}` export"))?;
    let ty = func.ty(&*store);
    if ty.params().len() != 0 {
        return Err(wasmtime::format_err!(
            "the export `{name}` takes parameters; only an export with none can be run"
        ));
    }
    let mut results = vec![Val::I32(0); ty.results().len()];
    func.call(&mut *store, &[], &mut results)?;
    Ok(results)
}

/// Formats a core result the way `zena run` prints a program's return
/// value; a reference result falls back to its debug form.
pub fn format_val(val: &Val) -> String {
    match val {
        Val::I32(i) => i.to_string(),
        Val::I64(i) => i.to_string(),
        Val::F32(f) => f32::from_bits(*f).to_string(),
        Val::F64(f) => f64::from_bits(*f).to_string(),
        other => format!("{other:?}"),
    }
}

/// Runs a core module for `zena:wasm`: the same result record a
/// component run reports, with no output to capture, since a core
/// module has no stdio to write to.
pub(crate) fn run(engine: &Engine, config: &RunConfig) -> RunFinished {
    let interruptible = crate::engine::is_interruptible(engine);
    let module =
        match crate::cache::load_module_variant(engine, &config.path, config.debug, interruptible) {
            Ok(m) => m,
            Err(e) => return RunFinished::failed(format!("{e:#}")),
        };
    let mut store = Store::new(engine, ());
    if interruptible {
        let ticks = match config.timeout {
            Some(limit) => limit.as_nanos().div_ceil(EPOCH_TICK.as_nanos()).max(1) as u64,
            None => NO_DEADLINE,
        };
        store.set_epoch_deadline(ticks);
        store.epoch_deadline_trap();
    }
    let _ = crate::engine::reserve_gc_heap(engine, &mut store);
    let t0 = Instant::now();
    let called = call_export(&mut store, &module, &config.invoke);
    let call_nanos = t0.elapsed().as_nanos() as i64;
    let (outcome, exit_code, result_text, message) = match called {
        Ok(results) => {
            let code = match results.first() {
                Some(Val::I32(code)) => *code,
                _ => 0,
            };
            let text = results.first().map(format_val).unwrap_or_default();
            (Outcome::Returned, code, text, String::new())
        }
        Err(e) => {
            if e.downcast_ref::<Trap>() == Some(&Trap::Interrupt) {
                (
                    Outcome::TimedOut,
                    -1,
                    String::new(),
                    "stopped at its time limit".to_string(),
                )
            } else {
                let mut message = format!("{e:?}");
                if let Some(bt) = e.downcast_ref::<wasmtime::WasmBacktrace>() {
                    message.push_str(&format!("\nWasm Backtrace:\n{bt}"));
                }
                (Outcome::Trapped, -1, String::new(), message)
            }
        }
    };
    RunFinished {
        outcome,
        exit_code,
        result_text,
        message,
        stdout: Vec::new(),
        stderr: Vec::new(),
        call_nanos,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_form_names_the_kind() {
        assert_eq!(first_form("(module)"), Some("module"));
        assert_eq!(first_form("  ;; a comment\n(component)"), Some("component"));
        assert_eq!(first_form("(; block (; nested ;) ;)\n(module)"), Some("module"));
        assert_eq!(first_form("not wat"), None);
    }
}
