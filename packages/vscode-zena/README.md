# Zena Language Support for Visual Studio Code

Language support for the [Zena](https://zena-lang.dev) programming language in Visual Studio Code Desktop and `vscode.dev`.

## Features

- **Diagnostics**: Type checking and syntax diagnostics powered by Zena's self-hosted WebAssembly language service (`lsp.wasm`).
- **Linting & Quick Fixes**: Inline `zena-lint` warnings with per-finding quick fixes, Fix All, and the `Zena: Fix lint findings in file` command.
- **Navigation**: Go to Definition across workspace modules and read-only bundled `zena:*` standard library modules, plus document symbol outlines.
- **Hover & Completions**: Hover type signatures and doc comments, plus member, local, built-in, and keyword completions.
- **Formatting**: Whole-document formatting via `Format Document`.
- **Syntax Highlighting**: TextMate grammars for `.zena` source files and fenced `zena` blocks in Markdown.

## Installation

### From a Release VSIX

Download `vscode-zena.vsix` from [zena-lang.dev/releases](https://zena-lang.dev/releases/) or the latest [GitHub Release](https://github.com/elematic/zena/releases) and install it:

```sh
code --install-extension vscode-zena.vsix
```

Or open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run **Extensions: Install from VSIX...**, and select the downloaded `.vsix` file.

### Development

1. Open the `zena` repository root in VS Code.
2. Press **F5** (**Run → Start Debugging**) and choose **Run Zena Extension**.
3. VS Code runs the Wireit watch build and opens an Extension Development Host window with `vscode-zena` loaded.
4. To package and install locally from the repository root:
   ```sh
   npm run install-ext -w vscode-zena
   ```

## License

MIT
