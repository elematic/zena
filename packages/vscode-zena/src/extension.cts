import type {ZenaExtension} from './lib/zena-extension.js';
import type vscode from 'vscode';

let zenaExtension: ZenaExtension;

export async function activate(context: vscode.ExtensionContext) {
  // This must be a dynamic import. Even though Node supports require(esm) now,
  // Electron will error if we try to use static imports.
  const {ZenaExtension} = await import('./lib/zena-extension.js');
  zenaExtension = new ZenaExtension(context);
  await zenaExtension.activate();
}

export async function deactivate() {
  await zenaExtension?.deactivate();
}
