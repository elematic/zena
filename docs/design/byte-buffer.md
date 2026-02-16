# Byte Buffer Design

## Overview

This document describes the design for binary data handling in Zena, with a
focus on `ByteBuffer` - a growable byte buffer for efficient binary
construction. This is essential for building tools like a WASM emitter in Zena.

## Motivation: Self-Hosting the Compiler

To self-host the Zena compiler, we need to emit `.wasm` binaries. The current
TypeScript emitter uses `number[]` arrays:

```typescript
// Current TypeScript emitter pattern
const buffer: number[] = [];
buffer.push(0x00, 0x61, 0x73, 0x6d); // Magic
this.#writeUnsignedLEB128(buffer, value);
buffer.push(...sectionBytes);
return new Uint8Array(buffer);
```

We need equivalent functionality in Zena for binary construction.

## Current State

### ByteArray (Intrinsic)

`ByteArray` is a **fixed-size** WASM GC array of bytes (`(array (mut i8))`):

```zena
// byte-array.zena - current implementation
export let newByteArray = (size: i32): ByteArray => __byte_array_new(size);
export let copyBytes = (dest, destOffset, src, srcOffset, len) => __byte_array_copy(...);
```

**Intrinsics available:**

- `__byte_array_new(size)` - create with size
- `__byte_array_length(arr)` - get length
- `__byte_array_get(arr, index)` - read byte (unsigned i32)
- `__byte_array_set(arr, index, value)` - write byte
- `__byte_array_copy(dest, destOffset, src, srcOffset, len)` - bulk copy

### StringBuilder (Chunked Growth)

`StringBuilder` demonstrates efficient growth via chunks:

```zena
export final class StringBuilder {
  #chunks: Array<ByteArray>;     // Filled chunks
  #currentChunk: ByteArray;       // Active chunk
  #currentPos: i32;               // Position in current chunk
  #totalLength: i32;              // Sum of filled chunks
  ...
}
```

This avoids repeated copying on growth - chunks are kept intact and only
combined when needed (e.g., `toString()`).

---

## Design: ByteBuffer

### Goals

1. **Efficient appending** - O(1) amortized writes
2. **Random access reads** - for patching (e.g., backfilling section sizes)
3. **Binary output** - produce final `ByteArray` for file I/O or host interop
4. **Typed writes** - write i32/i64/f32/f64 in various encodings (LE, LEB128)

### API Design

```zena
import { newByteArray, copyBytes } from 'zena:byte-array';

/**
 * A growable buffer for efficiently constructing binary data.
 */
export final class ByteBuffer {
  #chunks: Array<ByteArray>;
  #currentChunk: ByteArray;
  #currentPos: i32;
  #totalLength: i32;

  /** Create a new ByteBuffer with initial chunk capacity. */
  #new(capacity: i32 = 256) {
    this.#chunks = new Array<ByteArray>();
    this.#currentChunk = newByteArray(capacity > 0 ? capacity : 256);
    this.#currentPos = 0;
    this.#totalLength = 0;
  }

  /** Total bytes written. */
  length: i32 {
    get { return this.#totalLength + this.#currentPos; }
  }

  //===------------------------------------------------------------------===//
  // Core Write Operations
  //===------------------------------------------------------------------===//

  /** Write a single byte. */
  writeByte(b: i32): ByteBuffer {
    this.#ensureSpace(1);
    __byte_array_set(this.#currentChunk, this.#currentPos, b);
    this.#currentPos = this.#currentPos + 1;
    return this;
  }

  /** Write multiple bytes from a ByteArray. */
  writeBytes(src: ByteArray): ByteBuffer {
    return this.writeBytesSlice(src, 0, __byte_array_length(src));
  }

  /** Write a slice of bytes from a ByteArray. */
  writeBytesSlice(src: ByteArray, offset: i32, length: i32): ByteBuffer {
    var remaining = length;
    var srcOffset = offset;

    while (remaining > 0) {
      let available = this.#ensureSpace(remaining);
      var toCopy = remaining;
      if (toCopy > available) {
        toCopy = available;
      }

      copyBytes(this.#currentChunk, this.#currentPos, src, srcOffset, toCopy);
      this.#currentPos = this.#currentPos + toCopy;
      srcOffset = srcOffset + toCopy;
      remaining = remaining - toCopy;
    }
    return this;
  }

  /** Write another ByteBuffer's contents. */
  writeBuffer(other: ByteBuffer): ByteBuffer {
    // Copy all full chunks
    var i = 0;
    while (i < other.#chunks.length) {
      this.writeBytes(other.#chunks[i]);
      i = i + 1;
    }
    // Copy current chunk portion
    if (other.#currentPos > 0) {
      this.writeBytesSlice(other.#currentChunk, 0, other.#currentPos);
    }
    return this;
  }

  //===------------------------------------------------------------------===//
  // Typed Write Operations (Little-Endian)
  //===------------------------------------------------------------------===//

  /** Write a 16-bit unsigned integer (little-endian). */
  writeU16(value: i32): ByteBuffer {
    this.writeByte(value & 0xFF);
    this.writeByte((value >> 8) & 0xFF);
    return this;
  }

  /** Write a 32-bit unsigned integer (little-endian). */
  writeU32(value: i32): ByteBuffer {
    this.writeByte(value & 0xFF);
    this.writeByte((value >> 8) & 0xFF);
    this.writeByte((value >> 16) & 0xFF);
    this.writeByte((value >> 24) & 0xFF);
    return this;
  }

  /** Write a 64-bit integer (little-endian). */
  writeU64(value: i64): ByteBuffer {
    this.writeU32(value as i32);
    this.writeU32((value >> 32) as i32);
    return this;
  }

  /** Write a 32-bit float (little-endian). */
  writeF32(value: f32): ByteBuffer {
    // Reinterpret f32 bits as i32
    let bits = __f32_reinterpret_i32(value);
    return this.writeU32(bits);
  }

  /** Write a 64-bit float (little-endian). */
  writeF64(value: f64): ByteBuffer {
    // Reinterpret f64 bits as i64
    let bits = __f64_reinterpret_i64(value);
    return this.writeU64(bits);
  }

  //===------------------------------------------------------------------===//
  // LEB128 Encoding (for WASM)
  //===------------------------------------------------------------------===//

  /** Write an unsigned LEB128 encoded integer. */
  writeULEB128(value: i32): ByteBuffer {
    var v = value;
    while (true) {
      let byte = v & 0x7F;
      v = v >>> 7;  // Unsigned shift
      if (v != 0) {
        this.writeByte(byte | 0x80);
      } else {
        this.writeByte(byte);
        return this;
      }
    }
  }

  /** Write a signed LEB128 encoded integer. */
  writeSLEB128(value: i32): ByteBuffer {
    var v = value;
    var more = true;
    while (more) {
      let byte = v & 0x7F;
      v = v >> 7;  // Signed shift
      // Check if more bytes needed
      if ((v == 0 && (byte & 0x40) == 0) || (v == -1 && (byte & 0x40) != 0)) {
        more = false;
        this.writeByte(byte);
      } else {
        this.writeByte(byte | 0x80);
      }
    }
    return this;
  }

  /** Write a 64-bit unsigned LEB128. */
  writeULEB128_64(value: i64): ByteBuffer {
    var v = value;
    while (true) {
      let byte = (v & 0x7F) as i32;
      v = v >>> 7;
      if (v != 0) {
        this.writeByte(byte | 0x80);
      } else {
        this.writeByte(byte);
        return this;
      }
    }
  }

  /** Write a 64-bit signed LEB128. */
  writeSLEB128_64(value: i64): ByteBuffer {
    var v = value;
    var more = true;
    while (more) {
      let byte = (v & 0x7F) as i32;
      v = v >> 7;
      if ((v == 0 && (byte & 0x40) == 0) || (v == -1 && (byte & 0x40) != 0)) {
        more = false;
        this.writeByte(byte);
      } else {
        this.writeByte(byte | 0x80);
      }
    }
    return this;
  }

  //===------------------------------------------------------------------===//
  // Random Access (for patching)
  //===------------------------------------------------------------------===//

  /** Read a byte at an absolute position. */
  getByte(index: i32): i32 {
    let (chunkIndex, localOffset) = this.#resolveIndex(index);
    if (chunkIndex < this.#chunks.length) {
      return __byte_array_get(this.#chunks[chunkIndex], localOffset);
    }
    return __byte_array_get(this.#currentChunk, localOffset);
  }

  /** Write a byte at an absolute position (for patching). */
  setByte(index: i32, value: i32): void {
    let (chunkIndex, localOffset) = this.#resolveIndex(index);
    if (chunkIndex < this.#chunks.length) {
      __byte_array_set(this.#chunks[chunkIndex], localOffset, value);
    } else {
      __byte_array_set(this.#currentChunk, localOffset, value);
    }
  }

  /** Patch a U32 at an absolute position (little-endian). */
  patchU32(index: i32, value: i32): void {
    this.setByte(index, value & 0xFF);
    this.setByte(index + 1, (value >> 8) & 0xFF);
    this.setByte(index + 2, (value >> 16) & 0xFF);
    this.setByte(index + 3, (value >> 24) & 0xFF);
  }

  //===------------------------------------------------------------------===//
  // Output
  //===------------------------------------------------------------------===//

  /** Convert to a single contiguous ByteArray. */
  toByteArray(): ByteArray {
    let totalLen = this.length;
    if (totalLen == 0) {
      return newByteArray(0);
    }

    let result = newByteArray(totalLen);
    var offset = 0;

    // Copy all full chunks
    var i = 0;
    while (i < this.#chunks.length) {
      let chunk = this.#chunks[i];
      let chunkLen = __byte_array_length(chunk);
      copyBytes(result, offset, chunk, 0, chunkLen);
      offset = offset + chunkLen;
      i = i + 1;
    }

    // Copy current chunk
    if (this.#currentPos > 0) {
      copyBytes(result, offset, this.#currentChunk, 0, this.#currentPos);
    }

    return result;
  }

  /** Clear the buffer, reusing the first chunk. */
  clear(): void {
    this.#chunks = new Array<ByteArray>();
    this.#currentPos = 0;
    this.#totalLength = 0;
    // Keep #currentChunk for reuse
  }

  //===------------------------------------------------------------------===//
  // Internal Helpers
  //===------------------------------------------------------------------===//

  /** Ensure at least 1 byte is available. Returns available space. */
  #ensureSpace(needed: i32): i32 {
    let chunkLen = __byte_array_length(this.#currentChunk);
    if (this.#currentPos >= chunkLen) {
      // Rotate to new chunk
      this.#chunks.push(this.#currentChunk);
      this.#totalLength = this.#totalLength + chunkLen;

      // Double the chunk size, but at least fit `needed`
      var newCapacity = chunkLen * 2;
      if (newCapacity < needed) {
        newCapacity = needed;
      }
      this.#currentChunk = newByteArray(newCapacity);
      this.#currentPos = 0;
      return newCapacity;
    }
    return chunkLen - this.#currentPos;
  }

  /** Resolve absolute index to (chunkIndex, localOffset). */
  #resolveIndex(index: i32): (i32, i32) {
    var remaining = index;
    var chunkIdx = 0;
    while (chunkIdx < this.#chunks.length) {
      let chunkLen = __byte_array_length(this.#chunks[chunkIdx]);
      if (remaining < chunkLen) {
        return (chunkIdx, remaining);
      }
      remaining = remaining - chunkLen;
      chunkIdx = chunkIdx + 1;
    }
    // In current chunk
    return (chunkIdx, remaining);
  }
}
```

---

## Design: DataView

For reading typed values from a `ByteArray` (e.g., parsing binary formats), we
need a `DataView`-like class. Unlike `ByteBuffer` which is write-focused,
`DataView` is read-focused.

```zena
/**
 * Provides typed read access to a ByteArray.
 */
export final class DataView {
  #buffer: ByteArray;

  #new(buffer: ByteArray) {
    this.#buffer = buffer;
  }

  /** Get buffer length. */
  byteLength: i32 {
    get { return __byte_array_length(this.#buffer); }
  }

  /** Read unsigned byte. */
  getU8(offset: i32): i32 {
    return __byte_array_get(this.#buffer, offset);
  }

  /** Read signed byte. */
  getI8(offset: i32): i32 {
    let u = __byte_array_get(this.#buffer, offset);
    // Sign extend
    return (u << 24) >> 24;
  }

  /** Read 16-bit unsigned (little-endian). */
  getU16(offset: i32): i32 {
    return __byte_array_get(this.#buffer, offset)
         | (__byte_array_get(this.#buffer, offset + 1) << 8);
  }

  /** Read 32-bit unsigned (little-endian). */
  getU32(offset: i32): i32 {
    return __byte_array_get(this.#buffer, offset)
         | (__byte_array_get(this.#buffer, offset + 1) << 8)
         | (__byte_array_get(this.#buffer, offset + 2) << 16)
         | (__byte_array_get(this.#buffer, offset + 3) << 24);
  }

  /** Read 64-bit (little-endian). */
  getU64(offset: i32): i64 {
    let lo = this.getU32(offset) as i64;
    let hi = this.getU32(offset + 4) as i64;
    return lo | (hi << 32);
  }

  /** Read f32 (little-endian). */
  getF32(offset: i32): f32 {
    let bits = this.getU32(offset);
    return __i32_reinterpret_f32(bits);
  }

  /** Read f64 (little-endian). */
  getF64(offset: i32): f64 {
    let bits = this.getU64(offset);
    return __i64_reinterpret_f64(bits);
  }

  /** Read unsigned LEB128. Returns (value, bytesRead). */
  getULEB128(offset: i32): (i32, i32) {
    var result = 0;
    var shift = 0;
    var pos = offset;
    while (true) {
      let byte = __byte_array_get(this.#buffer, pos);
      pos = pos + 1;
      result = result | ((byte & 0x7F) << shift);
      if ((byte & 0x80) == 0) {
        return (result, pos - offset);
      }
      shift = shift + 7;
    }
  }
}
```

---

## Required Compiler Intrinsics

The design requires two new intrinsics for float bit reinterpretation:

| Intrinsic                    | WASM Instruction      | Description            |
| ---------------------------- | --------------------- | ---------------------- |
| `__f32_reinterpret_i32(f32)` | `i32.reinterpret_f32` | Float bits as integer  |
| `__f64_reinterpret_i64(f64)` | `i64.reinterpret_f64` | Double bits as integer |
| `__i32_reinterpret_f32(i32)` | `f32.reinterpret_i32` | Integer as float bits  |
| `__i64_reinterpret_f64(i64)` | `f64.reinterpret_i64` | Integer as double bits |

These map directly to WASM instructions with no runtime cost.

---

## Alternative Designs Considered

### 1. Single Contiguous Buffer (like JS ArrayBuffer)

```zena
class ByteBuffer {
  #buffer: ByteArray;
  #length: i32;
  #capacity: i32;

  #grow() {
    let newBuffer = newByteArray(this.#capacity * 2);
    copyBytes(newBuffer, 0, this.#buffer, 0, this.#length);
    this.#buffer = newBuffer;
  }
}
```

**Pros:**

- Simple random access
- Single final copy

**Cons:**

- Every growth requires copying all data
- For large buffers, this becomes expensive

### 2. Chunked Buffer (chosen design)

**Pros:**

- O(1) amortized writes regardless of total size
- No copying during writes
- Natural for streaming construction

**Cons:**

- Random access requires chunk lookup
- Final `toByteArray()` requires one copy

For WASM emitter use case, we write sequentially far more than we read, so
chunked is the better choice. Patching is relatively rare.

### 3. Hybrid: Rope-like Structure

Could use a tree of chunks for O(log n) random access. Probably overkill for
our use case.

---

## Future: Typed Arrays

For performance-critical numeric processing (signal processing, matrix math),
we may want typed arrays similar to JavaScript's `Float32Array`, `Int32Array`.

### Option A: Generic FixedArray<T>

We already have `FixedArray<T>` which compiles to WASM GC arrays:

- `FixedArray<i32>` → `(array (mut i32))`
- `FixedArray<f32>` → `(array (mut f32))`

This gives us typed arrays "for free" via generics.

### Option B: Explicit Typed Array Classes

```zena
export final class Int32Array {
  #buffer: FixedArray<i32>;
  // ...
}
```

For now, `FixedArray<T>` should suffice. We can add convenience wrappers later.

---

## Future: Host Interop

### Interop with JS ArrayBuffer

When targeting JS hosts, we need to exchange binary data:

```zena
// Future API
let jsBuffer = ArrayBuffer.from(byteBuffer);  // Copy to JS
let zenaBytes = ByteArray.fromArrayBuffer(ab); // Copy from JS
```

This requires host function imports. Design TBD based on runtime needs.

### Interop with Linear Memory

For WASI and FFI, see [linear-memory.md](linear-memory.md). The `Memory` class
provides direct access to linear memory. We can copy between:

```zena
// GC heap → linear memory
let mem = Memory.default;
let bytes = buffer.toByteArray();
var i = 0;
while (i < __byte_array_length(bytes)) {
  mem.setU8(ptr + i, __byte_array_get(bytes, i));
  i = i + 1;
}

// Future: bulk copy intrinsic?
// __memory_copy_from_gc(mem, ptr, bytes, offset, length)
```

---

## Implementation Plan

### Phase 1: ByteBuffer (Priority: High)

1. Add reinterpret intrinsics to compiler
2. Implement `ByteBuffer` in stdlib
3. Add comprehensive tests

**Deliverables:**

- [zena:byte-buffer](../packages/stdlib/zena/byte-buffer.zena) module
- Tests for all write methods and LEB128 encoding

### Phase 2: DataView (Priority: Medium)

1. Implement `DataView` class
2. Add tests for all read methods

**Deliverables:**

- [zena:data-view](../packages/stdlib/zena/data-view.zena) module

### Phase 3: Integration (Priority: Low)

1. Use ByteBuffer in a sample WASM emitter
2. Document patterns for binary format construction

---

## Usage Example: WASM Section

```zena
import { ByteBuffer } from 'zena:byte-buffer';

let writeSection = (buf: ByteBuffer, sectionId: i32, content: ByteBuffer): void => {
  buf.writeByte(sectionId);
  buf.writeULEB128(content.length);
  buf.writeBuffer(content);
};

let emitTypeSection = (types: Array<FuncType>): ByteBuffer => {
  let content = new ByteBuffer();
  content.writeULEB128(types.length);
  for (let ty in types) {
    content.writeByte(0x60);  // func
    content.writeULEB128(ty.params.length);
    for (let p in ty.params) {
      content.writeByte(encodeValType(p));
    }
    content.writeULEB128(ty.results.length);
    for (let r in ty.results) {
      content.writeByte(encodeValType(r));
    }
  }
  return content;
};
```

---

## Summary

| Class           | Purpose                      | Growth Strategy              |
| --------------- | ---------------------------- | ---------------------------- |
| `ByteArray`     | Fixed-size byte storage      | N/A (fixed)                  |
| `ByteBuffer`    | Growable binary construction | Chunked (like StringBuilder) |
| `DataView`      | Typed reads from ByteArray   | N/A (view only)              |
| `FixedArray<T>` | Typed numeric arrays         | N/A (fixed)                  |
| `Array<T>`      | Growable generic arrays      | Doubling                     |

The chunked `ByteBuffer` design balances write efficiency with the occasional
need for random access patching, making it well-suited for binary format
construction like WASM emission.
