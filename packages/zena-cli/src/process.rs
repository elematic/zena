//! Host side of `zena:process` — the `zena_process` import module.
//!
//! Spawning is a deliberate escape from the WASI sandbox, so it is a
//! capability the CLI grants per invocation: orchestrator programs (the
//! bench and test runners) and repo tests get real implementations;
//! `zena-cli run` gets them only with `--allow-spawn` or
//! ZENA_ALLOW_SPAWN=1. Without the grant every `zena_process` import the
//! module declares is linked to a stub that traps with an explanatory
//! message, so unrelated programs still instantiate and run.
//!
//! Handles (command builders, running processes) cross the boundary as
//! `ExternRef`s wrapping host state — no handle table, the guest GC owns
//! their lifetime. Strings cross via the `$stringCreate`/`$stringSetByte`/
//! `$stringGetByte`/`$stringGetLength` helpers every Zena module exports.

use super::*;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Default)]
struct CmdState {
    argv: Vec<String>,
    cwd: Option<String>,
}

struct Finished {
    exit_code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    wall_nanos: i64,
    /// Set when the process overran a `proc_wait_timeout` deadline and
    /// was killed rather than exiting on its own.
    timed_out: bool,
}

/// Drains one of a child's pipes on its own thread. Reading them
/// sequentially would deadlock on a child that fills the other first.
fn drain<R: std::io::Read + Send + 'static>(
    mut pipe: Option<R>,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    })
}

/// A child being waited on: the result arrives on `rx` when the worker
/// thread finishes, and `child` is kept so a deadline can kill it.
struct Pending {
    rx: std::sync::mpsc::Receiver<std::result::Result<Finished, String>>,
    child: std::sync::Arc<Mutex<Option<std::process::Child>>>,
}

enum ProcState {
    Running(Pending),
    Done(std::result::Result<Finished, String>),
    // Transient state while wait() swaps Running out; never observed.
    Waiting,
}

/// Whether this invocation may spawn processes. `run` passes the
/// `--allow-spawn` flag through here; orchestrators pass `true`.
pub(crate) fn spawn_allowed(flag: bool) -> bool {
    flag || std::env::var("ZENA_ALLOW_SPAWN").is_ok_and(|v| v == "1")
}

/// Links every `zena_process` import the module declares — real
/// implementations when `allow` is set, trapping stubs otherwise.
pub(crate) fn add_process_imports(
    linker: &mut Linker<MyState>,
    module: &Module,
    allow: bool,
) -> Result<()> {
    for import in module.imports() {
        if import.module() != "zena_process" {
            continue;
        }
        let Some(func_ty) = import.ty().func().cloned() else {
            continue;
        };
        let name = import.name().to_string();
        if !allow {
            linker.func_new("zena_process", &name, func_ty, move |_caller, _params, _results| {
                Err(wasmtime::Error::msg(
                    "process spawning is not enabled for this invocation; \
                     zena:process is limited to trusted zena-cli invocations \
                     (pass --allow-spawn or set ZENA_ALLOW_SPAWN=1 to opt in)",
                ))
            })?;
            continue;
        }
        match name.as_str() {
            "cmd_new" => linker.func_new("zena_process", "cmd_new", func_ty,
                |mut caller: Caller<'_, MyState>, _params, results| {
                    let handle = ExternRef::new(&mut caller, Mutex::new(CmdState::default()))?;
                    results[0] = Val::ExternRef(Some(handle));
                    Ok(())
                })?,
            "cmd_arg" => linker.func_new("zena_process", "cmd_arg", func_ty,
                |mut caller: Caller<'_, MyState>, params, _results| {
                    let arg = read_guest_string(&mut caller, &params[1])?;
                    with_handle::<Mutex<CmdState>, _>(&mut caller, &params[0], "cmd_arg", |cmd| {
                        cmd.lock().unwrap().argv.push(arg);
                        Ok(())
                    })
                })?,
            "cmd_cwd" => linker.func_new("zena_process", "cmd_cwd", func_ty,
                |mut caller: Caller<'_, MyState>, params, _results| {
                    let cwd = read_guest_string(&mut caller, &params[1])?;
                    with_handle::<Mutex<CmdState>, _>(&mut caller, &params[0], "cmd_cwd", |cmd| {
                        cmd.lock().unwrap().cwd = Some(cwd);
                        Ok(())
                    })
                })?,
            "proc_spawn" => linker.func_new("zena_process", "proc_spawn", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let (argv, cwd) = with_handle::<Mutex<CmdState>, _>(
                        &mut caller, &params[0], "proc_spawn",
                        |cmd| {
                            let cmd = cmd.lock().unwrap();
                            Ok((cmd.argv.clone(), cmd.cwd.clone()))
                        })?;
                    if argv.is_empty() {
                        return Err(wasmtime::Error::msg("proc_spawn: empty argv"));
                    }
                    // The child is spawned here rather than inside the
                    // worker thread so its handle is reachable for
                    // `proc_wait_timeout` to kill. Both pipes are read on
                    // their own threads: a child that fills one while the
                    // parent reads the other would otherwise deadlock.
                    let t0 = Instant::now();
                    let mut command = std::process::Command::new(&argv[0]);
                    command
                        .args(&argv[1..])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped());
                    if let Some(cwd) = &cwd {
                        command.current_dir(cwd);
                    }
                    let (tx, rx) = std::sync::mpsc::channel();
                    let shared_child = match command.spawn() {
                        Ok(mut child) => {
                            let out = child.stdout.take();
                            let err = child.stderr.take();
                            let shared = std::sync::Arc::new(Mutex::new(Some(child)));
                            let worker_child = shared.clone();
                            std::thread::spawn(move || {
                                let out_t = drain(out);
                                let err_t = drain(err);
                                // Poll rather than block in `wait()`: the
                                // lock has to be free between polls, or a
                                // deadline could never acquire it to kill
                                // the child it is waiting on.
                                let status = loop {
                                    {
                                        let mut guard = worker_child.lock().unwrap();
                                        match guard.as_mut().map(|c| c.try_wait()) {
                                            Some(Ok(Some(status))) => break Some(Ok(status)),
                                            Some(Err(e)) => break Some(Err(e)),
                                            Some(Ok(None)) => {}
                                            None => break None,
                                        }
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(2));
                                };
                                let stdout = out_t.join().unwrap_or_default();
                                let stderr = err_t.join().unwrap_or_default();
                                let _ = tx.send(match status {
                                    Some(Ok(status)) => Ok(Finished {
                                        exit_code: status.code().unwrap_or(-1),
                                        stdout,
                                        stderr,
                                        wall_nanos: t0.elapsed().as_nanos() as i64,
                                        timed_out: false,
                                    }),
                                    Some(Err(e)) => Err(format!("waiting on {argv:?}: {e}")),
                                    None => Err(format!("waiting on {argv:?}: no child")),
                                });
                            });
                            shared
                        }
                        Err(e) => {
                            // Report the failure through the same channel
                            // so `wait` is the single place that reports.
                            let _ = tx.send(Err(format!("spawning {argv:?}: {e}")));
                            std::sync::Arc::new(Mutex::new(None))
                        }
                    };
                    let pending = Pending { rx, child: shared_child };
                    let handle =
                        ExternRef::new(&mut caller, Mutex::new(ProcState::Running(pending)))?;
                    results[0] = Val::ExternRef(Some(handle));
                    Ok(())
                })?,
            "proc_wait" => linker.func_new("zena_process", "proc_wait", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let code = with_finished(&mut caller, &params[0], "proc_wait",
                        |fin| Ok(fin.exit_code))?;
                    results[0] = Val::I32(code);
                    Ok(())
                })?,
            "proc_stdout" => linker.func_new("zena_process", "proc_stdout", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let bytes = with_finished(&mut caller, &params[0], "proc_stdout",
                        |fin| Ok(fin.stdout.clone()))?;
                    results[0] = make_guest_string(&mut caller, &bytes)?;
                    Ok(())
                })?,
            "proc_stderr" => linker.func_new("zena_process", "proc_stderr", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let bytes = with_finished(&mut caller, &params[0], "proc_stderr",
                        |fin| Ok(fin.stderr.clone()))?;
                    results[0] = make_guest_string(&mut caller, &bytes)?;
                    Ok(())
                })?,
            "proc_wait_timeout" => linker.func_new("zena_process", "proc_wait_timeout", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let Val::I64(millis) = params[1] else {
                        return Err(wasmtime::Error::msg("proc_wait_timeout: millis not an i64"));
                    };
                    // A non-positive deadline means "no deadline", so a
                    // caller can disable its timeout without branching.
                    let timeout = if millis > 0 {
                        Some(std::time::Duration::from_millis(millis as u64))
                    } else {
                        None
                    };
                    let code = with_finished_timeout(
                        &mut caller, &params[0], "proc_wait_timeout", timeout,
                        |fin| Ok(fin.exit_code))?;
                    results[0] = Val::I32(code);
                    Ok(())
                })?,
            "proc_timed_out" => linker.func_new("zena_process", "proc_timed_out", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let flag = with_finished(&mut caller, &params[0], "proc_timed_out",
                        |fin| Ok(if fin.timed_out { 1 } else { 0 }))?;
                    results[0] = Val::I32(flag);
                    Ok(())
                })?,
            "proc_wall_nanos" => linker.func_new("zena_process", "proc_wall_nanos", func_ty,
                |mut caller: Caller<'_, MyState>, params, results| {
                    let nanos = with_finished(&mut caller, &params[0], "proc_wall_nanos",
                        |fin| Ok(fin.wall_nanos))?;
                    results[0] = Val::I64(nanos);
                    Ok(())
                })?,
            other => {
                return Err(anyhow::anyhow!("unknown zena_process import: {other}"));
            }
        };
    }
    Ok(())
}

/// Runs `f` with the host data behind a handle param, converting AnyRef
/// vals (concrete GC import signatures) to ExternRef as needed.
fn with_handle<T: 'static, R>(
    caller: &mut Caller<'_, MyState>,
    param: &Val,
    what: &str,
    f: impl FnOnce(&T) -> Result<R, wasmtime::Error>,
) -> Result<R, wasmtime::Error> {
    let ext = param_to_externref(caller, param, what)?;
    let data = ext.data(&mut *caller)?;
    let Some(state) = data.and_then(|d| d.downcast_ref::<T>()) else {
        return Err(wasmtime::Error::msg(format!("{what}: not a zena_process handle")));
    };
    // Safety dance: `data` borrows the store, but `f` may need the caller
    // again (it doesn't today — all closures copy out first).
    f(state)
}

/// Waits (once) on a process handle, then projects out of the result.
///
/// `timeout` bounds the wait: when it elapses the child is killed and
/// the result it then produces is flagged `timed_out`. `None` waits
/// indefinitely. Waiting again returns the same cached result either
/// way.
fn with_finished_timeout<R>(
    caller: &mut Caller<'_, MyState>,
    param: &Val,
    what: &str,
    timeout: Option<std::time::Duration>,
    f: impl FnOnce(&Finished) -> Result<R, wasmtime::Error>,
) -> Result<R, wasmtime::Error> {
    with_handle::<Mutex<ProcState>, _>(caller, param, what, |state| {
        let mut state = state.lock().unwrap();
        if let ProcState::Running(_) = &*state {
            let ProcState::Running(pending) = std::mem::replace(&mut *state, ProcState::Waiting)
            else {
                unreachable!()
            };
            let (result, killed) = match timeout {
                Some(dur) => match pending.rx.recv_timeout(dur) {
                    Ok(r) => (r, false),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // Kill, then take the result the worker sends
                        // once the child is reaped, so stdout and stderr
                        // captured before the deadline are preserved.
                        if let Some(child) = pending.child.lock().unwrap().as_mut() {
                            let _ = child.kill();
                        }
                        // The worker still has to reap the child and
                        // drain its pipes. That is normally instant, but
                        // a grandchild the kill did not reach can hold a
                        // pipe open, so give up after a grace period and
                        // report the timeout without the output rather
                        // than hanging on it.
                        let reaped = pending
                            .rx
                            .recv_timeout(std::time::Duration::from_secs(2))
                            .unwrap_or_else(|_| {
                                Ok(Finished {
                                    exit_code: -1,
                                    stdout: Vec::new(),
                                    stderr: b"(killed on timeout; \
                                              output withheld by a surviving child)"
                                        .to_vec(),
                                    wall_nanos: dur.as_nanos() as i64,
                                    timed_out: true,
                                })
                            });
                        (reaped, true)
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => (
                        Err("process wait thread vanished".to_string()),
                        false,
                    ),
                },
                None => (
                    pending
                        .rx
                        .recv()
                        .unwrap_or_else(|_| Err("process wait thread vanished".to_string())),
                    false,
                ),
            };
            *state = ProcState::Done(result.map(|mut fin| {
                fin.timed_out = killed;
                fin
            }));
        }
        match &*state {
            ProcState::Done(Ok(fin)) => f(fin),
            ProcState::Done(Err(msg)) => Err(wasmtime::Error::msg(format!("{what}: {msg}"))),
            _ => Err(wasmtime::Error::msg(format!("{what}: process in invalid state"))),
        }
    })
}

/// `with_finished_timeout` with no deadline.
fn with_finished<R>(
    caller: &mut Caller<'_, MyState>,
    param: &Val,
    what: &str,
    f: impl FnOnce(&Finished) -> Result<R, wasmtime::Error>,
) -> Result<R, wasmtime::Error> {
    with_finished_timeout(caller, param, what, None, f)
}

fn param_to_externref(
    caller: &mut Caller<'_, MyState>,
    param: &Val,
    what: &str,
) -> Result<Rooted<ExternRef>, wasmtime::Error> {
    match param {
        Val::ExternRef(Some(r)) => Ok(*r),
        Val::AnyRef(Some(anyref)) => Ok(ExternRef::convert_any(&mut *caller, *anyref)?),
        _ => Err(wasmtime::Error::msg(format!("{what}: null or non-reference handle"))),
    }
}

/// Reads a guest String param via the module's `$stringGetLength` /
/// `$stringGetByte` exports. Bytes are Zena's string encoding (UTF-8).
pub(crate) fn read_guest_string(
    caller: &mut Caller<'_, MyState>,
    param: &Val,
) -> Result<String, wasmtime::Error> {
    let ext = param_to_externref(caller, param, "string argument")?;
    let get_length = caller
        .get_export("$stringGetLength")
        .and_then(|e| e.into_func())
        .ok_or_else(|| wasmtime::Error::msg("no $stringGetLength export"))?;
    let get_byte = caller
        .get_export("$stringGetByte")
        .and_then(|e| e.into_func())
        .ok_or_else(|| wasmtime::Error::msg("no $stringGetByte export"))?;

    let mut len_res = vec![Val::I32(0)];
    get_length.call(&mut *caller, &[Val::ExternRef(Some(ext))], &mut len_res)?;
    let Val::I32(len) = len_res[0] else {
        return Err(wasmtime::Error::msg("$stringGetLength returned a non-i32"));
    };
    let mut bytes = Vec::with_capacity(len.max(0) as usize);
    let mut byte_res = vec![Val::I32(0)];
    for i in 0..len {
        get_byte.call(
            &mut *caller,
            &[Val::ExternRef(Some(ext)), Val::I32(i)],
            &mut byte_res,
        )?;
        let Val::I32(b) = byte_res[0] else {
            return Err(wasmtime::Error::msg("$stringGetByte returned a non-i32"));
        };
        bytes.push(b as u8);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Builds a guest String from host bytes via `$stringCreate` /
/// `$stringSetByte` (the same protocol the stack-trace helpers use).
pub(crate) fn make_guest_string(
    caller: &mut Caller<'_, MyState>,
    bytes: &[u8],
) -> Result<Val, wasmtime::Error> {
    let create = caller
        .get_export("$stringCreate")
        .and_then(|e| e.into_func())
        .ok_or_else(|| wasmtime::Error::msg("no $stringCreate export"))?;
    let set_byte = caller
        .get_export("$stringSetByte")
        .and_then(|e| e.into_func())
        .ok_or_else(|| wasmtime::Error::msg("no $stringSetByte export"))?;

    let mut cr_res = vec![Val::I32(0)];
    create.call(&mut *caller, &[Val::I32(bytes.len() as i32)], &mut cr_res)?;
    let str_ref = cr_res[0].clone();
    for (i, &byte) in bytes.iter().enumerate() {
        set_byte.call(
            &mut *caller,
            &[str_ref.clone(), Val::I32(i as i32), Val::I32(byte as i32)],
            &mut [],
        )?;
    }
    Ok(str_ref)
}
