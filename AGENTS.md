# Zena Project Instructions

This document guides AI assistants working on the Zena programming language. For
the development plan and feature roadmap, see [PLAN.md](./PLAN.md).

## Project Overview

Zena is a statically typed language targeting WASM-GC. It has features and
syntax inspired by TypeScript, Dart, and Swift.

**Important**: Zena is not released yet. Don't worry about breaking changes—we
can freely improve APIs, syntax, and semantics.

## Design Principles

1.  **Performance**: Generated WASM should be fast. Avoid runtime overhead where
    possible (e.g., try to avoid dynamic dispatch, boxing, etc., where
    possible).
2.  **Binary Size**: The compiler should produce the smallest possible WASM
    binary. This is critical for network delivery.
    - _Trade-off_: When Performance and Binary Size conflict (e.g.,
      Monomorphization vs Erasure), we currently favor **Performance**, but this
      is a tunable design choice.
3.  **Simplicity**: The language should be easy to parse and analyze.
4.  **Safety**: Strong static typing with a sound type system. No implicit type
    coercion.
5.  **Minimal Output**: Standard library components (like `Map`) should only be
    included in the output if they are actually used by the program (Dead Code
    Elimination).

## Zena Syntax Quick Reference

**CRITICAL**: Zena syntax differs from TypeScript in important ways. Pay close
attention!

### Variables (Different from TypeScript!)

```zena
let x = 1;   // IMMUTABLE binding (like TypeScript's `const`)
var y = 1;   // MUTABLE binding (like TypeScript's `let`)
```

- **`let`** = immutable (NOT like TypeScript's `let`!)
- **`var`** = mutable
- There is no `const` keyword in Zena.

### Match/Case Syntax (Different from other languages!)

```zena
// CORRECT - use colon after case
match (value) {
  case 0: "zero"
  case 1: "one"
  case _: "other"
}

// WRONG - do NOT use arrow syntax
match (value) {
  case 0 => "zero" // ❌ WRONG!
}
```

### Functions

```zena
// Arrow syntax only (no function keyword)
let add = (a: i32, b: i32) => a + b;

// With block body
let greet = (name: string) => { return "Hello, " + name; };
```

### For Loops

```zena
// C-style for (note: use var for mutable loop variable)
for (var i = 0; i < 10; i = i + 1) {
  // ...
}

// For-in loops
for (let item in collection) {
  // ...
}
```

### Multiple return values

```zena
/** Returns the first Foo and a count of how many Foos there are */
let getFoo = () => {
  return (theFoo, 3)
};

// Multi-valued returns use unboxed tuples that must be destructured
let (foo, fooCount) = getFoo();
```

Multi-valued returns put return values on the WASM stack, instead of on the
heap, which is a strong hint to the runtime to put the value directly in a
register. This is much better for performance-critical APIs like iterators.

### Full Reference

The official language reference is maintained in `docs/language-reference.md`.
**Instruction**: When adding or modifying language features, you MUST update
`docs/language-reference.md` to reflect the changes. Also update the website
quick reference at `packages/website/src/docs/quick-reference.md`.

## Project Structure & Environment

This project uses two package managers:

- **npm**: For Node.js packages and as a script runner (via Wireit)
- **Nix**: For non-Node dependencies (wasmtime, wasm-tools, etc.)

We use **direnv** with **Nix flakes** for reproducible tooling. When you enter
the project directory, direnv automatically activates the environment with:

- Node.js v25 (required for WASM exnref support)
- wasmtime (for WASI testing)
- wasm-tools (for WASM debugging)
- `WIREIT_LOGGER=simple` (for readable build output)

**You do NOT need to**:

- Prefix commands with `nix develop -c`
- Set `WIREIT_LOGGER=simple` manually
- Run `direnv allow` after the first time

Just run commands directly: `npm test`, `wasmtime run ...`, etc.

### Packages (npm monorepo)

- **packages/compiler**: The core compiler (`@zena-lang/compiler`)
- **packages/stdlib**: The standard library (`@zena-lang/stdlib`)
- **packages/cli**: Command-line interface
- **packages/runtime**: Runtime support for host environments

### Scripts

All scripts run through npm (using Wireit for caching), even for non-Node tasks:

- `npm test`: Run tests across the workspace
- `npm run build`: Build packages

### Running Tests

- Use `npm test` or `npm test -w @zena-lang/compiler` to run all tests.
- **Running Specific Tests**:
  - To run a specific test file, you MUST use the package workspace flag and
    pass the file path after `--`.
  - Example: `npm test -w @zena-lang/compiler -- test/checker/checker_test.js`
  - Do NOT try to pass arguments to the root `npm test` command (e.g.
    `npm test packages/compiler/...`), as they are ignored.
- **NEVER** use `npm test packages/compiler` or
  `npm test --some/path/some_test.ts`.
- Packages are always referred to by **package name** (e.g.,
  `@zena-lang/compiler`), not package path.

### Wireit Caching (IMPORTANT!)

**Interpreting Wireit Output**:

- `✅ [test] Executed successfully` = Tests ran and passed
- `✅ [test] Already fresh` = Tests already passed, nothing changed since last
  run - **this is success, move on**
- `❌ [test] Failed` = Tests failed - Wireit does NOT cache failures

When you see `✅ Already fresh`, the task succeeded. Do not try to force a re-run.
Wireit caches script results and only re-runs scripts when inputs change.

**TRUST THE CACHE**:

- If a test shows as cached/skipped but passed, **it is still passing**. The
  cache is working correctly.
- If a build shows as cached, **the outputs are still valid**. No action needed.
- **NEVER** try to bust the cache by deleting `node_modules`, `.wireit`, or
  build outputs. This is almost never the correct solution.
- If you think caching is wrong, it's almost certainly a Wireit
  **configuration** problem (missing dependency or input file in
  `package.json`), not a cache corruption issue that needs manual
  intervention.

**Do NOT**:

- Run `rm -rf .wireit` or delete cache directories
- Delete `lib/` or other build output directories
- Add `--no-cache` flags or similar
- Run builds multiple times "just to be sure"

**Do**:

- Trust that cached results are correct
- If tests should have run but didn't, check `package.json` wireit config for
  missing inputs or dependencies

### Running Zena Programs with WASI

```bash
# Build with WASI target
zena build main.zena -o main.wasm --target wasi

# Run with wasmtime
wasmtime run -W gc,function-references,exceptions --invoke main main.wasm

# With filesystem access
wasmtime run -W gc,function-references,exceptions --dir . --invoke main main.wasm
```

## Coding Standards

### TypeScript (for compiler code)

- Use strict TypeScript. Write very modern (ES2024) TypeScript.
- **Erasable Syntax**: Do not use non-erasable syntax.
  - No `enum` (use `const` objects with `as const`).
  - No `namespace` (use ES modules).
  - No constructor parameter properties (e.g.
    `constructor(public x: number)`).
  - No `private` keyword (use `#` private fields).
- **Variables**: Prefer `const`, then `let`. Avoid `var`.
- **Functions**: Always use arrow functions, unless a `this` binding is
  strictly required.

### Formatting

- Use single-quotes.
- Use 2 spaces for indents.
- No spaces around object literals and imports (e.g., `import {suite, test}
from 'node:test';`).

### Naming

- File names should be `kebab-case`.
- Test files should end in `_test.ts`. The prefix should be `kebab-case`
  (e.g., `generics-parser_test.ts`, not `generics_parser_test.ts`).

### Documentation

- **Use JSDoc comments** (`/** ... */`) on all public APIs (exported
  functions, classes, methods, interfaces).
- Include `@param`, `@returns`, and `@example` tags where helpful.
- Comment non-obvious internal code with regular comments.
- Update `docs/language-reference.md` when language syntax or semantics
  change.
- Maintain design documents in `docs/design/` for complex features.

### Testing

- Use `suite` and `test` syntax from `node:test`.
- Write tests for each compiler stage (Lexer, Parser, Codegen).
- New syntax features MUST have dedicated parser tests (and lexer tests, if new
  tokens are introduced).
- **New AST nodes**: When adding new AST node types, always add corresponding
  visit methods to `visitor.ts` to ensure DCE and other analyses cover them.
- **Isolating Tests**: To isolate tests, pass the `--test-only` flag to Node
  and use `test.only()` in the test file.
- **Codegen Tests**:
  - Use `compileAndRun(source, entryPoint?)` from `test/codegen/utils.ts` to
    compile and execute Zena code. It returns the result of the entry point
    function.
  - Use `compileAndInstantiate(source)` if you need access to all exports or
    need to test multiple functions from one source.
- **Portable Tests**: When possible, write new tests in `tests/language/` as
  portable tests that can be run by both the TypeScript compiler and a future
  Zena compiler. This helps us work toward self-hosting incrementally.

### Temporary Tests and Debug Scripts

- Create temporary test files in the normal test directories (e.g.,
  `packages/compiler/src/test/`). Files in `/tmp/` will not be able to
  import project modules correctly.
- Keeping temp files in the source tree ensures:
  - Imports like `import {Compiler} from '../compiler.ts'` work correctly
  - Running `npm test` builds any dependencies first (via Wireit)
  - You can use `test.only()` to isolate your temp test
- Use the `--test-only` flag to isolate tests when debugging.
- Use only `npm run`, `npm test`, or `node` to run scripts. Do NOT run
  scripts with `npx`, `tsx`, or `ts-node`.

## Bug Handling Workflow

When you encounter a bug in the compiler or a missing feature during
development:

1.  **Don't immediately try to fix it** if it's tangential to your current task.
    This can lead to long debugging sessions that pollute the context.

2.  **Document the bug** in [BUGS.md](./BUGS.md) with:
    - Short description
    - Date found
    - Severity (low/medium/high/blocking)
    - Workaround if any
    - How to reproduce

3.  **Decide how to proceed**:
    - If severity is **blocking**: Fix it now (no choice).
    - If severity is **high** and the fix is quick (<10 min): Consider fixing.
    - Otherwise: Note it in BUGS.md and continue with the current task.

4.  **For substantial bugs**: Consider starting a **new agent session** to fix
    the bug, then return to the original task with clean context.

**Don't** try to work around compiler bugs with hacky code when we should just
fix the compiler. We control the compiler—fix it properly.

## Long-Term Goals

### Self-Hosting

A major goal is to rewrite the Zena compiler in Zena itself. To work toward this
incrementally:

- Write new tests as **portable tests** when possible (in `tests/language/`).
- These tests use a format that can be run by any Zena compiler implementation.
- When implementing features, consider how they would be expressed in Zena.

## Key Documentation

- **Language Reference**: `docs/language-reference.md`
- **Compiler Architecture**: `docs/design/compiler-architecture.md`
- **Design Documents**: `docs/design/*.md` (see directory for full list)
- **Development Plan**: `PLAN.md`
- **Known Bugs**: `BUGS.md`
