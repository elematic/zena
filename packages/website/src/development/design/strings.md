---
title: 'Strings'
description: 'One String type, a representation chosen per compile target, views instead of copies, and what Unicode costs in a small binary.'
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
implementation size, Unicode-safe operations and zero-copy host interop. Rather
than make one Wasm binary optimal for every host, the representation is chosen
per compile target.

- **One final `String` class per target.** On the byte targets (`zena-cli`,
  `component`, `freestanding`), a `String` is a view onto a byte array of
  WTF-8. On the js target it holds a JavaScript string. A program has exactly
  one `String` class, with no subclasses, so every call on a string is direct.
  [Why not subclasses](#why-not-subclasses) below says what that gave up.
- **The encoding is hidden.** There is no `[](i32)` operator. Strings are
  indexed by an opaque `StringIndex`, Swift-style, that can only lie on a
  character boundary, and byte-level work goes through explicit UTF-8 and
  UTF-16 views.
- **Slicing is a view.** A slice shares its parent's bytes, Go-style, so it
  costs one small object and copies nothing. This can keep a large parent
  alive, so `copy()` makes a slice its own backing array.
- **Parsers walk a `StringReader`** rather than index at random: it keeps a
  position and consumes whitespace, runs of bytes matching a predicate, and
  text up to a delimiter, which also reduces the need for regular expressions.
- **Concatenation in bulk goes through `StringBuilder`**, template literals and
  `join`. Without a rope implementation, piecewise concatenation with `+` in a
  loop takes quadratic time. A compiler warning for it is planned. _Note_: This
  is a provisional decision. It may turn out that the complexity of a
  `StringBuilder` is similar to that of a rope-based `String`, and that the cost
  of several `String` implementations is acceptable. We will need benchmarks.

### Why not subclasses

The earlier plan was a `String` class with a closed set of subclasses sharing
their algorithms through a few virtual primitives (`length`, `byteAt`): one
backed by a GC byte array, a `HostString` holding a JavaScript string, a
`LinearMemoryString` over WASI data, and possibly a `RopeString` for cheap
concatenation.

What happened instead is that the js target got a `String` of its own, chosen
when the program is compiled (`core/string-js.zena` in place of
`core/string.zena`). Each program then has one `String`, which keeps what the
subclasses would have cost out of every program:

- No virtual dispatch on any string operation, and no reliance on the
  optimizer to remove it.
- The struct type is final, which makes casts to it cheap: in wasmtime a cast
  to a final type is a type-index comparison, and a failing cast to an open one
  calls out of JIT code.
- Neither representation's code is linked into a program that uses the other.

The costs are two implementations of the same API to keep in step, and that one
module cannot hold both representations: a byte-target module running in
JavaScript copies every string that crosses the boundary.

Subclasses could still come back for a representation a target needs alongside
its main one: a linear-memory string for zero-copy WASI data, or a rope if `+`
in loops turns out to be common. Either would make `String` non-final and its
calls virtual in a program that uses both kinds; devirtualization could still
make them direct in a program that creates only one.

## Representation

### On the byte targets

```zena
export final class String implements Hashable, Stringable, Iterable<String> {
  #data: ByteArray; // may be shared with other Strings
  #start: i32; // inclusive
  #end: i32; // exclusive
  #encoding: Encoding; // always WTF-8 today
  var #hashCode: i32 = 0; // 0 until computed
}
```

All fields are private, and the compiler leaves `#hashCode` out of the struct
in a program that never reads it. A slice is a new `String` over the same
`#data`:

```zena
let json = await readFile('data.json'); // #start = 0, #end = 10000
let key = json[start..end]; // shares #data
let owned = key.copy(); // its own ByteArray
```

A 10-byte slice of a 10 MB string keeps the 10 MB alive until the slice is
collected. Go makes the same trade with its `string`, and it works well in
practice: most slices are short-lived, and where they are not, `copy()` makes
the ownership explicit.

The `Encoding` field can say `WTF16`, and the views handle a WTF-16 string, but
nothing on the byte targets constructs one: literals, concatenation, the
builder and decoding all produce WTF-8.

::: info Why WTF, not UTF
JavaScript strings can contain unpaired surrogates, so they are not always valid
UTF-16. WTF-8 and WTF-16 are the variants that permit them. Well-formed text is
a subset of both, so valid UTF-8 and UTF-16 behave identically. An unpaired
surrogate reaches a Zena string only from the host or through the deprecated
`sliceBytes`; strings built in Zena keep scalar boundaries.
:::

### On the js target

```zena
export final class String implements Hashable, Stringable, Iterable<String> {
  #handle: externref; // a JavaScript string
}
```

Most operations call the
[JS String Builtins](https://github.com/WebAssembly/js-string-builtins)
(`wasm:js-string`): length, `charCodeAt`, substring, concatenation, equality
and comparison. String literals are imported string constants, so they cost no
code to build. `encoding` reports `WTF16`, and a `StringIndex` is a UTF-16 code
unit offset. A few operations import a JavaScript function instead, where that
is smaller or faster than the same work in Zena: case conversion, `indexOf` and
`replaceAll`.

## Literals

On the byte targets, the bytes of every distinct literal are packed into one
passive data segment. The module copies the segment into one byte array when it
starts, and a literal's first evaluation creates a view onto its part of that
array and caches it by literal, so later evaluations return the same object and
copy nothing.

Strings built at run time are not interned. A parser that wants one object per
distinct identifier can intern with the `StringTable` in `zena:string-reader`
([working notes](https://github.com/elematic/zena/blob/main/docs/design/string-interning.md)).

## Indexing and views

Raw integer indexing (`str[0]`) is rejected at compile time, so code cannot
split a multi-byte UTF-8 sequence or a surrogate pair. `String` is indexed by
`StringIndex` instead:

```zena
export opaque type StringIndex = i32;
```

Outside `zena:core`, `StringIndex` is opaque (`0 as StringIndex` is a compile
error), and every `StringIndex` a `String` produces lies on a Unicode scalar
boundary of that string. At run time it is an unboxed `i32`, an offset in the
string's own encoding: bytes on the byte targets, UTF-16 code units on the js
target. That is why `String` has no byte-level API of its own. The bytes belong
to the views, `str.utf8` and `str.utf16`, and each maps its own offsets back to
`StringIndex` with `indexAt`.

### Navigation

- `str.startIndex` and `str.endIndex` — the first index and the one past the
  end.
- `str.indexAfter(i)` and `str.indexBefore(i)` — the next and previous extended
  grapheme cluster boundary.
- `str.scalarIndexAfter(i)` and `str.scalarIndexBefore(i)` — the next and
  previous code point boundary.
- `str.indexOffsetBy(from, count)` — steps `count` grapheme clusters (backward
  when negative), returning `(false, _)` past either end.
- `str.indexOf(needle)` — where `needle` first occurs, as a `StringIndex`.
- `str.utf8.indexAt(offset)` — the index for a UTF-8 offset into the view, when
  the offset is in `[0, length]` and not on a continuation byte. $O(1)$ when the
  view shares the string's storage; for a WTF-16 string it counts the code units
  of the scalars before the offset. `str.utf16.indexAt` is the same for code
  unit offsets, rejecting one that splits a surrogate pair. An index found in a
  sub-view from `slice` still indexes the whole string.

Indexing with a `StringIndex` returns the grapheme cluster there, and indexing
with a range of them returns a slice. Both share the string's storage:

```zena
let s = 'café😀';
let first = s[s.startIndex]; // "c"
let rest = s[s.indexAfter(s.startIndex)..]; // "afé😀"

if (let (true, pos) = s.indexOf('é')) {
  let prefix = s[..pos]; // "caf"
  let suffix = s[pos..]; // "é😀"
}
```

### Iteration and views

- `for (let g in str)` and `str.graphemes` yield each extended grapheme cluster
  as a slice. `str.reverse()` reverses by grapheme cluster, so combining marks
  and emoji sequences stay intact.
- `str.codePoints` yields Unicode scalar values as `i32`. Like `graphemes`, it
  is a view that allocates nothing of its own.
- `str.utf8` is a view of UTF-8 bytes (`u8`), with $O(1)$ `length`, `utf8[i]`,
  `slice`, `copyTo` and `toArray`. It shares a WTF-8 string's storage and
  transcodes a WTF-16 one, so on the js target it allocates.
- `str.utf16` is a view of UTF-16 code units (`u16`), with $O(1)$ `length`,
  `utf16[i]`, `slice` and `toArray`. It shares a WTF-16 string's storage and
  transcodes a WTF-8 one.

The older byte-oriented members of `String` — `length`, `getByteAt`,
`sliceBytes`, and `codePointAt(index: i32)` — read the string's own encoding,
so their results differ by target. They are `@deprecated` in favor of
`isEmpty`, the views, the counts, and `codePointAt(index: StringIndex)`.

### Lengths

`str.isEmpty`, `str.utf8.length` and `str.utf16.length` are $O(1)$ when the view
shares storage. `str.codePoints.count()` and `str.graphemes.count()` walk the
string.

| String         | `utf8.length` | `utf16.length` | `codePoints.count()` | `graphemes.count()` |
| -------------- | ------------- | -------------- | -------------------- | ------------------- |
| `"hello"`      | 5             | 5              | 5                    | 5                   |
| `"café"`       | 5             | 4              | 4                    | 4                   |
| `"cafe\u0301"` | 6             | 5              | 5                    | 4                   |
| `"😀"`         | 4             | 2              | 1                    | 1                   |
| `"👨‍👩‍👧"`         | 18            | 8              | 5                    | 1                   |

### Grapheme clusters without tables

The `Grapheme_Cluster_Break` tables of UAX #29 run to tens of kilobytes, which
would dominate a small module. `indexAfter` and `indexBefore` approximate the
rules with range checks and arithmetic instead:

1. **CR LF** is one cluster (GB3).
2. **Controls** (`< 0x20`, `0x7F..0x9F`) break before and after (GB4, GB5).
3. **Hangul** syllable sequences join (GB6–GB8). The leading, vowel and
   trailing jamo are ranges, and a precomposed syllable is `LV` or `LVT` by
   `(cp - 0xAC00) % 28`.
4. **Extending characters** never start a cluster (GB9, GB9a): the Combining
   Diacritical Marks blocks, the Cyrillic, Hebrew, Arabic, Devanagari and Thai
   combining marks, ZWJ and ZWNJ, variation selectors, the keycap mark, emoji
   skin-tone modifiers, and the tag characters of subdivision flags.
5. **After a ZWJ** there is no break, which keeps sequences like `👨‍👩‍👧‍👦` and `🏳️‍🌈`
   together (GB11, approximated: the rule does not check that an emoji precedes
   the ZWJ).
6. **Regional indicators** pair two by two, by counting the run backward
   (GB12, GB13), so flags stay whole.

What it does not implement: prepended characters (GB9b), spacing marks outside
the blocks above, and Indic conjunct rules (GB9c). Text in those scripts can
split where UAX #29 would not.

## Building and comparing

- **`a + b`** allocates an array of the combined length and copies both
  strings into it.
- **`StringBuilder`** collects bytes in chunks that double in size.
  `toString()` returns a view of the chunk when there is only one, and
  otherwise copies the chunks into one array. The js target has its own
  builder.
- **Template literals** and **`join(items, separator)`** are the other ways to
  build a string from parts.
- **`==`** compares by value: the same object, then the lengths, then the two
  cached hash codes when both are computed, then the bytes.
- **`hashCode()`** is 32-bit FNV-1a over the bytes, computed once and kept in
  `#hashCode`; a hash of 0 is stored as 1, so 0 can mean "not computed". On the
  js target it is computed over the UTF-16 code units each time, since the
  object holds only the JavaScript string.
- **`compareTo`** compares bytes, which in UTF-8 is code point order.

## Case conversion

Case conversion is the clearest instance of the binary-size goal above in
tension with the Unicode-safety one. Doing it correctly takes data, and on most
targets that data has to ship in the binary.

### How Unicode defines case

Whether a character is upper- or lowercase and what it converts to are separate
facts in the Unicode Character Database:

- **Properties.** The general category says whether a letter is uppercase
  (`Lu`), lowercase (`Ll`) or titlecase (`Lt`, the digraphs `ǅ` `ǈ` `ǋ` `ǲ`).
  The derived `Lowercase` and `Uppercase` properties add characters that are
  not letters of those categories but behave like them, such as `ª`, the
  modifier letter `ʰ` and the circled `Ⓐ`. `Cased` is the union of the three.
- **Mappings.** `UnicodeData.txt` gives each code point at most one simple
  upper-, lower- and titlecase mapping. `SpecialCasing.txt` adds the mappings
  to several code points (`ß` → `SS`, `ﬃ` → `FFI`, `İ` → `i̇`) and the
  conditional ones: Final_Sigma, and language-specific rules for Turkish,
  Azeri and Lithuanian.

The two disagree more than one might expect. `ℂ` is uppercase and has no
lowercase, `ĸ` is lowercase and has no uppercase, and `ß` has an uppercase only
as two letters. A conversion follows the mappings; the properties matter only
to Final_Sigma.

Unicode's default case conversion (section 3.13 of the standard) applies the
full mappings, unconditional and Final_Sigma, and leaves out the
language-specific ones. That is what JavaScript's `toLowerCase` and
`toUpperCase` do, and Rust's and Python's. (Java's `toLowerCase()` uses the
default locale, so it applies the Turkish rules on a Turkish system.)

### What Zena provides

- `toLowerCase()` and `toUpperCase()` apply the default case conversion, with
  the same result as JavaScript. On the js target they call the host's methods,
  since the host already carries the data. On the other targets they read
  tables compiled into the module.
- `asciiLowerCase()` and `asciiUpperCase()` change only `A`–`Z` and `a`–`z`.
  They are for text that is ASCII by definition — header names, URL schemes,
  hexadecimal digits — where Unicode mapping would be wrong as well as
  costly: `'ﬁle'.toUpperCase()` is `'FILE'`, and a protocol keyword should
  not be produced by a ligature.

All four return the string itself, without allocating, when nothing changes.
There are no locale-sensitive or titlecase variants.

### The tables

A generator, `packages/stdlib/scripts/generate-case-tables.js`, reads
`UnicodeData.txt`, `SpecialCasing.txt` and `DerivedCoreProperties.txt` and
writes five tables into `core/case-tables.zena`, a file of its own whose
header describes the encoding. Before writing, it checks every
code point's mapping against Node's ICU when the Unicode versions match. For
Unicode 17.0:

| Table                     | Contents                                        | Entries | Bytes |
| ------------------------- | ----------------------------------------------- | ------- | ----- |
| `CASE_RANGES`             | One-to-one mappings, as ranges sharing a delta  | 329     | 1,735 |
| `UPPER_SPECIALS`          | Uppercase mappings to several code points       | 102     | 835   |
| `LOWER_SPECIALS`          | Lowercase mappings to several code points (`İ`) | 1       | 8     |
| `CASED`, `CASE_IGNORABLE` | The two properties Final_Sigma reads            | 622     | 1,585 |

A range covers either a run of code points with the same upper and lower
deltas (`а`–`я` are all 32 below `А`–`Я`) or a run of alternating
uppercase/lowercase pairs (`Ā ā Ă ă …`), which is how most of Latin Extended
and Cyrillic is laid out.

Each table is a string literal of printable ASCII: a stream of variable-length
integers with five payload bits per byte, as the IDNA table in `zena:url` is.
A string literal is the cheapest constant data a module can hold — it sits
in a data segment, with no code to construct it — and the streams are under a
quarter of the size of the decoded tables, 4,163 bytes against 18,512. On the
first call, a table is decoded into a sorted `FixedArray<i32>` that lookups
binary-search.
`packages/stdlib/dev/case-difftest.js` compares both methods with JavaScript
over every code point and over 20,000 strings built to exercise Final_Sigma.

The lookups are in `core/case-mapping.zena`, which `core/string.zena`
imports for the two methods. The tables can be string literals in a library
`String`'s own module depends on because the compiler orders a module with
string literals after the module declaring `String`, which puts such a
library on a cycle with it
([#752](https://github.com/elematic/zena/pull/752)).

### What it costs

`toLowerCase` and `toUpperCase` have separate loops, so a program links only
the tables of the methods it calls. Over an empty freestanding module at
`-O2`:

| Calls            | Adds   |
| ---------------- | ------ |
| `asciiLowerCase` | 0.6 KB |
| `toUpperCase`    | 4.6 KB |
| `toLowerCase`    | 5.8 KB |

About 1.7 KB of `toLowerCase` is Final_Sigma: the `CASED` and
`CASE_IGNORABLE` tables, which nothing else reads, and the scan around each
`Σ`. A rule that approximates both properties with the mapping tables would
save it and differ from JavaScript in rare contexts;
[#750](https://github.com/elematic/zena/issues/750) measures where. For now
the methods match JavaScript exactly, so a program gives the same answer on
every target.

### Case-insensitive comparison

Zena has no case-insensitive comparison yet. Unicode's tool for it is case
folding (`CaseFolding.txt`), and neither conversion alone is a substitute:

- Comparing lowercase forms treats as different 23 groups of characters that
  folding treats as equal, among them `s` and `ſ`, `μ` and the micro sign `µ`,
  `σ` and `ς`, `θ` and `ϑ`. `ß` lowercases to itself and `SS` to `ss`.
- Comparing uppercase forms treats the Kelvin sign `K` as different from `k`,
  `Å` from the Ångström sign, and `Ω` from the Ohm sign, and treats dotless `ı`
  as equal to `i`.

Lowercasing the uppercase form, one code point at a time and so without
Final_Sigma, gives exactly the equivalence of full case folding on every
string, with two exceptions to patch: `ẞ` (U+1E9E) must become `ss` rather
than `ß`, and `ı` must stay `ı`. (Checked by testing, for every code point,
that each form is a function of the other.) So a comparison needs no tables
beyond the conversion tables: it reads the three mapping tables, but not
Final_Sigma's two, and can fold both strings one code point at a time as it
compares them, without allocating either folded form.

## Host interop

On the js target nothing is copied: a `String` holds the JavaScript string,
and the compiler's `$stringGetHandle` export hands it over as it is.

On the byte targets, a `String` is a Wasm GC struct wrapping a GC array. Both
are opaque to the host: JavaScript cannot read a GC struct's fields, and a GC
array cannot be viewed as a typed array. Every string crossing to JavaScript is
copied.

### Which side runs the loop

Wasm calling the host once per byte is the slow approach. The advice, from the
dart2wasm team in
[WebAssembly/gc#568](https://github.com/WebAssembly/gc/issues/568), is to invert
it: pass the string to the host as an `externref` and let the host drive the
loop, calling a small exported function to read each byte, "because V8 optimizes
JS calling Wasm better than Wasm calling JS." dart2wasm ships exactly this, as
`$wasmI8ArrayGet`.

The compiler emits helpers for this when a `String` crosses one of the
module's exports or host imports, and only for the direction it crosses in:

| Export             | Signature                     | Direction   |
| ------------------ | ----------------------------- | ----------- |
| `$stringGetLength` | `(externref) -> i32`          | Wasm → host |
| `$stringGetByte`   | `(externref, i32) -> i32`     | Wasm → host |
| `$stringCreate`    | `(i32) -> externref`          | host → Wasm |
| `$stringSetByte`   | `(externref, i32, i32) -> ()` | host → Wasm |

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

## Not done yet

- **`+` in a loop has no warning**, so the quadratic-time foot gun is
  unguarded.
- **The byte-indexed API still exists**, deprecated. `StringReader` positions,
  from `mark()`, are still `i32` byte offsets used with `sliceBytes`.
- **There are no `String` subclasses**: no rope, no linear-memory string, and no
  host string in a byte-target module.
- **WTF-16 exists only on the js target.** On the byte targets nothing produces
  a WTF-16 string, and there is no option to make literals WTF-16.
- **Grapheme segmentation is approximate**, as described above.
- **No case-insensitive comparison**, and no locale-sensitive operations.
- **Batch transcoding.** Many `utf8` views of slices of one WTF-16 string, or
  `utf16` views of one WTF-8 string, transcode the shared part once per slice. A
  batch API could transcode the backing array once.

## What operations cost

| Operation                                     | Time           | Allocates                                      | Shares storage |
| --------------------------------------------- | -------------- | ---------------------------------------------- | -------------- |
| `str[start..end]`, `slice`                    | $O(1)$         | the `String` struct                            | yes            |
| `str[i]` (one grapheme cluster)               | cluster length | the `String` struct                            | yes            |
| `str.copy()`                                  | $O(n)$         | a byte array and a struct                      | no             |
| `str.reverse()`                               | $O(n)$         | a byte array and a struct                      | no             |
| `str + other`                                 | $O(n)$         | a byte array and a struct                      | no             |
| `str == other`                                | $O(n)$         | nothing                                        | —              |
| `str.hashCode()`                              | $O(n)$, once   | nothing                                        | —              |
| `str.isEmpty`                                 | $O(1)$         | nothing                                        | —              |
| `str.utf8`, `str.utf16` (same encoding)       | $O(1)$         | the view struct                                | yes            |
| `str.utf8`, `str.utf16` (transcoded)          | $O(n)$         | a byte array and a view                        | no             |
| `view[i]`, `view.length`                      | $O(1)$         | nothing                                        | —              |
| `view.indexAt(i)` (same encoding)             | $O(1)$         | nothing                                        | —              |
| `view.indexAt(i)` (transcoded)                | $O(n)$         | nothing                                        | —              |
| `str.codePoints.count()`, `graphemes.count()` | $O(n)$         | nothing                                        | —              |
| `toLowerCase()`, `toUpperCase()`              | $O(n)$         | a byte array and a struct, if anything changes | no             |

The table is for the byte targets. On the js target the engine decides, and
`str.utf8` always transcodes.
