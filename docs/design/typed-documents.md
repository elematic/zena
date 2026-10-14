# Typed Documents

Status: **Proposed.** Nothing here is built.

## Overview

Programs exchange data with the outside world as documents: a JSON request
body, a configuration file, a record in a document database such as
Firestore. A document is a tree built from a few kinds of values: null,
booleans, numbers, strings, lists, and maps from string keys to values.
Inside the program the same data lives in the program's own types:

```zena
class Package(name: String, version: String, dependencies: Array<String>)
```

Turning a `Package` into a document is **encoding**, and turning a document
back into a `Package` is **decoding**. Together they are serialization.
Many languages derive this code from the type, either at runtime through
reflection (Java, C#, Go's `encoding/json`) or at compile time from a
declaration's fields (Rust's serde, Swift's `Codable`, Kotlin's
`kotlinx.serialization`).

Zena has neither, so this code is written by hand. Reading a package
manifest with `zena:json` takes one call per field and one check per call:

```zena
let readPackage = (json: JsonObject): Package => {
  var name = '';
  if (let (true, value) = json.stringAt('name')) {
    name = value;
  } else {
    throw new ManifestError('missing "name"');
  }
  // ... the same for every other field, and a loop for the list
};
```

Writing to Firestore is the same work with a different API, and each
format a program uses needs its own copy. `package-manifest.zena` in the
compiler and `server.zena` in the language service are both written this
way.

This document designs compile-time serialization for Zena:

- A declaration opts in with `@codable`. When the compiler checks the
  declaration, it generates an encoder and a decoder for it, as it
  generates `==` for a case class.
- The generated code writes through a format-independent `Encoder` and
  reads through a `Decoder`, declared in a new module, `zena:codec`.
- Each format is a library that implements those two interfaces:
  `zena:json` for JSON, the Firestore client for Firestore documents.
- Decorators on the declaration choose keys, discriminators and custom
  conversions, and add value constraints such as ranges and patterns.
- The same description of a type also produces its JSON Schema.

With that, the manifest is:

```zena
@codable
class Package(name: String, version: String, dependencies: Array<String> = [])

let manifest = parseJsonAs<Package>(text);
```

and a typed Firestore collection is:

```zena
@codable
class Post(title: String, views: i64, tags: Array<String>)

let posts = db.collection<Post>('posts');
await posts.doc('hello').set(new Post('Hello', 0, []));
let post = await posts.doc('hello').get();
```

## Goals

- Encoders and decoders for classes, sealed classes, enums, lists, maps
  and nullable types are generated, typed and checked.
- One generated encoder and decoder per type serves every format.
- A program carries code only for the types it converts, in the
  directions it converts them.
- A type that cannot be converted is reported in the editor, where it is
  declared or where it is used.
- Decoding reports what went wrong and where: `posts/hello: field
'views': expected an integer, found a string`.
- A JSON Schema can be produced from a type, including its value
  constraints.
- A type the generator cannot handle can supply its own codec.

## Non-goals

- Structural records. A record type (`{title: String}`) has no
  declaration to put `@codable` or field options on, because a type alias
  is only another name for the structure. See [Open
  questions](#open-questions).
- Streaming decode, where values are read as their bytes arrive. JSON and
  Firestore documents are already trees by the time a program converts
  them: `zena:json` parses to `JsonValue`, and Firestore responses are
  decoded `Value` messages.
- Schema evolution beyond defaults and nullable fields. A field added
  later has a default or a nullable type, and a document without the key
  still decodes.
- Generating Zena types from a JSON Schema. That is a generator from a
  schema to source, like the protobuf generator ([protobuf.md](protobuf.md)),
  and would be its own design.
- Typed field paths in queries and typed partial updates. They need label
  types (`keyof`) or a `Partial<T>` operator, which
  [row-types.md](row-types.md) and [record-presence.md](record-presence.md)
  defer.

## Background

What the language offers today decides much of the design.

**Classes, sealed classes and enums** (implemented). The concise class
syntax `class Point(x: f64, y: f64)` declares a class whose constructor
takes its fields; the compiler also derives `==` and `hashCode` for it. A
class written out in full can do the same with `this.` constructor
parameters: `new(this.x, this.y)`. A sealed class is a closed set of cases
that a `match` covers exhaustively; its cases are classes, usually written
concisely. An enum is an `i32`-backed or string-backed set of named values
([enums.md](enums.md)). These are **nominal** types: each has a
declaration, and two declarations with the same fields are different
types.

**Type aliases and records are structural.** `type Post = {title: String}`
gives a record type a second name; any value of type `{title: String}` is
a `Post`. An option attached to the alias's field would be lost wherever
the same value is typed by its structure.

**Compiler-synthesized members** (implemented). The checker gives a case
class `==` and `hashCode`, and lowering builds their bodies
(`synthesizeCaseClassMembers` in `checker.zena`, `lowerCaseClassEq` in
`codegen/ir/equality.zena`). A case class implicitly implements
`Hashable`, so a generic `HashMap<K extends Hashable, V>` accepts it.

**Type-directed intrinsics** (implemented). `equals<T>(a, b)` and
`hash<T>(v)` (`core/hashable.zena`) are declared once and lowered per type
argument: each specialization of a generic function that calls them gets
the comparison its `T` needs.

**Source synthesis** (implemented, for WIT). `wit-module-synth.zena`
renders Zena source from a WIT file with the `zena` template tag in
`code-template.zena`, and the compiler checks and compiles the result like
any other module.

**Decorators** (partly implemented, [decorators.md](decorators.md)). The
builtin `@intrinsic` and `@external` apply to declared functions and to
methods. A library can declare a field decorator with the `decorator`
keyword; it replaces a class field with an accessor. Decorators with
arguments (`@key('x')`) parse everywhere and are errors in the checker. At
module level a decorator can only precede `declare`.

**Absent:** runtime reflection (a program cannot list a type's fields),
macros ([macros.md](macros.md) designs syntactic macros that run before
type checking; none exist), and label or mapped types.

## Detailed design

### The data model

Every format reads and writes the same set of values:

| Value       | JSON                       | Firestore `Value`    |
| ----------- | -------------------------- | -------------------- |
| null        | `null`                     | `nullValue`          |
| boolean     | `true`/`false`             | `booleanValue`       |
| integer     | number (string above 2^53) | `integerValue`       |
| double      | number                     | `doubleValue`        |
| string      | string                     | `stringValue`        |
| bytes       | base64 string              | `bytesValue`         |
| timestamp   | RFC 3339 string            | `timestampValue`     |
| list        | array                      | `arrayValue`         |
| record      | object                     | `mapValue`           |
| map         | object                     | `mapValue`           |
| format data | (none)                     | reference, geo point |

A **record** is a value with a fixed set of named fields, known from the
type: a class's document fields. A **map** has keys known only at
runtime: a `Map<String, T>`. JSON and Firestore write both as objects, so their
encoders treat them alike. Formats that have no maps, such as a binary
format that writes a record's fields by position, can tell them apart:
the encoder learns the field count and each field's index when it writes
a record, and has no such information for a map.

An `i64` above 2^53 in magnitude cannot round-trip through a JavaScript
number, so JSON writes it as a string and reads either form, as
protobuf's JSON mapping does.

A timestamp is in the data model because both formats have a native
encoding for one and most applications store times. The standard library
has a monotonic `Instant` but no wall-clock time type yet; see [Open
questions](#open-questions).

**Format data** is a value one format has and others do not, such as a
Firestore document reference. A type that holds one supplies its own codec
(see [Custom codecs](#custom-codecs)).

### Encoder and Decoder

`zena:codec` declares the two interfaces:

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

  /** A record of `fieldCount` fields, each written as `field` and its value. */
  beginRecord(fieldCount: i32): void;
  field(name: String, index: i32): void;
  endRecord(): void;

  /** A map, each entry written as `key` and its value. */
  beginMap(length: i32): void;
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

  /** A list's elements; throws unless `kind` is `List`. */
  length: i32;
  element(index: i32): Decoder;

  /** A record field or map entry: `(true, decoder)` or `(false, _)`. */
  field(name: String): inline (true, Decoder) | inline (false, _);
  keys(): Iterator<String>;

  /** The name the source gives the document, such as a Firestore document id. */
  documentId: String | null;

  /** Where this value sits in the document, for errors: `author.name`. */
  path: String;
}
```

The encoder is written to in order, so it can stream: the JSON encoder
writes text through `JsonBuilder`, and the Firestore encoder builds a
`Value` tree. Passing it a finished map instead would need a third tree
type for the generated code to build, and each conversion would build that
tree and then copy it into the format's own.

The decoder reads fields by name in any order, because a document's keys
come in any order. Each typed read throws a `DecodeError` naming the path,
what was expected, and what was found. `double()` also accepts an
integer, because JSON does not distinguish them and Firestore stores a
JavaScript `1.0` as the integer `1`.

### Opting in

A class, sealed class or enum opts in with `@codable`:

```zena
@codable
class Author(name: String, email: String)

@codable
class Post(title: String, views: i64, tags: Array<String>, author: Author | null)
```

`@codable` asks for three things:

1. The checker checks that every field can be encoded: a primitive, a
   `String`, a `ByteArray`, a list or a `Map<String, T>` of encodable
   values, `T | null` of one, another `@codable` type, or a type with a
   custom codec. A field that is none of these is an error on that field:
   `field 'session' of Post: Session is not @codable and has no codec`.
2. The class implicitly implements the `Codable` interface, as a case
   class implicitly implements `Hashable`. Generic code requires it with a
   constraint: `collection<T extends Codable>(path: String)`. Using a type
   that is not `@codable` is then a type error at the call, in the editor.
3. The compiler generates the encoder and decoder (see
   [Generation](#generation)).

Opting in is explicit because the encoding becomes a stored format.
Documents written today must decode next year, so the set of types with a
stored form, and their keys, should be visible in their declarations.

### Document fields and decoding

The same rules apply to every class, written concisely or in full, and to
each case of a sealed class.

A class's **document fields** are its public fields, minus any marked
`@skip`. For `class Post(title: String, views: i64)` they are `title` and
`views`. The encoder writes the document fields, which it can always do,
since they are public.

The decoder has to build a value from them, so a `@codable` class follows
a protocol for that. It names a **decoding entry point**, a function whose
parameters are matched to document fields by name and which returns the
class:

- **By default, the constructor**, when each of its parameters names a
  document field: a `this.x` parameter, or a plain parameter `x` where the
  class has a public field `x`.
- **Otherwise, a static method marked `@decoder`.** A class whose
  constructor takes something other than its fields offers one for
  decoding:

```zena
@codable
class Account {
  name: String;
  var balance: i64 = 0;
  #auditLog: GrowableArray<String> = new GrowableArray<String>();

  /** Opens an account with a first deposit. */
  new(name: String, deposit: Deposit) : name = name {
    this.balance = deposit.amount;
  }

  @decoder
  static restore(name: String, balance: i64): Account { ... }

  displayName: String {
    get { return this.name.asciiUpperCase(); }
  }
}
```

The decoder decodes a value for each of the entry point's parameters from
the key of the document field it names, and calls it. A parameter with a
default makes its key optional. It then assigns each `var` document field
the entry point did not take. The checker reports, on the field or the
parameter:

- a document field the decoder cannot set: immutable, and not taken by
  the entry point;
- a parameter that names no document field;
- a class with neither a constructor that qualifies nor a `@decoder`.

The protocol's contract is that a parameter named like a field receives
that field's encoded value, and the constructed object holds it in that
field. For a `this.` parameter the checker can see that it does. For a
plain parameter or a `@decoder` method it is the class's promise, as
`hashCode` agreeing with `==` is.

A class that is not sealed decodes as the declared class. A value of a
subclass is encoded through its own encoder when the subclass is
`@codable` too, since the encoder is a member, but a decoder for the base
class has no way to know which subclass a document came from. A hierarchy
that must round-trip as its subclasses is a sealed class, whose decoder
reads the discriminator and calls the case's entry point.

### Generated code

For `Post`, the encoder writes a record:

```zena
// [Codable.encode]
(out: Encoder): void => {
  out.beginRecord(4);
  out.field('title', 0);
  out.string(this.title);
  out.field('views', 1);
  out.integer(this.views);
  out.field('tags', 2);
  encode<Array<String>>(this.tags, out);
  out.field('author', 3);
  encode<Author | null>(this.author, out);
  out.endRecord();
}
```

and the decoder reads one and calls `Post`'s constructor, its entry
point:

```zena
// static [Codable.decode]
(input: Decoder): Post => new Post(
  requiredField(input, 'title').string(),
  requiredField(input, 'views').integer(),
  decode<Array<String>>(requiredField(input, 'tags')),
  decodeOr<Author | null>(input, 'author', null),
)
```

The generated members are keyed by symbols in `zena:codec`
(`Codable.encode`, `Codable.decode`), as `AsyncIterable.asyncIterator` is,
so they cannot collide with the class's own members.

Fields map to keys by these rules, where a default is a parameter's
default or a field's initializer:

| Field                                | Encoded as              | When the key is absent |
| ------------------------------------ | ----------------------- | ---------------------- |
| `x: T`                               | `T`'s encoding          | `DecodeError`          |
| `x: T = default` (or an initializer) | `T`'s encoding          | the default            |
| `x: T \| null`                       | null, or `T`'s encoding | null                   |
| `@skip x: T = default`               | not written             | the default            |
| `@id x: String` (or nullable)        | not written             | `input.documentId`     |
| `@key('created_at') createdAt: ...`  | under `created_at`      | as above               |

Values map by these rules:

| Type                                   | Encoded as                                   |
| -------------------------------------- | -------------------------------------------- |
| `i8`…`i64`, `u8`…`u32`                 | integer; decode checks the range             |
| `u64`                                  | integer; decode rejects values above i64 max |
| `f32`, `f64`                           | double                                       |
| `boolean`, `String`, `ByteArray`       | boolean, string, bytes                       |
| string-backed enum                     | string; decode rejects an unknown value      |
| `i32`-backed enum                      | integer; decode rejects an unknown value     |
| `Array<T>`, `GrowableArray<T>`, etc.   | list                                         |
| `Map<String, T>`, `HashMap<String, T>` | map                                          |
| `@codable` class                       | record                                       |
| `@codable` sealed class                | record with a discriminator field            |

A sealed class is written as its case's record, with an extra field,
`type`, holding the case's name. A unit case is a record holding only
`type`. The decoder reads `type`, then decodes that case. `@tag('kind')`
on the sealed class renames the field, and `@variant('circle')` on a case
changes its value.

```zena
@codable
@tag('kind')
sealed class Shape {
  @variant('circle') case Circle(radius: f64)
  case Square(side: f64)
}
```

Keys not declared by the type are ignored when decoding, so a document
written by a newer version of the program still decodes. `@closed` on a
class makes them a `DecodeError` instead.

**Generic types.** `@codable class Page<T extends Codable>(items:
Array<T>, next: String | null)` gets one encoder and decoder, which call
`encode<T>` and `decode<T>`. Each specialization of the generic class gets
the conversion of its `T`.

**Recursive types** need nothing special: `Tree`'s encoder calls
`encode<Array<Tree>>`, which calls `Tree`'s encoder for each child.

### Type-directed entry points

Library code converts values through two intrinsics:

```zena
@intrinsic('codec.encode')
export declare function encode<T>(value: T, out: Encoder): void;

@intrinsic('codec.decode')
export declare function decode<T>(input: Decoder): T;
```

They are lowered per type argument, as `equals<T>` and `hash<T>` are. For
a `@codable` type they call the generated member. For a primitive, a
list, a map or a nullable type they call library code in `zena:codec`,
which recurses through `encode` and `decode` on the element type. For a
type with a custom codec they call the codec.

`encode` and `decode` are separate functions, so a program that only
writes a type never reaches its decoder, and dead-code elimination removes
it.

### Generation

The encoder and decoder are generated when the checker checks the
`@codable` declaration, and live in the declaring module, beside the
class:

1. While registering the class's members, the checker adds the
   signatures of the two generated members, as it adds a case class's
   `==` and `hashCode`.
2. It renders their bodies as Zena source from the class's fields, their
   declared types, and their decorators, using the `zena` template tag,
   and parses the result into member declarations of the class.
3. The bodies are checked with the rest of the module's bodies, and
   compiled like any other members.

Because the code is generated in the declaring module, it resolves names
the way the class's own code does: field types are written as they are in
the declaration, and a class that is not exported is still in scope. The
checker sees the generated code at the same time as the code around it, so
its errors appear in the editor, and lazy body checking
([lazy-body-checking.md](lazy-body-checking.md)) defers it like any other
body in a dependency.

Generated source keeps the generator small. Field reads, constructor
calls, `match` over sealed cases and calls into `Encoder` are existing
language features, so the generator writes them as Zena and the checker
and lowering do the rest. A type error in generated code is a generator
bug. `ZENA_DUMP_SYNTHESIZED=1` writes the generated source next to the
output.

A `@codable` type the program never converts still has its members
checked, which costs compile time, and none of its code is emitted.

### Decorators

`zena:codec` declares the decorators the generator reads:

| Decorator          | Placed on                           | Effect                                   |
| ------------------ | ----------------------------------- | ---------------------------------------- |
| `@codable`         | class, sealed class, enum           | generate the encoder and decoder         |
| `@key('name')`     | field, or concise-class parameter   | the field's key                          |
| `@decoder`         | static method returning the class   | decode through it                        |
| `@skip`            | field with a default or initializer | never written; decoded as the default    |
| `@id`              | `String` or `String \| null` field  | read from the document's name            |
| `@tag('kind')`     | sealed class                        | the discriminator field (default `type`) |
| `@variant('post')` | sealed case                         | the case's discriminator value           |
| `@closed`          | class, sealed class                 | reject undeclared keys                   |
| `@codec(expr)`     | class declaration, field            | use this codec instead                   |

plus the value constraints in [JSON Schema](#json-schema).

A key is a stored format: renaming a field in source renames its key in
every document written afterward, and documents written before no longer
decode it. `@key` keeps the old key when the field's name changes.

These decorators need three extensions to decorators
([decorators.md](decorators.md)):

- **Data decorators.** A decorator declared with no body records itself
  and its arguments on the declaration it decorates, and changes nothing
  else: `export declare decorator key(name: String);`. The generator finds
  a decorator by the identity of its declaration, so a program can import
  `key` under another name.
- **Constant arguments.** A data decorator's arguments are constant
  expressions: literals, enum members, and, for `@codec`, a reference to a
  module-level `let`. The checker types each against the decorator's
  parameter. The open question decorators.md raises for arguments, when a
  spliced argument is evaluated, does not arise: the compiler reads a
  data decorator's arguments and splices nothing.
- **Positions.** Class, sealed class and enum declarations, concise-class
  parameters, sealed `case` declarations, and static methods, besides the class fields
  decorators reach today. On a class field, a data decorator sits beside
  the field decorators `decorators.md` describes and replaces nothing. At module level, a decorator may then precede
  `class`, `sealed class` and `enum` as well as `declare`.

### Custom codecs

A type the generator cannot handle, or one whose stored form should differ
from its fields, supplies a codec:

```zena
export interface Codec<T> {
  encode(value: T, out: Encoder): void;
  decode(input: Decoder): T;
}

final class UtcTimeCodec implements Codec<UtcTime> { ... }
let utcTimeCodec = new UtcTimeCodec();

@codec(utcTimeCodec)
export final class UtcTime { ... }
```

`encode<T>` and `decode<T>` call the codec, so such a type can be a field
of a `@codable` type. A type from another package, which cannot be
decorated, takes `@codec` on each field that holds it.

A codec that writes format data asks whether the encoder supports it:

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

The Firestore encoder implements `ReferenceEncoder` and the JSON encoder
does not, so the same field is a reference in Firestore and the
document's name in JSON.

### Format rules

Some documents a type can describe are ones a format cannot store.
Firestore rejects a list directly inside a list (a map between them is
allowed), maps and lists nested more than 20 deep, keys of the form
`__name__`, and documents over 1 MiB. JSON has no NaN or infinity.

These are rules of the format, the same for every application, so the
format's encoder enforces them. The Firestore encoder keeps a stack of the
containers it is inside, and throws an `EncodeError` with the path at
`beginList` inside a list, at the 21st level, or at a reserved key, before
anything is sent. The JSON encoder throws at a non-finite double. The
document size is left to the server, which reports it.

The generator could find some of these at compile time, since it sees
`Array<Array<T>>`, but it does not know which format a value is bound for.
A format that declared its restrictions to the generator, through the
typed API that converts the value, would move the error to the call. That
is left for when a second format has rules worth checking early.

### JSON Schema

A **schema** describes the documents an application accepts, which a
format's rules do not: which keys exist, their types, and constraints on
their values. JSON Schema is the common way to write one down, and is read
by OpenAPI tools, by validators, and by LLM APIs that take a tool's
parameters or a response's shape as a schema.

The generator already knows a `@codable` type's structure, so it can also
write the type's schema:

```zena
@intrinsic('codec.jsonSchema')
export declare function jsonSchemaOf<T extends Codable>(): String;
```

`jsonSchemaOf<Post>()` is a string constant built at compile time:

```json
{
  "type": "object",
  "properties": {
    "title": {"type": "string"},
    "views": {"type": "integer"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "author": {"anyOf": [{"$ref": "#/$defs/Author"}, {"type": "null"}]}
  },
  "required": ["title", "views", "tags"],
  "$defs": {"Author": {...}}
}
```

A field with a default or a nullable type is optional. A sealed class is
a `oneOf` over its cases, each with a `const` discriminator. A `@closed`
class sets `additionalProperties: false`. An enum is an `enum`.

JSON Schema can also say more than a type does: a number's range, a
string's length, pattern or format, a list's length. Data decorators
express these, and each does two jobs: it writes its keyword into the
schema, and the generated decoder checks it, throwing a `DecodeError` for
a value outside it.

| Decorator             | Schema keyword           |
| --------------------- | ------------------------ |
| `@range(min, max)`    | `minimum`, `maximum`     |
| `@length(min, max)`   | `minLength`, `maxLength` |
| `@items(min, max)`    | `minItems`, `maxItems`   |
| `@pattern('[a-z]+')`  | `pattern`                |
| `@format('email')`    | `format`                 |
| `@description('...')` | `description`            |

```zena
@codable
class SearchRequest(
  @description('Words to search for') @length(1, 200) query: String,
  @range(1, 100) limit: i32 = 20,
)
```

The type, the decoder and the published schema then come from one
declaration and agree. A constraint used in many places is better as a
type: a `distinct` type over `String` with a checking constructor and
`@format('email')` on its codec is an `Email` every field can use.

Validating a document against a schema known only at runtime is a
different tool, a validator over `JsonValue`, and is not part of this
design.

### Firestore

The Firestore client adds typed views over its untyped API:

```zena
@codable
class Post(title: String, views: i64 = 0, @id id: String | null = null)

let posts: TypedCollection<Post> = db.collection<Post>('posts');
let ref = await posts.add(new Post('Hello'));
await posts.doc('hello').set(post);
let snapshot = await posts.doc('hello').get();
if (let (true, data) = snapshot.data()) {
  console.log(`${data.id}: ${data.title}`);
}
for await (let s in posts.where('views', Operator.GreaterThan, integerValue(100)).stream()) {
  ...
}
```

`collection<T extends Codable>` is the counterpart of the JavaScript
SDK's `withConverter`: a typed view whose reads and writes go through
`T`'s codec. `snapshot.data()` answers `(false, _)` for a document that
does not exist and throws a `DecodeError` for one that does not match
`T`. The `@id` field is filled from the document's id.

A typed write can carry field transforms, which the server applies to the
stored document: `posts.doc('a').set(post, new Fields().serverTimestamp('updatedAt'))`.
The transforms' field names are strings, as are the names in `update` and
in queries, and a key changed with `@key` is the name to write there.

### JSON

`zena:json` adds:

```zena
export let parseJsonAs = <T extends Codable>(text: String): T => ...;
export let stringifyAs = <T extends Codable>(value: T): String => ...;
```

### Cost

A converted type costs one generated function per direction used, with
about one encoder or decoder call per field. That is the code a person
would write by hand, with its error handling in shared helpers.

The calls go through the `Encoder` and `Decoder` interfaces. A program
that uses one format has one class implementing each, and the `-O2`
devirtualizer turns a call into a direct call when every vtable that
could hold the slot installs the same function (`devirt.zena`). Whether
that covers these interface calls, and what they cost when it does not,
is measured in the first step of the [Plan](#plan), where hand-written
codecs make the same calls.

## Plan

1. `zena:codec`: `Encoder`, `Decoder`, `Codec<T>`, `DecodeError` and
   `EncodeError`, with JSON and Firestore implementations that check their
   formats' rules, and typed Firestore collections that take an explicit
   `Codec<T>`. This needs no compiler change and works with hand-written
   codecs.
2. Data decorators: bodyless declarations, constant arguments, and the
   new positions.
3. `@codable`: the field check, the decoding protocol, the `Codable`
   interface, generation for classes and enums, then sealed classes, and
   the `encode`/`decode` intrinsics. Typed collections switch to `T extends Codable`.
4. Value constraints and `jsonSchemaOf<T>`.
5. `package-manifest.zena` and the language service's JSON handling move
   to `parseJsonAs`.

## Alternatives considered

**Converters, as in Firestore's JavaScript SDK.** `withConverter` attaches
a hand-written pair of functions to a reference and returns a typed view.
This design keeps that shape: `TypedCollection<T>` is the typed view,
`Codec<T>` is the hand-written pair for types that need one, and `@id`
gives the decoder what `fromFirestore` gets from receiving the whole
snapshot. It differs where the SDK's converters cause bugs. Their reads
are unchecked: `snapshot.data()` returns whatever the converter built,
and a document of the wrong shape surfaces later, wherever a field is
used. Their writes with `{merge: true}` pass the converter a partial
object, which every converter must handle. And a reference made without
`withConverter` is untyped. Here, decoding checks every field, and the
type of a collection is fixed when it is created.

**Generation on demand.** The compiler could generate a type's code when
reachability first finds a call to `encode<T>`, with no opt-in, which
would also cover structural records. The code would then be checked after
the rest of the program, so a type that cannot be converted would be
reported only by a build, never in the editor, and only at the
specialization that reached it, often inside library code. Records would
still have nowhere to put options. Generating at declaration avoids all
three.

**Runtime reflection.** A program could read a table of each type's
fields at runtime, and one library function per format could walk it.
Zena records no such table. Every reflected type would carry its table
whether converted or not, primitive fields would be boxed to pass through
a uniform interface, and decoding would still need a way to call the
constructor.

**Procedural macros.** [macros.md](macros.md) designs macros that run
before type checking, invoked at expression sites. A macro would see a
class's field types as written, but not what an alias or an imported name
resolves to, and it has no form that attaches to a declaration. Macros are
also unbuilt. If they arrive, `@codable` could become one.

**Synthesis in IR**, as case-class `==` is built. The conversions are
mostly calls into library interfaces, constructor calls and `match` over
sealed cases, which source expresses directly and IR would need new
construction code for.

**One generator per format** (`toJson`, `toFirestore`). Each format would
need its own generator in the compiler, and a new format would need a
compiler change. With one data model and per-format encoders, a format is
a library.

## Open questions

- **Structural records.** Whether records convert, with field names as
  keys and no options, generated on demand.
- **Wall-clock time.** The data model's timestamp needs a standard
  library type to map to; `zena:time` has only the monotonic `Instant`
  and `Duration`. Firestore's generated `Timestamp` serves the client
  until then.
- **Integer keys.** Whether `Map<i32, T>` encodes, with keys written as
  decimal strings, as protobuf's JSON mapping does.
- **Naming conventions.** Whether a class-level option (`@keys('snake')`)
  renames every field, for JSON APIs that use `snake_case`.
- **Transforms as field options.** Whether a field option such as
  `@serverTimestamp updatedAt: Timestamp | null` should write a transform
  on every write, in place of passing transforms to `set`.
