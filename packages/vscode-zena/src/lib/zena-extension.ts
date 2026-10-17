import * as vscode from 'vscode';
import {formatError} from '@zena-lang/runtime';
import {ZenaCompilerService} from './compiler-service.js';
import type {LintFindingInfo} from './compiler-service.js';

export const outputChannel = vscode.window.createOutputChannel('Zena');

/**
 * The UTF-16 offset in `source` of a UTF-8 byte offset into it, which is
 * what the service reports and what `TextDocument.positionAt` wants.
 */
function byteToCharOffset(source: string, byteOffset: number): number {
  let bytes = 0;
  let chars = 0;
  for (const ch of source) {
    if (bytes >= byteOffset) break;
    bytes += Buffer.byteLength(ch, 'utf8');
    chars += ch.length;
  }
  return chars;
}

/**
 * Holds the shared state of the Zena extension and manages its lifecycle.
 */
export class ZenaExtension {
  context: vscode.ExtensionContext;
  #compiler: ZenaCompilerService;
  #diagnosticCollection: vscode.DiagnosticCollection;
  #statusBarItem: vscode.StatusBarItem;
  /** The lint findings of each document's last check, by file path. */
  #lintFindings = new Map<string, LintFindingInfo[]>();

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
      outputChannel.appendLine(`Failed to load compiler:\n${formatError(e)}`);
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

    // Lint findings as quick fixes, and one action that fixes them all.
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        'zena',
        {
          provideCodeActions: (document, range) => {
            const findings = this.#findingsFor(document);
            if (findings.length === 0) return [];
            const source = document.getText();
            const actions: vscode.CodeAction[] = [];
            for (const finding of findings) {
              const findingRange = this.#rangeOf(document, source, finding);
              if (
                !findingRange.intersection(range) &&
                !range.contains(findingRange)
              ) {
                continue;
              }
              const action = new vscode.CodeAction(
                `Fix: ${finding.message}`,
                vscode.CodeActionKind.QuickFix,
              );
              action.edit = new vscode.WorkspaceEdit();
              action.edit.replace(
                document.uri,
                findingRange,
                finding.replacement,
              );
              action.diagnostics = (
                this.#diagnosticCollection.get(document.uri) ?? []
              ).filter(
                (d) =>
                  d.source === 'zena-lint' &&
                  d.range.start.isEqual(findingRange.start),
              );
              actions.push(action);
            }
            const all = new vscode.CodeAction(
              'Fix all zena-lint findings',
              vscode.CodeActionKind.SourceFixAll.append('zena'),
            );
            all.edit = this.#fixAllEdit(document, source, findings);
            actions.push(all);
            return actions;
          },
        },
        {
          providedCodeActionKinds: [
            vscode.CodeActionKind.QuickFix,
            vscode.CodeActionKind.SourceFixAll.append('zena'),
          ],
        },
      ),
    );

    // "Zena: Fix lint findings in file" on the active document.
    context.subscriptions.push(
      vscode.commands.registerCommand('zena.fixLint', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'zena') return;
        this.#checkDocument(editor.document);
        const findings = this.#findingsFor(editor.document);
        if (findings.length === 0) {
          vscode.window.showInformationMessage('Zena: nothing to fix.');
          return;
        }
        await vscode.workspace.applyEdit(
          this.#fixAllEdit(
            editor.document,
            editor.document.getText(),
            findings,
          ),
        );
        vscode.window.showInformationMessage(
          `Zena: applied ${findings.length} fix${findings.length === 1 ? '' : 'es'}.`,
        );
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
            if (result.doc) {
              contents.appendMarkdown('\n---\n' + result.doc);
            }
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

      // The lint findings, as warnings beside the checker's diagnostics.
      // The checker's own "unnecessary cast" warning gives way to the
      // lint finding for the same cast, which carries the fix.
      const findings = this.#compiler.lintDocument(path);
      this.#lintFindings.set(path, findings);
      if (findings.length > 0) {
        const own = (this.#diagnosticCollection.get(document.uri) ?? []).filter(
          (d) =>
            !(
              d.message.startsWith('Unnecessary cast') &&
              findings.some((f) =>
                document
                  .positionAt(byteToCharOffset(source, f.start))
                  .isEqual(d.range.start),
              )
            ),
        );
        for (const finding of findings) {
          const range = new vscode.Range(
            document.positionAt(byteToCharOffset(source, finding.start)),
            document.positionAt(byteToCharOffset(source, finding.end)),
          );
          const diagnostic = new vscode.Diagnostic(
            range,
            finding.message,
            vscode.DiagnosticSeverity.Warning,
          );
          diagnostic.source = 'zena-lint';
          diagnostic.code = finding.rule;
          own.push(diagnostic);
        }
        this.#diagnosticCollection.set(document.uri, own);
      }
    } catch (e) {
      const msg = formatError(e);
      outputChannel.appendLine(
        `Check failed for ${document.uri.fsPath}: ${msg}`,
      );
    }
  }

  /** The lint findings of the document's last check. */
  #findingsFor(document: vscode.TextDocument): LintFindingInfo[] {
    return this.#lintFindings.get(document.uri.fsPath) ?? [];
  }

  #rangeOf(
    document: vscode.TextDocument,
    source: string,
    finding: LintFindingInfo,
  ): vscode.Range {
    return new vscode.Range(
      document.positionAt(byteToCharOffset(source, finding.start)),
      document.positionAt(byteToCharOffset(source, finding.end)),
    );
  }

  /**
   * One edit applying every finding. The findings do not overlap, so the
   * edit holds one replacement per finding.
   */
  #fixAllEdit(
    document: vscode.TextDocument,
    source: string,
    findings: LintFindingInfo[],
  ): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    for (const finding of findings) {
      edit.replace(
        document.uri,
        this.#rangeOf(document, source, finding),
        finding.replacement,
      );
    }
    return edit;
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
