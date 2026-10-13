# Typed Documents

Status: **Proposed.** Nothing here is built.

## Overview

A Firestore document's fields are a `map<string, Value>`, and `Value` is a
tree of strings, numbers, maps and lists. A JSON document is the same kind
of tree. A program usually holds its data in its own types instead:

```zena
type Post = {
  title: String,
  views: i64,
  tags: Array<String>,
  author?: Author,
};
```

Moving a `Post` into a document and back takes conversion code. Today that
code is written by hand. With the Firestore client
([protobuf.md](protobuf.md)) it looks like this:

```zena
let toFields = (post: Post): Fields => {
  let fields = new Fields()
    .string('title', post.title)
    .integer('views', post.views)
    .array('tags', post.tags.map((t) => stringValue(t)));
  if (let {author} = post) {
    fields.map('author', authorFields(author));
  }
  return fields;
};

let fromSnapshot = (s: DocumentSnapshot): Post => {
  // ... a getter per field, a check per getter, an error per check
};
```

The JSON side has the same shape. `package-manifest.zena` in the compiler
and `server.zena` in the language service each read JSON with a
`stringAt`/`objectAt` call per field.

This document designs a way to get that code from the compiler. The
compiler generates, for any type a program converts, a pair of functions:
one that writes a value through a format-independent `Encoder`, and one
that reads it back through a `Decoder`. Firestore and `zena:json` each
supply one `Encoder` and one `Decoder`. The Firestore client then offers
typed collections:

```zena
let posts = db.collection<Post>('posts');
await posts.doc('hello').set({title: 'Hello', views: 0, tags: []});
let post = await posts.doc('hello').get();
if (let (true, data) = post.data()) {
  console.log(data.title);
}
```

## Goals

- Conversion code for records, case classes, enums, sealed classes,
  arrays, maps and nullable types is generated, typed, and checked.
- One generated encoder and decoder per type serves every format.
- A program pays only for the types it converts, in the directions it
  converts them.
- Decoding reports what went wrong and where: `posts/hello: field
'views': expected an integer, found a string`.
- Per-field options (a different key, a field left out) and per-type
  options (a sealed class's discriminator field) are decorators.
- A type the generator cannot handle can supply its own codec.

## Non-goals

- Streaming decode, where values are read as their bytes arrive. Both
  sources this document targets are already trees when the conversion
  runs: Firestore responses are decoded `Value` views, and `zena:json`
  parses to `JsonValue`.
- Schema evolution beyond optional fields. A field added later is
  declared optional (`f?: T`), and a document without it decodes.
- Typed field paths in queries (`where(Post.views, ...)`). They need
  label types (`keyof`), which [row-types.md](row-types.md) defers.
- Typed partial updates. They need a `Partial<T>` type operator, which
  [record-presence.md](record-presence.md) designs and nothing
  implements.

## Background

What the language offers today, and what it lacks, decides the design.

**Records with optional fields** (implemented,
[record-presence.md](record-presence.md)). `{author?: Author}` is a
record whose `author` may be absent. The record stores a presence bitmask,
and code reads the field through `??`, `if (let {author} = post)`, or a
pattern. An absent field and a document missing the key mean the same
thing, so optional fields map onto absent keys with no extra convention.

**Case classes, sealed classes and enums** (implemented). A case class
`class Point(x: f64, y: f64)` has a constructor whose parameters are its
fields, so it can be rebuilt from its fields. A sealed class is a closed
set of cases a `match` covers exhaustively, so a generated decoder can
switch over them. An enum is an `i32`-backed or string-backed union of
literals ([enums.md](enums.md)). Nothing maps an enum's string back to a
member at runtime.

**Compiler-synthesized members** (implemented). The checker gives a case
class `==` and `hashCode` signatures (`synthesizeCaseClassMembers` in
`checker.zena`), and lowering builds their bodies directly in IR from the
struct's fields (`lowerCaseClassEq` in `codegen/ir/equality.zena`).

**Type-directed intrinsics** (implemented). `equals<T>(a, b)` and
`hash<T>(v)` (`core/hashable.zena`) are declared once and lowered per type
argument: each specialization of a generic function that calls them gets
the comparison its `T` needs. The conversion functions in this design are
two more of these.

**Source synthesis** (implemented, for WIT). `wit-module-synth.zena`
renders Zena source from a WIT file, with the `zena` template tag in
`code-template.zena`, and the compiler checks and compiles it like any
other module.

**Checking driven by reachability** (implemented,
[lazy-body-checking.md](lazy-body-checking.md)). The checker leaves the
bodies of dependency modules for reachability to request, so checking is
already re-entrant from the reachability walk.

**Decorators** (partly implemented, [decorators.md](decorators.md)). The
builtin `@intrinsic` and `@external` apply to declared functions, and to
methods. A library can declare a field decorator with the `decorator`
keyword; it replaces a class field with an accessor. Decorators with
arguments (`@key('x')`) and dotted names parse everywhere but are errors
in the checker. At module level a decorator can only precede `declare`.

**Absent:** runtime reflection (a program cannot list a type's fields),
macros ([macros.md](macros.md) designs syntactic macros that run before
type checking; none exist), and label or mapped types.

## Detailed design

### The data model

Every format reads and writes the same small set of values:

| Data model value | Firestore `Value`    | JSON                       |
| ---------------- | -------------------- | -------------------------- |
| null             | `nullValue`          | `null`                     |
| boolean          | `booleanValue`       | `true`/`false`             |
| integer (i64)    | `integerValue`       | number (string above 2^53) |
| double (f64)     | `doubleValue`        | number                     |
| string           | `stringValue`        | string                     |
| bytes            | `bytesValue`         | base64 string              |
| timestamp        | `timestampValue`     | RFC 3339 string            |
| list             | `arrayValue`         | array                      |
| map              | `mapValue`           | object                     |
| format value     | reference, geo point | (none)                     |

The JSON integer rule follows protobuf's JSON mapping: an `i64` whose
magnitude exceeds 2^53 cannot round-trip through a JavaScript number, so
it is written as a string, and the decoder accepts both forms.

A timestamp is in the data model because both formats have a natural
encoding for one and every application stores times. The standard library
has a monotonic `Instant` but no wall-clock time type yet; see [Open
questions](#open-questions).

A **format value** is a value one format has and the others do not, such
as a Firestore document reference. A type that holds one supplies its own
codec, which asks the encoder whether it supports the value (see [Custom
codecs](#custom-codecs)).

### Encoder and Decoder

A new standard library module, `zena:codec`, declares the two interfaces:

```zena
export interface Encoder {
  null_(): void;
  boolean(value: boolean): void;
  integer(value: i64): void;
  double(value: f64): void;
  string(value: String): void;
  bytes(value: ByteArray): void;
  timestamp(seconds: i64, nanos: i32): void;

  beginList(length: i32): void;
  endList(): void;

  /** A map, written as `key` followed by the key's value, repeatedly. */
  beginMap(): void;
  key(name: String): void;
  endMap(): void;
}

export interface Decoder {
  kind: ValueKind;
  boolean(): boolean;
  integer(): i64;
  double(): f64;
  string(): String;
  bytes(): ByteArray;
  timestamp(): inline (i64, i32);

  /** The list's elements; throws unless `kind` is `List`. */
  length: i32;
  element(index: i32): Decoder;

  /** The value at `name` in a map: `(true, decoder)` or `(false, _)`. */
  field(name: String): inline (true, Decoder) | inline (false, _);
  keys(): Iterator<String>;

  /** Where this value sits in the document, for errors: `author.name`. */
  path: String;
}
```

The encoder writes in order, so it can stream: the JSON encoder can be
`JsonBuilder` itself, and the Firestore encoder builds a `Value` tree. The
decoder reads by key in any order, which both trees allow and which
decoding a record needs, since a document's keys come in any order.

Each typed read throws a `DecodeError` naming the path, what was expected
and what was found. `double()` also accepts an integer, because JSON does
not distinguish them and Firestore stores `1.0` written from JavaScript as
the integer `1`.

### Generated conversions

Two type-directed intrinsics in `zena:codec` do the work:

```zena
@intrinsic('codec.encode')
export declare function encode<T>(value: T, out: Encoder): void;

@intrinsic('codec.decode')
export declare function decode<T>(input: Decoder): T;
```

They are separate functions, not one `Codec<T>` object, so a program that
only writes a type carries no decoder for it, and the reverse. Library
code calls them from generic functions: `TypedCollection<T>.set` calls
`encode<T>`, and each specialization of `set` gets the encoder for its
`T`, the way each specialization of `HashMap<K, V>` gets the `hash` for
its `K`.

For each type argument the compiler generates the two functions as Zena
source, checks them, and compiles them as ordinary functions (see
[Synthesis](#synthesis)). For `Post` the encoder is:

```zena
let encode_Post = (value: Post, out: Encoder): void => {
  out.beginMap();
  out.key('title');
  out.string(value.title);
  out.key('views');
  out.integer(value.views);
  out.key('tags');
  encode_Array_String(value.tags, out);
  if (let {author} = value) {
    out.key('author');
    encode_Author(author, out);
  }
  out.endMap();
};
```

and the decoder:

```zena
let decode_Post = (input: Decoder): Post => {
  let title = requiredField(input, 'title').string();
  let views = requiredField(input, 'views').integer();
  let tags = decode_Array_String(requiredField(input, 'tags'));
  if (let (true, author) = input.field('author')) {
    return {title, views, tags, author: decode_Author(author)};
  }
  return {title, views, tags};
};
```

The record literal at the end sets `author` only when the key is present,
so the decoded record's presence matches the document's. A record with
several optional fields is built from parts the way the Firestore client
builds a query ([protobuf.md](protobuf.md)): the generated code assigns
each present field through a spread.

The rules, by type:

| Type                                            | Encoded as                                   |
| ----------------------------------------------- | -------------------------------------------- |
| `i8`…`i64`, `u8`…`u32`                          | integer; decode checks the range             |
| `u64`                                           | integer; decode rejects values above i64 max |
| `f32`, `f64`                                    | double                                       |
| `boolean`, `String`                             | boolean, string                              |
| `ByteArray`                                     | bytes                                        |
| string-backed enum                              | string; decode rejects an unknown value      |
| `i32`-backed enum                               | integer; decode rejects an unknown value     |
| `T \| null`                                     | null, or `T`                                 |
| record                                          | map with a key per field                     |
| optional field `f?: T`                          | key omitted when absent                      |
| case class                                      | map with a key per constructor parameter     |
| sealed class                                    | map with a discriminator key; see below      |
| `Array<T>`, `GrowableArray<T>`, `FixedArray<T>` | list                                         |
| `Map<String, T>`, `HashMap<String, T>`          | map                                          |

A type that is none of these, and has no codec of its own, is a compile
error at the call that needed it, naming the path to the offending field:
`cannot encode Post: field 'session' has type Session, a class with no
codec`. Interfaces, functions, and ordinary classes (whose state may be
private and whose constructor need not take their fields) are in this
group.

A **sealed class** is a map whose `type` key holds the case's name, and
whose other keys are the case's fields. A unit case is a map holding only
the `type` key. The decoder reads `type`, then decodes the matching case.
`@tag` and `@variant` change the key and the names (see
[Decorators](#decorators)).

**Recursive types** work because each type's functions are named and call
each other: `encode_Tree` calls `encode_Tree` for its children.

**Generic types** are generated per instantiation. `Page<Post>` gets
`encode_Page_Post`, which calls `encode_Post`.

**Unknown keys** are ignored when decoding, so a document written by a
newer version of a program, with a field this version does not declare,
still decodes.

### Decorators

Options attach to declarations as decorators that carry data and change
nothing else. `zena:codec` declares them:

| Decorator          | Placed on                               | Effect                                   |
| ------------------ | --------------------------------------- | ---------------------------------------- |
| `@key('name')`     | record field, case-class parameter      | the field's key in the document          |
| `@skip`            | optional field, or field with a default | never written; decoded as absent/default |
| `@tag('kind')`     | sealed class                            | the discriminator key (default `type`)   |
| `@variant('post')` | sealed case                             | the case's discriminator value           |
| `@codec(expr)`     | type declaration, field                 | use this codec instead of generating one |

```zena
type Post = {
  title: String,
  @key('created_at') createdAt: Timestamp,
  @skip draft?: boolean,
};

@tag('kind')
sealed class Shape {
  @variant('circle') case Circle(radius: f64)
  case Square(side: f64)
}
```

A key matters beyond the code: it is the stored format. Renaming a field
in source renames the key in every document written afterward, and
documents written before no longer decode the field. `@key` keeps the old
name when the field's name changes.

This needs three things decorators do not have today:

- **Data decorators.** A declaration that names a decorator and its
  parameters, with no body: `export declare decorator key(name: String);`.
  Applying one records the decorator and its arguments on the
  declaration. It adds no members and replaces nothing. The generator
  reads the decorators by their declaration's identity, so a program can
  import `key` under another name.
- **Arguments.** For data decorators, arguments are constant expressions:
  literals, enum members, and, for `@codec`, a reference to a module-level
  `let`. The checker types each against the decorator's parameter.
  [decorators.md](decorators.md) lists arguments as not yet implemented
  for field decorators, whose open question (when a splice is evaluated)
  does not arise here: a data decorator's arguments are read by the
  compiler, not spliced into code.
- **Positions.** Record fields in a type literal, case-class parameters,
  sealed `case` declarations, class declarations, and type alias
  declarations, besides the class fields decorators reach today. At
  module level, a decorator may then precede `type`, `class`, `sealed
class` and `enum` as well as `declare`.

### Custom codecs

A type the generator cannot handle, or one whose stored form should differ
from its fields, supplies a codec:

```zena
export interface Codec<T> {
  encode(value: T, out: Encoder): void;
  decode(input: Decoder): T;
}

let instantCodec: Codec<UtcTime> = ...;

@codec(instantCodec)
export final class UtcTime { ... }
```

`encode<T>` and `decode<T>` call the codec where the generator would have
generated code, so a type with `@codec` can sit inside generated types.
A type from another package that cannot be decorated takes `@codec` on
each field that holds it.

A codec that needs a format value asks the encoder for it:

```zena
export interface ReferenceEncoder {
  reference(name: String): void;
}

final class ReferenceCodec implements Codec<DocumentReference> {
  encode(ref: DocumentReference, out: Encoder): void {
    if (out is ReferenceEncoder) {
      (out as ReferenceEncoder).reference(ref.name);
    } else {
      out.string(ref.name);
    }
  }
  decode(input: Decoder): DocumentReference { ... }
}
```

The Firestore encoder implements `ReferenceEncoder`; the JSON encoder does
not, so the same type writes a reference to Firestore and its name to
JSON.

### Synthesis

The generator works on resolved types after checking, because it needs
facts only the checker has: what `Post` names, which of its fields are
optional, what an alias stands for, which declaration a decorator
resolves to.

It produces Zena source, like `wit-module-synth.zena`:

1. When reachability reaches a specialization whose body calls
   `encode<T>` or `decode<T>` with a concrete `T`, it asks the generator
   for that type's function.
2. The generator walks `T` and the types it contains, and renders one
   function per type and direction not already generated, into a
   synthesized module for the compile.
3. The checker checks the new functions. This is the same re-entrant
   request reachability already makes for a dependency's deferred bodies.
4. Lowering replaces the intrinsic call with a call to the generated
   function.

Generating source keeps the generator small. Field reads, record
construction with presence bits, `match` over sealed cases, and calls
into `Encoder` are all existing language features, so the generator
writes them as Zena and lets the checker and lowering do the rest. The
case-class `==` built in IR is the counterexample: its body is short, but
the conversions call library interfaces, build records with presence
masks and dispatch over sealed cases, and each of those would be new IR
construction code.

The generated source refers to types and decorators by their resolved
symbols, not by name. A type declared without `export`, in a module the
synthesized module does not import, is still nameable there. The checker
needs a form of type reference that names a symbol directly, which only
generated code can write. `ZENA_DUMP_SYNTHESIZED=1` writes the generated
source next to the output, for reading and for bug reports.

### Cost

A converted type costs one function per direction used, with about one
encoder or decoder call per field. That is the code a person would write
by hand, minus the code a person would write for errors, which here is a
shared helper.

The calls go through the `Encoder` and `Decoder` interfaces. A program
that uses one format, which is most programs, has one class implementing
each interface. The `-O2` devirtualizer turns a call into a direct call
when every vtable that could hold the slot installs the same function
(`devirt.zena`); whether that covers these interface calls, and what they
cost when it does not, is measured in the first step of the
[Plan](#plan), where hand-written codecs make the same calls.

A program pays nothing for a type it does not convert: no function is
generated for it, and nothing is recorded about it at runtime.

### Firestore

`google-cloud:firestore` adds typed views over the untyped client:

```zena
let posts: TypedCollection<Post> = db.collection<Post>('posts');

await posts.doc('hello').set(post);           // encode<Post>
await posts.add(post);
let snapshot = await posts.doc('hello').get();
if (let (true, data) = snapshot.data()) { ... } // decode<Post>
for await (let s in posts.where('views', Operator.GreaterThan, integerValue(100)).stream()) {
  ...
}
await db.runTransaction(async (tx) => {
  let current = await tx.get(posts.doc('a'));
  ...
});
```

`snapshot.data()` answers `(false, _)` for a document that does not exist
and throws a `DecodeError` for one that does not match `Post`. `update`,
field transforms and queries keep their untyped forms: their field names
are strings, and a key changed with `@key` is the name to write there.

### JSON

`zena:json` adds:

```zena
export let parseJsonAs = <T>(text: String): T => decode<T>(new JsonDecoder(parseJson(text)));
export let stringifyAs = <T>(value: T): String => { ... encode<T>(value, builder) ... };
```

The compiler's `package-manifest.zena` is the first internal user: its
hand-written parsing becomes a record type and one `parseJsonAs` call.

## Plan

1. `zena:codec` with `Encoder`, `Decoder`, `Codec<T>` and `DecodeError`;
   Firestore and JSON implementations of both interfaces; typed
   Firestore collections that take an explicit `Codec<T>`. This needs no
   compiler change and is usable with hand-written codecs.
2. Data decorators: declarations, constant arguments, and the new
   positions.
3. `encode<T>` and `decode<T>`: synthesis for primitives, records,
   optional fields, case classes, enums, arrays, maps and nullable types,
   then sealed classes and the decorators. Typed collections switch from
   an explicit codec to the intrinsics.
4. `package-manifest.zena` and the language service's JSON handling move
   to `parseJsonAs`.

## Alternatives considered

**Runtime reflection.** A program could read a table of each type's
fields at runtime, and one library function per format could walk it.
Zena records no such table today. Every reflected type would carry its
table whether converted or not, primitive fields would have to be boxed
to pass through a uniform interface, and decoding would still need a way
to construct the type. Generated code has none of those costs.

**Procedural macros.** [macros.md](macros.md) designs macros that run
after parsing and before type checking, invoked at expression sites. A
macro would see `Post`'s field names as written, but not what an alias
stands for, what an imported type is, or a field's inferred type, and it
has no form that attaches to a declaration. Macros are also unbuilt. If
they arrive, the generator here could be exposed through them.

**Synthesis in IR**, as case-class `==` is built. Discussed under
[Synthesis](#synthesis): the conversions are mostly calls into library
interfaces and record construction, which source expresses directly and
IR would need new construction code for.

**One generator per format** (`toFirestore<T>`, `toJson<T>`). Each format
would need its own generator in the compiler, and a new format would need
a compiler change. With one data model and per-format encoders, a format
is a library.

**A required opt-in decorator** (`@codable type Post = ...`). Requiring
one makes conversion a visible part of a type's contract. Without it, any
record or case class converts. This document leaves `encode<T>` working
on any eligible type, because the call that converts already makes the
choice visible, but lists it as an open question.

## Open questions

- **Opt-in.** Whether a type must be marked (`@codable`) before
  `encode<T>` accepts it.
- **Wall-clock time.** Firestore has `Timestamp`, generated from its
  protos. The standard library needs a wall-clock time type for the data
  model's timestamp to map to; `zena:time` has only the monotonic
  `Instant` and `Duration`.
- **Strict decoding.** Whether to offer a mode that rejects unknown keys.
- **Integer keys.** Whether `Map<i32, T>` encodes, with keys written as
  decimal strings, as protobuf's JSON mapping does.
- **Naming conventions.** Whether a type-level option (`@keys('snake')`)
  should rename every field, for JSON APIs that use `snake_case`.
