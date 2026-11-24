//! Native `winit` scene wrapper around [`zenafx_render::demo`].

use std::sync::{Arc, Mutex};

pub use zenafx_render::demo::{FlatScene, PAGE, hello};

use super::surface::Scene;
use super::text::TextEngine;
use super::types::{Color, Command, FrameEvent, Size};

/// The [`Scene`] the window runs: builds [`hello`] once, then re-solves it at
/// whatever size each frame arrives with.
pub struct HelloScene {
    message: String,
    text: Arc<Mutex<TextEngine>>,
    scene: Option<FlatScene>,
}

impl HelloScene {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            text: Arc::new(Mutex::new(TextEngine::new())),
            scene: None,
        }
    }
}

impl Scene for HelloScene {
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command> {
        let message = self.message.clone();
        let engine = self.text.clone();
        let mut text = engine.lock().unwrap();
        let scene = self.scene.get_or_insert_with(|| hello(&mut text, &message));
        scene.display_list(
            Size {
                width: frame.width as f32,
                height: frame.height as f32,
            },
            &mut text,
        )
    }

    fn text(&self) -> Arc<Mutex<TextEngine>> {
        self.text.clone()
    }

    fn background(&self) -> Color {
        PAGE
    }
}
