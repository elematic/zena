# String Implementation Design

## Overview

Strings in Zena are immutable sequences of characters. The design supports
multiple implementations to optimize for different use cases:

- **Native UTF-8 strings**: Default implementation using WASM GC arrays
- **Host strings**: Zero-copy interop with JS/Java strings
- **Different encodings**: Compiler flags for UTF-16/WTF-16

## Current Implementation Status

### What's Done

- ✅ String literals stored in WASM data section (`array.new_data`)
- ✅ `String` extension class on `ByteArray` with `length` and `getByteAt`
- ✅ `string` keyword aliases to the `String` class
- ✅ Concatenation via `+` operator (runtime helper function)
- ✅ Value equality via `==`/`!=` (byte-by-byte comparison with fast path)
- ✅ FNV-1a hashing for `Map`/`Set` usage
- ✅ Length via `array.len` instruction

### What's Planned (see Incremental Plan below)

- Consolidate `string` type and `String` class into a single unified `String`
- Move `operator +` to the `String` class
- Compile-time string interning for literals
- Host string implementation for zero-copy interop
- Disallow indexed byte access (enforce encoding independence)
- String methods similar to JS (`substring`, `indexOf`, etc.)
- Iterator support for Unicode character iteration

## Architecture

### Type Hierarchy

**Decision**: `String` is a **final class** wrapping `ByteArray`.

```zena
final class String {
  #data: ByteArray;

  #new(data: ByteArray) {
    this.#data = data;
  }

  length: i32 { get { return this.#data.length; } }

  operator +(other: String): String { ... }
}
```

**Rationale**:

- Simple and zero overhead for the common case (native UTF-8 strings)
- Provides a place to add methods (`substring`, `indexOf`, etc.) and operators
- Can migrate to interface later if host string support requires it
- Avoids virtual dispatch overhead for all string operations

**Alternatives considered**:

1. Interface-based - deferred until we need multiple implementations
2. Sealed class with tag - too complex for current needs
3. Extension class (current) - doesn't provide a place for `operator +`

### WASM Representation

**Native String (Phase 1)**:

- WASM Type: struct containing `(ref $byteArray)`
- Internal field: `#data: ByteArray` (UTF-8 encoded)
- The ByteArray is mutable at the WASM level for efficient construction, but
  semantically immutable to user code.

**Future Host String (Phase 5+)**:

- May require migrating `String` to an interface
- WASM Type: `externref` wrapping a JS string
- Lazy conversion to native when iterating or accessing bytes

## Literals

String literals are stored in the WASM **Data Section**.

1. **Compilation**: The compiler adds UTF-8 bytes to a passive data segment.
2. **Runtime**: `array.new_data` allocates and initializes from the segment.
3. **Interning**:
   - **Current**: Compile-time deduplication (same literal text shares one data
     segment), but each evaluation creates a new array instance.
   - **Planned**: Global intern table mapping data segment index to string
     instance. First access creates the string; subsequent accesses return the
     cached instance.

### Interning Strategy

```
// Pseudocode for interned string access
global $string_intern_table: (array (ref null $string))

func $get_interned_string(data_index: i32) -> (ref $string):
  let cached = $string_intern_table[data_index]
  if cached != null:
    return cached
  let new_string = array.new_data $string_type $data_index 0 len
  $string_intern_table[data_index] = new_string
  return new_string
```

## Operations

### Concatenation (`+`)

Currently implemented via a runtime helper. Will move to `operator +` on the
`String` class:

```zena
class String {
  operator +(other: String): String {
    // Implementation
  }
}
```

### Equality (`==`, `!=`)

Value equality with fast path for reference equality:

1. `ref.eq` for reference comparison (fast path, catches interned strings)
2. Length comparison
3. Byte-by-byte comparison

### Hashing

FNV-1a hash computed on demand. Future optimization: cache hash code in a
wrapper struct if we move away from bare `ByteArray`.

### Indexing

**Indexed byte access (`str[i]`) is disallowed** to support changing encodings
without breaking programs. The `getByteAt` method is internal/unsafe.

To access characters, use:

- `str.charAt(i)` - returns the i-th Unicode code point (future)
- Iterator - iterate over Unicode characters (future)

### Length

`str.length` returns the byte length for native strings. For Unicode character
count, use `str.charCount()` (future).

## Incremental Implementation Plan

### Phase 1: String Class Consolidation

Convert `String` from extension class to regular class while maintaining
backward compatibility.

**Tasks:**

1. **Create `String` as a regular final class wrapping `ByteArray`**
   - Add internal `#data: ByteArray` field
   - Implement `length` getter delegating to `#data.length`
   - Add `#new(data: ByteArray)` constructor

2. **Add `operator +` to String class**
   - Move concatenation logic into the class
   - Codegen calls `operator +` method instead of helper function

3. **Update checker to unify `string` and `String`**
   - `string` keyword resolves to the `String` class type
   - String literals have type `String` (not `ByteArray`)

4. **Update codegen for new String representation**
   - String literals create `String` instances (wrapping the ByteArray)
   - Update equality, hashing to work with wrapped type

**Considerations:**

- Breaking change for code using `ByteArray` directly for strings
- Need to update tests and potentially the prelude

### Phase 2: Compile-Time String Interning

**Tasks:**

1. **Add global intern table in codegen**
   - Array of nullable string references, sized by number of unique literals
   - Initialize to nulls in start function

2. **Generate interning wrapper for string literals**
   - Replace direct `array.new_data` with call to intern helper
   - Helper checks table, creates if needed, returns cached

3. **Optimize equality for interned strings**
   - Add fast path: if both refs equal, return true immediately
   - Already implemented, will automatically benefit from interning

### Phase 3: String Methods

Add JavaScript-like string methods:

1. `substring(start: i32, end?: i32): String`
2. `indexOf(search: String, start?: i32): i32`
3. `startsWith(prefix: String): boolean`
4. `endsWith(suffix: String): boolean`
5. `trim(): String`
6. `split(separator: String): Array<String>`
7. `replace(search: String, replacement: String): String`
8. `toUpperCase(): String` / `toLowerCase(): String`

### Phase 4: Disallow Indexed Access

**Tasks:**

1. **Remove `getByteAt` from public API** (or mark as unsafe/internal)
2. **Add checker error for `str[i]` syntax on strings**
3. **Add `charAt(i: i32): i32` for code point access**

### Phase 5: Host String Support (Future)

**Tasks:**

1. **Define `HostString` class wrapping `externref`**
2. **Add compiler flag for default string type**
3. **Implement lazy conversion between native and host strings**
4. **Update string operations to handle both types**

### Phase 6: Iterator Support (Future)

**Tasks:**

1. **Implement `Iterable<i32>` interface for String** (yields code points)
2. **Add `chars(): Iterator<i32>` method**
3. **Add `bytes(): Iterator<i32>` method** (for when you really need bytes)
4. **Support `for..of` loops over strings**

## Open Questions

1. **How to handle encoding in length?**
   - `length` returns byte count (current) or character count?
   - Recommendation: `length` = byte count, `charCount()` = Unicode count

2. **Should we cache hash codes?**
   - Now that String is a wrapper struct, we could add a cached hash field
   - Worth it if strings are frequently used as map keys
   - Could be lazy: compute on first `hashCode()` call

3. **Backward compatibility with `ByteArray`?**
   - Code using `string` should work unchanged
   - Code explicitly using `ByteArray` for strings may need updates

4. **What to do with surrogate codepoints from JS strings?**
   - JS strings are WTF-16, not UTF-16 (can contain unpaired surrogates)
   - Options: validate eagerly, replace with U+FFFD, or pass through
   - See "WTF-16 and Surrogates" section below

## Background: The WASM String Landscape

This section summarizes key insights from Andy Wingo's article
["Requiem for a Stringref"](https://wingolog.org/archives/2023/10/19/requiem-for-a-stringref)
(October 2023), which provides excellent context for string design in WASM.

### The Core Problem

Languages compiled to WASM need strings, but WASM only provides primitives
(arrays, structs). Each language has different string semantics:

- **Java/JS**: UTF-16 code units, O(1) access to 16-bit units
- **Python**: Unicode code points, O(1) access to codepoints
- **Rust**: UTF-8 bytes, O(1) access to bytes

When running on the web, there's a fundamental tension: JS strings are optimized
for UTF-16 access, but other languages may prefer different views.

### UTF-8 is the Future

The article argues (citing Henri Sivonen's
["It's Not Wrong that '🤦🏼‍♂️'.length == 7"](https://hsivonen.fi/string-length/))
that:

1. **Random access to codepoints is not actually important** - users want
   grapheme clusters anyway, which are variable-length
2. **UTF-8 is more space-efficient** than UTF-16 or array-of-codepoints
3. **Swift successfully migrated from UTF-16 to UTF-8** with a "views" API
4. Even JS engines are considering UTF-8 internally

**Implication for Zena**: Our UTF-8 default is the right choice. We should NOT
provide O(1) codepoint access - it encourages the wrong mental model.

### WTF-16 and Surrogates

JavaScript strings are actually **WTF-16**, not UTF-16:

- UTF-16 requires surrogate pairs to be properly paired
- WTF-16 allows unpaired surrogates (invalid Unicode)
- This is historical baggage from Java/JS exposing 16-bit code unit access

When receiving strings from JS, we must decide:

1. **Validate eagerly**: O(n) check, reject invalid strings
2. **Replace surrogates**: Replace with U+FFFD (lossy)
3. **Pass through**: Extend our semantics to handle surrogates

**Recommendation**: For host interop, validate or replace. Don't let WTF-16
semantics leak into Zena's type system.

### The stringref Proposal (Stalled)

There was a WASM `stringref` proposal that would provide:

- Abstract string type with UTF-8 and UTF-16 views
- Would allow JS strings to be used directly
- Currently in "hiatus" - no consensus in the standards group

**Objections**:

1. "Strings are too high-level for WASM"
2. "We'd be standardizing JS strings"

**Current workaround** (used by Guile/Hoot):

- Use `stringref` as a toolchain concept
- Lower to `(array i8)` with WTF-8 encoding
- Call host conversion routines at boundaries

### Performance Model Concerns

Different hosts may have different internal representations:

- Browser: likely UTF-16 internally (to match JS)
- Non-web: likely UTF-8

Requesting a UTF-16 view on UTF-8 string (or vice versa) may be:

- O(1) on one system (if already that encoding)
- O(n) on another (requires transcoding)

This can cause quadratic behavior in loops if not careful.

**Implication for Zena**: Our "views" API (like Swift) should make encoding
conversions explicit, so users understand the cost model.

### Recommendations for Zena

Based on the article:

1. **Stick with UTF-8** - it's the future, more efficient
2. **Don't expose O(1) codepoint access** - wrong abstraction
3. **Provide "views" API** like Swift: `string.utf8`, `string.utf16`,
   `string.codePoints`, `string.graphemes`
4. **For host strings**, consider:
   - `externref` wrapping JS string
   - Lazy transcoding only when needed
   - Explicit API for getting views to surface cost
5. **Handle surrogates explicitly** at the JS boundary
6. **Consider breadcrumbs** (like Swift) if we ever need fast codepoint indexing

## Future Considerations

- **Unicode Support**: Iterators will handle Unicode code points or grapheme
  clusters.
- **Single Quotes**: May reserve `'a'` for character literals (code points).
- **Ropes**: For efficient concatenation of large strings.
- **String Builders**: Mutable buffer for efficient string construction.
- **Views API**: Like Swift, provide `.utf8`, `.utf16`, `.codePoints` views.
- **Breadcrumbs**: For accelerating codepoint access on UTF-8 strings if needed.
