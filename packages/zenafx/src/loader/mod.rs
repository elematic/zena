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
pub mod listeners;

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

use crate::ui::clipboard::{Clipboard, Memory};
use crate::ui::events::{Delivery, KeyDefault, KeyDelivery, KeyEvent, PointerInput};
use crate::ui::scene::{Cursor, Scene as RetainedScene};
use crate::ui::surface::{Scene, Wake};
use crate::ui::text::TextEngine;
use crate::ui::types::{Color, Command, FrameEvent, Size};
use link::{UiHostState, add_host_to_linker};
use listeners::{Heard, Listeners, Offered};

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
    background: Color,
    /// Where the window thread hands the worker what an input leads to. The
    /// worker writes each event to its listener's stream and waits for the
    /// answer, which this thread must not do. Dropping it asks the worker to
    /// stop, and the component's task is dropped with the store on the way
    /// out.
    deliveries: UnboundedSender<Input>,
    /// Inputs handed to the worker that have not been through all of their
    /// listeners yet.
    undelivered: Arc<AtomicU32>,
    /// The host's end of each listener's stream, for counting what was
    /// written to them.
    listeners: Listeners,
    /// Shared with the host functions, which call it when the component
    /// writes the tree.
    wake: Arc<Mutex<Option<Wake>>>,
    /// Where copied text goes and pasted text comes from. Only this thread
    /// uses it, and no component is handed it.
    clipboard: Box<dyn Clipboard>,
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
        let (scene, text, entries, ready, wake, listeners) = (
            state.scene.clone(),
            state.text.clone(),
            state.guest_entries.clone(),
            state.ready.clone(),
            state.wake.clone(),
            state.listeners.clone(),
        );
        let undelivered = Arc::new(AtomicU32::new(0));

        let component = Component::from_file(engine, path)
            .map_err(|e| anyhow!("could not load a component from {}: {e:?}", path.display()))?;

        // `failed` carries a trap back to this thread. Dropping the sending
        // end of `deliveries` is how dropping the scene ends the worker.
        let (failed_tx, failed_rx) = mpsc::channel::<anyhow::Error>();
        let (deliveries_tx, deliveries_rx) = unbounded_channel::<Input>();

        let engine = engine.clone();
        let display = path.display().to_string();
        let worker = Worker {
            display: path.display().to_string(),
            deliveries: deliveries_rx,
            undelivered: undelivered.clone(),
        };
        std::thread::Builder::new()
            .name("zenafx-component".into())
            .spawn(move || {
                if let Err(e) = run_component(&engine, component, state, worker) {
                    // Nobody is listening once `load` has returned, so a trap
                    // after that is said here or nowhere.
                    log::error!("{display} stopped: {e:?}");
                    let _ = failed_tx.send(e);
                }
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
            background: Color::rgb(1.0, 1.0, 1.0),
            deliveries: deliveries_tx,
            undelivered,
            listeners,
            wake,
            clipboard: Box::new(Memory::default()),
        })
    }

    /// Give one key to the listeners it reaches, or act on it here if it
    /// reaches none. Returns whether a frame is owed.
    fn dispatch(&self, event: KeyEvent) -> bool {
        let mut scene = self.scene.lock().unwrap();
        scene.notice(&event);
        let delivery = scene.key(event);
        if delivery.listeners.is_empty() {
            return act_on(&delivery.event, &mut scene);
        }
        drop(scene);
        self.send(Input::Key(delivery));
        false
    }

    /// Copy to and paste from `clipboard` from now on. A scene starts with
    /// a clipboard of its own, which is right for one with no window. The
    /// program that opens a window gives it the platform's.
    pub fn use_clipboard(&mut self, clipboard: Box<dyn Clipboard>) {
        self.clipboard = clipboard;
    }

    /// The clipboard this scene copies to and pastes from.
    pub fn clipboard(&mut self) -> &mut dyn Clipboard {
        self.clipboard.as_mut()
    }

    /// Every call into the component since this scene was created. `main` is
    /// the only function the host calls, so a retained tree leaves this at
    /// one however often the window is resized. Re-entering the call's task
    /// through its callback, which is how a timer or an event on a
    /// listener's stream reaches the component, is not another call.
    pub fn guest_entries(&self) -> u32 {
        self.entries.load(Ordering::Relaxed)
    }

    /// How many events have been written to listeners' streams. Each one
    /// wakes the component, so a pointer crossing nodes that hear nothing
    /// leaves this where it was.
    pub fn events_delivered(&self) -> u32 {
        self.listeners.offered()
    }

    /// How many times the component has written the tree, with a `render`
    /// or a `content`.
    pub fn writes(&self) -> u32 {
        self.scene.lock().unwrap().writes
    }

    /// How many inputs have been handed to the component's thread and not
    /// yet been through all of their listeners.
    ///
    /// An input is delivered some time after [`Scene::pointer`] returns,
    /// because the window's thread does not wait on a component. This is how
    /// a test finds out that the listeners have run.
    pub fn undelivered(&self) -> u32 {
        self.undelivered.load(Ordering::Relaxed)
    }

    /// Give the component's thread the calls an input or a frame led to.
    fn hand_over(&self, deliveries: Vec<Delivery>) {
        if !deliveries.is_empty() {
            self.send(Input::Pointer(deliveries));
        }
    }

    /// Give the component's thread something to deliver.
    fn send(&self, input: Input) {
        self.undelivered.fetch_add(1, Ordering::Relaxed);
        if self.deliveries.send(input).is_err() {
            // The component's thread has ended, which it reported when it
            // did. Nothing will be delivered again.
            self.undelivered.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// What the component's thread is given besides the component.
struct Worker {
    /// What to call the component in a message.
    display: String,
    deliveries: UnboundedReceiver<Input>,
    undelivered: Arc<AtomicU32>,
}

/// Instantiate and run the component.
///
/// One `run_concurrent` for the component's whole life: it calls `main` and
/// then stays, writing each pointer input's events to the streams of the
/// listeners it reaches. Staying is also what keeps wasmtime delivering
/// callback re-entries to the work `main` started, a read of a listener's
/// stream among it. The call to `main` resolves only when its task finishes,
/// which for a component with a timer armed or a stream being read is never.
fn run_component(
    engine: &Engine,
    component: Component,
    state: UiHostState,
    worker: Worker,
) -> Result<()> {
    let Worker {
        display,
        mut deliveries,
        undelivered,
    } = worker;
    let display = display.as_str();

    let mut linker: Linker<UiHostState> = Linker::new(engine);
    add_host_to_linker(&mut linker)?;

    let entries = state.guest_entries.clone();
    let listeners = state.listeners.clone();
    let (scene, wake) = (state.scene.clone(), state.wake.clone());
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
                // Resolves only if `main` traps. A `main` that finishes has
                // left nothing outstanding, so there is nothing more for this
                // thread to drive, and it stays only until the scene is
                // dropped.
                let entry = async {
                    entries.fetch_add(1, Ordering::Relaxed);
                    match main.call_concurrent(accessor, ()).await {
                        Err(e) => anyhow!("{display}'s `main` trapped: {e:?}"),
                        Ok(()) => std::future::pending().await,
                    }
                };
                // Resolves when the scene is dropped. One input at a time, in
                // the order they arrived: a listener sees the tree as the
                // listeners before it left it.
                let inputs = async {
                    while let Some(input) = deliveries.recv().await {
                        match input {
                            Input::Pointer(input) => {
                                deliver(&listeners, &scene, &wake, &input).await
                            }
                            Input::Key(key) => deliver_key(&listeners, &scene, &wake, key).await,
                        }
                        undelivered.fetch_sub(1, Ordering::Relaxed);
                    }
                };
                tokio::select! {
                    trapped = entry => Some(trapped),
                    () = inputs => None,
                }
            })
            .await
            .map_err(|e| anyhow!("{display} trapped: {e:?}"))?;
        match trap {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
}

/// Write one input's events to the streams of the listeners it reaches.
///
/// A `down`, `up` or `move` goes to one listener at a time. The next is
/// offered it only once this one has answered, by dropping the reply that
/// came with it, and not at all if the answer was to stop. The wait is on
/// the component and has no limit, as a call into it would have none: a
/// component that does not read its streams stalls its own input and nobody
/// else's, because this is its own thread.
///
/// A listener whose answer is to capture the pointer has it captured here,
/// as soon as the answer arrives. Capturing the pointer can change how its
/// node looks, which asks the window for a frame.
///
/// `enter` and `leave` are written without waiting. Nothing a listener does
/// with one changes who else hears it.
async fn deliver(
    listeners: &Listeners,
    scene: &Mutex<RetainedScene>,
    wake: &Mutex<Option<Wake>>,
    input: &[Delivery],
) {
    for delivery in input {
        for call in &delivery.calls {
            if !delivery.stops_when_handled {
                listeners.offer(
                    call.listener,
                    Offered {
                        event: Heard::Pointer(call.event),
                        answered: None,
                    },
                );
                continue;
            }
            let (answered, answer) = tokio::sync::oneshot::channel();
            let offered = Offered {
                event: Heard::Pointer(call.event),
                answered: Some(answered),
            };
            // A listener whose stream has gone, or goes before it answers,
            // stopped nothing and captures nothing.
            if !listeners.offer(call.listener, offered) {
                continue;
            }
            let answer = answer.await.unwrap_or_default();
            if answer.capture {
                let restyled = {
                    let mut scene = scene.lock().unwrap();
                    scene.capture(call.listener);
                    // A listener that captures the pointer is starting a drag
                    // of its own. The press began a selection before any
                    // listener had answered, so that is put back.
                    scene.cancel_selecting();
                    scene.dirty
                };
                if let (true, Some(wake)) = (restyled, wake.lock().unwrap().as_ref()) {
                    wake();
                }
            }
            if answer.stop_propagation {
                break;
            }
        }
    }
}

/// Offer a key to the listeners it reaches, one at a time, and then do what
/// the scene does with the key, unless a listener called `prevent-default`.
///
/// `Tab` moves the focus, and it is done here and not when the key arrives
/// because a listener may want the key for itself: an editor that indents
/// with `Tab` prevents the default, and the focus stays where it is.
///
/// Stopping propagation and preventing the default are separate answers, as
/// they are in the DOM. A listener that stops propagation keeps later
/// listeners from hearing the key, and the focus still moves.
async fn deliver_key(
    listeners: &Listeners,
    scene: &Mutex<RetainedScene>,
    wake: &Mutex<Option<Wake>>,
    key: KeyDelivery,
) {
    let mut prevented = false;
    for listener in &key.listeners {
        let (answered, answer) = tokio::sync::oneshot::channel();
        let offered = Offered {
            event: Heard::Key(key.event.clone()),
            answered: Some(answered),
        };
        if !listeners.offer(*listener, offered) {
            continue;
        }
        let answer = answer.await.unwrap_or_default();
        prevented |= answer.prevent_default;
        if answer.stop_propagation {
            break;
        }
    }
    if prevented {
        return;
    }
    if act_on(&key.event, &mut scene.lock().unwrap()) {
        if let Some(wake) = wake.lock().unwrap().as_ref() {
            wake();
        }
    }
}

/// Do what the scene does with a key whose default no listener prevented.
/// Returns whether a frame is owed for it.
fn act_on(key: &KeyEvent, scene: &mut RetainedScene) -> bool {
    match key.default_action() {
        KeyDefault::None => false,
        KeyDefault::MoveFocus { backwards } => {
            scene.move_focus(backwards);
            scene.dirty
        }
        KeyDefault::SelectAll => {
            scene.select_all_text();
            scene.dirty
        }
    }
}

/// What the window's thread hands the component's thread to deliver.
enum Input {
    /// What a pointer input, or a frame, found for the pointer's listeners.
    Pointer(Vec<Delivery>),
    /// A key, and the listeners it reaches.
    Key(KeyDelivery),
}

impl Scene for GuestScene {
    /// Solve and paint the tree the component installed.
    ///
    /// Never enters the component: the worker thread drives it, and this reads
    /// the tree the component writes. So a resize costs a solve and a paint.
    ///
    /// A frame can find that the tree moved under a pointer that did not. It
    /// draws what the pointer is over now, and the `enter` and `leave` calls
    /// that follow from it go to the component's thread as an input's do.
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        let size = Size {
            width: frame.width as f32,
            height: frame.height as f32,
        };
        let (commands, owed) = {
            let mut scene = self.scene.lock().unwrap();
            let commands = scene.draw(size, &mut self.text.lock().unwrap());
            (commands, scene.take_owed())
        };
        self.hand_over(owed);
        commands
    }

    fn text(&self) -> Arc<Mutex<TextEngine>> {
        self.text.clone()
    }

    fn background(&self) -> Color {
        self.background
    }

    /// Work out which listeners the input reaches and hand them to the
    /// component's thread to write to.
    ///
    /// Working it out needs only the tree, which is here, so an input that
    /// reaches no listener ends on this thread and the component is never
    /// woken.
    ///
    /// Answers whether the input changed how something looks, which it can
    /// by moving a node into or out of a state a template gave a look for.
    /// That needs a frame and wakes nobody. A listener that changes the tree
    /// asks for its frame itself, through the [`Wake`] the window gave this
    /// scene.
    fn pointer(&mut self, input: PointerInput) -> bool {
        let (deliveries, restyled) = {
            let mut scene = self.scene.lock().unwrap();
            let deliveries = scene.pointer(input);
            // What the pointer does to the selection is the scene's too, and
            // needs the shaped text to find a place in it.
            scene.select_with(input, &self.text.lock().unwrap());
            (deliveries, scene.dirty)
        };
        self.hand_over(deliveries);
        restyled
    }

    /// Work out which listeners a key reaches and hand them to the
    /// component's thread, which does what the scene does with the key
    /// afterwards unless one of them prevented it.
    ///
    /// A key that reaches no listener is acted on here, and the answer says
    /// whether that owes a frame: `Tab` moves the focus in a component that
    /// listens for no keys at all without waking it.
    ///
    /// The clipboard's three shortcuts are the host's, and are done here
    /// before any listener hears the key:
    ///
    /// - Control or Meta with `c` copies what is selected, wherever it is.
    /// - With `x` it copies too. Removing what was cut is left to the text
    ///   field that hears the key, since the text is the field's.
    /// - With `v`, the key is followed by a second one named `Paste` whose
    ///   `text` is what is on the clipboard. A text field inserts a key's
    ///   text whatever the key, so a field needs nothing more to be pasted
    ///   into, and no component is ever handed the clipboard.
    fn key(&mut self, event: KeyEvent) -> bool {
        let copies = event.is_shortcut('c') || event.is_shortcut('x');
        let pasted = match event.is_shortcut('v') {
            true => self.clipboard.read(),
            false => None,
        };
        if copies {
            let selected = self.scene.lock().unwrap().selected_text();
            if let Some(selected) = selected {
                self.clipboard.write(&selected);
            }
        }
        let mut owed = self.dispatch(event);
        if let Some(text) = pasted {
            owed |= self.dispatch(KeyEvent {
                down: true,
                key: "Paste".to_owned(),
                code: String::new(),
                modifiers: Default::default(),
                repeat: false,
                text: Some(text),
            });
        }
        owed
    }

    fn woken_by(&mut self, wake: Wake) {
        *self.wake.lock().unwrap() = Some(wake);
    }

    /// The cursor the tree names for what the pointer is over. The scene
    /// knows, so nothing is asked of the component.
    fn cursor(&self) -> Cursor {
        self.scene.lock().unwrap().cursor()
    }

    /// A component owes another frame while its tree is dirty.
    ///
    /// A component that is still running owes nothing on that account. It can
    /// write the tree at any time, and the write is what asks for a frame,
    /// through the [`Wake`]. A component reading a listener's stream is
    /// always still running, so asking for frames while it runs would redraw
    /// an idle window without pause.
    fn wants_another_frame(&self) -> bool {
        self.scene.lock().unwrap().dirty
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use super::*;
    use crate::ui::events::Modifiers;
    use crate::ui::scene::{Appearance, NodeDef, TemplateDef, TemplateRef};
    use crate::ui::types::{Layout, OwnBox};
    use listeners::{Answer, KeyDeliveryRecord};

    /// A scene of one node, which can have the focus and has not got it.
    fn focusable_scene() -> Arc<Mutex<RetainedScene>> {
        let mut text = TextEngine::new();
        let mut scene = RetainedScene::new();
        let root = scene.root();
        scene.render(
            root,
            &TemplateRef::Fresh(TemplateDef {
                id: 1,
                nodes: vec![NodeDef {
                    own_box: OwnBox::default(),
                    layout: Layout::default(),
                    appearance: Appearance::Nothing,
                    first_child: 0,
                    child_count: 0,
                    is_slot: false,
                    cursor: None,
                    focusable: true,
                    editable: false,
                    unselectable: false,
                }],
                bindings: vec![],
                states: vec![],
            }),
            &[],
            &mut text,
        );
        Arc::new(Mutex::new(scene))
    }

    /// Deliver `Tab` to one key listener for each of `answers`, in that
    /// order, each giving its answer to every key it is offered. Returns
    /// whether the focus moved, and how many keys each listener was offered.
    fn tab_answered_with(answers: &[Answer]) -> (bool, Vec<u32>) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime");
        runtime.block_on(async {
            let scene = focusable_scene();
            let listeners = Listeners::default();
            let mut ids = Vec::new();
            let mut heard = Vec::new();
            for answer in answers.iter().copied() {
                let (id, mut stream) = listeners.open::<KeyDeliveryRecord>(scene.clone());
                let count = Arc::new(AtomicU32::new(0));
                ids.push(id);
                heard.push(count.clone());
                // What a component does: read the stream, and answer.
                tokio::spawn(async move {
                    while let Some(offered) = stream.next_offered().await {
                        count.fetch_add(1, Ordering::Relaxed);
                        if let Some(answered) = offered.answered {
                            let _ = answered.send(answer);
                        }
                    }
                });
            }
            let tab = KeyEvent {
                down: true,
                key: "Tab".to_owned(),
                code: "Tab".to_owned(),
                modifiers: Modifiers::default(),
                repeat: false,
                text: None,
            };
            let key = KeyDelivery {
                event: tab,
                listeners: ids,
            };
            deliver_key(&listeners, &scene, &Mutex::new(None), key).await;
            let moved = scene.lock().unwrap().has_focus();
            let heard = heard.iter().map(|n| n.load(Ordering::Relaxed)).collect();
            (moved, heard)
        })
    }

    /// Listeners that pass a key on are each offered it, and the host then
    /// does what it does with the key.
    #[test]
    fn a_key_every_listener_passes_on_is_acted_on() {
        let pass = Answer::default();
        assert_eq!(tab_answered_with(&[pass, pass]), (true, vec![1, 1]));
    }

    /// Stopping propagation keeps the key from later listeners and changes
    /// nothing else: the focus still moves.
    #[test]
    fn stopping_propagation_does_not_prevent_the_default() {
        let stop = Answer {
            stop_propagation: true,
            ..Answer::default()
        };
        assert_eq!(
            tab_answered_with(&[stop, Answer::default()]),
            (true, vec![1, 0])
        );
    }

    /// Preventing the default keeps the focus where it is, and later
    /// listeners are still offered the key.
    #[test]
    fn preventing_the_default_does_not_stop_propagation() {
        let prevent = Answer {
            prevent_default: true,
            ..Answer::default()
        };
        assert_eq!(
            tab_answered_with(&[prevent, Answer::default()]),
            (false, vec![1, 1])
        );
    }
}
