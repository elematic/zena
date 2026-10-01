//! Binding a component's `zenafx:host` imports to the host primitives.
//!
//! The loader defines every import itself rather than handing wasmtime a
//! generated `add_to_linker`, because "Runtime linking and import interposition"
//! in `docs/design/zenafx-ui.md`
//! wants each instance's imports decided per instance: a component gets the
//! interfaces the policy grants it and no others.

use anyhow::Result;
use wasmtime::component::Linker;
use wasmtime::StoreContextMut;

use crate::ui::layout::{measure_text, solve_with};
use crate::ui::scene::{Scene, SceneNode};
use crate::ui::text::TextEngine;
use crate::ui::types::{Command, Content, Measured, Node, Rect, Size, TextLook};

/// What a ZenaFX window's host functions read and write.
pub struct UiHostState {
    pub text: TextEngine,
    /// The retained tree. The component installs one when it starts, and a
    /// frame after that is a solve and a paint over this and nothing else.
    pub scene: Scene,
    /// The frame being built. A component that paints for itself, rather
    /// than describing a tree, appends to this through `present`.
    pub frame: Vec<Command>,
    /// Every entry into the component since the scene was created. A
    /// retained tree should leave this at one while the window resizes.
    pub guest_entries: u32,
}

impl UiHostState {
    pub fn new() -> Self {
        Self {
            text: TextEngine::new(),
            scene: Scene::new(),
            frame: Vec::new(),
            guest_entries: 0,
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
/// `text-look` imports the interface that declares it — but they carry only
/// types, so they need an instance and no functions.
pub fn add_host_to_linker(linker: &mut Linker<UiHostState>) -> Result<()> {
    linker.instance("zenafx:ui/style@0.1.0")?;
    linker.instance("zenafx:ui/geometry@0.1.0")?;

    let mut text = linker.instance("zenafx:host/text@0.1.0")?;
    text.func_wrap(
        "register-run",
        |mut caller: StoreContextMut<'_, UiHostState>, (content, look): (String, TextLook)| {
            Ok((caller.data_mut().text.register_run(&content, &look),))
        },
    )?;
    text.func_wrap(
        "update-run",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (run, content, look): (u32, String, TextLook)| {
            caller.data_mut().text.update_run(run, &content, &look);
            Ok(())
        },
    )?;
    text.func_wrap(
        "release-run",
        |mut caller: StoreContextMut<'_, UiHostState>, (run,): (u32,)| {
            caller.data_mut().text.release_run(run);
            Ok(())
        },
    )?;
    text.func_wrap(
        "measure-run",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (run, available_width): (u32, Option<f32>)| {
            let m: Measured = caller.data_mut().text.measure_run(run, available_width);
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

    let mut scene = linker.instance("zenafx:host/scene@0.1.0")?;
    scene.func_wrap(
        "install",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (parent, nodes): (Option<u32>, Vec<SceneNode>)| {
            let data = caller.data_mut();
            let UiHostState { scene, text, .. } = data;
            Ok((scene.install(parent, &nodes, text),))
        },
    )?;
    scene.func_wrap(
        "replace",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (target, nodes): (u32, Vec<SceneNode>)| {
            let data = caller.data_mut();
            let UiHostState { scene, text, .. } = data;
            Ok((scene.replace(target, &nodes, text),))
        },
    )?;
    scene.func_wrap(
        "invalidate",
        |mut caller: StoreContextMut<'_, UiHostState>, (): ()| {
            caller.data_mut().scene.dirty = true;
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
    solve_with(nodes, available, |content, query| match content {
        Content::Text(run) => measure_text(&mut caller.data_mut().text, *run, query),
        Content::Box => Measured {
            width: 0.0,
            height: 0.0,
            baseline: 0.0,
        },
    })
}
