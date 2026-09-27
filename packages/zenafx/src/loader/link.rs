//! Binding a component's `zenafx:host` imports to the host primitives.
//!
//! The loader defines every import itself rather than handing wasmtime a
//! generated `add_to_linker`, because §6.2 of `docs/design/zenafx-ui.md`
//! wants each instance's imports decided per instance: a component gets the
//! interfaces the policy grants it and no others, and a component never
//! reaches another component except through the host.

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Result;
use wasmtime::component::{Linker, TypedFunc};
use wasmtime::StoreContextMut;

use crate::ui::layout::{measure_text, solve_with};
use crate::ui::text::TextEngine;
use crate::ui::types::{
    Command, Content, Measured, MeasureRequest, Node, Rect, Size, TextLook,
};

/// One component, from the moment its handle is promised.
///
/// `render` is `None` between the `spawn` that named it and the
/// instantiation that fills it in. The entry exists in that window so the
/// handle the guest already holds resolves to something: an embedder
/// spawns a child and fills its slot in the same breath, and a slot filled
/// against a missing entry would be silently dropped.
#[derive(Clone, Default)]
pub struct Widget {
    pub render: Option<TypedFunc<(f32, f32), ()>>,
    /// Absent for the root, which is never embedded and so never measured.
    pub measure: Option<TypedFunc<(MeasureRequest,), (Size,)>>,
    /// What this widget's embedder has put in each of its named slots.
    pub slots: HashMap<String, u32>,
}

/// What a ZenaFX window's host functions read and write.
///
/// One of these serves every component in the window, because they share one
/// `Store` (§6.5) and because a slot binds two components together: the
/// embedder names a slot on the child, and the child asks what is in it.
pub struct UiHostState {
    pub text: TextEngine,
    /// The frame being built. Every `present` appends to it, translated into
    /// window coordinates, so the order components are placed in is the
    /// order they paint in.
    pub frame: Vec<Command>,
    pub widgets: Vec<Widget>,
    /// The widget whose `render` or `measure` is on the stack. `place-slot`
    /// and slot measurement resolve against its top entry.
    pub stack: Vec<u32>,
    /// Where the running widget's box starts. Its display list is in its own
    /// coordinates and lands in the window's.
    pub origin: (f32, f32),
    /// Where `spawn` looks, and what it is allowed to find: a component may
    /// only name a file in the directory the root was loaded from. A real
    /// policy check replaces this.
    pub component_dir: PathBuf,
    /// Handles promised by `spawn` and not yet instantiated, as
    /// (handle, source). The loader instantiates outside the host call,
    /// because instantiation needs the `Linker` and the `Component`,
    /// neither of which a host function can reach.
    pub pending_spawns: Vec<(u32, String)>,
}

impl UiHostState {
    pub fn new(component_dir: PathBuf) -> Self {
        Self {
            text: TextEngine::new(),
            frame: Vec::new(),
            widgets: Vec::new(),
            stack: Vec::new(),
            origin: (0.0, 0.0),
            component_dir,
            pending_spawns: Vec::new(),
        }
    }

    /// What fills `name` on the widget currently running.
    fn slot_of(&self, name: &str) -> Option<u32> {
        let current = *self.stack.last()?;
        self.widgets
            .get(current as usize)?
            .slots
            .get(name)
            .copied()
    }
}

/// Run `widget` inside `bounds`: clip to the box, translate into it, call
/// `render`, and put the clip and origin back.
///
/// The clip is what stops a component drawing outside the box it was given,
/// which is the compositor's half of the capability model (§12).
fn place_widget(
    caller: &mut StoreContextMut<'_, UiHostState>,
    widget: u32,
    bounds: Rect,
) -> wasmtime::Result<()> {
    // Not instantiated yet: the handle was promised this frame and draws
    // nothing until the next one.
    let Some(Some(render)) = caller.data().widgets.get(widget as usize).map(|w| w.render) else {
        return Ok(());
    };

    let saved = caller.data().origin;
    let outer = Rect {
        x: saved.0 + bounds.x,
        y: saved.1 + bounds.y,
        width: bounds.width,
        height: bounds.height,
    };
    {
        let data = caller.data_mut();
        data.frame.push(Command::PushClip(outer));
        data.origin = (outer.x, outer.y);
        data.stack.push(widget);
    }

    let result = render.call(&mut *caller, (bounds.width, bounds.height));

    {
        let data = caller.data_mut();
        data.stack.pop();
        data.origin = saved;
        data.frame.push(Command::PopClip);
    }
    result
}

/// Ask `widget` how big it wants to be.
///
/// This runs while the embedder is suspended inside its own `solve` host
/// call. The embedder is not on the stack of this call — the host is — so
/// no component is re-entered, and the rule in §6.4 about guest→guest calls
/// on the frame path does not apply.
fn measure_widget(
    caller: &mut StoreContextMut<'_, UiHostState>,
    widget: u32,
    request: MeasureRequest,
) -> Measured {
    let Some(Some(measure)) = caller
        .data()
        .widgets
        .get(widget as usize)
        .map(|w| w.measure)
    else {
        return Measured {
            width: 0.0,
            height: 0.0,
            baseline: 0.0,
        };
    };
    caller.data_mut().stack.push(widget);
    let answer = measure.call(&mut *caller, (request,));
    caller.data_mut().stack.pop();
    match answer {
        Ok((size,)) => Measured {
            width: size.width,
            height: size.height,
            baseline: size.height,
        },
        Err(e) => {
            log::error!("a child trapped in `measure`: {e:?}");
            Measured {
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
            }
        }
    }
}

/// Solve a tree whose leaves may be child components or slots.
fn solve_tree(
    caller: &mut StoreContextMut<'_, UiHostState>,
    nodes: &[Node],
    available: Size,
) -> Vec<Rect> {
    solve_with(nodes, available, |content, query| match content {
        Content::Text(run) => measure_text(&mut caller.data_mut().text, *run, query),
        Content::Child(handle) => measure_widget(caller, *handle, query),
        Content::Slot(name) => match caller.data().slot_of(name) {
            Some(filler) => measure_widget(caller, filler, query),
            // An empty slot takes no space, the way an empty `<slot>` with
            // no fallback contributes nothing.
            None => Measured {
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
            },
        },
        Content::Box => Measured {
            width: 0.0,
            height: 0.0,
            baseline: 0.0,
        },
    })
}

/// Define `zenafx:host/{text,layout,paint,children}` on `linker`.
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
            let origin = caller.data().origin;
            let frame = &mut caller.data_mut().frame;
            frame.extend(commands.into_iter().map(|c| translate(c, origin)));
            Ok(())
        },
    )?;

    let mut children = linker.instance("zenafx:host/children@0.1.0")?;
    children.func_wrap(
        "spawn",
        |mut caller: StoreContextMut<'_, UiHostState>, (source,): (String,)| {
            // Instantiating needs the `Linker` and the compiled `Component`,
            // which a host function cannot reach, so the request is queued
            // and the loader services it before the next frame. The handle
            // returned is the index the widget will occupy, which makes a
            // spawn look the same whether the component is on disk or, one
            // day, still being fetched.
            let data = caller.data_mut();
            let handle = data.widgets.len() as u32;
            // The entry goes in now, empty. The guest has the handle and
            // may use it before the frame ends — filling a slot on it, for
            // one — and there has to be somewhere to record that.
            data.widgets.push(Widget::default());
            data.pending_spawns.push((handle, source));
            Ok((Ok::<u32, String>(handle),))
        },
    )?;
    children.func_wrap(
        "fill-slot",
        |mut caller: StoreContextMut<'_, UiHostState>,
         (child, name, content): (u32, String, u32)| {
            if let Some(w) = caller.data_mut().widgets.get_mut(child as usize) {
                w.slots.insert(name, content);
            }
            Ok(())
        },
    )?;
    children.func_wrap(
        "place",
        |mut caller: StoreContextMut<'_, UiHostState>, (child, bounds): (u32, Rect)| {
            place_widget(&mut caller, child, bounds)?;
            Ok(())
        },
    )?;
    children.func_wrap(
        "place-slot",
        |mut caller: StoreContextMut<'_, UiHostState>, (name, bounds): (String, Rect)| {
            if let Some(filler) = caller.data().slot_of(&name) {
                place_widget(&mut caller, filler, bounds)?;
            }
            Ok(())
        },
    )?;

    Ok(())
}

/// Move a command from a widget's own coordinates into the window's.
fn translate(command: Command, (dx, dy): (f32, f32)) -> Command {
    let shift = |r: Rect| Rect {
        x: r.x + dx,
        y: r.y + dy,
        ..r
    };
    match command {
        Command::Quad(mut q) => {
            q.bounds = shift(q.bounds);
            Command::Quad(q)
        }
        Command::Glyphs(mut g) => {
            g.x += dx;
            g.y += dy;
            Command::Glyphs(g)
        }
        Command::PushClip(r) => Command::PushClip(shift(r)),
        Command::PopClip => Command::PopClip,
    }
}
