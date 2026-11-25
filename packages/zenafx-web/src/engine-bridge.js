/**
 * JS wrapper around the compiled `zenafx_web_engine.wasm` rendering layer
 * (`zenafx-render`: retained scene, Taffy layout, Parley text shaping, Vello CPU).
 */

import {
  decodeDeliveries,
  decodeKeyResult,
  decodeU32List,
  decodeUtf8,
  encodeKeyEvent,
} from './cabi.js';

const textEncoder = new TextEncoder();

/** Pointer input kind tags matching `engine/src/lib.rs`. */
export const PointerInputKind = {
  Moved: 0,
  Button: 1,
  Wheel: 2,
  Left: 3,
};

/** CSS cursor keywords in the exact order of `zenafx_render::scene::Cursor::ALL`. */
export const CURSOR_CSS_NAMES = [
  'default',
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'e-resize',
  'n-resize',
  'ne-resize',
  'nw-resize',
  's-resize',
  'se-resize',
  'sw-resize',
  'w-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'col-resize',
  'row-resize',
  'all-scroll',
  'zoom-in',
  'zoom-out',
];

/**
 * A compiled `zenafx_web_engine.wasm` module, reusable across many engine
 * instances (one per canvas / demo).
 */
export class RenderEngineModule {
  #module;

  /**
   * @param {WebAssembly.Module} module
   */
  constructor(module) {
    this.#module = module;
  }

  /**
   * Compile `zenafx_web_engine.wasm` from bytes.
   * @param {Uint8Array | ArrayBuffer} bytes
   */
  static async compile(bytes) {
    const mod = await WebAssembly.compile(bytes);
    return new RenderEngineModule(mod);
  }

  /**
   * Instantiate a fresh isolated rendering engine instance.
   */
  async instantiate() {
    const instance = await WebAssembly.instantiate(this.#module, {});
    return new RenderEngine(instance);
  }
}

/**
 * One live ZenaFX rendering engine instance backed by `zenafx_web_engine.wasm`.
 */
export class RenderEngine {
  #exports;
  #memory;
  #handle;
  #disposed = false;

  /**
   * @param {WebAssembly.Instance} instance
   */
  constructor(instance) {
    this.#exports = /** @type {any} */ (instance.exports);
    this.#memory = /** @type {WebAssembly.Memory} */ (this.#exports.memory);
    this.#handle = this.#exports.engine_new();
  }

  #copyIn(bytes) {
    const ptr = this.#exports.alloc(bytes.length);
    new Uint8Array(this.#memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  }

  #readOutBytes() {
    const ptr = this.#exports.engine_out_ptr(this.#handle);
    const len = this.#exports.engine_out_len(this.#handle);
    if (len === 0) return new Uint8Array(0);
    // Copy out before the next Wasm call can reallocate linear memory.
    return new Uint8Array(this.#memory.buffer, ptr, len).slice();
  }

  /**
   * Register raw TTF/OTF font bytes with Parley/Fontique.
   * @param {Uint8Array} fontBytes
   * @returns {number} number of registered font faces
   */
  registerFont(fontBytes) {
    const ptr = this.#copyIn(fontBytes);
    try {
      return this.#exports.engine_register_font(
        this.#handle,
        ptr,
        fontBytes.length,
      );
    } finally {
      this.#exports.dealloc(ptr, fontBytes.length);
    }
  }

  /**
   * Set physical pixels per logical pixel (`window.devicePixelRatio`).
   * @param {number} scale
   */
  setScale(scale) {
    this.#exports.engine_set_scale(this.#handle, scale);
  }

  /**
   * Load the built-in Rust "Hello, world" card demo (web equivalent of `zfx --ui`).
   * @param {string} [message]
   */
  loadHelloDemo(message = 'Hello from ZenaFX on the Web!') {
    const bytes = textEncoder.encode(message);
    const ptr = this.#copyIn(bytes);
    try {
      this.#exports.engine_load_hello_demo(this.#handle, ptr, bytes.length);
    } finally {
      this.#exports.dealloc(ptr, bytes.length);
    }
  }

  /**
   * `zenafx:host/scene.root()`
   * @returns {number}
   */
  root() {
    return this.#exports.scene_root(this.#handle) >>> 0;
  }

  /**
   * `zenafx:host/scene.create-node()`
   * @returns {number}
   */
  createNode() {
    return this.#exports.scene_create_node(this.#handle) >>> 0;
  }

  /**
   * `zenafx:host/scene.[method]node.set-slot(slot, children)`
   * @param {number} node
   * @param {number} slot
   * @param {number[]} children
   * @returns {boolean}
   */
  setSlot(node, slot, children) {
    const byteLen = children.length * 4;
    const ptr = byteLen > 0 ? this.#exports.alloc(byteLen) : 0;
    try {
      if (byteLen > 0) {
        const view = new DataView(this.#memory.buffer);
        for (let i = 0; i < children.length; i++) {
          view.setUint32(ptr + i * 4, children[i] >>> 0, true);
        }
      }
      return (
        this.#exports.scene_set_slot(
          this.#handle,
          node >>> 0,
          slot >>> 0,
          ptr,
          children.length,
        ) !== 0
      );
    } finally {
      if (byteLen > 0) {
        this.#exports.dealloc(ptr, byteLen);
      }
    }
  }

  /**
   * `resource.drop` on `zenafx:host/scene.node`.
   * @param {number} node
   * @returns {boolean}
   */
  dropNode(node) {
    return this.#exports.scene_drop_node(this.#handle, node >>> 0) !== 0;
  }

  /**
   * `zenafx:host/scene.[method]node.render(...)`
   * @param {number} node
   * @param {Uint8Array} encodedPayload
   */
  render(node, encodedPayload) {
    const ptr = this.#copyIn(encodedPayload);
    try {
      const ok = this.#exports.scene_render(
        this.#handle,
        node >>> 0,
        ptr,
        encodedPayload.length,
      );
      if (!ok) {
        throw new Error('zenafx-web-engine failed to decode render payload');
      }
    } finally {
      this.#exports.dealloc(ptr, encodedPayload.length);
    }
  }

  /**
   * `zenafx:host/scene.[method]node.content(slot, count)`
   * @param {number} node
   * @param {number} slot
   * @param {number} count
   * @returns {number[] | null}
   */
  content(node, slot, count) {
    const ok = this.#exports.scene_content(
      this.#handle,
      node >>> 0,
      slot >>> 0,
      count >>> 0,
    );
    if (!ok) return null;
    return decodeU32List(this.#readOutBytes());
  }

  /**
   * `zenafx:host/scene.[method]node.listen-pointer(...)`
   * @returns {boolean}
   */
  listenPointer(node, target, kind, scope, phase, listenerId) {
    return (
      this.#exports.scene_listen_pointer(
        this.#handle,
        node >>> 0,
        target >>> 0,
        kind >>> 0,
        scope >>> 0,
        phase >>> 0,
        listenerId >>> 0,
      ) !== 0
    );
  }

  /**
   * `zenafx:host/scene.[method]node.listen-keys(...)`
   * @returns {boolean}
   */
  listenKeys(node, target, phase, listenerId) {
    return (
      this.#exports.scene_listen_keys(
        this.#handle,
        node >>> 0,
        target >>> 0,
        phase >>> 0,
        listenerId >>> 0,
      ) !== 0
    );
  }

  /**
   * `zenafx:host/scene.[method]node.selection(target)`
   * @returns {{anchor: number, focus: number} | null}
   */
  selectionIn(node, target) {
    const ok = this.#exports.scene_selection_in(
      this.#handle,
      node >>> 0,
      target >>> 0,
    );
    if (!ok) return null;
    const [anchor, focus] = decodeU32List(this.#readOutBytes());
    return {anchor, focus};
  }

  /**
   * `zenafx:host/scene.[method]node.select(target, to)`
   * @returns {boolean}
   */
  select(node, target, anchor, focus) {
    return (
      this.#exports.scene_select(
        this.#handle,
        node >>> 0,
        target >>> 0,
        anchor >>> 0,
        focus >>> 0,
      ) !== 0
    );
  }

  /**
   * Capture the pointer for `listenerId` and cancel any window selection started
   * by the press. Returns whether the scene is dirty.
   * @param {number} listenerId
   * @returns {boolean}
   */
  capture(listenerId) {
    return this.#exports.scene_capture(this.#handle, listenerId >>> 0) !== 0;
  }

  /**
   * CSS `cursor` keyword for the node currently under the pointer (or captured).
   * @returns {string}
   */
  cursor() {
    const idx = this.#exports.scene_cursor(this.#handle) >>> 0;
    return CURSOR_CSS_NAMES[idx] ?? 'default';
  }

  /**
   * Currently selected text in the window, or `null` when nothing is selected.
   * @returns {string | null}
   */
  selectedText() {
    const ok = this.#exports.scene_selected_text(this.#handle);
    if (!ok) return null;
    return decodeUtf8(this.#readOutBytes());
  }

  /**
   * Feed a `KeyEvent` into the retained scene.
   * @param {{down: boolean, key: string, code: string, modifiers?: {shift?: boolean, control?: boolean, alt?: boolean, meta?: boolean}, repeat?: boolean, text?: string | null}} event
   */
  key(event) {
    const encoded = encodeKeyEvent(event);
    const ptr = this.#copyIn(encoded);
    try {
      const ok = this.#exports.scene_key(this.#handle, ptr, encoded.length);
      if (!ok) {
        throw new Error('zenafx-web-engine failed to decode key event');
      }
      return decodeKeyResult(this.#readOutBytes());
    } finally {
      this.#exports.dealloc(ptr, encoded.length);
    }
  }

  /**
   * Apply a key's default action (`1 = Tab`, `2 = Shift+Tab`, `3 = SelectAll`)
   * after listeners have answered without calling `prevent-default`.
   * @param {number} action
   * @returns {boolean}
   */
  actOnKeyDefault(action) {
    if (!action) return false;
    return (
      this.#exports.scene_act_on_key_default(this.#handle, action >>> 0) !== 0
    );
  }

  /**
   * Remove a listener by id.
   * @param {number} listenerId
   */
  unlisten(listenerId) {
    this.#exports.scene_unlisten(this.#handle, listenerId >>> 0);
  }

  /**
   * Listener ids whose nodes were removed since the last call.
   * @returns {number[]}
   */
  takeEnded() {
    const count = this.#exports.scene_take_ended(this.#handle);
    if (count === 0) return [];
    return decodeU32List(this.#readOutBytes());
  }

  /**
   * Feed a pointer input into the retained scene.
   * @param {{type: 'moved', x: number, y: number}
   *   | {type: 'button', x: number, y: number, button: number, down: boolean}
   *   | {type: 'wheel', x: number, y: number, dx: number, dy: number}
   *   | {type: 'left'}} input
   * @param {number} [nowMs]
   * @returns {{deliveries: Array<{stopsWhenHandled: boolean, calls: Array<{listener: number, event: {kind: number, x: number, y: number, button: number}}>}>, dirty: boolean}}
   */
  pointer(input, nowMs = performance.now()) {
    let dirty = 0;
    if (input.type === 'moved') {
      dirty = this.#exports.scene_pointer(
        this.#handle,
        PointerInputKind.Moved,
        input.x,
        input.y,
        0,
        0,
        nowMs,
      );
    } else if (input.type === 'button') {
      dirty = this.#exports.scene_pointer(
        this.#handle,
        PointerInputKind.Button,
        input.x,
        input.y,
        input.button,
        input.down ? 1 : 0,
        nowMs,
      );
    } else if (input.type === 'wheel') {
      dirty = this.#exports.scene_pointer(
        this.#handle,
        PointerInputKind.Wheel,
        input.x,
        input.y,
        input.dx,
        input.dy,
        nowMs,
      );
    } else {
      dirty = this.#exports.scene_pointer(
        this.#handle,
        PointerInputKind.Left,
        0,
        0,
        0,
        0,
        nowMs,
      );
    }
    const deliveries = decodeDeliveries(this.#readOutBytes());
    return {deliveries, dirty: dirty !== 0};
  }

  /**
   * Take any `enter`/`leave` deliveries produced when layout moved nodes under
   * a still pointer during the last frame.
   */
  takeOwed() {
    const count = this.#exports.scene_take_owed(this.#handle);
    if (count === 0) return [];
    return decodeDeliveries(this.#readOutBytes());
  }

  isDirty() {
    return this.#exports.scene_is_dirty(this.#handle) !== 0;
  }

  solves() {
    return this.#exports.scene_solves(this.#handle) >>> 0;
  }

  nodeCount() {
    return this.#exports.scene_node_count(this.#handle) >>> 0;
  }

  /**
   * Solve layout, paint with Vello CPU, and return frame metadata.
   * Pixels can then be read via `rgbaPixels()` (for Canvas2D `ImageData`)
   * or `premulPixels()` (for WebGPU `writeTexture`).
   *
   * @param {number} width
   * @param {number} height
   * @param {{r: number, g: number, b: number, a: number}} [bg]
   */
  drawFrame(width, height, bg = {r: 1, g: 1, b: 1, a: 1}) {
    const w = Math.max(1, Math.min(65535, Math.floor(width)));
    const h = Math.max(1, Math.min(65535, Math.floor(height)));
    const commandCount = this.#exports.engine_draw_frame(
      this.#handle,
      w,
      h,
      bg.r,
      bg.g,
      bg.b,
      bg.a,
    );
    return {width: w, height: h, commandCount: commandCount >>> 0};
  }

  /**
   * Unpremultiplied RGBA8 view directly over Wasm linear memory (valid until
   * the next Wasm call). Copy with `.slice()` if retaining across frames.
   */
  rgbaPixels() {
    const ptr = this.#exports.engine_rgba_ptr(this.#handle);
    const len = this.#exports.engine_rgba_len(this.#handle);
    return new Uint8ClampedArray(this.#memory.buffer, ptr, len);
  }

  /**
   * Premultiplied RGBA8 view directly over `vello_cpu::Pixmap` in Wasm linear
   * memory, for zero-copy upload to WebGPU `rgba8unorm` textures.
   */
  premulPixels() {
    const ptr = this.#exports.engine_premul_ptr(this.#handle);
    const len = this.#exports.engine_rgba_len(this.#handle);
    return new Uint8Array(this.#memory.buffer, ptr, len);
  }

  /**
   * Inspect the last frame's display list (quads, glyph runs with text, clips)
   * and scene counters.
   */
  inspectFrame() {
    this.#exports.engine_inspect_frame_json(this.#handle);
    return JSON.parse(decodeUtf8(this.#readOutBytes()));
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#exports.engine_drop(this.#handle);
  }
}
