# Test Runner Architecture

## Status

- **Status**: Design Discussion
- **Date**: 2026-01-03

## Problem Statement

Zena needs a test runner for `zena:test`. As a compiled language, this raises
several architectural questions:

1. **Orchestration**: Where does the runner live? (Node.js vs native Zena)
2. **Compilation**: How do we handle on-the-fly compilation? Caching?
   Dependencies?
3. **Bundling**: One program per test file, or combine tests into a single
   binary?
4. **Incremental builds**: How do we avoid recompiling unchanged code?

## Current State

Today, Zena tests are written in TypeScript and use `compileAndRun()` to compile
inline Zena code snippets. This works but doesn't scale to:

- Testing the stdlib itself (in Zena)
- Self-hosted compiler tests
- User application tests

## Design Options

### Option A: Node.js Orchestrated Runner

The test runner is a Node.js CLI that:

1. Discovers `.zena` test files (glob patterns, config file)
2. Compiles each test file to WASM
3. Instantiates and runs each WASM module
4. Collects results and reports

```
┌─────────────────────────────────────────────────────────┐
│                    Node.js Runner                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Discovery│→ │ Compile  │→ │ Execute  │→ Report     │
│  │ (glob)   │  │ (WASM)   │  │(instantiate)           │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

**Pros**:

- Can start immediately (no filesystem support needed)
- Node handles file discovery, process management, output formatting
- Easy to integrate with existing Node test infrastructure
- Can use watch mode via `chokidar` or similar

**Cons**:

- Tests run in Node, not a "pure" Zena environment
- Every test file is a separate WASM module (overhead)
- Node dependency for all test workflows

### Option B: Native Zena Runner (WASI)

Build `zena:fs` on WASI filesystem APIs, then implement the runner in Zena:

```zena
// zena-test-runner.zena
import { readDir, readFile } from 'zena:fs';
import { run } from 'zena:test';

let testFiles = readDir('.').filter(f => f.endsWith('_test.zena'));
// ... somehow compile and run each file?
```

**Problem**: The runner would need to compile Zena code _from within_ a running
WASM module. This is circular—we'd need the compiler itself to be a WASM module.

**Pros**:

- Pure Zena solution
- Could run in any WASI runtime (wasmtime, wasmer, Node via jco)
- Dogfoods the language

**Cons**:

- Requires self-hosted compiler first (or compiling TS compiler to WASM)
- Significant WASI work needed (`zena:fs`, process spawning?)
- Much larger scope

### Option C: Hybrid with Pre-compiled Test Bundles

Use Node for orchestration, but compile all tests into a single WASM bundle:

1. **Build step**: Compile all test files + stdlib into one WASM module
2. **Run step**: Node instantiates the bundle and calls `runAllTests()`

```zena
// Generated test-bundle.zena (or bundled by compiler)
import { suite as arrayTests } from './array_test.zena';
import { suite as mapTests } from './map_test.zena';
import { runAll } from 'zena:test';

export let main = () => runAll([arrayTests, mapTests]);
```

**Pros**:

- Single WASM instantiation (faster)
- Shared stdlib between tests
- Still orchestrated by Node

**Cons**:

- All-or-nothing: can't run single test file easily
- Larger bundle sizes
- Build step adds complexity

### Option D: Compilation Caching with Separate Modules

Like Option A, but with intelligent caching:

1. Each `.zena` file compiles to a `.wasm` file
2. Cache based on content hash + dependency hashes
3. Only recompile when source or dependencies change

```
tests/
  array_test.zena     → .zena-cache/array_test.abc123.wasm
  map_test.zena       → .zena-cache/map_test.def456.wasm
```

**Pros**:

- Incremental: only recompile what changed
- Can run single files or all
- Simple mental model

**Cons**:

- Each test file includes full stdlib (duplication)
- Cache invalidation complexity (transitive dependencies)
- Still many WASM instantiations for large test suites

---

## Deep Dive: The Compilation Problem

The core challenge is that Zena is a **statically linked** language. Every WASM
module contains:

1. The test code itself
2. All imported modules (transitively)
3. The stdlib (`zena:array`, `zena:string`, etc.)

For a test file `array_test.zena` that imports `zena:assert` and `zena:test`:

```
array_test.wasm contains:
  - array_test.zena code
  - zena:assert code
  - zena:test code
  - zena:array code (used by test)
  - zena:string code (used by everything)
  - zena:error code (used by assertions)
  - ... etc
```

**Current stdlib size**: ~30 KB WASM (rough estimate). With 100 test files,
that's 3 MB of duplicated stdlib code being compiled and loaded.

### Potential Solutions

#### 1. Dynamic Linking (Future)

WASM doesn't natively support dynamic linking, but Component Model does. We
could:

- Compile stdlib as a separate Component
- Link test Components to stdlib Component
- Share one stdlib instance across all tests

**Timeline**: Requires Component Model support in Zena. Significant work.

#### 2. Compile Once, Run Many (Single Process)

Compile all tests into one bundle (Option C). Avoids duplication but loses
granularity.

#### 3. "Fat" Cached Modules

Pre-compile stdlib to WASM and link it:

```
stdlib.wasm (compiled once)
test.wasm   (links to stdlib.wasm via imports)
```

This is essentially building our own dynamic linking. Complex but doable.

#### 4. Accept the Duplication (For Now)

For small test suites (< 100 files), compilation is fast enough (~50ms/file).
The duplicate stdlib in each module is inefficient but not catastrophic.

**Recommendation**: Start here, optimize later.

---

## Recommended Approach: Phased Implementation

### Phase 1: Simple Node Runner (Immediate)

Build a minimal test runner in Node that:

1. Accepts glob patterns for test files
2. Compiles each file on the fly
3. Runs tests and reports results
4. No caching (keep it simple)

```bash
npx zena-test 'tests/**/*_test.zena'
```

Implementation in `packages/cli`:

```typescript
// packages/cli/src/lib/test.ts
import {Compiler, CodeGenerator} from '@zena-lang/compiler';
import {instantiate} from '@zena-lang/runtime';
import {glob} from 'glob';

export async function runTests(patterns: string[]): Promise<TestResults> {
  const files = await glob(patterns);
  const results: TestResult[] = [];

  for (const file of files) {
    const host = new NodeCompilerHost();
    const compiler = new Compiler(host);
    const program = compiler.bundle(file);
    const generator = new CodeGenerator(program);
    const wasm = generator.generate();

    const {exports} = await WebAssembly.instantiate(wasm, imports);
    const testResult = exports.tests.run();
    results.push({file, ...testResult});
  }

  return summarize(results);
}
```

### Phase 2: Caching Layer

Add content-based caching:

```typescript
// .zena-cache/
//   manifest.json        - maps source hashes to compiled artifacts
//   abc123.wasm          - cached compiled modules

interface CacheManifest {
  [sourcePath: string]: {
    sourceHash: string;
    dependencyHashes: Record<string, string>;
    wasmPath: string;
  };
}
```

Cache invalidation:

- Invalidate if source file hash changes
- Invalidate if any dependency hash changes
- Transitive: if `zena:array` changes, all tests using arrays invalidate

### Phase 3: Watch Mode

Use `chokidar` to watch for file changes:

```bash
npx zena-test --watch 'tests/**/*_test.zena'
```

Re-run affected tests when files change.

### Phase 4: Bundled Test Mode (Optional)

For CI or when running full suite:

```bash
npx zena-test --bundle 'tests/**/*_test.zena'
```

Compiles all tests into a single WASM module for faster execution.

---

## Open Questions

### 1. Test File Convention

What convention for test files?

- `*_test.zena` (Go style)
- `*.test.zena` (Jest style)
- `test_*.zena` (Python style)

**Proposal**: `*_test.zena` (matches existing TS convention in project)

### 2. Test Discovery vs Explicit Export

How does the runner find tests in a file?

**Option A**: Magic export name

```zena
export let tests = suite('Array', () => { ... });
```

**Option B**: Side-effect registration (requires top-level execution)

```zena
suite('Array', () => { ... });  // auto-registers
```

**Current**: Option A (explicit export) since top-level statements don't
execute.

### 3. Parallel Execution

Should tests run in parallel?

- **File-level**: Run multiple test files concurrently (easy with Node workers)
- **Test-level**: Run individual tests concurrently (requires async in Zena)

**Proposal**: File-level parallelism in Phase 2, test-level later.

### 4. Stdlib Changes During Development

When developing stdlib, tests need the _local_ stdlib, not a cached/installed
version. The runner needs to:

- Detect when running in monorepo context
- Use local stdlib path
- Invalidate cache when stdlib changes

---

## Comparison with Other Languages

| Language   | Test Runner  | Compilation Strategy           |
| ---------- | ------------ | ------------------------------ |
| Rust       | `cargo test` | Compiles test binary per crate |
| Go         | `go test`    | Compiles test binary per pkg   |
| TypeScript | Jest/Vitest  | JIT via Node/V8                |
| Zig        | `zig test`   | Compiles test binary           |
| OCaml      | dune         | Compiles test executable       |

Most compiled languages compile tests into a binary. The key difference is they
have fast compilers and good caching. For Zena, we need to ensure:

1. Compilation is fast (< 100ms for incremental)
2. Caching is effective (avoid recompiling stdlib)
3. Developer experience is good (watch mode, clear errors)

---

## Implementation Timeline

| Phase | Description          | Effort   | Dependencies         |
| ----- | -------------------- | -------- | -------------------- |
| 1     | Simple Node runner   | 1-2 days | `zena:test` module   |
| 2     | Caching              | 2-3 days | Phase 1              |
| 3     | Watch mode           | 1 day    | Phase 2              |
| 4     | Bundled mode         | 2-3 days | Phase 2              |
| 5     | Native runner (WASI) | Weeks    | Self-hosted compiler |

---

## Appendix: WASI Filesystem for Future

When we eventually want a native runner, we'll need `zena:fs`:

```zena
// zena:fs (future)
export interface FileInfo {
  name: string;
  isDirectory: boolean;
  size: i64;
}

export let readFile: (path: string) => string;
export let writeFile: (path: string, content: string) => void;
export let readDir: (path: string) => Array<FileInfo>;
export let exists: (path: string) => boolean;
```

This maps to WASI Preview 2's `wasi:filesystem/types` interface. The main work
is implementing the Component Model canonical ABI for strings and arrays.

See [wasi.md](wasi.md) for details on WASI integration.
