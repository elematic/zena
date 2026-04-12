import * as vscode from 'vscode';
import {ZenaCompilerService} from './compiler-service.js';

export const outputChannel = vscode.window.createOutputChannel('Zena');

/**
 * Holds the shared state of the Zena extension and manages its lifecycle.
 */
export class ZenaExtension {
  context: vscode.ExtensionContext;
  #compiler: ZenaCompilerService;
  #diagnosticCollection: vscode.DiagnosticCollection;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.#compiler = new ZenaCompilerService(outputChannel);
    this.#diagnosticCollection =
      vscode.languages.createDiagnosticCollection('zena');
  }

  async activate() {
    outputChannel.appendLine('Activating Zena language extension');

    const {context} = this;

    context.subscriptions.push(this.#diagnosticCollection);

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
  }

  #checkDocument(document: vscode.TextDocument) {
    if (!this.#compiler.isReady) return;

    try {
      const source = document.getText();
      const path = document.uri.fsPath;
      const diagnostics = this.#compiler.checkDocument(source, path);
      this.#diagnosticCollection.set(document.uri, diagnostics);
    } catch (e) {
      outputChannel.appendLine(`Check failed for ${document.uri.fsPath}: ${e}`);
    }
  }

  async deactivate() {
    outputChannel.appendLine('Deactivating Zena language extension');
    this.#diagnosticCollection.clear();
  }
}
