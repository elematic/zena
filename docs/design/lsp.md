# Zena Language Server / VS Code Integration

## Status: In Progress

## Goals

Provide IDE features for Zena in VS Code, starting with:

1. **Diagnostics** — show type errors and parse errors inline
2. **Go to Definition** — jump to where a symbol is declared
3. **Formatting** — auto-format Zena source files
4. **Hover** — show the type of an identifier on hover

These features exercise the core compiler pipeline (parse → check → query) and
the full VS Code integration path.

## Architecture

### Phase 1: Self-Hosted Compiler via WASM (Current)

The **self-hosted compiler compiled to WASM** runs inside the VS Code extension
host. The bootstrap compiler compiles the self-hosted compiler to a `.wasm`
module; the extension loads and calls it from JavaScript. No separate process,
no LSP protocol overhead.

```
┌─────────────────────────────────────────────────────┐
│  VS Code Extension (vscode-zena)                    │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Extension Host (TypeScript/Node.js)          │  │
│  │                                               │  │
│  │  ┌─────────────────────────────────────────┐  │
│  │  │  lsp.wasm (from @zena-lang/language-     │  │
│  │  │           service)                       │  │
│  │  │                                          │  │
│  │  │  LanguageService                         │  │
│  │  │    ├─ SourceFileCache (parse/scope)      │  │
│  │  │    ├─ Program (immutable snapshot)       │  │
│  │  │    │    ├─ SourceFiles (shared)          │  │
│  │  │    │    ├─ ScopeResults (cached)         │  │
│  │  │    │    └─ CheckResults (on demand)      │  │
│  │  │    └─ Queries (diagnostics, types, defs) │  │
│  │  └─────────────────────────────────────────┘  │
│  │                                               │  │
│  │  ┌─────────────────────────────────────────┐  │
│  │  │  JS Glue (compiler-service.ts)          │  │
│  │  │  • WASM instantiation + string marshal  │  │
│  │  │  • CompilerHost (read_file import)       │  │
│  │  │  • VS Code providers (diagnostics,       │  │
│  │  │    definition, hover, formatting)        │  │
│  │  └─────────────────────────────────────────┘  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Why this approach:**

- Uses the self-hosted compiler from the start — no bootstrap compiler
  dependency in the extension
- WASM runs in-process in the extension host, so no separate process or
  JSON-RPC overhead
- The self-hosted compiler already has parser, scope analysis, and
  SemanticModel with diagnostics, node types, and name resolution
- VS Code's extension API is simpler than implementing the full LSP protocol

**WASM ↔ JS interface:** Strings (source code, file paths, type descriptions)
are passed as WASM GC `externref` values via `$stringCreate`, `$stringSetByte`,
`$stringGetByte`, `$stringGetLength` exports. The `@zena-lang/runtime` package
provides `createStringReader`/`createStringWriter` helpers that wrap these into
ergonomic JS functions. The host provides a `read_file` import so the WASM
compiler can load dependency sources from the filesystem.

### Phase 2: Standalone LSP Server

When the CLI is separated from Node/TypeScript, add a `zena lsp` command that
speaks LSP over stdio. The VS Code extension becomes a thin client. Other
editors (Neovim, Helix, Zed) get support for free.

---

## Current Implementation

### What's Built ✅

**Extension infrastructure** (`packages/vscode-zena/`):

- `extension.cts` — CJS entry point with dynamic ESM import
- `compiler-service.ts` — WASM compiler wrapper: loads `lsp.wasm`,
  marshals strings, exposes `checkDocument()`, `getDefinition()`,
  `formatDocument()`
- `zena-extension.ts` — Extension lifecycle, VS Code event wiring,
  diagnostic collection, definition provider, formatting provider
- Status bar with Zena indicator, output channel for logging

**Language service** (`packages/language-service/`):

- `zena/lsp.zena` — WASM entry point compiled from Zena. Exports `init()`,
  `check()`, `format()`, `getDefinition()`, and diagnostic getter functions.
  Uses the full Compiler pipeline for cross-module import resolution.
- Integration tests exercising diagnostics, formatting, and definition lookup

**Working features:**

- Diagnostics (parse errors, type errors, unresolved names) with source
  locations on document open/change
- Go to definition (identifiers, type annotations, constructors, fields)
  including cross-module jumps
- Document formatting via the zena-formatter
- Multi-file diagnostics (errors in dependencies shown under the dep's URI)

### Current Limitations

The current `lsp.zena` creates a **fresh `Compiler` + `LibraryLoader` on every
`check()` call**. This means:

1. Every keystroke re-reads, re-parses, and re-scope-analyzes the entire
   stdlib (~20+ modules)
2. Only one file can be "active" — `__cachedScopeResult` stores exactly one
   result for `getDefinition()` queries
3. Only the entry module is type-checked, not its dependents
4. No version tracking — redundant work even when nothing changed

---

## Incremental Architecture: Program + SourceFileCache

See `docs/design/self-hosted-compiler.md` **Section 9** for the full design.
Summary of the three key abstractions:

### SourceFileCache

Long-lived, mutable cache of parsed source files. Shared across `Program`
snapshots. Stores `(path, version) → SourceFile` plus the file-local
`ScopeResult` (which depends only on the AST, not on other modules).

Eviction policy: after each edit cycle, entries not in the current `Program`'s
file set are dropped (except stdlib, which is always retained).

### Program (Immutable Snapshot)

An immutable snapshot of the compilation state at a point in time. Created
fresh on each edit; shares `SourceFile`s and `ScopeResult`s via the cache.
`CheckResult`s for unchanged subgraphs are carried forward from the previous
`Program`.

Key properties:

- **On-demand checking** — type-checking is lazy, triggered only when
  `getDiagnostics()` or `getSemanticModel()` is called for a specific file.
- **Export signature comparison** — if a file's exports haven't changed
  (e.g., editing inside a function body), dependents' `CheckResult`s are
  still valid and don't need re-checking.
- **Immutable** — queries always see a consistent snapshot. No interleaved
  mutation issues.

### LanguageService

The stateful orchestrator. Replaces the current module-level globals in
`lsp.zena`. Tracks open files, creates new `Program` snapshots on edits,
delegates queries.

---

## Implementation Plan

### Step 1: Extension Infrastructure ✅ Complete

- CJS entry point, WASM loading, string marshaling, VS Code providers

### Step 2: WASM Entry Point ✅ Complete

- `lsp.zena` compiled to `lsp.wasm` with `init()`, `check()`, `format()`,
  `getDefinition()` exports
- Host `read_file` import for filesystem access

### Step 3: Basic Diagnostics ✅ Complete

- Parse errors, type errors, unresolved names reported with source locations
- Multi-file diagnostics (dependency errors mapped to their file URI)

### Step 4: Go to Definition ✅ Complete

- Byte-offset-based lookup via `ScopeResult.references` and
  `ScopeResult.declarations`
- Cross-module definition jumps (identifiers resolved to dependency symbols)

### Step 5: Document Formatting ✅ Complete

- `format()` export calls zena-formatter, returns formatted source
- VS Code `DocumentFormattingEditProvider` wired up

### Step 6: Persistent LanguageService ← Next

Replace the stateless per-call architecture with persistent state:

1. **Keep `LibraryLoader` alive across calls.** The loader already caches
   `SourceFile`s by path — stop throwing it away between `check()` calls.
   This alone avoids re-parsing the stdlib on every keystroke.

2. **Add version tracking on the JS side.** Track `TextDocument.version` for
   open files. Skip `check()` entirely when the version hasn't changed (e.g.,
   switching tabs back to an already-checked file).

3. **Support multiple open files.** Track all open files instead of caching
   one `ScopeResult`. Each open file gets its own cached results. Closing a
   file clears its entry.

### Step 7: SourceFileCache + Program

Extract the full incremental architecture:

1. **`SourceFileCache`** — extract `LibraryLoader`'s cache into a standalone
   cache keyed by `(path, version)`. Include `ScopeResult` in cache entries.

2. **`Program`** — immutable snapshot with lazy `getCheckResult()`. Carry
   forward `CheckResult`s from the previous `Program` for unchanged files
   whose dependencies haven't changed.

3. **Export signature comparison** — detect when a file's exports are
   identical despite a source change (function body edits). Skip re-checking
   dependents when exports are stable.

### Step 8: Hover Types

1. Map cursor position to a source byte offset
2. `Program.getSemanticModel(path).getNodeType(offset)` → Type
3. `typeToString(type)` → formatted type string
4. Return as `vscode.Hover` with ` ```zena ` code block

### Step 9: Additional Features (Future)

- Find All References
- Document Symbols / Outline
- Completions / IntelliSense
- Rename Symbol
- Code Actions (quick fixes)
- Signature Help
- Semantic Tokens (richer highlighting than TextMate)

---

## File Structure

```
packages/language-service/
  package.json              # Wireit build: TS tests + WASM compilation
  zena/
    lsp.zena                # WASM entry point (LanguageService, exports)
  src/test/
    lsp_test.ts             # Integration tests (load lsp.wasm in Node)
  lsp.wasm                  # Built artifact

packages/vscode-zena/
  package.json              # Extension manifest, Wireit build
  src/
    extension.cts           # CJS entry point (dynamic imports ESM)
    lib/
      compiler-service.ts   # WASM loading, string marshaling, host imports
      zena-extension.ts     # Extension lifecycle, VS Code providers
  lsp.wasm                  # Copied from language-service at build time
  syntaxes/                 # TextMate grammar files
  language-configuration.json
```

---

## Open Questions

- **Multi-root workspaces**: How to handle multiple `zena-packages.json`
  roots? Start with single-root.
- **Stdlib bundling**: Currently resolved via `../stdlib/zena` relative to
  the extension path. Works for development; need a strategy for published
  extension (bundle stdlib sources or rely on npm).
- **Web extension**: Running in VS Code for the Web (vscode.dev) is natural
  since the compiler is already WASM — but the `read_file` host import
  needs shimming for a virtual filesystem.
