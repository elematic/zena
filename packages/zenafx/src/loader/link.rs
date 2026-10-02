//! Binding a component's `zenafx:host` imports to the host primitives.
//!
//! The loader defines every import itself rather than handing wasmtime a
//! generated `add_to_linker`, because "Runtime linking and import interposition"
//! in `docs/design/zenafx-ui.md`
//! wants each instance's imports decided per instance: a component gets the
//! interfaces the policy grants it and no others.

use anyhow::Result;
use wasmtime::StoreContextMut;
use wasmtime::component::{Linker, Resource, ResourceTable, ResourceType};
use wasmtime_wasi::clocks::{WasiClocksCtx, WasiClocksCtxView, WasiClocksView};

use crate::ui::layout::{measure_text, solve_with};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use crate::ui::scene::{Hole, Scene, TemplateRef};
use crate::ui::text::TextEngine;
use crate::ui::types::{Command, Content, Measured, Node, Rect, Size, TextStyle};

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
    /// The frame being built. A component that paints for itself, rather
    /// than describing a tree, appends to this through `present`.
    pub frame: Vec<Command>,
    /// Every entry into the component since the scene was created. A
    /// retained tree should leave this at one while the window resizes.
    /// Shared for the same reason the scene is: the store it lives in is
    /// held by the entry's task.
    pub guest_entries: Arc<AtomicU32>,
    /// Set by the component's `ready`, which is how it says the tree it has
    /// built is worth drawing. The loader waits for it rather than for the
    /// entry call, which for a component that keeps working never returns.
    pub ready: Arc<AtomicBool>,
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
            frame: Vec::new(),
            guest_entries: Arc::new(AtomicU32::new(0)),
            ready: Arc::new(AtomicBool::new(false)),
            clocks: WasiClocksCtx::default(),
            table: ResourceTable::new(),
        }
    }
}

impl Default for UiHostState {
    fn default() -> Self {
        Self::new()
    }
}

/// Define `zenafx:host/{text,layout,paint,scene}` on `linker`.
///
/// `zenafx:ui/{style,geometry}` are imported too — a component that names
/// `text-style` imports the interface that declares it — but they carry only
/// types, so they need an instance and no functions.
pub fn add_host_to_linker(linker: &mut Linker<UiHostState>) -> Result<()> {
    linker.instance("zenafx:ui/style@0.1.0")?;
    linker.instance("zenafx:ui/geometry@0.1.0")?;

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

    let mut paint = linker.instance("zenafx:host/paint@0.1.0")?;
    paint.func_wrap(
        "present",
        |mut caller: StoreContextMut<'_, UiHostState>, (commands,): (Vec<Command>,)| {
            caller.data_mut().frame.extend(commands);
            Ok(())
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
            let mut scene = scene.lock().unwrap();
            let mut text = text.lock().unwrap();
            scene.render(node.rep(), &template, &holes, &mut text);
            Ok(())
        },
    )?;
    scene.func_wrap(
        "[method]node.content",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (node, slot, count): (Resource<HostNode>, u32, u32)| {
            let data = caller.data_mut();
            let (scene, text) = (data.scene.clone(), data.text.clone());
            let mut scene = scene.lock().unwrap();
            let mut text = text.lock().unwrap();
            // A slot a template never declared is a guest bug, and there is
            // nothing to hand back that would be less wrong than a trap.
            match scene.content(node.rep(), slot, count, &mut text) {
                Some(ids) => Ok((ids
                    .into_iter()
                    .map(Resource::<HostNode>::new_own)
                    .collect::<Vec<_>>(),)),
                None => Err(wasmtime::Error::msg(format!("a node has no slot {slot}"))),
            }
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
