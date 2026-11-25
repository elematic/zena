/**
 * Component Model Canonical ABI reader/writer for `zenafx:host` types, plus
 * binary encoding/decoding for the `zenafx-web-engine` wasm32 module.
 *
 * Canonical ABI offsets match `packages/zenafx/wit/zenafx.wit` and the
 * Component Model specification (little-endian, natural field alignment).
 */

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

// Canonical ABI struct sizes (bytes)
export const CABI_NODE_DEF_SIZE = 132;
export const CABI_BINDING_SIZE = 8;
export const CABI_STATE_STYLE_SIZE = 68;
export const CABI_HOLE_SIZE = 60;
export const CABI_DELIVERY_SIZE = 24;
export const CABI_KEY_DELIVERY_SIZE = 44;

/**
 * Growable little-endian binary writer matching `engine/src/codec.rs`.
 */
export class BinaryWriter {
  #buf;
  #view;
  #pos = 0;

  constructor(initialCapacity = 1024) {
    this.#buf = new Uint8Array(initialCapacity);
    this.#view = new DataView(this.#buf.buffer);
  }

  #ensure(extra) {
    const needed = this.#pos + extra;
    if (needed <= this.#buf.length) return;
    let next = this.#buf.length * 2;
    while (next < needed) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.#buf.subarray(0, this.#pos));
    this.#buf = grown;
    this.#view = new DataView(this.#buf.buffer);
  }

  u8(v) {
    this.#ensure(1);
    this.#buf[this.#pos++] = v & 0xff;
  }

  u16(v) {
    this.#ensure(2);
    this.#view.setUint16(this.#pos, v, true);
    this.#pos += 2;
  }

  u32(v) {
    this.#ensure(4);
    this.#view.setUint32(this.#pos, v >>> 0, true);
    this.#pos += 4;
  }

  f32(v) {
    this.#ensure(4);
    this.#view.setFloat32(this.#pos, v, true);
    this.#pos += 4;
  }

  bytes(slice) {
    this.u32(slice.length);
    this.#ensure(slice.length);
    this.#buf.set(slice, this.#pos);
    this.#pos += slice.length;
  }

  string(s) {
    this.bytes(textEncoder.encode(s));
  }

  finish() {
    return this.#buf.subarray(0, this.#pos);
  }
}

/**
 * Little-endian binary reader matching `engine/src/codec.rs`.
 */
export class BinaryReader {
  #bytes;
  #view;
  #pos = 0;

  constructor(bytes) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8() {
    return this.#bytes[this.#pos++];
  }

  u32() {
    const v = this.#view.getUint32(this.#pos, true);
    this.#pos += 4;
    return v;
  }

  f32() {
    const v = this.#view.getFloat32(this.#pos, true);
    this.#pos += 4;
    return v;
  }
}

// ============================================================================
// Transcode Canonical ABI structs from guest linear memory -> engine binary
// ============================================================================

const readStringBytes = (memBytes, view, offset) => {
  const ptr = view.getUint32(offset, true);
  const len = view.getUint32(offset + 4, true);
  return memBytes.subarray(ptr, ptr + len);
};

const copyColor = (view, offset, out) => {
  out.f32(view.getFloat32(offset, true));
  out.f32(view.getFloat32(offset + 4, true));
  out.f32(view.getFloat32(offset + 8, true));
  out.f32(view.getFloat32(offset + 12, true));
};

const copyOptColor = (view, offset, out) => {
  const tag = view.getUint8(offset);
  out.u8(tag ? 1 : 0);
  if (tag) {
    copyColor(view, offset + 4, out);
  }
};

const copyBoxStyle = (view, offset, out) => {
  copyOptColor(view, offset, out); // 0..20
  copyOptColor(view, offset + 20, out); // 20..40
  out.f32(view.getFloat32(offset + 40, true)); // border-width
  out.f32(view.getFloat32(offset + 44, true)); // corner-radius
  out.f32(view.getFloat32(offset + 48, true)); // opacity
};

const copyTextStyle = (memBytes, view, offset, out) => {
  out.bytes(readStringBytes(memBytes, view, offset)); // family: 0..8
  out.f32(view.getFloat32(offset + 8, true)); // size
  out.u16(view.getUint16(offset + 12, true)); // weight
  out.u8(view.getUint8(offset + 14) ? 1 : 0); // italic
  copyColor(view, offset + 16, out); // color: 16..32
};

const copyLength = (view, offset, out) => {
  const tag = view.getUint8(offset);
  out.u8(tag);
  if (tag === 1 || tag === 2) {
    out.f32(view.getFloat32(offset + 4, true));
  }
};

// box: 44 bytes
const copyBox = (view, offset, out) => {
  copyLength(view, offset, out); // width: 0..8
  copyLength(view, offset + 8, out); // height: 8..16
  out.f32(view.getFloat32(offset + 16, true)); // grow
  out.f32(view.getFloat32(offset + 20, true)); // shrink
  // padding: top, right, bottom, left
  out.f32(view.getFloat32(offset + 24, true));
  out.f32(view.getFloat32(offset + 28, true));
  out.f32(view.getFloat32(offset + 32, true));
  out.f32(view.getFloat32(offset + 36, true));
  out.u8(view.getUint8(offset + 40)); // overflow-x
  out.u8(view.getUint8(offset + 41)); // overflow-y
};

// layout: variant { flex(flex), flow(flow) }, 16 bytes: tag @ 0, case @ 4
const copyLayout = (view, offset, out) => {
  const tag = view.getUint8(offset);
  out.u8(tag);
  if (tag === 0) {
    out.u8(view.getUint8(offset + 4)); // axis
    out.u8(view.getUint8(offset + 5)); // justify-content
    out.u8(view.getUint8(offset + 6)); // align-items
    out.f32(view.getFloat32(offset + 8, true)); // gap
  } else if (tag === 1) {
    out.u8(view.getUint8(offset + 4)); // align
    // line-height: option<f32> (tag @ 8, value @ 12)
    const hasLineHeight = view.getUint8(offset + 8) !== 0;
    out.u8(hasLineHeight ? 1 : 0);
    if (hasLineHeight) {
      out.f32(view.getFloat32(offset + 12, true));
    }
  }
};

const copyNodeStyle = (memBytes, view, offset, out) => {
  const tag = view.getUint8(offset);
  out.u8(tag);
  if (tag === 1) {
    copyBoxStyle(view, offset + 4, out);
  } else if (tag === 2) {
    // text-content: { content: string (0..8), style: text-style (8..40) }
    out.bytes(readStringBytes(memBytes, view, offset + 4));
    copyTextStyle(memBytes, view, offset + 12, out);
  }
};

const copyNodeDef = (memBytes, view, offset, out) => {
  copyBox(view, offset, out); // 0..44
  copyLayout(view, offset + 44, out); // 44..60
  copyNodeStyle(memBytes, view, offset + 60, out); // 60..116
  out.u32(view.getUint32(offset + 116, true)); // first-child
  out.u32(view.getUint32(offset + 120, true)); // child-count
  out.u8(view.getUint8(offset + 124) ? 1 : 0); // is-slot
  // cursor: option<cursor> (tag @ 125, value @ 126)
  const hasCursor = view.getUint8(offset + 125) !== 0;
  out.u8(hasCursor ? 1 : 0);
  if (hasCursor) {
    out.u8(view.getUint8(offset + 126));
  }
  out.u8(view.getUint8(offset + 127) ? 1 : 0); // focusable
  out.u8(view.getUint8(offset + 128) ? 1 : 0); // editable
  out.u8(view.getUint8(offset + 129) ? 1 : 0); // unselectable
};

const copyBinding = (view, offset, out) => {
  out.u32(view.getUint32(offset, true)); // node
  out.u8(view.getUint8(offset + 4)); // target
};

const copyStateStyle = (memBytes, view, offset, out) => {
  out.u32(view.getUint32(offset, true)); // node
  out.u8(view.getUint8(offset + 4)); // when
  out.u32(view.getUint32(offset + 8, true)); // of
  const restyleTag = view.getUint8(offset + 12);
  out.u8(restyleTag);
  if (restyleTag === 0) {
    copyBoxStyle(view, offset + 16, out);
  } else if (restyleTag === 1) {
    copyTextStyle(memBytes, view, offset + 16, out);
  }
};

const copyHole = (memBytes, view, offset, out) => {
  out.u32(view.getUint32(offset, true)); // binding
  const tag = view.getUint8(offset + 4);
  out.u8(tag);
  if (tag === 0) {
    out.bytes(readStringBytes(memBytes, view, offset + 8));
  } else if (tag === 1) {
    copyBoxStyle(view, offset + 8, out);
  } else if (tag === 2) {
    copyTextStyle(memBytes, view, offset + 8, out);
  } else if (tag === 3) {
    copyBox(view, offset + 8, out);
  } else if (tag === 4) {
    copyLayout(view, offset + 8, out);
  }
};

/**
 * Transcode `[method]node.render` arguments directly from the guest component's
 * linear memory into the binary payload expected by `zenafx-web-engine`'s
 * `scene_render`.
 *
 * @param {WebAssembly.Memory} guestMemory
 * @param {number} templateTag 0 = known, 1 = fresh
 * @param {number} templateId
 * @param {number} nodesPtr
 * @param {number} nodesLen
 * @param {number} bindingsPtr
 * @param {number} bindingsLen
 * @param {number} statesPtr
 * @param {number} statesLen
 * @param {number} holesPtr
 * @param {number} holesLen
 * @returns {Uint8Array}
 */
export const transcodeRenderCall = (
  guestMemory,
  templateTag,
  templateId,
  nodesPtr,
  nodesLen,
  bindingsPtr,
  bindingsLen,
  statesPtr,
  statesLen,
  holesPtr,
  holesLen,
) => {
  const memBytes = new Uint8Array(guestMemory.buffer);
  const view = new DataView(guestMemory.buffer);
  const out = new BinaryWriter();

  out.u8(templateTag);
  out.u32(templateId >>> 0);
  if (templateTag === 1) {
    out.u32(nodesLen >>> 0);
    for (let i = 0; i < nodesLen; i++) {
      copyNodeDef(memBytes, view, nodesPtr + i * CABI_NODE_DEF_SIZE, out);
    }
    out.u32(bindingsLen >>> 0);
    for (let i = 0; i < bindingsLen; i++) {
      copyBinding(view, bindingsPtr + i * CABI_BINDING_SIZE, out);
    }
    out.u32(statesLen >>> 0);
    for (let i = 0; i < statesLen; i++) {
      copyStateStyle(
        memBytes,
        view,
        statesPtr + i * CABI_STATE_STYLE_SIZE,
        out,
      );
    }
  }

  out.u32(holesLen >>> 0);
  for (let i = 0; i < holesLen; i++) {
    copyHole(memBytes, view, holesPtr + i * CABI_HOLE_SIZE, out);
  }

  return out.finish();
};

/**
 * Write a Canonical ABI `delivery` record (`{event: pointer-event, reply: option<reply>}`)
 * into guest linear memory at `ptr`.
 *
 * @param {WebAssembly.Memory} guestMemory
 * @param {number} ptr
 * @param {{kind: number, x: number, y: number, button: number}} event
 * @param {number | null} replyHandle
 */
export const writeDelivery = (guestMemory, ptr, event, replyHandle) => {
  const view = new DataView(guestMemory.buffer);
  // pointer-event (16 bytes)
  view.setUint8(ptr, event.kind & 0xff);
  view.setUint8(ptr + 1, 0);
  view.setUint16(ptr + 2, 0, true);
  view.setFloat32(ptr + 4, event.x, true);
  view.setFloat32(ptr + 8, event.y, true);
  view.setUint8(ptr + 12, event.button & 0xff);
  view.setUint8(ptr + 13, 0);
  view.setUint16(ptr + 14, 0, true);
  // option<reply> (8 bytes at offset 16)
  if (replyHandle !== null) {
    view.setUint8(ptr + 16, 1);
    view.setUint8(ptr + 17, 0);
    view.setUint16(ptr + 18, 0, true);
    view.setUint32(ptr + 20, replyHandle >>> 0, true);
  } else {
    view.setUint32(ptr + 16, 0, true);
    view.setUint32(ptr + 20, 0, true);
  }
};

/**
 * Decode a `Vec<Delivery>` encoded by `engine/src/codec.rs`.
 * @param {Uint8Array} bytes
 */
export const decodeDeliveries = (bytes) => {
  if (bytes.length === 0) return [];
  const r = new BinaryReader(bytes);
  const count = r.u32();
  const deliveries = [];
  for (let i = 0; i < count; i++) {
    const stopsWhenHandled = r.u8() !== 0;
    const callCount = r.u32();
    const calls = [];
    for (let j = 0; j < callCount; j++) {
      const listener = r.u32();
      const kind = r.u8();
      const x = r.f32();
      const y = r.f32();
      const button = r.u8();
      calls.push({listener, event: {kind, x, y, button}});
    }
    deliveries.push({stopsWhenHandled, calls});
  }
  return deliveries;
};

/**
 * Decode a `Vec<u32>` encoded by `engine/src/codec.rs`.
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
export const decodeU32List = (bytes) => {
  if (bytes.length === 0) return [];
  const r = new BinaryReader(bytes);
  const count = r.u32();
  const list = new Array(count);
  for (let i = 0; i < count; i++) {
    list[i] = r.u32();
  }
  return list;
};

/**
 * Write a Canonical ABI `key-delivery` record (`{event: key-event, reply: reply}`)
 * into guest linear memory at `ptr`, allocating UTF-8 string payloads via
 * `guestRealloc`.
 *
 * @param {WebAssembly.Memory} guestMemory
 * @param {(oldPtr: number, oldSize: number, align: number, newSize: number) => number} guestRealloc
 * @param {number} ptr
 * @param {{down: boolean, key: string, code: string, modifiers: {shift: boolean, control: boolean, alt: boolean, meta: boolean}, repeat: boolean, text: string | null}} event
 * @param {number} replyHandle
 */
export const writeKeyDelivery = (
  guestMemory,
  guestRealloc,
  ptr,
  event,
  replyHandle,
) => {
  const allocStr = (str) => {
    const bytes = textEncoder.encode(str);
    if (bytes.length === 0) return {ptr: 0, len: 0};
    const p = guestRealloc(0, 0, 1, bytes.length) >>> 0;
    new Uint8Array(guestMemory.buffer, p, bytes.length).set(bytes);
    return {ptr: p, len: bytes.length};
  };

  // Allocate strings BEFORE creating DataView in case realloc grows memory.
  const keySlice = allocStr(event.key ?? '');
  const codeSlice = allocStr(event.code ?? '');
  const hasText = event.text !== null && event.text !== undefined;
  const textSlice = hasText ? allocStr(event.text) : {ptr: 0, len: 0};

  const view = new DataView(guestMemory.buffer);
  // key-event (40 bytes):
  //   0: down (bool), 1..4: pad
  view.setUint32(ptr, event.down ? 1 : 0, true);
  //   4: key (ptr, len)
  view.setUint32(ptr + 4, keySlice.ptr, true);
  view.setUint32(ptr + 8, keySlice.len, true);
  //  12: code (ptr, len)
  view.setUint32(ptr + 12, codeSlice.ptr, true);
  view.setUint32(ptr + 16, codeSlice.len, true);
  //  20: modifiers (shift, control, alt, meta)
  const m = event.modifiers ?? {};
  view.setUint8(ptr + 20, m.shift ? 1 : 0);
  view.setUint8(ptr + 21, m.control ? 1 : 0);
  view.setUint8(ptr + 22, m.alt ? 1 : 0);
  view.setUint8(ptr + 23, m.meta ? 1 : 0);
  //  24: repeat (bool), 25..28: pad
  view.setUint32(ptr + 24, event.repeat ? 1 : 0, true);
  //  28: text (option<string>: tag @ 28, ptr @ 32, len @ 36)
  view.setUint32(ptr + 28, hasText ? 1 : 0, true);
  view.setUint32(ptr + 32, textSlice.ptr, true);
  view.setUint32(ptr + 36, textSlice.len, true);
  //  40: reply (own<reply> u32)
  view.setUint32(ptr + 40, replyHandle >>> 0, true);
};

/**
 * Encode a `KeyEvent` for `zenafx-web-engine`'s `scene_key`.
 * @param {{down: boolean, key: string, code: string, modifiers?: {shift?: boolean, control?: boolean, alt?: boolean, meta?: boolean}, repeat?: boolean, text?: string | null}} event
 * @returns {Uint8Array}
 */
export const encodeKeyEvent = (event) => {
  const out = new BinaryWriter(64);
  out.u8(event.down ? 1 : 0);
  out.string(event.key ?? '');
  out.string(event.code ?? '');
  const m = event.modifiers ?? {};
  const bits =
    (m.shift ? 1 : 0) |
    (m.control ? 2 : 0) |
    (m.alt ? 4 : 0) |
    (m.meta ? 8 : 0);
  out.u8(bits);
  out.u8(event.repeat ? 1 : 0);
  if (event.text !== null && event.text !== undefined) {
    out.u8(1);
    out.string(event.text);
  } else {
    out.u8(0);
  }
  return out.finish();
};

/**
 * Decode the result of `scene_key` (`[defaultAction, dirty, count, ...listeners]`).
 * @param {Uint8Array} bytes
 */
export const decodeKeyResult = (bytes) => {
  if (bytes.length === 0) {
    return {defaultAction: 0, dirty: false, listeners: []};
  }
  const r = new BinaryReader(bytes);
  const defaultAction = r.u8();
  const dirty = r.u8() !== 0;
  const count = r.u32();
  const listeners = new Array(count);
  for (let i = 0; i < count; i++) {
    listeners[i] = r.u32();
  }
  return {defaultAction, dirty, listeners};
};

/**
 * Decode UTF-8 bytes to string.
 * @param {Uint8Array} bytes
 */
export const decodeUtf8 = (bytes) => textDecoder.decode(bytes);
