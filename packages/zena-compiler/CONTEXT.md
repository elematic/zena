# AI Agent Context: Zena Self-Hosted Compiler

For the broader architecture, see [self-hosted-compiler.md](../../docs/design/self-hosted-compiler.md).
For the current progress and roadmap of codegen, see the new [IR design doc](../../docs/design/ir.md).

## WebAssembly Code Generation

Code generation separates semantic discovery from lowering and emission
(all paths under `zena/lib/codegen/`):

- **`reachability/`**: `ReachabilityAnalysis` (RTA). Decides what exists —
  reached functions, generic instantiations, vtable membership — and
  populates the `WasmModule` structural model (`wasm-module.zena`).
- **`module-generator.zena`**: `ModuleGenerator`. Drives the module pass —
  per reached function: AST → ZIR → GVN → verify → emit — and iterates
  `WasmModule` fields calling section hooks on `WasmEmitter`.
- **`ir/`**: the ZIR backend — the compiler's only backend; see
  [ir/CONTEXT.md](zena/lib/codegen/ir/CONTEXT.md) for the file map,
  invariants, and verification workflow, and `docs/design/ir.md` for
  the design. `ir.zena` (instruction set + flat encoding),
  `builder.zena`, `cfg.zena`, `lowering.zena` + `lowering-context.zena`
  - per-construct modules (control-flow, patterns, operators, equality,
    templates, intrinsics, scaffold), `gvn.zena`, `verifier.zena`,
    `emit.zena` (SSA destruction, stack scheduling, local coalescing),
    `printer.zena` for WAT-comment dumps.
- **`wasm-emitter.zena`**: `WasmEmitter` interface. The required hooks for
  generating Wasm modules and instructions.
- **`binary-emitter.zena`**: `BinaryEmitter`. Implements `WasmEmitter` to output
  binary `.wasm` format natively.
- **`wat-emitter.zena`**: `WatEmitter`. Implements `WasmEmitter` to output
  string `.wat` format representation.

## WebAssembly Code Generation Constraints

- Zena emits **WebAssembly GC** and **Exceptions** native standards. Wasm
  modules must adhere to strict orderings. For instance, the **Type Section
  (1)** must be serialized _before_ the **Function Section (3)** and **Code
  Section (10)**.
- To resolve this, codegen is multi-pass: `WasmModule.layout()` assigns
  indices for all signatures, `struct` layouts, and recursion (`rec`)
  groups before instruction bytecodes are constructed.
- `ByteBuffer` abstractions generate isolated payloads per section, then combine
  them efficiently into a parent buffer prefixed by `length`.

## Language Quirks & Best Practices

- Standard Zena `enum` fields are nominal and must be explicitly cast to
  integers when outputting literal bytecodes.
  - Example: `Opcode.return_ as i32` or `SectionId.Type as i32`
- Unhandled primitive parsing logic should be explicitly thrown to prevent
  silent, hard-to-track runtime fallbacks instead of safely bubbling zeroes:
  - Example: `if (!ok) { throw new Error("Parse check failed"); }`
- Prefer strongly typed Zena structures (`class FunctionSignature`) rather than
  raw byte buffers internally while traversing semantic nodes.
- **Structural Records vs Classes:** Prefer structural types/records (e.g.,
  `type CompilationUnit = {ast: Module, model: SemanticModel}`) over classes
  when identity or methods are unneeded. This reduces boilerplate and aligns
  better with data-oriented tree processing.
- **Topological Sorting & `CompilationUnit`:** Rely on the `Program.units` array
  being topologically sorted during compilation. This separation of concerns
  allows Codegen to incrementally assign deterministic WASM indices across
  multiple modules without walking the dependency graph itself.
- **Symbol Disambiguation in Wasm:** When resolving call targets during codegen,
  explicitly throw on `null` (unresolved/compilation skip), map local module
  calls via `functionMap` (lookup by symbol ID), and map cross-module calls via
  `exportMap` (lookup by the `ImportSpecifier`'s String name).

## Build System (Wireit)

- Test runners and execution pipelines rely on `npm` scripts wrapped around
  **wireit**.
- Treat wireit caches as truth. If an output binary (like `cli.wasm` or
  test-specific `.wasm` payloads) is repeatedly "missing" or "deleted", check
  the `.json` `output` glob intersections immediately—make sure `build:tests` is
  safely excluding `cli.wasm`.

## Portable Tests

**Portable tests** are compiler-agnostic language tests under
`tests/language/`, split into `syntax/`, `semantics/` and `execution/`.
Each category has a runner written in Zena, in `zena/test/`:

| Runner                    | Checks                                                   |
| ------------------------- | -------------------------------------------------------- |
| `portable_syntax.zena`    | parse → AST vs. the `.ast.json` snapshot beside the test |
| `portable_semantics.zena` | check → diagnostics vs. `@error:` / `@warning:`          |
| `portable_execution.zena` | compile + run → vs. `@result:` / `@stdout:`              |

They share `zena/test/portable-harness.zena` (directory discovery,
`// @name: value` directive parsing, skip accounting). The execution
runner additionally uses `zena:process` to run each language test in its
own `zena-cli run` worker, with a bounded pool and a 120s per-test
deadline (`waitFor`); `run-wasmtime.js` grants it `--allow-spawn` and
sets the pool size (`ZENA_TEST_PARALLELISM`, else `min(cpus, 8)`).

**The execution runner compiles in batches and runs in isolation.** It
embeds the compiler (it imports `../lib/...` directly), so it compiles
every test itself before running any, many entry points through **one**
`Compiler` with the incremental `ProgramCheckResult` threaded — the
stdlib is then parsed and checked once per batch rather than once per
test, which is where nearly all the cost was (a five-line test cost
0.385s to compile against 0.027s for a cache hit). Only _running_ is
isolated, one `zena-cli run` process per test, because that is where
traps and hangs live.

The batch is sliced across as many worker processes as the pool has
workers, because **sharing a compiler is not monotonically cheaper**:
the whole suite through a single compiler takes 49s, while eight slices
of it take 4.3s of wall time and only half the CPU (31s against 65s). A
compiler accumulates per-entry-point state, so the amortised stdlib is a
win and the accumulation is a loss, and slices in the tens of tests sit
near the bottom of that curve. Whole suite: 33.6s → 21.2s with nothing
cached, 3.5s → 7.7s on a repeat run — the repeat costs more because it
genuinely recompiles all 465 rather than serving `zena-cli`'s cache.

Batching needed one compiler fix first, and it was not a codegen bug:
generic instantiations are interned on the generic source, and the key
was the type argument's *name*, so two entry points that each declared a
`class Item` shared `zena:iterator`'s `Iterable<Item>` and the second
emitted an interface trampoline that downcast to the first's struct.
`instantiationKeyOf` in `lib/types.zena` now keys nominal types by
identity; `zena/test/type-instantiation_test.zena` guards it.

**Discovery has no allow-list.** A test runs because the file exists.
The only way to hold one back is an explicit directive in the file:

```zena
// @skip: <why this cannot run yet>
```

Every runner prints `N tests, M skipped, K support modules` and lists
each skip with its reason, so a test that stops being collected shows up
as a number that moved. (A _support module_ is an execution-test file
with no `@result:`/`@stdout:` — a module some sibling test imports.)

Run one category, optionally filtered by path substring:

```bash
npm run test:execution -w @zena-lang/zena-compiler -- variables
```
