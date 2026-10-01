//! Loading a ZenaFX component and running it as a scene.
//!
//! The "Runtime linking" path at its smallest: compile a component, build a `Linker` for
//! it, bind its `zenafx:host` imports, instantiate, and ask it once what it
//! draws. Fetching over the network, caching by content hash and the policy
//! check come later.

pub mod link;

use std::path::Path;

use anyhow::{Result, anyhow};
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

use crate::ui::scene::SceneNode;
use crate::ui::surface::Scene;
use crate::ui::text::TextEngine;
use crate::ui::types::{Color, Command, FrameEvent, Size};
use link::{UiHostState, add_host_to_linker};

/// The interface a component exports to hand over what it draws.
const APP: &str = "zenafx:host/app@0.1.0";


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

/// The component a window shows, and the tree it installed.
pub struct GuestScene {
    store: Store<UiHostState>,
    background: Color,
}

impl GuestScene {
    /// Compile and instantiate the component at `path`, and mount what it
    /// draws.
    pub fn load(engine: &Engine, path: &Path) -> Result<Self> {
        let mut linker: Linker<UiHostState> = Linker::new(engine);
        add_host_to_linker(&mut linker)?;

        let mut scene = Self {
            store: Store::new(engine, UiHostState::new()),
            background: Color::rgb(1.0, 1.0, 1.0),
        };
        scene.start(&linker, engine, path)?;
        Ok(scene)
    }

    /// Ask the component what it draws, and mount it.
    ///
    /// The component builds its root widget and returns the tree that widget
    /// describes. Installing it is the host's job: a widget never mounts
    /// itself, never learns that it was mounted, and holds nothing
    /// afterwards. This is the only call the component ever receives.
    fn start(&mut self, linker: &Linker<UiHostState>, engine: &Engine, path: &Path) -> Result<()> {
        let component = Component::from_file(engine, path)
            .map_err(|e| anyhow!("could not load a component from {}: {e:?}", path.display()))?;
        // Instantiation is where a missing or mistyped host import surfaces:
        // the linker typechecks what it defined against what the component
        // asked for.
        let instance = linker
            .instantiate(&mut self.store, &component)
            .map_err(|e| anyhow!("could not instantiate {}: {e:?}", path.display()))?;

        let app = instance
            .get_export_index(&mut self.store, None, APP)
            .ok_or_else(|| anyhow!("{} does not export {APP}", path.display()))?;
        let start_idx = instance
            .get_export_index(&mut self.store, Some(&app), "start")
            .ok_or_else(|| anyhow!("{} exports no `start`", path.display()))?;
        let start = instance
            .get_typed_func::<(), (Vec<SceneNode>,)>(&mut self.store, &start_idx)
            .map_err(|e| anyhow!("{}'s `start` has the wrong type: {e:?}", path.display()))?;

        self.store.data_mut().guest_entries += 1;
        let (nodes,) = start
            .call(&mut self.store, ())
            .map_err(|e| anyhow!("{}'s `start` trapped: {e:?}", path.display()))?;

        let UiHostState { scene, text, .. } = self.store.data_mut();
        scene.install(None, &nodes, text);
        Ok(())
    }
}

impl GuestScene {
    /// Every entry into the component since this scene was created. A
    /// retained tree leaves it at one, however often the window is resized.
    pub fn guest_entries(&self) -> u32 {
        self.store.data().guest_entries
    }
}

impl Scene for GuestScene {
    /// Solve and paint the installed tree. The component was entered once,
    /// at load, and a frame — a resize included — does not enter it again.
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        let size = Size {
            width: frame.width as f32,
            height: frame.height as f32,
        };
        let UiHostState { scene, text, .. } = self.store.data_mut();
        scene.draw(size, text)
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

    /// A component that replaces part of its tree calls `invalidate`, which
    /// marks the scene dirty and owes one more frame.
    fn wants_another_frame(&self) -> bool {
        self.store.data().scene.dirty
    }
}
