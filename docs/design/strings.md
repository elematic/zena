# String Implementation Design

## Overview

Strings in Zena are immutable sequences of characters represented by a final
`String` class. There is no separate `string` primitive type—`String` is the
one and only string type in the language.

The `String` class uses a **view-based design** (similar to Go): every string
is a view into a backing `ByteArray`, with `#start` and `#end` offsets. This
enables **O(1) zero-copy slicing** while maintaining a single `String` type.

This design provides:

- **Encapsulation**: The backing `ByteArray` is private; users cannot mutate
  string contents.
- **Zero-copy slicing**: `slice()` returns a new `String` that shares the
  backing array—no allocation or copying required.
- **Multi-encoding support**: Strings can be UTF-8 or UTF-16 encoded, making
  interop with JS hosts efficient.
- **Single type**: No separate `StringSlice` or `StringView` type. Just `String`.
- **Future extensibility**: The wrapper design allows for alternative
  implementations (ropes, host strings) later without changing the public API.

## String Class Design

```zena
final class String {
  #data: ByteArray;    // Backing storage (may be shared with other Strings)
  #start: i32;         // Start offset into #data (inclusive)
  #end: i32;           // End offset into #data (exclusive)
  #encoding: i32;      // 0 = WTF-8, 1 = WTF-16

  // Length in code units (bytes for WTF-8, 2-byte units for WTF-16)
  length: i32 {
    get {
      if (this.#encoding == 0) {
        return this.#end - this.#start;
      } else {
        return (this.#end - this.#start) / 2;
      }
    }
  }

  // Length in bytes
  byteLength: i32 {
    get => this.#end - this.#start;
  }

  // Get byte at index (relative to this view)
  getByteAt(index: i32): i32 {
    return this.#data[this.#start + index];
  }

  // O(1) zero-copy slice - returns a new String sharing the backing array
  slice(start: i32, end: i32): String {
    return new String(
      this.#data,
      this.#start + start,
      this.#start + end,
      this.#encoding
    );
  }

  // Force a copy - use when you need to release the parent string's memory
  copy(): String {
    let len = this.#end - this.#start;
    let newData = new ByteArray(len);
    // Copy bytes from this view to new array
    __byte_array_copy(newData, 0, this.#data, this.#start, len);
    return new String(newData, 0, len, this.#encoding);
  }
}
```

### Memory Sharing

Slicing creates a new `String` that shares the backing `ByteArray`:

```zena
let json = readFile("data.json");   // String: #start=0, #end=10000
let key = json.slice(100, 110);     // String: shares #data, #start=100, #end=110
let owned = key.copy();             // New String: owns its own ByteArray
```

**Memory retention**: A slice keeps its parent's backing array alive. A 10-byte
slice of a 10MB string retains 10MB until the slice is garbage collected. Use
`copy()` when you need to release the parent string's memory:

```zena
// Parser example: copy extracted values to release input
let parse = (input: String): array<String> => {
  var results = #[];
  // ... parsing logic ...
  // Copy string values to release input buffer
  results.push(extractedValue.copy());
  return results;
};
```

This is the same tradeoff Go makes with its `string` type, and it works well
in practice. For most use cases, the memory sharing is beneficial (fast slicing,
no allocation). When memory is a concern, `copy()` makes ownership explicit.

### Encoding

Strings track their encoding at runtime via a tag field:

| Tag | Encoding | Code Unit Size | Use Case                                   |
| --- | -------- | -------------- | ------------------------------------------ |
| 0   | WTF-8    | 1 byte         | Default, compact for ASCII-heavy text      |
| 1   | WTF-16   | 2 bytes        | JS interop, direct copy to/from JS strings |

**WTF-8 and WTF-16**: We use the "Wobbly Transformation Format" variants that
allow unpaired surrogates. This is necessary for lossless round-tripping with
JavaScript, which uses WTF-16 internally. Valid UTF-8/UTF-16 is a subset of
WTF-8/WTF-16, so well-formed strings work identically.

**When do unpaired surrogates occur?**

- Receiving a string from JS that contains them
- Slicing a UTF-16 string at a code unit boundary that splits a surrogate pair

Strings that originate entirely from Zena (literals, concatenation) are always
well-formed UTF. Unpaired surrogates only arise from JS interop or careless
slicing.

**Compiler flag**: A compiler flag (`--default-encoding=wtf8|wtf16`) controls
the encoding used for string literals. Default is WTF-8.

**Mixed encodings**: Strings of different encodings can coexist at runtime.
Operations that combine strings (e.g., concatenation) will normalize to a
common encoding—typically the encoding of the left operand, or UTF-8 if both
differ.

### WASM Representation

```wat
;; String struct type (view-based)
(type $String (struct
  (field $data (ref $ByteArray))  ;; Backing byte array (may be shared)
  (field $start i32)              ;; Start offset (inclusive)
  (field $end i32)                ;; End offset (exclusive)
  (field $encoding i32)           ;; Encoding tag
))

;; ByteArray is the raw WASM GC array
(type $ByteArray (array (mut i8)))
```

The view-based design adds 8 bytes per string (start + end fields). This is a
small cost for O(1) slicing. The extra `struct.get` for offset calculation is
~1 cycle and negligible.

## StringBuilder

For efficient string construction without repeated allocations:

```zena
class StringBuilder {
  #buffer: ByteArray;
  #length: i32;
  #encoding: i32;

  #new(capacity: i32 = 16, encoding: i32 = 0) {
    this.#buffer = new ByteArray(capacity);
    this.#length = 0;
    this.#encoding = encoding;
  }

  append(s: String): StringBuilder { /* ... */ }
  appendByte(b: i32): StringBuilder { /* ... */ }
  toString(): String { /* ... */ }
  clear(): void { /* ... */ }
}
```

Use `StringBuilder` when concatenating many strings in a loop. For simple
`a + b + c` expressions, the compiler-generated concatenation is fine.

## Literals

String literals are stored in the WASM **Data Section**.

1.  **Compilation**: The compiler encodes the literal in the default encoding
    (controlled by `--default-encoding`) and adds the bytes to a passive data
    segment.
2.  **Runtime**: A `String` object is created wrapping a `ByteArray` initialized
    from the data segment using `array.new_data`.
3.  **Interning**:
    - **Current**: Strings are **not interned** at runtime. Evaluating the same
      literal multiple times creates distinct `String` objects.
    - **Planned**: Runtime string interning for literals to enable fast
      reference equality.

## Operations

### Concatenation (`+`)

The `+` operator is overloaded on `String`. Implementation:

1.  If encodings differ, transcode the right operand to match the left.
2.  Allocate a new `ByteArray` of combined length.
3.  Copy bytes from both strings using `array.copy`.
4.  Return a new `String` wrapping the result.

For building many strings, prefer `StringBuilder`.

### Equality (`==`, `!=`)

Value equality via `operator ==`:

1.  Reference equality fast path.
2.  If encodings differ, normalize before comparing (or compare semantically).
3.  Compare byte-by-byte.

**Optimization**: With string interning, literal comparisons become reference
comparisons.

### Hashing

The `hash` intrinsic computes a hash over the string's bytes. The hash is
computed on demand (not cached) to keep `String` objects small. If profiling
shows hashing is a bottleneck, we can add optional caching.

### Indexing & Iteration

- **Indexed Access**: Direct indexed access (`str[i]`) is **disallowed** to
  avoid encoding-dependent semantics.
- **Byte Access**: `str.byteAt(i)` returns the byte at index `i`.
- **Iteration**: `for (c in str)` iterates over Unicode code points (decoding
  from the underlying encoding). Requires iterator support.

### Substring Operations

With the view-based design, slicing is O(1) and zero-copy:

```zena
// O(1) zero-copy slice - returns String sharing backing array
slice(start: i32, end: i32): String

// Convenience: slice from start to end of string
slice(start: i32): String  // equivalent to slice(start, length)

// Force a copy - releases reference to parent's backing array
copy(): String

// Substring is an alias for slice().copy() - always copies
substring(start: i32, end: i32): String
```

**Recommended usage**:

- Use `slice()` for parsing and intermediate operations (zero-copy, fast)
- Use `copy()` when you need to release the parent string's memory
- Use `substring()` when you want a copied substring in one call

**Code unit indices**: All slice operations use code unit indices (bytes for
WTF-8, 2-byte units for WTF-16). Slicing in the middle of a multi-byte
character or surrogate pair can produce invalid sequences. This matches
JavaScript behavior.

```zena
// Code point operations (O(n) to find boundaries, always well-formed output)
sliceByCodePoint(start: i32, end: i32): String
```

**Code point slicing** treats indices as code point offsets, ensuring the
result is always well-formed Unicode. This is O(n) to find the byte offset
but guarantees no broken surrogates.

### Length

- `str.length`: Length in **code units** (bytes for UTF-8, 2-byte units for
  UTF-16). This matches JavaScript's `length` for UTF-16 strings.
- `str.byteLength`: Length in **bytes**.
- `str.codePointCount()`: Count of Unicode code points (O(n), requires decoding).

**Rationale for code units**: Using code units (rather than raw bytes) ensures
that ASCII-only strings have stable length regardless of encoding:
`"hello".length === 5` whether the string is UTF-8 or UTF-16. This is less
surprising for common cases. Non-ASCII strings have encoding-dependent lengths,
but this matches JavaScript behavior and is unavoidable without O(n) decoding.

| String    | UTF-8 `length` | UTF-16 `length` | Code Points |
| --------- | -------------- | --------------- | ----------- |
| `"hello"` | 5              | 5               | 5           |
| `"héllo"` | 6              | 5               | 5           |
| `"😀"`    | 4              | 2               | 1           |

## JS Host Interop

When running in a JS host:

- **WTF-16 strings** can be passed to/from JS with zero-copy (if the host
  exposes raw string buffers via `stringref` or typed arrays).
- **WTF-8 strings** require transcoding when crossing the boundary.
- **Unpaired surrogates** in JS strings are preserved during import/export,
  ensuring lossless round-tripping.

Using `--default-encoding=wtf16` is recommended for JS-heavy applications to
minimize transcoding overhead.

### Future: Host Strings

A future `HostString` implementation could wrap a JS string reference directly,
avoiding any copying for strings that originate from JS and are only passed
back to JS.

## Unified String Architecture

### Design Principle

From the user's perspective, there is **one `String` type**. Internally, `String`
is an abstract class with multiple final implementations optimized for different
backing stores. This mirrors JavaScript's approach, where V8 internally has
SeqString, ConsString, SlicedString, ExternalString, etc., but users only see
`string`.

### Internal Implementations

```zena
// String is an abstract class (not exported by default)
abstract class String {
  abstract get length(): i32;
  abstract byteAt(index: i32): i32;

  // All methods implemented once, using abstract primitives
  indexOf(needle: String): i32 { ... }
  startsWith(prefix: String): boolean { ... }
  slice(start: i32, end: i32): String { ... }
  operator +(other: String): String { ... }
  // ... 30+ methods, implemented once
}

// GC-backed string (default for literals, concatenation)
final class GCString extends String {
  #data: ByteArray;
  #start: i32;
  #end: i32;
  #encoding: i32;

  byteAt(index: i32): i32 {
    return this.#data[this.#start + index];
  }
}

// Linear memory-backed string (for WASI I/O, FFI)
final class LinearString extends String {
  #ptr: i32;
  #len: i32;
  #encoding: i32;

  @intrinsic('i32.load8_u')
  declare byteAt(index: i32): i32;
}

// Host-backed string (for JS/DOM interop)
final class HostString extends String {
  #handle: externref;

  @external("host", "stringByteAt")
  declare byteAt(index: i32): i32;
}

// Rope string (for efficient concatenation in text editors)
final class RopeString extends String {
  #left: String;
  #right: String;

  byteAt(index: i32): i32 {
    if (index < this.#left.length) return this.#left.byteAt(index);
    return this.#right.byteAt(index - this.#left.length);
  }
}

// Literal string (backed by WASM data segment, no GC allocation)
final class LiteralString extends String {
  #dataOffset: i32;  // Offset into WASM data segment
  #len: i32;

  @intrinsic('i32.load8_u')
  declare byteAt(index: i32): i32;
}
```

### User-Facing API

Users interact only with `String`:

```zena
let a: String = "hello";              // LiteralString or GCString
let b: String = a.slice(0, 3);        // View (shares backing)
let c: String = a + b;                // GCString (or RopeString)
let d: String = File.read(path);      // LinearString from WASI
let e: String = element.textContent;  // HostString from DOM

// All work the same way
func process(s: String): void { ... }
process(a); process(b); process(c); process(d); process(e);
```

### Performance Considerations

**Virtual Dispatch**: Method calls on `String` are virtual calls since the
concrete type is unknown at compile time.

**Code Sharing Strategy**: The abstract `String` class uses the **template method
pattern** - shared algorithms are implemented once on the base class, calling
abstract primitives (`byteAt`, etc.) that each subclass implements. This is
different from mixins:

| Approach                  | Code Duplication           | Internal Call Overhead                    |
| ------------------------- | -------------------------- | ----------------------------------------- |
| Template method (current) | None - shared code in base | Virtual dispatch for primitives           |
| Mixins                    | Full duplication per class | Direct calls (monomorphized)              |
| Swappable backing store   | None                       | Virtual dispatch for every backing access |

We chose template method because:

1. **Minimal binary bloat**: ~30 String methods × ~5 implementations = code shared
2. **Hot path optimization**: The abstract primitives (`byteAt`, `length`) are tiny,
   so virtual call overhead is amortized over the algorithm's work
3. **Devirtualization**: When concrete type is known, the entire call chain devirtualizes

**The internal polymorphism concern**: Yes, `indexOf` calling `this.byteAt()` is a
virtual call. But this is acceptable because:

- Most string algorithms are O(n), so one vtable lookup per byte is negligible
- JIT inline caching makes repeated calls to the same concrete type fast
- When the caller knows the concrete type, the JIT can specialize the entire method

**Devirtualization**: The compiler can eliminate virtual dispatch when:

1. **Single implementation**: If a program doesn't use `LinearString` or
   `HostString`, only `GCString` exists → all calls devirtualize.
2. **Known concrete type**: After `new GCString(...)` or type narrowing with
   `is`, calls devirtualize.
3. **JIT optimization**: WASM JITs use inline caching for monomorphic call sites.

**Escape hatch**: For performance-critical code, concrete types can be imported:

```zena
// Standard import - just String
import {String} from 'zena:core';

// Performance import - concrete types available
import {LinearString, GCString} from 'zena:core/internal';

func processIO(s: LinearString): void {
  s.indexOf("x");  // Direct call, guaranteed no virtual dispatch
}
```

See [optimizations.md](optimizations.md) for the complete devirtualization strategy.

## Future Considerations

- **Unicode Support**: Iterators will handle Unicode code points or grapheme
  clusters, abstracting over the underlying encoding.
- **Single Quotes**: Reserved for character literals (code points) in the
  future: `'A'` would be an `i32` code point, not a string.
- **Compile-Time Interning**: String literals could be interned at compile time
  by deduplicating identical literals in the data section.
- **Cached Hash Codes**: If hashing becomes a bottleneck, add an optional cached
  hash field (increases `String` size by 4 bytes).

## Summary: Operation Costs

| Operation             | Time | Allocates?               | Shares Memory? |
| --------------------- | ---- | ------------------------ | -------------- |
| `str.slice(a, b)`     | O(1) | Yes (String struct only) | Yes            |
| `str.copy()`          | O(n) | Yes (ByteArray + String) | No             |
| `str.substring(a, b)` | O(n) | Yes (ByteArray + String) | No             |
| `str + other`         | O(n) | Yes (ByteArray + String) | No             |
| `str == other`        | O(n) | No                       | N/A            |
| `str.length`          | O(1) | No                       | N/A            |
| `str.getByteAt(i)`    | O(1) | No                       | N/A            |
