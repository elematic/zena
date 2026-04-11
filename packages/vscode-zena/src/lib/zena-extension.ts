import * as vscode from 'vscode';

export const outputChannel = vscode.window.createOutputChannel('Zena');

/**
 * Holds the shared state of the Zena extension and manages its lifecycle.
 */
export class ZenaExtension {
  context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async activate() {
    outputChannel.appendLine('Activating Zena language extension');

    const {context} = this;

    context.subscriptions.push(
      vscode.commands.registerCommand('zena.helloWorld', () => {
        vscode.window.showInformationMessage('Hello from Zena!');
      }),
    );
  }

  async deactivate() {
    outputChannel.appendLine('Deactivating Zena language extension');
  }
}
