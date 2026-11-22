//! Binding a component's `zenafx:host` imports to the host primitives.
//!
//! The loader defines every import itself rather than handing wasmtime a
//! generated `add_to_linker`, because "Runtime linking and import interposition"
//! in `docs/design/zenafx-ui.md`
//! wants each instance's imports decided per instance: a component gets the
//! interfaces the policy grants it and no others.

use anyhow::Result;
use wasmtime::StoreContextMut;
use wasmtime::component::{Linker, Resource, ResourceTable, ResourceType, StreamReader};
use wasmtime_wasi::clocks::{WasiClocksCtx, WasiClocksCtxView, WasiClocksView};

use crate::ui::layout::{measure_text, solve_with};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use super::listeners::{DeliveryRecord, HostReply, KeyDeliveryRecord, Listeners, Replies};
use crate::ui::events::{KeyListener, Listener, Phase, PointerKind, Scope};
use crate::ui::scene::{Hole, Scene, TemplateRef, TextSelection};
use crate::ui::surface::Wake;
use crate::ui::text::TextEngine;
use crate::ui::types::{Content, Measured, Node, Rect, Size, TextStyle};

/// What a `node` handle names.
///
/// A host resource's representation is a `u32` the host chooses, and the scene
/// id is already one, so the id *is* the representation and there is no table
/// to keep beside the tree. Nothing hangs off this type — it exists to give
/// `ResourceType::host` something to name, so that a `node` handle cannot be
/// confused with a handle of some other resource.
///
/// Two handles can therefore share a representation: a parent that asks for the
/// same slot twice gets two owned handles onto one node. That is sound here
/// because dropping a handle is not structural — see `resource node` in
/// `wit/zenafx.wit` — so the destructor has nothing to do and running it twice
/// does nothing twice.
pub struct HostNode;

/// What a ZenaFX window's host functions read and write.
///
/// The tree and the text engine sit behind locks rather than inside the
/// store, because an async entry's task holds `&mut Store` for as long as it
/// is parked: a frame could not read the scene out of the store while the
/// component waits on a timer. Holding them here lets the window draw from
/// the same tree the guest is writing.
pub struct UiHostState {
    pub text: Arc<Mutex<TextEngine>>,
    /// The retained tree. The component installs one when it starts, and a
    /// frame after that is a solve and a paint over this and nothing else.
    pub scene: Arc<Mutex<Scene>>,
    /// Every entry into the component since the scene was created. A
    /// retained tree should leave this at one while the window resizes.
    /// Shared for the same reason the scene is: the store it lives in is
    /// held by the entry's task.
    pub guest_entries: Arc<AtomicU32>,
    /// Set by the component's `ready`, which is how it says the tree it has
    /// built is worth drawing. The loader waits for it rather than for the
    /// entry call, which for a component that keeps working never returns.
    pub ready: Arc<AtomicBool>,
    /// How to ask the window for a frame, once there is a window to ask. The
    /// component writes the tree from its own thread, at a time of its own
    /// choosing, so a write is what tells the window a frame is owed.
    pub wake: Arc<Mutex<Option<Wake>>>,
    /// The host's end of each stream `node.listen-pointer` handed out.
    pub listeners: Listeners,
    /// The replies the component holds and has not answered with yet.
    pub replies: Replies,
    /// `wasi:clocks`, which is what `zena:time`'s `sleep` parks on. A
    /// component that never sleeps still carries it: the interface is in the
    /// linker either way, and an unused import costs nothing.
    clocks: WasiClocksCtx,
    /// For `wasi:clocks`' own resources. The `node` resource needs none: its
    /// handles carry a scene id and nothing else — see [`HostNode`].
    table: ResourceTable,
}

impl WasiClocksView for UiHostState {
    fn clocks(&mut self) -> WasiClocksCtxView<'_> {
        WasiClocksCtxView {
            ctx: &mut self.clocks,
            table: &mut self.table,
        }
    }
}

impl UiHostState {
    pub fn new() -> Self {
        Self {
            text: Arc::new(Mutex::new(TextEngine::new())),
            scene: Arc::new(Mutex::new(Scene::new())),
            guest_entries: Arc::new(AtomicU32::new(0)),
            ready: Arc::new(AtomicBool::new(false)),
            wake: Arc::new(Mutex::new(None)),
            listeners: Listeners::default(),
            replies: Replies::default(),
            clocks: WasiClocksCtx::default(),
            table: ResourceTable::new(),
        }
    }

    /// What follows from the component having written the tree: the streams
    /// of listeners whose nodes the write dropped are ended, and the window
    /// is asked for a frame, if there is a window.
    fn changed(&self) {
        let ended = self.scene.lock().unwrap().take_ended();
        self.listeners.end(&ended);
        if let Some(wake) = self.wake.lock().unwrap().as_ref() {
            wake();
        }
    }
}

impl Default for UiHostState {
    fn default() -> Self {
        Self::new()
    }
}

/// Define `zenafx:host/{text,layout,scene}` on `linker`.
///
/// No interface here hands the host a display list or pixels. A component
/// changes what is on screen by changing its nodes, and rasterizing and
/// presenting stay inside the host's graphics engine.
///
/// `zenafx:ui/{style,geometry}` are imported too — a component that names
/// `text-style` imports the interface that declares it — but they carry only
/// types, so they need an instance and no functions.
pub fn add_host_to_linker(linker: &mut Linker<UiHostState>) -> Result<()> {
    linker.instance("zenafx:ui/style@0.1.0")?;
    linker.instance("zenafx:ui/geometry@0.1.0")?;

    let mut events = linker.instance("zenafx:host/events@0.1.0")?;
    // Dropping a reply is the answer to the event it came with.
    events.resource(
        "reply",
        ResourceType::host::<HostReply>(),
        |mut store, reply| {
            store.data_mut().replies.answer(reply);
            Ok(())
        },
    )?;
    events.func_wrap(
        "[method]reply.stop-propagation",
        |mut caller: StoreContextMut<'_, UiHostState>, (reply,): (Resource<HostReply>,)| {
            caller.data_mut().replies.stop_propagation(reply.rep());
            Ok(())
        },
    )?;
    events.func_wrap(
        "[method]reply.prevent-default",
        |mut caller: StoreContextMut<'_, UiHostState>, (reply,): (Resource<HostReply>,)| {
            caller.data_mut().replies.prevent_default(reply.rep());
            Ok(())
        },
    )?;
    events.func_wrap(
        "[method]reply.capture",
        |mut caller: StoreContextMut<'_, UiHostState>, (reply,): (Resource<HostReply>,)| {
            caller.data_mut().replies.capture(reply.rep());
            Ok(())
        },
    )?;

    let mut text = linker.instance("zenafx:host/text@0.1.0")?;
    text.func_wrap(
        "register-run",
        |mut caller: StoreContextMut<'_, UiHostState>, (content, style): (String, TextStyle)| {
            let text = caller.data_mut().text.clone();
            Ok((text.lock().unwrap().register_run(&content, &style),))
        },
    )?;
    text.func_wrap(
        "update-run",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (run, content, style): (u32, String, TextStyle)| {
            let text = caller.data_mut().text.clone();
            text.lock().unwrap().update_run(run, &content, &style);
            Ok(())
        },
    )?;
    text.func_wrap(
        "release-run",
        |mut caller: StoreContextMut<'_, UiHostState>, (run,): (u32,)| {
            let text = caller.data_mut().text.clone();
            text.lock().unwrap().release_run(run);
            Ok(())
        },
    )?;
    text.func_wrap(
        "measure-run",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (run, available_width): (u32, Option<f32>)| {
            let engine = caller.data_mut().text.clone();
            let m: Measured = engine.lock().unwrap().measure_run(run, available_width);
            Ok((m,))
        },
    )?;

    let mut layout = linker.instance("zenafx:host/layout@0.1.0")?;
    layout.func_wrap(
        "solve",
        |mut caller: StoreContextMut<'_, UiHostState>, (nodes, available): (Vec<Node>, Size)| {
            Ok((solve_tree(&mut caller, &nodes, available),))
        },
    )?;

    wasmtime_wasi::p3::clocks::add_to_linker(linker)?;

    let mut scene = linker.instance("zenafx:host/scene@0.1.0")?;

    // Nothing to free: the node belongs to whoever's interior it sits in, and
    // it goes away when that interior is rebuilt. A guest letting go of a
    // handle says only that this guest has stopped referring to the node.
    scene.resource(
        "node",
        ResourceType::host::<HostNode>(),
        |_store, _rep| Ok(()),
    )?;

    scene.func_wrap(
        "root",
        |mut caller: StoreContextMut<'_, UiHostState>, (): ()| {
            let scene = caller.data_mut().scene.clone();
            let id = scene.lock().unwrap().root();
            Ok((Resource::<HostNode>::new_own(id),))
        },
    )?;
    scene.func_wrap(
        "[method]node.render",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (node, template, holes): (Resource<HostNode>, TemplateRef, Vec<Hole>)| {
            let data = caller.data_mut();
            let (scene, text) = (data.scene.clone(), data.text.clone());
            scene
                .lock()
                .unwrap()
                .render(node.rep(), &template, &holes, &mut text.lock().unwrap());
            data.changed();
            Ok(())
        },
    )?;
    scene.func_wrap(
        "[method]node.content",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (node, slot, count): (Resource<HostNode>, u32, u32)| {
            let data = caller.data_mut();
            let (scene, text) = (data.scene.clone(), data.text.clone());
            let children =
                scene
                    .lock()
                    .unwrap()
                    .content(node.rep(), slot, count, &mut text.lock().unwrap());
            data.changed();
            // A slot a template never declared is a guest bug, and there is
            // nothing to hand back that would be less wrong than a trap.
            match children {
                Some(ids) => Ok((ids
                    .into_iter()
                    .map(Resource::<HostNode>::new_own)
                    .collect::<Vec<_>>(),)),
                None => Err(wasmtime::Error::msg(format!("a node has no slot {slot}"))),
            }
        },
    )?;
    scene.func_wrap(
        "[method]node.listen-pointer",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (node, target, kind, scope, phase): (
            Resource<HostNode>,
            u32,
            PointerKind,
            Scope,
            Phase,
        )| {
            let data = caller.data_mut();
            let scene = data.scene.clone();
            let (id, stream) = data.listeners.open::<DeliveryRecord>(scene.clone());
            let listener = Listener {
                kind,
                scope,
                phase,
                id,
            };
            // The same reasoning as a slot that was never declared: a
            // listener on a node that is not there would never hear anything,
            // and the guest would not find out why. Dropping `stream` on the
            // way out takes the listener's channel with it.
            if !scene.lock().unwrap().listen(node.rep(), target, listener) {
                return Err(wasmtime::Error::msg(format!(
                    "a node shows no template with a position {target} to listen at"
                )));
            }
            Ok((StreamReader::new(&mut caller, stream)?,))
        },
    )?;
    scene.func_wrap(
        "[method]node.listen-keys",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (node, target, phase): (Resource<HostNode>, u32, Phase)| {
            let data = caller.data_mut();
            let scene = data.scene.clone();
            let (id, stream) = data.listeners.open::<KeyDeliveryRecord>(scene.clone());
            let listener = KeyListener { phase, id };
            if !scene
                .lock()
                .unwrap()
                .listen_keys(node.rep(), target, listener)
            {
                return Err(wasmtime::Error::msg(format!(
                    "a node shows no template with a position {target} to listen at"
                )));
            }
            Ok((StreamReader::new(&mut caller, stream)?,))
        },
    )?;
    scene.func_wrap(
        "[method]node.selection",
        |caller: StoreContextMut<'_, UiHostState>, (node, target): (Resource<HostNode>, u32)| {
            let scene = caller.data().scene.lock().unwrap();
            Ok((scene.selection_in(node.rep(), target),))
        },
    )?;
    scene.func_wrap(
        "[method]node.select",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (node, target, to): (Resource<HostNode>, u32, TextSelection)| {
            let data = caller.data_mut();
            // The same reasoning as a listener at a position that is not
            // there: a caret put in no text would never show, and the guest
            // would not find out why.
            if !data.scene.lock().unwrap().select(node.rep(), target, to) {
                return Err(wasmtime::Error::msg(format!(
                    "a node shows no template with text at position {target} to select in"
                )));
            }
            data.changed();
            Ok(())
        },
    )?;
    scene.func_wrap(
        "ready",
        |mut caller: StoreContextMut<'_, UiHostState>, (): ()| {
            caller.data_mut().ready.store(true, Ordering::Relaxed);
            Ok(())
        },
    )?;

    Ok(())
}

/// Solve a tree a component handed to `solve`, measuring its text leaves.
fn solve_tree(
    caller: &mut StoreContextMut<'_, UiHostState>,
    nodes: &[Node],
    available: Size,
) -> Vec<Rect> {
    let engine = caller.data_mut().text.clone();
    let mut text = engine.lock().unwrap();
    solve_with(nodes, available, |content, query| match content {
        Content::Text(run) => measure_text(&mut text, *run, query),
        Content::Box => Measured {
            width: 0.0,
            height: 0.0,
            baseline: 0.0,
        },
    })
}
