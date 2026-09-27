//! `zenafx:host/surface`: the window, its input, and when a frame happens.
//!
//! A frame event is produced when a redraw was requested, and at no other
//! time. The loop runs under [`ControlFlow::Wait`], so an idle application
//! costs nothing — which is why ZenaFX does not sit on `wasi-gfx:surface`,
//! whose runtime wakes every surface 60 times a second whether or not
//! anything was invalidated. §8.4 of `docs/design/zenafx-ui.md`.

use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context as _, Result};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::PhysicalKey;
use winit::window::{Window, WindowId};

use super::paint::Painter;
use super::text::TextEngine;
use super::types::{Color, Command, FrameEvent, KeyEvent, PointerEvent};

/// What the window shows.
///
/// This is the seam the loader will sit behind: today [`super::demo`]
/// implements it in Rust, and a guest component implements it once the
/// loader exists. Either way the host owns the frame clock and asks for a
/// display list when a frame is due.
pub trait Scene {
    /// Produce the display list for one frame.
    fn frame(&mut self, frame: FrameEvent) -> Vec<Command>;

    /// The runs this scene's display list refers to.
    ///
    /// A scene owns its text engine: the ids in a `Glyphs` command mean
    /// nothing without the engine that minted them, and for a guest scene
    /// the engine lives inside the component's store.
    fn text(&self) -> &TextEngine;

    fn text_mut(&mut self) -> &mut TextEngine;

    /// What to clear to before drawing.
    fn background(&self) -> Color {
        Color::rgb(1.0, 1.0, 1.0)
    }

    /// Returns whether the scene changed and wants another frame.
    fn pointer(&mut self, _event: PointerEvent) -> bool {
        false
    }

    /// Returns whether the scene changed and wants another frame.
    fn key(&mut self, _event: KeyEvent) -> bool {
        false
    }

    /// Whether the scene has work that needs one more frame. Asked after
    /// each frame; a scene that always answers `true` runs the window flat
    /// out, which is what `ControlFlow::Wait` otherwise avoids.
    fn wants_another_frame(&self) -> bool {
        false
    }
}

/// How the window is opened.
#[derive(Clone, Debug)]
pub struct WindowConfig {
    pub title: String,
    pub width: u32,
    pub height: u32,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            title: "ZenaFX".to_owned(),
            width: 800,
            height: 600,
        }
    }
}

/// Open a window and run `scene` in it until it is closed.
///
/// This takes over the calling thread, and on macOS must be called from the
/// main one.
pub fn run(config: WindowConfig, scene: impl Scene + 'static) -> Result<()> {
    let event_loop = EventLoop::new().context("failed to create the winit event loop")?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut app = App {
        config,
        scene: Box::new(scene),
        window: None,
        started: Instant::now(),
        frames: 0,
    };
    event_loop.run_app(&mut app).context("the window loop failed")
}

/// The window and everything that had to wait for it to exist.
struct Live {
    window: Arc<Window>,
    surface: softbuffer::Surface<Arc<Window>, Arc<Window>>,
    painter: Painter,
    /// The last pointer position, so a button event can carry one.
    cursor: (f32, f32),
}

struct App {
    config: WindowConfig,
    scene: Box<dyn Scene>,
    window: Option<Live>,
    started: Instant,
    frames: u64,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title(self.config.title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.config.width,
                self.config.height,
            ));
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                log::error!("could not open a window: {e}");
                event_loop.exit();
                return;
            }
        };
        let context = match softbuffer::Context::new(window.clone()) {
            Ok(c) => c,
            Err(e) => {
                log::error!("could not create a softbuffer context: {e}");
                event_loop.exit();
                return;
            }
        };
        let surface = match softbuffer::Surface::new(&context, window.clone()) {
            Ok(s) => s,
            Err(e) => {
                log::error!("could not create a softbuffer surface: {e}");
                event_loop.exit();
                return;
            }
        };
        let size = window.inner_size();
        self.scene.text_mut().set_scale(window.scale_factor() as f32);
        self.window = Some(Live {
            window: window.clone(),
            surface,
            painter: Painter::new(size.width as u16, size.height as u16),
            cursor: (0.0, 0.0),
        });
        self.started = Instant::now();
        window.request_redraw();
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        let Some(live) = self.window.as_mut() else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),

            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                self.scene.text_mut().set_scale(live.window.scale_factor() as f32);
                live.window.request_redraw();
            }

            WindowEvent::CursorMoved { position, .. } => {
                live.cursor = (position.x as f32, position.y as f32);
                let wants = self.scene.pointer(PointerEvent {
                    x: live.cursor.0,
                    y: live.cursor.1,
                    button: 0,
                    down: false,
                });
                if wants {
                    live.window.request_redraw();
                }
            }

            WindowEvent::MouseInput { state, button, .. } => {
                let wants = self.scene.pointer(PointerEvent {
                    x: live.cursor.0,
                    y: live.cursor.1,
                    button: button_code(button),
                    down: state == ElementState::Pressed,
                });
                if wants {
                    live.window.request_redraw();
                }
            }

            WindowEvent::KeyboardInput { event, .. } => {
                let wants = self.scene.key(KeyEvent {
                    code: match event.physical_key {
                        PhysicalKey::Code(c) => c as u32,
                        PhysicalKey::Unidentified(_) => 0,
                    },
                    down: event.state == ElementState::Pressed,
                    text: event.text.map(|t| t.to_string()).unwrap_or_default(),
                });
                if wants {
                    live.window.request_redraw();
                }
            }

            WindowEvent::RedrawRequested => {
                let size = live.window.inner_size();
                let (Some(w), Some(h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
                else {
                    // A zero-sized window is minimised; there is nothing to
                    // draw and softbuffer will not take the resize.
                    return;
                };

                let frame = FrameEvent {
                    time_ms: self.started.elapsed().as_secs_f64() * 1000.0,
                    width: size.width,
                    height: size.height,
                    scale: live.window.scale_factor() as f32,
                };
                let commands = self.scene.frame(frame);

                live.painter.resize(size.width as u16, size.height as u16);
                live.painter
                    .draw(&commands, self.scene.background(), self.scene.text());

                if let Err(e) = live.surface.resize(w, h) {
                    log::error!("could not resize the surface: {e}");
                    return;
                }
                match live.surface.buffer_mut() {
                    Ok(mut buffer) => {
                        live.painter.blit_to(&mut buffer);
                        if let Err(e) = buffer.present() {
                            log::error!("could not present a frame: {e}");
                        } else {
                            self.frames += 1;
                            if self.scene.wants_another_frame() {
                                live.window.request_redraw();
                            }
                            log::info!(
                                "presented frame {} at {}x{}, {} commands",
                                self.frames,
                                size.width,
                                size.height,
                                commands.len()
                            );
                        }
                    }
                    Err(e) => log::error!("could not acquire a frame buffer: {e}"),
                }
            }

            _ => {}
        }
    }
}

fn button_code(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
        MouseButton::Other(n) => n.min(u8::MAX as u16) as u8,
    }
}
