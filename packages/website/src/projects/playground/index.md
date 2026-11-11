---
title: 'WebAssembly Playground'
description: 'An embeddable browser playground evolving from Zena into a language-agnostic WebAssembly IDE with pluggable build workers, LSP, and preview.'
status: 'In progress'
statusType: 'warning'
lead: 'Starting as the Zena playground, this project is growing into a general WebAssembly playground driven by a standard build worker, language server, console output, and preview protocol that any Wasm-compiled toolchain can plug into.'
---

You can try the current Zena playground today at [`/playground/`](/playground/),
as well as inside interactive code samples embedded across the documentation and
blog.

Most language playgrounds are built as one-off web apps coupled to a single
compiler's JavaScript API, or they send source code to a remote backend container
to compile and execute. Because WebAssembly compilers, language servers, and
build tools can themselves compile to WebAssembly, an entire multi-file IDE loop
can run locally inside browser workers with zero server round-trips. We are
evolving `@zena-lang/playground` so that the UI shell, editor, console, and
preview sandbox are reusable by any language that speaks a shared worker
protocol.

## Current browser architecture

Today `@zena-lang/playground` ships as standalone custom elements
(`<zena-playground>`, `<zena-example-playground>`, and `<zena-preview>`) built
with Lit and CodeMirror 6:

- **Self-hosted Wasm language service in a Web Worker** — Zena's language server
  and compiler (`lsp.wasm`, compiled from Zena to Wasm GC) run off the main
  thread inside `compiler-worker.js` with the standard library bundled in memory.
- **Live editor intelligence** — As you type across multiple virtual files, the
  worker incrementally type-checks the workspace and returns inline diagnostics,
  hover types, go-to-definition targets, and completions to CodeMirror 6.
- **In-browser compilation and execution** — Running a program compiles the
  workspace to `.wasm` bytes inside the worker, instantiates the resulting
  module with host console and error hooks, and streams structured output and
  source-mapped locations back to the output pane.

## Sandboxed multi-file preview

Beyond console programs, WebAssembly projects often produce interactive web UIs
combining `.html`, `.css`, `.js`, and `.wasm` artifacts (for example, components
using [Wasm Web UI](/projects/wasm-web-ui/) or Canvas/WebGPU canvases).

`<zena-preview>` serves multi-file build outputs entirely in the browser without
a backend file server:

- **Cross-origin preview isolation** — Preview content renders inside a
  dedicated preview origin so user scripts and compiled Wasm modules cannot read
  the parent documentation site's storage or DOM.
- **Service Worker virtual filesystem** — A Service Worker registered on the
  preview origin intercepts HTTP requests for `.html`, `.js`, `.css`, and
  `.wasm` paths and fulfills them over `MessagePort` from the playground's
  in-memory build artifact map, complete with proper `application/wasm` MIME
  types for streaming compilation.

## Pluggable compiler, LSP, and console protocol

Nothing about multi-tab editing, diagnostic squiggles, `.wasm` inspection,
structured console output, or Service Worker preview is specific to Zena. To
turn the playground into a general WebAssembly playground, we are separating the
host UI from Zena's compiler behind three explicit worker protocols:

1. **Build worker protocol** — Synchronizes virtual workspace files (`create`,
   `update`, `delete`), triggers single-file or multi-package builds (including
   build graphs driven by [Zebra](/projects/zebra/)'s `zena:workflow` engine),
   and emits named output artifacts (`.wasm` binaries, generated JS bindings,
   WAT disassembly, and source maps) alongside structured build diagnostics.
2. **Language Server Protocol (LSP) over `MessagePort`** — Standardizes editor
   requests (diagnostics, hover, completions, formatting, and navigation) on
   JSON-RPC / LSP messages over browser `MessagePort` channels so any Wasm
   language server—Rust, C/C++, Go, Zig, AssemblyScript, WAT, or Zena—attaches
   to the same CodeMirror frontend.
3. **Console and runtime output protocol** — Captures `stdout`/`stderr` streams,
   structured log values, benchmark timings, formatted Wasm traps, and preview
   reload events from execution workers in a uniform event stream.

With those boundaries in place, a compiler author can publish a worker bundle
pointing at their `.wasm` toolchain—or compose components compiled by two
different languages in a single multi-file workspace—without rebuilding an
editor and sandbox UI from scratch.

## Current status and roadmap

`@zena-lang/playground` is live on [`zena-lang.dev/playground/`](/playground/)
and published in the monorepo with multi-file tabs, worker-based Zena compilation
and LSP features, console execution, and `<zena-preview>` Service Worker
sandboxing.

Planned work includes:

- Extracting and documenting the language-agnostic build worker, LSP, and
  console output protocol specifications.
- Decoupling Zena-specific syntax configuration and worker bootstrap into a
  pluggable language pack alongside WAT and other WebAssembly toolchains.
- Binary inspection views (exported/imported WIT interfaces, section sizes, and
  WAT disassembly) for any compiled `.wasm` artifact.
- Shareable multi-file workspace permalinks and embeddable configuration presets.

→ Try it: [Playground](/playground/) ·
Source: [`packages/playground`](https://github.com/elematic/zena/tree/main/packages/playground) ·
Design: [`docs/design/playground-preview.md`](https://github.com/elematic/zena/blob/main/docs/design/playground-preview.md)
