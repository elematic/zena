---
title: 'Strings'
description: 'Reference for the String class, string literals, escape sequences, template literals, operators, and memory layout in Zena.'
---

::: warning Unsettled String Internals
The internal architecture of strings in Zena is actively evolving. Current versions
expose a raw constructor `new(data, start, end, encoding)` and byte-level methods
(`getByteAt`, `sliceBytes`) that will be restricted or replaced in future releases.
Multi-encoding support is currently limited to WTF-8 at runtime, and host strings
backed by WebAssembly `js-string-builtins` are in development. Future iterations
will transition toward Swift-style opaque index objects rather than raw byte offsets.
:::

Strings in Zena are immutable sequences of Unicode characters represented by the
`String` class. `String` is a reference type with value-based equality and
internally managed memory views.

For usage guidelines, memory management patterns, and parsing examples, see the
[Strings Guide](/guide/strings/). For standard library builder and
parser classes, see the [`StringBuilder`](/api/core/#stringbuilder) and
[`StringReader`](/api/core/#stringreader) API documentation.

## The String type

The `String` class is defined in the standard library and implemented as a final
class implementing `Hashable`:

```zena
export final class String implements Hashable
```

`String` is a class rather than a primitive value. String literals, template
expressions, concatenations, and slicing operations all produce instances of
`String`.

### Constructors and factory methods

```zena
// Creates a new string by joining an array of string parts
static fromParts<A extends Array<String>>(parts: A): String;

// Internal compiler entry point for lowering template literals
static fromRawParts(parts: array<var String>): String;

// Creates a String from a backing ByteArray with explicit bounds
static fromByteArray(data: ByteArray, start: i32, end: i32, encoding: Encoding): String;

// Direct constructor (will be restricted to private in future releases)
new(data: ByteArray, start: i32, end: i32, encoding: Encoding);
```

In standard application code, create strings using literals, template expressions,
or [`StringBuilder`](/api/core/#stringbuilder). The direct constructor
is intended for internal runtime operations.

## String literals and escapes

String literals are enclosed in single quotes (`'...'`) or double quotes (`"..."`):

```zena
let single = 'hello';
let double = "world";
```

Single-quoted and double-quoted literals have identical semantics in the current
compiler. Both evaluate to a `String` instance.

### Escape sequences

The following escape sequences are recognized in string literals:

| Escape       | Name              | Description                                          |
| :----------- | :---------------- | :--------------------------------------------------- |
| `\n`         | Newline           | Line feed character (`0x0A`)                         |
| `\r`         | Carriage return   | Carriage return character (`0x0D`)                   |
| `\t`         | Tab               | Horizontal tab character (`0x09`)                    |
| `\\`         | Backslash         | Literal backslash character (`\`)                    |
| `\"`         | Double quote      | Literal double quotation mark (`"`)                  |
| `\'`         | Single quote      | Literal single quotation mark (`'`)                  |
| `\h`         | Word boundary     | Word character escape                                |
| `\<newline>` | Line continuation | Escapes the source line break (no character emitted) |

```zena
let escaped = "First line\nSecond line\t(indented)";
let quotes = "He said, \"Hello!\" and it\'s fine";
```

## Template literals and interpolation

Template literals are enclosed in backticks (`` `...` ``) and support expression
interpolation via `${expression}`:

```zena
let name = "Alice";
let count = 3;
let message = `Hello, ${name}! You have ${count} unread messages.`;
```

### Interpolated expressions

Interpolation supports:

- `String` expressions
- Numeric primitives and narrow integers (`i32`, `u32`, `i64`, `u64`, `f32`, `f64`, `i8`, `u8`, `i16`, `u16`)
- `boolean` values (`true` and `false`)

```zena
let a = 10;
let b = 20;
let log = `${a} + ${b} = ${a + b}`; // "10 + 20 = 30"
```

Arbitrary object types do not implicitly convert to strings in template expressions.
To interpolate a class instance, invoke an explicit method returning a `String`.
A general `toString()` conversion protocol <span class="badge info">Planned</span> is
under consideration, subject to a dead-code elimination design that avoids pulling
string conversion methods into every compiled binary.

### Lowering mechanism

The compiler lowers template literals to `String.fromRawParts(...)`. This helper
determines total byte length in a first pass and allocates a single backing
`ByteArray` for the resulting string, avoiding intermediate buffer copies.

## Multi-line strings

Zena provides two ways to write strings that span multiple lines of source code.

### Multi-line template literals

Template literals preserve line breaks verbatim:

```zena
let query = `
SELECT id, title, created_at
FROM articles
WHERE published = true
ORDER BY created_at DESC
`;
```

### Line continuations

In regular string literals (`"..."` or `'...'`) and template literals, a backslash
immediately followed by a line break escapes the newline:

```zena
let description = "This is a single long line of text that is \
written across multiple lines in the source file without \
inserting any newline characters.";
```

The resulting string contains continuous text with no embedded `\n` or `\r`.

## Tagged templates

Tagged templates allow a function to parse and evaluate a template literal:

```zena
let result = tag`Hello ${name}, your score is ${score}!`;
```

### Tag function signature

A tag function receives a `TemplateStringsArray` representing the static string
segments and an array containing the interpolated expression values:

```zena
import {TemplateStringsArray, TemplateTag} from 'zena:core';

let customTag: TemplateTag<String> = (
  strings: TemplateStringsArray,
  values: FixedArray<anyref>
): String => {
  // strings.length == values.length + 1
  return strings[0];
};
```

### The TemplateStringsArray class

`TemplateStringsArray` provides access to both cooked and raw string segments:

| Member    | Type                     | Description                                 |
| :-------- | :----------------------- | :------------------------------------------ |
| `length`  | `i32`                    | Number of string segments                   |
| `[index]` | `String`                 | Cooked (escape-processed) string at `index` |
| `raw`     | `ImmutableArray<String>` | Raw (unescaped) string segments             |

In raw strings (`strings.raw[i]`), escape sequences like `\n` remain as two
characters (`\` and `n`) rather than being converted to line feed characters.

### The dedent tag

The standard library exports a built-in [`dedent`](/api/core/#dedent)
tag in `zena:core`. It strips common leading indentation and
trims opening and closing blank lines:

```zena
import {dedent} from 'zena:core';

let usage = dedent`
  zena build <entry>
    -o <path>   where to write the module
`;
```

### Call-site caching

The compiler allocates the `TemplateStringsArray` instance once per syntactic
call site and caches it. Repeated executions of the same tagged template
expression pass the same `TemplateStringsArray` reference to the tag function.

## Indexing and slicing

### Subscript indexing

Direct subscript access (`str[i]`) produces a compile-time error:

```zena
let text = "hello";
let c = text[0];
// @error: Direct indexing on 'String' is not supported
```

Subscripting by raw integer index is prohibited to prevent splitting multi-byte
UTF-8 sequences or surrogate pairs. For character-aware scanning and parsing, use
[`StringReader`](/api/core/#stringreader).

### Byte operations

Strings currently expose byte-level methods:

```zena
// Length of the string in bytes
length: i32 { get; }

// Byte value at the given index (0 to length - 1)
getByteAt(index: i32): i32;

// O(1) zero-copy slice by byte offsets
sliceBytes(start: i32, end: i32): String;
```

::: warning Safety
`sliceBytes` and `getByteAt` operate on raw byte offsets, not Unicode code points.
Calling `sliceBytes` with arbitrary offsets can slice through the middle of a
multi-byte UTF-8 sequence, producing an invalid string. Use
[`StringReader`](/api/core/#stringreader) to determine safe slice positions.
:::

### Memory retention and copying

Slices produced by `sliceBytes` share the backing `ByteArray` of the parent
string. A small slice prevents the entire backing array from being collected by
the garbage collector.

To release the parent buffer, use `.copy()`:

```zena
// Returns a new String with an independently allocated ByteArray
copy(): String;

// Copies bytes into an existing ByteArray
copyBytesTo(target: ByteArray, targetOffset: i32, start: i32 = 0, length: i32 = -1): void;
```

```zena
let fileContent = readFile("large.xml");
let token = fileContent.sliceBytes(10, 20).copy(); // Detached from large buffer
```

## Comparison and equality

### Equality operators

Strings compare by value using `==` and `!=`:

| Operator | Semantic         | Description                                                     |
| :------- | :--------------- | :-------------------------------------------------------------- |
| `==`     | Value equality   | Returns `true` if both strings contain identical byte sequences |
| `!=`     | Value inequality | Returns `true` if string contents differ                        |

Value equality (`==`) executes an optimized comparison:

1. Length comparison (`this.length == other.length`).
2. Cached hash code mismatch check: if both strings have computed hash codes and they differ, returns `false` without scanning bytes.
3. Byte-by-byte comparison (`#regionEquals`).

```zena
let a = "hello";
let b = "hel" + "lo";
let isSameValue = a == b;  // true
let isDifferent = a != "world"; // true
```

::: warning Reference identity (`===`) is unstable
Because `String` is currently defined as a class, the compiler permits `===` and
`!==`. However, strings have value semantics, and separate heap allocations with
identical character content evaluate to `false` under `===`.

Reference identity is an implementation detail that should be non-observable for
value types. Comparing strings by identity is unstable and planned to be disallowed
by the compiler, matching records and tuples. Code should always use `==` and `!=`.
:::

### Search and split methods

```zena
// Returns true if this string starts with prefix
startsWith(prefix: String): boolean;

// Returns true if this string ends with suffix
endsWith(suffix: String): boolean;

// Returns true if this string contains needle
contains(needle: String): boolean;

// Splits the string into substrings separated by separator
split(separator: String): FixedArray<String>;
```

For cursor-based tokenization, sequential scanning, and parsing at UTF-8 code point
boundaries, use [`StringReader`](/api/core/#stringreader).

### ASCII case conversion

```zena
// Returns a copy with ASCII characters (A-Z) converted to lowercase
asciiLowerCase(): String;

// Returns a copy with ASCII characters (a-z) converted to uppercase
asciiUpperCase(): String;
```

These methods operate strictly on ASCII bytes (`0x41..0x5A` and `0x61..0x7A`).
They do not perform full Unicode case folding. This keeps WebAssembly binaries
compact by avoiding large Unicode case-mapping tables. If no characters change,
they return `this` directly without allocating a new string.

### Hashing

`String` implements the [`Hashable`](/api/core/#hashable) interface:

```zena
hashCode(): i32;
```

The hash code is computed using the 32-bit FNV-1a algorithm and cached in a private
`#hashCode` field after its first computation.

## Encodings and representation

### Memory layout

In WebAssembly GC, a `String` is represented as a struct:

```wat
(type $String (struct
  (field $data (ref $ByteArray))  ;; Backing byte array (array (mut i8))
  (field $start i32)              ;; Inclusive start offset
  (field $end i32)                ;; Exclusive end offset
  (field $encoding i32)           ;; Encoding tag (0 = WTF-8, 1 = WTF-16)
  (field $hashCode (mut i32))     ;; Cached FNV-1a hash code
))
```

### Encodings

The `Encoding` enum defines supported encodings:

```zena
export enum Encoding {
  WTF8, // 0 - UTF-8 allowing unpaired surrogates
  WTF16 // 1 - WTF-16 for JS interop
}
```

::: warning Encoding status
While `Encoding.WTF16` is declared in the standard library, the current compiler
and runtime only instantiate WTF-8 strings.
:::

### The concatenation performance hazard

The `+` operator on strings allocates a new `ByteArray` equal to the combined length
of both operands and copies the bytes from each:

```zena
operator +(other: String): String;
```

Concatenating strings with `+` inside a loop repeatedly allocates new byte arrays,
creating an O(n²) performance hazard identical to naive concatenation in Java.
For dynamic or iterative string generation, use
[`StringBuilder`](/api/core/#stringbuilder). For interpolating values
into static text, prefer [template literals](#template-literals).

### Future architectural direction

Zena is actively expanding its string implementation toward two major milestones:

1. **Swift-style index model**: Replacing raw integer byte offsets with opaque
   index types (`String.Index`) and standard unicode code point iterators to
   prevent accidental slicing bugs.
2. **Polymorphic backing storage**: Expanding `String` into an abstract base
   supporting multiple concrete implementations:
   - Native WebAssembly GC byte arrays (current default)
   - Host strings backed by JavaScript strings via WebAssembly `js-string-builtins`
   - Linear memory strings for zero-copy WASI I/O
