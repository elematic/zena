import * as vscode from 'vscode';
import {ZenaCompilerService} from './compiler-service.js';

export const outputChannel = vscode.window.createOutputChannel('Zena');

/** Format an unknown caught value for logging. */
const formatError = (e: unknown): string => {
  if (e instanceof Error) return e.stack ?? e.message;
  if (e != null && typeof e === 'object') {
    const name = e.constructor?.name ?? 'unknown';
    // WebAssembly.Exception has a .stack in V8
    const stack = 'stack' in e ? String((e as {stack: unknown}).stack) : '';
    const message =
      'message' in e ? String((e as {message: unknown}).message) : '';
    return stack || message || `[${name}]`;
  }
  return String(e);
};

/**
 * Holds the shared state of the Zena extension and manages its lifecycle.
 */
export class ZenaExtension {
  context: vscode.ExtensionContext;
  #compiler: ZenaCompilerService;
  #diagnosticCollection: vscode.DiagnosticCollection;
  #statusBarItem: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.#compiler = new ZenaCompilerService(outputChannel);
    this.#diagnosticCollection =
      vscode.languages.createDiagnosticCollection('zena');
    this.#statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.#statusBarItem.command = 'zena.showOutput';
    this.#statusBarItem.text = '$(zap) Zena';
    this.#statusBarItem.tooltip = 'Zena Language Service';
  }

  async activate() {
    outputChannel.appendLine('Activating Zena language extension (v2-format)');

    const {context} = this;

    context.subscriptions.push(this.#diagnosticCollection);
    context.subscriptions.push(this.#statusBarItem);

    context.subscriptions.push(
      vscode.commands.registerCommand('zena.showOutput', () => {
        outputChannel.show();
      }),
    );

    // Show status bar when a Zena file is active.
    const updateStatusBarVisibility = () => {
      if (vscode.window.activeTextEditor?.document.languageId === 'zena') {
        this.#statusBarItem.show();
      } else {
        this.#statusBarItem.hide();
      }
    };
    updateStatusBarVisibility();
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        updateStatusBarVisibility(),
      ),
    );

    // Initialize the WASM compiler.
    try {
      await this.#compiler.initialize(context.extensionPath);
    } catch (e) {
      outputChannel.appendLine(`Failed to load compiler: ${e}`);
      vscode.window.showErrorMessage(
        'Zena: Failed to load compiler. See Output > Zena for details.',
      );
      return;
    }

    // Check the active document on activation.
    if (vscode.window.activeTextEditor?.document.languageId === 'zena') {
      this.#checkDocument(vscode.window.activeTextEditor.document);
    }

    // Re-check on document change.
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'zena') {
          this.#checkDocument(e.document);
        }
      }),
    );

    // Re-check when switching to a Zena file.
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'zena') {
          this.#checkDocument(editor.document);
        }
      }),
    );

    // Clear diagnostics when a document is closed.
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.#diagnosticCollection.delete(doc.uri);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('zena.helloWorld', () => {
        vscode.window.showInformationMessage('Hello from Zena!');
      }),
    );

    // Go to Definition.
    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider('zena', {
        provideDefinition: (document, position) => {
          if (!this.#compiler.isReady) return null;
          try {
            const source = document.getText();
            // Use the start of the word under the cursor so we hit
            // the exact byte offset stored in the ReferenceMap.
            const wordRange = document.getWordRangeAtPosition(position);
            const wordStart = wordRange ? wordRange.start : position;
            const offset = Buffer.byteLength(
              source.slice(0, document.offsetAt(wordStart)),
              'utf8',
            );
            outputChannel.appendLine(
              `Go to definition: offset=${offset} pos=${position.line}:${position.character}`,
            );
            const result = this.#compiler.getDefinition(
              document.uri.fsPath,
              offset,
            );
            if (!result) return null;
            const uri = vscode.Uri.file(result.file);
            // Convert 1-based line/column to 0-based for VS Code.
            const pos = new vscode.Position(
              Math.max(0, result.line - 1),
              Math.max(0, result.column - 1),
            );
            const originRange =
              wordRange ?? new vscode.Range(position, position);
            return [
              {
                originSelectionRange: originRange,
                targetUri: uri,
                targetRange: new vscode.Range(pos, pos),
                targetSelectionRange: new vscode.Range(pos, pos),
              } satisfies vscode.LocationLink,
            ];
          } catch (e) {
            const msg = formatError(e);
            outputChannel.appendLine(`Go to definition failed: ${msg}`);
            return null;
          }
        },
      }),
    );

    // Hover.
    context.subscriptions.push(
      vscode.languages.registerHoverProvider('zena', {
        provideHover: (document, position) => {
          if (!this.#compiler.isReady) return null;
          try {
            const source = document.getText();
            const wordRange = document.getWordRangeAtPosition(position);
            const wordStart = wordRange ? wordRange.start : position;
            const offset = Buffer.byteLength(
              source.slice(0, document.offsetAt(wordStart)),
              'utf8',
            );
            const result = this.#compiler.getHover(document.uri.fsPath, offset);
            if (!result) return null;

            const contents = new vscode.MarkdownString();
            contents.appendCodeblock(result.label, 'zena');
            return new vscode.Hover(contents, wordRange);
          } catch (e) {
            const msg = formatError(e);
            outputChannel.appendLine(`Hover failed: ${msg}`);
            return null;
          }
        },
      }),
    );

    // Document formatting.
    context.subscriptions.push(
      vscode.languages.registerDocumentFormattingEditProvider('zena', {
        provideDocumentFormattingEdits: (document) => {
          outputChannel.appendLine(
            `Format requested for ${document.uri.fsPath}`,
          );
          if (!this.#compiler.isReady) {
            outputChannel.appendLine('Format skipped: compiler not ready');
            return [];
          }
          try {
            const source = document.getText();
            const formatted = this.#compiler.formatDocument(source);
            if (formatted === null) {
              this.#setStatusBarError('Format error');
              return [];
            }
            if (formatted === source) {
              this.#setStatusBarOk();
              return [];
            }
            outputChannel.appendLine(
              `Format: applying changes (${source.length} → ${formatted.length} bytes)`,
            );
            this.#setStatusBarOk();
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(source.length),
            );
            return [vscode.TextEdit.replace(fullRange, formatted)];
          } catch (e) {
            const msg = formatError(e);
            outputChannel.appendLine(`Format failed: ${msg}`);
            this.#setStatusBarError('Format error');
            return [];
          }
        },
      }),
    );

    // Document symbols / outline.
    context.subscriptions.push(
      vscode.languages.registerDocumentSymbolProvider('zena', {
        provideDocumentSymbols: (document) => {
          if (!this.#compiler.isReady) return [];
          try {
            const source = document.getText();
            const path = document.uri.fsPath;
            const symbols = this.#compiler.getDocumentSymbols(path, source);

            const toDocumentSymbol = (
              info: import('./compiler-service.js').DocumentSymbolInfo,
            ): vscode.DocumentSymbol => {
              const range = new vscode.Range(
                document.positionAt(info.start),
                document.positionAt(info.end),
              );
              const selRange = new vscode.Range(
                document.positionAt(info.selStart),
                document.positionAt(info.selEnd),
              );
              const sym = new vscode.DocumentSymbol(
                info.name,
                '',
                info.kind as vscode.SymbolKind,
                range,
                selRange,
              );
              sym.children = info.children.map(toDocumentSymbol);
              return sym;
            };

            return symbols.map(toDocumentSymbol);
          } catch (e) {
            const msg = formatError(e);
            outputChannel.appendLine(`Document symbols failed: ${msg}`);
            return [];
          }
        },
      }),
    );
  }

  #checkDocument(document: vscode.TextDocument) {
    if (!this.#compiler.isReady) return;

    try {
      const source = document.getText();
      const path = document.uri.fsPath;
      const byFile = this.#compiler.checkDocument(source, path);

      // Clear previous diagnostics for the entry file (always present).
      this.#diagnosticCollection.set(document.uri, []);

      // Set diagnostics per file.
      for (const [filePath, diagnostics] of byFile) {
        const uri = vscode.Uri.file(filePath);
        this.#diagnosticCollection.set(uri, diagnostics);
      }
    } catch (e) {
      const msg = formatError(e);
      outputChannel.appendLine(
        `Check failed for ${document.uri.fsPath}: ${msg}`,
      );
    }
  }

  #setStatusBarOk() {
    this.#statusBarItem.text = '$(zap) Zena';
    this.#statusBarItem.backgroundColor = undefined;
    this.#statusBarItem.tooltip = 'Zena Language Service';
  }

  #setStatusBarError(tooltip: string) {
    this.#statusBarItem.text = '$(zap) Zena';
    this.#statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground',
    );
    this.#statusBarItem.tooltip = `${tooltip} — click to view logs`;
  }

  async deactivate() {
    outputChannel.appendLine('Deactivating Zena language extension');
    this.#diagnosticCollection.clear();
  }
}
