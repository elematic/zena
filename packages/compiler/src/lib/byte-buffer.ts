/**
 * A growable byte buffer using resizable ArrayBuffer for efficient binary
 * building. Uses resizable ArrayBuffers which can grow without copying data.
 */
export class ByteBuffer {
  #buffer: ArrayBuffer;
  #view: Uint8Array;
  #length = 0;

  constructor(initialCapacity = 4096, maxCapacity = 256 * 1024 * 1024) {
    this.#buffer = new ArrayBuffer(initialCapacity, {
      maxByteLength: maxCapacity,
    });
    this.#view = new Uint8Array(this.#buffer);
  }

  get length(): number {
    return this.#length;
  }

  #ensureCapacity(needed: number): void {
    if (needed <= this.#buffer.byteLength) return;
    let newSize = this.#buffer.byteLength;
    while (newSize < needed) newSize *= 2;
    this.#buffer.resize(Math.min(newSize, this.#buffer.maxByteLength));
    // Re-create view to reflect new buffer size
    this.#view = new Uint8Array(this.#buffer);
  }

  push(...bytes: number[]): void {
    this.#ensureCapacity(this.#length + bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      this.#view[this.#length++] = bytes[i];
    }
  }

  pushByte(byte: number): void {
    this.#ensureCapacity(this.#length + 1);
    this.#view[this.#length++] = byte;
  }

  pushArray(bytes: Uint8Array | readonly number[]): void {
    this.#ensureCapacity(this.#length + bytes.length);
    if (bytes instanceof Uint8Array) {
      this.#view.set(bytes, this.#length);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        this.#view[this.#length + i] = bytes[i];
      }
    }
    this.#length += bytes.length;
  }

  toUint8Array(): Uint8Array {
    // Return a copy so .buffer has the correct size (important for
    // WebAssembly.compile)
    return this.#view.slice(0, this.#length);
  }
}
