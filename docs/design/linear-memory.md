# Linear Memory Design

## Overview

Zena is a WASM-GC language, but many WASI APIs and external libraries (like
re2-wasm, sqlite-wasm) operate on **linear memory**. This document describes
the `zena:memory` module which provides the bridge between Zena's GC heap and
linear memory, enabling:

1. Type-safe access to linear memory with intrinsic-backed methods
2. Memory management with pluggable allocators
3. Integration with WASI and linear-memory libraries (regex, compression, crypto)

For string design including `LinearString`, see [strings.md](strings.md).

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
The `Memory` class and allocators provide this bridge.

---

## The Memory Class

The `Memory` class provides type-safe, array-like access to WASM linear memory.
All methods are backed by `@intrinsic` decorators that compile directly to WASM
memory instructions.

```zena
export final class Memory {
  /** The default memory instance (memory index 0). */
  static default: Memory = new Memory();

  /** Get the current size of linear memory in 64KB pages. */
  @intrinsic('memory.size')
  declare size(): i32;

  /** Grow linear memory by pages. Returns old size, or -1 on failure. */
  @intrinsic('memory.grow')
  declare grow(pages: i32): i32;

  /** The current size in bytes. */
  byteLength: i32 {
    get { return this.size() << 16; }
  }

  // Byte access (u8)
  @intrinsic('i32.load8_u')
  declare getU8(ptr: i32): i32;

  @intrinsic('i32.store8')
  declare setU8(ptr: i32, value: i32): void;

  // 32-bit integer access
  @intrinsic('i32.load')
  declare getI32(ptr: i32): i32;

  @intrinsic('i32.store')
  declare setI32(ptr: i32, value: i32): void;

  // 64-bit integer access
  @intrinsic('i64.load')
  declare getI64(ptr: i32): i64;

  @intrinsic('i64.store')
  declare setI64(ptr: i32, value: i64): void;

  // Floating point access
  @intrinsic('f32.load')
  declare getF32(ptr: i32): f32;

  @intrinsic('f32.store')
  declare setF32(ptr: i32, value: f32): void;

  @intrinsic('f64.load')
  declare getF64(ptr: i32): f64;

  @intrinsic('f64.store')
  declare setF64(ptr: i32, value: f64): void;

  // Array-like byte access via operator overloading
  @intrinsic('i32.load8_u')
  declare operator [](index: i32): i32;

  @intrinsic('i32.store8')
  declare operator []=(index: i32, value: i32): void;
}
```

### Usage

```zena
let mem = Memory.default;

// Size operations
let pages = mem.size();        // Current size in pages
let bytes = mem.byteLength;    // Current size in bytes
mem.grow(1);                   // Add one 64KB page

// Typed access (explicit methods)
mem.setI32(100, 42);
let value = mem.getI32(100);   // 42

// Array-like byte access
mem[0] = 65;                   // Write byte at address 0
let b = mem[0];                // Read byte (unsigned): 65
```

### Why Simple Methods over Buffer Classes?

An earlier design proposed typed buffer classes (U8Buffer, I32Buffer, etc.):

```zena
// NOT IMPLEMENTED - earlier design
final class I32Buffer {
  #ptr: i32;
  #len: i32;
  @intrinsic('i32.load')
  declare operator [](index: i32): i32;  // Would need ptr + index * 4
}
```

We chose simple typed methods instead because:

1. **No stride inference needed**: `getI32(ptr)` takes the exact address;
   the caller handles offsets. Buffer classes would need compiler magic to
   infer stride (4 for i32, 8 for f64) from the element type.

2. **Maps to WASM 1:1**: Each method is exactly one WASM instruction.
   No hidden multiplication or addition.

3. **Simpler for WASI/FFI**: Most APIs pass raw pointers. Wrapping in buffer
   objects adds ceremony without benefit.

4. **Works today**: No new compiler features required.

Stride calculation is the caller's responsibility:

```zena
// Reading an i32 array at ptr with length n:
let mem = Memory.default;
for (var i = 0; i < n; i = i + 1) {
  let value = mem.getI32(ptr + i * 4);
  // ...
}
```

---

## Allocator Interface

The `Allocator` interface abstracts memory allocation strategies. The key design
decision is using **multi-return values** to force error handling:

```zena
interface Allocator {
  /** Returns (true, ptr) on success, (false, _) on failure. */
  alloc(bytes: i32): (true, i32) | (false, never);

  /** Allocate with alignment (align must be power of 2). */
  allocAligned(bytes: i32, align: i32): (true, i32) | (false, never);

  /** Free a previously allocated pointer. May be a no-op for some allocators. */
  free(ptr: i32): void;
}
```

### Why Multi-Return Instead of Returning 0?

The traditional C pattern returns 0 (NULL) on failure:

```c
void* ptr = malloc(size);
if (ptr == NULL) { /* handle error */ }  // Easy to forget!
```

This is dangerous because 0 IS a valid linear memory address (unlike GC where
null is special). The multi-return pattern forces callers to handle both cases:

```zena
// Must use pattern matching - compiler enforces handling both cases
if (let (true, ptr) = alloc.alloc(size)) {
  // use ptr
} else {
  // handle out of memory
}
```

### FreeListAllocator (Default)

The default allocator supports both `alloc()` and `free()`. Uses a first-fit
free list with 8-byte headers:

```zena
export final class FreeListAllocator implements Allocator {
  /** The default allocator, starting at byte 64 (after WASI reserved area). */
  static default: FreeListAllocator = new FreeListAllocator(64);

  #startPtr: i32;
  #nextPtr: i32;      // Bump pointer for fresh allocations
  #freeList: i32;     // Head of free list (0 = empty)

  alloc(bytes: i32): (true, i32) | (false, never) {
    // 1. Search free list for suitable block
    // 2. If found, split if large enough, return
    // 3. Otherwise bump allocate, grow memory if needed
    // 4. Return (false, _) if grow fails
  }

  free(ptr: i32): void {
    // Add block to free list
  }
}
```

Memory layout:

```
[8-byte header: size, next_free][user data...]
```

### BumpAllocator (Arena)

A fast allocator for temporary allocations with known lifetime. Does not support
individual `free()` - use `reset()` to free all at once.

**Key design**: BumpAllocator is **bounded** over a pre-allocated region from
the root allocator. It cannot grow memory - when exhausted, allocation fails.

```zena
export final class BumpAllocator implements Allocator {
  #startPtr: i32;
  #endPtr: i32;
  #nextPtr: i32;

  /** Create over a pre-allocated region. */
  #new(startPtr: i32, size: i32) {
    this.#startPtr = startPtr;
    this.#endPtr = startPtr + size;
    this.#nextPtr = startPtr;
  }

  alloc(bytes: i32): (true, i32) | (false, never) {
    let ptr = this.#nextPtr;
    let newNext = ptr + bytes;
    if (newNext > this.#endPtr) {
      return (false, _);  // Arena exhausted
    }
    this.#nextPtr = newNext;
    return (true, ptr);
  }

  /** Reset to initial state. WARNING: invalidates all pointers! */
  reset(): void {
    this.#nextPtr = this.#startPtr;
  }

  /** Bytes remaining in arena. */
  remaining: i32 { get { return this.#endPtr - this.#nextPtr; } }
}
```

### Usage Patterns

**General allocation:**

```zena
import {defaultAllocator} from 'zena:memory';

if (let (true, ptr) = defaultAllocator.alloc(1024)) {
  // use ptr
  defaultAllocator.free(ptr);
} else {
  // handle out of memory
}
```

**Helper for critical allocations:**

```zena
const allocOrPanic = (alloc: Allocator, bytes: i32): i32 => {
  if (let (true, ptr) = alloc.alloc(bytes)) {
    return ptr;
  }
  throw new Error('out of memory');
};
```

**Arena pattern for scratch memory:**

```zena
// Allocate a 4KB arena from the root allocator
if (let (true, region) = defaultAllocator.alloc(4096)) {
  let arena = new BumpAllocator(region, 4096);

  // Fast allocations - no free list overhead
  if (let (true, buf1) = arena.alloc(256)) { /* ... */ }
  if (let (true, buf2) = arena.alloc(512)) { /* ... */ }

  // Reuse arena for next batch
  arena.reset();

  // When done, free the underlying region
  defaultAllocator.free(region);
}
```

---

## The Lifetime Problem (Future)

WASM GC manages GC objects automatically, but linear memory has no automatic
cleanup. When a GC object holding a linear memory pointer becomes unreachable,
the linear memory it points to is NOT freed.

```zena
const leak = (): void => {
  if (let (true, ptr) = defaultAllocator.alloc(1024)) {
    // ptr goes out of scope without free()
    // 1024 bytes of linear memory are leaked!
  }
};
```

### Future: `using` Declaration

Inspired by C# `using` and TC39 Explicit Resource Management:

```zena
// Future syntax - not yet implemented
func process(): void {
  using buf = allocOrPanic(defaultAllocator, 1024);
  // use buf
}  // buf automatically freed here

// Desugars to:
func process(): void {
  let buf = allocOrPanic(defaultAllocator, 1024);
  try {
    // use buf
  } finally {
    defaultAllocator.free(buf);
  }
}
```

---

## GC ↔ Linear Memory Transfer

A key limitation: **GC arrays are opaque to WASM bulk memory operations**.
You cannot use `memory.copy` to transfer between GC arrays and linear memory.

Transfer must be done element-by-element:

```zena
/** Copy from GC array to linear memory. */
const copyToLinear = (src: FixedArray<i32>, srcOffset: i32,
                       dst: i32, len: i32): void => {
  let mem = Memory.default;
  for (var i = 0; i < len; i = i + 1) {
    mem.setU8(dst + i, src[srcOffset + i]);
  }
};

/** Copy from linear memory to GC array. */
const copyFromLinear = (src: i32, dst: FixedArray<i32>,
                         dstOffset: i32, len: i32): void => {
  let mem = Memory.default;
  for (var i = 0; i < len; i = i + 1) {
    dst[dstOffset + i] = mem.getU8(src + i);
  }
};
```

For performance-critical code, consider keeping data in linear memory
throughout the hot path, only converting at boundaries.

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

## FFI: C/Rust Library Integration (Future)

### The Bridge Pattern

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Zena Code     │────▶│  Linear Memory   │────▶│  C/Rust WASM    │
│  (GC Objects)   │◀────│   (Allocator)    │◀────│   (Library)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
     String              Memory + ptr             const char*
     FixedArray<i32>     Memory + ptr             int32_t*
     Record {x, y}       Struct in linear mem     struct point
```

### Example: zlib Integration

```zena
import {Memory, defaultAllocator} from 'zena:memory';

// Import the C function
@external("zlib", "compress")
declare func zlib_compress(
  destPtr: i32,
  destLenPtr: i32,
  sourcePtr: i32,
  sourceLen: i32
): i32;

// Helper to copy GC array to linear memory
const copyToLinear = (src: FixedArray<i32>, ptr: i32, len: i32): void => {
  let mem = Memory.default;
  for (var i = 0; i < len; i = i + 1) {
    mem.setU8(ptr + i, src[i]);
  }
};

// Helper to copy linear memory to GC array
const copyFromLinear = (ptr: i32, len: i32): FixedArray<i32> => {
  let mem = Memory.default;
  let result = new FixedArray<i32>(len);
  for (var i = 0; i < len; i = i + 1) {
    result[i] = mem.getU8(ptr + i);
  }
  return result;
};

// High-level Zena API
class Compression {
  static compress(data: FixedArray<i32>): FixedArray<i32> {
    let mem = Memory.default;
    let alloc = defaultAllocator;

    // 1. Allocate and copy input to linear memory
    if (let (true, sourcePtr) = alloc.alloc(data.length)) {
      copyToLinear(data, sourcePtr, data.length);

      // 2. Allocate output buffer
      let maxDestLen = data.length + div(data.length, 10) + 12;
      if (let (true, destPtr) = alloc.alloc(maxDestLen)) {
        // 3. Allocate space for destLen output parameter
        if (let (true, destLenPtr) = alloc.alloc(4)) {
          mem.setI32(destLenPtr, maxDestLen);

          // 4. Call C function
          let result = zlib_compress(destPtr, destLenPtr, sourcePtr, data.length);

          // 5. Copy result back to GC heap
          let actualLen = mem.getI32(destLenPtr);
          let output = copyFromLinear(destPtr, actualLen);

          // 6. Free all allocations
          alloc.free(destLenPtr);
          alloc.free(destPtr);
          alloc.free(sourcePtr);

          if (result != 0) {
            throw new Error('compression failed');
          }
          return output;
        }
      }
    }
    throw new Error('out of memory');
  }
}

// Usage - clean high-level API
let compressed = Compression.compress(myData);
```

### Example: re2-wasm (Regex) (Future)

```zena
import {Memory, defaultAllocator} from 'zena:memory';

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
    let mem = Memory.default;
    let alloc = defaultAllocator;

    if (let (true, ptr) = alloc.alloc(pattern.length)) {
      // Copy string to linear memory
      for (var i = 0; i < pattern.length; i = i + 1) {
        mem.setU8(ptr + i, pattern.byteAt(i));
      }
      this.#handle = re2_compile(ptr, pattern.length, 0);
      alloc.free(ptr);

      if (this.#handle == 0) {
        throw new Error("Invalid pattern");
      }
    } else {
      throw new Error("out of memory");
    }
  }

  match(input: String): FixedArray<Match>? {
    let mem = Memory.default;
    let alloc = defaultAllocator;

    // Allocate buffers for input and match results
    if (let (true, inputPtr) = alloc.alloc(input.length)) {
      // Copy input to linear memory
      for (var i = 0; i < input.length; i = i + 1) {
        mem.setU8(inputPtr + i, input.byteAt(i));
      }

      // 10 matches * 2 ints (start, end) * 4 bytes = 80 bytes
      if (let (true, matchPtr) = alloc.alloc(80)) {
        let count = re2_match(this.#handle, inputPtr, input.length, matchPtr, 10);

        let result: FixedArray<Match>? = null;
        if (count > 0) {
          result = FixedArray.generate(count, (i) => {
            new Match(mem.getI32(matchPtr + i * 8),
                      mem.getI32(matchPtr + i * 8 + 4))
          });
        }

        alloc.free(matchPtr);
        alloc.free(inputPtr);
        return result;
      }
      alloc.free(inputPtr);
    }
    throw new Error("out of memory");
  }

  dispose(): void {
    if (this.#handle != 0) {
      re2_free(this.#handle);
      this.#handle = 0;
    }
  }
}
```

### Struct Marshaling (Future)

For C structs, access fields via Memory at known offsets:

```zena
import {Memory, defaultAllocator} from 'zena:memory';

// C struct: struct Point { int32_t x; int32_t y; };

class LinearPoint {
  #ptr: i32;

  #new(ptr: i32) {
    this.#ptr = ptr;
  }

  static alloc(): LinearPoint? {
    if (let (true, ptr) = defaultAllocator.alloc(8)) {
      return new LinearPoint(ptr);
    }
    return null;
  }

  static wrap(ptr: i32): LinearPoint {
    return new LinearPoint(ptr);
  }

  x: i32 {
    get { return Memory.default.getI32(this.#ptr); }
    set { Memory.default.setI32(this.#ptr, value); }
  }

  y: i32 {
    get { return Memory.default.getI32(this.#ptr + 4); }
    set { Memory.default.setI32(this.#ptr + 4, value); }
  }

  get ptr(): i32 { return this.#ptr; }

  toRecord(): {x: i32, y: i32} {
    return {x: this.x, y: this.y};
  }

  free(): void {
    defaultAllocator.free(this.#ptr);
  }
}
```

---

## WASM Tables and Function Pointers (Future)

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
import {Memory, defaultAllocator} from 'zena:memory';

// GC object table for passing closures via userData
let gcTable: Table<Object> = new Table(100);

const execWithCallback = (db: Database, sql: string,
                          callback: (row: Row) => void): void => {
  let mem = Memory.default;

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

  // Allocate null-terminated SQL string
  if (let (true, sqlPtr) = defaultAllocator.alloc(sql.length + 1)) {
    for (var i = 0; i < sql.length; i = i + 1) {
      mem.setU8(sqlPtr + i, sql.byteAt(i));
    }
    mem.setU8(sqlPtr + sql.length, 0);  // Null terminator

    if (let (true, errPtr) = defaultAllocator.alloc(4)) {
      sqlite3_exec(db.handle, sqlPtr, trampolineIndex, closureIndex, errPtr);
      defaultAllocator.free(errPtr);
    }
    defaultAllocator.free(sqlPtr);
  }

  gcTable.remove(closureIndex);
};
```

````

### Callback Helper (Future)

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

// Usage with automatic cleanup (once `using` is implemented)
const sortArray = (arrPtr: i32, arrLen: i32): void => {
  using cmp = Callback.create((a: i32, b: i32): i32 => a - b);
  qsort(arrPtr, arrLen, 4, cmp.index);
};
````

---

## Advanced Topics (Future)

### Multiple Memories

The WASM multi-memory proposal allows modules to have multiple linear memories.
The current `Memory` class design supports this through instances:

```zena
// Memory can be extended to support multiple memories
final class Memory {
  static default: Memory = new Memory();  // Memory index 0

  // Future: import additional memories
  // @external("re2", "memory")
  // static declare let re2Memory: Memory;
}
```

**Current status**: Multi-memory is a proposal, not yet widely supported.
For MVP, we assume a single memory (index 0).

### Future: WASM Weak References

WASM GC has a post-MVP proposal for weak references. Once available, this could
enable automatic cleanup of linear memory:

```zena
// Future: automatic cleanup when GC object is collected
class LinearBuffer {
  #ptr: i32;

  #new(ptr: i32) {
    this.#ptr = ptr;
    // Register cleanup when this GC object dies
    __weak_ref_register(this, () => {
      defaultAllocator.free(ptr);
    });
  }
}
```

Until then, explicit lifetime management via manual `free()` calls is required.

---

## Implementation Status

### Completed ✓

- **Memory intrinsics**: All load/store intrinsics (i32, i64, f32, f64, u8)
- **memory.size, memory.grow**: Memory management intrinsics
- **Memory class**: Type-safe access with `@intrinsic` decorators
- **Allocator interface**: With multi-return for safe error handling
- **FreeListAllocator**: Default allocator with alloc/free support
- **BumpAllocator**: Arena-style allocator with reset()
- **defaultAllocator export**: Standard entry point for allocation

### Planned

1. **`using` Declaration**: Automatic cleanup syntax for linear memory lifetime
2. **LinearString**: String implementation backed by linear memory for zero-copy I/O
3. **Tables and Callbacks**: Function pointer support for C library integration
4. **Multi-memory support**: When WASM multi-memory is widely supported

---

## Open Questions

1. **`using` syntax**: Should we implement `using` declarations for automatic
   cleanup, or is manual `free()` sufficient?

2. **LinearString**: How should `LinearString` integrate with the current String
   implementation? Via inheritance or as a separate type?

3. **Table management**: Should tables auto-grow? How do we handle table indices
   becoming invalid after `remove()`?

4. **Async FFI**: How do we handle C libraries that use callbacks for async?
   Should we bridge to Zena's future async model?
