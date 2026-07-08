# AI Agent Context: Zena Self-Hosted Compiler

For the broader architecture, see [self-hosted-compiler.md](../../docs/design/self-hosted-compiler.md).
For the current progress and roadmap of codegen, see [CODEGEN_PLAN.md](CODEGEN_PLAN.md).

## WebAssembly Code Generation

Code generation separates logical AST traversal from target text/binary
emission:

- **`discovery.zena`**: `Discovery` pass. Resolves and stores
  target Wasm indices for AST elements.
- **`module-generator.zena`**: `ModuleGenerator`. Iterates over `WasmModule`
  fields and calls section hooks on `WasmEmitter`.
- **`function-generator.zena`**: `FunctionGenerator`. Walks function ASTs and
  translates statements/expressions into `WasmEmitter` calls.
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
- To resolve this, `wasm-generator.zena` typically utilizes a multi-pass
  approach over the AST, allocating indices for all `FunctionSignature`s,
  `struct` layouts, and Recursion (`rec`) groups prior to constructing the
  actual instruction bytecodes.
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

## Portable Tests & Selective Execution

- **Portable tests** are shared language tests located in `tests/language/`.
  Both the bootstrap compiler and the self-hosted compiler run against these
  same test files to ensure identical behavior.
- **Selective Execution (`runList`)**: Because the self-hosted compiler's
  WebAssembly code generator is still being incrementally implemented, it cannot
  yet compile the entire portable test suite. In
  `src/scripts/run-execution-tests.ts`, there is an explicit `runList` array
  (e.g., `['return_42.zena', ...]`) and only tests in the list are run. If you
  add a new end-to-end Wasmtime test and want the self-hosted compiler to run
  it, you _must_ add it to the `runList` array!
- Run execution tests locally via: `npm run test:execution  -w @zena-lang/zena-compiler -- [filter]` explicitly to isolate generated Wasm regressions
  natively using the `wasmtime --invoke main` interface wrapped by Node.js.
  For example, to run just the variable tests, use `npm run test:execution -w @zena-lang/zena-compiler -- variables`.
