# Protobuf and gRPC

Status: **Partly implemented.** The generator, the runtime, the gRPC
transport and the fallback transport are in `packages/protobuf`.
`packages/google-cloud` holds the generated Firestore code,
metadata-server credentials and a hand-written Firestore client. Typed
documents and loader plugins are not built.

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
- A message to encode is built from a **record** with presence-optional
  fields by the message class's `of` method, which encodes it and
  returns a view of the bytes. A message-typed field holds a view, on
  both the reading and the writing side. Only the message types a
  program builds have their encoders reached.
- No descriptors, reflection tables, or `Any` type registries are
  generated.
- Generated service clients call a small transport interface. Unary calls
  can use Google's gRPC fallback protocol over HTTP/1.1. Streaming calls
  need gRPC over HTTP/2, which `zena-cli` and `zena-run` support and
  wasmtime's default outgoing handler does not.
- The generator is a Zena library that turns `.proto` text into Zena
  source. It runs as a command-line program or a build step, and the
  output is checked in. Once the output shape is settled, the same
  library can move behind a general loader-plugin mechanism, which the
  WIT synthesizer would move onto too.

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

### What the compiler provides

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
- **Dead-field elimination** ([binary-size.md](binary-size.md),
  "Dead-field elimination"). At `-O1` and above, a class field that no
  surviving function reads is removed with its writes, and a setter left
  empty goes with its calls. The value written is still computed, so a
  call made to produce it still runs. Record fields are not removed. The
  views below do not depend on it; see
  [Caching decoded fields](#caching-decoded-fields) for what it allows.
- **Presence-optional record fields** ([record-presence.md](record-presence.md)).
  `{name: String, mask?: DocumentMask}` may or may not have `mask`, and
  the absence is observable through patterns. This matches proto3
  explicit presence.
- **`String` as a view** ([strings.md](strings.md)). A `String` is a
  `ByteArray`, a start and an end, in WTF-8. `String.fromByteArray` is
  public, so a protobuf `string` field can be a `String` sharing the
  response buffer, with no copy, without the runtime living in the
  standard library.
- **`ByteBuffer` and `DataView`** (`packages/stdlib/zena/core/`).
  `ByteBuffer` writes little-endian numbers and LEB128 varints, the
  protobuf varint encoding among them. `data-view.zena` reads them back:
  free functions over a `ByteArray` and an offset, which allocate
  nothing, and a range-checked `DataView` class over them, as
  [byte-buffer.md](byte-buffer.md) planned. The runtime decodes with the
  free functions.
- **WIT synthesis** (`packages/zena-compiler/zena/lib/wit-module-synth.zena`).
  The one existing case of generating Zena from an interface language. A
  `zena-packages.json` entry `{"wit": "./path"}` makes the CLI host turn a
  WIT interface into Zena source text when a module imports it. The
  sections on where generation runs build on this.

## Goals

- A program pays in binary size for the fields it reads and the message
  types it builds, and little for the rest of the schema.
- Compile time for an unused part of the schema stays at parsing and
  signature checking.
- Messages are typed. A field read has the field's Zena type, a request
  is checked against its message type, and `oneof` matches are
  exhaustive.
- Generated code is readable Zena that can be inspected and debugged.

Non-goals for now: gRPC servers, proto2 semantics (default values,
extensions, groups), editions, and the protobuf text format. The parser
reads proto2 files, so that a proto3 file can import one.

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

the generator emits, doc comments aside:

```zena
export final class Document {
  #m: ProtoView;

  new(m: ProtoView) : #m = m;

  static decode(bytes: ByteArray): Document {
    return new Document(ProtoView.of(bytes));
  }

  static of(init: DocumentInit): Document { ... }

  protoView: ProtoView {
    get { return this.#m; }
  }

  name: String {
    get { return this.#m.string(1); }
  }

  fields: ProtoMap<String, Value> {
    get { return this.#m.map(2, (e) => e.string(1), (e) => new Value(e.messageOrEmpty(2))); }
  }

  createTime: Timestamp | null {
    get {
      let m = this.#m.message(3);
      return if (m == null) null else new Timestamp(m as ProtoView);
    }
  }
  ...
}
```

`Document` has one field for any size of message. A program that reads
only `name` reaches the `name` getter and `ProtoView.string`. The other
getters, `ProtoMap`, and the whole `Value` decoder are never emitted.

Unknown fields cost nothing. The protobuf wire format makes every field
skippable without its schema: the tag gives a wire type, and the wire
type gives the length. A view therefore never needs code for fields it
does not read, and fields added by a newer server are skipped.

A nested message is a view over a sub-range of the same bytes, so
reading `doc.createTime` allocates one small object and copies nothing.

### ProtoView and the field index

`ProtoView` is the shared runtime type. It holds the byte array, the
start and end offsets, and an index built on the first field access. The
index pass reads tags and skips values. For each field number it records
the offsets of the first and last tags and the number of occurrences.
The pass is the same code for every message type, so it adds no
per-message code.

The index is an array indexed by field number for numbers below 1024,
sized by the largest such number in the message. Larger numbers go in a
map. Field numbers in the Firestore protos go up to 22.

A scalar field that occurs more than once reads as its last occurrence.
A message field that occurs more than once is merged, as the
specification requires: the getter returns a view of the occurrences'
concatenated bytes, because decoding a concatenation is defined to be the
merge. A field written with a wire type its schema does not allow throws
a `ProtoError`, as do truncated values and varints longer than 10 bytes.

Getters decode on every call. `doc.name` read twice creates two `String`
slices. Code that reads a field in a loop should bind it to a local
first.

### Caching decoded fields

A getter could keep what it decoded in a field of the view, so a second
read costs nothing. With dead-field elimination, a cache field that only
its getter reads goes when the getter is unreached, so a program pays
for the caches of the fields it reads and no others. Which types are
worth caching is undecided: strings and nested messages allocate on
every read, while scalars are cheap to decode again.

### Scalars, strings and bytes

| Proto type                    | Zena type when read            | Zena type in an `Init` record |
| ----------------------------- | ------------------------------ | ----------------------------- |
| `int32`, `sint32`, `sfixed32` | `i32`                          | `i32`                         |
| `uint32`, `fixed32`           | `u32`                          | `u32`                         |
| `int64`, `sint64`, `sfixed64` | `i64`                          | `i64`                         |
| `uint64`, `fixed64`           | `u64`                          | `u64`                         |
| `float`, `double`             | `f32`, `f64`                   | `f32`, `f64`                  |
| `bool`                        | `boolean`                      | `boolean`                     |
| `string`                      | `String`                       | `String`                      |
| `bytes`                       | `ProtoBytes`                   | `ByteArray \| ProtoBytes`     |
| an enum                       | the generated enum             | the generated enum            |
| a message                     | the message's class, or `null` | the message's class           |
| `repeated T`                  | `ProtoList<T>`                 | `Array<T>`                    |
| `map<K, V>`                   | `ProtoMap<K, V>`               | `Map<K, V>`                   |

A `string` field becomes a `String` sharing the response's byte array,
through the public `String.fromByteArray`. Proto3 requires `string`
fields to be valid UTF-8, and WTF-8 accepts every valid UTF-8 sequence.
The runtime does not validate.

A scalar with implicit presence (proto3 without `optional`) reads as its
default value when absent. A scalar with explicit presence (proto3
`optional`, or a `oneof` member) also gets a `hasX` getter: Zena has no
nullable primitives, so `i32 | null` is not a type.

### Repeated fields and maps

A repeated field reads as a `ProtoList<T>`, an iterable that scans
forward from the field's first occurrence. Repeated numeric fields
accept both the packed and the unpacked encoding, and a mix of the two,
because proto3 parsers are required to. `length` counts the elements,
which decodes a packed run, and `toArray()` copies them out.

A `map<K, V>` reads as a `ProtoMap<K, V>`. `has(key)` and
`getOr(key, fallback)` scan the entries, and the last entry with a key
wins. Iterating yields `ProtoMapEntry` objects with `key` and `value`.
A caller that looks up many keys can copy the entries into a `HashMap`.

### oneof

A `oneof` reads as a sealed class, built when the getter is called. For
Firestore's `Value`, whose `value_type` has 15 members, the generator
emits:

```zena
export sealed class ValueValueType {
  case ValueNullValue(value: NullValue)
  case ValueBooleanValue(value: boolean)
  case ValueIntegerValue(value: i64)
  case ValueDoubleValue(value: f64)
  case ValueTimestampValue(value: Timestamp)
  case ValueStringValue(value: String)
  ...
  case ValueValueTypeNotSet
}
```

and a caller writes:

```zena
let text = match (value.valueType) {
  case ValueStringValue {value}: value
  case ValueIntegerValue {value}: `${value}`
  case _: '?'
};
```

The member that is set is the one whose tag occurs last, as the
specification requires. `ValueValueTypeNotSet` stands for no member set.
Reaching the `valueType` getter reaches every member's decoder, since the
getter builds whichever case is present. Each member also has its own
getter, `value.stringValue`, for code that expects one member and should
not pay for the others. It returns the default value, or null for a
message, when another member is set.

Zena has no nested declarations, so the generator flattens nested names
with the parent's name as a prefix: `StructuredQuery.FieldFilter`
becomes `StructuredQueryFieldFilter`. A case is named for its message and
field, `ValueStringValue`, unless that is the name of a generated type.
`TransactionOptions` has both a member `read_write` and a nested message
`ReadWrite`, so that member's case takes the oneof type's name instead:
`TransactionOptionsModeReadWrite`.

### Enums

A proto enum becomes a Zena enum with explicit values. When every value
starts with the enum's name in upper snake case, the prefix is dropped:
`Color { COLOR_UNSPECIFIED, COLOR_RED }` becomes
`Color { Unspecified, Red }`. Otherwise the values keep their full names
in Pascal case, as `StructuredQuery.FieldFilter.Operator` does, since only
its first value carries the prefix. Aliases (`allow_alias`) keep the
first name for each number.

Proto3 enums are open: a newer server can send a value the generated
code does not know. The enum cast in Zena is unchecked
([enums.md](enums.md)), so an unknown value is carried through, and
`match` needs a `case _` arm to cover it.

### Records for encoding

Each message `M` has a record type `MInit` with one presence-optional
field per proto field, and `M.of(init)` encodes one and returns a view
of the bytes. For `GetDocumentRequest`:

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
  mask?: DocumentMask,
  transaction?: ByteArray | ProtoBytes,
  readTime?: Timestamp,
};
```

and a caller writes:

```zena
let doc = await firestore.getDocument({
  name: path,
  mask: DocumentMask.of({fieldPaths: ['title']}),
});
```

Most fields are presence-optional, so a literal names only the fields it
sets. A field marked `(google.api.field_behavior) = REQUIRED` is a
required record field, so leaving it out is a type error. A field marked
`OUTPUT_ONLY` is left out of the record, because the server sets it and
ignores it in requests.

A message-typed field holds the field's view class, `DocumentMask`, and
not another record. So a nested message is encoded before its parent:
`DocumentMask.of` runs first, and the parent copies its bytes. This was
chosen over records nested in records for three reasons:

- `Init` records never refer to each other, so they are never recursive.
  Firestore's messages are recursive (`Value` holds a `MapValue`, whose
  fields are `Value`s), and the checker cannot yet compare a record alias
  that refers to itself through a type argument such as
  `Map<String, Value>` with the record it names
  (`tests/language/execution/records/recursive_alias_type_argument.zena`).
- A nested message's length is known before it is written, so the parent
  needs no scratch buffer or size pass.
- A view read from one response can go straight into the next request.
  Read-modify-write needs no conversion, and the copy carries fields the
  generated code does not know.

The cost is writing `MapValue.of(...)` at each level of a nested literal.

The members of a `oneof` are separate optional fields in the record. The
type does not stop a caller from setting two; the encoder writes both,
and a reader takes the one written last.

### Encoder reachability

`M.of` tests each field's presence and encodes the fields that are
present. Calling it reaches the code for every field of that type, and
the `protoView` getters of the message types its fields hold. It does
not reach those types' encoders: a nested message was encoded when it
was built. A program that calls only `getDocument` reaches
`GetDocumentRequest.of`, and `DocumentMask.of` only if it builds a mask.
The `StructuredQuery` encoders are emitted only for a program that
builds a query.

### Well-known types

`Timestamp`, `Duration`, `Struct`, `Value`, `ListValue`, the wrapper
types and `Empty` are generated from their `.proto` files like any other
message. `Any` is generated as a type URL plus bytes; decoding its
contents is up to the caller, so no type registry is needed. Conversions
between these and Zena's own types are not written yet.

### What is not generated

- Descriptors and reflection. They reference every message and field, so
  everything they reference would be reachable.
- An `Any` type registry, for the same reason.
- The proto3 JSON codec. It is needed only for the REST transport (see
  [REST with JSON](#rest-with-json)).
- Client methods for RPCs that stream requests (`Write` and `Listen` in
  Firestore). The class comment lists them.

Each of these can be added as an opt-in output later without changing
the views or records.

## Service stubs and transports

### Transport interface

A generated client turns each RPC into a typed method that encodes the
request, calls the transport, and wraps the response bytes in a view.
The transport knows nothing of messages:

```zena
export interface ProtoTransport {
  unary(method: RpcMethod, request: ProtoView, metadata: RpcMetadata): Future<ProtoView>;
  serverStream(method: RpcMethod, request: ProtoView, metadata: RpcMetadata): AsyncIterator<ProtoView>;
}
```

`RpcMethod` holds the full service and method names. A unary method is
`async` and returns `Future<Response>`. A server-streaming method returns
a `ProtoStream<Response>`, which a `for await` consumes:

```zena
for await (let response in client.runQuery({parent, structuredQuery})) { ... }
```

`RpcMetadata` holds headers for one call. A generated client puts the
call's routing header there (see [Routing headers](#routing-headers)).
Headers that every call shares belong to the transport:

- `FallbackTransport.setHeader` sets fixed headers.
- A `Credentials` value supplies the `authorization` header. Its
  `authorization(): Future<String | null>` is asked before every call, so
  an implementation can refresh an expiring token.

### Routing headers

Google's front ends route a call by its `x-goog-request-params` header
(https://google.aip.dev/client-libraries/4222): `key=value` pairs joined
with `&`, each value percent-encoded. A generated client builds it from
the request with `RoutingHeader`.

- **Explicit routing.** When the method has a `google.api.routing`
  annotation, each `routing_parameters` entry reads the request field it
  names. With a `path_template`, the parameter is the part of the value
  the template's variable captures, and is sent only if the value matches:
  `projects/*/databases/{database_id=*}/**` turns
  `projects/p/databases/(default)/documents` into
  `database_id=%28default%29`. Without a template, the whole value is
  sent under the field's name. A later parameter with the same key
  replaces an earlier one.
- **Implicit routing.** Otherwise, each variable in the path of the
  method's `google.api.http` rule is a parameter, keyed by its field path
  and sent whole. Firestore's `UpdateDocument` rule,
  `/v1/{document.name=projects/*/databases/*/documents/*/**}`, gives
  `document.name=projects%2Fp%2F...`.
- **Empty values.** An empty or absent value sends nothing, and a call
  with no parameters sends no header.

Of the Firestore RPCs, only `ExecutePipeline` has a routing annotation;
the rest route implicitly. The real Firestore accepts the header on both
unary and streaming calls (`examples/firestore-fallback-probe.zena`).

Transports are written against the `wasi:http` 0.3 bindings directly,
the ones `zena:fetch` and `zena:http` are built on. `Request.new_`
takes request headers, a body stream and a trailers future,
`setMethod` sets `POST`, and `Response.consume-body` returns the body
stream and a future for the trailers, which is everything gRPC and the
fallback protocol need. `zena:fetch` is a convenience over the same
bindings for simple requests and can grow a fuller request API, but a
transport does not wait on it.

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
general.

Zena's own runtime (`packages/zena-runtime`) overrides
`send_request` (`src/http_client.rs`), so programs run by `zena-cli`
and `zena-run` get both. One client per process keeps idle
connections open for reuse. `https://` connections offer `h2` and
`http/1.1` through ALPN and use HTTP/2 when the server chooses it;
`http://` connections use HTTP/1.1, except gRPC requests. Request and
response trailers pass through on HTTP/2. A component run by stock
`wasmtime serve` or `wasmtime run -S http` still gets the default
handler, so a gRPC transport needs Zena's host there; under stock hosts,
the fallback transport below works over HTTP/1.1.

A local gRPC server, the Firestore emulator among them, speaks
cleartext HTTP/2 with prior knowledge (h2c): no TLS, so no ALPN, and
HTTP/1.1 requests are refused. A `wasi:http` guest cannot ask for a
protocol version, and gRPC is never valid over HTTP/1.1, so the host
decides from the request: an `http://` request whose `content-type` is
`application/grpc` or `application/grpc+<codec>` goes over h2c, on a
pool of its own.

`protobuf:grpc` is the transport. `GrpcTransport` posts the framed
request to `/<service>/<method>` with `content-type: application/grpc`
and `te: trailers`, and reads framed responses from the body as they
arrive. The call's status comes from the trailers, or from the headers
of a response that carries no messages. `grpc-message` is
percent-decoded, and `grpc-status-details-bin` is decoded from base64
into the `RpcError`'s `status`. A response that is not gRPC maps its
HTTP status as the gRPC specification does (404 is UNIMPLEMENTED, 503
is UNAVAILABLE). Requests are not compressed and no compression is
offered, so a compressed response is an error.

`setTimeout` gives each call a deadline. The transport sends it as
`grpc-timeout`, so the server ends a call still running then with
DEADLINE_EXCEEDED, and also sets the request's first-byte timeout, so a
call whose response never starts fails the same way on the client. The
emulator test holds a document's lock in a transaction and writes it
from a connection with a 300 ms deadline. The fallback transport takes
no deadline yet.

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

The specification does not describe streaming, but Firestore serves
server-streaming methods over it. The body of a streaming method is a
`google.rpc.StreamBody`: each response is an occurrence of field 1, the
final `google.rpc.Status` is field 2, and field 15 is keep-alive
padding. This was observed by posting an empty `GetDocument` and a
`RunQuery` naming a nonexistent project to `firestore.googleapis.com`
without credentials. The first answered 400 with a bare `Status`
(`08 03 ...`, code 3), the second 403 with the `Status` inside field 2 of
a `StreamBody` (`12 a1 03 08 07 ...`, code 7).

`protobuf:fallback` (`packages/protobuf/zena/fallback.zena`) implements
this as `FallbackTransport`, over the `wasi:http` bindings, so it runs
under `wasmtime serve`, whose outgoing HTTP is HTTP/1.1 only.

- `setHeader` sets headers sent on every call, such as `authorization`.
- A streaming call reads the `StreamBody` as its bytes arrive, and hands
  out each response once its bytes are buffered.
- A failed call throws an `RpcError` with the `google.rpc.Code`, the
  message and the encoded `Status`.
- An error response without a `Status` body maps its HTTP status to a
  code, as Google APIs do.

Its tests run a `zena:http` server in the same program, answering as the
fallback protocol does. `examples/firestore-fallback-probe.zena` calls
the real Firestore without credentials, and gets code 7 from both
`getDocument` and `runQuery`. `examples/fallback-service.zena` is a
`wasi:http` service that runs the same `runQuery` while answering a
request. Served by stock `wasmtime serve` 48.0.5, it gets code 7 the
same way, through the host's HTTP/1.1 client.

### REST with JSON

Firestore's REST API covers every RPC except `Listen` and `Write`
([reference](https://docs.cloud.google.com/firestore/docs/reference/rest)).
`runQuery` returns a JSON array of responses. REST would need the
proto3 JSON mapping as a second generated codec: camel-cased field
names, `int64` as strings, and per-type rules for the well-known types.
`zena:json` is a dynamic tree today, with no typed mapping.

### Host requirements

| Requirement                                | Needed by                             | State                                             |
| ------------------------------------------ | ------------------------------------- | ------------------------------------------------- |
| Method, request headers and body           | every transport, auth                 | in the `wasi:http` bindings                       |
| Response trailers                          | gRPC                                  | in the `wasi:http` bindings                       |
| Pooled connections                         | production servers                    | `zena-runtime`; not in wasmtime's default handler |
| HTTP/2 to `*.googleapis.com`               | gRPC                                  | `zena-runtime`; not in wasmtime's default handler |
| An outgoing-request hook in `zena-runtime` | running servers under Zena's own host | done (`src/http_client.rs`)                       |

The guest side needs nothing new. Under `zena-cli` and `zena-run` the
host side is in place too; under stock `wasmtime`, outgoing requests
still open a connection each and use HTTP/1.1.

### Authentication on Cloud Run

On Cloud Run, a service gets an access token by requesting
`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`
with the header `Metadata-Flavor: Google`. The JSON response holds
`access_token` and `expires_in`. The client caches the token until shortly
before it expires, and sends it as `authorization: Bearer <token>`. The
request needs one header, which the `wasi:http` bindings set.

`google-cloud:auth` implements this as `MetadataServerCredentials`, a
`Credentials` that fetches a token on first use and again a minute before
it expires. `defaultCredentials()` uses `GOOGLE_OAUTH_ACCESS_TOKEN` when
it is set, for local runs with a token from
`gcloud auth print-access-token`, and the metadata server otherwise.
`defaultProjectId()` reads `GOOGLE_CLOUD_PROJECT` or asks the metadata
server.

Routing is separate; see [Routing headers](#routing-headers).

## Where generation runs

### Generator library

The generator is a pure Zena library in `packages/protobuf/zena`:

- `lexer.zena` and `parser.zena` read `.proto` text into a syntax tree.
  Options are kept as written, with aggregate values parsed in the text
  format, and the generator reads the ones it uses by name, so the
  `.proto` files declaring them need not be present.
- `schema.zena` loads files and their imports through a function the
  caller passes in, resolves type references with protoc's scoping rules,
  and marks what the roots reach. A missing import is an error only if a
  reached declaration needs a type from it.
- `emitter.zena` writes the Zena source.
- `generator.zena` is the entry point: `generate({files, read, roots?,
runtimeImport?})` returns one module's source.

It does no I/O. `bin/generate.zena` is a command-line program around it,
with `protoc`-style `-I` include directories. Parsing `.proto` text means
users don't need `protoc`. The Google `.proto` files Firestore needs are
vendored in `packages/protobuf/protos`.

Names follow these rules:

- A message or enum takes its nested name. A name that another reached
  type also has, or that the generated module relies on (`String`,
  `Map`, `ProtoView`, ...), gets a prefix from its package, unless it is
  in the first input file's package: a `google.protobuf.Value` beside a
  `google.firestore.v1.Value` becomes `ProtobufValue`.
- Fields and methods are lower camel case. A name that is a Zena keyword
  gets a trailing `_`, as `type` becomes `type_`. Contextual keywords
  that work as member names, such as `from`, are left alone.
- Two members of one class that would share a name get trailing `_`s.

### Build step

A zb or Wireit script can run `bin/generate.zena` and write `.zena`
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

The protobuf package's tests keep a fixture covering each feature
checked in under `test-files/generated`. A test fails when the
generator's output differs from it, and `UPDATE_PROTO_GOLDENS=1` rewrites
it. The generated Firestore module is
`packages/google-cloud/zena/firestore-v1.zena`; that package's test fails
when it is stale, and its `generate` script rewrites it.

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
editor support once in the language service would cover all of them. The
protobuf generator already has this shape: `generate` takes a read
function and returns source.

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

1. Build the generator library and the runtime, run the generator from
   the command line, and check in the output. Iterate on the code shape
   with measurements. Changing the generator does not touch the
   compiler, so it needs no bootstrap reseed. This is done.
2. Once the shape is stable, build the loader-plugin mechanism. Move the
   WIT synthesizer and the protobuf generator onto it, and give the
   language service a way to run synthesizers.

## Measurements

`packages/protobuf/examples` holds two programs over the generated
Firestore module, with a transport that answers with canned bytes, and a
baseline that uses the same standard library pieces (a future, a
`HashMap`, a console line) without protobuf. Built with
`zena-cli -O <n> build`:

| Program                                                                                   | `-O0`   | `-O1`  | `-O2`  |
| ----------------------------------------------------------------------------------------- | ------- | ------ | ------ |
| `baseline.zena`                                                                           | 21,461  | 11,380 | 10,159 |
| `firestore-get.zena`: get a document, read one field                                      | 107,014 | 30,498 | 25,898 |
| `firestore-query.zena`: build a filtered, ordered query, stream results, read every field | 225,255 | 49,818 | 38,723 |

Sizes are in bytes, measured at e1958efd, which added routing headers
(about 1.7 KB at `-O2` in each program). At `-O2` the get program adds
16 KB to the baseline and the query program 29 KB. Dead-field
elimination (#301) took the get program from 26,903 bytes at `-O2` to
24,268 and the query program from 41,996 to 36,919, measured against
the commit before it. In the get program the largest generated
functions are `Value.of` and `Document.of`, which the program calls to
build its canned response; a client that only reads would not reach
them. The generated Firestore module is 9,490 lines, 91 message classes,
9 enums and 30 oneof types, and neither program carries most of it.

Compiling the get program takes about 1.1 s against 0.3 s for the
baseline. The examples import the generated module from the google-cloud
package; importing it by relative path, as part of the local project,
took the same time.

The runtime is checked against `protoc` 36.2: messages `protoc`
encoded from text format decode correctly, and the generated encoders
produce the same bytes for the same values
(`packages/protobuf/test-files/protoc`).

## Compiler limitations met

- A record alias that refers to itself through a type argument does not
  compile, which shaped the encoding side (see
  [Records for encoding](#records-for-encoding)).
  `tests/language/execution/records/recursive_alias_type_argument.zena`
  reproduces it, skipped.
- An imported function held by a top-level `let` and used as a value only
  inside a class method fails in lowering with "non-local identifier".
  The generated code passes arrows over runtime methods instead:
  `(v, p) => v.int32At(p)`.
  `tests/language/execution/imports/let_fn_value_in_class.zena`
  reproduces it, skipped.
- `u32 as i64` sign-extends
  ([#90](https://github.com/elematic/zena/issues/90)). The writer masks
  `uint32` values to 32 bits instead.

## Firestore client layering

The Firestore client has four layers:

1. `protobuf:runtime`: `ProtoView`, `ProtoWriter`, `ProtoList`,
   `ProtoMap`, `ProtoBytes` and the transport interface.
2. Generated views, records, encoders and the `FirestoreClient` for
   `google.firestore.v1`.
3. A hand-written client, `google-cloud:firestore`:
   `db.collection('users').doc(id).get()`, transactions with retry,
   batched writes and query building.
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
the two share one design: [typed-documents.md](typed-documents.md).

### The hand-written client

`Firestore` holds a project and database id and a `FirestoreClient`.
Every call goes through the generated client, so the transport is a
constructor option, and the constructor names no transport of its own.
`Firestore.connect()` uses gRPC, which production servers under
`zena-cli` speak, and reads `FIRESTORE_EMULATOR_HOST` as Google's client
libraries do, talking gRPC to the emulator with the token `owner`.
`Firestore.connectFallback()` uses the fallback transport, for stock
hosts. Each entry point names only its own transport, so a program
carries one: the gRPC transport added about 29 KB at `-O2` to a program
that used only the fallback transport, when the constructor could pick
either.

- `DocumentReference` and `CollectionReference` are paths. `get`, `set`,
  `create`, `update` and `delete` each make one call. `update` sends an
  update mask of the top-level field names and requires the document to
  exist; `create` requires it not to. A `get` of a missing document
  answers a snapshot whose `exists` is false, from the API's NOT_FOUND.
- `Query` is immutable: `where`, `orderBy`, `limit` and `offset` return
  a new query. Several `where` filters are joined by AND. `stream()`
  hands out each document as its response arrives; `get()` collects them.
- `DocumentSnapshot` reads fields by path (`author.name` reaches into map
  values), with a getter per type that answers `(true, value)` or
  `(false, _)`, the standard library's lookup convention.
- `Fields` builds a document's fields, and `stringValue`, `integerValue`
  and the other functions build `Value`s for filters and arrays.
- `runTransaction` begins a read-write transaction, runs the body with a
  `Transaction` that reads in it and collects writes, and commits them.
  When the server aborts the transaction for contention, in a read or
  in the commit, it waits a random time that doubles with each attempt
  and begins again, passing the old id as `retry_transaction`, up to
  five attempts. When the body throws anything else, it rolls back and
  rethrows. The emulator aborts a read that waits too long for another
  transaction's lock; retrying only aborted commits missed that, and
  the emulator tests found it.
- `WriteBatch` commits several writes in one call.

- Field transforms and field deletion are `Fields` entries beside
  values. An `update`'s mask names the fields with values and the
  deleted ones, not the transformed ones, which the server applies
  after the update.
- `getAll` reads documents with `BatchGetDocuments`, whose responses
  come in any order, and answers them in the order asked.
- Cursors take values or a snapshot. A snapshot cursor appends an
  ordering by `__name__` in the direction of the last ordering, as
  Google's client libraries do, so paging never skips or repeats tied
  documents.
- `count()` runs a count aggregation (`RunAggregationQuery`).
- `StructuredQuery` is built from parts, each encoded only when present,
  and merged by concatenating the encodings (`ProtoView.merge`), which
  protobuf defines as a merge. A record literal cannot leave a field out
  conditionally, so building it whole took a branch per combination.
- A program pays only for the features it uses. The optional query
  parts (`where`, `select`, cursors) are classes behind a `QueryPart`
  interface, made by the method that sets them, and a `Fields`' transforms
  and deletions live in a class behind an interface, made by the first
  of them. Reachability keeps an implementation's code only when the
  class is made. Written as fields read by the shared code, these
  features added 12,228 bytes at `-O2` to the README example, which uses
  none of them; written this way they add 4,876. Closures would serve
  the same purpose, but they hit a compiler error ("closure pair struct
  not found") in some programs.

Not built yet: `sum` and `avg` aggregations, `in` and array filters
beyond passing a `Value`, OR filters, listening, and partition queries.

## Implementation plan

Done:

- The runtime: `ProtoView` with its field index, `ProtoWriter`,
  `ProtoList`, `ProtoMap`, `ProtoBytes`, `ProtoStream` and the transport
  interface; and in the standard library, the binary readers it decodes
  with (`data-view.zena`).
- The `.proto` parser, schema loader and emitter, with a command-line
  entry point.
- Host: a `send_request` hook in `zena-runtime` that pools connections
  and negotiates HTTP/2.
- Generated Firestore code, with size measurements.
- Dead-field elimination in the compiler (#301).
- The fallback transport, `protobuf:fallback`, with server streaming.
- Per-call metadata, credentials, and routing headers from
  `google.api.routing` and `google.api.http`.
- `packages/google-cloud`: the generated Firestore module,
  metadata-server credentials, and the hand-written client.
- The gRPC transport, `protobuf:grpc`, and h2c in `zena-runtime` for
  `http://` gRPC requests. The Firestore client runs against the
  emulator over it (`npm run test:emulator -w @zena-lang/google-cloud`,
  which depends on the root `emulators:start` wireit service).

Remaining:

1. A test against the real Firestore, with both transports, locally and
   on Cloud Run under `zena-cli`, once the first draft of everything is
   in.
2. Typed documents.
3. Loader plugins, with WIT and protobuf as the first two users.

## Open questions

- Whether getters should cache decoded values, and for which field types
  (see [Caching decoded fields](#caching-decoded-fields)).
- Whether to validate UTF-8 when reading a `string` field, and if so,
  whether once per view or per read.
- How generated code tests an enum for an unknown value, beyond a
  `case _` arm.
- Whether `ProtoMap` should build a hash table on first lookup, as the
  field index does, instead of scanning per lookup.

## Alternatives considered

- **Eager decoding into classes**, as most protobuf libraries do. One
  decode function reads every field into a struct field, so it reaches
  every field's decoder. Dead-field elimination would remove the struct
  fields the program never reads, but not the decoding: each value is
  still read off the wire, strings and nested messages still allocate,
  and their decoders are still emitted. A program pays for decoding the
  whole message whatever it reads.
- **Eager decoding into records.** Records give structural types and
  pattern matching, but the decode function still sets every field, so
  the cost is the same as eager decoding into classes.
- **Records nested in records for encoding**, `{mask: {fieldPaths: [...]}}`.
  This reads better in a literal, but Firestore's message types are
  recursive, and recursive record aliases through type arguments do not
  compile; see [Records for encoding](#records-for-encoding).
- **`protoc` and a `FileDescriptorSet` as the generator's input.**
  Descriptors give an exact resolved schema, but users would need
  `protoc` or `buf` installed. Proto3's grammar is small enough to parse
  directly, and WIT already set the precedent of parsing source text.
- **REST with JSON as the only transport.** It works over HTTP/1.1 today
  and covers all but the realtime RPCs. It needs a second codec, and
  JSON is larger and slower to parse than the binary encoding the other
  two transports share.
