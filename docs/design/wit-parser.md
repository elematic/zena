# WIT Parser in Zena

## Status

- **Status**: Completed (Resolution and Serialization Polish)
- **Last Updated**: 2026-07-14
- **Current Completion**: 211/211 tests passing (100.0%)
  - Error/Parse-Fail tests: 130/130 passing (100%)
  - Success/JSON-Compare tests: 81/81 passing (100.0%)
  - Remaining: 0 tests failing, 0 skipped

## Overview

This document outlines the plan for implementing a WebAssembly Interface Types
(WIT) parser in Zena. The parser will be used by the Zena compiler to:

1. Parse WIT files that define component interfaces
2. Generate Zena type bindings from WIT definitions (see [WASI
   Support](./wasi.md) for type mappings)
3. Enable Zena to be a first-class Component Model citizen

The implementation follows **Option C** from our research: port the test suite
from the canonical Rust implementation first, then implement the parser against
those tests.

## Goals

1. **Test-Driven**: Port the wasm-tools test suite before writing parser code
2. **Pure Zena**: Implement the parser in Zena itself (dogfooding)
3. **Integrated**: Use the parser from our TypeScript compiler via WASM
4. **Bootstrappable**: Handle the circular dependency elegantly

## Reference Implementation

The canonical WIT parser lives in
[bytecodealliance/wasm-tools](https://github.com/bytecodealliance/wasm-tools):

- **Lexer**: ~800 lines in
  [`crates/wit-parser/src/ast/lex.rs`](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-parser/src/ast/lex.rs)
- **Parser/AST**: ~1700 lines in
  [`crates/wit-parser/src/ast.rs`](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-parser/src/ast.rs)
- **Resolver**: ~1500 lines in
  [`crates/wit-parser/src/ast/resolve.rs`](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-parser/src/ast/resolve.rs)
- **Test Suite**: ~70+ `.wit` files in
  [`crates/wit-parser/tests/ui/`](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-parser/tests/ui)

---

## Phase 1: Test Infrastructure ✅ COMPLETE

216 cases are ported from wasm-tools: 78 that must resolve and 138 that must
fail.

### 1.1 Test Format

The cases come from wasm-tools' `tests/ui/` directory and live under
`packages/wit-parser/tests/`. A case is:

- **Input**: a `.wit` file, a directory of them, or a component carrying WIT
  (`.wat` or `.wasm`), which `wasm-tools component wit` decodes
- **Expected output**: a `.wit.json` file holding the resolved AST, in the shape
  `wasm-tools component wit --json` emits
- **Error case**: a `.wit.result` file in place of the JSON, holding the error
  upstream reports; the document has to fail to parse or resolve

```
packages/wit-parser/
├── tests/                       # Ported from wasm-tools
│   ├── types.wit                # Input
│   ├── types.wit.json           # Expected resolved AST
│   ├── complex-include/         # One package over several files
│   ├── complex-include.wit.json
│   ├── parse-fail/              # Error cases
│   │   ├── bad-list.wit
│   │   └── bad-list.wit.result
│   └── test-config.json         # Cases held out by name
└── zena/test/
    ├── syntax_test.zena         # Lexer and parser
    ├── corpus_test.zena         # This corpus
    └── encoder_test.zena        # Component encoder round-trip
```

### 1.2 Test Runner

`corpus_test.zena` is a Zena test, run by `zena test` like the standard
library's, which gives it `zena:fs` under WASI with the repository preopened as
`.`:

1. It walks `tests/`, pairing each input with the expectation beside it
2. It reads a case's document and parses and resolves it through `wit.zena`
3. For a `.wit.json` case it serializes the AST with `toJson` and compares it to
   the golden with `zena:assert`'s `jsonEqual`
4. A `.wit.result` case has to throw; the message is not compared yet
5. `zena:test` reports, and a failure is what wireit sees

A directory case is one package spread over several files, possibly with
vendored dependencies under `deps/`. The parser takes a single string, so the
files are concatenated: main files first, then deps, each group sorted by path,
and within one directory the file carrying the `package ...;` header first — a
package's header has to precede its items, which `wasm-tools` does not require
because it parses each file separately and merges by package name.

Two faults in the corpus are properties of a file rather than of a document, so
concatenating destroys them and the test checks for them textually: two files
declaring different packages, and a file using an alias a sibling created.

Run the whole set, or one file with its own output:

```bash
npm test -w @zena-lang/wit-parser
./target/release/zena-cli test --single packages/wit-parser/zena/test/corpus_test.zena
```

---

## Phase 2: String Interop ✅ COMPLETE

The TypeScript compiler needs to pass strings into and receive strings from the
WIT parser WASM module.

**Verified 2026-02-12**: The `echo.zena` test module confirms bidirectional
string passing works via the import/export pattern.

### 2.1 Current String Reading

`@zena-lang/runtime` already provides string reading utilities:

```typescript
// packages/runtime/src/index.ts
export function createStringReader(exports: WebAssembly.Exports) {
  const getByte = exports.$stringGetByte as (str: unknown, i: number) => number;
  return (strRef: unknown, length: number): string => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = getByte(strRef, i) & 0xff;
    }
    return new TextDecoder().decode(bytes);
  };
}
```

### 2.2 String Writing (New)

We need the inverse: write a JavaScript string into WASM memory for the parser
to consume. Options:

**Option A: Linear Memory + Allocation**

Export an allocator from Zena, write bytes to linear memory:

```typescript
// In runtime package
export function createStringWriter(exports: WebAssembly.Exports) {
  const alloc = exports.$alloc as (size: number) => number;
  const memory = exports.memory as WebAssembly.Memory;

  return (str: string): {ptr: number; len: number} => {
    const bytes = new TextEncoder().encode(str);
    const ptr = alloc(bytes.length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return {ptr, len: bytes.length};
  };
}
```

**Option B: Import-Based Streaming**

Pass string bytes via imports (no linear memory needed):

```zena
// Zena side - parser receives string via imports
@external("wit-parser", "get_source_byte")
declare function __getSourceByte(index: i32): i32;

@external("wit-parser", "get_source_length")
declare function __getSourceLength(): i32;
```

```typescript
// TypeScript side
const source = 'package foo:bar;';
const imports = {
  'wit-parser': {
    get_source_byte: (i: number) => source.charCodeAt(i),
    get_source_length: () => source.length,
  },
};
```

**Recommendation**: Start with **Option B** (import-based) for simplicity. It
requires no linear memory management and works naturally with WASM-GC. We can
optimize with Option A later if performance is a concern.

### 2.3 Result Serialization

The parser needs to return structured results. Options:

1. **JSON String**: Parser outputs JSON string, TypeScript parses it
2. **Accessor Functions**: Export getters like the test runner does
3. **Shared Types**: Define types that both Zena and TypeScript understand

For the initial implementation, we'll use **JSON string output** since:

- We need JSON anyway to compare with `.wit.json` expected outputs
- `zena:json` already has serialization support
- Single function call is simpler than many accessor exports

---

## Phase 3: Parser Implementation [IN PROGRESS]

Once tests are in place, implement the parser itself.

### 4.1 Module Structure

```
packages/wit-parser/zena/
├── token.zena              # Token types, Span           ✅ COMPLETE
├── lexer.zena              # Tokenizer class             ✅ COMPLETE
├── parser.zena             # Recursive descent parser    ✅ COMPLETE
├── resolver.zena           # Name resolution             ✅ COMPLETE (under testing/polish)
├── ast-json.zena           # JSON serialization          ✅ COMPLETE (under testing/polish)
├── wit.zena                # Public entry point          ✅ COMPLETE
└── test/                   # The tests, in Zena          ✅ COMPLETE
```

### 4.2 Implementation Order

1. **Lexer** ✅ COMPLETE (~350 lines)
   - Token enum with all WIT tokens (47 token types)
   - Span tracking for error messages
   - Unicode identifier support
   - Full coverage of wasm-tools test files

2. **AST Types** ✅ COMPLETE (in parser.zena, ~800 lines)
   - Node types for all WIT constructs
   - Uses tagged class pattern (Zena lacks sum types with payloads)
   - Docs, stability annotations

3. **Parser** ✅ COMPLETE (~1100 lines)
   - Recursive descent, LL(1) with some lookahead
   - Package declarations with versions
   - Interface and world definitions
   - Type definitions (record, variant, enum, flags, resource, alias)
   - Function signatures with async support
   - Use/include statements
   - Annotations (@since, @unstable, @deprecated)
   - Multi-file package support

4. **Resolver** ✅ COMPLETE (in resolver.zena, ~2750 lines)
   - Performs semantic validation and package/interface/world resolution
   - Type interning, scoping, cycle tracking, and use/include validation
   - Transitive dependency-conflict checking

5. **JSON Output** ✅ COMPLETE (in ast-json.zena, ~550 lines)
   - Serializes resolved AST to match `.wit.json` format exactly

### 4.3 Parser Next Steps

Syntax parsing and resolver/serializer implementations are complete. All 90/90 semantic validation tests (error cases) are passing. The remaining failures (3 success tests) are JSON serialization or scoping discrepancies categorized below:

### Failing Success Test Categories

1. **Multi-file/Package Resolution** (3 tests remaining)
   - _Issue_: Multi-file packages and cross-package uses do not resolve their structures fully, or are ordered differently.
   - _Example_: `foreign-deps`, `foreign-deps-union`, `multi-file`

### 4.4 Zena Features Exercised

This project will stress-test:

- **String handling**: Parsing, slicing, spans
- **Enums/variants**: Token types, AST nodes
- **Classes**: Tokenizer, Parser, Resolver
- **Pattern matching**: Token dispatch
- **Error handling**: Parse errors with locations
- **Generics**: Collections (if we use Arena patterns)

---

## Phase 4: Integration [NOT STARTED]

Designed in [component-model.md](./component-model.md), which is the document of
record for everything past the parser: what a WIT import means, named import
slots, the type mapping, the canonical ABI, and component emission.

The sketch that used to sit here is gone for the same two reasons Phase 3 was.
It integrated with the **TypeScript** compiler (`packages/compiler/src/wit-integration.ts`),
which is being retired; and it generated Zena _source_ from WIT, which is not the
direction — WIT is to be first-class in the compiler, with a WIT-backed package
resolving to a `SourceFile` whose `ModuleExports` are synthesized from the
resolved WIT, so no `.zena` files are emitted at all.

## Appendix A: WIT Test File Reference

Key test files from wasm-tools to port:

| File                    | Description                       |
| ----------------------- | --------------------------------- |
| `types.wit`             | All primitive and composite types |
| `functions.wit`         | Function signatures               |
| `resources.wit`         | Resource types and methods        |
| `async.wit`             | Async functions, futures, streams |
| `worlds-with-types.wit` | World declarations                |
| `package-syntax*.wit`   | Package declarations              |
| `versions.wit`          | Versioning syntax                 |
| `feature-gates.wit`     | `@since` and `@unstable`          |
| `parse-fail/*.wit`      | Error cases                       |

---

## Appendix B: JSON Output Format

The `.wit.json` files use a specific schema. Example for a simple world:

```json
{
  "worlds": [
    {
      "name": "my-world",
      "imports": {
        "interface:foo:bar/baz": {
          "interface": 0
        }
      },
      "exports": {}
    }
  ],
  "interfaces": [
    {
      "name": "baz",
      "types": {},
      "functions": {}
    }
  ],
  "types": [],
  "packages": [
    {
      "name": "foo:bar",
      "interfaces": {"baz": 0},
      "worlds": {"my-world": 0}
    }
  ]
}
```

---

## TODO List

### Phase 1a: Test Inventory ✅ COMPLETE

- [x] Generate complete list of test files from wasm-tools `tests/ui/`
- [x] Categorize tests by type (basic types, records, functions, resources,
      etc.)
- [x] Identify which tests have `.wit.json` vs `.wit.result` expected outputs
- [x] Document test count and save inventory to
      `tests/wit-parser/TEST_INVENTORY.md`

**Results**: 201 total tests identified (85 success tests, 116 error tests)
across 10 categories. See [TEST_INVENTORY.md](../../tests/wit-parser/TEST_INVENTORY.md)
for full details.

### Phase 1b: Single Test + Runner (validate format) ✅ COMPLETE

- [x] Create `tests/wit-parser/ui/` directory structure
- [x] Port initial tests: `empty.wit`, `types.wit` (success cases)
- [x] Port initial error test: `parse-fail/bad-list.wit`
- [x] Build test runner that can run these tests
- [x] Validate the test format works end-to-end
- [x] Adjust test format if needed before mass porting

**Results**: the runner discovers cases recursively and validates file pairs.
Format kept as-is: a single-file case uses a sibling `.wit.json`/`.wit.result`,
a multi-file case a directory.

### Phase 1c: Port Remaining Tests ✅ COMPLETE

- [x] Port all `.wit` test files from inventory
- [x] Port corresponding `.wit.json` expected outputs
- [x] Port `parse-fail/` error case tests
- [x] Verify test count matches inventory

**Results**: 194 tests ported total:

- 72 success tests (single-file and directory tests)
- 122 error tests (parse-fail/ directory)

All tests discovered by test runner and validated. Tests are skipped until
the parser is implemented.

### Test Runner

- [ ] Add `--runtime wasmtime` flag to CLI test command
- [ ] Implement wasmtime spawning with `--dir` flags
- [ ] Pass exit code and stdout back to reporter
- [ ] Document `@requires: wasmtime` directive usage

### String Interop

- [ ] Add `createStringWriter` to `@zena-lang/runtime` (Option A)
- [ ] OR: Define import-based string passing protocol (Option B)
- [ ] Test string round-trip: TS → WASM → TS
- [ ] Document string interop patterns

### Bootstrap

- [ ] Create `packages/compiler/src/wit-parser.wasm` placeholder
- [ ] Add `scripts/build-wit-parser.ts` script
- [ ] Add version checking mechanism
- [ ] Document bootstrap rebuild process

### Parser Implementation

- [x] Create `packages/wit-parser/zena/` module structure
- [x] Implement lexer (Token enum, Tokenizer class)
- [x] Implement AST types (in parser.zena)
- [x] Implement core parser (recursive descent)
- [x] Implement annotations (@since, @unstable, @deprecated)
- [x] Fix nested block comment parsing (lexer)
- [x] Implement nested package syntax (parser)
- [x] Fix fixed-size list parsing (`list<T, N>`)
- [x] Fix constructor return types (`constructor() -> result<T>`)
- [x] Fix versioned use paths (`use pkg:name/iface@version.{items}`)
- [x] Fix trailing commas in tuples (`tuple<T,>`)
- [x] Fix complex semver parsing (`1.0.1--`, `1.0.0-a+b`)
- [x] Implement multi-file package support
- [x] Implement resolver (`resolver.zena` for semantic validation)
- [x] Implement JSON serialization (`ast-json.zena` for `.wit.json` output)
- [ ] Polish and resolve Type Index Ordering issues
- [ ] Align Use Statement scopes and World Import/Export Resolution
- [ ] Resolve Multi-file and Nested Package JSON representation discrepancies

### Integration

- [x] Public entry point on the parser (`wit-parser:wit`)
- [x] Test against real WASI WIT files (pinned corpus, gated in `npm test`)
- [ ] Make WIT imports first-class in the compiler (see component-model.md)

### Testing Milestones

- [x] Basic types tests passing
- [x] Records & variants tests passing
- [x] Functions tests passing
- [x] Resources tests passing
- [x] Packages & worlds tests passing (single-file)
- [x] Annotation tests passing (@since, @unstable)
- [x] Nested block comments tests passing
- [x] Nested package syntax tests passing
- [x] Multi-file package tests passing
- [x] All parse-fail tests passing (130/130 passing)
- [x] All success JSON structure tests passing (81/81 passing)
- [x] Full test suite parity with wasm-tools
