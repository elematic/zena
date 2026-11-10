# Development

This document describes the repository layout, test suites, and maintenance
scripts for `packages/wit-parser`.

## Directory Layout

```
packages/wit-parser/
├── zena-package.json          # Zena package manifest
├── package.json               # Monorepo Wireit test orchestration
├── README.md                  # Public package documentation
├── DEVELOPMENT.md             # This file
├── LICENSE                    # MIT license
├── src/                       # Package source (.zena libraries)
│   ├── wit.zena               # Public entry point (parse, parseSyntax, resolve, toJson)
│   ├── token.zena             # Token types and Span
│   ├── lexer.zena             # WIT tokenizer
│   ├── parser.zena            # Recursive-descent parser and AST definitions
│   ├── resolver.zena          # Semantic validation and name resolution
│   ├── document.zena          # Multi-file WIT assembly and error diagnostics
│   ├── component-encoder.zena # Component Model binary type/import section encoder
│   ├── ast-json.zena          # .wit.json serializer (matching wasm-tools)
│   ├── ast-json-types.zena    # Flat schema types for .wit.json output
│   └── helpers.zena           # Identifier, semver, and package-name helpers
├── test/                      # Zena test suites and fixtures
│   ├── syntax_test.zena       # Lexer and parser unit tests
│   ├── corpus_test.zena       # Runner for test/fixtures/wasm-tools and test/fixtures/corpus
│   ├── encoder_test.zena      # Runner for test/fixtures/encoder round-trip tests
│   └── fixtures/
│       ├── wasm-tools/        # Upstream test corpus synced from bytecodealliance/wasm-tools
│       ├── corpus/            # Our own .wit + .wit.json parser/resolver regression cases
│       └── encoder/           # Component encoder fixtures (.wit + .golden.wit)
└── dev/                       # Development and corpus scripts
    ├── wit-corpus.json        # Pinned commits and digests for real-world WASI WIT
    ├── wit-corpus.js          # Locates and verifies the real-world WASI WIT corpus
    ├── fetch-wit-corpus.js    # Downloads the pinned WASI corpus (for non-Nix checkouts)
    ├── parse-real-wit.zena    # Parses and resolves the real-world WASI WIT corpus
    ├── encode-wit.zena        # CLI helper to encode a WIT world as a types-only component
    ├── sync-upstream-tests.sh # Syncs test/fixtures/wasm-tools/ from wasm-tools
    └── wit-multi-instance-check.sh
```

Only `src/`, `zena-package.json`, `README.md`, and `LICENSE` are included when
publishing (`"files": ["src"]` in `zena-package.json`).

## Running Tests

From the monorepo root:

```bash
# Run all WIT parser tests (unit tests, corpus tests, encoder tests, and real-WASI check)
npm test -w @zena-lang/wit-parser

# Inner loop using the already-built CLI
npm run test:quick -- packages/wit-parser/test
```

## Test Suites and Fixtures

### 1. Upstream `wasm-tools` Corpus (`test/fixtures/wasm-tools/`)

Ported from `crates/wit-parser/tests/ui/` in
[bytecodealliance/wasm-tools](https://github.com/bytecodealliance/wasm-tools)
and run by `test/corpus_test.zena`:

- **Success cases (`.wit` + `.wit.json`)**: single `.wit` files, multi-file
  directories (with optional `deps/`), or binary/text components (`.wasm`/`.wat`
  decoded via `wasm-tools component wit`). The resolved AST is serialized with
  `toJson` and compared against the `.wit.json` golden.
- **Error cases (`parse-fail/*.wit` + `.wit.result`)**: invalid WIT documents
  that must fail to parse or resolve.
- **`test-config.json`**: lists any `skip` or `expectedFailures` entries.

To re-sync `test/fixtures/wasm-tools/` from upstream `wasm-tools`:

```bash
./packages/wit-parser/dev/sync-upstream-tests.sh [path-to-wasm-tools]
```

### 2. Local Corpus Regression Cases (`test/fixtures/corpus/`)

Uses the same `.wit` + `.wit.json` format as `test/fixtures/wasm-tools/` and is
run alongside it by `test/corpus_test.zena`, but lives in its own directory so
`dev/sync-upstream-tests.sh` never overwrites local tests.

These cases cover constructs that real WASI packages rely on and that the
upstream `wasm-tools` UI corpus did not exercise:

1. **Pre-release and build semver in `use`/`import` paths** and **versioned
   interface paths in world `import`/`export`** (`versioned-paths/`).
2. **Doc comments inside function parameter lists** (`param-doc-comments.wit`).
3. **An interface name shadowed by a type bound from an earlier `use`**
   (`interface-shadowed-by-use.wit`, from `wasi:sockets` where
   `interface network` declares `resource network`).
4. **The same interface name across two packages**
   (`cross-package-name-collision/`, from `wasi:clocks` and `wasi:sockets` both
   declaring `interface types`).

### 3. Component Encoder Fixtures (`test/fixtures/encoder/`)

Run by `test/encoder_test.zena`. Each `<name>.wit` fixture has a target world
that `encodeTypesOnlyComponent` encodes into a binary component. The test
validates the output with `wasm-tools validate --features all` and checks that
`wasm-tools component wit` prints the `<name>.golden.wit` file beside it.

To regenerate goldens after an intentional encoder change:

```bash
UPDATE_WIT_GOLDENS=1 ./target/release/zena-cli test packages/wit-parser/test/encoder_test.zena
```

### 4. Real-World WASI WIT Corpus (`dev/wit-corpus.json`)

`npm test` also runs `dev/parse-real-wit.zena --check` against three real WASI
trees:

| Tree                                  | Packages / Interfaces / Worlds |
| ------------------------------------- | ------------------------------ |
| WASI 0.2 (`wasi:http@0.2.8` + 6 deps) | 7 / 31 / 9                     |
| WASI 0.3.0-rc-2025-09-16 draft        | 6 / 25 / 8                     |
| WASI 0.3.0 (released)                 | 6 / 25 / 8                     |

Because third-party WASI WIT files carry their own license, the corpus is
fetched rather than checked into the repository. Commits and content digests are
pinned in `dev/wit-corpus.json`:

- **With Nix**: `nix develop` (or `direnv`) exports `ZENA_WASI_WIT` pointing to
  the unpacked Nix store path.
- **Without Nix**: run `node packages/wit-parser/dev/fetch-wit-corpus.js` to
  download and verify the corpus into `packages/wit-parser/.wit-corpus/`.

You can also run `dev/parse-real-wit.zena` manually on any directory of `.wit`
files from the monorepo root:

```bash
./target/release/zena-cli run --dir . --dir / packages/wit-parser/dev/parse-real-wit.zena --check
./target/release/zena-cli run --dir . --dir / packages/wit-parser/dev/parse-real-wit.zena "$ZENA_WASI_WIT/wasi/proposals"
./target/release/zena-cli run --dir . --dir / packages/wit-parser/dev/parse-real-wit.zena --files "$ZENA_WASI_WIT/wasi-http/wit"
```
