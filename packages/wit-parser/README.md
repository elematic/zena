# WIT Parser

This package contains the WIT (WebAssembly Interface Types) parser for Zena.

## Status

✅ **Implemented** — lexer, parser, resolver, and `.wit.json` serialization, all
written in Zena (`zena/`). The full ported wasm-tools UI corpus passes:
**211/211** (130 parse-fail + 81 resolve-and-compare).

⚠️ Passing that corpus is **not** sufficient to parse real WASI packages. The
upstream UI tests miss three combinations that every shipping WASI package uses,
so `wasi:http` (p2 and p3) does not parse today. The gaps are documented with
minimal repros in [component-model.md](../../docs/design/component-model.md),
Part 9, and reproducible with `node dev/parse-real-wit.mjs --probe`.

Nothing in the compiler calls this parser yet — see the same document for the
integration and bindgen plan.

## Directory Structure

```
packages/wit-parser/
├── README.md              # This file
├── package.json           # Package config with Wireit scripts
├── zena/                  # The parser itself, in Zena
│   ├── lexer.zena
│   ├── parser.zena
│   ├── resolver.zena
│   ├── ast-json.zena      # .wit.json serialization
│   └── *-test-harness.zena
├── src/scripts/
│   └── run-tests.ts       # Node-based test runner
├── dev/
│   └── parse-real-wit.mjs # Run the parser over real-world WIT
└── tests/                 # Ported test files (mirrors wasm-tools ui/ structure)
    ├── empty.wit              # Success test input
    ├── empty.wit.json         # Expected parsed output
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

The runner compiles the Zena parser to WASM, instantiates it, feeds each test's
WIT in, and compares the result against the expected `.wit.json` or
`.wit.result`.

To check the parser against real-world WIT rather than the synthetic corpus:

```bash
curl -L https://github.com/WebAssembly/wasi-http/archive/refs/heads/main.tar.gz | tar xz
node dev/parse-real-wit.mjs wasi-http-main/wit wasi-http-main/wit-0.3.0-draft
node dev/parse-real-wit.mjs --files wasi-http-main/wit   # per-file breakdown
node dev/parse-real-wit.mjs --probe                      # known-gap repros
```

## Test Formats

### Success Tests (`.wit` + `.wit.json`)

Tests that verify valid WIT files parse correctly. The `.wit.json` file contains the expected JSON representation of the resolved AST.

### Error Tests (`.wit` + `.wit.result`)

Tests that verify invalid WIT files produce expected error messages. The `.wit.result` file contains the expected error with location info.

### Directory Tests

Some tests use directories containing multiple `.wit` files (multi-file packages). The expected output is at the parent level: `dirname.wit.json` or `dirname.wit.result`.

## Next Steps

The parser is done; the consumers are not. See
[component-model.md](../../docs/design/component-model.md):

1. Fix the three real-world parse gaps (Part 9)
2. Expose a stable entry point and add `parseWit()` to the compiler (Part 8)
3. Generate Zena bindings from resolved WIT (Parts 2–5)
