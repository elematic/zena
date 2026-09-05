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

// Functions: arrow syntax
let add = (a: i32, b: i32) => a + b;
let greet = (name: String) => {
  return 'Hello, ' + name;
};

// ...or a top-level `function` declaration, which is never a closure
function addOne(a: i32): i32 {
  return a + 1;
}

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
export function main(): i32 { return 0; }
```

Key things that differ from TypeScript:

- **`function` is for top-level declarations only** — everything else is an
  arrow function. A `function` can never be a closure; an arrow can.
- **No `const`** — use `let` (immutable) and `var` (mutable).
- **Class fields are immutable by default** — use `var` to make mutable.
- **Dart-style constructors** — initializer lists (`: x = x, y = y`), `this.`
  params, semicolon bodies.
- **`String` not `string`** — capital S (it's a class, not a primitive alias).
- for/in loops iterate on iterables and iterators: `for (let item in items)`.
  They are like for/of loops in TypeScript.
- **No `++`/`--`** — use `+= 1` instead.
- **Sound type system** — there is no `any`, and no escape hatch from checking.
  `anyref` is the top type for REFERENCES only; primitives are never boxed
  implicitly, so putting one behind a reference means writing `new Box<T>(x)`.
- **`match` expressions** with exhaustiveness checking.
- **Sealed classes** for sum types, not TypeScript discriminated unions.

## The Compiler

The compiler (`packages/zena-compiler`, package name
`@zena-lang/zena-compiler`) is **self-hosted**: written in Zena, with a
ZIR (CFG+SSA IR) backend. See `docs/design/self-hosted-compiler.md` for
the architecture. It is executed by `zena-cli` (`packages/zena-cli`),
the Rust/wasmtime host. An earlier TypeScript implementation
(`packages/compiler`, "the bootstrap compiler") has been deleted; older
docs and comments may still refer to it.

The compiler must pass the **portable tests** in `tests/language/`.

## The Bootstrap (CRITICAL)

The self-hosted compiler builds itself from a prebuilt, checked-in
compiler: `packages/zena-compiler/bootstrap/cli.wasm` — **the
bootstrap**. `build:cli` runs it through `zena-cli` (built from source
by cargo) to produce the working compiler; everything else builds from
that. Design doc: `docs/design/bootstrapping.md`. Rules:

- **NEVER edit, delete, or regenerate `bootstrap/cli.wasm` by hand.**
  Re-baselining goes through `npm run reseed -w @zena-lang/zena-compiler`,
  which is gated on the full suite plus the fixpoint check, followed by
  a second `npm test` that rebuilds everything from the new bootstrap.
- **The invariant**: the bootstrap must build a HEAD that passes the
  test suite. `test:fixpoint` (stage-1 ≡ stage-2 byte parity) is part
  of `npm test` — a compiler that miscompiles itself fails the gate.
- A compiler-source change the current bootstrap cannot compile lands
  in two steps (feature first, self-use after a reseed) — see the
  design doc.

## Portable Tests

Tests in `tests/language/` are compiler-agnostic `.zena` files with comment
directives. They're organized into three categories:

- **`syntax/`** — Parser tests. Directive: `// @target: module|statement|expression`
- **`semantics/`** — Type checker tests. Directive: `// @mode: check` with `// @error:` on error lines.
- **`execution/`** — Codegen tests. Directive: `// @mode: run` with `// @result:` for expected return value.

The runners are Zena programs in `packages/zena-compiler/zena/test/`
(`portable_syntax`, `portable_semantics`, `portable_execution`). They
discover tests by walking the directory — there is no list of tests or
directories to add to. A test that cannot run yet says so in the file:

```zena
// @skip: <why this cannot run yet>
```

Skips are printed, with their reasons, in every run's summary.

When fixing bugs or adding features, prefer adding portable tests here.

## Project Structure

This project is an **npm monorepo** managed with **Wireit**.

- **`packages/zena-compiler`**: The self-hosted compiler (`@zena-lang/zena-compiler`). (See [CONTEXT.md](packages/zena-compiler/CONTEXT.md); the ZIR backend and the reachability pass each have their own CONTEXT.md under `zena/lib/codegen/`. The checked-in bootstrap lives in `bootstrap/`.)
- **`packages/stdlib`**: Standard library (`@zena-lang/stdlib`).
- **`packages/zena-cli`**: Native Rust CLI for executing Zena via Wasmtime. (See [CONTEXT.md](packages/zena-cli/CONTEXT.md)).
- **`packages/runtime`**: JS runtime helpers.
- **`packages/language-service`**: `lsp.zena` and the `lsp.wasm` it builds, plus the JS API around it (`@zena-lang/language-service`). Published.
- **`packages/zenadoc`**: API documentation extraction — reads a package's source and emits JSON describing its public API (`@zena-lang/zenadoc`). See [zenadoc.md](docs/design/zenadoc.md).
- **`packages/codemirror`**: Zena support for CodeMirror 6 (`@zena-lang/codemirror`). Published.
- **`packages/playground`**: the `<zena-playground>` element (`@zena-lang/playground`). Published.
- **`tests/language/`**: Portable language tests.
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

### Running Zena Programs

```bash
npm run zena -w @zena-lang/zena-cli -- run main.zena
```

Paths are relative to `packages/zena-cli`. To build a standalone wasm
and run it under wasmtime directly:

```bash
npm run zena -w @zena-lang/zena-cli -- build main.zena -o main.wasm
wasmtime run -W gc=y -W function-references=y -W exceptions=y --invoke main main.wasm
```

### Running Benchmarks

We have a micro-benchmarking suite that compares Zena's execution speed (under `wasmtime` and Node.js) with native JS.

To run the benchmarks:

```bash
npm run benchmark -w @zena-lang/zena-compiler
```

You can filter benchmarks (e.g. `--filter StringBuilder`) or specify iteration runs (`--runs 1`).

### Debugging WASM Crashes

When a WASM module crashes with `RuntimeError: illegal cast` or similar traps,
stack traces show anonymous function indices by default. Use the **`-g` flag**
to emit a WASM name section with readable function names:

```bash
npm run zena -w @zena-lang/zena-cli -- -g build main.zena -o main.wasm --target host
```

This produces stack traces like `ScopeBuilder.#processClassBody → Compiler.compile`
instead of `wasm-function[2621]`. Use `wasm-tools dump -d main.wasm` to inspect
specific bytecode offsets from the trace.

The name section is **opt-in**: it is debug metadata, and for a small module
the largest thing in it (9.9KB of a 34KB hello-world), so a plain `build`
leaves it out. `-g` reaches the compiler as `ZENA_DEBUG_NAMES`; using
`BinaryGenerator` directly, pass `debugNames = true` as its third argument.
The compiler's own builds, the test wasms and the portable-execution runner
all keep names, so their stack traces are always readable. See
`docs/design/binary-size.md`.

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

### `ERR_MODULE_NOT_FOUND` on a file whose source exists

If something fails to import, say, `packages/compiler/lib/ast.js` while
`src/lib/ast.ts` is sitting right there, the package's output has gone partial.

**Check for a second build first.** Two Wireit runs over one checkout — a
second terminal, an editor task, `npm install` re-linking the workspaces — will
race on the same output directories, and one will read `lib/` while the other
is rewriting it. Wireit usually says so: "Input file … was deleted
unexpectedly. Is another process writing to the same location?" Wait for the
other run to finish; nothing is broken.

Otherwise the output really is wrong, and Wireit has cached it as good:

1. A file disappears from `lib/` — an interrupted build, a stray `rm`.
2. An input changes, so Wireit re-runs `tsc`. The `tsc` scripts use
   `clean: "if-file-deleted"` to stay incremental, so `tsconfig.tsbuildinfo`
   survives — and it still lists that file as emitted, so `tsc` re-emits
   nothing and exits 0.
3. Wireit caches the incomplete output, and every dependent fails until some
   unrelated input shifts the fingerprint.

The fingerprint is computed from inputs, so deleting the output does not
invalidate it — Wireit will just restore the same bad cache entry. Drop the
entry instead:

```bash
rm -rf packages/compiler/.wireit packages/compiler/tsconfig.tsbuildinfo
npm run build -w @zena-lang/compiler
```

This is the one situation where the cache is genuinely stale. Everything under
"Rules" above still applies otherwise.

### Running Tests

**ALWAYS** use `npm` to run tests. Never use `npx`, `tsx`, or bash scripts.
There is no `wireit` command. Use `npm test`.

```bash
# Run all tests
npm test

# Run tests for a specific package
npm test -w @zena-lang/zena-compiler

# Run a specific test file (note: path is relative, uses .js extension)
npm test -w @zena-lang/runtime -- test/runtime_test.js

# Isolate a specific test (use test.only() in the file)
npm test -w @zena-lang/runtime -- --test-only test/runtime_test.js
```

- Packages are referred to by **package name** (`@zena-lang/zena-compiler`), not path.
- **NEVER** use `npm test packages/zena-compiler/...` or `npm test -- some/path`.
- If test output is large and written to a file by the system, use the
  `read_file` tool, which supports `startLine` and `endLine` parameters, to read
  the file.
- We use the Wireit quiet logger by default, which should only log test errors.
  If you need to see full test output, use `WIREIT_LOGGER=simple`.

## ⚠️ CRITICAL: Temporary Files

**NEVER create test or debug files under `/tmp/`.** Files in `/tmp/` cannot
import project modules because relative paths are broken.

- If you truly need a temporary file for debugging, create temporary test files
  in the **normal test directories** (e.g., `packages/runtime/src/test/`).
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

### TypeScript (scripts, runtime, tooling)

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

All prose — design docs, commit messages, PR descriptions, comments —
follows `docs/writing-style.md`. Read it before writing any of these.
