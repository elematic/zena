import type * as vscode from 'vscode';
import {ZenaExtension} from './lib/zena-extension.js';

let zenaExtension: ZenaExtension | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  zenaExtension = new ZenaExtension(context);
  await zenaExtension.activate();
}

export async function deactivate(): Promise<void> {
  await zenaExtension?.deactivate();
  zenaExtension = undefined;
}
