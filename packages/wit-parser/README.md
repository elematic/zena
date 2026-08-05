# WIT Parser

This package contains the WIT (WebAssembly Interface Types) parser for Zena.

## Status

✅ **Implemented** — lexer, parser, resolver, and `.wit.json` serialization, all
written in Zena (`zena/`). The full ported wasm-tools UI corpus passes:
**215/215** (130 parse-fail, 81 ported resolve-and-compare, 4 of our own), plus
one known failure kept as a repro (see below).

**Real `wasi:http@0.2.8` parses and resolves end to end** — 33 files, 7
packages, 31 interfaces, 9 worlds. Getting there took four fixes for
combinations the synthetic corpus never exercised, each now covered by a test of
our own (`versioned-paths/`, `param-doc-comments.wit`,
`interface-shadowed-by-use.wit`); see TEST-STATUS.md.

`wasi:http@0.3.0-rc-2025-09-16` does not yet resolve. One resolver bug remains,
reduced to `tests/cross-package-name-collision/` and registered as an expected
failure: when two packages both declare an `interface types`, an unqualified
`use types.{…}` is answered from the scope stack rather than from the package
that owns the interface, so the two look mutually dependent.

Nothing in the compiler calls this parser yet — see
[component-model.md](../../docs/design/component-model.md) for the integration
and bindgen plan.

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
│   ├── parse-real-wit.js  # Run the parser over real-world WIT
│   ├── fetch-wit-corpus.js # Download the pinned corpus (non-Nix checkouts)
│   └── wit-corpus.js      # Locate + verify the corpus (shared)
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

### The real-world WIT corpus

`npm test` also checks the parser against real `wasi:http`, which is where every
bug the synthetic corpus missed was found. That WIT is third-party and carries
its own license, so it is **fetched, not vendored** — pinned by
[`wit-corpus.json`](wit-corpus.json) (a commit, not a branch) and reaching a
checkout one of two ways:

```bash
nix develop                     # exports ZENA_WASI_WIT; no download, works offline
node dev/fetch-wit-corpus.js    # non-Nix checkouts: downloads to .wit-corpus/
```

**The check fails if the corpus is absent** rather than skipping. A check that
skips reports the same green tick as one that ran, which is how "we test against
real WASI" quietly becomes a claim nobody has verified in months.

Both paths verify content before use, and neither trusts the tarball bytes:
GitHub regenerates archives, so gzip framing changes even when no file does.
Nix's `fetchzip` hashes the unpacked tree; the script hashes the extracted
`.wit` files. Updating the pin means refreshing both hashes — `wit-corpus.json`
documents the commands.

Other modes take explicit directories, so they work on any WIT:

```bash
node dev/parse-real-wit.js --check                      # what npm test runs
node dev/parse-real-wit.js .wit-corpus/wit              # resolve a tree
node dev/parse-real-wit.js --files .wit-corpus/wit      # per-file breakdown
node dev/parse-real-wit.js --probe                      # known-gap repros
```

## Test Formats

### Success Tests (`.wit` + `.wit.json`)

Tests that verify valid WIT files parse correctly. The `.wit.json` file contains the expected JSON representation of the resolved AST.

### Error Tests (`.wit` + `.wit.result`)

Tests that verify invalid WIT files produce expected error messages. The `.wit.result` file contains the expected error with location info.

### Directory Tests

Some tests use directories containing multiple `.wit` files (multi-file packages). The expected output is at the parent level: `dirname.wit.json` or `dirname.wit.result`.

## Next Steps

The parser handles p2; the consumers do not exist yet. See
[component-model.md](../../docs/design/component-model.md):

1. Fix the remaining p3 resolver bug (`cross-package-name-collision`)
2. Expose a stable entry point and add `parseWit()` to the compiler (Part 8)
3. Generate Zena bindings from resolved WIT (Parts 2–5)
