import * as vscode from 'vscode';
import {formatError} from '@zena-lang/runtime';
import {
  getStdlibContent,
  STDLIB_SCHEME,
  uriForCompilerPath,
  ZenaCompilerService,
  type DocumentSymbolInfo,
  type LintFindingInfo,
} from './compiler-service.js';

export const outputChannel = vscode.window.createOutputChannel('Zena');

/**
 * Converts 1-based LSP `SymbolKind` values emitted by `lsp.wasm` to 0-based
 * `vscode.SymbolKind` values.
 */
function toVsCodeSymbolKind(lspKind: number): vscode.SymbolKind {
  switch (lspKind) {
    case 5:
      return vscode.SymbolKind.Class;
    case 6:
      return vscode.SymbolKind.Method;
    case 7:
    case 8:
      return vscode.SymbolKind.Property;
    case 9:
      return vscode.SymbolKind.Constructor;
    case 10:
      return vscode.SymbolKind.Enum;
    case 11:
      return vscode.SymbolKind.Interface;
    case 12:
      return vscode.SymbolKind.Function;
    case 13:
      return vscode.SymbolKind.Variable;
    case 22:
      return vscode.SymbolKind.EnumMember;
    default:
      return Math.max(0, lspKind - 1) as vscode.SymbolKind;
  }
}

/**
 * Converts 1-based LSP `CompletionItemKind` values emitted by `lsp.wasm` to
 * 0-based `vscode.CompletionItemKind` values.
 */
function toVsCodeCompletionKind(lspKind: number): vscode.CompletionItemKind {
  switch (lspKind) {
    case 2:
      return vscode.CompletionItemKind.Method;
    case 3:
      return vscode.CompletionItemKind.Function;
    case 6:
      return vscode.CompletionItemKind.Variable;
    case 7:
      return vscode.CompletionItemKind.Class;
    case 14:
      return vscode.CompletionItemKind.Keyword;
    default:
      return Math.max(0, lspKind - 1) as vscode.CompletionItemKind;
  }
}

/**
 * Holds the shared state of the Zena extension and manages its lifecycle.
 */
export class ZenaExtension {
  context: vscode.ExtensionContext;
  #compiler: ZenaCompilerService;
  #diagnosticCollection: vscode.DiagnosticCollection;
  #statusBarItem: vscode.StatusBarItem;
  /** The lint findings of each document's last check, keyed by `uri.path`. */
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

  async activate(): Promise<void> {
    outputChannel.appendLine('Activating Zena language extension');

    const {context} = this;

    context.subscriptions.push(this.#diagnosticCollection);
    context.subscriptions.push(this.#statusBarItem);

    // Virtual read-only documents for bundled `zena:*` standard library files.
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(STDLIB_SCHEME, {
        provideTextDocumentContent: (uri) => getStdlibContent(uri.path) ?? '',
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('zena.showOutput', () => {
        outputChannel.show();
      }),
    );

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

    try {
      await this.#compiler.initialize(context.extensionUri);
    } catch (e) {
      outputChannel.appendLine(`Failed to load compiler:\n${formatError(e)}`);
      vscode.window.showErrorMessage(
        'Zena: Failed to load compiler. See Output > Zena for details.',
      );
      return;
    }

    if (vscode.window.activeTextEditor?.document.languageId === 'zena') {
      void this.#checkDocument(vscode.window.activeTextEditor.document);
    }

    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.languageId === 'zena' && doc.uri.scheme !== STDLIB_SCHEME) {
          void this.#checkDocument(doc);
        }
      }),
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          e.document.languageId === 'zena' &&
          e.document.uri.scheme !== STDLIB_SCHEME
        ) {
          void this.#checkDocument(e.document);
        }
      }),
    );

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (
          editor?.document.languageId === 'zena' &&
          editor.document.uri.scheme !== STDLIB_SCHEME
        ) {
          void this.#checkDocument(editor.document);
        }
      }),
    );

    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.#diagnosticCollection.delete(doc.uri);
        this.#lintFindings.delete(doc.uri.path);
        this.#compiler.closeDocument(doc.uri.path);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('zena.helloWorld', () => {
        vscode.window.showInformationMessage('Hello from Zena!');
      }),
    );

    // Lint findings as quick fixes, plus Fix All.
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        'zena',
        {
          provideCodeActions: (document, range) => {
            const findings = this.#findingsFor(document);
            if (findings.length === 0) return [];
            const actions: vscode.CodeAction[] = [];
            for (const finding of findings) {
              if (finding.shared) continue;
              const findingRange = this.#rangeOf(document, finding);
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
              action.edit = this.#fixAllEdit(document, [
                finding,
                ...findings.filter((f) => f.shared && f.rule === finding.rule),
              ]);
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
            all.edit = this.#fixAllEdit(document, findings);
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

    context.subscriptions.push(
      vscode.commands.registerCommand('zena.fixLint', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'zena') return;
        await this.#checkDocument(editor.document);
        const findings = this.#findingsFor(editor.document);
        const count = findings.filter((f) => !f.shared).length;
        if (count === 0) {
          vscode.window.showInformationMessage('Zena: nothing to fix.');
          return;
        }
        await vscode.workspace.applyEdit(
          this.#fixAllEdit(editor.document, findings),
        );
        vscode.window.showInformationMessage(
          `Zena: applied ${count} fix${count === 1 ? '' : 'es'}.`,
        );
      }),
    );

    // Go to Definition (workspace files + `zena-stdlib:` virtual files).
    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider('zena', {
        provideDefinition: async (document, position) => {
          if (!this.#compiler.isReady) return null;
          try {
            const source = document.getText();
            const wordRange = document.getWordRangeAtPosition(position);
            const wordStart = wordRange ? wordRange.start : position;
            const offset = document.offsetAt(wordStart);
            const result = await this.#compiler.getDefinition(
              document.uri,
              offset,
              source,
            );
            if (!result) return null;
            const targetUri = uriForCompilerPath(result.file, document.uri);
            const pos = new vscode.Position(
              Math.max(0, result.line - 1),
              Math.max(0, result.column - 1),
            );
            const originRange =
              wordRange ?? new vscode.Range(position, position);
            return [
              {
                originSelectionRange: originRange,
                targetUri,
                targetRange: new vscode.Range(pos, pos),
                targetSelectionRange: new vscode.Range(pos, pos),
              } satisfies vscode.LocationLink,
            ];
          } catch (e) {
            outputChannel.appendLine(
              `Go to definition failed: ${formatError(e)}`,
            );
            return null;
          }
        },
      }),
    );

    // Hover.
    context.subscriptions.push(
      vscode.languages.registerHoverProvider('zena', {
        provideHover: async (document, position) => {
          if (!this.#compiler.isReady) return null;
          try {
            const source = document.getText();
            const wordRange = document.getWordRangeAtPosition(position);
            const wordStart = wordRange ? wordRange.start : position;
            const offset = document.offsetAt(wordStart);
            const result = await this.#compiler.getHover(
              document.uri,
              offset,
              source,
            );
            if (!result) return null;

            const contents = new vscode.MarkdownString();
            contents.appendCodeblock(result.label || result.type, 'zena');
            if (result.doc) {
              contents.appendMarkdown('\n---\n' + result.doc);
            }
            return new vscode.Hover(contents, wordRange);
          } catch (e) {
            outputChannel.appendLine(`Hover failed: ${formatError(e)}`);
            return null;
          }
        },
      }),
    );

    // Completions.
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        'zena',
        {
          provideCompletionItems: async (document, position) => {
            if (!this.#compiler.isReady) return [];
            try {
              const source = document.getText();
              const offset = document.offsetAt(position);
              const items = await this.#compiler.getCompletions(
                document.uri,
                offset,
                source,
              );
              return items.map((info) => {
                const item = new vscode.CompletionItem(
                  info.label,
                  toVsCodeCompletionKind(info.kind),
                );
                if (info.detail) {
                  item.detail = info.detail;
                }
                if (info.doc) {
                  const md = new vscode.MarkdownString();
                  md.appendMarkdown(info.doc);
                  item.documentation = md;
                }
                return item;
              });
            } catch (e) {
              outputChannel.appendLine(`Completions failed: ${formatError(e)}`);
              return [];
            }
          },
        },
        '.',
      ),
    );

    // Document formatting.
    context.subscriptions.push(
      vscode.languages.registerDocumentFormattingEditProvider('zena', {
        provideDocumentFormattingEdits: (document) => {
          if (!this.#compiler.isReady) {
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
            this.#setStatusBarOk();
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(source.length),
            );
            return [vscode.TextEdit.replace(fullRange, formatted)];
          } catch (e) {
            outputChannel.appendLine(`Format failed: ${formatError(e)}`);
            this.#setStatusBarError('Format error');
            return [];
          }
        },
      }),
    );

    // Document symbols / outline.
    context.subscriptions.push(
      vscode.languages.registerDocumentSymbolProvider('zena', {
        provideDocumentSymbols: async (document) => {
          if (!this.#compiler.isReady) return [];
          try {
            const source = document.getText();
            const symbols = await this.#compiler.getDocumentSymbols(
              document.uri,
              source,
            );

            const toDocumentSymbol = (
              info: DocumentSymbolInfo,
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
                toVsCodeSymbolKind(info.kind),
                range,
                selRange,
              );
              sym.children = info.children.map(toDocumentSymbol);
              return sym;
            };

            return symbols.map(toDocumentSymbol);
          } catch (e) {
            outputChannel.appendLine(
              `Document symbols failed: ${formatError(e)}`,
            );
            return [];
          }
        },
      }),
    );
  }

  async #checkDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.#compiler.isReady || document.uri.scheme === STDLIB_SCHEME) {
      return;
    }

    try {
      const source = document.getText();
      const path = document.uri.path;
      const byFile = await this.#compiler.checkDocument(source, document.uri);

      this.#diagnosticCollection.set(document.uri, []);

      for (const [filePath, diagnostics] of byFile) {
        const uri = uriForCompilerPath(filePath, document.uri);
        this.#diagnosticCollection.set(uri, diagnostics);
      }

      const findings = await this.#compiler.lintDocument(path);
      this.#lintFindings.set(path, findings);
      if (findings.length > 0) {
        const own = (this.#diagnosticCollection.get(document.uri) ?? []).filter(
          (d) =>
            !(
              d.message.startsWith('Unnecessary cast') &&
              findings.some((f) =>
                document.positionAt(f.start).isEqual(d.range.start),
              )
            ),
        );
        for (const finding of findings) {
          if (finding.shared) continue;
          const range = new vscode.Range(
            document.positionAt(finding.start),
            document.positionAt(finding.end),
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
      outputChannel.appendLine(
        `Check failed for ${document.uri.toString()}: ${formatError(e)}`,
      );
    }
  }

  #findingsFor(document: vscode.TextDocument): LintFindingInfo[] {
    return this.#lintFindings.get(document.uri.path) ?? [];
  }

  #rangeOf(
    document: vscode.TextDocument,
    finding: LintFindingInfo,
  ): vscode.Range {
    return new vscode.Range(
      document.positionAt(finding.start),
      document.positionAt(finding.end),
    );
  }

  #fixAllEdit(
    document: vscode.TextDocument,
    findings: LintFindingInfo[],
  ): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    for (const finding of findings) {
      edit.replace(
        document.uri,
        this.#rangeOf(document, finding),
        finding.replacement,
      );
    }
    return edit;
  }

  #setStatusBarOk(): void {
    this.#statusBarItem.text = '$(zap) Zena';
    this.#statusBarItem.backgroundColor = undefined;
    this.#statusBarItem.tooltip = 'Zena Language Service';
  }

  #setStatusBarError(tooltip: string): void {
    this.#statusBarItem.text = '$(zap) Zena';
    this.#statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground',
    );
    this.#statusBarItem.tooltip = `${tooltip} — click to view logs`;
  }

  async deactivate(): Promise<void> {
    outputChannel.appendLine('Deactivating Zena language extension');
    this.#diagnosticCollection.clear();
  }
}
