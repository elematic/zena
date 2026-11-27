//! Wasmtime host adapter for the ZenaFX platform component
//! (`zenafx:platform@0.1.0` over `zenafx:core/render@0.1.0`).
//!
//! Instantiates the compiled Zena platform component in a synchronous
//! `wasmtime::Store` (never parked in `run_concurrent`) and binds its
//! `zenafx:core/render@0.1.0` imports directly to [`RenderCore`] and
//! [`TextEngine`].
//!
//! Designed in `docs/design/zenafx-platform-core.md`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow};
use wasmtime::component::{Component, Instance, Linker, TypedFunc};
use wasmtime::{Engine, Store, StoreContextMut};

use zenafx_render::core::{CoreEvent, RenderCore, RenderOp};
use zenafx_render::events::{Delivery, KeyDefault, KeyEvent, Phase, PointerInput, PointerKind, Scope};
use zenafx_render::scene::{Hole, TemplateRef, TextSelection};
use zenafx_render::text::TextEngine;
use zenafx_render::types::{Command, Rect, Size};

mod platform_bundle {
    include!(concat!(env!("OUT_DIR"), "/platform_bundle.rs"));
}

const RUNTIME_IFACE: &str = "zenafx:platform/runtime@0.1.0";

/// Host state bound to `zenafx:core/render@0.1.0` inside the platform
/// component's synchronous store.
pub struct CoreHostState {
    pub core: Arc<Mutex<RenderCore>>,
    pub text: Arc<Mutex<TextEngine>>,
}

impl CoreHostState {
    pub fn new() -> Self {
        Self {
            core: Arc::new(Mutex::new(RenderCore::new())),
            text: Arc::new(Mutex::new(TextEngine::new())),
        }
    }
}

impl Default for CoreHostState {
    fn default() -> Self {
        Self::new()
    }
}

/// Bind `zenafx:core/render@0.1.0` on `linker` to [`CoreHostState`].
pub fn add_core_to_linker(linker: &mut Linker<CoreHostState>) -> Result<()> {
    let mut render = linker.instance("zenafx:core/render@0.1.0")?;
    render.func_wrap(
        "apply",
        |caller: StoreContextMut<'_, CoreHostState>, (ops,): (Vec<RenderOp>,)| {
            let core = caller.data().core.clone();
            let text = caller.data().text.clone();
            core.lock()
                .unwrap()
                .apply(&ops, &mut text.lock().unwrap());
            Ok(())
        },
    )?;
    render.func_wrap(
        "selection",
        |caller: StoreContextMut<'_, CoreHostState>, (id,): (u32,)| {
            let sel = caller.data().core.lock().unwrap().selection_in(id);
            Ok((sel,))
        },
    )?;
    render.func_wrap(
        "select",
        |caller: StoreContextMut<'_, CoreHostState>, (id, to): (u32, TextSelection)| {
            caller.data().core.lock().unwrap().select(id, to);
            Ok(())
        },
    )?;
    render.func_wrap(
        "capture-pointer",
        |caller: StoreContextMut<'_, CoreHostState>, (id,): (Option<u32>,)| {
            caller.data().core.lock().unwrap().capture_pointer(id);
            Ok(())
        },
    )?;
    render.func_wrap(
        "focus",
        |caller: StoreContextMut<'_, CoreHostState>, (id,): (Option<u32>,)| {
            let _ = caller.data().core.lock().unwrap().focus(id);
            Ok(())
        },
    )?;
    render.func_wrap(
        "bounds",
        |caller: StoreContextMut<'_, CoreHostState>, (id,): (u32,)| {
            let b: Option<Rect> = caller.data().core.lock().unwrap().bounds(id);
            Ok((b,))
        },
    )?;
    Ok(())
}

/// A live instance of the ZenaFX platform component running synchronously over
/// [`RenderCore`].
pub struct PlatformRuntime {
    store: Store<CoreHostState>,
    core: Arc<Mutex<RenderCore>>,
    text: Arc<Mutex<TextEngine>>,
    f_root: TypedFunc<(), (u32,)>,
    f_create_node: TypedFunc<(), (u32,)>,
    f_drop_node: TypedFunc<(u32,), (bool,)>,
    f_render: TypedFunc<(u32, TemplateRef, Vec<Hole>), ()>,
    f_content: TypedFunc<(u32, u32, u32), (Option<Vec<u32>>,)>,
    f_set_slot: TypedFunc<(u32, u32, Vec<u32>), (bool,)>,
    f_take_ended: TypedFunc<(), (Vec<u32>,)>,
    f_listen_pointer: TypedFunc<(u32, u32, u32, PointerKind, Scope, Phase), (bool,)>,
    f_listen_keys: TypedFunc<(u32, u32, u32, Phase), (bool,)>,
    f_unlisten: TypedFunc<(u32,), ()>,
    f_selection: TypedFunc<(u32, u32), (Option<TextSelection>,)>,
    f_select: TypedFunc<(u32, u32, TextSelection), (bool,)>,
    f_on_core_events: TypedFunc<(Vec<CoreEvent>,), (bool,)>,
    f_route_pointer: TypedFunc<(PointerKind, Option<u32>, f32, f32, u8, bool), (Vec<Delivery>,)>,
    f_route_key: TypedFunc<(Option<u32>,), (Vec<u32>,)>,
    f_capture_target: TypedFunc<(u32,), (Option<u32>,)>,
}

fn export_func<Params, Results>(
    instance: &Instance,
    store: &mut Store<CoreHostState>,
    iface: &wasmtime::component::ComponentExportIndex,
    name: &str,
) -> Result<TypedFunc<Params, Results>>
where
    Params: wasmtime::component::ComponentNamedList + wasmtime::component::Lower,
    Results: wasmtime::component::ComponentNamedList + wasmtime::component::Lift,
{
    let idx = instance
        .get_export_index(&mut *store, Some(iface), name)
        .ok_or_else(|| anyhow!("platform component exports no `{name}` on {RUNTIME_IFACE}"))?;
    instance
        .get_typed_func::<Params, Results>(&mut *store, &idx)
        .map_err(|e| anyhow!("platform export `{name}` has unexpected signature: {e:?}"))
}

impl PlatformRuntime {
    /// Load the default platform component: `ZENAFX_PLATFORM_WASM` if set,
    /// otherwise the bundled bytes (with `--features bundled`), otherwise
    /// `packages/zenafx/out/platform.wasm` in the repository.
    pub fn load_default(engine: &Engine) -> Result<Self> {
        if let Ok(path) = std::env::var("ZENAFX_PLATFORM_WASM") {
            return Self::load(engine, Path::new(&path));
        }
        if let Some(bytes) = platform_bundle::BUNDLED_PLATFORM {
            return Self::from_bytes(engine, bytes);
        }
        let repo_wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/platform.wasm");
        Self::load(engine, &repo_wasm)
    }

    /// Load and instantiate the compiled platform component at `path`.
    pub fn load(engine: &Engine, path: &Path) -> Result<Self> {
        let component = Component::from_file(engine, path).map_err(|e| {
            anyhow!(
                "could not load platform component from {}: {e:?}",
                path.display()
            )
        })?;
        Self::from_component(engine, &component)
    }

    /// Instantiate the platform component from precompiled bytes.
    pub fn from_bytes(engine: &Engine, bytes: &[u8]) -> Result<Self> {
        let component = Component::from_binary(engine, bytes)
            .map_err(|e| anyhow!("could not compile platform component bytes: {e:?}"))?;
        Self::from_component(engine, &component)
    }

    /// Instantiate a compiled [`Component`] over a fresh [`RenderCore`].
    pub fn from_component(engine: &Engine, component: &Component) -> Result<Self> {
        let mut linker = Linker::new(engine);
        add_core_to_linker(&mut linker)?;

        let state = CoreHostState::new();
        let core = state.core.clone();
        let text = state.text.clone();
        let mut store = Store::new(engine, state);

        let instance = linker
            .instantiate(&mut store, component)
            .map_err(|e| anyhow!("could not instantiate platform component: {e:?}"))?;

        let iface = instance
            .get_export_index(&mut store, None, RUNTIME_IFACE)
            .ok_or_else(|| anyhow!("platform component does not export {RUNTIME_IFACE}"))?;

        let f_root = export_func(&instance, &mut store, &iface, "root")?;
        let f_create_node = export_func(&instance, &mut store, &iface, "create-node")?;
        let f_drop_node = export_func(&instance, &mut store, &iface, "drop-node")?;
        let f_render = export_func(&instance, &mut store, &iface, "render")?;
        let f_content = export_func(&instance, &mut store, &iface, "content")?;
        let f_set_slot = export_func(&instance, &mut store, &iface, "set-slot")?;
        let f_take_ended = export_func(&instance, &mut store, &iface, "take-ended-listeners")?;
        let f_listen_pointer = export_func(&instance, &mut store, &iface, "listen-pointer")?;
        let f_listen_keys = export_func(&instance, &mut store, &iface, "listen-keys")?;
        let f_unlisten = export_func(&instance, &mut store, &iface, "unlisten")?;
        let f_selection = export_func(&instance, &mut store, &iface, "selection")?;
        let f_select = export_func(&instance, &mut store, &iface, "select")?;
        let f_on_core_events = export_func(&instance, &mut store, &iface, "on-core-events")?;
        let f_route_pointer = export_func(&instance, &mut store, &iface, "route-pointer")?;
        let f_route_key = export_func(&instance, &mut store, &iface, "route-key")?;
        let f_capture_target = export_func(&instance, &mut store, &iface, "capture-target")?;

        Ok(Self {
            store,
            core,
            text,
            f_root,
            f_create_node,
            f_drop_node,
            f_render,
            f_content,
            f_set_slot,
            f_take_ended,
            f_listen_pointer,
            f_listen_keys,
            f_unlisten,
            f_selection,
            f_select,
            f_on_core_events,
            f_route_pointer,
            f_route_key,
            f_capture_target,
        })
    }

    pub fn core(&self) -> &Arc<Mutex<RenderCore>> {
        &self.core
    }

    pub fn text(&self) -> &Arc<Mutex<TextEngine>> {
        &self.text
    }

    pub fn root(&mut self) -> Result<u32> {
        let (id,) = self.f_root.call(&mut self.store, ())?;
        Ok(id)
    }

    pub fn create_node(&mut self) -> Result<u32> {
        let (id,) = self.f_create_node.call(&mut self.store, ())?;
        Ok(id)
    }

    pub fn drop_node(&mut self, id: u32) -> Result<bool> {
        let (changed,) = self.f_drop_node.call(&mut self.store, (id,))?;
        Ok(changed)
    }

    pub fn render(&mut self, id: u32, template: TemplateRef, holes: Vec<Hole>) -> Result<()> {
        self.f_render.call(&mut self.store, (id, template, holes))?;
        Ok(())
    }

    pub fn content(&mut self, id: u32, slot: u32, count: u32) -> Result<Option<Vec<u32>>> {
        let (kids,) = self.f_content.call(&mut self.store, (id, slot, count))?;
        Ok(kids)
    }

    pub fn set_slot(&mut self, id: u32, slot: u32, children: Vec<u32>) -> Result<bool> {
        let (ok,) = self.f_set_slot.call(&mut self.store, (id, slot, children))?;
        Ok(ok)
    }

    pub fn take_ended_listeners(&mut self) -> Result<Vec<u32>> {
        let (ended,) = self.f_take_ended.call(&mut self.store, ())?;
        Ok(ended)
    }

    pub fn listen_pointer(
        &mut self,
        id: u32,
        target: u32,
        listener_id: u32,
        kind: PointerKind,
        scope: Scope,
        phase: Phase,
    ) -> Result<bool> {
        let (ok,) = self.f_listen_pointer.call(
            &mut self.store,
            (id, target, listener_id, kind, scope, phase),
        )?;
        Ok(ok)
    }

    pub fn listen_keys(
        &mut self,
        id: u32,
        target: u32,
        listener_id: u32,
        phase: Phase,
    ) -> Result<bool> {
        let (ok,) = self
            .f_listen_keys
            .call(&mut self.store, (id, target, listener_id, phase))?;
        Ok(ok)
    }

    pub fn unlisten(&mut self, listener_id: u32) -> Result<()> {
        self.f_unlisten.call(&mut self.store, (listener_id,))?;
        Ok(())
    }

    pub fn selection(&mut self, id: u32, target: u32) -> Result<Option<TextSelection>> {
        let (sel,) = self.f_selection.call(&mut self.store, (id, target))?;
        Ok(sel)
    }

    pub fn select(&mut self, id: u32, target: u32, to: TextSelection) -> Result<bool> {
        let (ok,) = self.f_select.call(&mut self.store, (id, target, to))?;
        Ok(ok)
    }

    pub fn on_core_events(&mut self, events: Vec<CoreEvent>) -> Result<bool> {
        if events.is_empty() {
            return Ok(false);
        }
        let (changed,) = self.f_on_core_events.call(&mut self.store, (events,))?;
        Ok(changed)
    }

    pub fn capture_target(&mut self, listener_id: u32) -> Result<Option<u32>> {
        let (rid,) = self.f_capture_target.call(&mut self.store, (listener_id,))?;
        Ok(rid)
    }

    /// Solve and draw one frame in [`RenderCore`], flushing any watched core
    /// events into the platform component and returning any `enter`/`leave`
    /// deliveries owed because layout moved nodes under a stationary pointer.
    pub fn draw_with_owed(&mut self, available: Size) -> Result<(Vec<Command>, Vec<Delivery>)> {
        let (mut cmds, events, draw_hover, pos) = {
            let mut core = self.core.lock().unwrap();
            let mut text = self.text.lock().unwrap();
            let cmds = core.draw(available, &mut text);
            let events = core.take_events();
            let draw_hover = core.take_draw_hover();
            let pos = core.pointer_pos();
            (cmds, events, draw_hover, pos)
        };
        if !events.is_empty() && self.on_core_events(events)? {
            let mut core = self.core.lock().unwrap();
            let mut text = self.text.lock().unwrap();
            cmds = core.draw(available, &mut text);
            let _ = core.take_events();
        }
        let owed = match draw_hover {
            Some(under) => {
                let (deliveries,) = self.f_route_pointer.call(
                    &mut self.store,
                    (PointerKind::Enter, under, pos.0, pos.1, 0, false),
                )?;
                deliveries
            }
            None => Vec::new(),
        };
        Ok((cmds, owed))
    }

    /// Solve and draw one frame in [`RenderCore`], discarding owed deliveries.
    pub fn draw(&mut self, available: Size) -> Result<Vec<Command>> {
        let (cmds, _) = self.draw_with_owed(available)?;
        Ok(cmds)
    }

    /// Process a pointer input through [`RenderCore`], forward watched state
    /// changes to `on-core-events`, and route logical listener deliveries.
    pub fn pointer(&mut self, input: PointerInput) -> Result<(Vec<Delivery>, bool)> {
        let (outcome, was_captured) = {
            let mut core = self.core.lock().unwrap();
            let text = self.text.lock().unwrap();
            let was_captured = core.captured().is_some();
            let outcome = core.pointer(input, &text);
            (outcome, was_captured)
        };
        let restyled = self.on_core_events(outcome.events)?;
        let (kind, x, y, button) = match input {
            PointerInput::Moved { x, y } => (PointerKind::Move, x, y, 0),
            PointerInput::Button {
                x,
                y,
                button,
                down: true,
            } => (PointerKind::Down, x, y, button),
            PointerInput::Button {
                x,
                y,
                button,
                down: false,
            } => (PointerKind::Up, x, y, button),
            PointerInput::Wheel { .. } => return Ok((Vec::new(), outcome.needs_redraw || restyled)),
            PointerInput::Left => (PointerKind::Leave, 0.0, 0.0, 0),
        };
        let (deliveries,) = self.f_route_pointer.call(
            &mut self.store,
            (kind, outcome.target, x, y, button, was_captured),
        )?;
        Ok((deliveries, outcome.needs_redraw || restyled))
    }

    /// Capture the pointer for the node owning `listener_id`, restoring any
    /// text selection started by the press and restyling if needed.
    pub fn capture_listener(&mut self, listener_id: u32) -> Result<bool> {
        let target = self.capture_target(listener_id)?;
        let events = {
            let mut core = self.core.lock().unwrap();
            core.capture_pointer(target);
            core.take_events()
        };
        let restyled = self.on_core_events(events)?;
        let dirty = self.core.lock().unwrap().dirty;
        Ok(restyled || dirty)
    }

    /// Perform the native default action for a key whose default was not
    /// prevented by any listener. Returns whether a redraw is owed.
    pub fn act_on_key(&mut self, event: &KeyEvent) -> Result<bool> {
        match event.default_action() {
            KeyDefault::None => Ok(false),
            KeyDefault::MoveFocus { backwards } => {
                let events = self.core.lock().unwrap().move_focus(backwards);
                let restyled = self.on_core_events(events)?;
                let dirty = self.core.lock().unwrap().dirty;
                Ok(restyled || dirty)
            }
            KeyDefault::SelectAll => {
                let mut core = self.core.lock().unwrap();
                core.select_all_text();
                Ok(core.dirty)
            }
        }
    }

    /// Route a keyboard event across the logical focus path.
    pub fn route_key(&mut self, event: &KeyEvent) -> Result<Vec<u32>> {
        let focused = {
            let mut core = self.core.lock().unwrap();
            core.notice_key(event);
            core.focused()
        };
        let (listeners,) = self.f_route_key.call(&mut self.store, (focused,))?;
        Ok(listeners)
    }
}
