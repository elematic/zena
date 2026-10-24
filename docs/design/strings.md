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
export opaque type StringIndex = i32;

export final class String implements Iterable<String>, Hashable {
  #data: ByteArray;    // Backing storage (may be shared with other Strings)
  #start: i32;         // Start offset into #data (inclusive)
  #end: i32;           // End offset into #data (exclusive)
  #encoding: Encoding; // WTF8 or WTF16

  isEmpty: boolean { get => this.#end == this.#start; }

  startIndex: StringIndex { get => 0 as StringIndex; }
  endIndex: StringIndex { get => (this.#end - this.#start) as StringIndex; }

  // Grapheme cluster at `index` as a zero-copy String slice
  operator [](index: StringIndex): String {
    let next = this.indexAfter(index);
    return this.slice(index, next);
  }

  // Zero-copy slice between two validated StringIndex boundaries
  operator [](r: Range<StringIndex>): String {
    let (start, end) = r.bounds(this.endIndex);
    return this.slice(start, end);
  }

  // Force a copy - use when you need to release the parent string's memory
  copy(): String {
    let len = this.#end - this.#start;
    let newData = __byte_array_new(len);
    __byte_array_copy(newData, 0, this.#data, this.#start, len);
    return new String.#fromBytes(newData, 0, len, this.#encoding);
  }
}
```

### Memory Sharing

Slicing creates a new `String` that shares the backing `ByteArray`:

```zena
let json = readFile("data.json");        // String: #start=0, #end=10000
let key = json[start..end];              // String: shares #data, #start=100, #end=110
let owned = key.copy();                  // New String: owns its own ByteArray
```

**Memory retention**: A slice keeps its parent's backing array alive. A 10-byte
slice of a 10MB string retains 10MB until the slice is garbage collected. Use
`copy()` when you need to release the parent string's memory:

```zena
// Parser example: copy extracted values to release input
let parse = (input: String): array<String> => {
  var results = [];
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
- Slicing a string at an unvalidated byte offset with the deprecated
  `sliceBytes`

Strings that originate entirely from Zena (literals, concatenation, and
`StringIndex` slices) preserve scalar boundaries.

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
import {StringBuilder} from 'zena:string-builder';

final class StringBuilder {
  new(capacity: i32 = 16);

  length: i32 { get; }      // Current length in bytes
  capacity: i32 { get; }    // Total allocated capacity

  append(s: String): StringBuilder;
  appendByte(b: i32): StringBuilder;
  toString(): String;
  clear(): void;
}
```

**Implementation**: Uses a rope/chunked approach with a list of `ByteArray`
chunks that grow as needed (doubling strategy). When appending a string that
fits in the current chunk, bytes are copied directly without intermediate
allocation. For strings spanning chunks, `copyBytesTo` with offset parameters
avoids creating slice objects.

**Status**: ✅ Implemented in `zena:string-builder`

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

### Indexing, Views, and Iteration

Raw integer indexing (`str[0]`) is rejected at compile time so user code cannot
accidentally split a multi-byte UTF-8 sequence or surrogate pair. Instead,
`String` is indexed by `StringIndex`:

```zena
export opaque type StringIndex = i32;
```

Outside `zena:core`, `StringIndex` is opaque (`0 as StringIndex` is a compile
error), and every `StringIndex` produced by `String` is guaranteed to lie on a
valid Unicode scalar boundary of the string's own encoding. At runtime,
`StringIndex` erases to an unboxed `i32`: an offset in that encoding, which
is why `String` exposes no byte-level API of its own. The bytes belong to the
views, `str.utf8` and `str.utf16`, and each view maps its own offsets back to
`StringIndex` with `indexAt`.

#### Navigation

- `str.startIndex: StringIndex` — index of the first character (`0`).
- `str.endIndex: StringIndex` — "past the end" index.
- `str.indexAfter(i: StringIndex): StringIndex` — next extended grapheme
  cluster boundary after `i`.
- `str.indexBefore(i: StringIndex): StringIndex` — previous extended grapheme
  cluster boundary before `i`.
- `str.scalarIndexAfter(i: StringIndex): StringIndex` — next Unicode scalar
  (code point) boundary after `i`.
- `str.scalarIndexBefore(i: StringIndex): StringIndex` — previous Unicode
  scalar boundary before `i`.
- `str.indexOffsetBy(from: StringIndex, count: i32): inline (true, StringIndex) | inline (false, _)` —
  advances `from` by `count` grapheme clusters (or steps backward when
  `count < 0`), returning `(false, _)` if stepping moves past the string bounds.
- `str.utf8.indexAt(offset: i32): inline (true, StringIndex) | inline (false, _)` —
  the string's index for a UTF-8 offset into the view, when the offset is in
  `[0, length]` and on a scalar boundary (not a continuation byte
  `0b10xxxxxx`). $O(1)$ when the view shares the string's storage (a WTF-8
  string); for a WTF-16 string it counts the code units of the scalars before
  the offset. `str.utf16.indexAt` is the same for code unit offsets, rejecting
  an offset that splits a surrogate pair, $O(1)$ for a WTF-16 string. A
  sub-view from `slice` maps offsets relative to itself, so an index found in
  a sub-view still indexes the whole string.

#### Table-Free Grapheme Cluster Segmentation

Full UAX #29 `Grapheme_Cluster_Break` property lookup tables require 30–100 KB
of static data, which would bloat small WebAssembly binaries. Instead,
`indexAfter` and `indexBefore` use a table-free arithmetic boundary rule (~8
contiguous Unicode block checks with zero static tables):

1. **ASCII fast path**: If two adjacent bytes are `< 0x80` and not `\r\n`, break
   immediately in 1 byte read.
2. **CRLF**: Do not break between `\r` (`0x0D`) and `\n` (`0x0A`).
3. **Controls**: Break before and after control characters (`< 0x20`, `0x7F..0x9F`).
4. **Hangul Jamo**: Conjoin leading (`L`, `0x1100..0x115F`, `0xA960..0xA97C`),
   vowel (`V`, `0x1160..0x11A7`, `0xD7B0..0xD7C6`), trailing (`T`,
   `0x11A8..0x11FF`, `0xD7CB..0xD7FB`), and precomposed `LV` / `LVT` syllables
   (`0xAC00..0xD7A3`) arithmetically via `(cp - 0xAC00) % 28`.
5. **Combining marks, variation selectors, and emoji modifiers**: Do not break
   before a code point in:
   - Combining Diacritical Marks (`0x0300..0x036F`, `0x1AB0..0x1AFF`,
     `0x1DC0..0x1DFF`, `0x20D0..0x20FF`, `0xFE20..0xFE2F`)
   - Zero-Width Joiner (`0x200D`) and Zero-Width Non-Joiner (`0x200C`)
   - Variation Selectors (`0xFE00..0xFE0F`, `0xE0100..0xE01EF`) and Keycap
     (`0x20E3`)
   - Emoji skin-tone modifiers (`0x1F3FB..0x1F3FF`)
   - Tag characters for subdivision flags (`0xE0020..0xE007F`)
6. **ZWJ sequences**: Do not break immediately after `U+200D` (Zero-Width
   Joiner), keeping sequences like `👨‍👩‍👧‍👦` and `🏳️‍🌈` intact.
7. **Regional Indicator pairs**: Country flag sequences (`0x1F1E6..0x1F1FF`)
   pair in groups of two by counting contiguous Regional Indicators backward to
   the start of the run.

#### Default Iteration and Views

- **`for (let g in str)`** and **`str.graphemes`** (`StringGraphemes`):
  `String` implements `Iterable<String>`, yielding each extended grapheme
  cluster as a zero-copy `String` slice. `str.reverse(): String` reverses a
  string by grapheme clusters so combining marks and multi-code-point emojis
  stay intact.
- **`str.codePoints`** (`StringCodePoints`): Zero-allocation extension view
  implementing `Iterable<i32>`, yielding decoded Unicode scalar values (`0..0x10FFFF`).
- **`str.utf8`** (`StringUtf8View`): Contiguous UTF-8 / WTF-8 byte view
  implementing `Iterable<u8>`, with $O(1)$ `length`, `utf8[i]: u8`,
  `utf8.slice(start, end)`, `utf8.copyTo(...)`, and `utf8.toArray(): FixedArray<u8>`.
  When `str.encoding == Encoding.WTF8`, `str.utf8` shares the string's backing
  `ByteArray` without copying; when `str.encoding == Encoding.WTF16` (including
  on `--target js`), it transcodes to a UTF-8 `ByteArray`.
- **`str.utf16`** (`StringUtf16View`): Contiguous UTF-16 / WTF-16 code unit view
  implementing `Iterable<u16>`, with $O(1)$ `length`, `utf16[i]: u16`,
  `utf16.slice(start, end)`, and `utf16.toArray(): FixedArray<u16>`. When
  `str.encoding == Encoding.WTF16` (or on `--target js`), `str.utf16` reads the
  backing storage directly without copying; when `str.encoding == Encoding.WTF8`,
  it transcodes to a UTF-16 buffer.

### Substring and Range Operations

Range literals constructed with `StringIndex` endpoints produce `Range<StringIndex>`
values (`BoundedRange<StringIndex>`, `FromRange<StringIndex>`, `ToRange<StringIndex>`), and `..`
produces `FullRange`. Indexing a string with a `StringIndex` or range returns a
zero-copy `String` slice:

```zena
let s = "café😀";
let first = s[s.startIndex];       // "c"
let rest = s[s.indexAfter(s.startIndex)..]; // "afé😀"
let full = s[..];                  // "café😀"

if (let (true, pos) = s.indexOf("é")) {
  let prefix = s[..pos];           // "caf"
  let suffix = s[pos..];           // "é😀"
}
```

`String` has no byte-level operations of its own, because what bytes a
string has depends on its encoding: a WTF-8 and a WTF-16 string of the same
text differ in length and in every offset. Byte-level work goes through a
view, `str.utf8` or `str.utf16`, which reads one encoding whatever the
string's own; `view[i]` reads a unit, `view.slice(start, end)` narrows the
view, and `view.indexAt(offset)` turns a view offset on a scalar boundary into
the `StringIndex` that slices the string (`str[a..b]`).

The older byte-oriented names on `String` (`length`, `getByteAt`,
`sliceBytes`, and `codePointAt(index: i32)`) read the string's own encoding
and are marked `@deprecated` in favor of `isEmpty`, `graphemes.count()`,
`codePoints.count()`, the views, and `codePointAt(index: StringIndex)`.

### Length

- `str.isEmpty: boolean` — `O(1)` check for an empty string.
- `str.utf8.length: i32` — length in UTF-8 bytes (`O(1)` on `StringUtf8View`).
- `str.utf16.length: i32` — length in UTF-16 code units (`O(1)` on `StringUtf16View`).
- `str.graphemes.count(): i32` — `O(n)` count of extended grapheme clusters.
- `str.codePoints.count(): i32` — `O(n)` count of Unicode scalar values.
- `str.length: i32` (_deprecated_) — length in the string's own encoding.

| String         | `utf8.length` | `utf16.length` | `codePoints.count()` | `graphemes.count()` |
| -------------- | ------------- | -------------- | -------------------- | ------------------- |
| `"hello"`      | 5             | 5              | 5                    | 5                   |
| `"café"`       | 5             | 4              | 4                    | 4                   |
| `"cafe\u0301"` | 6             | 5              | 5                    | 4                   |
| `"😀"`         | 4             | 2              | 1                    | 1                   |
| `"👨‍👩‍👧"`         | 18            | 8              | 5                    | 1                   |

## JS Host Interop

When running in a JS host:

- **WTF-16 strings** can be passed to/from JS with zero-copy (if the host
  exposes raw string buffers via `stringref` or typed arrays).
- **WTF-8 strings** require transcoding when crossing the boundary.
- **Unpaired surrogates** in JS strings are preserved during import/export,
  ensuring lossless round-tripping.

Using `--default-encoding=wtf16` is recommended for JS-heavy applications to
minimize transcoding overhead.

### Host strings

Zena distinguishes between two strategies for host string interop (detailed in [host-interop.md](host-interop.md)):

1. **Universal modules**: A `HostString` subclass of `String` wraps an `externref` to avoid transcoding when JavaScript strings are passed through WebAssembly to other JavaScript APIs. If character access is needed and `wasm:js-string` is unavailable, it delegates to a host helper or lazily transcodes to a `ByteArray`.
2. **JavaScript-targeted modules (`--target js`)**: The module assumes a JavaScript host. `String` remains a normal WebAssembly GC class backed directly by an `externref` handle, using the `wasm:js-string` proposal builtins and imported string constants for zero-copy operations and minimal binary size.

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

- **Batch Transcoding for Shared Backing Buffers**: If a program creates
  transcoded views (`.utf8` on WTF-16 strings or `.utf16` on WTF-8 strings) for
  many string slices that share the same backing `ByteArray`, transcoding each
  slice individually may do redundant work or allocate many small buffers. We
  can explore a batch transcoding API that transcodes the shared backing buffer
  once (or integrates with `StringBuilder` / `ByteBuffer`).
- **Single Quotes**: Reserved for character literals (code points) in the
  future: `'A'` would be an `i32` code point, not a string.
- **Compile-Time Interning**: String literals could be interned at compile time
  by deduplicating identical literals in the data section.
- **Cached Hash Codes**: If hashing becomes a bottleneck, add an optional cached
  hash field (increases `String` size by 4 bytes).

## Summary: Operation Costs

| Operation                              | Time | Allocates?                    | Shares Memory? |
| -------------------------------------- | ---- | ----------------------------- | -------------- |
| `str[start..end]` / `slice`            | O(1) | Yes (String struct only)      | Yes            |
| `str[i]`                               | O(1) | Yes (String struct only)      | Yes            |
| `str.copy()`                           | O(n) | Yes (ByteArray + String)      | No             |
| `str.reverse()`                        | O(n) | Yes (ByteArray + String)      | No             |
| `str + other`                          | O(n) | Yes (ByteArray + String)      | No             |
| `str == other`                         | O(n) | No                            | N/A            |
| `str.isEmpty`                          | O(1) | No                            | N/A            |
| `str.utf8` / `str.utf16` (same enc)    | O(1) | Yes (View struct only)        | Yes            |
| `str.utf8` / `str.utf16` (transcoded)  | O(n) | Yes (ByteArray + View struct) | No             |
| `utf8[i]` / `utf16[i]` / `view.length` | O(1) | No                            | N/A            |
| `view.indexAt(i)` (same enc)           | O(1) | No                            | N/A            |
| `view.indexAt(i)` (transcoded)         | O(n) | No                            | N/A            |
| `str.graphemes.count()`                | O(n) | No                            | N/A            |
| `str.codePoints.count()`               | O(n) | No                            | N/A            |
