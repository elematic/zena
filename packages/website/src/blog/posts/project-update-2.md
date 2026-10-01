---
title: 'Zena Project Update #2: Self-Hosted CLI, Language Server, WASI 0.3, and Ranges'
description: 'Our second project update covers moving the zena command line into Zena itself, adding the stdio language server (zena lsp), adopting WASI 0.3, range iteration and slicing, and compiler bug fixes.'
date: 2026-10-01T15:00:00Z
author: justinfagnani
tags:
  - updates
hero:
  image: '/images/blog/isawred-AGQZprOABgQ-unsplash.jpg'
  alt: 'A close-up of a control panel'
  credit: 'Photo by iSawRed on Unsplash'
---

Welcome to **Zena Project Update #2**.

Following last week's update, this post covers development since September 25:
rewriting the `zena` CLI in Zena, adding a standard I/O language server,
migrating to WASI 0.3, supporting range iteration and array slicing, and landing
a set of compiler and type checker fixes.

## 1. Self-Hosted CLI (`zena`)

The `zena` command-line tool is now a Zena program
(`packages/zena-cli/zena/main.zena`) compiled to WebAssembly. The native
`zena-cli` executable is a thin Rust host (~100 lines) that configures
filesystem preopens, enables process spawning, and calls `main`.

The CLI module links the compiler, build orchestrator (`zb`), doc generator
(`zenadoc`), and code formatter (`zena-formatter`) in-process:

- **`zena build`**: Compiles Zena modules in-process using `compileFile`. Wireit
  targets can be run via `zena build <target>` with `zb`.
- **`zena run`**: Compiles and executes programs with `zena:wasm`. Compilation
  results are cached in Zena, tracking imported file sizes and modification
  times to invalidate stale builds.
- **`zena test`**: Discovers test files with `zena:fs` and executes them
  concurrently across spawned instances of the CLI module via `zena:wasm`.
- **`zena fmt`**: Formats files with the Zena code formatter, supporting direct
  stdout printing, in-place formatting with `--write`, and verification with
  `--check`.
- **`zena bench`**: Runs benchmark suites configured through `zena:bench`.

## 2. Language Server over stdio (`zena lsp`)

The CLI now provides a Language Server Protocol server via `zena lsp`,
communicating over standard I/O for editor integrations.

Analysis logic was split into `@zena-lang/language-service`, allowing `zena lsp`
and the browser playground to share the same diagnostic and completion
implementation. In addition, syntax errors are now emitted as structured
diagnostics with file and source span locations.

## 3. Ranges and Slicing

Ranges now implement the `Iterable` protocol, enabling iteration in `for-in`
loops:

```zena
for (let i in 0..10) {
  print(i);
}
```

In addition, `Array<T>` now supports slicing via ranges:

```zena
let numbers = [0, 1, 2, 3, 4, 5];
let middle = numbers[2..4]; // [2, 3]
let tail = numbers[3..];    // [3, 4, 5]
```

## 4. WASI 0.3 and Component Model

- **WASI 0.3**: Moved component runtime imports and standard library integration
  to WASI 0.3. Component binaries are smaller due to allocator simplification
  (removing the pointer map) and a leaner event loop.
- **Resource destructors**: The compiler and WIT parser now generate and
  register destructors for resources that guest components provide.
- **Parameter spilling**: Added Canonical ABI parameter spilling for functions
  whose signatures exceed core-value thresholds (16 values for synchronous
  functions, 4 for asynchronous functions), packing spilled arguments into
  memory buffers.
- **Synchronous export components**: Components exporting only synchronous
  functions can omit asynchronous event loop machinery.

## 5. Standard Library Additions

- **Scoped cancellation**: Moved the `.cancel()` capability from `CancelScope`
  to `TaskGroup`. `CancelScope` is now a read-only token (`isCancelled`),
  preventing child tasks from cancelling parent scopes.
- **`zena:json`**: Added decoding for Unicode escapes (`\uXXXX`), `\b`, and
  `\f`, path-based property lookups on `JsonObject`, and serialization support
  for parsed JSON trees.
- **`zena:cli` and `zena:process`**: Added standard input reading via `zena:cli`
  and standard input writing for child processes via `zena:process`.
- **`zena:js`**: Added `toPromise()`, converting a Zena future into a JavaScript
  promise in JS environments.
- **`String`**: Added public `indexOf`, `trim()`, and `StringReader`.

## 6. Compiler and Type System Fixes

Several bug fixes landed across the compiler and type system:

- **Interface overloads**: Added support for overloaded methods and operators on
  interfaces, including read-by-index `[]` slot resolution.
- **Mixin resolution**: Resolved method lookups for mixins applied through other
  mixins.
- **Array literal typing**: Mixed element types in array literals now infer
  common union types.
- **Expression body adaptation**: Expression body values now adapt to match
  declared return types.
- **Async main rooting**: Rooted the asynchronous runtime driver for `void`
  async `main` entry points in declared worlds.
- **Dead vtable slot pruning**: Retained method table slots only when a call
  site can dispatch through them.
- **Single-comparison loop exits**: Lowered loop condition exits to a single
  comparison.
- **Negative enum members**: Added support for negative integer values in enum
  members.
