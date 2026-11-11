# Developing `protobuf`

This document covers the internal layout, test fixtures, and CLI codegen script for `packages/protobuf`.

## Directory Layout

```text
packages/protobuf/
├── zena-package.json       # Zena package manifest
├── package.json            # Monorepo npm/wireit test runner config
├── src/                    # Published Zena library source files
│   ├── runtime.zena        # Wire-format views, writers, and transport interface
│   ├── grpc.zena           # gRPC over HTTP/2 transport
│   ├── fallback.zena       # Google gRPC fallback ($rpc) transport
│   ├── http.zena           # Shared HTTP header/request helpers
│   ├── lexer.zena          # .proto tokenizer
│   ├── parser.zena         # .proto parser and AST
│   ├── schema.zena         # Import loading, name resolution, reachability
│   ├── emitter.zena        # Zena source emitter
│   ├── generator.zena      # High-level codegen entry point
│   └── text.zena           # Protobuf text format helpers
├── bin/
│   └── generate.zena       # Command-line generator script used in the monorepo
├── protos/                 # Vendored upstream Google .proto schemas
└── test/                   # Zena test suites and fixtures
    ├── *_test.zena         # Unit and integration tests
    └── fixtures/
        ├── protos/         # Test .proto schemas (zena/test/v1/everything.proto)
        ├── generated/      # Checked-in golden Zena output (everything.zena)
        └── protoc/         # Golden wire-format bytes (.binpb) encoded by protoc
```

When publishing to the Zena package manager (`zena pkg publish`), `"files": ["src"]` in `zena-package.json` restricts the published archive to `src/`, `zena-package.json`, `README.md`, and `LICENSE`.

## Running the CLI Generator

From the repository root:

```sh
./target/release/zena-cli run --dir . packages/protobuf/bin/generate.zena -- \
  -I path/to/protos -I packages/protobuf/protos \
  -o out/service.zena path/to/service.proto
```

- `-I <dir>`: include directories searched in order for entry `.proto` files and their imports. `packages/protobuf/protos` contains the vendored Google well-known types and API protos.
- `--root <full.name>`: generate only this message, enum, or service and what it transitively refers to (repeatable).
- `--runtime <specifier>`: module specifier for runtime imports in the generated file (defaults to `protobuf/runtime`).

## Testing

From the repository root:

```sh
npm test -w @zena-lang/protobuf
```

When the code generator's output changes intentionally, regenerate the checked-in golden fixture (`test/fixtures/generated/everything.zena`) and review the diff:

```sh
UPDATE_PROTO_GOLDENS=1 ./target/release/zena-cli test packages/protobuf/test/generator_test.zena
```
