# WIT Parser in Zena

## Status

- **Status**: In Progress (Phase 4)
- **Last Updated**: 2026-02-12

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

Test infrastructure is in place with 194 tests ported from wasm-tools.

### 1.1 Test Format

Tests will be ported from wasm-tools' `tests/ui/` directory. Each test consists
of:

- **Input**: A `.wit` file (or directory of `.wit` files)
- **Expected Output**: A `.wit.json` file with the parsed/resolved AST
- **Error Cases**: Tests in `parse-fail/` that should produce errors

We'll organize these under `packages/stdlib/tests/wit-parser/`:

```
packages/stdlib/tests/wit-parser/
├── ui/                          # Ported from wasm-tools
│   ├── types.wit                # Input WIT file
│   ├── types.wit.json           # Expected parsed output
│   ├── async.wit
│   ├── async.wit.json
│   ├── parse-fail/              # Error cases
│   │   ├── bad-syntax.wit
│   │   └── bad-syntax.wit.stderr
│   └── ...
├── wit-parser_test.zena         # Test runner in Zena
└── test-suite.json              # Suite metadata
```

### 1.2 Test Categories

We'll port tests in phases, starting with simpler cases:

| Category           | Description                            | Test Count (approx) |
| ------------------ | -------------------------------------- | ------------------- |
| Basic Types        | Primitives, lists, options, results    | ~10                 |
| Records & Variants | Composite types, enums, flags          | ~10                 |
| Functions          | Parameters, results, async             | ~10                 |
| Resources          | Handles, methods, constructors         | ~15                 |
| Packages & Worlds  | Package syntax, imports, exports       | ~15                 |
| Advanced           | Nested packages, versioning, stability | ~15                 |

### 1.3 Test Runner Architecture

Since `zena:fs` only works in wasmtime (WASI), we need a runner that can:

1. Read `.wit` input files from the filesystem
2. Read `.wit.json` expected output files
3. Run the parser and compare results
4. Report pass/fail using `zena:test`

**Architecture**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Test Execution Flow                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. TypeScript Runner (packages/cli)                                │
│     ├── Discovers test files (Node.js glob)                         │
│     ├── Compiles wit-parser_test.zena to WASM                       │
│     └── Invokes wasmtime with --dir flags                           │
│                                                                     │
│  2. Wasmtime Runtime                                                │
│     ├── Loads WASM module                                           │
│     ├── Provides WASI filesystem access                             │
│     └── Runs main() entry point                                     │
│                                                                     │
│  3. Zena Test Module (wit-parser_test.zena)                         │
│     ├── Uses zena:fs to read .wit files                             │
│     ├── Calls WIT parser (in Zena)                                  │
│     ├── Compares output to .wit.json                                │
│     └── Reports via zena:test                                       │
│                                                                     │
│  4. Result Collection                                               │
│     ├── wasmtime exit code indicates pass/fail                      │
│     └── TypeScript runner collects and reports                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.4 Wasmtime Test Runner CLI Command

We need to extend the CLI to support running tests via wasmtime. This builds on
the existing test infrastructure but uses wasmtime instead of Node's WASM
runtime.

```bash
# Run WIT parser tests via wasmtime
zena test --runtime wasmtime --dir ./tests/wit-parser packages/stdlib/tests/wit-parser

# The --dir flag maps to wasmtime's --dir for WASI preopens
```

**Implementation in `packages/cli/src/lib/test.ts`**:

1. Detect `@requires: wasmtime` directive in test files
2. Compile to WASM as usual
3. Instead of `WebAssembly.instantiate`, spawn `wasmtime run`
4. Pass `--dir` flags for filesystem access
5. Collect exit code and stdout for results

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

## Phase 3: Bootstrapping Strategy [NOT STARTED]

The Zena compiler needs the WIT parser to process WIT files, but the WIT parser
is written in Zena and needs the compiler to be built. This is a classic
bootstrap problem.

### 3.1 Bootstrap Approaches

**Option A: Lazy Loading**

The compiler loads the WIT parser WASM only when needed:

```typescript
// packages/compiler/src/wit.ts
let witParser: WitParser | null = null;

async function getWitParser(): Promise<WitParser> {
  if (!witParser) {
    // Load pre-compiled WASM from package
    const wasm = await import('./wit-parser.wasm');
    witParser = new WitParser(wasm);
  }
  return witParser;
}

export async function parseWit(source: string): Promise<WitResolve> {
  const parser = await getWitParser();
  return parser.parse(source);
}
```

**Option B: Build-Time Pre-compilation**

The WIT parser WASM is pre-compiled and checked into the repo (or built by CI):

```
packages/compiler/
├── src/
│   └── wit-parser.wasm     # Pre-compiled, checked in
└── scripts/
    └── build-wit-parser.ts # Rebuilds the WASM
```

**Option C: Staged Build**

npm build script compiles the parser first, then the rest of the compiler:

```json
{
  "scripts": {
    "build": "npm run build:wit-parser && npm run build:compiler",
    "build:wit-parser": "zena build stdlib/zena/wit-parser.zena -o src/wit-parser.wasm"
  }
}
```

**Recommendation**: Use **Option B** initially—pre-compile and check in the
WASM. This avoids complexity during early development. Once stable, switch to
Option C for CI builds.

### 3.2 Version Consistency

The pre-compiled WIT parser WASM must be compatible with the current compiler.
We'll add a version check:

```typescript
// At load time
const parserVersion = exports.$version?.() ?? 0;
const compilerVersion = COMPILER_WIT_PARSER_VERSION;
if (parserVersion !== compilerVersion) {
  throw new Error(
    `WIT parser version mismatch: expected ${compilerVersion}, got ${parserVersion}`,
  );
}
```

---

## Phase 4: Parser Implementation [NOT STARTED]

Once tests are in place, implement the parser itself.

### 4.1 Module Structure

```
packages/stdlib/zena/
├── wit/
│   ├── lexer.zena       # Token types, Tokenizer class
│   ├── ast.zena         # AST node types
│   ├── parser.zena      # Recursive descent parser
│   ├── resolver.zena    # Name resolution, type building
│   └── json.zena        # JSON serialization for output
└── wit-parser.zena      # Public API, re-exports
```

### 4.2 Implementation Order

1. **Lexer** (~500 lines)
   - Token enum with all WIT tokens
   - Span tracking for error messages
   - Unicode identifier support

2. **AST Types** (~300 lines)
   - Node types for all WIT constructs
   - Docs, attributes, stability annotations

3. **Parser** (~800 lines)
   - Recursive descent, LL(1) with some lookahead
   - Error recovery for better diagnostics

4. **Resolver** (~1000 lines)
   - Package/interface/world resolution
   - Type interning
   - Foreign dependency handling

5. **JSON Output** (~200 lines)
   - Serialize resolved AST to match `.wit.json` format

### 4.3 Zena Features Exercised

This project will stress-test:

- **String handling**: Parsing, slicing, spans
- **Enums/variants**: Token types, AST nodes
- **Classes**: Tokenizer, Parser, Resolver
- **Pattern matching**: Token dispatch
- **Error handling**: Parse errors with locations
- **Generics**: Collections (if we use Arena patterns)

---

## Phase 5: Integration [NOT STARTED]

### 5.1 Compiler Integration

```typescript
// packages/compiler/src/wit-integration.ts
import {parseWit, WitResolve, WitInterface} from './wit-parser';

export async function loadWitBindings(witPath: string): Promise<ZenaModule> {
  const source = await fs.readFile(witPath, 'utf-8');
  const resolved = await parseWit(source);
  return generateZenaBindings(resolved);
}

function generateZenaBindings(wit: WitResolve): ZenaModule {
  // Generate Zena types from WIT types
  // Generate import stubs for WIT imports
  // Generate export wrappers for WIT exports
}
```

### 5.2 Zena Syntax for WIT

Long-term, we want inline WIT support:

```zena
// Option A: Import WIT files directly
import {Greeter} from './greeter.wit';

// Option B: Inline WIT blocks
@wit """
  interface greeter {
    greet: func(name: string) -> string;
  }
"""
class MyGreeter implements Greeter {
  greet(name: string) => "Hello, " + name;
}
```

This is out of scope for the initial implementation.

---

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

**Results**: TypeScript test runner in `packages/wit-parser/src/run-tests.ts`
discovers tests recursively, validates file pairs, and reports results. Format
kept as-is: single-file tests use sibling `.wit.json`/`.wit.result`, multi-file
tests use directories.

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

- [ ] Create `packages/stdlib/zena/wit/` module structure
- [ ] Implement lexer (Token enum, Tokenizer class)
- [ ] Implement AST types
- [ ] Implement parser (recursive descent)
- [ ] Implement resolver
- [ ] Implement JSON serialization

### Integration

- [ ] Add `parseWit` function to compiler
- [ ] Generate Zena bindings from WIT
- [ ] Test with real WASI WIT files

### Testing Milestones

- [ ] Basic types tests passing
- [ ] Records & variants tests passing
- [ ] Functions tests passing
- [ ] Resources tests passing
- [ ] Packages & worlds tests passing
- [ ] All parse-fail tests passing
- [ ] Full test suite parity with wasm-tools
