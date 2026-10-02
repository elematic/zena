//! Loading a ZenaFX component and running it as a scene.
//!
//! The "Runtime linking" path at its smallest: compile a component, build a
//! `Linker` for it, bind its `zenafx:host` imports, instantiate, and call its
//! entry. Fetching over the network, caching by content hash and the policy
//! check come later.
//!
//! The entry is `main: async func()`, so its lift carries a callback and its
//! task can report WAIT. That is the only way the host can re-enter the
//! component to run work it started — a `sleep` from `zena:time`, a fetch,
//! anything parked on a waitable — and it is why the program's own `main` may
//! be an ordinary synchronous function that starts work and returns.
//!
//! ## Why the component runs on its own thread
//!
//! Driving a parked task means being inside `Store::run_concurrent`, which
//! holds `&mut Store` until the future it was given completes. Two
//! consequences follow, and together they decide the shape of this module:
//!
//! - The call has to be long-lived. Slicing it per frame does not work: a
//!   timeout around `run_concurrent` never fires, because its poll loop does
//!   not yield to the executor between guest steps, so the frame thread simply
//!   stops.
//! - Nothing else can touch the store while it runs. So the tree and the text
//!   engine live behind locks in [`UiHostState`] rather than inside the store,
//!   and a frame draws from those without entering the component at all.
//!
//! The window therefore keeps the main thread (winit requires it on macOS) and
//! the component gets a worker, which is the arrangement `zfx`'s webgpu path
//! already uses.

pub mod link;

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

use crate::ui::scene::Scene as RetainedScene;
use crate::ui::surface::Scene;
use crate::ui::text::TextEngine;
use crate::ui::types::{Color, Command, FrameEvent, Size};
use link::{UiHostState, add_host_to_linker};

/// The interface a component exports to hand over what it draws.
const APP: &str = "zenafx:host/app@0.1.0";

/// How long `load` waits for the component to say its tree is ready.
///
/// Bounded so a component that never does fails to load rather than hanging
/// the window.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10);

/// How often `load` looks to see whether the component is ready.
const INSTALL_POLL: Duration = Duration::from_millis(1);

/// The engine a ZenaFX component runs on.
///
/// Zena's own settings from `zena-runtime` — GC, exceptions, typed function
/// references, tail calls — plus the component model and the concurrency
/// support `Store::run_concurrent` needs. Concurrency is what makes the entry's
/// `async func` lift mean anything: its task is what can report WAIT, and
/// without that the host would never re-enter the component to finish what it
/// started.
pub fn engine(debug: bool) -> Result<Engine> {
    let mut config: Config = zena_runtime::engine::config(debug);
    config.wasm_component_model(true);
    config.concurrency_support(true);
    Engine::new(&config).map_err(|e| anyhow!("could not create the wasmtime engine: {e}"))
}

/// The component a window shows, and the tree it installed.
///
/// Holds no store: the worker thread owns it for the component's lifetime.
pub struct GuestScene {
    /// The same tree the component writes, read here without the store.
    scene: Arc<Mutex<RetainedScene>>,
    text: Arc<Mutex<TextEngine>>,
    entries: Arc<AtomicU32>,
    /// Cleared when the component's task finishes, which is how a static
    /// component stops owing frames.
    running: Arc<AtomicBool>,
    background: Color,
    /// Dropping it asks the worker to stop; the component's task is dropped
    /// with the store on the way out.
    _shutdown: mpsc::Sender<()>,
}

impl GuestScene {
    /// Compile and instantiate the component at `path`, run its entry, and
    /// return once it has installed its tree.
    ///
    /// The entry runs on a worker thread and stays there: `main` returning is
    /// not the end of it, because the work `main` started continues on the
    /// callback re-entries that the worker's `run_concurrent` delivers.
    pub fn load(engine: &Engine, path: &Path) -> Result<Self> {
        let state = UiHostState::new();
        let (scene, text, entries, ready) = (
            state.scene.clone(),
            state.text.clone(),
            state.guest_entries.clone(),
            state.ready.clone(),
        );
        let running = Arc::new(AtomicBool::new(true));

        let component = Component::from_file(engine, path)
            .map_err(|e| anyhow!("could not load a component from {}: {e:?}", path.display()))?;

        // `failed` carries a trap back to this thread; `shutdown` is how
        // dropping the scene ends the worker.
        let (failed_tx, failed_rx) = mpsc::channel::<anyhow::Error>();
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let engine = engine.clone();
        let display = path.display().to_string();
        let worker_running = running.clone();
        std::thread::Builder::new()
            .name("zenafx-component".into())
            .spawn(move || {
                let outcome = run_component(
                    &engine,
                    component,
                    state,
                    &display,
                    &worker_running,
                    shutdown_rx,
                );
                if let Err(e) = outcome {
                    let _ = failed_tx.send(e);
                }
                worker_running.store(false, Ordering::Relaxed);
            })
            .map_err(|e| anyhow!("could not start the component thread: {e}"))?;

        // Wait for the component's `ready` rather than for the entry call: the
        // call resolves when the task finishes, which for a component that
        // keeps working is never. `ready` is the component saying the tree it
        // has built is worth drawing, so it is also the point at which the
        // first frame is complete.
        let deadline = std::time::Instant::now() + INSTALL_TIMEOUT;
        loop {
            if let Ok(e) = failed_rx.try_recv() {
                return Err(e);
            }
            if ready.load(Ordering::Relaxed) {
                break;
            }
            if std::time::Instant::now() > deadline {
                return Err(anyhow!(
                    "{} did not call `ready` within {INSTALL_TIMEOUT:?}, so the \
                     host never learned its tree was complete",
                    path.display()
                ));
            }
            std::thread::sleep(INSTALL_POLL);
        }

        Ok(Self {
            scene,
            text,
            entries,
            running,
            background: Color::rgb(1.0, 1.0, 1.0),
            _shutdown: shutdown_tx,
        })
    }

    /// Every entry into the component since this scene was created. A
    /// retained tree leaves it at one, however often the window is resized:
    /// re-entering the entry's task through its callback is not another call
    /// to `main`.
    pub fn guest_entries(&self) -> u32 {
        self.entries.load(Ordering::Relaxed)
    }
}

/// Instantiate and run the component.
///
/// One `run_concurrent` for the component's whole life: it calls `main` and
/// then parks, which is what keeps wasmtime delivering callback re-entries to
/// the work `main` started. The call itself resolves only when the task
/// finishes — never, for a component that keeps timers armed — so `running` is
/// cleared there rather than by the thread ending.
fn run_component(
    engine: &Engine,
    component: Component,
    state: UiHostState,
    display: &str,
    running: &Arc<AtomicBool>,
    shutdown: mpsc::Receiver<()>,
) -> Result<()> {
    let mut linker: Linker<UiHostState> = Linker::new(engine);
    add_host_to_linker(&mut linker)?;

    let entries = state.guest_entries.clone();
    let mut store = Store::new(engine, state);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| anyhow!("could not create a tokio runtime: {e}"))?;

    rt.block_on(async {
        // Instantiation is where a missing or mistyped host import surfaces:
        // the linker typechecks what it defined against what the component
        // asked for.
        let instance = linker
            .instantiate_async(&mut store, &component)
            .await
            .map_err(|e| anyhow!("could not instantiate {display}: {e:?}"))?;

        let app = instance
            .get_export_index(&mut store, None, APP)
            .ok_or_else(|| anyhow!("{display} does not export {APP}"))?;
        let main_idx = instance
            .get_export_index(&mut store, Some(&app), "main")
            .ok_or_else(|| anyhow!("{display} exports no `main`"))?;
        let main = instance
            .get_typed_func::<(), ()>(&mut store, &main_idx)
            .map_err(|e| anyhow!("{display}'s `main` has the wrong type: {e:?}"))?;

        let trap = store
            .run_concurrent(async |accessor| {
                entries.fetch_add(1, Ordering::Relaxed);
                let called = main.call_concurrent(accessor, ()).await;
                // Getting here means the task finished, so nothing is
                // outstanding and the window stops being owed frames.
                running.store(false, Ordering::Relaxed);
                if let Err(e) = called {
                    return Some(anyhow!("{display}'s `main` trapped: {e:?}"));
                }
                // Park while the component still has work. The store's event
                // loop keeps running while this is pending, which is what
                // delivers a sleep's completion to the component's task.
                while shutdown.try_recv() != Err(mpsc::TryRecvError::Disconnected) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                None
            })
            .await
            .map_err(|e| anyhow!("{display} trapped: {e:?}"))?;
        match trap {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
}

impl Scene for GuestScene {
    /// Solve and paint the tree the component installed.
    ///
    /// Never enters the component: the worker thread drives it, and this reads
    /// the tree the component writes. So a resize costs a solve and a paint.
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        let size = Size {
            width: frame.width as f32,
            height: frame.height as f32,
        };
        let (scene, text) = (self.scene.clone(), self.text.clone());
        let mut scene = scene.lock().unwrap();
        let mut text = text.lock().unwrap();
        scene.draw(size, &mut text)
    }

    fn text(&self) -> Arc<Mutex<TextEngine>> {
        self.text.clone()
    }

    fn background(&self) -> Color {
        self.background
    }

    /// A component owes another frame while its tree is dirty, or while its
    /// task is still running — it can write a binding at any time.
    fn wants_another_frame(&self) -> bool {
        self.running.load(Ordering::Relaxed) || self.scene.lock().unwrap().dirty
    }
}
