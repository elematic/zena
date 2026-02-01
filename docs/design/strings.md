# String Implementation Design

## Overview

Strings in Zena are immutable sequences of characters represented by a final
`String` class. There is no separate `string` primitive type—`String` is the
one and only string type in the language.

The `String` class wraps a `ByteArray` internally and tracks encoding metadata.
This design provides:

- **Encapsulation**: The backing `ByteArray` is private; users cannot mutate
  string contents.
- **Multi-encoding support**: Strings can be UTF-8 or UTF-16 encoded, making
  interop with JS hosts efficient.
- **Future extensibility**: The wrapper design allows for alternative
  implementations (ropes, host strings) later without changing the public API.

## String Class Design

```zena
final class String {
  #data: ByteArray;
  #encoding: i32;  // 0 = UTF-8, 1 = UTF-16

  // Length in bytes (not characters)
  byteLength: i32 {
    get() => this.#data.length;
  }

  // Length in code units (bytes for UTF-8, 2-byte units for UTF-16)
  length: i32 {
    get() {
      if (this.#encoding == 0) {
        return this.#data.length;
      } else {
        return this.#data.length / 2;
      }
    }
  }

  // Internal: get byte at index
  #getByteAt(index: i32): i32 => this.#data[index];

  // ... methods like substring, indexOf, etc.
}
```

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
;; String struct type
(type $String (struct
  (field $data (ref $ByteArray))  ;; Backing byte array
  (field $encoding i32)           ;; Encoding tag
))

;; ByteArray is the raw WASM GC array
(type $ByteArray (array (mut i8)))
```

The extra struct indirection (compared to using `ByteArray` directly) costs one
`struct.get` per field access. This is ~1 cycle and negligible for most
operations. For performance-critical code that builds strings incrementally,
use `StringBuilder`.

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

```zena
// Code unit operations (O(1) index calculation, matches JS)
substring(start: i32, end: i32): String
slice(start: i32, end?: i32): String

// Code point operations (O(n) to find boundaries, always well-formed output)
substringByCodePoint(start: i32, end: i32): String
```

**Code unit slicing** (`substring`, `slice`) operates on code unit indices and
can produce unpaired surrogates if you slice in the middle of a surrogate pair.
This matches JavaScript behavior:

```javascript
'😀'.substring(0, 1); // JS: lone high surrogate (length 1)
```

**Code point slicing** (`substringByCodePoint`) treats indices as code point
offsets, ensuring the result is always well-formed Unicode. This is O(n) to
find the byte offset but guarantees no broken surrogates.

**Recommendation**: For most text processing, use code-unit operations (fast,
familiar to JS developers). Use code-point operations when Unicode correctness
is critical and you're working with user-visible text boundaries.

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

## Future Considerations

- **Unicode Support**: Iterators will handle Unicode code points or grapheme
  clusters, abstracting over the underlying encoding.
- **Single Quotes**: Reserved for character literals (code points) in the
  future: `'A'` would be an `i32` code point, not a string.
- **Ropes**: For applications with heavy string manipulation (text editors),
  a rope-based `String` variant could be added. The public API remains
  unchanged.
- **Compile-Time Interning**: String literals could be interned at compile time
  by deduplicating identical literals in the data section.
- **Cached Hash Codes**: If hashing becomes a bottleneck, add an optional cached
  hash field (increases `String` size by 4 bytes).
