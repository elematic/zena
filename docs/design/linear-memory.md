# Linear Memory Design

## Overview

Zena is a WASM-GC language, but many WASI APIs and external libraries (like
re2-wasm, sqlite-wasm) operate on **linear memory**. This document designs the
bridge between Zena's GC heap and linear memory, enabling:

1. Zero-copy string handling for WASI I/O
2. Type-safe buffer access with familiar `[]` syntax
3. Integration with linear-memory libraries (regex, compression, crypto)
4. Memory management patterns for linear memory lifetime

For string design including `LinearString`, see [strings.md](strings.md).
For devirtualization optimizations, see [optimizations.md](optimizations.md).

## The Two Memory Worlds

```
┌─────────────────────────────────────────────────────────────────┐
│                        WASM Module                              │
│  ┌──────────────────────┐      ┌──────────────────────────────┐ │
│  │     GC Heap          │      │      Linear Memory           │ │
│  │  ┌─────────────┐     │      │  ┌────────────────────────┐  │ │
│  │  │ String      │     │      │  │ WASI iovec structs     │  │ │
│  │  │ - ByteArray─┼─────┼──X───┼──│ re2 pattern buffer     │  │ │
│  │  │ - start     │     │      │  │ File read buffer       │  │ │
│  │  │ - end       │     │      │  │ Crypto work area       │  │ │
│  │  └─────────────┘     │      │  └────────────────────────┘  │ │
│  │  ┌─────────────┐     │      │                              │ │
│  │  │ FixedArray  │     │      │  ptr=0    ptr=1024   ptr=2048│ │
│  │  └─────────────┘     │      └──────────────────────────────┘ │
│  └──────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────┘
```

**The X marks the problem**: GC objects can't be passed to linear memory APIs.
We need a bridge.

---

## Buffer Classes

### Hierarchy

```zena
// Base interface for all linear memory views
interface LinearBuffer<T> extends Sequence<T> {
  get ptr(): i32;
  get byteLength(): i32;

  // Create a view (zero-copy)
  slice(start: i32, end: i32): LinearBuffer<T>;
}

// Typed buffer implementations
final class U8Buffer implements LinearBuffer<i32> {
  #ptr: i32;
  #len: i32;

  #new(ptr: i32, len: i32) {
    this.#ptr = ptr;
    this.#len = len;
  }

  // Allocate new buffer in linear memory
  static alloc(len: i32): U8Buffer {
    let ptr = LinearMemory.alloc(len);
    return new U8Buffer(ptr, len);
  }

  // Wrap existing linear memory region
  static wrap(ptr: i32, len: i32): U8Buffer {
    return new U8Buffer(ptr, len);
  }

  get length(): i32 { return this.#len; }
  get ptr(): i32 { return this.#ptr; }
  get byteLength(): i32 { return this.#len; }

  @intrinsic('i32.load8_u')
  declare operator [](index: i32): i32;

  @intrinsic('i32.store8')
  declare operator []=(index: i32, value: i32): void;

  slice(start: i32, end: i32): U8Buffer {
    return new U8Buffer(this.#ptr + start, end - start);
  }

  // Copy from GC array
  copyFrom(source: ByteArray, sourceStart: i32 = 0, len: i32 = -1): void;

  // Copy to GC array
  copyTo(dest: ByteArray, destStart: i32 = 0, len: i32 = -1): void;
}

final class I32Buffer implements LinearBuffer<i32> {
  #ptr: i32;
  #len: i32;  // Length in elements

  get byteLength(): i32 { return this.#len * 4; }

  @intrinsic('i32.load')
  declare operator [](index: i32): i32;  // Compiler emits: ptr + index * 4

  @intrinsic('i32.store')
  declare operator []=(index: i32, value: i32): void;
}

final class F64Buffer implements LinearBuffer<f64> {
  #ptr: i32;
  #len: i32;

  get byteLength(): i32 { return this.#len * 8; }

  @intrinsic('f64.load')
  declare operator [](index: i32): f64;  // Compiler emits: ptr + index * 8
}
```

### Intrinsic Stride Calculation

For `I32Buffer[i]`, we need `i32.load(ptr + i * 4)`:

```wat
;; Compiler transformation for @intrinsic('i32.load') on I32Buffer:
;; Source: buffer[index]
;;
;; Emitted WASM:
local.get $this
struct.get $I32Buffer #ptr    ;; Get base pointer
local.get $index
i32.const 4
i32.mul
i32.add                        ;; ptr + index * 4
i32.load align=4 offset=0
```

The compiler infers stride from the intrinsic name and buffer element type:

- `i32.load` on `I32Buffer` → stride 4
- `f64.load` on `F64Buffer` → stride 8
- `i32.load8_u` on `U8Buffer` → stride 1

### Bounds Checking

Debug builds insert bounds checks:

```zena
// Debug mode expansion of buffer[i]
if (i < 0 || i >= this.#len) {
  throw new IndexOutOfBoundsError(i, this.#len);
}
__intrinsic_i32_load(this.#ptr + i * 4)
```

Release mode omits the check. For explicit unchecked access:

```zena
buffer.getUnchecked(index);  // Never bounds-checks
buffer.setUnchecked(index, value);
```

---

## Memory Management

### Basic Operations

```zena
final class LinearMemory {
  @intrinsic('memory.size')
  declare static size(): i32;  // In pages (64KB each)

  @intrinsic('memory.grow')
  declare static grow(pages: i32): i32;  // Returns old size, -1 on failure

  // Simple bump allocator (for MVP)
  static #nextPtr: i32 = 64;  // Skip WASI reserved area

  static alloc(bytes: i32): i32 {
    let ptr = LinearMemory.#nextPtr;
    LinearMemory.#nextPtr = ptr + bytes;

    // Grow memory if needed
    let needed = (LinearMemory.#nextPtr + 65535) / 65536;
    if (needed > LinearMemory.size()) {
      LinearMemory.grow(needed - LinearMemory.size());
    }

    return ptr;
  }

  // Note: No free() in MVP - use arena/region patterns instead
}
```

### The Lifetime Problem

WASM GC manages GC objects automatically, but linear memory has no automatic
cleanup. When a `U8Buffer` GC object becomes unreachable, the linear memory it
points to is NOT freed.

```zena
func leak(): void {
  let buf = U8Buffer.alloc(1024);
  // buf goes out of scope, GC object is collected
  // BUT: 1024 bytes of linear memory are leaked!
}
```

### Solution: `using` Declaration

Inspired by C# `using` and TC39 Explicit Resource Management:

```zena
func process(): void {
  using buf = U8Buffer.alloc(1024);
  // use buf
}  // buf.dispose() called automatically here

// Desugars to:
func process(): void {
  let buf = U8Buffer.alloc(1024);
  try {
    // use buf
  } finally {
    buf.dispose();
  }
}
```

**Interface:**

```zena
interface Disposable {
  dispose(): void;
}

// Compiler ensures `using` variables implement Disposable
using buf = U8Buffer.alloc(1024);  // OK: U8Buffer implements Disposable
using x = 42;  // Error: i32 does not implement Disposable
```

**Multiple resources:**

```zena
func copy(src: string, dst: string): void {
  using srcBuf = U8Buffer.alloc(src.length);
  using dstBuf = U8Buffer.alloc(src.length);

  src.copyTo(srcBuf);
  transform(srcBuf, dstBuf);
  // Both disposed in reverse order: dstBuf, then srcBuf
}
```

### Arena Pattern

For many small allocations with shared lifetime:

```zena
func processFile(filename: string): Result {
  using arena = new Arena(LinearMemory.defaultAllocator);

  // All allocations from arena
  let pathBuf = U8Buffer.alloc(256, arena);
  let dataBuf = U8Buffer.alloc(4096, arena);
  let resultBuf = U8Buffer.alloc(1024, arena);

  // ... lots of work with buffers ...

  // Copy result to GC before arena dies
  let result = resultBuf.toByteArray();
  return result;
}  // arena.dispose() frees ALL linear memory at once
```

---

## Allocator Interface

Different scenarios need different allocation strategies:

```zena
interface Allocator {
  alloc(bytes: i32): i32;       // Returns ptr, or 0 on failure
  free(ptr: i32, bytes: i32): void;
  realloc(ptr: i32, oldBytes: i32, newBytes: i32): i32;
}

// Bump allocator - fast, no individual free
final class BumpAllocator implements Allocator {
  #memory: Memory;
  #base: i32;
  #offset: i32;
  #limit: i32;

  alloc(bytes: i32): i32 {
    let ptr = this.#base + this.#offset;
    this.#offset = this.#offset + bytes;
    if (this.#base + this.#offset > this.#limit) {
      this.#memory.grow(1);
      this.#limit = this.#limit + 65536;
    }
    return ptr;
  }

  free(ptr: i32, bytes: i32): void {
    // No-op for bump allocator
  }

  reset(): void {
    this.#offset = 0;
  }
}

// Arena allocator - bulk free
final class Arena implements Allocator {
  #allocator: Allocator;
  #allocations: Array<{ptr: i32, size: i32}>;

  alloc(bytes: i32): i32 {
    let ptr = this.#allocator.alloc(bytes);
    this.#allocations.push({ptr, size: bytes});
    return ptr;
  }

  free(ptr: i32, bytes: i32): void {
    // No-op - freed in bulk
  }

  dispose(): void {
    for (let a in this.#allocations) {
      this.#allocator.free(a.ptr, a.size);
    }
    this.#allocations.clear();
  }
}

// Free-list allocator - supports individual free
final class FreeListAllocator implements Allocator {
  // Traditional malloc/free implementation
}
```

---

## LinearString

`LinearString` is a String implementation backed by linear memory, enabling
zero-copy string handling for WASI I/O and FFI.

### Code Sharing with String

`LinearString` extends the abstract `String` class, which uses the **template
method pattern** for code sharing. The base `String` class implements ~30 methods
(indexOf, startsWith, split, etc.) once, calling abstract primitives that each
subclass implements:

```zena
// In abstract String class (shared code, not duplicated):
indexOf(needle: String): i32 {
  // Algorithm implemented once, calls this.byteAt() which is virtual
  for (var i = 0; i <= this.length - needle.length; i = i + 1) {
    if (this.regionMatches(i, needle)) return i;
  }
  return -1;
}

// Each subclass only implements the primitives:
final class LinearString extends String {
  @intrinsic('i32.load8_u')
  declare byteAt(index: i32): i32;  // ~3 WASM instructions

  get length(): i32 { return this.#len; }
}

final class GCString extends String {
  byteAt(index: i32): i32 {
    return this.#data[this.#start + index];  // ~5 WASM instructions
  }
}
```

**Why not mixins?** Mixins would monomorphize (duplicate) all ~30 methods for each
String subclass. With 5 subclasses (GCString, LinearString, HostString, RopeString,
LiteralString), that's 5× the code. The template method approach shares code with
a small virtual dispatch overhead for the primitives.

**Performance**: The virtual `byteAt()` calls inside shared methods are acceptable
because:
- String algorithms are O(n), amortizing the vtable lookup cost
- JIT inline caching makes repeated calls to the same type fast
- When concrete type is known, entire method specializes (see devirtualization)

See [strings.md](strings.md) for the complete String architecture.

### LinearString Implementation

```zena
final class LinearString extends String {
  #ptr: i32;
  #len: i32;
  #encoding: i32;

  // Zero-copy constructor
  static wrap(ptr: i32, len: i32, encoding: Encoding = Encoding.UTF8): LinearString {
    return new LinearString(ptr, len, encoding);
  }

  // Slicing (still zero-copy)
  slice(start: i32, end: i32): LinearString {
    return new LinearString(this.#ptr + start, end - start, this.#encoding);
  }

  // Convert to GC string (copies data)
  toGCString(): GCString {
    let data = new ByteArray(this.#len);
    this.copyTo(data);
    return new GCString(data, 0, this.#len, this.#encoding);
  }

  // Access underlying linear memory
  get ptr(): i32 { return this.#ptr; }
  get byteLength(): i32 { return this.#len; }

  @intrinsic('i32.load8_u')
  declare byteAt(index: i32): i32;
}
```

---

## FFI: C/Rust Library Integration

### The Bridge Pattern

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Zena Code     │────▶│  Linear Memory   │────▶│  C/Rust WASM    │
│  (GC Objects)   │◀────│    (Bridge)      │◀────│   (Library)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
     String              U8Buffer / ptr           const char*
     FixedArray<i32>     I32Buffer / ptr          int32_t*
     Record {x, y}       Struct in linear mem     struct point
```

### Example: zlib Integration

```zena
// Import the C function
@external("zlib", "compress")
declare func zlib_compress(
  destPtr: i32,
  destLenPtr: i32,
  sourcePtr: i32,
  sourceLen: i32
): i32;

// High-level Zena API
class Compression {
  static compress(data: ByteSequence): ByteArray {
    // 1. Copy input to linear memory
    using sourceBuf = U8Buffer.alloc(data.length);
    data.copyTo(sourceBuf);

    // 2. Allocate output buffer
    let maxDestLen = data.length + (data.length / 10) + 12;
    using destBuf = U8Buffer.alloc(maxDestLen);

    // 3. Allocate space for destLen output parameter
    using destLenBuf = I32Buffer.alloc(1);
    destLenBuf[0] = maxDestLen;

    // 4. Call C function
    let result = zlib_compress(
      destBuf.ptr,
      destLenBuf.ptr,
      sourceBuf.ptr,
      data.length
    );

    if (result != 0) {
      throw new CompressionError(result);
    }

    // 5. Copy result back to GC heap
    let actualLen = destLenBuf[0];
    let output = new ByteArray(actualLen);
    destBuf.slice(0, actualLen).copyTo(output);

    return output;
  }
}

// Usage - clean high-level API
let compressed = Compression.compress(myData);
```

### Example: re2-wasm (Regex)

```zena
@external("re2", "re2_compile")
declare func re2_compile(patternPtr: i32, patternLen: i32, flags: i32): i32;

@external("re2", "re2_match")
declare func re2_match(
  handle: i32,
  inputPtr: i32, inputLen: i32,
  matchesPtr: i32, maxMatches: i32
): i32;

@external("re2", "re2_free")
declare func re2_free(handle: i32): void;

class Regex {
  #handle: i32;

  #new(pattern: String) {
    using buf = U8Buffer.alloc(pattern.length);
    pattern.copyTo(buf);
    this.#handle = re2_compile(buf.ptr, buf.byteLength, 0);
    if (this.#handle == 0) {
      throw new RegexError("Invalid pattern");
    }
  }

  match(input: String): FixedArray<Match>? {
    // Optimize: if input is already linear, use directly
    let (ptr, len) = input.toLinearRef();

    using matchBuf = I32Buffer.alloc(20);  // 10 matches * 2
    let count = re2_match(this.#handle, ptr, len, matchBuf.ptr, 10);

    if (count == 0) return null;

    return FixedArray.generate(count, (i) => {
      new Match(matchBuf[i * 2], matchBuf[i * 2 + 1])
    });
  }

  dispose(): void {
    if (this.#handle != 0) {
      re2_free(this.#handle);
      this.#handle = 0;
    }
  }
}
```

### Zero-Copy Pipeline

The real win is when you can avoid copies entirely:

```zena
// Read file -> regex match -> no copies until we need GC objects!
let fd = Filesystem.open("log.txt");
let content = fd.readLinear();  // Returns LinearString (zero-copy)

let regex = new Regex("error: (.*)");
let matches = regex.match(content);  // LinearString.ptr passed directly to re2!

// Only copy the matches we care about
for (let m in matches) {
  let errorMsg: String = content.slice(m.start, m.end).toString();  // Copy here
  Console.log(errorMsg);
}
```

### FFI Helper: `toLinearRef()`

A key method for efficient FFI:

```zena
extension class StringExt on String {
  // Returns (ptr, len) - either existing linear ptr or temp copy
  toLinearRef(): (i32, i32) {
    if (this is LinearString) {
      return (this.ptr, this.byteLength);  // Zero-copy!
    }
    // Must copy to linear memory
    let buf = U8Buffer.alloc(this.length);
    this.copyTo(buf);
    return (buf.ptr, buf.byteLength);
  }
}
```

### Struct Marshaling

For C structs, define layout-compatible linear memory views:

```zena
// C struct: struct Point { int32_t x; int32_t y; };

class LinearPoint {
  #ptr: i32;

  static alloc(): LinearPoint {
    return new LinearPoint(LinearMemory.alloc(8));
  }

  static wrap(ptr: i32): LinearPoint {
    return new LinearPoint(ptr);
  }

  get x(): i32 { return I32Buffer.wrap(this.#ptr, 1)[0]; }
  set x(v: i32) { I32Buffer.wrap(this.#ptr, 1)[0] = v; }

  get y(): i32 { return I32Buffer.wrap(this.#ptr + 4, 1)[0]; }
  set y(v: i32) { I32Buffer.wrap(this.#ptr + 4, 1)[0] = v; }

  get ptr(): i32 { return this.#ptr; }

  toRecord(): {x: i32, y: i32} {
    return {x: this.x, y: this.y};
  }
}
```

---

## WASM Tables and Function Pointers

C libraries often take function pointer callbacks. In WASM, function pointers
are **table indices** (i32).

```zena
// Declare a table for callbacks
@external("env", "__indirect_function_table")
declare let callbackTable: Table<(i32, i32) => i32>;

// Add a Zena function to the table
let compareInts = (a: i32, b: i32): i32 => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

let funcIndex: i32 = callbackTable.add(compareInts);

// Pass index to C library
qsort(arrayPtr, count, 4, funcIndex);
```

### Callbacks with Closures

Closures capture variables, but C callbacks often pass a `void* userData`:

```zena
// GC object table for passing closures via userData
let gcTable: Table<Object> = new Table(100);

func execWithCallback(db: Database, sql: string,
                      callback: (row: Row) => void): void {
  // Store the closure in a GC table, get index
  let closureIndex = gcTable.add(callback);

  // Trampoline function that looks up the closure
  let trampoline = (userData: i32, argc: i32, argv: i32, cols: i32): i32 => {
    let cb = gcTable.get(userData) as (Row) => void;
    let row = Row.fromLinear(argc, argv, cols);
    cb(row);
    return 0;
  };

  let trampolineIndex = callbackTable.add(trampoline);

  using sqlBuf = U8Buffer.allocNullTerminated(sql);
  let errBuf = I32Buffer.alloc(1);

  sqlite3_exec(db.handle, sqlBuf.ptr, trampolineIndex, closureIndex, errBuf.ptr);

  gcTable.remove(closureIndex);
}
```

### Callback Helper

```zena
class Callback<F> implements Disposable {
  #index: i32;
  #table: Table<F>;

  static create<F>(f: F, table: Table<F> = defaultCallbackTable): Callback<F> {
    let index = table.add(f);
    return new Callback(index, table);
  }

  get index(): i32 { return this.#index; }

  dispose(): void {
    this.#table.remove(this.#index);
  }
}

// Usage with automatic cleanup
func sortArray(arr: I32Buffer): void {
  using cmp = Callback.create((a: i32, b: i32): i32 => a - b);
  qsort(arr.ptr, arr.length, 4, cmp.index);
}
```

---

## Advanced Topics

### Multiple Memories

The WASM multi-memory proposal allows modules to have multiple linear memories:

```zena
// Memory is a first-class concept
final class Memory {
  static let default: Memory = Memory.#fromIndex(0);

  @external("env", "memory")
  static declare let shared: Memory;

  @intrinsic('memory.size')
  declare size(): i32;

  @intrinsic('memory.grow')
  declare grow(pages: i32): i32;
}

// Buffers are parameterized by memory
final class U8Buffer {
  #memory: Memory;
  #ptr: i32;
  #len: i32;

  static allocIn(memory: Memory, len: i32): U8Buffer {
    let ptr = memory.alloc(len);
    return new U8Buffer(memory, ptr, len);
  }
}

// Library-specific memories
let re2Memory = Memory.import("re2", "memory");
let patternBuf = U8Buffer.allocIn(re2Memory, 1024);
```

**Current status**: Multi-memory is a proposal, not yet widely supported.
For MVP, we assume a single memory (index 0).

### Future: WASM Weak References

WASM GC has a post-MVP proposal for weak references. Once available:

```zena
final class U8Buffer {
  #new(ptr: i32, len: i32) {
    this.#ptr = ptr;
    this.#len = len;
    // When this GC object is collected, free linear memory
    __weak_ref_register(this, () => {
      LinearMemory.defaultAllocator.free(ptr, len);
    });
  }
}
```

Until then, explicit lifetime management via `using` is required.

---

## Implementation Plan

### Phase 1: Memory Intrinsics

- Add all load/store intrinsics to codegen
- Add `memory.size`, `memory.grow`
- Basic `LinearMemory` static class with bump allocator

### Phase 2: `using` Declaration

- Parser: `using` statement syntax
- Checker: Validate `Disposable` interface
- Codegen: Desugar to try/finally with dispose()
- Define `Disposable` interface in stdlib

### Phase 3: Buffer Classes

- Implement `U8Buffer`, `I32Buffer`, `F32Buffer`, `F64Buffer`
- Intrinsic-backed `[]` operators with stride calculation
- `alloc`, `wrap`, `slice` methods
- `copyTo`/`copyFrom` for GC ↔ linear transfers
- `Disposable` implementation

### Phase 4: Allocator Interface

- Define `Allocator` interface
- Implement `BumpAllocator`, `Arena`
- Update buffer classes to accept allocator

### Phase 5: LinearString

- Implement `LinearString` extending `String`
- Add `toLinearRef()` extension method
- Implement `LinearStringBuilder`

### Phase 6: Tables and Callbacks

- Table type and operations
- `Callback<F>` wrapper class
- Integration with `using` for automatic cleanup

### Phase 7: FFI Helpers & Testing

- `withLinearString`, `withArena` helpers
- Null-terminated string helpers
- Integration tests with real libraries

---

## Open Questions

1. **Memory growth strategy**: Should we expose control over when/how linear
   memory grows, or always auto-grow?

2. **`@linear struct` syntax**: Worth adding compiler support for auto-generating
   linear memory struct wrappers, or is manual definition sufficient?

3. **Multi-memory support**: When should we add support for multiple memories?
   Wait for broader runtime support, or design the API now?

4. **Table management**: Should tables auto-grow? How do we handle table indices
   becoming invalid after `remove()`?

5. **Async FFI**: How do we handle C libraries that use callbacks for async?
   Should we bridge to Zena's future async model?
