//! Loading ZenaFX components and running them as a scene.
//!
//! §6.2's path at its smallest: compile a component, build a `Linker` for
//! it, bind its `zenafx:host` imports, instantiate, and call it once per
//! frame. A component that embeds another asks the host to spawn it, so the
//! embedder never holds the child's exports and the host can refuse.
//! Fetching over the network, caching by content hash and the policy check
//! come later.

pub mod link;

use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use wasmtime::component::{Component, Linker, ResourceAny};
use wasmtime::{Config, Engine, Store};

use crate::ui::surface::Scene;
use crate::ui::text::TextEngine;
use crate::ui::types::{Color, Command, FrameEvent, MeasureRequest, Size};
use link::{UiHostState, Widget, add_host_to_linker};

/// The interface a component exports to hand over a root widget instance.
const APP: &str = "zenafx:host/app@0.1.0";
/// The older interface, where the component itself is the one widget.
const WIDGET: &str = "zenafx:host/widget@0.1.0";

/// The engine a ZenaFX component runs on.
///
/// Zena's own settings from `zena-runtime` — GC, exceptions, typed function
/// references, tail calls — plus the component model. Async support is off:
/// a frame is a synchronous call, and the store is entered from the window
/// loop on the main thread.
pub fn engine(debug: bool) -> Result<Engine> {
    let mut config: Config = zena_runtime::engine::config(debug);
    config.wasm_component_model(true);
    Engine::new(&config).map_err(|e| anyhow!("could not create the wasmtime engine: {e}"))
}

/// A window's components: the root, and whatever it has spawned.
///
/// They share one `Store`, because a `Store` is entered by one thread at a
/// time and because a slot binds two of them together (§6.5).
pub struct GuestScene {
    engine: Engine,
    store: Store<UiHostState>,
    linker: Linker<UiHostState>,
    root: u32,
    background: Color,
    /// Whether the last frame brought new components in, so the window owes
    /// one more frame for them to appear in.
    spawned_last_frame: bool,
    /// Whether the retained root has installed its tree yet.
    mounted: bool,
}

impl GuestScene {
    /// Compile and instantiate the component at `path` as the window's root.
    pub fn load(engine: &Engine, path: &Path) -> Result<Self> {
        let dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        let mut linker: Linker<UiHostState> = Linker::new(engine);
        add_host_to_linker(&mut linker)?;

        let store = Store::new(engine, UiHostState::new(dir));
        let mut scene = Self {
            engine: engine.clone(),
            store,
            linker,
            root: 0,
            background: Color::rgb(1.0, 1.0, 1.0),
            spawned_last_frame: false,
            mounted: false,
        };
        let root = scene.instantiate(path)?;
        scene.store.data_mut().widgets.push(root);
        scene.root = 0;
        Ok(scene)
    }

    /// Compile and instantiate one component, returning its exports.
    fn instantiate(&mut self, path: &Path) -> Result<Widget> {
        let component = Component::from_file(&self.engine, path)
            .map_err(|e| anyhow!("could not load a component from {}: {e:?}", path.display()))?;
        // Instantiation is where a missing or mistyped host import surfaces:
        // the linker typechecks what it defined against what the component
        // asked for.
        let instance = self
            .linker
            .instantiate(&mut self.store, &component)
            .map_err(|e| anyhow!("could not instantiate {}: {e:?}", path.display()))?;

        // A component that exports `app` hands over a widget instance; the
        // host holds the handle and draws through it. One that exports
        // `widget` is itself the widget.
        if let Some(app) = instance.get_export_index(&mut self.store, None, APP) {
            return self.start_root(&instance, &app, path);
        }

        let iface = instance
            .get_export_index(&mut self.store, None, WIDGET)
            .ok_or_else(|| anyhow!("{} does not export {WIDGET}", path.display()))?;
        let find = |store: &mut Store<UiHostState>, name: &str| {
            instance
                .get_export_index(&mut *store, Some(&iface), name)
                .ok_or_else(|| anyhow!("{} exports no `{name}`", path.display()))
        };

        let render_idx = find(&mut self.store, "render")?;
        let render = instance
            .get_typed_func::<(f32, f32), ()>(&mut self.store, &render_idx)
            .map_err(|e| anyhow!("{}'s `render` has the wrong type: {e:?}", path.display()))?;
        let measure_idx = find(&mut self.store, "measure")?;
        let measure = instance
            .get_typed_func::<(MeasureRequest,), (Size,)>(&mut self.store, &measure_idx)
            .ok();

        Ok(Widget {
            render: Some(render),
            measure,
            root: None,
            slots: Default::default(),
        })
    }

    /// Ask a component for its root widget and keep the handle.
    ///
    /// The handle lives as long as the store. Dropping it properly needs
    /// `resource_drop`, which matters once a root can be replaced —
    /// navigation, or a component that rebuilds its tree.
    fn start_root(
        &mut self,
        instance: &wasmtime::component::Instance,
        app: &wasmtime::component::ComponentExportIndex,
        path: &Path,
    ) -> Result<Widget> {
        let find = |store: &mut Store<UiHostState>, name: &str| {
            instance
                .get_export_index(&mut *store, Some(app), name)
                .ok_or_else(|| anyhow!("{} exports no `{name}`", path.display()))
        };

        let start_idx = find(&mut self.store, "start")?;
        let start = instance
            .get_typed_func::<(), (ResourceAny,)>(&mut self.store, &start_idx)
            .map_err(|e| anyhow!("{}'s `start` has the wrong type: {e:?}", path.display()))?;

        let mount_idx = find(&mut self.store, "[method]root.mount")?;
        let mount = instance
            .get_typed_func::<(ResourceAny,), ()>(&mut self.store, &mount_idx)
            .map_err(|e| anyhow!("{}'s `root.mount` has the wrong type: {e:?}", path.display()))?;

        let (handle,) = start
            .call(&mut self.store, ())
            .map_err(|e| anyhow!("{}'s `start` trapped: {e:?}", path.display()))?;

        Ok(Widget {
            render: None,
            measure: None,
            root: Some((handle, mount)),
            slots: Default::default(),
        })
    }

    /// Instantiate the components `spawn` promised handles for.
    ///
    /// A host function cannot instantiate: it holds neither the `Linker`
    /// nor the compiled `Component`. `spawn` records the request and puts
    /// an empty entry in place so the handle it returned already resolves;
    /// this fills that entry in, between the frame that asked and the next.
    /// A failure leaves it empty rather than removing it, because the guest
    /// holds the handle either way and an empty widget draws nothing.
    fn service_spawns(&mut self) -> bool {
        let queued = std::mem::take(&mut self.store.data_mut().pending_spawns);
        let serviced = !queued.is_empty();
        for (handle, source) in queued {
            let dir = self.store.data().component_dir.clone();
            // A component names a sibling file and nothing else: no
            // separators, no traversal. This is where a policy check goes.
            let named = Path::new(&source);
            if named.components().count() != 1 {
                log::error!("a component may only spawn a sibling file, not {source:?}");
                continue;
            }
            match self.instantiate(&dir.join(named)) {
                Ok(widget) => {
                    // Slots the embedder filled before the child existed are
                    // already on the entry, so only the exports are written.
                    let entry = &mut self.store.data_mut().widgets[handle as usize];
                    entry.render = widget.render;
                    entry.measure = widget.measure;
                }
                Err(e) => log::error!("could not spawn {source:?}: {e:?}"),
            }
        }
        serviced
    }
}

impl GuestScene {
    /// What the last frame cost at the host boundary: `solve` calls the
    /// guest made, and `measure` calls the host had to make back into a
    /// component because the tree crossed a component boundary.
    pub fn last_frame_calls(&self) -> (u32, u32) {
        let d = self.store.data();
        (d.solves, d.cross_measures)
    }

    /// Every entry into a component since this scene was created. A
    /// retained tree leaves it flat once mounted, however often the window
    /// is resized.
    pub fn guest_entries(&self) -> u32 {
        self.store.data().guest_entries
    }
}

impl Scene for GuestScene {
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        self.spawned_last_frame = self.service_spawns();

        self.store.data_mut().frame.clear();
        self.store.data_mut().solves = 0;
        self.store.data_mut().cross_measures = 0;
        self.store.data_mut().origin = (0.0, 0.0);
        self.store.data_mut().stack.clear();
        self.store.data_mut().stack.push(self.root);

        let entry = self.store.data().widgets[self.root as usize].clone();
        let size = Size {
            width: frame.width as f32,
            height: frame.height as f32,
        };

        // A retained root installs its tree once. Every frame after that —
        // a resize included — is solved and painted by the host with no
        // call into any component.
        if let Some((handle, mount)) = entry.root {
            if !self.mounted {
                self.mounted = true;
                self.store.data_mut().guest_entries += 1;
                if let Err(e) = mount.call(&mut self.store, (handle,)) {
                    log::error!("the root component trapped in `mount`: {e:?}");
                    return Vec::new();
                }
            }
            let data = self.store.data_mut();
            let UiHostState { scene, text, .. } = data;
            let commands = scene.draw(size, text);
            self.store.data_mut().stack.clear();
            return commands;
        }

        let Some(render) = entry.render else {
            return Vec::new();
        };
        self.store.data_mut().guest_entries += 1;
        if let Err(e) = render.call(&mut self.store, (size.width, size.height)) {
            log::error!("the root component trapped in `render`: {e:?}");
            self.store.data_mut().stack.clear();
            return Vec::new();
        }
        self.store.data_mut().stack.clear();

        // A spawn asked for during this frame is serviced before the next
        // one, so a component that spawns on its first frame draws the child
        // on its second.
        std::mem::take(&mut self.store.data_mut().frame)
    }

    fn text(&self) -> &TextEngine {
        &self.store.data().text
    }

    fn text_mut(&mut self) -> &mut TextEngine {
        &mut self.store.data_mut().text
    }

    fn background(&self) -> Color {
        self.background
    }

    /// A component that spawns a child asks for it during a frame and gets
    /// the handle back immediately, but the child is not instantiated until
    /// the frame ends. One more frame is owed so the child can draw.
    fn wants_another_frame(&self) -> bool {
        !self.store.data().pending_spawns.is_empty()
            || self.spawned_last_frame
            || self.store.data().scene.dirty
    }
}
