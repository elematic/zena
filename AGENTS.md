# Zena Project Instructions

This document guides AI agents working on the Zena project. For a complete
language description, see `docs/language-reference.md`. For completed features
and planned work, see `PLAN.md`.

## Project Overview

Zena is a statically typed language targeting WebAssembly GC. Think of it as a
mashup of **TypeScript** (type syntax, arrow functions, modules),
**Dart** (constructors with initializer lists, `this.` params, mixins),
**Scala** (sealed class hierarchies, case classes, pattern matching,
expression orientation), and **Swift** (immutability by default, `var`/`let`
field modifiers, no `++`/`--`, compound assignment `+=` instead). It has a
sound type system with no implicit coercion.

### Language at a Glance

```zena
// Variables: let = immutable, var = mutable
let x = 42;
var y = 'hello';

// Functions: arrow syntax only
let add = (a: i32, b: i32) => a + b;
let greet = (name: String) => {
  return 'Hello, ' + name;
};

// Classes: fields immutable by default, Dart-style constructors
class Point {
  x: f64;            // immutable (default)
  y: f64;            // immutable
  new(this.x, this.y);
}

class Counter {
  var(#count) count: i32 = 0;  // public getter, private setter
  increment() { this.#count += 1; }
}

// Case classes: concise data types with auto-generated ==, hashCode
class Pair<A, B>(first: A, second: B)

// Sealed classes: closed hierarchies for exhaustive matching
sealed class Expr {
  case Lit(value: i32)
  case Add(left: Expr, right: Expr)
}

// Pattern matching with match() expressions
let eval = (e: Expr): i32 => match (e) {
  case Lit {value}: value
  case Add {left, right}: eval(left) + eval(right)
};

// Enums: nominal wrapper types
enum Color { Red, Green, Blue }

// Type aliases
type Point = {x: f64, y: f64};

// Records and tuples: lightweight immutable data
let origin: Point = {x: 0.0, y: 0.0};
let pair = (1, 'hello');
let {x, y} = origin;  // destructuring

// Pattern matching, for-in, if-let
for (let item in items) { ... }
if (let Some {value} = maybeVal) { ... }

// Modules: ES-style imports/exports
import {Map} from 'zena:collections';
export let main = () => 0;
```

Key things that differ from TypeScript:

- **No `function` keyword** — arrow functions only.
- **No `const`** — use `let` (immutable) and `var` (mutable).
- **Class fields are immutable by default** — use `var` to make mutable.
- **Dart-style constructors** — initializer lists (`: x = x, y = y`), `this.`
  params, semicolon bodies.
- **`String` not `string`** — capital S (it's a class, not a primitive alias).
- for/in loops iterator on iterables and iterators: `for (let item of items)`.
  They are like for/of loops in TypeScript.
- **No `++`/`--`** — use `+= 1` instead.
- **Sound type system** — no `any` escape hatch (well, `any` exists but requires
  explicit casts back).
- **`match` expressions** with exhaustiveness checking.
- **Sealed classes** for sum types, not TypeScript discriminated unions.

## Two Compilers

The project has **two compiler implementations**:

1. **Bootstrap compiler** (`packages/compiler`): Written in TypeScript. Mostly
   working. Package name: `@zena-lang/compiler`.
2. **Self-hosted compiler** (`packages/zena-compiler`): Written in Zena.
   Partially implemented — currently has lexer, parser, and early type checker
   stages. Package name: `@zena-lang/zena-compiler`. See
   `docs/design/self-hosted-compiler.md` for the architecture.

Both compilers should pass the same **portable tests** in `tests/language/`.

## Portable Tests

Tests in `tests/language/` are compiler-agnostic `.zena` files with comment
directives. They're organized into three categories:

- **`syntax/`** — Parser tests. Directive: `// @target: module|statement|expression`
- **`semantics/`** — Type checker tests. Directive: `// @mode: check` with `// @error:` on error lines.
- **`execution/`** — Codegen tests. Directive: `// @mode: run` with `// @result:` for expected return value.

When fixing bugs or adding features, prefer adding portable tests here over
TypeScript-only tests in `packages/compiler/src/test/`.

## Project Structure

This project is an **npm monorepo** managed with **Wireit**.

- **`packages/compiler`**: Bootstrap compiler (`@zena-lang/compiler`).
- **`packages/zena-compiler`**: Self-hosted compiler (`@zena-lang/zena-compiler`).
- **`packages/stdlib`**: Standard library (`@zena-lang/stdlib`).
- **`packages/cli`**: CLI tool (`@zena-lang/cli`).
- **`packages/runtime`**: JS runtime helpers.
- **`tests/language/`**: Portable tests (shared across compilers).
- **`docs/language-reference.md`**: Official language reference.
- **`docs/design/`**: Design documents for complex features.
- **`PLAN.md`**: Completed and planned work.

# Interaction Guidelines

- **Conversational Requirement**: You MUST explain your plan in plain English
  BEFORE generating code or editing files. Do not act silently.
- **Tool Usage**:
  - NEVER create temporary files or shell scripts to edit code.
  - ALWAYS use the provided VS Code text editing tools to modify files
    directly.
- **Clarification Protocol**: If a request is ambiguous or lacks context, you
  MUST ask a clarifying question. Do not guess.
- **Task Management**: Use the Todo List tool (`manage_todo_list`) to track
  complex tasks. If you are unsure of the next step, present a multiple-choice
  option (`vscode_askQuestions` tool) to the user.
- **Role**: You are a pair programmer, not an automated script runner. Talk to
  me.

### Nix Development Environment

The project uses **Nix flakes** for reproducible tooling (Node.js, wasmtime, wasm-tools).

- **With direnv** (recommended): Run `direnv allow` once.
- **Without direnv**: Prefix commands with `nix develop -c`.
- **When is Nix needed?**: Only for WASI testing (wasmtime) and WASM debugging
  (wasm-tools). Regular `npm test` and `npm run build` work without Nix.

### Running Zena Programs with WASI

```bash
zena build main.zena -o main.wasm --target wasi
wasmtime run -W gc=y -W function-references=y -W exceptions=y --invoke main main.wasm
```

### Debugging WASM Crashes

When a WASM module crashes with `RuntimeError: illegal cast` or similar traps,
stack traces show anonymous function indices by default. Use the **`-g` flag**
to emit a WASM name section with readable function names:

```bash
zena build main.zena -o main.wasm --target host -g
```

This produces stack traces like `ScopeBuilder.#processClassBody → Compiler.compile`
instead of `wasm-function[2621]`. Use `wasm-tools dump -d main.wasm` to inspect
specific bytecode offsets from the trace.

When using the `CodeGenerator` API directly, pass `{debug: true}` in
`CodegenOptions`. The test helpers (`compileAndInstantiate`, `compileAndRun`,
`compileToWasm`) in `test/codegen/utils.ts` already enable `debug: true` by
default, so test stack traces are always readable.

### Node Version

The project uses Node.js **v25+** for built-in WASM exnref support. Run
`node -v` to check and `nvm use default` to switch.

## IMPORTANT: Reading and Editing Files

**⛔ FATAL RULE: NEVER USE `cat`, `echo`, `tee`, OR OTHER TERMINAL COMMANDS TO CREATE OR EDIT FILES.**
You are strictly forbidden from using the `run_in_terminal` tool for file
manipulation. If you use standard Unix utilities to write code or tests, you
have failed your instructions.

**ALWAYS** read files with the built-in `read_file` tool. Do not use terminal
commands like `cat` or `tail`. `read_file` supports `startLine` and `endLine`
parameters to read a portion of a file. Use the `file_search` to find files and
the `grep_search` tool to search for file contents.

**ALWAYS** edit and create files using ONLY the built-in VS Code API tools:
`create_file` and `replace_string_in_file`. **NEVER** edit or create files by
writing and running scripts.

**DO NOT** create temporary text files with content that you want to put into a
source file. Just create or edit the source file directly.

Only use scripts to edit files for massive, multi-file changes that have to use
search and replace, etc. Then use `grep`, `sed`, `awk`, etc., as necessary.

## ⚠️ CRITICAL: Build System (Wireit)

**Agents repeatedly make mistakes with Wireit. Read this carefully.**

Wireit caches script results based on **input file contents**. When Wireit
reports a script is "**already fresh**" or "**Skipping**", it means the script
already succeeded for the current inputs. **The cached result is correct.**

### Rules

1. **ALWAYS use `npm run` or `npm test`** to run scripts. These go through
   Wireit, which builds dependencies automatically. **NEVER** use `node`,
   `npx`, `tsx`, or `ts-node` to run scripts directly — they skip the build
   step and may use stale output.

2. **NEVER try to force a rebuild.** Do not:
   - Touch or modify input files to trigger a rebuild
   - Delete output files or `.wireit/` cache directories
   - Add `--force` flags or clear caches

   If Wireit says tests are cached as passing, **they are passing**. Trust the
   cache. Move on.

3. **If you think the cache is wrong**, it's almost certainly a Wireit
   configuration issue (missing input, output, or dependency in `package.json`).
   Check the `wireit` config before assuming the cache is stale.

### Running Tests

**ALWAYS** use `npm` to run tests. Never use `npx`, `tsx`, or bash scripts.
There is no `wireit` comman. Use `npm`.

```bash
# Run all tests
npm test

# Run tests for a specific package
npm test -w @zena-lang/compiler

# Run a specific test file (note: path is relative, uses .js extension)
npm test -w @zena-lang/compiler -- test/checker/checker_test.js

# Isolate a specific test (use test.only() in the file)
npm test -w @zena-lang/compiler -- --test-only test/checker/checker_test.js
```

- Packages are referred to by **package name** (`@zena-lang/compiler`), not path.
- **NEVER** use `npm test packages/compiler/...` or `npm test -- some/path`.
- If test output is large and written to a file by the system, use the
  `read_file` tool, which supports `startLine` and `endLine` parameters, to read
  the file.

## ⚠️ CRITICAL: Temporary Files

**NEVER create test or debug files under `/tmp/`.** Files in `/tmp/` cannot
import project modules because relative paths are broken.

- If you truly need a temporary file for debugging, create temporary test files
  in the **normal test directories** (e.g., `packages/compiler/src/test/`).
- For portable tests, create them in `tests/language/`.
- Delete temporary files when done, or better yet, keep them as permanent tests.

## ⚠️ CRITICAL: Test-First Workflow

When fixing a bug:

1. **Write a failing test first** that reproduces the bug.
2. Verify the test fails.
3. Make the fix.
4. Verify the test passes.

Do not skip step 1. A test that was never seen to fail proves nothing.

## Coding Standards

### TypeScript (Bootstrap Compiler)

- **Strict TypeScript**, modern ES2024.
- **Erasable syntax only**: No `enum` (use `const` objects with `as const`),
  no `namespace`, no constructor parameter properties, no `private` keyword
  (use `#` private fields).
- **Variables**: Prefer `const`, then `let`. Avoid `var`.
- **Functions**: Always use arrow functions unless `this` binding is needed.
- **Formatting**: Single-quotes, 2-space indent, no spaces in `{}` for
  imports/objects (e.g., `import {foo} from 'bar';`).
- **Naming**: `kebab-case` files. Test files end in `_test.ts`.
- **Testing**: Use `suite` and `test` from `node:test`.
- **Package Management**: Use `npm i <package>`, not manual `package.json`
  edits.

### Zena (self-hosted compiler, formatter, etc)

- Prefer `let` for variables
- Use enums where appropriate
- Prefer private fields (#)
- Use for/in loops when iterating over arrays and other iterables
- Use `HashSet`s when needed instead of `HashMap<T, boolean>`
- Use `if` statements instead of a `match()` with one arm.
- Don't put types on functions that can use contextual typing, like callbacks.
- Use JSDoc-style multi-like comments (`/** */`)
- Document classes with their own JSDoc comment, do not use a big comment
  section divider above each class.

### Testing

- New syntax features MUST have parser tests (and lexer tests if new tokens).
- New AST nodes MUST have visit methods in `visitor.ts` (for DCE).
- **Codegen tests**: Use `compileAndRun(source)` or `compileAndInstantiate(source)`
  from `test/codegen/utils.ts`.
- **Isolating tests**: Use `--test-only` flag + `test.only()`.

### Documentation

When adding or modifying language features, update:

1. `docs/language-reference.md`
2. `packages/website/src/docs/quick-reference.md`

Design documents live in `docs/design/`. See the directory listing for topics.
