# WIT Parser

This package contains the WIT (WebAssembly Interface Types) parser for Zena.

## Status

🚧 **In Development** - Parser not yet implemented. Test infrastructure is ready.

## Directory Structure

```
packages/wit-parser/
├── README.md              # This file
├── TEST_INVENTORY.md      # Full inventory of tests to port
├── package.json           # Package config with Wireit scripts
├── scripts/
│   └── run-tests.js       # Node-based test runner
└── tests/                 # Ported test files (mirrors wasm-tools ui/ structure)
    ├── empty.wit              # Success test input
    ├── empty.wit.json         # Expected parsed output
    ├── types.wit              # Success test input
    ├── types.wit.json         # Expected parsed output
    └── parse-fail/            # Error test cases
        ├── bad-list.wit           # Error test input
        └── bad-list.wit.result    # Expected error message
```

## Running Tests

```bash
# Run WIT parser tests (from monorepo root)
npm test -w @zena-lang/wit-parser

# Or from this directory
npm test
```

Currently, the test runner operates in **discovery mode** - it verifies test files exist and are properly structured, but skips actual parsing since the parser isn't implemented yet.

## Test Formats

### Success Tests (`.wit` + `.wit.json`)

Tests that verify valid WIT files parse correctly. The `.wit.json` file contains the expected JSON representation of the resolved AST.

### Error Tests (`.wit` + `.wit.result`)

Tests that verify invalid WIT files produce expected error messages. The `.wit.result` file contains the expected error with location info.

### Directory Tests

Some tests use directories containing multiple `.wit` files (multi-file packages). The expected output is at the parent level: `dirname.wit.json` or `dirname.wit.result`.

## Porting Progress

See [TEST_INVENTORY.md](./TEST_INVENTORY.md) for the full list of tests and porting status.

Current progress: **3 / 201 tests ported (1.5%)**

## Future Plans

Once the parser is implemented in Zena:

1. The test runner will compile and invoke the Zena parser
2. For WASI filesystem access, tests may run via wasmtime
3. Parser source will live in `packages/stdlib/zena/wit/`
