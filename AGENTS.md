# Zena Project Instructions

This document guides AI agents working on the Zena project. For a complete
language description, see `docs/language-reference.md`. For completed features
and planned work, see `PLAN.md`.

## Project Overview

Zena is a statically typed language targeting WebAssembly GC, with
TypeScript's syntax, a sound type system and no implicit coercion.

### Writing Zena

The guide to the language is [`skills/zena/SKILL.md`](skills/zena/SKILL.md),
the skill that agents in other projects install. Three of its sections are
copied below, so that every agent here has them whatever its harness
loads. **Read the whole file before writing or reviewing Zena**: it also
has a tour of the language and the work loop, and its `references/`
directory has an example of each idiom, the compiler's message for common
mistakes, a map of the standard library, and the tools.

In this repository the `zena` command it names is
`./target/release/zena-cli`, and "Coding Standards" below adds the rules
that are this repository's own.

The copy is generated: change `skills/zena/SKILL.md` and run
`npm run skill`. `packages/zena-cli/tests/skill_test.zena` fails while the
two differ, and compiles and lints the skill's code blocks.

<!-- skills/zena/SKILL.md: begin (npm run skill) -->

#### The language in brief

Start from TypeScript's syntax: `let`, arrow functions, classes, generics,
`import`/`export`, template literals, `?.` and `??`, flow narrowing.

Remove everything dynamic. There is no `any`, `undefined`, truthiness,
implicit coercion, prototype, `this` rebinding or structural class typing.
The type system is sound, and types exist at run time: `is` and `as` are
checked, and `Box<i32>` is a different type from `Box<f64>`.

Split values into three kinds:

- **Primitives** are WebAssembly value types (`i32`, `i64`, `u32`, `u64`,
  `f32`, `f64`, `boolean`, and the narrow `i8`/`u8`/`i16`/`u16`). They are
  never boxed implicitly and never `null`.
- **Records and tuples** (`{x: 1, y: 2}`, `(1, 'a')`) are structural,
  immutable and compared by value.
- **Classes and interfaces** are nominal.

Then add, each from a language that does it well:

- **Swift's mutability defaults.** `let` is immutable and `var` is mutable,
  for variables and for class fields. `var(#count) count: i32 = 0` is a
  field with a public getter and a private setter.
- **Dart's classes.** Every field is initialized before a constructor's
  body runs: by a `this.` parameter, `new(this.x, this.y);`, or in an
  initializer list, `new(w: f64) : width = w, super(w);`, where `super`
  goes last. Named constructors: `new Point.origin()`. Mixins:
  `class Button with Clickable`. Extension classes:
  `extension class Path on String`, a typed view of a value, erased at run
  time.
- **Scala's data types.** A case class, `class Point(x: f64, y: f64)`, gets
  its fields, constructor, `==` and `hashCode`. A `sealed class` with
  `case Circle(radius: f64)` variants is a sum type.
- **Scala's `match`, Rust's `if let`.**
  `match (shape) { case Circle {radius} if radius > 0.0: … }` destructures,
  takes guards and must cover every case. `if (let P = x)` and
  `while (let P = x)` test and bind. `if`, `match` and `try` are
  expressions, so there is no ternary and no `switch`.
- **Go's multiple returns, on the stack.** `inline (i32, i32)` returns two
  values with no allocation. `inline (true, T) | (false, _)` is a value or
  nothing, and `??` unwraps it: `map.get(key) ?? fallback`.
- **Swift's strings.** A `String` is Unicode text with no integer index.
  `for (let g in s)` iterates graphemes; `s.codePoints`, `s.utf8` and
  `s.utf16` are views; a slice takes a `StringIndex` range.
- **Dafny's contracts, checked at run time.** `requires (n > 0)`,
  `ensures (result >= 0)`, `old(e)` and a loop's `invariant (…)` are part of
  a signature. A `debug` clause runs only in tests. A `static` clause is
  for proof, which is in progress.
- **Nim's distinct types.** `distinct type Meters = f64` is a nominal type
  at no cost. An `opaque type` can be cast into only by its own library.
- **Rust's ownership, without lifetimes.** `using file = open(path);`
  releases a `Disposable` when the block ends, as in C#. A handle that
  outlives a block is a `resource class`, held as `Own<T>`, which moves,
  or `Borrow<T>`, which cannot leave the stack.
- **Trio's cancellation.** `async` and `await` over `Future<T>`. A
  `TaskGroup` cancels what it started, cancellation unwinds past `catch`,
  and `try … cancel { … }` and `shielded { … }` are for cleanup.
- **JavaScript's symbols and iterators, resolved at compile time.** A
  member named by a symbol: `static symbol dispose;`, declared as
  `[Disposable.dispose]()` and called as `x.[Disposable.dispose]()`.
  `for (let x in xs)` drives an `Iterator` whose `next()` allocates
  nothing, and a `gen` function is one.
- **Also:** Hack's pipeline, `x |> f($) |> g($, 1)`; operator and method
  overloading, resolved statically; generics compiled once per type
  argument, as in Rust.

#### Features to reach for

Agents write TypeScript-shaped Zena by default. Each row is a place where
the TypeScript habit compiles, or nearly compiles, and Zena has something
better. Check your diff against this table before you finish.
[references/idioms.md](skills/zena/references/idioms.md) has a compiled example of each.

| When you are about to write                                                                  | Write                                                                                                                  |
| :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| A `kind: 'a' \| 'b'` field and an `if` chain over it                                         | A `sealed class` with `case` variants and an exhaustive `match`                                                        |
| `export let add = (a: i32, b: i32) => a + b;` at the top level                               | `function add(a: i32, b: i32): i32 { … }`: hoisted, and never a closure. Arrows are for callbacks and captures         |
| A class that only holds data, with a hand-written constructor                                | A case class: `class Point(x: f64, y: f64)`                                                                            |
| An `interface` describing a bag of fields                                                    | A record type: `type Options = {port: i32, host: String}`                                                              |
| An options object read as `opts.timeout ?? 5000`                                             | An optional field, `{timeout?: i32}`, read with a default: `let {timeout = 5000} = opts;`                              |
| `T \| null` for a primitive, a sentinel like `-1`, or a thrown error for an expected failure | `inline (true, T) \| (false, _)`, `inline Result<T, E>`, or `Option<T>` to store it                                    |
| An object or array returned to carry two results                                             | `inline (A, B)`, destructured at the call: `let (a, b) = f();`                                                         |
| `if (x.kind == …) … else if …`, nested `if`s that pick a value                               | `match`, with patterns and guards; `if`/`match` as the expression itself                                               |
| A null check then a cast, or `has` then a second lookup                                      | `map.get(k) ?? d` (`??` unwraps `(true, v)`), `if (let (true, v) = map.get(k))`, `if (let Some {value} = opt)`, `x?.y` |
| `if (!ok) throw …` at the top of a function, or a comment "n must be positive"               | `requires (n > 0)`; `ensures (…)` for what the result promises; `invariant (…)` on a loop                              |
| `type UserId = String`, or a bare `i32` standing for a unit                                  | `distinct type UserId = String`; `opaque type` when a value must come from a validating function                       |
| `try { … } finally { x.close(); }`                                                           | `using x = open();`                                                                                                    |
| A wrapper class around one value, to give it a type and methods                              | `extension class Path on String`: the wrapper is erased, and `as` converts for free                                    |
| A base class that exists to share a few methods                                              | A `mixin`, applied with `with`                                                                                         |
| `a.plus(b)`, `a.equals(b)`, `a.compareTo(b) < 0`, `table.get(i)`                             | `operator +`, `operator ==`, `compareTo` (gives `<`), `operator []` and `operator []=`                                 |
| `h(g(f(x)))`                                                                                 | `x \|> f($) \|> g($) \|> h($)`                                                                                         |
| `for (var i = 0; i < xs.length; i += 1) { xs[i] … }`                                         | `for (let x in xs)`; `for (let i in 0..n)`; `for (let {key, value} in map)`                                            |
| An `AbortSignal`-style flag passed down to stop async work                                   | A `TaskGroup` and its `cancel()`; `try … cancel { … }` for cleanup                                                     |
| `s[i]`, `s.length` or a loop over UTF-16 units                                               | `for (let g in s)`, `s.codePoints`, `s.utf8.length`, `StringIndex` ranges, `StringReader`                              |
| A mutable field or `var`, by habit                                                           | `let` and plain fields; `var` only where the value changes                                                             |
| `xs: Array<T>` or `m: Map<K, V>` on a field or parameter                                     | The class: `GrowableArray<T>`, `HashMap<K, V>`. An interface type costs a wrapper per use                              |
| A `number`                                                                                   | The type the value has: `i32` for counts and indexes, `i64`, `f64`, `u8` for bytes                                     |

#### TypeScript that is not Zena

- **Names.** `const`, `string`, `number`, `Promise`, `undefined`,
  `instanceof`, `for … of`, `switch`, `?:`, `++` and `x!` do not exist.
  Write `let`, `String`, a numeric type, `Future`, `null`, `is`,
  `for … in`, `match`, `if (c) a else b`, `+= 1`, and `x as T` after a null
  check.
- **Conditions and operators.** A condition is a `boolean`: `if (text)` and
  `if (count)` are errors. `/` on integers gives a float; integer division
  is `div(a, b)` from `zena:math`. `+` does not convert to a string; write
  `` `n=${n}` ``. `==` compares records, tuples, strings and case classes
  by value. `===` compares references, and is an error on records and
  tuples.
- **Numbers.** An integer literal is an `i32` and a float literal an `f64`
  unless the context says otherwise. An `i32` widens to `i64` or `f64` by
  itself. Narrowing, and mixing signed with unsigned, needs `as`, and a
  cast before a binary operator needs parentheses: `(n as i64) - 1`.
- **Null and unions.** A primitive is never `null`, and cannot share a union
  with a reference: `i32 | null` is an error. Use `Option<i32>`,
  `Box<i32>?` or an inline tuple.
- **Functions.** `function` is only for top-level declarations; inside a
  function, or as a callback, write an arrow. A method body is a block,
  never `=>`. An optional parameter has a default
  (`name: String? = null`), never `?`. There are no rest parameters.
- **Libraries.** A library body holds declarations only: code runs from
  `main`, or from a function something calls. Nothing is global except the
  prelude (`console`, `String`, `Error`, `Option`, `Future`, the array
  types, `Map`, `Box`, ranges). Everything else is imported.
- **Classes.** A field without `var` cannot be assigned anywhere, the
  constructor's body included: `new(x: i32) { this.x = x; }` is an error.
  Write `new(this.x);` or `new(x: i32) : x = x;`, with `super(…)` last in
  that list and never in the body. A field is always `this.x`, also in a
  case class. A getter is `area: f64 { get { return …; } }`. A `var` field
  does not narrow after a null check; copy it to a `let`. A symbol-keyed
  member is called with a dot, `x.[Disposable.dispose]()`: `x[sym]()` is an
  index.
- **Records.** Destructuring renames with `as`: `let {x as left} = point;`.
  A field marked `?` may be absent, which is different from `null`:
  `opts.timeout` is an error, so write `let {timeout = 5000} = opts;` or
  `if (let {timeout} = opts)`. A class field cannot be marked `?`.
- **Collections.** An array literal is an `ImmutableArray`. For a mutable
  one write `new GrowableArray<T>()`, or `growable([1, 2])` or
  `fixed([1, 2])`, both imported from `zena:core`. A `Map` is written with
  `map[k] = v` and read with `map.get(k)`, which returns `(true, v)` or
  `(false, _)`, or with `map[k]`, which throws when the key is missing. Its
  size is `map.size`, and iterating it gives `{key, value}` entries.
- **Strings.** A `String` has no integer index and no useful `length`. See
  "Strings" in [references/idioms.md](skills/zena/references/idioms.md).
- **Errors.** Only an `Error` can be thrown, and `catch (e)` binds one. An
  uncaught error prints `thrown Wasm exception` without its message: catch
  it in `main` and log `e.message`, or reproduce it in a test.

[references/pitfalls.md](skills/zena/references/pitfalls.md) has the longer list, with
the compiler's message for each mistake.

<!-- skills/zena/SKILL.md: end -->

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

The repository bootstraps from a prebuilt, checked-in CLI module:
`packages/zena-cli/bootstrap/zena.wasm` — **the bootstrap**. Before
`packages/zena-cli/out/zena.wasm` is built, `./target/release/zena-cli`
falls back to `bootstrap/zena.wasm`, so `zena build`, `zena fmt` and
`zena lint` work as soon as cargo builds `zena-cli`. During a build,
`zena-compiler:build:cli` runs `bootstrap/zena.wasm` through `zena-cli`
to produce the working Stage A compiler (`zena/out/cli.wasm`), which
then builds `packages/zena-cli/out/zena.wasm` and everything else.
Design doc: `docs/design/bootstrapping.md`. Rules:

- **NEVER edit, delete, or regenerate `bootstrap/zena.wasm` by hand.**
  Re-baselining goes through `npm run reseed`, which is gated on the
  full suite plus the fixpoint check and a byte-for-byte self-audit,
  followed by a second `npm test` that rebuilds everything from the new
  bootstrap.
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
- [packages/pds/CONTEXT.md](packages/pds/CONTEXT.md) — the PDS, ported from pds.js, and its managed accounts
- [packages/registry/CONTEXT.md](packages/registry/CONTEXT.md) — the App View: the registry methods, the site, and the service
- [packages/pds-web/CONTEXT.md](packages/pds-web/CONTEXT.md) — the App View's server-rendered pages and their assets (Radica)
- [packages/markdown/CONTEXT.md](packages/markdown/CONTEXT.md) — CommonMark and GFM parser, AST, plugin API, and HTML renderer
- [packages/semver/CONTEXT.md](packages/semver/CONTEXT.md) — semantic versions and npm's version ranges
- [packages/changes/CONTEXT.md](packages/changes/CONTEXT.md) — change files, units and groups, and release versions
- [packages/terminal/CONTEXT.md](packages/terminal/CONTEXT.md) — colors, Clack-style layout and a spinner for command-line programs
- [packages/workspace-hack/CONTEXT.md](packages/workspace-hack/CONTEXT.md) — the generated crate that gives the Rust crates one set of dependency features

### Packages & Directories

A new directory under `packages/` gets a `README.md`, a `CONTEXT.md`, a
`CLAUDE.md` containing `@./CONTEXT.md`, and entries in both lists here and
in the root `CLAUDE.md`.

- **`packages/zena-compiler`**: The self-hosted compiler (`@zena-lang/zena-compiler`).
- **`packages/stdlib`**: Standard library (`@zena-lang/stdlib`).
- **`packages/zena-cli`**: The `zena` command (`@zena-lang/zena-cli`): the Zena CLI module (`zena/main.zena` → `out/zena.wasm`, with the checked-in bootstrap in `bootstrap/zena.wasm`) and the Rust/wasmtime binary that hosts it. Links in the compiler, test and bench runners, `zebra`, `zenadoc`, `zena-formatter`, `zena-lint`, and `language-service`.
- **`packages/zena-runtime`**: Rust library shared by `zena-cli`, `zena-run`, and `zenafx`: the wasmtime engine configuration, the `.cwasm` cache, WASI 0.3, and the `zena:host` WIT imports (stack traces, process spawning, running Wasm modules, instantiating components and keeping them, raw terminal input). The Rust counterpart of `packages/runtime`.
- **`packages/workspace-hack`**: A crate with no code, generated by `cargo hakari`, that every Rust crate depends on so that `zena-run`, `zena-cli` and `zfx` share one build of wasmtime. Run `cargo hakari generate && cargo hakari manage-deps` after changing a Rust dependency.
- **`packages/zena-run`**: Minimal Rust binary that runs one compiled Zena module on wasmtime with those imports, without the CLI module.
- **`packages/zenafx`**: Experimental runtime binary (`zfx`) for graphical programs: runs WebAssembly components with GPU hardware acceleration via `wasi:webgpu` and OS window presentation via `wasi-gfx:surface`. (See [graphical-runtime.md](docs/design/graphical-runtime.md)).
- **`packages/wit-parser`**: WIT (WebAssembly Interface Types) parser, resolver, and component encoder (`@zena-lang/wit-parser`). (See [wit-parser.md](docs/design/wit-parser.md)).
- **`packages/markdown`**: CommonMark and GitHub Flavored Markdown (GFM) parser, syntax tree, plugin system, and HTML renderer (`@zena-lang/markdown`). (See [markdown.md](docs/design/markdown.md)).
- **`packages/zena-formatter`**: Code formatter for Zena (`@zena-lang/zena-formatter`).
- **`packages/zena-lint`**: Lint rules for Zena source, each with a fix the tool applies: `function` declarations for top-level arrows, `??`/`?.`, collection literals, immutable fields and variables, no redundant casts or annotations (`@zena-lang/zena-lint`). Every fix is type-checked before it is kept. `zena lint <paths>` reports, `zena lint --fix <paths>` rewrites; the language server and the VS Code extension show the findings with quick fixes. See its README.
- **`packages/zebra`**: Zebra build orchestrator tool (`@zena-lang/zebra`).
- **`packages/terminal`**: Output for command-line programs (`zena-lang:terminal`): colors that follow `NO_COLOR` and `FORCE_COLOR`, Clack's rail and step markers, and its spinner. Zebra and `zena` print with it.
- **`packages/workflow`**: Workflow automation package (`@zena-lang/workflow`).
- **`packages/protobuf`**: Protocol Buffers support for Zena (`@zena-lang/protobuf`).
- **`packages/google-cloud`**: Google Cloud client libraries for Zena (`@zena-lang/google-cloud`).
- **`packages/runtime`**: JS runtime helpers (`@zena-lang/runtime`).
- **`packages/atproto`**: AT Protocol libraries: the data model, DAG-CBOR, CIDs, repositories and their proofs, keys and signatures, identity resolution, XRPC, service auth and sessions (`@zena-lang/atproto`).
- **`packages/semver`**: Semantic versions and npm's version ranges (`zena-lang:semver`): parsing, precedence, whether a version is in a range, and the highest or lowest version in one.
- **`packages/changes`**: The `changes` command (`npm run changes -- status|check`) and its libraries: change files in `.changes/`, the units and groups in `.changes/config.json`, and the version each release would get. (See [change-files.md](docs/design/change-files.md)).
- **`packages/package-manager`**: The package manager's libraries: records, source archives, fetching, version selection, manifests and workspaces, and the registry's lexicons (`@zena-lang/package-manager`).
- **`packages/pds`**: An AT Protocol PDS written in Zena, ported from pds.js, with managed accounts for the App Views it trusts (`@zena-lang/pds`). (See [pds.md](docs/design/pds.md)).
- **`packages/registry`**: The Zena App View, the package manager's service: the registry methods, the site, and the service that runs them with the PDS (`@zena-lang/registry`). (See [package-manager.md](docs/design/package-manager.md)).
- **`packages/pds-web`**: The stylesheet and script of the App View's web pages, which the App View renders on the server (`packages/registry/src/web`): Radica's design tokens and the few Radica elements the pages use (`@zena-lang/pds-web`).
- **`packages/language-service`**: Language service library, `lsp.zena` / `lsp.wasm`, and the JS API around it (`@zena-lang/language-service`). Published.
- **`packages/zenadoc`**: API documentation extraction — reads a package's source and emits JSON describing its public API (`@zena-lang/zenadoc`). (See [zenadoc.md](docs/design/zenadoc.md)).
- **`packages/codemirror`**: Zena support for CodeMirror 6 (`@zena-lang/codemirror`). Published.
- **`packages/playground`**: The `<zena-playground>` element (`@zena-lang/playground`). Published.
- **`packages/website`** & **`packages/website-client`**: Project website and documentation (`@zena-lang/website`).
- **`packages/vscode-zena`**: VS Code extension providing syntax highlighting and language server client integration.
- **`tests/language/`**: Portable language tests.
- **`docs/language-reference.md`**: Official language reference.
- **`docs/design/`**: Design documents for complex features.
- **`docs/agents/`**: The checks that run on agents' changes, and the loop that adds one when a mistake repeats.
- **`skills/zena/`**: The guide to writing Zena, for agents here (see "Writing Zena") and, installed as a skill, in other projects. `packages/zena-cli/tests/skill_test.zena` compiles its code blocks.
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
  - `--target` / `-t`: `zena-component` (default; WASI 0.3 component with
    `zena:host` imports for `zena-runtime`), `component` (standard WASI 0.3 /
    WIT world component), `js` (core module with `wasm:js-string` and zero
    runtime imports), `zena-js` (core module for `@zena-lang/runtime`), or
    `core` (core module with no host imports beyond `@external`).
  - `--wit <path>`, `--world <name>`: WIT world for `component` and
    `zena-component` builds.
  - `--extension-wit <path>`: An extension's WIT, which the world's views
    of its interfaces are checked against; repeatable, and needs `--wit`
    and `--world` (`docs/design/runtime-components.md`).
  - `--imported-string-constants <module>`: The module `js` and `zena-js`
    builds import string literals from (default `_`; WebAssembly ESM
    integration uses `wasm:js/string-constants`).
  - `--compact-imports`: Group imports by module, and by type within a
    module, in the encodings of the compact import section proposal,
    reordering them to do so. Experimental: V8 reads it behind
    `--experimental-wasm-compact-imports`, and wasmtime does not, so
    component targets reject it.
  - `--time`: Print compiler phase timings.
  - Global flags before subcommand: `-g` / `--debug` (emit WASM name section,
    disable inlining on run, and compile `debug` contract clauses),
    `-O <0|1|2|s>` (optimization level; default `1`).
- **`build [target]`**: Run a build target using `zebra` (e.g.,
  `zena-cli build`, `zena-cli build test`, or
  `zena-cli build ./packages/zebra:test`).
- **`run <file.zena|file.wasm> [-- args...]`** or **`run <target> [-- args...]`**:
  Compile (through the `.zena` compile cache) and run a `.zena`, `.wasm`, or
  `.wat` file (`--dir HOST[::GUEST]`, `--allow-spawn`, `--allow-extensions`,
  `--invoke <fn>`, `--no-cache`, `--time` go before the file; everything after
  it is passed to the program). When the argument is a script or `<path>:<script>`
  target (`zena-cli run test`, `zena-cli run check`, `zena-cli run ./packages/zebra:test`),
  run that target with `zebra` (`-j`, `-w`, `-f` / `--force`, `--no-cache`, `-v`,
  and `-- <args...>`).
- **`test [paths/globs...]`**: With no paths or globs, run the current
  package's `test` target via `zebra` (`zebra.json`, `zena-package.json`, or
  `package.json`), executing declarative `"type": "zena:test"` steps and
  zero-config `zena-package.json` packages in-process (`-j` / `--jobs`,
  `-w` / `--watch`, `--force`, `--no-cache`, `-v` / `--verbose`, and
  `-- <args...>`). With paths, globs, `-f` / `--filter <substring>` (a
  substring of the test file's path), or `--exclude <glob>`, discover and run
  `*_test.zena` files in parallel (also supports `--single`, `-j`, and
  `--no-cache`).
- **`fmt [--write|-w | --check] <files...>`**: Format `.zena` files.
- **`lint [--fix] [--only rules] [--skip rules] <paths...>`**: Report what
  the lint rules (`packages/zena-lint`) find in `.zena` files, as
  `path:line:column: message [rule]`, exiting 1 when there are findings;
  `--fix` rewrites the files, keeping each fix the type checker accepts.
  `--list-rules` prints the rules.
- **`pkg <command>`**: The package commands, under one noun.
  - **`pkg init [dir] [--name <name>] [--scope <scope>]`**: Make the
    current directory, or `dir` (made if need be), a package: write its
    `zena-package.json` with the directory's name, or `--name`, and
    version 0.1.0. It refuses a directory that already has a manifest.
  - **`pkg add <package>[@version] [--name <local>]`**: Add a published
    package, by DID, handle or `scope:name`, to `zena-package.json`, at its
    latest stable release when no version is given (its latest
    pre-release when it has no stable one),
    under `scope:name` for a package in a scope (imports then read
    `'scope:name/library'`); select versions for everything it leads to, pin them in
    `zena-lock.json`, and fetch them. It prints what changed in the
    lockfile, and refuses a pinned release whose CIDs changed at the same
    version unless given `--allow-changed`.
  - **`pkg update [names...]`**: Select versions again without keeping the
    lockfile's pins of the named dependencies, or of any when none is
    named, so each gets the latest version its ranges allow that is not
    retracted; then pin and fetch as `add` does. `add` and `update` take
    `--duplicates allow|warn|error` for a package selected at two
    versions (the root manifest's `"duplicates"` is the default).
  - **`pkg fetch`**: Fetch the published packages `zena-lock.json` pins
    into the package cache, checking each against its pins.
    `ZENA_PLC_DIRECTORY` and `ZENA_DNS_OVER_HTTPS` replace the PLC
    directory and the DNS resolver handles are looked up with.
  - **`pkg login <handle or DID> [--password-stdin]`**: Sign in to an
    atproto account with an app password, from stdin, `ZENA_APP_PASSWORD`
    or the terminal, keeping the session in `$ZENA_CONFIG_DIR/session.json`
    (default `~/.config/zena`), readable only by its owner. **`pkg logout`**
    ends it.
  - **`pkg publish [--scope <name> --yes] [--registry <url>]`**: Publish the
    package you are in at its manifest's `version` to a registry
    (`ZENA_REGISTRY`), creating its account first when it has no `did`, in
    the scope its manifest's `scope` or `--scope` names, with the files its
    `files` patterns name (by default, all but tests). The registry holds
    the release until enough maintainers attest it. **`pkg create`** only
    creates it.
  - **`pkg approve [<package>@]<version> | <scope> | <package> [--yes]`**
    shows a release, or changes to who belongs, waiting for approval and,
    with `--yes`, approves them. **`pkg retract <version> [--reason]`**
    marks a release so that choosing a version skips it.
  - **`pkg admin allow|deny <person>`** and **`pkg admin list`**: who may
    create scopes on a registry that lets only its admins and the accounts
    they list (`APP_VIEW_SCOPE_CREATORS=listed`). Its admins only.
  - **`pkg ci create <scope>/<name>`** makes an automation account for CI
    to publish as, and prints its token, which `pkg publish` calls the
    registry with from `ZENA_REGISTRY_TOKEN`; **`pkg ci token
<scope>/<name>`** replaces it. **`pkg ci retire <scope>/<name>`**
    retires the account: its token stops working, and it gets no other.
  - **`pkg scope create <name> [--yes]`**, **`pkg scope info <scope>`**:
    Create a scope on a registry, with you as its owner, or describe one.
    Publishing never creates a scope. **`pkg scope add|remove <scope>
<person>`** and **`pkg scope maintainers`** change and show its owners
    and publishers; **`pkg scope upgrade <scope> --yes`** makes it an
    organization, whose members **`pkg org add|remove|members`** change and
    show, and **`pkg scope join <scope> <org>`** and **`pkg scope leave`**
    put a scope in an organization and take it out. **`pkg team create|add|remove|delete|members <org>/<team>`** and
    **`pkg owner add|remove|list`** change and show who belongs to a team
    and a package. **`pkg scope settings`**, **`pkg team settings`** and
    **`pkg owner settings`** show and change their thresholds, and **`pkg
scope policy`** the minimums and defaults of a scope's packages. **`pkg
scope profile`** sets a scope's display name, description and website.
- **`doc <path> [-o <out.json>]`**: Extract a package's public API as JSON.
- **`bench <suite.json> [-o <out.json>]`**: Run a benchmark suite.
- **`lsp`**: Run the Zena language server over stdin/stdout.
- **`precompile <file.wasm>`**: Ahead-of-time compile a module to `.cwasm`.

Examples:

```bash
# Compile (cached) and run a Zena program from the repo root
./target/release/zena-cli run main.zena

# Compile to a standalone module (default target: zena-component) and run it
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
in the environment). The test wasms, the portable-execution runner and the
compiler stages built with `-g` keep names, so their stack traces are
readable. Stage A (`build:cli`, built by the bootstrap) has none; for a
readable trap in it, rerun the `build:cli` command with `ZENA_DEBUG_NAMES=1`
and another `-o`. See `docs/design/binary-size.md`.

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

4. **Don't edit or add input files while a Wireit run is going** in the
   same checkout, comments and `tests/language/` files included. A script's
   fingerprint is taken when it starts, so the run can cache output built
   from a mix of old and new files; the compiler also names some functions
   by source offset, so a comment reflow changes its output. Stop the run
   and start it again.

5. **`./target/release/zena-cli` runs `packages/zena-cli/out/zena.wasm`**,
   which only Wireit rebuilds. After switching branches or rebasing, run
   `npm run build -w @zena-lang/zena-cli` (a no-op when it is fresh) before
   treating a failure of the direct command as a compiler bug.

### Declaring inputs

An input wider than what a script reads makes every edit to it rerun that
script and everything after it, so keep inputs to what the script reads:

- **Manifests.** A compile reads every `zena-package.json` in the
  workspace, but its output depends only on the root manifest and the
  manifests of the packages it reaches. List those
  (`../atproto/zena-package.json`), never a glob over all of them.
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
- **TypeScript tests.** A package's `tsc` script compiles its tests too, so
  its `build` depends on the builds of every package the tests import, not
  only the ones its sources import. A missing one passes locally, where
  the other package happens to be built, and fails in CI.

### Zebra's scripts beside wireit's

Every wireit script also exists as a zebra script: in the package's
`zena-package.json` under `scripts`, or in `zebra.json` for a package
without a Zena manifest. The two run side by side until zebra caches in
CI. A change to a script's command, dependencies (`cascade` included),
inputs or outputs in one goes into the other in the same commit. They
differ only where zebra has its own means: a fileset (`../stdlib:lib`,
`../registry:source`) in place of a list of files, or a
`"type": "zena:test"` rule in place of a `zena-cli test ...` command.
`packages/zebra/test/repo-parity_test.zena` checks that the two stay in
sync.

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
  file-reading tool with line-range parameters to inspect it. Don't pipe
  `npm test` into `tail`: the pipeline's exit status is `tail`'s, so a
  failure reads as a pass. Redirect to a file and check the exit status.
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

### Across the codebase

The person reviewing this repository has had to ask for each of these
more than once:

- **Fix or file bugs in Zena; don't work around them.** When the
  compiler, the standard library or a tool gets in the way, fix it on
  its own branch, with a test, and stack the work that needs it on top;
  or file an issue with a reproduction. A workaround that has to stay
  until then names the issue in a comment.
- **Put general code in its general home.** Search the standard library
  before writing a helper, and add a missing utility there (or as a
  method on the type it is about) instead of in the package that first
  needed it. One general code path beats a case per type.
- **Zena has no users yet.** Change the language, the standard library
  and file formats directly. Don't keep compatibility shims, deprecated
  paths or migrations for old code.
- **Write new tools and tests in Zena**, unless they have to run before
  Zena is built (the pre-push check and editor hooks are JavaScript for
  that reason).
- **Key things by what they are.** Don't key a map by a source offset,
  an `i32` id or a name where the object itself, or a typed key, works;
  hidden global state needs a reason too.
- **Name things precisely, without abbreviations.** A Zena source file
  is a _library_; a _module_ is a Wasm module.

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

"Features to reach for" in `skills/zena/SKILL.md` applies here: `let` over
`var`, `for`/`in` over index loops, collection classes over their
interfaces, and the rest of that table. In addition:

- Use enums where appropriate
- Prefer private fields (`#`)
- Use `HashSet`s when needed instead of `HashMap<T, boolean>`
- Use `if` statements instead of a `match()` with one arm.
- Don't put types on functions that can use contextual typing, like callbacks.
- Use JSDoc-style multi-line comments (`/** */`)
- Document classes with their own JSDoc comment; do not use a big comment
  section divider above each class.
- Use template literals when concatenating more than two strings
- Omit an empty constructor (`new();`, `new() {}`): a class whose fields
  all have initializers gets one

### Testing

- New syntax, type-checking, or codegen features and bug fixes should include
  portable tests under `tests/language/` (`syntax/`, `semantics/`, `execution/`).
- New AST nodes in `packages/zena-compiler/zena/lib/ast.zena` must be handled in
  `ast-visitor.zena` and the reachability pass (`zena/lib/codegen/reachability/`).
- Zena unit tests (`*_test.zena`) use `suite`, `test`, and `expect` from
  `zena:test` and can be run directly during iteration with
  `npm run test:quick -- <path>`. A test body may be `async`
  (`test('name', async (ctx) => { ... })`); the runner awaits it before
  the next test.
- For TypeScript tests (`node:test`), isolate a single test with `--test-only`
  and `test.only()`.

### Documentation

When adding or modifying language features, update:

1. `docs/language-reference.md`
2. `packages/website/src/reference/quick-reference.md`
3. `skills/zena/`, when the change affects what it says (see `skills/README.md`)

Design documents live in `docs/design/`. See the directory listing for topics.

All prose — design docs, commit messages, comments — follows
`docs/writing-style.md`. Read it before writing any of these.

## Pull Requests

- **Committing** formats the staged files with prettier (the pre-commit
  hook that `npm ci` installs).
- **Before pushing**, `npm run check` (the pre-push hook runs it): prettier on the changed files CI checks, `zena lint`
  on the changed lines of `.zena` files, type errors in changed libraries
  that their tests would not report (#510), commit subject tags, and words
  that must stay out of this public repository. `npm run check -- --fix`
  formats. Check a PR's title and description the same way by saving
  them to a file and running `npm run check -- --text <file>`.
- **Commit subjects and PR titles** start with the packages they touch:
  `[stdlib] Add String.repeat`, `[pds][zena-cli] ...`, `[docs] ...` for
  documentation alone. PRs are squash-merged, so the title becomes the
  commit on `main`.
- **After pushing**, find out about merges, failing checks and comments
  without being told: subscribe to the PR (`subscribe_pr_activity`) if
  your harness has the tool, or else run `npm run watch-prs -- <numbers>`
  as a background task, which exits when there is something to act on,
  or after 110 minutes with nothing. Act on what it reports (fix the
  failing check, answer the comment, rebase), then start it again while
  any of the PRs are open.
- **Stacked PRs.** Open each PR with `--base` set to the branch below
  it, then make the chain a GitHub stack with
  `gh stack link <bottom PR> ... <top PR>` (the `gh-stack` extension;
  install it with `gh extension install github/gh-stack` where it is
  missing). When a PR in a stack merges, GitHub rebases the PRs above it
  onto `main` and retargets them, squash merges included. Bring your
  branches up to date with `git fetch` and
  `git reset --hard origin/<branch>`, after checking that `git status`
  and `git log origin/<branch>..` show nothing unpushed. Each layer runs
  the full CI, so keep stacks short.

  For a stack that is not linked, rebase by hand as soon as the PR below
  is squash-merged, without waiting to be asked:
  `git rebase --onto origin/main <old tip of the base branch> <branch>`,
  check that `git diff <old tip of your branch> HEAD` shows nothing
  unexpected, run `gh pr edit <n> --base main`, and push with
  `--force-with-lease`.

- Link the issue a PR fixes or advances (`Fixes #n`, `Part of #n`), and
  update the issue when the plan changes.

- `npm run worktrees` lists this repository's worktrees by whether
  removing one could lose work; `-- --remove` removes only merged, idle
  ones, and only when the person asks.

How these checks are maintained, and how a repeated mistake becomes a
new check: `docs/agents/README.md`.
