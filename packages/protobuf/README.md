# protobuf

A Protocol Buffers (`.proto`) code generator, wire-format runtime, and gRPC / gRPC-fallback transports for Zena.

## Installation

```sh
zena pkg add @zena/protobuf
```

## Generating Code

`protobuf/generator` compiles `.proto` schemas into Zena source code with no I/O of its own—you supply the entry file paths and a callback that reads imported `.proto` files:

```zena
import { generate } from 'protobuf/generator';

let source = await generate({
  files: ['service.proto'],
  read: async (path) => readProtoFile(path),
});
```

### Options (`GenerateOptions`)

- `files`: `Array<String>` — entry `.proto` files to generate from.
- `read`: `(path: String) => Future<String | null>` — returns the `.proto` text for `path`, or `null` if not found.
- `roots`: `Array<String>` (optional) — generate only the named messages, enums, or services (by full name) and the types they transitively reference. When omitted or empty, everything declared in `files` is generated.
- `runtimeImport`: `String` (optional) — module specifier that generated code imports runtime helpers from (defaults to `'protobuf/runtime'`).

## Using Generated Code

For each message `M`, the generator emits a view class `M` (which reads an encoded message in place without eagerly allocating child objects) and a record type `MInit`, which `M.of` encodes:

```zena
import { HashMap } from 'zena:collections';

// Decoding wire bytes
let doc = Document.decode(bytes);
let title = doc.fields.getOr('title', Value.of({}));
let text = match (title.valueType) {
  case ValueStringValue {value}: value
  case _: ''
};

// Encoding a message
let fields = new HashMap<String, Value>();
fields['title'] = Value.of({stringValue: 'Hello'});
let encoded = Document.of({name, fields}).protoView.toByteArray();
```

A message-typed field accepts the message's class, so nested messages are built inside out with `M.of`, and a message read from one response can be passed into another message unchanged without re-encoding.

## Services and Transports

For each `service` in a `.proto` file, the generator emits a client class over `ProtoTransport` (`protobuf/runtime`). Two transports speak over `wasi:http`, both supporting unary and server-streaming RPCs (and `GrpcTransport` also supporting client-streaming RPCs):

- **`protobuf/grpc`** (`GrpcTransport`): standard gRPC over HTTP/2 (`https://` via ALPN or cleartext HTTP/2 for `http://`).
- **`protobuf/fallback`** (`FallbackTransport`): Google's gRPC HTTP/1.1 `$rpc` fallback protocol (binary protobuf posted to `/$rpc/<service>/<method>`), usable on hosts whose outgoing HTTP is HTTP/1.1 only.

```zena
import { GrpcTransport } from 'protobuf/grpc';

let transport = new GrpcTransport('https://example.googleapis.com', credentials);
let client = new MyServiceClient(transport);
let response = await client.getItem({name: 'items/1'});
```

`credentials` is any `Credentials` (`protobuf/runtime`), which supplies the `authorization` header before each call. Generated clients also populate the `x-goog-request-params` routing header from `google.api.http` and `google.api.routing` options ([AIP-4222](https://google.aip.dev/client-libraries/4222)). Failed calls throw `RpcError` (`protobuf/runtime`) carrying the `google.rpc.Code`.

## Libraries

- `protobuf/runtime` — Wire-format views and writers (`ProtoView`, `ProtoWriter`, `ProtoList`, `ProtoMap`, `ProtoBytes`, `ProtoStream`), `ProtoTransport`, `Credentials`, `RpcMetadata`, `RpcMethod`, and `RpcError`.
- `protobuf/grpc` — `GrpcTransport` over HTTP/2.
- `protobuf/fallback` — `FallbackTransport` over Google's HTTP/1.1 `$rpc` fallback protocol.
- `protobuf/generator` — `generate` and `GenerateOptions` for turning `.proto` files into Zena source.
- `protobuf/parser` and `protobuf/lexer` — `.proto` syntax tree and tokenizer (`parseProto`, `Lexer`).
- `protobuf/schema` and `protobuf/emitter` — Schema resolution and Zena code emission.
- `protobuf/text` — Protobuf text format helpers.

## License

MIT
