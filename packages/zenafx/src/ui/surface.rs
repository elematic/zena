//! `zenafx:host/surface`: the window, its input, and when a frame happens.
//!
//! A frame event is produced when a redraw was requested, and at no other
//! time. The loop runs under [`ControlFlow::Wait`], so an idle application
//! costs nothing — which is why ZenaFX does not sit on `wasi-gfx:surface`,
//! whose runtime wakes every surface 60 times a second whether or not
//! anything was invalidated. "Surface, frames and demand-driven redraw" in
//! `docs/design/zenafx-ui.md`.

use std::num::NonZeroU32;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context as _, Result};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, KeyCode, NamedKey, PhysicalKey};
use winit::window::{CursorIcon, Window, WindowId};

use super::events::{KeyEvent, Modifiers, PointerInput};
use super::scene::Cursor;
use super::paint::Painter;
use super::text::TextEngine;
use super::types::{Color, Command, FrameEvent};

/// How far one notch of a mouse wheel scrolls, in physical pixels. Three
/// lines of body text, near enough, which is what desktops default to.
const WHEEL_NOTCH: f32 = 48.0;

/// Asks the window for a frame. Callable from any thread, any number of
/// times: requests made before the next frame become one frame.
pub type Wake = Arc<dyn Fn() + Send + Sync>;

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
    /// nothing without the engine that minted them. It is shared rather
    /// than borrowed because a guest scene's engine is also written from
    /// inside the component's store, whose task holds the store for as
    /// long as it is parked.
    fn text(&self) -> Arc<Mutex<TextEngine>>;

    /// What to clear to before drawing.
    fn background(&self) -> Color {
        Color::rgb(1.0, 1.0, 1.0)
    }

    /// Returns whether the scene changed and wants another frame.
    fn pointer(&mut self, _input: PointerInput) -> bool {
        false
    }

    /// Take the means to ask for a frame from outside the window's thread.
    ///
    /// Called once, before the first frame. A scene that only changes in
    /// answer to the calls above has no use for it. A scene whose content is
    /// written from another thread calls it when that content changes, since
    /// the window is otherwise asleep until its next input.
    fn woken_by(&mut self, _wake: Wake) {}

    /// Returns whether the scene changed and wants another frame.
    fn key(&mut self, _event: KeyEvent) -> bool {
        false
    }

    /// The cursor to show, given what the pointer is over. Asked after every
    /// input and every frame, since either can change it.
    fn cursor(&self) -> Cursor {
        Cursor::Default
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
pub fn run(config: WindowConfig, mut scene: impl Scene + 'static) -> Result<()> {
    let event_loop = EventLoop::new().context("failed to create the winit event loop")?;
    event_loop.set_control_flow(ControlFlow::Wait);

    // A wake is a user event, which is what brings a loop under
    // `ControlFlow::Wait` round when no input has arrived. The loop has gone
    // once the window closes, and a wake sent after that has nothing to do.
    let proxy = event_loop.create_proxy();
    scene.woken_by(Arc::new(move || {
        let _ = proxy.send_event(());
    }));

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
    /// The cursor the window was last told to show.
    shown: Cursor,
    /// The modifier keys held, which winit reports apart from the keys they
    /// are held with.
    modifiers: Modifiers,
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
        self.scene.text().lock().unwrap().set_scale(window.scale_factor() as f32);
        self.window = Some(Live {
            window: window.clone(),
            surface,
            painter: Painter::new(size.width as u16, size.height as u16),
            cursor: (0.0, 0.0),
            shown: Cursor::Default,
            modifiers: Modifiers::default(),
        });
        self.started = Instant::now();
        window.request_redraw();
    }

    /// A [`Wake`]: the scene changed on another thread and is owed a frame.
    fn user_event(&mut self, _event_loop: &ActiveEventLoop, _event: ()) {
        if let Some(live) = self.window.as_ref() {
            live.window.request_redraw();
        }
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
                self.scene
                    .text()
                    .lock()
                    .unwrap()
                    .set_scale(live.window.scale_factor() as f32);
                live.window.request_redraw();
            }

            WindowEvent::CursorMoved { position, .. } => {
                live.cursor = (position.x as f32, position.y as f32);
                let wants = self.scene.pointer(PointerInput::Moved {
                    x: live.cursor.0,
                    y: live.cursor.1,
                });
                if wants {
                    live.window.request_redraw();
                }
            }

            WindowEvent::CursorLeft { .. } => {
                if self.scene.pointer(PointerInput::Left) {
                    live.window.request_redraw();
                }
            }

            WindowEvent::MouseWheel { delta, .. } => {
                // winit says which way the wheel or the fingers moved, and
                // the content follows them: fingers moving up bring the
                // content up, which is scrolling further down. A wheel
                // reports notches, and a touchpad the distance itself.
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (-x * WHEEL_NOTCH, -y * WHEEL_NOTCH),
                    MouseScrollDelta::PixelDelta(by) => (-by.x as f32, -by.y as f32),
                };
                let wants = self.scene.pointer(PointerInput::Wheel {
                    x: live.cursor.0,
                    y: live.cursor.1,
                    dx,
                    dy,
                });
                if wants {
                    live.window.request_redraw();
                }
            }

            WindowEvent::MouseInput { state, button, .. } => {
                let wants = self.scene.pointer(PointerInput::Button {
                    x: live.cursor.0,
                    y: live.cursor.1,
                    button: button_code(button),
                    down: state == ElementState::Pressed,
                });
                if wants {
                    live.window.request_redraw();
                }
            }

            WindowEvent::ModifiersChanged(modifiers) => {
                let held = modifiers.state();
                live.modifiers = Modifiers {
                    shift: held.shift_key(),
                    control: held.control_key(),
                    alt: held.alt_key(),
                    meta: held.super_key(),
                };
            }

            WindowEvent::KeyboardInput { event, .. } => {
                let down = event.state == ElementState::Pressed;
                let wants = self.scene.key(KeyEvent {
                    down,
                    key: key_name(&event.logical_key),
                    code: code_name(event.physical_key),
                    modifiers: live.modifiers,
                    repeat: event.repeat,
                    text: typed(down, event.text.as_deref(), live.modifiers),
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
                    .draw(
                        &commands,
                        self.scene.background(),
                        &self.scene.text().lock().unwrap(),
                    );

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
                            // The first frame is the one worth a line: it says
                            // the window came up and drew something, and
                            // `tests/run.rs` waits for it. A component that
                            // keeps asking for redraws would make every frame
                            // after it a line, so those are trace and come back
                            // with `RUST_LOG=zenafx=trace`.
                            let level = if self.frames == 1 {
                                log::Level::Info
                            } else {
                                log::Level::Trace
                            };
                            log::log!(
                                level,
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

        let cursor = self.scene.cursor();
        if cursor != live.shown {
            live.window.set_cursor(icon(cursor));
            live.shown = cursor;
        }
    }
}

/// What a key means, as the W3C's keyboard events name it: the character it
/// types, or the name of a key that types none.
///
/// winit names its keys after the same specification, so a named key's name
/// is the one wanted, with two exceptions: the space bar's value is the space
/// it types, and the key winit calls Super is `Meta`.
pub fn key_name(key: &Key) -> String {
    match key {
        Key::Character(typed) => typed.to_string(),
        Key::Named(NamedKey::Space) => " ".to_owned(),
        Key::Named(NamedKey::Super) => "Meta".to_owned(),
        Key::Named(named) => format!("{named:?}"),
        Key::Dead(_) => "Dead".to_owned(),
        Key::Unidentified(_) => "Unidentified".to_owned(),
    }
}

/// The text a key press types, from the text the platform says it produced.
///
/// The platform reports text for keys that type none: a carriage return for
/// `Enter`, a tab, a backspace character, and a control character for a
/// letter pressed with `Control`. None of those is typing. A letter pressed
/// with `Control` or `Meta` is a shortcut whatever the platform makes of it.
pub fn typed(down: bool, produced: Option<&str>, held: Modifiers) -> Option<String> {
    let produced = produced?;
    let types = down
        && !held.control
        && !held.meta
        && !produced.is_empty()
        && !produced.chars().any(char::is_control);
    types.then(|| produced.to_owned())
}

/// Which key it is on the keyboard, as the W3C's keyboard events name it:
/// `KeyA`, `Space`, `Enter`. winit's names are the specification's, but for
/// the two it calls Super.
pub fn code_name(key: PhysicalKey) -> String {
    match key {
        PhysicalKey::Code(KeyCode::SuperLeft) => "MetaLeft".to_owned(),
        PhysicalKey::Code(KeyCode::SuperRight) => "MetaRight".to_owned(),
        PhysicalKey::Code(code) => format!("{code:?}"),
        PhysicalKey::Unidentified(_) => "Unidentified".to_owned(),
    }
}

/// The platform cursor for a cursor. winit names its cursors after CSS's
/// keywords, as the interface does, so each is the one of the same name.
/// The platform draws it.
pub fn icon(cursor: Cursor) -> CursorIcon {
    match cursor {
        Cursor::Default => CursorIcon::Default,
        Cursor::ContextMenu => CursorIcon::ContextMenu,
        Cursor::Help => CursorIcon::Help,
        Cursor::Pointer => CursorIcon::Pointer,
        Cursor::Progress => CursorIcon::Progress,
        Cursor::Wait => CursorIcon::Wait,
        Cursor::Cell => CursorIcon::Cell,
        Cursor::Crosshair => CursorIcon::Crosshair,
        Cursor::Text => CursorIcon::Text,
        Cursor::VerticalText => CursorIcon::VerticalText,
        Cursor::Alias => CursorIcon::Alias,
        Cursor::Copy => CursorIcon::Copy,
        Cursor::Move => CursorIcon::Move,
        Cursor::NoDrop => CursorIcon::NoDrop,
        Cursor::NotAllowed => CursorIcon::NotAllowed,
        Cursor::Grab => CursorIcon::Grab,
        Cursor::Grabbing => CursorIcon::Grabbing,
        Cursor::EResize => CursorIcon::EResize,
        Cursor::NResize => CursorIcon::NResize,
        Cursor::NeResize => CursorIcon::NeResize,
        Cursor::NwResize => CursorIcon::NwResize,
        Cursor::SResize => CursorIcon::SResize,
        Cursor::SeResize => CursorIcon::SeResize,
        Cursor::SwResize => CursorIcon::SwResize,
        Cursor::WResize => CursorIcon::WResize,
        Cursor::EwResize => CursorIcon::EwResize,
        Cursor::NsResize => CursorIcon::NsResize,
        Cursor::NeswResize => CursorIcon::NeswResize,
        Cursor::NwseResize => CursorIcon::NwseResize,
        Cursor::ColResize => CursorIcon::ColResize,
        Cursor::RowResize => CursorIcon::RowResize,
        Cursor::AllScroll => CursorIcon::AllScroll,
        Cursor::ZoomIn => CursorIcon::ZoomIn,
        Cursor::ZoomOut => CursorIcon::ZoomOut,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Each cursor is the platform's cursor of the same name. The two sets
    /// of names are both CSS's, so the names agree once they are written
    /// the same way.
    #[test]
    fn each_cursor_is_the_platform_cursor_of_its_name() {
        for cursor in Cursor::ALL {
            assert_eq!(format!("{cursor:?}"), format!("{:?}", icon(cursor)));
        }
    }

    /// A handler compares `key` with the names the W3C gives, so the names
    /// the window hands on are those: the character for a key that types
    /// one, the space bar included, and the specification's name otherwise.
    #[test]
    fn keys_are_named_as_the_w3c_names_them() {
        assert_eq!(key_name(&Key::Character("a".into())), "a");
        assert_eq!(key_name(&Key::Character("É".into())), "É");
        assert_eq!(key_name(&Key::Named(NamedKey::Space)), " ");
        assert_eq!(key_name(&Key::Named(NamedKey::Enter)), "Enter");
        assert_eq!(key_name(&Key::Named(NamedKey::Tab)), "Tab");
        assert_eq!(key_name(&Key::Named(NamedKey::ArrowDown)), "ArrowDown");
        assert_eq!(key_name(&Key::Named(NamedKey::Super)), "Meta");

        assert_eq!(code_name(PhysicalKey::Code(KeyCode::KeyA)), "KeyA");
        assert_eq!(code_name(PhysicalKey::Code(KeyCode::Space)), "Space");
        assert_eq!(code_name(PhysicalKey::Code(KeyCode::SuperLeft)), "MetaLeft");
    }

    /// A key types what the platform says it produced, unless that is a
    /// control character, the key is coming up, or it is a shortcut.
    #[test]
    fn a_key_types_text_only_when_it_is_typing() {
        let none = Modifiers::default();
        let with = |control, meta, shift| Modifiers {
            control,
            meta,
            shift,
            ..Modifiers::default()
        };

        assert_eq!(typed(true, Some("a"), none), Some("a".to_owned()));
        assert_eq!(
            typed(true, Some("É"), with(false, false, true)),
            Some("É".to_owned())
        );
        assert_eq!(typed(true, Some(" "), none), Some(" ".to_owned()));

        assert_eq!(typed(false, Some("a"), none), None, "coming up");
        assert_eq!(typed(true, None, none), None, "an arrow");
        assert_eq!(typed(true, Some("\r"), none), None, "Enter");
        assert_eq!(typed(true, Some("\t"), none), None, "Tab");
        assert_eq!(typed(true, Some("\u{8}"), none), None, "Backspace");
        assert_eq!(typed(true, Some("\u{7f}"), none), None, "Delete");
        assert_eq!(typed(true, Some("a"), with(true, false, false)), None);
        assert_eq!(typed(true, Some("a"), with(false, true, false)), None);
    }
}
