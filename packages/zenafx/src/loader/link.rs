//! Binding a component's `zenafx:host` imports to the host primitives.
//!
//! The loader defines every import itself rather than handing wasmtime a
//! generated `add_to_linker`, because §6.2 of `docs/design/zenafx-ui.md`
//! wants each instance's imports decided per instance: a component gets the
//! interfaces the policy grants it and no others, and a guest→guest binding
//! goes through a host trampoline. One `Linker` is built per instance for
//! that reason, so this function takes one rather than caching a shared one.

use anyhow::Result;
use wasmtime::StoreContextMut;
use wasmtime::component::Linker;

use crate::ui::layout::solve;
use crate::ui::text::TextEngine;
use crate::ui::types::{Command, Measured, Node, Rect, Size, TextLook};

/// What a ZenaFX instance's host functions read and write.
///
/// The text engine lives here because `zenafx:host/text` hands out run ids
/// and everything else refers to a run by id. The display list is the
/// current frame's: `present` fills it and the window drains it, since a
/// return-free `present` is the only thing a frame produces.
pub struct UiHostState {
    pub text: TextEngine,
    pub frame: Vec<Command>,
}

impl UiHostState {
    pub fn new() -> Self {
        Self {
            text: TextEngine::new(),
            frame: Vec::new(),
        }
    }
}

impl Default for UiHostState {
    fn default() -> Self {
        Self::new()
    }
}

/// Define `zenafx:host/{text,layout,paint}` on `linker`.
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
            let rects: Vec<Rect> = solve(&nodes, available, &mut caller.data_mut().text);
            Ok((rects,))
        },
    )?;

    let mut paint = linker.instance("zenafx:host/paint@0.1.0")?;
    paint.func_wrap(
        "present",
        |mut caller: StoreContextMut<'_, UiHostState>, (commands,): (Vec<Command>,)| {
            // The window drains this after `render` returns. A component
            // that calls `present` twice in one frame gets the last list,
            // matching a scene graph where the newest state wins.
            caller.data_mut().frame = commands;
            Ok(())
        },
    )?;

    Ok(())
}
