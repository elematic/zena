# Zena Language Server / VS Code Integration

## Status: Design

## Goals

Provide IDE features for Zena in VS Code, starting with:

1. **Diagnostics** — show type errors and parse errors inline
2. **Hover** — show the type of an identifier on hover
3. **Go to Definition** — jump to where a symbol is declared

These three features are the minimum viable starting point. They exercise the
core compiler pipeline (parse → check → query) and the full VS Code
integration path.

## Architecture

### Phase 1: Self-Hosted Compiler via WASM (Current Plan)

Run the **self-hosted compiler compiled to WASM** inside the VS Code extension
host. The bootstrap compiler compiles the self-hosted compiler to a `.wasm`
module; the extension loads and calls it from JavaScript. No separate process,
no LSP protocol overhead.

```
┌─────────────────────────────────────────────┐
│  VS Code Extension (vscode-zena)            │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  Extension Host (TypeScript/Node.js)  │  │
│  │                                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  Self-hosted compiler (.wasm)   │  │  │
│  │  │  (@zena-lang/zena-compiler)     │  │  │
│  │  │                                 │  │  │
│  │  │  Parser → Scope Analysis        │  │  │
│  │  │       → SemanticModel           │  │  │
│  │  │       → Diagnostics             │  │  │
│  │  │       → Types                   │  │  │
│  │  └─────────────────────────────────┘  │  │
│  │                                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  JS Glue / Language Service     │  │  │
│  │  │  (thin adapter layer)           │  │  │
│  │  │                                 │  │  │
│  │  │  • WASM instantiation           │  │  │
│  │  │  • CompilerHost (file I/O)      │  │  │
│  │  │  • VS Code providers            │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**Why this approach:**

- Uses the self-hosted compiler from the start — no bootstrap compiler
  dependency in the extension
- WASM runs in-process in the extension host, so no separate process or
  JSON-RPC overhead
- The self-hosted compiler already has parser, scope analysis, and
  SemanticModel with diagnostics, node types, and name resolution
- LSP-like query capabilities can be added directly to the self-hosted
  compiler as needed
- VS Code's extension API is simpler than implementing the full LSP protocol

**What needs to happen in the self-hosted compiler:**

- Expose an API that can be called from JS via WASM imports/exports
- The CompilerHost interface (file resolution and loading) is provided by the
  JS side as WASM imports
- Query results (diagnostics, types, resolved bindings) are returned to JS
  via exports or shared memory

### Phase 2: Standalone LSP Server

When the CLI is separated from Node/TypeScript, add a `zena lsp` command that
speaks LSP over stdio. The VS Code extension becomes a thin client. Other
editors (Neovim, Helix, Zed) get support for free.

## Implementation Plan

### Step 1: Extension Infrastructure ✅

Convert vscode-zena from a pure grammar extension to a programmatic extension:

- Add `src/extension.cts` CJS entry point with dynamic ESM import
- Add `src/lib/zena-extension.ts` with `activate()` / `deactivate()`
- Add `main` field to `package.json` pointing to `./extension.cjs`
- Add Wireit build, tsconfig, VS Code launch config

### Step 2: WASM Compilation Target for Self-Hosted Compiler

Build the self-hosted compiler to a `.wasm` module that exposes an API
callable from JS:

- Define WASM exports for: parse, check, query diagnostics, query types
- Define WASM imports for CompilerHost (resolve, load) provided by JS
- Build script that produces the `.wasm` artifact

### Step 3: JS Glue Layer

Wire the WASM compiler into the extension:

- Load and instantiate the `.wasm` module in the extension host
- Implement CompilerHost as WASM imports (reading from VS Code's document
  model for open files, disk for others)
- Stdlib resolution (bundled or from workspace `node_modules`)

### Step 4: Diagnostics

The simplest feature — direct mapping from compiler diagnostics to VS Code:

- After parse/check, read diagnostics from the self-hosted compiler
- Map `DiagnosticLocation` → `vscode.Range` (1-based → 0-based)
- Map `DiagnosticSeverity` → `vscode.DiagnosticSeverity`
- Publish via `vscode.languages.createDiagnosticCollection('zena')`
- Re-run on document open/change (debounced)

### Step 5: Hover Types

1. Map cursor position to a source offset
2. Call into the WASM compiler to find the node at that offset and its type
3. Format the type as a string
4. Return as `vscode.Hover` with markdown code block

The self-hosted compiler's `SemanticModel` already has `getNodeType()` keyed
by source offset — this maps naturally to hover queries.

### Step 6: Go to Definition

1. Map cursor position to a source offset
2. Call into the WASM compiler to resolve the identifier at that offset
3. `SemanticModel.resolve(node)` returns a `SymbolInfo` with the declaration
4. The declaration node has `loc` (file, line, column)
5. Return as `vscode.Location`

### Step 7: Document Management

For performance, maintain a per-workspace compiler state and recompile
incrementally:

- On file open/change: re-parse the changed module, re-check
- Cache modules that haven't changed
- Debounce recompilation (e.g., 300ms after last keystroke)

## File Structure

```
packages/vscode-zena/
  package.json            # Updated with main, activationEvents, wireit build
  tsconfig.json           # CTS → CJS entry point + ESM lib
  src/
    extension.cts         # CJS entry point (dynamic imports ESM)
    lib/
      zena-extension.ts   # Extension lifecycle
      # Future:
      # wasm-compiler.ts  # WASM loading and instantiation
      # providers.ts      # VS Code HoverProvider, DefinitionProvider, etc.
  syntaxes/               # Existing grammar files
  language-configuration.json  # Existing
```

## Open Questions

- **WASM ↔ JS interface**: How to efficiently pass strings (source code,
  file paths, type descriptions) between JS and the WASM compiler. Options:
  shared linear memory with string encoding, or component model.
- **Incremental checking**: For large projects, we'll want to only re-check
  changed modules and their dependents. Start with full recompilation.
- **Multi-root workspaces**: How to handle multiple `zena-packages.json`
  roots? Start with single-root.
- **Stdlib bundling**: The extension needs access to stdlib source files.
  Bundle them or rely on the npm package. Since the self-hosted compiler
  already handles stdlib loading, this may be straightforward.
- **Web extension**: Running in VS Code for the Web (vscode.dev) is natural
  since the compiler is already WASM — but WASI imports may need shimming.

## Future Features (Not in Scope Now)

- Completions / IntelliSense
- Find All References
- Rename Symbol
- Code Actions (quick fixes)
- Signature Help
- Document Symbols / Outline
- Semantic Tokens (richer highlighting than TextMate)
- Workspace Symbols
- Formatting (via zena-formatter)
