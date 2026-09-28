//! Host side of a Zena component: WASI 0.3 through `wasmtime-wasi`, plus
//! the `zena-cli:host` interfaces the `zena` command's target imports —
//! stack traces for `Error`, process spawning behind `zena:process`, and
//! running other components and core modules behind `zena:wasm` (a core
//! module runs with no imports; see [`crate::core_module`]). The WIT is
//! `packages/stdlib/zena/host-wit/host.wit`; the guest side is the
//! standard library's `component.zena` files for those modules.
//!
//! A component's `main` may be an async export, so calling it goes
//! through wasmtime's concurrent machinery: [`run_main`] builds a
//! current-thread tokio runtime around the instantiation and the call.
//! Everything blocking a program does — reading a file, waiting on a
//! child — blocks inside that call, which the Component Model allows a
//! call to an async export to do.
//!
//! Spawning processes and running programs are granted together
//! ([`crate::Grant`]); without the grant, the guest's calls trap with an
//! explanation.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wasmtime::component::{Component, HasSelf, Instance, Linker, Resource, ResourceTable, Val};
use wasmtime::error::Context as _;
use wasmtime::{Engine, Result, Store, StoreContextMut, Trap, format_err};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{FsPerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::engine::{EPOCH_TICK, NO_DEADLINE};
use crate::{Grant, PathMap};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../stdlib/zena/host-wit",
        world: "zena-cli:host/command",
        imports: {
            default: trappable,
        },
        with: {
            "zena-cli:host/process.command": super::CommandState,
            "zena-cli:host/process.process": super::ProcessState,
            "zena-cli:host/wasm.run": super::RunState,
        },
    });
}

use bindings::zena_cli::host::{process, wasm};

/// The most output a captured run keeps from each stream.
const CAPTURE_LIMIT: usize = 64 << 20;

/// The store data of every component this crate runs: the WASI context
/// and resource table `wasmtime-wasi` reads, the grant the host
/// interfaces check, and the engine a granted run starts children on.
pub struct ComponentState {
    pub wasi: WasiCtx,
    pub table: ResourceTable,
    grant: Option<Grant>,
    engine: Engine,
}

impl ComponentState {
    pub fn new(engine: &Engine, wasi: WasiCtx, grant: Option<Grant>) -> ComponentState {
        ComponentState {
            wasi,
            table: ResourceTable::new(),
            grant,
            engine: engine.clone(),
        }
    }

    fn granted(&self, what: &str) -> Result<&Grant> {
        self.grant.as_ref().ok_or_else(|| {
            format_err!(
                "{what} is not enabled for this invocation; zena:process and \
                 zena:wasm need an explicit grant from the host (pass \
                 --allow-spawn or set ZENA_ALLOW_SPAWN=1 to opt in)"
            )
        })
    }
}

impl WasiView for ComponentState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// A linker with everything a Zena component imports: WASI 0.3 and the
/// `zena-cli:host` interfaces.
pub fn linker(engine: &Engine) -> Result<Linker<ComponentState>> {
    let mut linker: Linker<ComponentState> = Linker::new(engine);
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    process::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;
    wasm::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;
    // `capture` needs the store, for the backtrace: linked by hand
    // rather than through the generated trait.
    linker
        .instance("zena-cli:host/stack-trace@1.0.0")?
        .func_wrap(
            "capture",
            |store: StoreContextMut<'_, ComponentState>, (): ()| -> Result<(String,)> {
                Ok((format!("{}", wasmtime::WasmBacktrace::capture(&store)),))
            },
        )?;
    Ok(linker)
}

/// Instantiates `component` and calls its nullary export `name`, on a
/// runtime of its own, returning the export's results. The error stays a
/// `wasmtime::Error` so callers can still ask it for the guest's exit
/// status ([`crate::exit_code`]) or a backtrace ([`crate::report_trap`]).
pub fn run_main(
    store: &mut Store<ComponentState>,
    linker: &Linker<ComponentState>,
    component: &Component,
    name: &str,
) -> Result<Vec<Val>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format_err!("failed to start a runtime: {e}"))?;
    // Headroom for the GC heap, as for a core module (ZENA_GC_RESERVE_MB).
    let engine = store.engine().clone();
    let _ = crate::engine::reserve_gc_heap(&engine, store);
    runtime.block_on(async {
        let instance: Instance = linker.instantiate_async(&mut *store, component).await?;
        let func = instance
            .get_func(&mut *store, name)
            .ok_or_else(|| format_err!("failed to find `{name}` export"))?;
        let count = func.ty(&*store).results().len();
        let mut results = vec![Val::Bool(false); count];
        func.call_async(&mut *store, &[], &mut results).await?;
        Ok(results)
    })
}

// ============================================================================
// zena-cli:host/process
// ============================================================================

/// A process being configured.
pub struct CommandState {
    argv: Vec<String>,
    cwd: Option<String>,
    inherit_stdio: bool,
}

/// How a child ended, and what it wrote; the host side of `finished`.
struct Finished {
    exit_code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    wall_nanos: i64,
    timed_out: bool,
}

impl From<Finished> for process::Finished {
    fn from(f: Finished) -> process::Finished {
        process::Finished {
            exit_code: f.exit_code,
            stdout: f.stdout,
            stderr: f.stderr,
            wall_nanos: f.wall_nanos,
            timed_out: f.timed_out,
        }
    }
}

/// A child being waited on: the result arrives on `rx` when the worker
/// thread finishes, and `child` is kept so a deadline can kill it.
struct Pending {
    rx: std::sync::mpsc::Receiver<std::result::Result<Finished, String>>,
    child: Arc<Mutex<Option<std::process::Child>>>,
}

/// A running process, then its result.
pub struct ProcessState {
    pending: Option<Pending>,
    done: Option<std::result::Result<Finished, String>>,
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

/// Translates a guest cwd to a host path: relative paths resolve under
/// the '.' preopen, absolute paths take their longest matching preopen
/// prefix. An unmapped path passes through unchanged.
fn translate_cwd(cwd: &str, map: &PathMap) -> PathBuf {
    if !cwd.starts_with('/') {
        if let Some((_, host)) = map.iter().find(|(guest, _)| guest == ".") {
            return if cwd == "." { host.clone() } else { host.join(cwd) };
        }
        return PathBuf::from(cwd);
    }
    match translate(cwd, map) {
        Some(host) => host,
        None => PathBuf::from(cwd),
    }
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
        return Some(if path == "." { host.clone() } else { host.join(path) });
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
    Some(if rest.is_empty() { host.clone() } else { host.join(rest) })
}

impl process::Host for ComponentState {}

impl process::HostCommand for ComponentState {
    fn new(&mut self, argv: Vec<String>) -> Result<Resource<CommandState>> {
        self.granted("process spawning")?;
        if argv.is_empty() {
            return Err(format_err!("command: empty argv"));
        }
        self.table
            .push(CommandState {
                argv,
                cwd: None,
                inherit_stdio: false,
            })
            .context("failed to push the command resource")
    }

    fn cwd(&mut self, this: Resource<CommandState>, path: String) -> Result<()> {
        self.table.get_mut(&this).context("command")?.cwd = Some(path);
        Ok(())
    }

    fn inherit_stdio(&mut self, this: Resource<CommandState>) -> Result<()> {
        self.table.get_mut(&this).context("command")?.inherit_stdio = true;
        Ok(())
    }

    fn spawn(
        &mut self,
        this: Resource<CommandState>,
    ) -> Result<std::result::Result<Resource<ProcessState>, String>> {
        let path_map = self.granted("process spawning")?.path_map.clone();
        let cmd = self.table.get(&this).context("command")?;
        let argv = cmd.argv.clone();
        let cwd = cmd.cwd.clone();
        let inherit_stdio = cmd.inherit_stdio;
        // The child is spawned here rather than inside the worker
        // thread so its handle is reachable for a deadline to kill.
        // Both pipes are read on their own threads: a child that fills
        // one while the parent reads the other would otherwise deadlock.
        let t0 = Instant::now();
        let mut command = std::process::Command::new(&argv[0]);
        command.args(&argv[1..]);
        if inherit_stdio {
            command
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit());
        } else {
            command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
        }
        if let Some(cwd) = &cwd {
            command.current_dir(translate_cwd(cwd, &path_map));
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => return Ok(Err(format!("{}: {e}", argv[0]))),
        };
        let out = child.stdout.take();
        let err = child.stderr.take();
        let shared = Arc::new(Mutex::new(Some(child)));
        let worker_child = shared.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let out_t = drain(out);
            let err_t = drain(err);
            // Poll rather than block in `wait()`: the lock has to be
            // free between polls, or a deadline could never acquire it
            // to kill the child it is waiting on.
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
                std::thread::sleep(Duration::from_millis(2));
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
                Some(Err(e)) => Err(format!("waiting for the process: {e}")),
                None => Err("the process handle was taken".to_string()),
            });
        });
        let proc = self
            .table
            .push(ProcessState {
                pending: Some(Pending { rx, child: shared }),
                done: None,
            })
            .context("failed to push the process resource")?;
        Ok(Ok(proc))
    }

    fn drop(&mut self, rep: Resource<CommandState>) -> Result<()> {
        self.table.delete(rep).context("command")?;
        Ok(())
    }
}

impl ProcessState {
    /// Waits (once), killing the child when `timeout` elapses; the
    /// result it then produces is flagged `timed_out`. Waiting again
    /// returns the same cached result.
    fn finish(&mut self, timeout: Option<Duration>) -> std::result::Result<&Finished, String> {
        if let Some(pending) = self.pending.take() {
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
                            .recv_timeout(Duration::from_secs(2))
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
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        (Err("process wait thread vanished".to_string()), false)
                    }
                },
                None => (
                    pending
                        .rx
                        .recv()
                        .unwrap_or_else(|_| Err("process wait thread vanished".to_string())),
                    false,
                ),
            };
            self.done = Some(result.map(|mut fin| {
                fin.timed_out = killed;
                fin
            }));
        }
        match &self.done {
            Some(Ok(fin)) => Ok(fin),
            Some(Err(msg)) => Err(msg.clone()),
            None => Err("process in invalid state".to_string()),
        }
    }
}

impl process::HostProcess for ComponentState {
    fn wait(&mut self, this: Resource<ProcessState>, millis: i64) -> Result<process::Finished> {
        // A non-positive deadline means "no deadline", so a caller can
        // disable its timeout without branching.
        let timeout = if millis > 0 {
            Some(Duration::from_millis(millis as u64))
        } else {
            None
        };
        let state = self.table.get_mut(&this).context("process")?;
        let fin = state.finish(timeout).map_err(|msg| format_err!("wait: {msg}"))?;
        Ok(process::Finished {
            exit_code: fin.exit_code,
            stdout: fin.stdout.clone(),
            stderr: fin.stderr.clone(),
            wall_nanos: fin.wall_nanos,
            timed_out: fin.timed_out,
        })
    }

    fn drop(&mut self, rep: Resource<ProcessState>) -> Result<()> {
        self.table.delete(rep).context("process")?;
        Ok(())
    }
}

// ============================================================================
// zena-cli:host/wasm
// ============================================================================

/// How a run ended. The numbers are what the WIT enum carries.
#[derive(Clone, Copy)]
pub(crate) enum Outcome {
    Returned,
    Trapped,
    TimedOut,
    Failed,
    Exited,
}

impl From<Outcome> for wasm::Outcome {
    fn from(o: Outcome) -> wasm::Outcome {
        match o {
            Outcome::Returned => wasm::Outcome::Returned,
            Outcome::Trapped => wasm::Outcome::Trapped,
            Outcome::TimedOut => wasm::Outcome::TimedOut,
            Outcome::Failed => wasm::Outcome::Failed,
            Outcome::Exited => wasm::Outcome::Exited,
        }
    }
}

/// What a finished run reports.
pub(crate) struct RunFinished {
    pub(crate) outcome: Outcome,
    pub(crate) exit_code: i32,
    pub(crate) result_text: String,
    pub(crate) message: String,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) call_nanos: i64,
}

impl RunFinished {
    pub(crate) fn failed(message: String) -> RunFinished {
        RunFinished {
            outcome: Outcome::Failed,
            exit_code: -1,
            result_text: String::new(),
            message,
            stdout: Vec::new(),
            stderr: Vec::new(),
            call_nanos: 0,
        }
    }

    fn to_wit(&self) -> wasm::RunResult {
        wasm::RunResult {
            outcome: self.outcome.into(),
            exit_code: self.exit_code,
            result_text: self.result_text.clone(),
            message: self.message.clone(),
            stdout: self.stdout.clone(),
            stderr: self.stderr.clone(),
            call_nanos: self.call_nanos,
        }
    }
}

/// A run in progress, then its result.
pub struct RunState {
    rx: Option<std::sync::mpsc::Receiver<RunFinished>>,
    done: Option<RunFinished>,
}

/// Everything a run needs, with the caller's paths already translated
/// to the host's.
pub struct RunConfig {
    pub path: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub inherit_env: bool,
    /// (directory in the run's view, host directory)
    pub dirs: PathMap,
    pub invoke: String,
    pub inherit_stdio: bool,
    pub grant: bool,
    pub timeout: Option<Duration>,
    /// Run on a debug engine: no inlining, so backtraces name every
    /// function.
    pub debug: bool,
}

impl wasm::Host for ComponentState {
    fn precompile(&mut self, path: String, debug: bool) -> Result<String> {
        let grant = self.granted("running components")?;
        Ok(match translate(&path, &grant.path_map) {
            Some(host) => {
                if crate::core_module::is_core_module_file(&host).unwrap_or(false) {
                    return Ok(match precompile_core_module(&host, debug) {
                        Ok(()) => String::new(),
                        Err(e) => format!("{e:#}"),
                    });
                }
                match precompile_component(&host, debug) {
                    Ok(()) => String::new(),
                    Err(e) => format!("{e:#}"),
                }
            }
            None => format!("{path} is outside every directory this program can reach"),
        })
    }
}

impl wasm::HostRun for ComponentState {
    fn new(&mut self, path: String, options: wasm::RunOptions) -> Result<Resource<RunState>> {
        let grant = self.granted("running components")?;
        // Paths are translated here, on the caller's side, so a refused
        // path is reported against the caller's own view of the file
        // system.
        let mut refused: Option<String> = None;
        let module_path = translate(&path, &grant.path_map);
        if module_path.is_none() {
            refused = Some(format!("{path} is outside every directory this program can reach"));
        }
        let mut dirs: PathMap = Vec::new();
        for mapping in &options.dirs {
            match translate(&mapping.source, &grant.path_map) {
                Some(host) => dirs.push((mapping.target.clone(), host)),
                None => {
                    refused.get_or_insert_with(|| {
                        format!(
                            "directory {} is outside every directory this program can reach",
                            mapping.source
                        )
                    });
                }
            }
        }
        let config = RunConfig {
            path: module_path.unwrap_or_default(),
            args: options.args,
            env: options.env,
            inherit_env: options.inherit_env,
            dirs,
            invoke: options.invoke,
            inherit_stdio: options.inherit_stdio,
            grant: options.grant,
            timeout: if options.timeout_nanos > 0 {
                Some(Duration::from_nanos(options.timeout_nanos as u64))
            } else {
                None
            },
            debug: options.debug,
        };
        let same_as_caller = config.debug == grant.debug;
        let engine = self.engine.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let finished = match refused {
                Some(message) => RunFinished::failed(message),
                None => {
                    // A time limit needs the engine whose code checks the
                    // epoch. Without one, the run shares its caller's
                    // engine, unless it asked for a different debug
                    // setting.
                    let engine = if config.timeout.is_some() {
                        crate::engine::interruptible_component_engine(config.debug)
                    } else if same_as_caller {
                        Ok(engine)
                    } else {
                        crate::engine::shared_component_engine(config.debug)
                    };
                    match engine {
                        Ok(engine) => run(&engine, &config),
                        Err(e) => RunFinished::failed(format!("{e:#}")),
                    }
                }
            };
            let _ = tx.send(finished);
        });
        self.table
            .push(RunState {
                rx: Some(rx),
                done: None,
            })
            .context("failed to push the run resource")
    }

    fn wait(&mut self, this: Resource<RunState>) -> Result<wasm::RunResult> {
        let state = self.table.get_mut(&this).context("run")?;
        if let Some(rx) = state.rx.take() {
            state.done = Some(rx.recv().unwrap_or_else(|_| {
                RunFinished::failed("the run's thread vanished".to_string())
            }));
        }
        Ok(state
            .done
            .as_ref()
            .map(RunFinished::to_wit)
            .unwrap_or_else(|| RunFinished::failed("run in invalid state".to_string()).to_wit()))
    }

    fn drop(&mut self, rep: Resource<RunState>) -> Result<()> {
        self.table.delete(rep).context("run")?;
        Ok(())
    }
}

/// Loads, instantiates and calls one component, and reports how it ended.
fn run(engine: &Engine, config: &RunConfig) -> RunFinished {
    let path = &config.path;
    // Checked first because the cache takes a lock file beside the path
    // before it reads the component, and would leave one next to a
    // component that does not exist.
    if !path.is_file() {
        return RunFinished::failed(format!("no such file: {}", path.display()));
    }
    if crate::core_module::is_core_module_file(path).unwrap_or(false) {
        return crate::core_module::run(engine, config);
    }
    let interruptible = crate::engine::is_interruptible(engine);
    let component =
        match crate::cache::load_component_variant(engine, path, config.debug, interruptible) {
            Ok(c) => c,
            Err(e) => return RunFinished::failed(format!("{e:#}")),
        };
    let mut wasi = WasiCtxBuilder::new();
    wasi.args(&config.args);
    if config.inherit_env {
        wasi.inherit_env();
    }
    for (key, value) in &config.env {
        wasi.env(key, value);
    }
    for (guest, host) in &config.dirs {
        if let Err(e) = wasi.preopened_dir(host, guest, FsPerms::ReadWrite) {
            return RunFinished::failed(format!("preopening {}: {e:#}", host.display()));
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
    let grant = if config.grant {
        Some(Grant {
            path_map: config.dirs.clone(),
            debug: config.debug,
        })
    } else {
        None
    };
    let mut store = Store::new(engine, ComponentState::new(engine, wasi.build(), grant));
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
    let linker = match linker(engine) {
        Ok(l) => l,
        Err(e) => return RunFinished::failed(format!("{e:#}")),
    };
    let t0 = Instant::now();
    let called = run_main(&mut store, &linker, &component, &config.invoke);
    let call_nanos = t0.elapsed().as_nanos() as i64;
    let (outcome, exit_code, result_text, message) = match called {
        Ok(results) => {
            // A Zena program's `main` returns its status.
            let code = match results.first() {
                Some(Val::S32(code)) => *code,
                Some(Val::U32(code)) => *code as i32,
                _ => 0,
            };
            let text = results.first().map(format_val).unwrap_or_default();
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
    RunFinished {
        outcome,
        exit_code,
        result_text,
        message,
        stdout,
        stderr,
        call_nanos,
    }
}

/// Formats a component value the way `zena run` prints a program's
/// return value: scalars plainly, anything else in its debug form.
pub fn format_val(val: &Val) -> String {
    match val {
        Val::Bool(b) => b.to_string(),
        Val::S8(i) => i.to_string(),
        Val::U8(i) => i.to_string(),
        Val::S16(i) => i.to_string(),
        Val::U16(i) => i.to_string(),
        Val::S32(i) => i.to_string(),
        Val::U32(i) => i.to_string(),
        Val::S64(i) => i.to_string(),
        Val::U64(i) => i.to_string(),
        Val::Float32(f) => f.to_string(),
        Val::Float64(f) => f.to_string(),
        Val::String(s) => s.clone(),
        other => format!("{other:?}"),
    }
}

/// The exit status a component's `main` returned: its first result when
/// that is an integer, else 0.
pub fn exit_status(results: &[Val]) -> i32 {
    match results.first() {
        Some(Val::S32(code)) => *code,
        Some(Val::U32(code)) => *code as i32,
        Some(Val::S64(code)) => *code as i32,
        Some(Val::U64(code)) => *code as i32,
        _ => 0,
    }
}

/// Writes a component's `.cwasm` beside it now, so later runs skip
/// Cranelift.
fn precompile_component(path: &Path, debug: bool) -> anyhow::Result<()> {
    if !path.is_file() {
        return Err(anyhow::anyhow!("no such file: {}", path.display()));
    }
    let engine = crate::engine::shared_component_engine(debug)?;
    crate::cache::precompile_component(&engine, path, debug)?;
    Ok(())
}

/// [`precompile_component`], for a core module. It compiles on the same
/// engine, whose settings are a superset of what a core module needs,
/// so its cache file is the one a later run reads.
fn precompile_core_module(path: &Path, debug: bool) -> anyhow::Result<()> {
    let engine = crate::engine::shared_component_engine(debug)?;
    crate::cache::precompile_module(&engine, path, debug)?;
    Ok(())
}
