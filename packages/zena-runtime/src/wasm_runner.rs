//! Host side of `zena:wasm`: the `zena_wasm` import module, which lets a
//! module start other Wasm modules and wait for their results.
//!
//! A Wasm module cannot start wasmtime by itself, and a command-line
//! tool written in Zena needs to: the test runner compiles each test to
//! a module and then runs it. This is that one capability. Each run gets
//! a fresh store on its own thread, so several run at once, and a trap
//! in one is reported in its result without affecting the caller.
//!
//! Running a module is granted together with spawning processes (see
//! [`crate::Spawn`]). Directories handed to a run are translated through
//! the caller's own preopens, and a path outside them is refused, so a
//! module can pass on only what it can reach itself. Without the grant
//! every import is a stub that traps with an explanation.
//!
//! Handles cross the boundary as `ExternRef`s, as in
//! [`crate::process`]: a run configuration being built, and a started
//! run.

use anyhow::Result;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use wasmtime::{Caller, Engine, ExternRef, Linker, Module, Store, Trap, Val};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};

use crate::engine::{
    EPOCH_TICK, NO_DEADLINE, interruptible_engine, is_interruptible, reserve_gc_heap, shared_engine,
};
use crate::strings::{make_guest_string, param_to_externref, read_guest_string};
use crate::{Grant, HostState, PathMap, Spawn};

/// The most output a captured run keeps from each stream.
const CAPTURE_LIMIT: usize = 64 << 20;

/// A run being configured, before `run_start`.
struct RunConfig {
    path: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    inherit_env: bool,
    /// (directory in the caller's view, directory in the run's view)
    dirs: Vec<(String, String)>,
    invoke: String,
    inherit_stdio: bool,
    grant: bool,
    timeout: Option<Duration>,
    /// Run on a debug engine: no inlining, so backtraces name every
    /// function. Starts as the caller's own setting.
    debug: bool,
}

/// How a run ended. The numbers are what `run_outcome` returns.
#[derive(Clone, Copy)]
enum Outcome {
    /// The export returned.
    Returned = 0,
    Trapped = 1,
    TimedOut = 2,
    /// The module could not be read, compiled, linked or instantiated.
    Failed = 3,
    /// The module ended itself with `proc_exit` (Zena's `exit(code)`).
    Exited = 4,
}

struct Finished {
    outcome: Outcome,
    exit_code: i32,
    /// The export's first result, formatted as `zena run` prints it; ''
    /// when it returned nothing or did not return.
    result_text: String,
    message: String,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    call_nanos: i64,
}

impl Finished {
    fn failed(message: String) -> Finished {
        Finished {
            outcome: Outcome::Failed,
            exit_code: -1,
            result_text: String::new(),
            message,
            stdout: Vec::new(),
            stderr: Vec::new(),
            call_nanos: 0,
        }
    }
}

enum RunState {
    Running(std::sync::mpsc::Receiver<Finished>),
    Done(Finished),
    // Transient while `wait` swaps `Running` out; never observed.
    Waiting,
}

/// Translates a path in the caller's view to a host path, through the
/// caller's preopens. Relative paths are under the '.' preopen; an
/// absolute path takes its longest matching preopen. A path outside
/// every preopen is refused, and so is any path with a `..` segment,
/// which could climb out of the preopen it starts in.
fn translate(path: &str, map: &PathMap) -> Option<PathBuf> {
    if path.split('/').any(|segment| segment == "..") {
        return None;
    }
    if !path.starts_with('/') {
        let (_, host) = map.iter().find(|(guest, _)| guest == ".")?;
        return Some(if path == "." {
            host.clone()
        } else {
            host.join(path)
        });
    }
    let mut best: Option<(usize, &PathBuf)> = None;
    for (guest, host) in map {
        let matched = if guest == "/" {
            true
        } else {
            path == guest
                || (path.starts_with(guest.as_str())
                    && path.as_bytes().get(guest.len()) == Some(&b'/'))
        };
        if matched && best.is_none_or(|(len, _)| guest.len() > len) {
            best = Some((guest.len(), host));
        }
    }
    let (len, host) = best?;
    let rest = path[len..].trim_start_matches('/');
    Some(if rest.is_empty() {
        host.clone()
    } else {
        host.join(rest)
    })
}

/// Links every `zena_wasm` import the module declares: real
/// implementations under a grant, trapping stubs otherwise.
pub fn add_to_linker(
    linker: &mut Linker<HostState>,
    module: &Module,
    grant: Option<Grant>,
) -> Result<()> {
    let grant = grant.map(std::sync::Arc::new);
    for import in module.imports() {
        if import.module() != "zena_wasm" {
            continue;
        }
        let Some(func_ty) = import.ty().func().cloned() else {
            continue;
        };
        let name = import.name().to_string();
        let Some(grant) = grant.clone() else {
            linker.func_new(
                "zena_wasm",
                &name,
                func_ty,
                move |_caller, _params, _results| {
                    Err(wasmtime::Error::msg(
                        "running Wasm modules is not enabled for this invocation; \
                     zena:wasm needs the same explicit grant as zena:process \
                     (pass --allow-spawn or set ZENA_ALLOW_SPAWN=1 to opt in)",
                    ))
                },
            )?;
            continue;
        };
        match name.as_str() {
            "run_new" => {
                let debug = grant.debug;
                linker.func_new(
                    "zena_wasm",
                    "run_new",
                    func_ty,
                    move |mut caller: Caller<'_, HostState>, params, results| {
                        let path = read_guest_string(&mut caller, &params[0])?;
                        let config = RunConfig {
                            path,
                            args: Vec::new(),
                            env: Vec::new(),
                            inherit_env: false,
                            dirs: Vec::new(),
                            invoke: "main".to_string(),
                            inherit_stdio: false,
                            grant: false,
                            timeout: None,
                            debug,
                        };
                        let handle = ExternRef::new(&mut caller, Mutex::new(config))?;
                        results[0] = Val::ExternRef(Some(handle));
                        Ok(())
                    },
                )?
            }
            "run_arg" => linker.func_new(
                "zena_wasm",
                "run_arg",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    let arg = read_guest_string(&mut caller, &params[1])?;
                    with_config(&mut caller, &params[0], "run_arg", |c| c.args.push(arg))
                },
            )?,
            "run_env" => linker.func_new(
                "zena_wasm",
                "run_env",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    let key = read_guest_string(&mut caller, &params[1])?;
                    let value = read_guest_string(&mut caller, &params[2])?;
                    with_config(&mut caller, &params[0], "run_env", |c| {
                        c.env.push((key, value))
                    })
                },
            )?,
            "run_inherit_env" => linker.func_new(
                "zena_wasm",
                "run_inherit_env",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    with_config(&mut caller, &params[0], "run_inherit_env", |c| {
                        c.inherit_env = true
                    })
                },
            )?,
            "run_dir" => linker.func_new(
                "zena_wasm",
                "run_dir",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    let from = read_guest_string(&mut caller, &params[1])?;
                    let to = read_guest_string(&mut caller, &params[2])?;
                    with_config(&mut caller, &params[0], "run_dir", |c| {
                        c.dirs.push((from, to))
                    })
                },
            )?,
            "run_invoke" => linker.func_new(
                "zena_wasm",
                "run_invoke",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    let name = read_guest_string(&mut caller, &params[1])?;
                    with_config(&mut caller, &params[0], "run_invoke", |c| c.invoke = name)
                },
            )?,
            "run_inherit_stdio" => linker.func_new(
                "zena_wasm",
                "run_inherit_stdio",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    with_config(&mut caller, &params[0], "run_inherit_stdio", |c| {
                        c.inherit_stdio = true
                    })
                },
            )?,
            "run_grant" => linker.func_new(
                "zena_wasm",
                "run_grant",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    with_config(&mut caller, &params[0], "run_grant", |c| c.grant = true)
                },
            )?,
            "run_debug" => linker.func_new(
                "zena_wasm",
                "run_debug",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    with_config(&mut caller, &params[0], "run_debug", |c| c.debug = true)
                },
            )?,
            "run_timeout" => linker.func_new(
                "zena_wasm",
                "run_timeout",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, _results| {
                    let Val::I64(nanos) = params[1] else {
                        return Err(wasmtime::Error::msg("run_timeout: nanos not an i64"));
                    };
                    with_config(&mut caller, &params[0], "run_timeout", |c| {
                        c.timeout = if nanos > 0 {
                            Some(Duration::from_nanos(nanos as u64))
                        } else {
                            None
                        }
                    })
                },
            )?,
            "run_start" => {
                let grant = grant.clone();
                linker.func_new(
                    "zena_wasm",
                    "run_start",
                    func_ty,
                    move |mut caller: Caller<'_, HostState>, params, results| {
                        let config = with_handle::<Mutex<RunConfig>, _>(
                            &mut caller,
                            &params[0],
                            "run_start",
                            |c| {
                                let c = c.lock().unwrap();
                                Ok(RunConfig {
                                    path: c.path.clone(),
                                    args: c.args.clone(),
                                    env: c.env.clone(),
                                    inherit_env: c.inherit_env,
                                    dirs: c.dirs.clone(),
                                    invoke: c.invoke.clone(),
                                    inherit_stdio: c.inherit_stdio,
                                    grant: c.grant,
                                    timeout: c.timeout,
                                    debug: c.debug,
                                })
                            },
                        )?;
                        let engine = caller.engine().clone();
                        let rx = start(engine, config, &grant);
                        let handle =
                            ExternRef::new(&mut caller, Mutex::new(RunState::Running(rx)))?;
                        results[0] = Val::ExternRef(Some(handle));
                        Ok(())
                    },
                )?
            }
            "run_wait" => linker.func_new(
                "zena_wasm",
                "run_wait",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, results| {
                    let code =
                        with_finished(&mut caller, &params[0], "run_wait", |f| Ok(f.exit_code))?;
                    results[0] = Val::I32(code);
                    Ok(())
                },
            )?,
            "run_outcome" => linker.func_new(
                "zena_wasm",
                "run_outcome",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, results| {
                    let outcome = with_finished(&mut caller, &params[0], "run_outcome", |f| {
                        Ok(f.outcome as i32)
                    })?;
                    results[0] = Val::I32(outcome);
                    Ok(())
                },
            )?,
            "run_message" | "run_stdout" | "run_stderr" | "run_result_text" => {
                let which = name.clone();
                linker.func_new(
                    "zena_wasm",
                    &name.clone(),
                    func_ty,
                    move |mut caller: Caller<'_, HostState>, params, results| {
                        let bytes = with_finished(&mut caller, &params[0], &which, |f| {
                            Ok(match which.as_str() {
                                "run_message" => f.message.clone().into_bytes(),
                                "run_stdout" => f.stdout.clone(),
                                "run_result_text" => f.result_text.clone().into_bytes(),
                                _ => f.stderr.clone(),
                            })
                        })?;
                        results[0] = make_guest_string(&mut caller, &bytes)?;
                        Ok(())
                    },
                )?
            }
            "module_precompile" => {
                let grant = grant.clone();
                linker.func_new(
                    "zena_wasm",
                    "module_precompile",
                    func_ty,
                    move |mut caller: Caller<'_, HostState>, params, results| {
                        let path = read_guest_string(&mut caller, &params[0])?;
                        let Val::I32(debug) = params[1] else {
                            return Err(wasmtime::Error::msg(
                                "module_precompile: debug not an i32",
                            ));
                        };
                        let outcome = match translate(&path, &grant.path_map) {
                            Some(host) => precompile(&host, debug != 0),
                            None => {
                                format!("{path} is outside every directory this module can reach")
                            }
                        };
                        results[0] = make_guest_string(&mut caller, outcome.as_bytes())?;
                        Ok(())
                    },
                )?
            }
            "run_call_nanos" => linker.func_new(
                "zena_wasm",
                "run_call_nanos",
                func_ty,
                |mut caller: Caller<'_, HostState>, params, results| {
                    let nanos = with_finished(&mut caller, &params[0], "run_call_nanos", |f| {
                        Ok(f.call_nanos)
                    })?;
                    results[0] = Val::I64(nanos);
                    Ok(())
                },
            )?,
            other => {
                return Err(anyhow::anyhow!("unknown zena_wasm import: {other}"));
            }
        };
    }
    Ok(())
}

/// Starts a run on its own thread and returns the channel its result
/// arrives on.
fn start(engine: Engine, config: RunConfig, grant: &Grant) -> std::sync::mpsc::Receiver<Finished> {
    let (tx, rx) = std::sync::mpsc::channel();
    // Paths are translated here, on the caller's side, so a refused path
    // is reported against the caller's own view of the filesystem.
    let module_path = translate(&config.path, &grant.path_map);
    let mut dirs: PathMap = Vec::new();
    let mut refused: Option<String> = None;
    for (from, to) in &config.dirs {
        match translate(from, &grant.path_map) {
            Some(host) => dirs.push((to.clone(), host)),
            None => {
                refused = Some(format!(
                    "directory {from} is outside every directory this module can reach"
                ));
                break;
            }
        }
    }
    let debug = config.debug;
    let same_as_caller = debug == grant.debug;
    std::thread::spawn(move || {
        let finished = match (module_path, refused) {
            (None, _) => Finished::failed(format!(
                "{} is outside every directory this module can reach",
                config.path
            )),
            (_, Some(message)) => Finished::failed(message),
            (Some(path), None) => {
                // A time limit needs the engine whose code checks the
                // epoch. Without one, the run shares its caller's engine,
                // unless it asked for a different debug setting.
                let engine = if config.timeout.is_some() {
                    interruptible_engine(debug)
                } else if same_as_caller {
                    Ok(engine)
                } else {
                    shared_engine(debug)
                };
                match engine {
                    Ok(engine) => run(&engine, &path, &config, dirs, debug),
                    Err(e) => Finished::failed(format!("{e:#}")),
                }
            }
        };
        let _ = tx.send(finished);
    });
    rx
}

/// Loads, instantiates and calls one module, and reports how it ended.
fn run(
    engine: &Engine,
    path: &PathBuf,
    config: &RunConfig,
    dirs: PathMap,
    debug: bool,
) -> Finished {
    // Checked first because the cache takes a lock file beside the path
    // before it reads the module, and would leave one next to a module
    // that does not exist.
    if !path.is_file() {
        return Finished::failed(format!("no such module: {}", path.display()));
    }
    let interruptible = is_interruptible(engine);
    let module = match crate::cache::load_module_variant(engine, path, debug, interruptible) {
        Ok(m) => m,
        Err(e) => return Finished::failed(format!("{e:#}")),
    };

    let mut wasi = WasiCtxBuilder::new();
    wasi.args(&config.args);
    if config.inherit_env {
        wasi.inherit_env();
    }
    for (key, value) in &config.env {
        wasi.env(key, value);
    }
    for (guest, host) in &dirs {
        if let Err(e) = wasi.preopened_dir(host, guest, FsPerms::ReadWrite) {
            return Finished::failed(format!("preopening {}: {e:#}", host.display()));
        }
    }
    let captured = if config.inherit_stdio {
        wasi.inherit_stdio();
        None
    } else {
        let out = MemoryOutputPipe::new(CAPTURE_LIMIT);
        let err = MemoryOutputPipe::new(CAPTURE_LIMIT);
        wasi.stdout(out.clone());
        wasi.stderr(err.clone());
        Some((out, err))
    };

    let mut store = Store::new(
        engine,
        HostState {
            wasi: wasi.build_p1(),
        },
    );
    if interruptible {
        // A store on the interruptible engine traps at its first call
        // unless it has a deadline.
        let ticks = match config.timeout {
            Some(limit) => limit.as_nanos().div_ceil(EPOCH_TICK.as_nanos()).max(1) as u64,
            None => NO_DEADLINE,
        };
        store.set_epoch_deadline(ticks);
        store.epoch_deadline_trap();
    }
    let _ = reserve_gc_heap(engine, &mut store);

    let spawn = if config.grant {
        Spawn::Allow(Grant {
            path_map: dirs,
            debug,
        })
    } else {
        Spawn::Deny
    };
    let mut linker: Linker<HostState> = Linker::new(engine);
    if let Err(e) = crate::add_to_linker(&mut linker, engine, &module, spawn) {
        return Finished::failed(format!("{e:#}"));
    }
    let instance = match linker.instantiate(&mut store, &module) {
        Ok(i) => i,
        Err(e) => return Finished::failed(format!("instantiating {}: {e:?}", path.display())),
    };

    let t0 = Instant::now();
    let called = crate::call_export(&mut store, &instance, &config.invoke);
    let call_nanos = t0.elapsed().as_nanos() as i64;

    let (outcome, exit_code, result_text, message) = match called {
        Ok(results) => {
            // A Zena program's `main` returns its status.
            let code = match results.first() {
                Some(Val::I32(code)) => *code,
                _ => 0,
            };
            let text = results
                .first()
                .map(crate::format_result)
                .unwrap_or_default();
            (Outcome::Returned, code, text, String::new())
        }
        Err(e) => {
            if let Some(code) = crate::exit_code(&e) {
                (Outcome::Exited, code, String::new(), String::new())
            } else if e.downcast_ref::<Trap>() == Some(&Trap::Interrupt) {
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
    drop(store);

    let (stdout, stderr) = match captured {
        Some((out, err)) => (out.contents().to_vec(), err.contents().to_vec()),
        None => (Vec::new(), Vec::new()),
    };
    Finished {
        outcome,
        exit_code,
        result_text,
        message,
        stdout,
        stderr,
        call_nanos,
    }
}

/// Writes a module's `.cwasm` beside it now, so later runs skip Cranelift.
/// Returns '' on success and the reason otherwise.
fn precompile(path: &PathBuf, debug: bool) -> String {
    let engine = match Engine::new(&crate::engine::config(debug)) {
        Ok(engine) => engine,
        Err(e) => return format!("{e:#}"),
    };
    if !path.is_file() {
        return format!("no such module: {}", path.display());
    }
    match crate::cache::precompile(&engine, path, debug) {
        Ok(_) => String::new(),
        Err(e) => format!("{e:#}"),
    }
}

fn with_handle<T: 'static, R>(
    caller: &mut Caller<'_, HostState>,
    param: &Val,
    what: &str,
    f: impl FnOnce(&T) -> Result<R, wasmtime::Error>,
) -> Result<R, wasmtime::Error> {
    let ext = param_to_externref(caller, param, what)?;
    let data = ext.data(&mut *caller)?;
    let Some(state) = data.and_then(|d| d.downcast_ref::<T>()) else {
        return Err(wasmtime::Error::msg(format!(
            "{what}: not a zena_wasm handle"
        )));
    };
    f(state)
}

fn with_config(
    caller: &mut Caller<'_, HostState>,
    param: &Val,
    what: &str,
    f: impl FnOnce(&mut RunConfig),
) -> Result<(), wasmtime::Error> {
    with_handle::<Mutex<RunConfig>, _>(caller, param, what, |c| {
        f(&mut c.lock().unwrap());
        Ok(())
    })
}

/// Waits (once) for a run, then projects out of its result. Waiting
/// again returns the same result.
fn with_finished<R>(
    caller: &mut Caller<'_, HostState>,
    param: &Val,
    what: &str,
    f: impl FnOnce(&Finished) -> Result<R, wasmtime::Error>,
) -> Result<R, wasmtime::Error> {
    with_handle::<Mutex<RunState>, _>(caller, param, what, |state| {
        let mut state = state.lock().unwrap();
        if let RunState::Running(_) = &*state {
            let RunState::Running(rx) = std::mem::replace(&mut *state, RunState::Waiting) else {
                unreachable!()
            };
            let finished = rx
                .recv()
                .unwrap_or_else(|_| Finished::failed("the run's thread vanished".to_string()));
            *state = RunState::Done(finished);
        }
        match &*state {
            RunState::Done(finished) => f(finished),
            _ => Err(wasmtime::Error::msg(format!(
                "{what}: run in invalid state"
            ))),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translate_refuses_paths_outside_the_preopens() {
        let map: PathMap = vec![
            (".".to_string(), PathBuf::from("/repo")),
            ("/tmp".to_string(), PathBuf::from("/repo/.zena/tmp")),
        ];
        assert_eq!(translate(".", &map), Some(PathBuf::from("/repo")));
        assert_eq!(
            translate("out/a.wasm", &map),
            Some(PathBuf::from("/repo/out/a.wasm"))
        );
        assert_eq!(
            translate("/tmp/x", &map),
            Some(PathBuf::from("/repo/.zena/tmp/x"))
        );
        // Sharing a prefix with /tmp is not being under it.
        assert_eq!(translate("/tmpfoo", &map), None);
        assert_eq!(translate("/etc/passwd", &map), None);
        // `..` could climb out of the preopen it starts in.
        assert_eq!(translate("../outside", &map), None);
        assert_eq!(translate("/tmp/../etc", &map), None);

        let rootless: PathMap = vec![("/tmp".to_string(), PathBuf::from("/t"))];
        assert_eq!(translate("relative", &rootless), None);
    }
}
