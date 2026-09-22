---
title: 'Strings'
description: 'A practical guide to string literals, templates, operations, slices, unicode safety, and performance in Zena.'
---

::: warning Unsettled String Internals
Zena's string architecture is actively evolving. While the high-level `String`
type is stable, several core changes are under consideration:

- Low-level operations like `getByteAt` and `sliceBytes` and the direct
  constructor `new(data, start, end, encoding)` are currently exposed
  as temporary implementation details that will become private or restricted.
- Multi-encoding support is partial (only WTF-8 is currently instantiated at
  runtime) and needs to be finished.
- Host-backed strings using the WebAssembly `js-string-builtins` proposal are
  under active development.
- Value semantics are not fully implemented.
  :::

Strings in Zena are immutable sequences of Unicode characters represented by the
`String` class.

Strings are being designed to find a good balance of familiar, ergonomic,
correct, portable, fast, and compact:

- Strings limit Unicode-unsafe operations, both for correctness and portability
  across hosts with different native encodings.
- Strings have simple implementations for code size, which may sacrifice
  performance on certain operations like concatenation.
- Strings sometimes trade off performance and memory overhead, for instance
  splitting strings is fast, but retains memory from the original source.
  Hashing can either be done on-demand, or cache the hash code, taking memory.

For the formal syntax specification, literal escape tables, and API signatures,
see the [Strings Reference](/reference/strings/).

## Literals and templates

Zena supports string literals, multi-line continuations, and template literals.

### String literals

String literals are enclosed in single quotes (`'...'`) or double quotes (`"..."`):

```zena
let single = 'hello';
let double = "world";
```

Both forms produce instances of `String` and support standard escape sequences:

```zena
let message = "First line\nSecond line\t(indented)";
let quote = "He said, \"Hello!\"";
```

### Template literals and interpolation

Template literals are enclosed in backticks (`` `...` ``) and support expression
interpolation via `${expression}`:

```zena
let name = "Alice";
let count = 3;
let message = `Hello, ${name}! You have ${count} unread messages.`;
```

Expressions inside `${...}` evaluate at runtime. In addition to strings, template
expressions directly format primitive numbers (`i32`, `u32`, `i64`, `u64`, `f32`, `f64`,
and narrow integers) and `boolean` values:

```zena
let a = 10;
let b = 20;
let summary = `${a} + ${b} = ${a + b}`; // "10 + 20 = 30"
let status = `Active: ${true}`;          // "Active: true"
```

Arbitrary objects do not implicitly convert to strings in template expressions.
To interpolate a class instance, invoke an explicit method that returns a `String`.
A universal `toString()` protocol <span class="badge info">Planned</span> is under
consideration, subject to dead-code elimination constraints so that unused formatting
logic is not preserved across the entire type hierarchy.

Template literals construct their result in a single pass, calculating the total
length upfront to avoid intermediate string allocations.

### Multi-line strings

Template literals preserve source line breaks and indentation:

```zena
let query = `
  SELECT id, title
  FROM articles
  WHERE published = true
`;
```

#### Stripping indentation with dedent

When writing multi-line template literals inside indented functions or blocks, the
surrounding indentation is included in the string output. To format template literals
cleanly in source code while stripping common leading whitespace, use the `dedent`
template tag from `zena:core`:

```zena
import {dedent} from 'zena:core';

let printHelp = () => {
  let usage = dedent`
    Usage: zena <command> [options]

    Commands:
      build    Compile the project
      run      Run the program
  `;
  console.log(usage);
};
```

`dedent` drops the opening and closing blank lines and removes the longest common
whitespace prefix across all content lines. Any interpolated values must be `String`
instances.

#### Line continuations

To format a long string literal across multiple lines in source code without
inserting newline characters into the string value, use a **line continuation**:
place a trailing backslash (`\`) immediately before the line break:

```zena
let description = "This is a single long line of text that spans \
multiple lines in the source file without inserting newline characters.";
```

Line continuations work in both standard string literals (`"..."`, `'...'`) and
template literals (`` `...` ``).

## Operations and equality

Strings provide operators and methods for concatenation, comparison, searching,
and case conversion.

### Value equality

The `==` and `!=` operators compare strings by **value**. Two strings are equal
if they contain identical character sequences:

```zena
let a = "hello";
let b = "hel" + "lo";

let sameValue = a == b;   // true
let different = a != "world"; // true
```

Value equality checks compare character content efficiently, checking lengths
and cached hashes before inspecting individual bytes.

::: warning Reference identity (`===`) is discouraged
Because `String` is currently implemented as a class, the compiler allows the
reference identity operators `===` and `!==`. However, strings have value semantics,
and separately allocated strings with identical contents do not share pointer
identity (`"hello" === ("hel" + "lo")` evaluates to `false`).

Pointer identity is an implementation detail that should be non-observable for
value types. Reference identity comparison on strings is unstable and planned to
be disallowed by the compiler, matching records and tuples. Always use `==` and `!=`
for string comparisons.
:::

### Concatenation

Use the `+` or `+=` operator to join strings:

```zena
let greeting = "Hello, " + name + "!";
var path = "/usr";
path += "/bin";
```

For formatting strings with variables or expressions, [template literals](#template-literals)
are generally preferred over chaining `+` operators.

When assembling strings dynamically or repeatedly inside loops, chaining `+`
allocates a new string and copies bytes on every iteration. Use
[`StringBuilder`](/api/core/#stringbuilder) instead to accumulate
content with buffered geometric growth.

### Searching and splitting

The `String` class provides core search and splitting methods:

```zena
let text = "image.png";

let isImage = text.endsWith(".png"); // true
let isDoc = text.startsWith("doc_"); // false
let hasDot = text.contains(".");      // true

let csv = "apple,banana,cherry";
let fruits = csv.split(",");         // FixedArray<String> with 3 elements
```

For cursor-based tokenization, custom parsing, or scanning character by character
across safe Unicode boundaries, use [`StringReader`](/api/core/#stringreader)
from `zena:core`.

### ASCII case conversion

The `asciiLowerCase()` and `asciiUpperCase()` methods transform ASCII characters:

```zena
let title = "Zena Language";
let lower = title.asciiLowerCase(); // "zena language"
let upper = title.asciiUpperCase(); // "ZENA LANGUAGE"
```

These methods operate strictly on ASCII bytes (`0x41..0x5A` and `0x61..0x7A`).
Restricting case mapping to ASCII avoids embedding large Unicode case-folding
tables into WebAssembly binaries. When a string contains no characters that need
changing, these methods return `this` directly with zero allocations.

## Slices, views, and copies

Zena implements strings using a **view-based architecture** similar to Go.
Every `String` instance is a lightweight header consisting of:

1. A reference to a backing `ByteArray`
2. An inclusive `#start` byte offset
3. An exclusive `#end` byte offset
4. An encoding tag

### Zero-copy slicing

Slicing a string reuses the existing bytes without duplication. Calling `.sliceBytes()`
creates a new `String` header referencing the existing `ByteArray` with shifted
offsets:

```zena
let full = "Hello, world!";
let hello = full.sliceBytes(0, 5); // String view: start = 0, end = 5
```

Slicing runs in O(1) constant time and allocates only the small `String` header.

### The memory retention hazard

Because a slice holds a reference to its entire parent `ByteArray`, the garbage
collector cannot reclaim the backing array as long as any slice remains reachable.

This introduces a memory retention hazard when storing small substrings extracted
from large documents:

```zena
// Reads a 50MB document into memory
let largeDocument = readFile("dataset.json");

// Extracting a small key as a slice
let key = largeDocument.sliceBytes(120, 130);

// Hazard: The entire 50MB ByteArray remains pinned in memory
// because `key` holds a reference to it.
```

### Detaching with copy()

To release parent memory, call `.copy()` on any slice you plan to retain
long-term:

```zena
let key = largeDocument.sliceBytes(120, 130).copy();
```

The `.copy()` method allocates a new `ByteArray` sized precisely to the slice
(`10` bytes in this example) and copies the bytes over. The parent `largeDocument`
can then be garbage collected as soon as it goes out of scope.

Use zero-copy slices for short-lived intermediate parsing, and call `.copy()`
on substrings that will be stored in long-lived data structures.

## Unicode and safety

String safety in Zena centers on preventing encoding corruption and providing
safe text parsing.

### Subscript indexing and Unicode safety

Direct integer subscripting (`str[i]`) produces a compile-time error:

```zena
let text = "Zena";
let char = text[0];
// @error: Direct indexing on 'String' is not supported
```

In UTF-8, characters frequently span between one and four bytes. Subscripting by
raw integer offsets risks splitting multi-byte code points, corrupting text.

Zena draws inspiration from **Swift's string model**: strings present views over
Unicode characters rather than raw byte arrays, and navigation uses opaque index
objects (`String.Index`). Future releases will introduce opaque index types and
Unicode code-point and grapheme-cluster iterators. For text parsing today, use
`StringReader`.

### Safe parsing with StringReader

To navigate and parse strings safely at Unicode code point boundaries, use
[`StringReader`](/api/core/#stringreader) from `zena:core`:

```zena
import {StringReader} from 'zena:core';

let parseWord = (input: String): String? => {
  let reader = new StringReader(input);

  reader.skipWhitespace();
  if (reader.isAtEnd) {
    return null;
  }

  // Mark the start position at a valid code point boundary
  let start = reader.mark();

  // Decode and advance across code points (1 to 4 bytes each)
  while (!reader.isAtEnd && isLetter(reader.peek())) {
    reader.advance();
  }

  // Extract a verified substring slice
  return reader.sliceFrom(start);
};
```

`StringReader` provides:

- **Code point decoding**: `peek()` and `advance()` decode full 1- to 4-byte
  UTF-8 sequences and return 32-bit Unicode code points.
- **Byte inspection for ASCII**: `peekByte()` and `advanceByte()` provide fast
  paths for known single-byte delimiters (`{`, `}`, `,`, `:`).
- **Safe slicing with mark()**: `reader.mark()` captures the byte offset at a
  verified code point boundary. Slices extracted via `sliceFrom(mark)` or
  `sliceRange(start, end)` are guaranteed to produce well-formed UTF-8.
- **Scanning utilities**: `skipWhitespace()`, `readUntil(needle)`, and
  `skipBytesWhile(predicate)`.

### Encodings and WTF-8

Zena adopts the **WTF-8** ("Wobbly Transformation Format") encoding standard.
Standard UTF-8 rejects surrogate code points (`U+D800` through `U+DFFF`).
However, JavaScript strings are sequences of 16-bit code units that may contain
unpaired surrogates. WTF-8 extends UTF-8 to permit well-formed surrogate sequences,
guaranteeing lossless round-tripping when exchanging strings with JavaScript
and DOM APIs.

Strings created inside Zena are always well-formed Unicode.

## Performance and representations

Efficient string processing in Zena involves choosing the right construction
tools and understanding how strings are represented at runtime.

### The concatenation performance hazard

The `+` operator allocates a new `ByteArray` equal to the combined length of both
operands and copies bytes from each:

```zena
let greeting = "Hello, " + name;
```

While suitable for simple expressions, using `+` inside loops is a severe
performance hazard. Similar to Java, repeated concatenation allocates and
copies increasingly large buffers on every iteration, leading to O(n²) time
complexity:

```zena
// Hazard: Allocates and copies a new buffer on every iteration
var csv = "";
for (let item in items) {
  csv += item + ","; // Quadratic buffer copying
}
```

For static multi-variable formatting, use template literals, which measure the
total length and allocate the result buffer once.

### Building strings with StringBuilder

For iterative string construction across loops or conditional logic, use
[`StringBuilder`](/api/core/#stringbuilder) from `zena:core`:

```zena
import {StringBuilder} from 'zena:core';

let buildCsv = (items: Array<String>): String => {
  let builder = new StringBuilder(64); // Initial capacity in bytes

  for (let item in items) {
    builder.append(item);
    builder.appendByte(44); // 44 = ASCII comma ','
  }

  return builder.toString();
};
```

`StringBuilder` offers several performance advantages:

- **Chunked geometric growth**: Appends write directly into preallocated chunk
  buffers, avoiding full-array reallocations.
- **Direct primitive formatting**: Methods such as `appendI32`, `appendU32`,
  `appendI64`, and `appendF64` write numbers directly into the buffer as decimal
  ASCII without creating temporary string objects.
- **Zero-copy completion**: When accumulated content fits in the initial chunk,
  `toString()` returns a zero-copy `String` view sharing that buffer.

### Polymorphic backing storage

Zena is designed around a single `String` API backed by specialized internal
storage implementations:

| Representation            | Storage                              | Use case                                      | Status           |
| :------------------------ | :----------------------------------- | :-------------------------------------------- | :--------------- |
| **GC strings**            | WebAssembly GC `ByteArray`           | Literals, concatenations, general computation | Active (default) |
| **Host strings**          | `externref` via `js-string-builtins` | Zero-copy sharing with JavaScript and the DOM | In development   |
| **Linear memory strings** | Pointer and byte length              | Zero-copy WASI filesystem, network, and C FFI | Planned          |
| **Ropes**                 | Tree of string segments              | High-throughput text editing and append trees | Planned          |

Today, all strings in Zena are backed by WebAssembly GC byte arrays. Active
compiler development is integrating the WebAssembly `js-string-builtins` proposal,
which will enable JavaScript host strings to enter Zena with zero transcoding
overhead.
