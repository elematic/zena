# Protobuf for Zena

A generator that turns `.proto` files into Zena source, and the runtime
the generated code calls. The design, and the reasons for the shape of
the generated code, are in
[docs/design/protobuf.md](../../docs/design/protobuf.md).

## Generating code

From the repository root:

```sh
./target/release/zena-cli run --dir . packages/protobuf/bin/generate.zena -- \
  -I path/to/protos -I packages/protobuf/protos \
  -o out/firestore.zena google/firestore/v1/firestore.proto
```

- `-I <dir>`: where to look for the named files and their imports, in
  order. `packages/protobuf/protos` has the Google well-known types and
  the Firestore protos.
- `--root <full.name>`: generate only this message, enum or service and
  what it refers to. Repeatable. Without it, everything declared in the
  named files is generated.
- `--runtime <specifier>`: where the generated module imports the
  runtime from. The default is `protobuf:runtime`, which needs a
  `"protobuf": "./packages/protobuf/zena"` entry in `zena-packages.json`.

The same generator is a library, with no I/O of its own:

```zena
import {generate} from 'protobuf:generator';

let source = generate({files: ['a.proto'], read: (path) => readFromSomewhere(path)});
```

## Using generated code

For each message `M` there is a class `M`, which reads an encoded
message, and a record type `MInit`, which `M.of` encodes:

```zena
let doc = Document.decode(bytes);
let title = doc.fields.getOr('title', Value.of({}));
let text = match (title.valueType) {
  case ValueStringValue {value}: value
  case _: ''
};

let fields = new HashMap<String, Value>();
fields['title'] = Value.of({stringValue: 'Hello'});
let encoded = Document.of({name, fields}).protoView.toByteArray();
```

A message-typed field takes the message's class, so nested messages are
built inside out with `M.of`, and a message read from one response can
go into the next request unchanged.

For each service there is a client class over a `ProtoTransport`.
`protobuf:fallback` provides one: `FallbackTransport` speaks Google's gRPC
fallback protocol (binary protobuf posted to `/$rpc/<service>/<method>`)
over `wasi:http`, so it works on hosts whose outgoing HTTP is HTTP/1.1,
such as `wasmtime serve`, and supports server-streaming methods:

```zena
let transport = new FallbackTransport('https://firestore.googleapis.com');
transport.setHeader('authorization', `Bearer ${token}`);
let firestore = new FirestoreClient(transport);
let doc = await firestore.getDocument({name: path});
for await (let response in firestore.runQuery({parent, structuredQuery})) {
  ...
}
```

A failed call throws an `RpcError` carrying the `google.rpc.Code`.

## Layout

- `zena/runtime.zena`: `ProtoView`, `ProtoWriter`, `ProtoList`, `ProtoMap`,
  `ProtoBytes`, `ProtoStream` and the transport interface.
- `zena/fallback.zena`: `FallbackTransport`, for component targets.
- `zena/lexer.zena`, `zena/parser.zena`: `.proto` source to a syntax tree.
- `zena/schema.zena`: loading imports, resolving names, choosing what to
  generate.
- `zena/emitter.zena`: the Zena source.
- `zena/generator.zena`: the library's entry point.
- `bin/generate.zena`: the command-line program.
- `protos/`: vendored Google `.proto` files.
- `examples/`: programs over the generated Firestore code, used for the
  size measurements in the design doc.
- `test-files/protos/`: the test schema. `test-files/generated/`: the
  generator's output for it and for Firestore, checked in and compiled by
  the tests. `test-files/protoc/`: messages `protoc` encoded.

## Testing

```sh
npm test -w @zena-lang/protobuf
```

When the generator's output changes on purpose, regenerate the checked-in
modules and review the diff:

```sh
UPDATE_PROTO_GOLDENS=1 ./target/release/zena-cli test packages/protobuf/zena/test/generator_test.zena
```
