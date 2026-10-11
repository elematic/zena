# Protobuf and gRPC

Status: **Proposed**.

This document designs protobuf messages and gRPC clients for Zena. The
first user is a Firestore client for servers running on Google Cloud Run.
It covers three decisions, in order of how much they affect the result:

1. The shape of the generated code. This determines binary size, and how
   much of a message's schema a program pays for.
2. The transport: gRPC over HTTP/2, Google's protobuf-over-HTTP/1.1
   fallback, or REST with JSON.
3. Where generation runs: a build step, the compiler's module loader, a
   loader plugin, or a macro.

## Overview

- A decoded message is a **view**: a class holding a byte array and a
  start and end offset. Each field's decoding lives in its getter.
  Reachability removes the getters a program never calls, and their
  decoders with them. A program that reads two fields of a 20-field
  message emits code for two fields.
- A message to encode is a **record** with presence-optional fields,
  encoded by one generated function per message type. Only the message
  types a program sends have their encoders reached.
- No descriptors, reflection tables, or `Any` type registries are
  generated unless asked for.
- Generated service stubs call a small transport interface. Unary calls
  can use Google's gRPC fallback protocol over HTTP/1.1. Streaming calls
  need gRPC over HTTP/2, which needs host work first.
- The generator is a Zena library that turns `.proto` text into Zena
  source. It runs first as a zb build step, and the Firestore package
  checks in its output. Once the output shape is settled, the same
  library moves behind a general loader-plugin mechanism, which the WIT
  synthesizer moves onto too.

## Background

### Firestore's API surface

`google/firestore/v1` is 10 `.proto` files with about 80 messages and
about 250 fields. It also imports well-known types (`Timestamp`,
`Struct`, `Empty`, wrappers, `Any`, `Duration`), `google.rpc.Status`,
`google.type.LatLng`, and the `google.api` annotation protos.

The `Firestore` service has 17 RPCs:

| Kind             | RPCs                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unary            | GetDocument, ListDocuments, CreateDocument, UpdateDocument, DeleteDocument, BeginTransaction, Commit, Rollback, PartitionQuery, ListCollectionIds, BatchWrite |
| Server streaming | BatchGetDocuments, RunQuery, RunAggregationQuery, ExecutePipeline                                                                                             |
| Bidirectional    | Write, Listen                                                                                                                                                 |

A server typically uses the unary calls plus `RunQuery`. `Listen` is for
realtime updates, which request-handling servers rarely need.

The schema is small. Generated client code gets large when the codec
reaches every field from one place: a decoder that switches over every
field number, or descriptor tables that reference every message. The
design below keeps each field's code separate so that reachability can
remove it.

### What the compiler provides today

- **Lazy body checking** ([lazy-body-checking.md](lazy-body-checking.md)).
  A module in a dependency package has its signatures checked. Its
  function bodies are checked only when reachability reaches them.
  Checking `examples/hello-world.zena` dropped from 1081 ms to 84 ms. A
  generated library shipped in a package therefore costs parsing and
  signature checking for its unused parts. Files reached by relative
  import from the entry point are still checked in full.
- **Reachability at method granularity** ([binary-size.md](binary-size.md)
  §11, §14). Unreached functions and methods are not emitted, and vtable
  slots nothing dispatches through are pruned.
- **No dead-field elimination** ([binary-size.md](binary-size.md), "Not
  yet: dead-field elimination"). Every declared field of a class or
  record stays in its struct, and every write to it stays live. A
  generated class with one field per proto field keeps all of them.
- **Presence-optional record fields** ([record-presence.md](record-presence.md)).
  `{name: String, mask?: DocumentMask}` may or may not have `mask`, and
  the absence is observable through patterns. This matches proto3
  explicit presence.
- **`String` as a view** ([strings.md](strings.md)). A `String` is a
  `ByteArray`, a start and an end, in WTF-8. A protobuf `string` field
  can be a `String` sharing the response buffer, with no copy.
- **`ByteBuffer`** (`packages/stdlib/zena/core/byte-buffer.zena`) has
  `writeULEB128` and `writeULEB128_64`, which are the protobuf varint
  encoding. There is no reader type and no varint decoder yet.
- **WIT synthesis** (`packages/zena-compiler/zena/lib/wit-module-synth.zena`).
  The one existing case of generating Zena from an interface language. A
  `zena-packages.json` entry `{"wit": "./path"}` makes the CLI host turn a
  WIT interface into Zena source text when a module imports it. The
  sections on where generation runs build on this.

## Goals

- A program pays in binary size for the fields it reads and the message
  types it sends, and little for the rest of the schema.
- Compile time for an unused part of the schema stays at parsing and
  signature checking.
- Messages are typed. A field read has the field's Zena type, a request
  is checked against its message type, and `oneof` matches are
  exhaustive.
- Generated code is readable Zena that can be inspected and debugged.

Non-goals for now: gRPC servers, the proto2 syntax and extensions, and
the protobuf text format.

## Generated code shape

### Message views for decoding

A response message is decoded into a view over its wire bytes. For
`google.firestore.v1.Document`:

```proto
message Document {
  string name = 1;
  map<string, Value> fields = 2;
  google.protobuf.Timestamp create_time = 3;
  google.protobuf.Timestamp update_time = 4;
}
```

the generator emits:

```zena
export final class Document {
  #m: ProtoView;
  new(this.#m);

  name: String {
    get => this.#m.string(1);
  }
  fields: ProtoMap<String, Value> {
    get => this.#m.map(2, ProtoView.readString, Value.view);
  }
  createTime: Timestamp | null {
    get => this.#m.message(3, Timestamp.view);
  }
  updateTime: Timestamp | null {
    get => this.#m.message(4, Timestamp.view);
  }

  static view(m: ProtoView): Document {
    return new Document(m);
  }
}
```

`Document` has one field for any size of message. A program that reads
only `name` reaches the `name` getter and `ProtoView.string`. The other
three getters, `ProtoMap`, and the whole `Value` decoder are never
emitted.

Unknown fields cost nothing. The protobuf wire format makes every field
skippable without its schema: the tag gives a wire type, and the wire
type gives the length. A view therefore never needs code for fields it
does not read, and fields added by a newer server are skipped.

A nested message is a view over a sub-range of the same bytes, so
reading `doc.createTime` allocates one small object and copies nothing.

### ProtoView and the field index

`ProtoView` is the shared runtime type. It holds the byte array, the
start and end offsets, and an index built on the first field access. The
index-building pass reads tags and skips values. For each field number it
records the offset of the last occurrence, and the first occurrence and
count for repeated fields. The pass is the same code for every message
type, so it adds no per-message code.

Field numbers in the Firestore protos go up to 22. The generator passes
each message's highest field number, so the index can be a small array
indexed by field number. A message with sparse large field numbers falls
back to a map.

Getters decode on every call. `doc.name` read twice creates two `String`
slices. Code that reads a field in a loop should bind it to a local
first. Caching decoded values would add a struct field per cached value,
which reachability cannot remove (see "No dead-field elimination"
above).

### Scalars, strings and bytes

| Proto type                                  | Zena type             |
| ------------------------------------------- | --------------------- |
| `int32`, `sint32`, `sfixed32`               | `i32`                 |
| `uint32`, `fixed32`                         | `u32`                 |
| `int64`, `sint64`, `sfixed64`               | `i64`                 |
| `uint64`, `fixed64`                         | `u64`                 |
| `float`, `double`                           | `f32`, `f64`          |
| `bool`                                      | `boolean`             |
| `string`                                    | `String`              |
| `bytes`                                     | a read-only byte view |
| `optional` scalar, or a message-typed field | `T \| null`           |

A `string` field becomes a `String` sharing the response's byte array.
This needs a constructor from a byte array and a range, which is
internal to the standard library today. Because of that, the runtime
(`ProtoView`, `ProtoMap`, the writer) belongs in the standard library as
`zena:protobuf`. Proto3 requires `string` fields to be valid UTF-8, and
WTF-8 accepts every valid UTF-8 sequence. Whether to validate on read is
an open question.

A scalar with implicit presence (proto3 without `optional`) reads as its
default value when absent.

### Repeated fields and maps

A repeated field reads as an iterable that scans forward from the
field's first occurrence. Repeated scalars must accept both the packed
and the unpacked encoding, because proto3 parsers are required to. A
`map<K, V>` reads as a `ProtoMap<K, V>`: a lookup scans the entries, and
iteration yields keys and values as views. A caller that looks up many
keys can copy it into a `HashMap`.

### oneof

A `oneof` reads as a sealed class, built when the getter is called.
Firestore's `Value` is the main case:

```zena
export sealed class ValueKind {
  case ValueNull()
  case ValueBoolean(value: boolean)
  case ValueInteger(value: i64)
  case ValueDouble(value: f64)
  case ValueTimestamp(value: Timestamp)
  case ValueString(value: String)
  case ValueBytes(value: ProtoBytes)
  case ValueReference(value: String)
  case ValueGeoPoint(value: LatLng)
  case ValueArray(value: ArrayValue)
  case ValueMap(value: MapValue)
  // ... and the four members used by pipeline queries
  case ValueUnset()
}
```

`ValueUnset` stands for "no member set", which proto3 allows. A `match`
over `value.kind` is checked for exhaustiveness. Reaching the `kind`
getter reaches every case's decoder, since the getter builds whichever
case is present. Per-member getters (`value.stringValue: String | null`)
are also generated, for code that expects one member and should not pay
for the others.

Zena has no nested declarations, so the generator flattens nested names
with the parent's name as a prefix. The WIT synthesizer does the same
for variant cases.

### Enums

A proto enum becomes a Zena enum with explicit values. Proto3 enums are
open: a newer server can send a value the generated code does not know.
The enum cast in Zena is unchecked ([enums.md](enums.md)), so an
unknown value is carried through. An exhaustive `match` then misses it,
so each generated enum needs a way to test for an unknown value. The
details are an open question.

### Records for encoding

A request is a record. For `GetDocumentRequest`:

```proto
message GetDocumentRequest {
  string name = 1 [(google.api.field_behavior) = REQUIRED];
  DocumentMask mask = 2;
  oneof consistency_selector {
    bytes transaction = 3;
    google.protobuf.Timestamp read_time = 5;
  }
}
```

the generator emits:

```zena
export type GetDocumentRequestInit = {
  name: String,
  mask?: DocumentMaskInit,
  consistencySelector?: GetDocumentRequestConsistencySelector,
};

export function encodeGetDocumentRequest(
  w: ProtoWriter,
  m: GetDocumentRequestInit,
): void { ... }
```

and a caller writes:

```zena
let doc = await firestore.getDocument({name: path, mask: {fieldPaths: ['title']}});
```

Most fields are presence-optional, so a literal names only the fields
it sets. A field marked `(google.api.field_behavior) = REQUIRED` is a
required record field, so leaving it out is a type error. The Firestore
protos carry 28 such annotations.

The record type has an `Init` suffix because a message that appears in
both requests and responses, such as `Document`, needs two names: a view
class for reading and a record for writing.

### Encoder reachability

The encoder for a message type tests each field's presence and encodes
the fields that are present. Calling it reaches the code for every field
of that type, and the encoders of nested message types. Encoders of
message types that no reached call sends are never emitted. A program
that calls only `getDocument` emits encoders for `GetDocumentRequest`,
`DocumentMask` and `Timestamp`. The `StructuredQuery` tree is emitted
only if the program also calls `runQuery`.

Request types are the smaller half of most APIs, and within a request
type the unused fields cost a presence test each. If the optimizer
inlines an encoder at a record literal, the presence bits become
constants and the tests for absent fields fold away. Nothing in this
design depends on that happening.

A nested message field is written as its length followed by its bytes,
so the length must be known before the bytes are written. The writer
encodes each nested message into a scratch buffer, then writes the
length and copies. The alternative, computing every message's size
first, would generate a second function per message. Requests are small,
so the copy is cheap.

### Embedding a view in a request

Read-modify-write is common: read a document, change one field, write it
back. A message-typed field in an `Init` record can accept either the
record or a view of the same message, for example
`DocumentInit | Document`. The encoder writes a view's byte range
unchanged, without decoding or re-encoding it. This also passes through
fields the generated code does not know.

### Well-known types

`Timestamp`, `Duration`, `Struct`, `Value`, `ListValue`, the wrapper
types and `Empty` are generated from their `.proto` files like any other
message. `zena:protobuf` adds conversions to and from Zena's own types
where those exist. `Any` is generated as a type URL plus bytes; decoding
its contents is up to the caller, so no type registry is needed.

### What is not generated

- Descriptors and reflection. They reference every message and field, so
  everything they reference would be reachable.
- An `Any` type registry, for the same reason.
- The proto3 JSON codec. It is needed only for the REST transport (see
  [REST with JSON](#rest-with-json)). When needed, it is a separate output
  the generator produces on request.

Each of these can be added as an opt-in output later without changing
the views or records.

## Service stubs and transports

### Transport interface

A generated service stub turns each RPC into a typed method that encodes
the request, calls the transport, and wraps the response bytes in a
view. The transport interface has no knowledge of messages:

```zena
export interface ProtoTransport {
  unary(method: RpcMethod, request: ByteBuffer, metadata: Metadata): Future<ProtoView>;
  serverStream(method: RpcMethod, request: ByteBuffer, metadata: Metadata): Stream<ProtoView>;
}
```

`RpcMethod` holds the full service and method names. The bidirectional
streaming method is left out until there is a user for it.

### gRPC over HTTP/2

gRPC needs HTTP/2. Each message is framed with one compressed-flag byte
and a 4-byte big-endian length. The call's status arrives in the
`grpc-status` and `grpc-message` trailers. A call that fails before
sending any messages returns the status in the headers instead, with no
body.

The guest side is small. The `wasi:http` 0.3 types already expose
request bodies as streams and trailers on both requests and responses.
The host side is missing. Wasmtime's default outgoing request handler
(`crates/wasi-http/src/default_send_request.rs`, wasmtime `e4657a0`)
does these things on every request:

- opens a new TCP connection;
- performs a new TLS handshake;
- performs an HTTP/1.1 handshake with
  `hyper::client::conn::http1::Builder`.

It does not negotiate HTTP/2 or reuse connections. Embedders can
override outgoing requests through `WasiHttpHooks::send_request`. The
wasi-http proposal is discussing how a guest signals that it needs
HTTP/2 for trailers
([wasi-http#128](https://github.com/WebAssembly/wasi-http/issues/128)).

A new connection and TLS handshake per request costs every outbound
call from a Cloud Run server, protobuf or not. That makes pooled
connections and HTTP/2 a host requirement for production servers in
general. Zena's own runtime (`packages/zena-runtime`) does not link
`wasmtime-wasi-http` today, so HTTP programs run only under
`wasmtime serve`.

### gRPC fallback over HTTP/1.1

Most Google APIs accept a fallback protocol
([HowToRPC](https://googleapis.github.io/HowToRPC.html)):

```
POST https://firestore.googleapis.com/$rpc/google.firestore.v1.Firestore/GetDocument
Content-Type: application/x-protobuf

<binary GetDocumentRequest>
```

The response body is the binary response message. On failure the HTTP
status is the mapping of the `google.rpc.Code`, and the body is a binary
`google.rpc.Status`. It works over HTTP/1.1 and uses the same message
encoding, so the views and records do not change.

The specification does not describe streaming. If the fallback cannot
serve server-streaming calls, `RunQuery` needs one of the other two
transports. This is the first thing to test.

### REST with JSON

Firestore's REST API covers every RPC except `Listen` and `Write`
([reference](https://docs.cloud.google.com/firestore/docs/reference/rest)).
`runQuery` returns a JSON array of responses. REST would need the
proto3 JSON mapping as a second generated codec: camel-cased field
names, `int64` as strings, and per-type rules for the well-known types.
`zena:json` is a dynamic tree today, with no typed mapping.

### Host requirements

| Requirement                                     | Needed by                             | State                                |
| ----------------------------------------------- | ------------------------------------- | ------------------------------------ |
| `zena:fetch` with method, request headers, body | every transport, auth                 | GET only, no request headers or body |
| Response trailers in `zena:fetch`               | gRPC                                  | ignored by `consumeBody`             |
| Pooled connections                              | production servers                    | not in wasmtime's default handler    |
| HTTP/2 to `*.googleapis.com`                    | gRPC                                  | not in wasmtime's default handler    |
| `wasmtime-wasi-http` in `zena-runtime`          | running servers under Zena's own host | not linked                           |

### Authentication on Cloud Run

On Cloud Run, a service gets an access token by requesting
`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`
with the header `Metadata-Flavor: Google`. The JSON response holds
`access_token` and `expires_in`. The client caches the token until shortly
before it expires, and sends it as `authorization: Bearer <token>`. This
needs request headers in `zena:fetch` and nothing else.

Firestore also expects an `x-goog-request-params` header naming the
database, as declared by the `google.api.routing` annotation on each
RPC. The generator can emit it from the annotation.

## Where generation runs

### Generator library

The generator is a pure Zena library, `packages/protobuf`, with two
parts:

- a parser for proto3 `.proto` text. It records the options the
  generator uses (`field_behavior`, `routing`, `http`) and ignores the
  rest;
- an emitter that produces Zena source text with the `zena` template
  tag from `packages/zena-compiler/zena/lib/code-template.zena`.

Its input is a set of `.proto` files and a list of message and service
names to generate. Its output is Zena source. It does no I/O. Parsing
`.proto` text means users don't need `protoc`. The `google/api`,
`google/protobuf`, `google/rpc` and `google/type` files Firestore imports
are vendored with the package that uses them.

The rest of this section is about where that library runs. It is the
same library in every case.

### Build step

A zb or Wireit script runs the generator from the CLI and writes `.zena`
files. zb already supports this: it runs arbitrary commands, caches by
content, and lets dependents rebuild only when the output's digest
changes ([workflow.md](workflow.md)).

- The output is ordinary files, so the language service, the debugger
  and code review see it with no extra support.
- A package such as the Firestore client checks in its generated code.
  Its users never run the generator.
- A user's own `.proto` files need a build step, and the output can go
  stale if the step is skipped. Package manifests have no notion of a
  build step yet ([package-manifest.md](package-manifest.md)).
- Because the output sits in a package, its unused bodies are not
  checked, per [lazy-body-checking.md](lazy-body-checking.md).

### Compiler-synthesized imports

The WIT path, repeated for `.proto`:

- a `zena-packages.json` entry `{"proto": "./protos"}`;
- a `proto:` branch in the module resolver;
- a case in each host's `readFile` that synthesizes source text.

There is no build step and the output is always current. Synthesis can
be lazy per imported name, which WIT's is not: it renders a whole
interface when one name is imported.

Its costs:

- A proto parser and generator in the compiler driver.
- A fourth special case. `.wit` already needs one in the manifest
  format, one in the resolver, and one in each host's `readFile`.
- The language service cannot see synthesized modules. It has no `wit:`
  branch either, so a WIT import shows as a missing module in the
  editor today.

### Loader plugins

A loader plugin generalizes the WIT case. The package manifest maps an
import scheme to a synthesizer and a root directory. The host reads the
files under that root and calls the synthesizer with their contents and
the imported names. The synthesizer returns Zena source, which the
compiler caches by synthesizer version and input digest.

The synthesizer is a pure function and receives only the bytes the host
gives it. That matches the sandbox [macros.md](macros.md) requires of
macros, which may not import file or network modules. WIT, protobuf, and
later schemas such as SQL or GraphQL would share one mechanism. Adding
editor support once in the language service would cover all of them.

Its cost is infrastructure that does not exist. The compiler is itself a
wasm module, and it would have to call a separately compiled synthesizer
under both the Rust host and the JS host. Designing that seam with WIT as
its only user would likely shape it around WIT's needs.

### Procedural macros

Procedural macros ([macros.md](macros.md)) are a poor fit, and they do
not exist yet:

- They are syntactic and run before type checking, at expression sites.
  A `.proto` file generates top-level declarations.
- The macro design forbids macro modules from importing file I/O, and a
  `.proto` file lives on disk.
- A macro would fit only if the schema were written inline in Zena
  source, which is not the Firestore case.

Macros are needed for a different part of the problem: mapping user
types to Firestore documents (see [Typed documents](#typed-documents)).

### Order

1. Build the generator library and the `zena:protobuf` runtime. Run the
   generator as a zb step for the Firestore package and check in the
   output. Iterate on the code shape with measurements. Changing the
   generator does not touch the compiler, so it needs no bootstrap
   reseed.
2. Once the shape is stable, build the loader-plugin mechanism. Move the
   WIT synthesizer and the protobuf generator onto it, and give the
   language service a way to run synthesizers.

## Firestore client layering

The Firestore package has four layers:

1. `zena:protobuf`: `ProtoView`, `ProtoWriter`, `ProtoMap`, varints and
   the transport interface.
2. Generated views, records, encoders and the `Firestore` stub for
   `google.firestore.v1`.
3. A hand-written client: `db.collection('users').doc(id).get()`,
   transactions with retry, batched writes, query building, and token
   handling.
4. Typed documents: mapping user classes and records to Firestore's
   `Map<String, Value>`.

Most of the work, and most of what makes the client pleasant to use, is
in layers 3 and 4.

### Typed documents

A document's fields are a `map<string, Value>`, and `Value` is a tree.
Reading a user type out of it, and writing one into it, needs per-type
conversion code. Writing that by hand for every type is error-prone, and
generating it needs either a derive mechanism on user declarations or
structural reflection. `zena:json` has the same need for typed JSON, so
the two should share a design. That design is out of scope here.

### Interim client

If production Firestore access is needed before this design is built, a
hand-written client over the REST API and `zena:json` can provide layer
3, calling REST endpoints with JSON in place of layers 1 and 2. Its
public API can stay the same when layer 2 arrives. It needs `zena:fetch` with methods, headers
and bodies, like every option here.

## Implementation plan

1. `zena:fetch`: request method, headers and body; response trailers.
2. `zena:protobuf` runtime: `ProtoView` with its field index, a varint
   reader, `ProtoWriter` on `ByteBuffer`, `ProtoMap`, and a fallback
   transport. Test against hand-written message classes before any
   generator exists.
3. Check whether the fallback protocol serves server-streaming calls,
   using `RunQuery`.
4. `.proto` parser and emitter in `packages/protobuf`, with a CLI entry
   point.
5. A Firestore package with checked-in generated code, built by a zb
   step. Measure binary size for a `getDocument`-only program and for one
   that also runs a query.
6. Metadata-server authentication and the hand-written client layer.
7. Host: `wasmtime-wasi-http` in `zena-runtime` with a `send_request`
   hook that pools connections and negotiates HTTP/2; then the gRPC
   transport.
8. Loader plugins, with WIT and protobuf as the first two users.

## Open questions

- Whether the gRPC fallback protocol supports server streaming.
- A non-repeated message field that occurs more than once must be merged
  under the protobuf specification. The index records only the last
  occurrence. Google's servers do not split messages this way, but the
  view should at least detect it.
- Whether to validate UTF-8 when reading a `string` field, and if so,
  whether once per view or per read.
- How generated code tests an enum for an unknown value.
- The byte storage type. `String` is backed by `ByteArray`, while
  `zena:stream` and `zena:fetch` deliver `FixedArray<u8>`. A view should
  wrap the response buffer without copying it.
- Naming of flattened nested messages and oneof types.

## Alternatives considered

- **Eager decoding into classes**, as most protobuf libraries do. One
  decode function reads every field into a struct field. The function
  reaches every field's decoder, and without dead-field elimination every
  struct field stays. A program pays for the whole message whatever it
  reads.
- **Eager decoding into records.** Records give structural types and
  pattern matching, but the decode function still sets every field, so
  the cost is the same as eager decoding into classes.
- **`protoc` and a `FileDescriptorSet` as the generator's input.**
  Descriptors give an exact resolved schema, but users would need
  `protoc` or `buf` installed. Proto3's grammar is small enough to parse
  directly, and WIT already set the precedent of parsing source text.
- **REST with JSON as the only transport.** It works over HTTP/1.1 today
  and covers all but the realtime RPCs. It needs a second codec, and
  JSON is larger and slower to parse than the binary encoding the other
  two transports share.
