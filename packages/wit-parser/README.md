# WIT Parser

This package contains the WIT (WebAssembly Interface Types) parser for Zena.

## Status

✅ **Implemented** — lexer, parser, resolver, and `.wit.json` serialization, all
written in Zena (`zena/`). The full ported wasm-tools UI corpus passes:
**215/215** (130 parse-fail, 81 ported resolve-and-compare, 4 of our own).

**Real WASI parses and resolves end to end** — three trees, checked on every
`npm test`:

| tree | packages / interfaces / worlds |
| --- | --- |
| WASI 0.2 (`wasi:http@0.2.8` + 6 deps) | 7 / 31 / 9 |
| WASI 0.3.0-rc-2025-09-16 draft | 6 / 25 / 8 |
| **WASI 0.3.0, released** | 6 / 25 / 8 |

Getting there took five fixes for combinations the synthetic corpus never
exercised — passing it was no evidence at all that real WASI would work. Each is
now covered by a test of our own (`versioned-paths/`, `param-doc-comments.wit`,
`interface-shadowed-by-use.wit`, `cross-package-name-collision/`); see
TEST-STATUS.md.

## Using it

The parser is a Zena package. `zena-packages.json` at the repository root maps
it, so any Zena code in this repo can import it:

```zena
import { parse } from 'wit-parser:wit';
import { AstItemTag } from 'wit-parser:parser';

let doc = parse(source);   // parses AND resolves; throws on either failure
```

`zena/wit.zena` is the entry point:

| | |
| --- | --- |
| `parse(source)` | parse + resolve → `Ast`. What you almost always want. |
| `parseSyntax(source)` | parse only, for tooling that reparses a file in isolation |
| `resolve(ast)` | resolve an AST in place, for documents assembled from several sources |
| `toJson(ast, order?)` | the `.wit.json` shape `wasm-tools` emits |

The names are unqualified because the module already says what they are about;
rename at the import site if `parse` is ambiguous in context. The test harness
does exactly that — it has its own `parse()` export, so it imports
`parse as parseWit`.

Errors are thrown, not returned — `Result<T, E>` is an inline multi-value union
([result-option.md](../../docs/design/result-option.md)) but is not in the
stdlib yet. `ParseError` and `ResolveError` both carry a `Span`.

The AST types live in `wit-parser:parser`; walking a document touches most of 87
declarations, so `wit.zena` re-exports only what you need to call it and catch
its failures.

`examples/parse-wit.zena` is a runnable consumer. It sits outside the package
root deliberately, so it can only reach the parser through the package map — it
stops compiling if that wiring breaks, which a test using relative imports would
not.

That guard only works if something builds it, and for a while nothing did: the
example had rotted into calling `.toString()` on an `i32`, which neither
compiler accepts. `npm test` now type-checks it (`test:example`).

> **All 12 modules now compile under the self-hosted compiler.** Every
> blocker is fixed: generic *private* methods (`Parser.#parseList<T>`,
> 0e7effe4), distributed sealed variants and block-scoped function bindings
> (#164), and self/forward-referencing closure captures (#165).
>
> **Consuming the package from another module still crashes that compiler**,
> so this example builds only under the bootstrap. A caller reaching the
> package through the package map dies in emit with `Invalid ref_func:
> index < 0`; compiling this package as an *entry point* is fine, and a
> type-only import is fine, so it is the cross-module **call** that trips
> it. See BUGS.md. It blocks the next stage directly: making WIT imports
> first-class makes the compiler itself a consumer of this package.

Nothing in the *compiler* calls the parser yet — making WIT imports first-class
is the next step; see
[component-model.md](../../docs/design/component-model.md).

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

`npm test` also checks the parser against real WASI, which is where every bug
the synthetic corpus missed was found. That WIT is third-party and carries its
own license, so it is **fetched, not vendored** — pinned by
[`wit-corpus.json`](wit-corpus.json) (commits, not tags or branches) and
reaching a checkout one of two ways:

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

Two sources are pinned, laid out as `<root>/<source-name>/…` by both fetchers:

- **`wasi-http`** — `WebAssembly/wasi-http`, which carries WASI 0.2 (`wasi:http@0.2.8`
  with its six deps vendored under `wit/deps/`) and the `0.3.0-rc-2025-09-16`
  draft. That repo is archived, having been merged into `WebAssembly/WASI`, so
  the pin will not move again. Its layout — deps vendored, the package header in
  only one file per package — is what exposed the ordering bugs.
- **`wasi`** — `WebAssembly/WASI` at `v0.3.0`, where 0.3 actually lives now.
  Structurally different: one `wit/` per proposal under `proposals/`, with *no*
  vendored deps, so resolving it leans on topological package ordering instead.

Both pins are deliberately behind upstream (0.2 is now at 0.2.12, and 0.3 has
newer RCs). They are fixtures, not a dependency — bump them when there is a
reason to.

Other modes take explicit directories, so they work on any WIT:

```bash
node dev/parse-real-wit.js --check                      # what npm test runs
node dev/parse-real-wit.js .wit-corpus/wasi/proposals   # resolve a tree
node dev/parse-real-wit.js --files .wit-corpus/wasi-http/wit  # per-file breakdown
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

The parser is done, p2 and p3 alike; the consumers do not exist yet. See
[component-model.md](../../docs/design/component-model.md):

1. ~~Expose a stable entry point~~ — done, `zena/wit.zena`
2. Make WIT imports first-class in the compiler: a WIT-backed package resolves
   to a `SourceFile` whose `ModuleExports` are synthesized from the resolved
   WIT, so `import {Request} from 'wasi:http/types'` binds real symbols with no
   generated source (Parts 2–5)
