//! WebAssembly C-ABI bridge around [`zenafx_render`].
//!
//! Compiles to `wasm32-unknown-unknown` so the browser host runs the exact same
//! retained scene graph, `taffy` flexbox solver, `parley` text shaper, and
//! `vello_cpu` rasterizer as the native `zfx` binary.

mod codec;

use std::alloc::{Layout, alloc as rust_alloc, dealloc as rust_dealloc};
use std::cell::RefCell;
use std::fmt::Write as _;

use zenafx_render::demo::{self, FlatScene};
use zenafx_render::events::{
    KeyDefault, KeyListener, Listener, Phase, PointerInput, PointerKind, Scope,
};
use zenafx_render::paint::Painter;
use zenafx_render::scene::{Scene, TextSelection};
use zenafx_render::text::TextEngine;
use zenafx_render::types::{Color, Command, Size};

struct EngineInstance {
    text: TextEngine,
    scene: Scene,
    demo_scene: Option<FlatScene>,
    painter: Painter,
    rgba_buf: Vec<u8>,
    out_buf: Vec<u8>,
    last_commands: Vec<Command>,
}

impl EngineInstance {
    fn new() -> Self {
        Self {
            text: TextEngine::new(),
            scene: Scene::new(),
            demo_scene: None,
            painter: Painter::new(1, 1),
            rgba_buf: Vec::new(),
            out_buf: Vec::new(),
            last_commands: Vec::new(),
        }
    }
}

thread_local! {
    static ENGINES: RefCell<Vec<Option<EngineInstance>>> = const { RefCell::new(Vec::new()) };
}

fn with_engine<R>(handle: u32, f: impl FnOnce(&mut EngineInstance) -> R) -> Option<R> {
    ENGINES.with(|cell| {
        let mut list = cell.borrow_mut();
        let slot = list.get_mut(handle as usize)?.as_mut()?;
        Some(f(slot))
    })
}

/// Allocate `len` bytes in Wasm linear memory (8-byte aligned).
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let size = len.max(1);
    let layout = Layout::from_size_align(size, 8).expect("valid layout");
    unsafe { rust_alloc(layout) }
}

/// Free a buffer previously returned by [`alloc`].
#[unsafe(no_mangle)]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let size = len.max(1);
    let layout = Layout::from_size_align(size, 8).expect("valid layout");
    unsafe { rust_dealloc(ptr, layout) };
}

/// Create a new ZenaFX rendering engine instance and return its handle.
#[unsafe(no_mangle)]
pub extern "C" fn engine_new() -> u32 {
    ENGINES.with(|cell| {
        let mut list = cell.borrow_mut();
        if let Some((idx, slot)) = list.iter_mut().enumerate().find(|(_, s)| s.is_none()) {
            *slot = Some(EngineInstance::new());
            idx as u32
        } else {
            list.push(Some(EngineInstance::new()));
            (list.len() - 1) as u32
        }
    })
}

/// Destroy an engine instance and release its memory.
#[unsafe(no_mangle)]
pub extern "C" fn engine_drop(handle: u32) {
    ENGINES.with(|cell| {
        let mut list = cell.borrow_mut();
        if let Some(slot) = list.get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// Register raw TTF/OTF font bytes with the engine's `TextEngine`.
/// Returns the number of font faces registered.
#[unsafe(no_mangle)]
pub extern "C" fn engine_register_font(handle: u32, ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    with_engine(handle, |eng| eng.text.register_font(bytes) as u32).unwrap_or(0)
}

/// Set physical pixels per logical pixel (devicePixelRatio).
#[unsafe(no_mangle)]
pub extern "C" fn engine_set_scale(handle: u32, scale: f32) {
    with_engine(handle, |eng| {
        eng.text.set_scale(scale);
    });
}

/// Load the built-in Rust "Hello, world" card demo (the web equivalent of `zfx --ui`).
#[unsafe(no_mangle)]
pub extern "C" fn engine_load_hello_demo(handle: u32, ptr: *const u8, len: usize) {
    let message = if ptr.is_null() || len == 0 {
        "Hello from ZenaFX on the Web!".to_owned()
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        String::from_utf8_lossy(bytes).into_owned()
    };
    with_engine(handle, |eng| {
        let flat = demo::hello(&mut eng.text, &message);
        eng.demo_scene = Some(flat);
    });
}

/// `zenafx:host/scene.root()` -> root node id.
#[unsafe(no_mangle)]
pub extern "C" fn scene_root(handle: u32) -> u32 {
    with_engine(handle, |eng| {
        eng.demo_scene = None;
        eng.scene.root()
    })
    .unwrap_or(0)
}

/// `zenafx:host/scene.create-node()`.
#[unsafe(no_mangle)]
pub extern "C" fn scene_create_node(handle: u32) -> u32 {
    with_engine(handle, |eng| eng.scene.create_node()).unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.set-slot(node, slot, children)`.
/// `ptr` points to `len` little-endian `u32` child node ids.
/// Returns 1 on success, 0 if the slot or any child id is invalid.
#[unsafe(no_mangle)]
pub extern "C" fn scene_set_slot(
    handle: u32,
    node: u32,
    slot: u32,
    ptr: *const u32,
    len: usize,
) -> u32 {
    let children: &[u32] = if len == 0 {
        &[]
    } else if ptr.is_null() {
        return 0;
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };
    with_engine(handle, |eng| {
        u32::from(eng.scene.set_slot(node, slot, children, &mut eng.text))
    })
    .unwrap_or(0)
}

/// `resource.drop` on `zenafx:host/scene.node`.
/// Returns 1 if a guest-owned node was freed, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn scene_drop_node(handle: u32, node: u32) -> u32 {
    with_engine(handle, |eng| u32::from(eng.scene.drop_node(node, &mut eng.text))).unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.render(...)` with binary-encoded `(TemplateRef, Vec<Hole>)`.
/// Returns 1 on success, 0 on decode failure.
#[unsafe(no_mangle)]
pub extern "C" fn scene_render(handle: u32, node: u32, ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut reader = codec::Reader::new(bytes);
    let Some((template, holes)) = reader.render_payload() else {
        return 0;
    };
    with_engine(handle, |eng| {
        eng.scene.render(node, &template, &holes, &mut eng.text);
        1
    })
    .unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.content(node, slot, count)`.
/// Writes the resulting child node ids (`len: u32, ids: [u32; len]`) into `out_buf`.
/// Returns 1 on success, 0 if the slot does not exist.
#[unsafe(no_mangle)]
pub extern "C" fn scene_content(handle: u32, node: u32, slot: u32, count: u32) -> u32 {
    with_engine(handle, |eng| {
        match eng.scene.content(node, slot, count, &mut eng.text) {
            Some(ids) => {
                codec::encode_u32_slice(&ids, &mut eng.out_buf);
                1
            }
            None => 0,
        }
    })
    .unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.listen-pointer(...)`.
/// Returns 1 if registered, 0 if `target` is out of range for `node`'s template.
#[unsafe(no_mangle)]
pub extern "C" fn scene_listen_pointer(
    handle: u32,
    node: u32,
    target: u32,
    kind: u32,
    scope: u32,
    phase: u32,
    listener_id: u32,
) -> u32 {
    let kind = match kind {
        0 => PointerKind::Down,
        1 => PointerKind::Up,
        2 => PointerKind::Move,
        3 => PointerKind::Enter,
        4 => PointerKind::Leave,
        _ => return 0,
    };
    let scope = match scope {
        0 => Scope::Node,
        1 => Scope::Subtree,
        2 => Scope::Captured,
        _ => return 0,
    };
    let phase = match phase {
        0 => Phase::Bubble,
        1 => Phase::Intercept,
        _ => return 0,
    };
    with_engine(handle, |eng| {
        u32::from(eng.scene.listen(
            node,
            target,
            Listener {
                kind,
                scope,
                phase,
                id: listener_id,
            },
        ))
    })
    .unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.listen-keys(...)`.
/// Returns 1 if registered, 0 if `target` is out of range for `node`'s template.
#[unsafe(no_mangle)]
pub extern "C" fn scene_listen_keys(
    handle: u32,
    node: u32,
    target: u32,
    phase: u32,
    listener_id: u32,
) -> u32 {
    let phase = match phase {
        0 => Phase::Bubble,
        1 => Phase::Intercept,
        _ => return 0,
    };
    with_engine(handle, |eng| {
        u32::from(eng.scene.listen_keys(
            node,
            target,
            KeyListener {
                phase,
                id: listener_id,
            },
        ))
    })
    .unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.selection(target)`.
/// Writes `[anchor: u32, focus: u32]` to `out_buf` and returns 1 when present, 0 when none.
#[unsafe(no_mangle)]
pub extern "C" fn scene_selection_in(handle: u32, node: u32, target: u32) -> u32 {
    with_engine(handle, |eng| match eng.scene.selection_in(node, target) {
        Some(sel) => {
            codec::encode_u32_slice(&[sel.anchor, sel.focus], &mut eng.out_buf);
            1
        }
        None => {
            eng.out_buf.clear();
            0
        }
    })
    .unwrap_or(0)
}

/// `zenafx:host/scene.[method]node.select(target, to)`.
/// Returns 1 if selected, 0 if `target` is not a text node in `node`'s template.
#[unsafe(no_mangle)]
pub extern "C" fn scene_select(
    handle: u32,
    node: u32,
    target: u32,
    anchor: u32,
    focus: u32,
) -> u32 {
    with_engine(handle, |eng| {
        u32::from(eng.scene.select(node, target, TextSelection { anchor, focus }))
    })
    .unwrap_or(0)
}

/// `zenafx:host/events.[method]reply.capture`: capture the pointer for `listener_id`
/// and cancel any window selection started by the press. Returns 1 if dirty.
#[unsafe(no_mangle)]
pub extern "C" fn scene_capture(handle: u32, listener_id: u32) -> u32 {
    with_engine(handle, |eng| {
        eng.scene.capture(listener_id);
        eng.scene.cancel_selecting();
        u32::from(eng.scene.dirty)
    })
    .unwrap_or(0)
}

/// Current cursor enum index (`0..33`, matching `Cursor::ALL`).
#[unsafe(no_mangle)]
pub extern "C" fn scene_cursor(handle: u32) -> u32 {
    with_engine(handle, |eng| eng.scene.cursor() as u32).unwrap_or(0)
}

/// Currently selected text in the window, written as UTF-8 bytes to `out_buf`.
/// Returns 1 if text is selected, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn scene_selected_text(handle: u32) -> u32 {
    with_engine(handle, |eng| match eng.scene.selected_text() {
        Some(text) => {
            eng.out_buf = text.into_bytes();
            1
        }
        None => {
            eng.out_buf.clear();
            0
        }
    })
    .unwrap_or(0)
}

/// Remove a pointer or key listener by id.
#[unsafe(no_mangle)]
pub extern "C" fn scene_unlisten(handle: u32, listener_id: u32) {
    with_engine(handle, |eng| {
        eng.scene.unlisten(listener_id);
    });
}

/// Take listener ids whose nodes were removed since the last call.
/// Encoded into `out_buf` as `(count: u32, ids: [u32; count])`.
#[unsafe(no_mangle)]
pub extern "C" fn scene_take_ended(handle: u32) -> u32 {
    with_engine(handle, |eng| {
        let ended = eng.scene.take_ended();
        let count = ended.len() as u32;
        codec::encode_u32_slice(&ended, &mut eng.out_buf);
        count
    })
    .unwrap_or(0)
}

/// Feed a pointer input into the retained scene (including host text selection
/// using the caller's monotonic `now_ms`).
/// `input_kind`: 0 = Moved(x, y), 1 = Button(x, y, button=a as u8, down=b != 0.0),
/// 2 = Wheel(x, y, dx=a, dy=b), 3 = Left.
/// Encodes the resulting `Vec<Delivery>` into `out_buf`, and returns 1 if the
/// scene is dirty and owes a frame, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn scene_pointer(
    handle: u32,
    input_kind: u32,
    x: f32,
    y: f32,
    a: f32,
    b: f32,
    now_ms: f64,
) -> u32 {
    let input = match input_kind {
        0 => PointerInput::Moved { x, y },
        1 => PointerInput::Button {
            x,
            y,
            button: a as u8,
            down: b != 0.0,
        },
        2 => PointerInput::Wheel { x, y, dx: a, dy: b },
        3 => PointerInput::Left,
        _ => return 0,
    };
    with_engine(handle, |eng| {
        let deliveries = eng.scene.pointer(input);
        eng.scene.select_with_at(input, &eng.text, now_ms);
        codec::encode_deliveries(&deliveries, &mut eng.out_buf);
        u32::from(eng.scene.dirty)
    })
    .unwrap_or(0)
}

fn encode_default_action(action: KeyDefault) -> u8 {
    match action {
        KeyDefault::None => 0,
        KeyDefault::MoveFocus { backwards: false } => 1,
        KeyDefault::MoveFocus { backwards: true } => 2,
        KeyDefault::SelectAll => 3,
    }
}

fn apply_default_action(scene: &mut Scene, action: u8) -> bool {
    match action {
        1 => {
            scene.move_focus(false);
            scene.dirty
        }
        2 => {
            scene.move_focus(true);
            scene.dirty
        }
        3 => {
            scene.select_all_text();
            scene.dirty
        }
        _ => false,
    }
}

/// Feed a binary-encoded `KeyEvent` into the retained scene.
/// If no key listeners are reached, applies the default action immediately.
/// Encodes `[default_action: u8, dirty: u8, listener_count: u32, listeners...]`
/// into `out_buf`. Returns 1 on success, 0 on decode failure.
#[unsafe(no_mangle)]
pub extern "C" fn scene_key(handle: u32, ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut reader = codec::Reader::new(bytes);
    let Some(event) = reader.key_event() else {
        return 0;
    };
    with_engine(handle, |eng| {
        eng.scene.notice(&event);
        let default_action = encode_default_action(event.default_action());
        let delivery = eng.scene.key(event);
        let dirty = if delivery.listeners.is_empty() {
            apply_default_action(&mut eng.scene, default_action) || eng.scene.dirty
        } else {
            eng.scene.dirty
        };
        codec::encode_key_result(default_action, dirty, &delivery.listeners, &mut eng.out_buf);
        1
    })
    .unwrap_or(0)
}

/// Apply a key's default action (`1 = MoveFocus(false)`, `2 = MoveFocus(true)`,
/// `3 = SelectAll`) after listeners have answered without calling `prevent-default`.
/// Returns 1 if the scene is dirty and owes a frame.
#[unsafe(no_mangle)]
pub extern "C" fn scene_act_on_key_default(handle: u32, action: u32) -> u32 {
    with_engine(handle, |eng| {
        u32::from(apply_default_action(&mut eng.scene, action as u8))
    })
    .unwrap_or(0)
}

/// Take any `enter`/`leave` deliveries produced during the last frame solve.
/// Encoded into `out_buf`. Returns number of delivery batches.
#[unsafe(no_mangle)]
pub extern "C" fn scene_take_owed(handle: u32) -> u32 {
    with_engine(handle, |eng| {
        let owed = eng.scene.take_owed();
        let count = owed.len() as u32;
        codec::encode_deliveries(&owed, &mut eng.out_buf);
        count
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn scene_is_dirty(handle: u32) -> u32 {
    with_engine(handle, |eng| u32::from(eng.scene.dirty)).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn scene_solves(handle: u32) -> u32 {
    with_engine(handle, |eng| eng.scene.solves).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn scene_node_count(handle: u32) -> u32 {
    with_engine(handle, |eng| eng.scene.len() as u32).unwrap_or(0)
}

/// Solve layout, build the display list, rasterize with `vello_cpu`, and populate
/// the unpremultiplied RGBA8 buffer (for Canvas2D `ImageData`).
/// Returns the number of commands drawn.
#[unsafe(no_mangle)]
pub extern "C" fn engine_draw_frame(
    handle: u32,
    width: u32,
    height: u32,
    bg_r: f32,
    bg_g: f32,
    bg_b: f32,
    bg_a: f32,
) -> u32 {
    let w = width.clamp(1, u16::MAX as u32) as u16;
    let h = height.clamp(1, u16::MAX as u32) as u16;
    let available = Size {
        width: w as f32,
        height: h as f32,
    };
    let bg = Color {
        r: bg_r,
        g: bg_g,
        b: bg_b,
        a: bg_a,
    };
    with_engine(handle, |eng| {
        let commands = if let Some(demo) = &eng.demo_scene {
            demo.display_list(available, &mut eng.text)
        } else {
            eng.scene.draw(available, &mut eng.text)
        };
        eng.painter.resize(w, h);
        eng.painter.draw(&commands, bg, &eng.text);
        let byte_len = w as usize * h as usize * 4;
        eng.rgba_buf.resize(byte_len, 0);
        eng.painter.blit_rgba_unpremul(&mut eng.rgba_buf);
        let count = commands.len() as u32;
        eng.last_commands = commands;
        count
    })
    .unwrap_or(0)
}

/// Pointer to the unpremultiplied RGBA8 framebuffer produced by the last [`engine_draw_frame`].
#[unsafe(no_mangle)]
pub extern "C" fn engine_rgba_ptr(handle: u32) -> *const u8 {
    with_engine(handle, |eng| eng.rgba_buf.as_ptr()).unwrap_or(std::ptr::null())
}

/// Byte length of the RGBA8 framebuffer (`width * height * 4`).
#[unsafe(no_mangle)]
pub extern "C" fn engine_rgba_len(handle: u32) -> usize {
    with_engine(handle, |eng| eng.rgba_buf.len()).unwrap_or(0)
}

/// Pointer to the premultiplied RGBA8 framebuffer inside `vello_cpu::Pixmap`
/// (zero-copy upload to WebGPU `rgba8unorm` textures).
#[unsafe(no_mangle)]
pub extern "C" fn engine_premul_ptr(handle: u32) -> *const u8 {
    with_engine(handle, |eng| eng.painter.pixels_rgba_bytes().as_ptr())
        .unwrap_or(std::ptr::null())
}

/// Pointer to the engine's scratch output buffer (`scene_pointer`, `scene_content`, etc.).
#[unsafe(no_mangle)]
pub extern "C" fn engine_out_ptr(handle: u32) -> *const u8 {
    with_engine(handle, |eng| eng.out_buf.as_ptr()).unwrap_or(std::ptr::null())
}

/// Byte length of the engine's scratch output buffer.
#[unsafe(no_mangle)]
pub extern "C" fn engine_out_len(handle: u32) -> usize {
    with_engine(handle, |eng| eng.out_buf.len()).unwrap_or(0)
}

/// Serialize the last frame's display list (quads, glyphs with text content & run id,
/// clips) into `out_buf` as JSON for automated tests and the web demo inspector.
#[unsafe(no_mangle)]
pub extern "C" fn engine_inspect_frame_json(handle: u32) -> u32 {
    with_engine(handle, |eng| {
        let mut s = String::from("{\"commands\":[");
        for (i, cmd) in eng.last_commands.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            match cmd {
                Command::Quad(q) => {
                    let _ = write!(
                        s,
                        "{{\"type\":\"quad\",\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"radius\":{},\"borderWidth\":{}",
                        q.bounds.x,
                        q.bounds.y,
                        q.bounds.width,
                        q.bounds.height,
                        q.corner_radius,
                        q.border_width,
                    );
                    if let Some(bg) = q.background {
                        let _ = write!(
                            s,
                            ",\"bg\":[{},{},{},{}]",
                            bg.r, bg.g, bg.b, bg.a
                        );
                    }
                    s.push('}');
                }
                Command::Glyphs(g) => {
                    let text = eng
                        .text
                        .get(g.run)
                        .map(|r| r.content())
                        .unwrap_or("");
                    let _ = write!(
                        s,
                        "{{\"type\":\"glyphs\",\"run\":{},\"x\":{},\"y\":{},\"text\":\"",
                        g.run, g.x, g.y
                    );
                    for ch in text.chars() {
                        match ch {
                            '"' => s.push_str("\\\""),
                            '\\' => s.push_str("\\\\"),
                            '\n' => s.push_str("\\n"),
                            '\r' => s.push_str("\\r"),
                            '\t' => s.push_str("\\t"),
                            c => s.push(c),
                        }
                    }
                    s.push_str("\"}");
                }
                Command::PushClip(r) => {
                    let _ = write!(
                        s,
                        "{{\"type\":\"pushClip\",\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}",
                        r.x, r.y, r.width, r.height
                    );
                }
                Command::PopClip => {
                    s.push_str("{\"type\":\"popClip\"}");
                }
            }
        }
        let _ = write!(
            s,
            "],\"solves\":{},\"dirty\":{},\"nodes\":{}}}",
            eng.scene.solves,
            eng.scene.dirty,
            eng.scene.len()
        );
        eng.out_buf = s.into_bytes();
        eng.out_buf.len() as u32
    })
    .unwrap_or(0)
}
