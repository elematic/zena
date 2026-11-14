# Changelog

## 0.1.0

- Bundle `lsp.wasm`, `@zena-lang/language-service`, `@zena-lang/runtime`, and the Zena standard library into a standalone extension with no external runtime dependencies.
- Support both VS Code Desktop and VS Code for the Web (`vscode.dev` / `github.dev`).
- Provide real-time type checking, `zena-lint` diagnostics and quick fixes, document formatting, hover types and doc comments, completions, document outline symbols, and Go to Definition across workspace and bundled `zena:*` standard library modules.
- Include TextMate syntax highlighting for `.zena` files and Markdown fenced `zena` code blocks.
