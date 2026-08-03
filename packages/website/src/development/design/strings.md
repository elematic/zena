---
title: 'Strings'
description: 'One String type, an encoding chosen per binary rather than per language, and views instead of copies.'
---

Note: The design of Zena strings is still somewhat in flux.

## Problem

Strings are a critical data type to get correct in a programming language for
many reasons:

- Strings are ubiquitous. Nearly every program and library will use them.
- They're often used in performance-critical hot loops, especially operations
  like equality, hashing, slicing, and concatenation.
- They're important for host interop. Strings frequently cross API boundaries.
- Unicode makes some string operations harder to do correctly for non-ASCII
  characters.
- Strings are complicated, and can easily contribute to binary bloat.

### Encodings

Modern programming languages generally use Unicode for all strings, and usually
use a variable-width encoding. Grapheme clusters (multi-codepoint sequences)
complicate the matter further. This means that there is not a direct mapping
between byte indices and "character" indices: you cannot read the Nth character
of a string without reading the first N-1 characters, the character length of
a string cannot be determined by its byte length, etc.

String APIs that allow direct byte access risk splitting multi-byte characters
and creating malformed strings. String APIs that remove direct indexing or
force character indexing risk creating performance problems if each indexing
operation becomes a loop of string contents.

### WebAssembly, interop and strings

On top of the complications of dealing with unicode within a single language,
Unicode poses an additional challenge for Wasm-based programs (and other
cross-language interop boundaries) because different hosts may use different
default string encodings. Communicating across the boundary may require
copying and re-encoding strings on every cross-boundary call.

Java, JavaScript, and C# use UTF-16, while Python, Rust, Go, Swift use UTF-8. It
is impossible to have a language with one encoding that doesn't require copying
at host call boundaries.

The WebAssembly [stringref](https://github.com/WebAssembly/stringref/blob/main/proposals/stringref/Overview.md) proposal was supposed to help address this (and the fact that string
implementations can be a lot of code to drag along in a binary), but that
proposal stalled. The web got the much narrower JS String Builtins instead,
which give Wasm direct access to JavaScript's string operations without adding a
string type to Wasm itself. That helps on the web and does nothing for WASI.

### Performance

String operations are so often used in performance critical code that the
performance of strings is itself a performance critical topic. If string
concatenation or slicing requires copying string contents, and slicing or
concatenation is done in a loop, then you create code that runs in quadratic
time on the length of strings you're handling. Strings are also numerous, and
their memory footprint can have a large impact on the overall program.

Some languages have a simple string API but a very complicated implementation.
JavaScript engines typically have something on the order of four string
implementations for efficiently dealing with different use character ranges,
ropes, etc. Other languages have simple implementations, but complex APIs that
force developers to use the API just right to avoid performance problems.

## Goals

- Small implementation size
- Low memory overhead
- Avoid virtual dispatch overhead
- Fast operations, especially equality and hashing
- Low Wasm indirection - flat data layout
- Unicode-safe operations
- Simple, ergonomic APIs
- Avoid copying on host calls

These goals are often in tension and it is hard to meet all of them.

## Design overview

We take inspiration from Swift and Go for our string design, emphasizing small
implementation size, Unicode-safe operations and zero-copy host interop. We will
flex on trying to make one Wasm binary be optimal for all hosts, and use
compiler flags to adjust the default encoding.

- String is a class with a final and fixed/sealed hierarchy, not an interface.
  - We can pay for virtual dispatch, and often optimize it away. We don't want
    to pay for the extra indirection of fat pointers for interfaces.
  - Most public String methods will be final and delegate to a few virtual
    methods that concrete implementations provide. When we can't devirtualize
    those calls, we can possibly customize the emit strategy to use branches at
    the callsites instead of vtable lookups.
  - To keep Zena binaries small and enable devirtualization, we will have one
    main String implemenation for all Zena-native strings that's backed by a
    single byte-array.
  - If we have other String subclasses, they might include:
    - HostString - a string created and managed by the host, such as a
      JavaScript string. Such strings will hold an externref, which is not an
      eqref, so will have to delegate to host functions, like the JS String
      Builtins.
    - LinearMemoryString - a string backed by linear memory for zero-copy access
      to WASI and other linear memory provided data.
    - RopeString - if we need, we can implement a rope-based string. We will
      hold off on this because unlike HostString and LinearMemoryString, it's
      very likely that simple programs will use RopeString and thus multiple
      String implementations, which will hinder devirtualization.
- To encourage Unicode safe operations, the encoding will be hidden and we will
  discourage the use of byte-indexing. Strings will not have a `[](i32)`
  operator. They will have a Swift-style `[](String.Index)` operator iteration
  over codepoints (or grapheme clusters?), and possibly a `getByteAt()` method.
- To reduce the need for random-access APIs and provide a building block for
  parsers and such, we will add a StringReader class that keeps a current
  position and has methods for safely navigating the string, including consuming
  some common character classes (whitespace, etc) to reduce the need for
  potentially expensive regular expressions.
- To make slicing fast and enable string literals to sharing data segments in
  the binary, strings will be a view onto a backing byte array, Go-style. This
  may cause extra memory to be held onto, so a copy() method will create a new
  backing array to allow the old one to be released.
- For fast concatenation we will add a StringBuilder class, JavaScript-style
  template literals, and a join function.
  - Without a rope implementation, piecewise concatenation with the `+` operator
    will be a foot gun, which we will attempt to discourage with compiler
    warnings. _Note_: This is a provisional decision. It may turn out that the
    complexity of a StringBuilder is similar to including a rope-based String
    implementation, and that the cost of multiple String implementations isn't
    insurmountable or a deal-breaker. We will need benchmarks.

## Host interop

A `String` is a Wasm GC struct wrapping a GC array. Both are opaque to the host:
JavaScript cannot read a GC struct's fields, and a GC array cannot be viewed as
a typed array. Every string crossing the boundary is copied.

### Which side runs the loop

Wasm calling the host once per byte is the slow approach. The advice, from the
dart2wasm team in
[WebAssembly/gc#568](https://github.com/WebAssembly/gc/issues/568), is to invert
it: pass the string to the host as an `externref` and let the host drive the
loop, calling a small exported function to read each byte, "because V8 optimizes
JS calling Wasm better than Wasm calling JS." dart2wasm ships exactly this, as
`$wasmI8ArrayGet`.

The compiler emits three helpers for this, exported from every module that uses
strings:

| Export           | Signature                     | Direction   |
| ---------------- | ----------------------------- | ----------- |
| `$stringGetByte` | `(externref, i32) -> i32`     | Wasm → host |
| `$stringCreate`  | `(i32) -> externref`          | host → Wasm |
| `$stringSetByte` | `(externref, i32, i32) -> ()` | host → Wasm |

Reading a string means calling `$stringGetByte` in a loop and decoding:

```js
const readString = (strRef, length) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = getByte(strRef, i) & 0xff;
  }
  return new TextDecoder().decode(bytes);
};
```

Writing goes the other way: encode with `TextEncoder`, call `$stringCreate(len)`
to allocate, then `$stringSetByte` per byte. `@zena-lang/runtime` packages both
as `createStringReader` and `createStringWriter`.

Byte-streaming out of Wasm, the alternative, costs N+2 Wasm-to-JS calls per
string. This costs one, plus a loop the engine can optimize.

### Why the signature is `externref`

`$stringGetByte` takes an `externref` and casts it back to a `String` inside the
function body, which looks like pointless work when it could take a typed
reference directly. It isn't. In the same thread, Jakob Kummerow of the V8 team
noted two things:

- V8's Wasm-into-JS inlining "currently only triggers for (nullable!)
  `externref` in the Wasm signature." A typed reference, or even `anyref`, does
  not get inlined.
- Implicit type checks at the boundary are "quite a bit slower than using
  `externref` and then an explicit `ref.cast` on the Wasm side."

The cast is the fast path, not overhead.

### The advice is V8-specific

All of the above describes one engine's current behavior, and the V8 engineer
in that thread says as much: "I'm not saying that you should optimize for V8's
current behavior, I'm just describing what that behavior is for now."

A custom Wasmtime embedding has no JIT inlining an exported Wasm function into a
host loop, so per-call overhead may dominate and a bulk copy is likely better.
Zena has not measured this outside V8.

The underlying problem is that Wasm GC has no bulk transfer between a GC array
and host memory at all. That is what issue #568 is asking for, and it is still
open.

### WASI

WASI is a separate problem. The canonical ABI passes strings in linear memory,
so a GC-backed string must be copied into linear memory for the call, and the
helpers above do not apply. Component Model GC removes that copy — wasmtime
already has `-W component-model-gc=y` — but until it is stable and arrives in a
post-0.3 WASI update, the copy stays.

## Current implementation

::: warning
The implementation predates the design above and has not caught up to it. This
section describes what exists today, not what is intended.
:::

`String` is a `final` class holding a view onto a backing byte array:

```zena
export final class String implements Hashable {
  #data: ByteArray; // may be shared with other Strings
  #start: i32; // inclusive
  #end: i32; // exclusive
  #encoding: Encoding; // WTF8 or WTF16
}
```

All fields are private. Slicing is O(1) and shares `#data`; `copy()` allocates a
new backing array so the parent can be collected.

```zena
let json = readFile('data.json');
let key = json.sliceBytes(100, 110); // shares the backing array
let owned = key.copy(); // new backing array
```

`StringBuilder` handles incremental construction. `StringReader` walks a string
by code point and provides `mark()`, which returns a position on a code point
boundary.

::: info Why WTF, not UTF
JavaScript strings can contain unpaired surrogates, so they are not always valid
UTF-16. WTF-8 and WTF-16 are the variants that permit them. Well-formed text is
a subset of both, so valid UTF-8 and UTF-16 behave identically.
:::

### Where it differs from the design

- **The encoding is not hidden.** `length` returns a byte count, and `getByteAt`
  and `sliceBytes` are byte-indexed. `sliceBytes` will split a multi-byte
  character if given an unaligned index.
- **There is no `[]` operator**, and no `String.Index` type to index by.
- **Only WTF-8 is produced.** The `Encoding` field exists and `WTF16` is
  defined, but nothing constructs a WTF-16 string, and `StringReader` decodes
  WTF-8 only.
- **`--default-encoding` does not exist.** The encoding of string literals is
  not configurable.
- **There are no `String` subclasses.** `HostString`, `LinearMemoryString`, and
  `RopeString` are unimplemented; the class is `final`.
- **Concatenation with `+` produces no warning**, so the quadratic-time foot gun
  is unguarded.

→ Working document:
[`docs/design/strings.md`](https://github.com/elematic/zena/blob/main/docs/design/strings.md)
