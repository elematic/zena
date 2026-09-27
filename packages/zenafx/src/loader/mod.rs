//! Loading a ZenaFX application component and running it as a scene.
//!
//! The smallest form of §6.2's path: compile a component, build a `Linker`
//! for it, bind its `zenafx:host` imports, instantiate, and call it once per
//! frame. Fetching over the network, caching by content hash and the policy
//! check come later, as does the second instance the application's
//! `zenafx:ui/scene` import binds to.

pub mod link;

use std::path::Path;

use anyhow::{Result, anyhow};
use wasmtime::component::{Component, Linker, TypedFunc};
use wasmtime::{Config, Engine, Store};

use crate::ui::surface::Scene;
use crate::ui::text::TextEngine;
use crate::ui::types::{Color, Command, FrameEvent};
use link::{UiHostState, add_host_to_linker};

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

/// An application component, instantiated and ready to render.
pub struct GuestScene {
    store: Store<UiHostState>,
    render: TypedFunc<(f32, f32), ()>,
    background: Color,
}

impl GuestScene {
    /// Compile and instantiate the component at `path`.
    pub fn load(engine: &Engine, path: &Path) -> Result<Self> {
        let component = Component::from_file(engine, path)
            .map_err(|e| anyhow!("could not load a component from {}: {e:?}", path.display()))?;

        let mut linker: Linker<UiHostState> = Linker::new(engine);
        add_host_to_linker(&mut linker)?;

        let mut store = Store::new(engine, UiHostState::new());
        // Instantiation is where a missing or mistyped host import surfaces:
        // the linker typechecks what it defined against what the component
        // asked for.
        let instance = linker
            .instantiate(&mut store, &component)
            .map_err(|e| anyhow!("could not instantiate {}: {e:?}", path.display()))?;

        let render = instance
            .get_typed_func::<(f32, f32), ()>(&mut store, "render")
            .map_err(|e| anyhow!("the component does not export `render: func(f32, f32)`: {e:?}"))?;

        Ok(Self {
            store,
            render,
            background: Color::rgb(1.0, 1.0, 1.0),
        })
    }
}

impl Scene for GuestScene {
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        self.store.data_mut().frame.clear();
        let size = (frame.width as f32, frame.height as f32);
        if let Err(e) = self.render.call(&mut self.store, size) {
            log::error!("the component trapped in `render`: {e:?}");
            return Vec::new();
        }
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
}
