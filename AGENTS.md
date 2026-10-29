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

// Libraries: ES-style imports/exports
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
the architecture. It is linked into the CLI module (`packages/zena-cli/out/zena.wasm`)
and executed by `zena-cli` (`packages/zena-cli`), the Rust/wasmtime host.
An earlier TypeScript implementation (`packages/compiler`, "the bootstrap
compiler") has been deleted; older docs and comments may still refer to it.

The compiler must pass the **portable tests** in `tests/language/`.

## The Bootstrap (CRITICAL)

The self-hosted compiler builds itself from a prebuilt, checked-in
compiler: `packages/zena-compiler/bootstrap/cli.wasm` — **the
bootstrap**. `build:cli` runs it through `zena-run` (built from source
by cargo) to produce the working Stage A compiler (`zena/out/cli.wasm`),
which then builds the CLI module and everything else. Design doc:
`docs/design/bootstrapping.md`. Rules:

- **NEVER edit, delete, or regenerate `bootstrap/cli.wasm` by hand.**
  Re-baselining goes through `npm run reseed -w @zena-lang/zena-compiler`,
  which is gated on the full suite plus the fixpoint check, followed by
  a second `npm test` that rebuilds everything from the new bootstrap.
- **The invariant**: the bootstrap must build a HEAD that passes the
  test suite. `test:fixpoint` (stage-B ≡ stage-C byte parity) is part
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

Skips are printed, with their reasons, in every run's summary. Run a single
category (optionally filtered by path substring) with:

```bash
npm run test:execution -w @zena-lang/zena-compiler -- variables
```

When fixing bugs or adding features, prefer adding portable tests here.

## Project Structure

This project is an **npm monorepo** managed with **Wireit** (plus a Cargo
workspace at the root for the Rust/wasmtime hosts).

Directory-level orientation lives in `CONTEXT.md` files. Read the
`CONTEXT.md` nearest your work before editing:

- [packages/zena-compiler/CONTEXT.md](packages/zena-compiler/CONTEXT.md) — self-hosted compiler and codegen overview
- [packages/zena-compiler/zena/lib/codegen/ir/CONTEXT.md](packages/zena-compiler/zena/lib/codegen/ir/CONTEXT.md) — ZIR backend (lowering, GVN, emit)
- [packages/zena-compiler/zena/lib/checker/CONTEXT.md](packages/zena-compiler/zena/lib/checker/CONTEXT.md) — the type checker's libraries
- [packages/zena-compiler/zena/lib/codegen/reachability/CONTEXT.md](packages/zena-compiler/zena/lib/codegen/reachability/CONTEXT.md) — RTA and specialization
- [packages/zena-cli/CONTEXT.md](packages/zena-cli/CONTEXT.md) — CLI module and Rust/wasmtime host
- [packages/pds/CONTEXT.md](packages/pds/CONTEXT.md) — the PDS and package host, ported from pds.js
- [packages/pds-web/CONTEXT.md](packages/pds-web/CONTEXT.md) — the PDS's server-rendered pages and their assets (Radica)
- [packages/workspace-hack/CONTEXT.md](packages/workspace-hack/CONTEXT.md) — the generated crate that gives the Rust crates one set of dependency features

### Packages & Directories

- **`packages/zena-compiler`**: The self-hosted compiler (`@zena-lang/zena-compiler`). The checked-in bootstrap lives in `bootstrap/`.
- **`packages/stdlib`**: Standard library (`@zena-lang/stdlib`).
- **`packages/zena-cli`**: The `zena` command (`@zena-lang/zena-cli`): the Zena CLI module (`zena/main.zena` → `out/zena.wasm`) and the Rust/wasmtime binary that hosts it. Links in the compiler, test and bench runners, `zb`, `zenadoc`, `zena-formatter`, and `language-service`.
- **`packages/zena-runtime`**: Rust library shared by `zena-cli`, `zena-run`, and `zenafx`: the wasmtime engine configuration, the `.cwasm` cache, WASI 0.3, and the `zena-cli:host` WIT imports (stack traces, process spawning, running Wasm modules, instantiating components and keeping them). The Rust counterpart of `packages/runtime`.
- **`packages/workspace-hack`**: A crate with no code, generated by `cargo hakari`, that every Rust crate depends on so that `zena-run`, `zena-cli` and `zfx` share one build of wasmtime. Run `cargo hakari generate && cargo hakari manage-deps` after changing a Rust dependency.
- **`packages/zena-run`**: Minimal Rust binary that runs one compiled Zena module on wasmtime with those imports, without the CLI module.
- **`packages/zenafx`**: Experimental runtime binary (`zfx`) for graphical programs: runs WebAssembly components with GPU hardware acceleration via `wasi:webgpu` and OS window presentation via `wasi-gfx:surface`. (See [graphical-runtime.md](docs/design/graphical-runtime.md)).
- **`packages/wit-parser`**: WIT (WebAssembly Interface Types) parser, resolver, and component encoder (`@zena-lang/wit-parser`). (See [wit-parser.md](docs/design/wit-parser.md)).
- **`packages/zena-formatter`**: Code formatter for Zena (`@zena-lang/zena-formatter`).
- **`packages/zena-lint`**: Lint rules for Zena source, each with a fix the tool applies: `function` declarations for top-level arrows, `??`/`?.`, collection literals, immutable fields and variables, no redundant casts or annotations (`@zena-lang/zena-lint`). Every fix is type-checked before it is kept. `zena lint <paths>` reports, `zena lint --fix <paths>` rewrites; the language server and the VS Code extension show the findings with quick fixes. See its README.
- **`packages/zb`**: Zena build orchestrator tool (`@zena-lang/zb`).
- **`packages/workflow`**: Workflow automation package (`@zena-lang/workflow`).
- **`packages/protobuf`**: Protocol Buffers support for Zena (`@zena-lang/protobuf`).
- **`packages/google-cloud`**: Google Cloud client libraries for Zena (`@zena-lang/google-cloud`).
- **`packages/runtime`**: JS runtime helpers (`@zena-lang/runtime`).
- **`packages/atproto`**: AT Protocol libraries: the data model, DAG-CBOR, CIDs, repositories and their proofs, keys and signatures, identity resolution, XRPC, service auth and sessions (`@zena-lang/atproto`).
- **`packages/package-manager`**: The package manager's libraries: records, source archives, fetching, version selection, manifests and workspaces, and the host's lexicons (`@zena-lang/package-manager`).
- **`packages/pds`**: An AT Protocol PDS written in Zena, ported from pds.js, and the base of the Zena package host (`@zena-lang/pds`). (See [pds.md](docs/design/pds.md)).
- **`packages/pds-web`**: The stylesheet and script of the package host's web pages, which the PDS renders on the server (`packages/pds/zena/web`): Radica's design tokens and the few Radica elements the pages use (`@zena-lang/pds-web`).
- **`packages/language-service`**: Language service library, `lsp.zena` / `lsp.wasm`, and the JS API around it (`@zena-lang/language-service`). Published.
- **`packages/zenadoc`**: API documentation extraction — reads a package's source and emits JSON describing its public API (`@zena-lang/zenadoc`). (See [zenadoc.md](docs/design/zenadoc.md)).
- **`packages/codemirror`**: Zena support for CodeMirror 6 (`@zena-lang/codemirror`). Published.
- **`packages/playground`**: The `<zena-playground>` element (`@zena-lang/playground`). Published.
- **`packages/website`** & **`packages/website-client`**: Project website and documentation (`@zena-lang/website`).
- **`packages/vscode-zena`**: VS Code extension providing syntax highlighting and language server client integration.
- **`tests/language/`**: Portable language tests.
- **`docs/language-reference.md`**: Official language reference.
- **`docs/design/`**: Design documents for complex features.
- **`PLAN.md`**: Completed and planned work.

## Interaction Guidelines

- **Conversational Requirement**: You MUST explain your plan in plain English
  BEFORE generating code or editing files. Do not act silently.
- **Clarification Protocol**: If a request is ambiguous or lacks context, you
  MUST ask a clarifying question. Do not guess. If your harness provides a
  structured multiple-choice question tool (e.g., `ask_question` in Antigravity,
  `AskUserQuestion` in Claude Code, `vscode_askQuestions` in VS Code), use it
  when presenting design choices or resolving ambiguity.
- **Task Management**: For multi-step tasks, use your harness's task tracking
  tool if available (e.g., `TodoWrite` / task tools in Claude Code,
  `manage_todo_list` in VS Code, or task artifacts in Antigravity).
- **Role**: You are a pair programmer, not an automated script runner. Talk to
  me.

### Reading and Editing Files (CRITICAL)

- **⛔ NEVER use `cat`, `echo`, `tee`, or other terminal commands to read,
  create, or edit files.** Do not write or run shell/node/python scripts to
  create or modify source or test files.
- **ALWAYS use your harness's built-in tools** for reading files, searching file
  names and contents, creating files, and making targeted edits. When reading
  large files or test output logs, use your file-reading tool's line-range
  parameters rather than `head` or `tail`.
- **DO NOT** create temporary text files with content that you want to put into
  a source file. Create or edit the source file directly.
- Reserve command-line tools (`sed`, `awk`, etc.) strictly for large-scale,
  mechanical multi-file replacements where single-file edit tools are
  impractical.

## Development Environment & CLI Tools

### Nix & Prerequisites

The project uses **Nix flakes** for reproducible tooling (Node.js, Rust/cargo,
wasmtime, wasm-tools).

- **With direnv** (recommended): Run `direnv allow` once.
- **Without direnv**: Prefix commands with `nix develop -c`.
- **Without Nix**: You need **Node.js v25+** (for built-in WASM `exnref`
  support; check with `node -v`) and a **Rust toolchain (`cargo`)**. `zena-cli`
  and `zena-run` embed Wasmtime via Cargo, so `npm run build` and `npm test`
  work without standalone `wasmtime`; the standalone `wasmtime` and
  `wasm-tools` CLIs are only needed for direct WASM inspection and debugging.
- **Installing npm dependencies**: `npm ci`, in a new checkout or worktree
  and after pulling. It installs what `package-lock.json` pins and never
  writes it. Wireit counts the lockfile as an input of every script, so an
  `npm install` that rewrites it makes the next build rerun everything.
  Use `npm i <package>` only to add or change a dependency, and commit the
  lockfile with it.

### The `zena` CLI (`zena-cli`)

Once built (`npm run build -w @zena-lang/zena-cli`), invoke the CLI either
directly from the repository root as `./target/release/zena-cli` (resolves
paths relative to your current working directory) or through Wireit as
`npm run zena -w @zena-lang/zena-cli -- ...` (ensures dependencies are built
first, with paths relative to `packages/zena-cli`).

Subcommands (`./target/release/zena-cli <subcommand>`):

- **`build <file.zena> -o <out.wasm|.wat>`**: Compile a Zena file to binary
  `.wasm` or text `.wat` (selected by `-o` extension).
  - `--target` / `-t`: `zena-cli` (default; WASI 0.3 component with
    `zena-cli:host` imports), `component` (standard WASI 0.3 / WIT world
    component), `js` (core module for `@zena-lang/runtime`; `host` is a legacy
    alias), or `freestanding` (core module with no host imports beyond
    `@external`).
  - `--wit <path>`, `--world <name>`: WIT world for `component` builds.
  - `--extension-wit <path>`: An extension's WIT, which the world's views
    of its interfaces are checked against; repeatable, and needs `--wit`
    and `--world` (`docs/design/runtime-components.md`).
  - `--imported-string-constants <module>`: The module `js` builds import
    string literals from (default `_`; WebAssembly ESM integration uses
    `wasm:js/string-constants`).
  - `--compact-imports`: Group imports by module, and by type within a
    module, in the encodings of the compact import section proposal,
    reordering them to do so. Experimental: V8 reads it behind
    `--experimental-wasm-compact-imports`, and wasmtime does not, so
    component targets reject it.
  - `--time`: Print compiler phase timings.
  - Global flags before subcommand: `-g` / `--debug` (emit WASM name section
    and disable inlining on run), `-O <0|1|2|s>` (optimization level; default
    `1`).
- **`build [target]`**: Run a Wireit build target using `zb` (e.g.,
  `zena-cli build`, `zena-cli build test`, or
  `zena-cli build ./packages/zb:test`).
- **`run <file.zena|file.wasm> [-- args...]`**: Compile (through the `.zena`
  compile cache) and run a source file, or run a compiled `.wasm` module.
  Supports `--dir HOST[::GUEST]`, `--allow-spawn`, `--allow-extensions`,
  `--invoke <fn>`, `--no-cache`, and `--time`.
- **`test [paths/globs...]`**: Discover and run `*_test.zena` files in parallel.
  Supports `-f` / `--filter <substring>`, `--exclude <glob>`, and `--single`.
- **`fmt [--write|-w | --check] <files...>`**: Format `.zena` files.
- **`lint [--fix] [--only rules] [--skip rules] <paths...>`**: Report what
  the lint rules (`packages/zena-lint`) find in `.zena` files, as
  `path:line:column: message [rule]`, exiting 1 when there are findings;
  `--fix` rewrites the files, keeping each fix the type checker accepts.
  `--list-rules` prints the rules.
- **`add <package>[@version] [--name <local>]`**: Add a published package,
  by DID, handle or `@scope/name`, to `zena-package.json`; select versions
  for everything it leads to, pin them in `zena-lock.json`, and fetch
  them.
- **`update [names...]`**: Raise dependencies to the latest version of their
  major version that is not retracted, then pin and fetch as `add` does.
- **`login <handle or DID> [--password-stdin]`**: Sign in to an atproto
  account with an app password, from stdin, `ZENA_APP_PASSWORD` or the
  terminal, keeping the session in `$ZENA_CONFIG_DIR/session.json` (default
  `~/.config/zena`), readable only by its owner. **`logout`** ends it.
- **`publish [--scope <name> --yes] [--host <url>]`**: Publish the package
  you are in at its manifest's `version` to a package host
  (`ZENA_PACKAGE_HOST`), creating its account first when it has no `did`,
  in the scope its manifest's `scope` or `--scope` names. The host holds
  the release until enough maintainers attest it.
  **`approve [<package>@]<version> | @<scope> | <package> [--yes]`** shows a
  release, or changes to who belongs, waiting for approval and, with
  `--yes`, approves them.
  **`package create`** only creates it. **`retract <version> [--reason]`**
  marks a release so that choosing a version skips it.
  **`ci create <scope>/<name>`** makes an automation account for CI to
  publish as.
- **`scope create <name> [--yes]`**, **`scope info <scope>`**: Create a
  scope on a package host, with you as its owner, or describe one.
  Publishing never creates a scope. **`scope add|remove <scope> <person>`**,
  **`scope members`**, **`team create|add|remove|delete|members`** and
  **`owner add|remove|list`** change and show who belongs to a scope, a
  team and a package. **`scope settings`**, **`team settings`** and
  **`owner settings`** show and change their thresholds, and **`scope
policy`** the minimums, defaults and creators of a scope's packages.
- **`fetch`**: Fetch the published packages `zena-lock.json` pins into
  the package cache, checking each against its pins. `ZENA_PLC_DIRECTORY`
  and `ZENA_DNS_OVER_HTTPS` replace the PLC directory and the DNS resolver
  handles are looked up with.
- **`doc <path> [-o <out.json>]`**: Extract a package's public API as JSON.
- **`bench <suite.json> [-o <out.json>]`**: Run a benchmark suite.
- **`lsp`**: Run the Zena language server over stdin/stdout.
- **`precompile <file.wasm>`**: Ahead-of-time compile a module to `.cwasm`.

Examples:

```bash
# Compile (cached) and run a Zena program from the repo root
./target/release/zena-cli run main.zena

# Compile to a standalone module (default target: zena-cli) and run it
./target/release/zena-cli build main.zena -o main.wasm
./target/release/zena-cli run main.wasm   # or: ./target/release/zena-run main.wasm

# Emit WAT text for inspection
./target/release/zena-cli build main.zena -o main.wat
```

### Running Benchmarks

Benchmarks are workload pairs under `benchmarks/workloads/`: each is a
small program built at `-O2`, and the pairs set an abstract form (an
interface-typed parameter, `map` over a closure, the iterator protocol)
against the same computation written concretely, so the gap is the
optimizer's to close. `benchmarks/README.md` lists them.

```bash
npm run bench                       # build every workload and report binary sizes
npm run bench:speed                 # time them (zena-cli bench, statistical sampling)
npm run bench -- --build --speed poly-param   # one workload, build + time
npm run bench:compile               # compiler phase timing benchmark
```

Timings on a loaded machine are noise; check `uptime` before trusting a
number.

### Debugging WASM Crashes

When a WASM module traps (`RuntimeError: illegal cast`, `unreachable`, etc.),
stack traces show anonymous function indices by default. Pass **`-g`** to emit
a WASM name section with readable function names (and disable Wasmtime inlining
when run via `zena-cli`):

```bash
./target/release/zena-cli -g build main.zena -o main.wasm
```

This produces stack traces like `ScopeBuilder.#processClassBody → Compiler.compile`
instead of `wasm-function[2621]`. Use `wasm-tools dump -d main.wasm` (or compile
with `-o main.wat`) to inspect specific bytecodes or instructions.

The name section is **opt-in**: it is debug metadata, and for a small module
the largest thing in it (9.9KB of a 34KB hello-world), so a plain `build`
leaves it out. `-g` sets `CompileFileOptions.debugNames` (or `ZENA_DEBUG_NAMES=1`
in the environment). The compiler's own builds, the test wasms, and the
portable-execution runner all keep names, so their stack traces are always
readable. See `docs/design/binary-size.md`.

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

### Declaring inputs

An input wider than what a script reads makes every edit to it rerun that
script and everything after it, so keep inputs to what the script reads:

- **Manifests.** A compile reads every `zena-package.json` in the
  workspace, but its output depends only on the root manifest and the
  manifests of the packages it reaches. List those
  (`../atproto/zena/zena-package.json`), never a glob over all of them.
  The root `check:workspace` script fails `npm test` when any manifest
  cannot be read.
- **Sources.** List the directories a compile's imports reach, such as a
  package's `lib/`. A package's tests are inputs only of the script that
  runs them.
- **A dependency's output.** When a script reads a file another script
  writes (`zena/out/cli.wasm`), list the file and depend on that script
  with `"cascade": false`. It then reruns when the file's bytes change,
  and not whenever the other script reruns. It no longer inherits that
  script's inputs, so it lists everything else it reads itself.
- **Generated files.** A file a script writes belongs in its `output`, and
  out of every other script's inputs. Otherwise the run after the one
  that wrote it sees a new input and rebuilds.

### `ERR_MODULE_NOT_FOUND` on a file whose source exists

If something fails to import, say, `packages/runtime/lib/index.js` while
`src/index.ts` is sitting right there, the package's output has gone partial.

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
rm -rf packages/runtime/.wireit packages/runtime/tsconfig.tsbuildinfo
npm run build -w @zena-lang/runtime
```

This is the one situation where the cache is genuinely stale. Everything under
"Rules" above still applies otherwise.

### Running Tests

**ALWAYS** use `npm` to run tests. Never use `npx`, `tsx`, or bash scripts.
There is no `wireit` command. Use `npm test`.

```bash
# Run all tests
npm test

# Everything except the fixpoint check, for a faster local loop
npm run test:smoke

# One area's Zena tests, with the compiler that is already built
npm run test:quick -- packages/stdlib/tests/regex

# Run tests for a specific package
npm test -w @zena-lang/zena-compiler

# Run a specific TypeScript test file (note: path is relative, uses .js extension)
npm test -w @zena-lang/runtime -- test/runtime_test.js

# Isolate a specific TypeScript test (use test.only() in the file)
npm test -w @zena-lang/runtime -- --test-only test/runtime_test.js
```

- Packages are referred to by **package name** (`@zena-lang/zena-compiler`), not path.
- **NEVER** use `npm test packages/zena-compiler/...` or `npm test -- some/path`.
- `npm run test:smoke` is `npm test` without `test:fixpoint`, which builds
  stage B and stage C of the compiler to compare them and is the longest
  chain in a cold run. It catches the compiler miscompiling itself, which no
  other test can see, so CI (`nix flake check`) runs the full `npm test`. Use
  the smoke target for the local loop; run `npm test` before finishing a task.
  See `docs/design/bootstrapping.md`.
- `npm run test:quick -- <path>` runs `zena test` on a path, directory or
  glob with **the compiler that is already built**. It is not a wireit
  script, so it rebuilds nothing. This is the inner loop for a standard
  library change: editing `zena/regex.zena` and running
  `npm run test:quick -- packages/stdlib/tests/regex` takes 1.5s, where
  `npm test -w @zena-lang/stdlib` takes 97s, because the standard library is
  an input to the compiler and a change to it rebuilds stage A, the CLI
  module and the bundle.

  What it gives up is exactly that rebuild. The compiler reads the standard
  library from disk when it compiles, so your test does compile against the
  sources you just edited — but the compiler running it still has the old
  ones linked in, and 66 of the standard library's 92 files are in its
  closure. So a change that affects the compiler can pass here and fail once
  the compiler is rebuilt. Finish with `npm run test:smoke` or `npm test`.

  It needs the `zena` command built: `npm run build -w @zena-lang/zena-cli`.

- If test output is large and written to a file by the harness, use your
  file-reading tool with line-range parameters to inspect it.
- We use the Wireit quiet logger by default, which only logs test errors.
  If you need to see full test output, use `WIREIT_LOGGER=simple`.

## ⚠️ CRITICAL: Temporary Files

**NEVER create test or debug files under `/tmp/`.** Files in `/tmp/` cannot
import project modules because relative paths are broken.

- If you truly need a temporary file for debugging, create temporary test files
  in the **normal test directories** (e.g., `packages/zena-compiler/zena/test/`
  or `packages/runtime/src/test/`).
- For portable tests, create them in `tests/language/`.
- Keep them. Promote a scratch file to a permanent test, or leave it where it
  is. A probe that located a bug is the reproduction for that bug, so deleting
  it leaves a claim with nothing behind it.

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

### Zena (self-hosted compiler, stdlib, formatter, etc)

- Prefer `let` for variables
- Use enums where appropriate
- Prefer private fields (`#`)
- Use `for`/`in` loops when iterating over arrays and other iterables
- Use `HashSet`s when needed instead of `HashMap<T, boolean>`
- Annotate collections with the class (`HashMap`, `HashSet`,
  `GrowableArray`), not the interface, unless the slot is genuinely
  polymorphic; an interface annotation costs a fat pointer per crossing
  and an indirect call per use
- Use `if` statements instead of a `match()` with one arm.
- Don't put types on functions that can use contextual typing, like callbacks.
- Use JSDoc-style multi-line comments (`/** */`)
- Document classes with their own JSDoc comment; do not use a big comment
  section divider above each class.
- Use template literals when concatenating more than two strings

### Testing

- New syntax, type-checking, or codegen features and bug fixes should include
  portable tests under `tests/language/` (`syntax/`, `semantics/`, `execution/`).
- New AST nodes in `packages/zena-compiler/zena/lib/ast.zena` must be handled in
  `ast-visitor.zena` and the reachability pass (`zena/lib/codegen/reachability/`).
- Zena unit tests (`*_test.zena`) use `suite`, `test`, and `expect` from
  `zena:test` and can be run directly during iteration with
  `npm run test:quick -- <path>`.
- For TypeScript tests (`node:test`), isolate a single test with `--test-only`
  and `test.only()`.

### Documentation

When adding or modifying language features, update:

1. `docs/language-reference.md`
2. `packages/website/src/reference/quick-reference.md`

Design documents live in `docs/design/`. See the directory listing for topics.

All prose — design docs, commit messages, comments — follows
`docs/writing-style.md`. Read it before writing any of these.
