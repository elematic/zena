# Developing `google-cloud`

This document covers the directory layout, code generation, and test suites for `packages/google-cloud`.

## Directory Layout

```text
packages/google-cloud/
├── zena-package.json       # Zena package manifest
├── package.json            # Monorepo npm/wireit test & codegen runner config
├── firebase.json           # Firestore emulator port configuration
├── src/                    # Published Zena library source files
│   ├── auth.zena           # Credentials and project ID discovery
│   ├── dns.zena            # Cloud DNS REST client
│   ├── firestore.zena      # High-level Firestore client
│   ├── firestore-v1.zena   # Generated protobuf client/messages for google.firestore.v1
│   ├── kms.zena            # Cloud KMS REST client
│   ├── storage.zena        # High-level Cloud Storage client
│   ├── storage-v2.zena     # Generated protobuf client/messages for google.storage.v2
│   └── testing/            # Exported test helpers
│       ├── fake-kms.zena
│       └── firestore-emulator.zena
└── test/                   # Zena test suites
    ├── *_test.zena         # Unit and in-memory transport tests
    └── emulator/
        └── firestore_emulator_test.zena
```

When publishing to the Zena package manager (`zena pkg publish`), `"files": ["src"]` in `zena-package.json` restricts the published archive to `src/`, `zena-package.json`, `README.md`, and `LICENSE`.

## Regenerating Protobuf Modules

`src/firestore-v1.zena` and `src/storage-v2.zena` are generated from the vendored `.proto` schemas in `packages/protobuf/protos/`. Regenerate them from the repository root with:

```sh
npm run generate -w @zena-lang/google-cloud
```

`test/generated_test.zena` verifies that both files match the current output of `protobuf/generator`.

## Testing

From the repository root:

```sh
npm test -w @zena-lang/google-cloud
```

The unit tests run Firestore and Cloud Storage against in-memory `ProtoTransport`s, Cloud DNS and Cloud KMS against local `zena:http` test servers, and `auth` against a local fake metadata server.

### Firestore Emulator Tests

```sh
npm run test:emulator -w @zena-lang/google-cloud
```

Runs the Firestore client against the Firestore emulator over gRPC (`test/emulator/firestore_emulator_test.zena`). It depends on the root `emulators:start` wireit service, which enters the flake's `emulators` shell (`firebase-tools` and Java) and starts the emulator on `127.0.0.1:8180` (`firebase.json`). Each test uses an isolated project ID on the emulator.
