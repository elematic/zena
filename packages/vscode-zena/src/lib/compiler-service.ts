import * as vscode from 'vscode';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  createStringReader,
  createStringWriter,
  createConsoleImports,
} from '@zena-lang/runtime';

/**
 * Typed interface for the LSP WASM exports.
 *
 * check() returns an opaque diagnostics handle (WASM GC object as externref).
 * Getter functions accept this handle to read individual fields.
 * When the JS side drops the reference, WASM GC collects it.
 */
interface LspExports extends WebAssembly.Exports {
  check(source: unknown, path: unknown): unknown;
  getDiagnosticCount(diagnostics: unknown): number;
  getDiagnosticLine(diagnostics: unknown, index: number): number;
  getDiagnosticColumn(diagnostics: unknown, index: number): number;
  getDiagnosticStart(diagnostics: unknown, index: number): number;
  getDiagnosticLength(diagnostics: unknown, index: number): number;
  getDiagnosticSeverity(diagnostics: unknown, index: number): number;
  getDiagnosticMessage(diagnostics: unknown, index: number): unknown;
  $stringGetByte(str: unknown, index: number): number;
  $stringGetLength(str: unknown): number;
  $stringCreate(len: number): unknown;
  $stringSetByte(str: unknown, index: number, value: number): void;
}

/**
 * Manages the WASM-based Zena compiler instance.
 *
 * Loads lsp.wasm, provides methods to check source and read diagnostics.
 */
export class ZenaCompilerService {
  #exports: LspExports | undefined;
  #writeString: ((s: string) => unknown) | undefined;
  #readString: ((ref: unknown, len: number) => string) | undefined;
  #outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.#outputChannel = outputChannel;
  }

  async initialize(extensionPath: string): Promise<void> {
    const wasmPath = join(extensionPath, 'lsp.wasm');
    const wasmBuffer = await readFile(wasmPath);

    let exports: LspExports | undefined;
    const consoleImports = createConsoleImports(() => exports);

    const result = await WebAssembly.instantiate(wasmBuffer, {
      console: consoleImports,
    });

    const instance =
      (result as unknown as {instance: WebAssembly.Instance}).instance ??
      result;
    exports = instance.exports as LspExports;
    this.#exports = exports;
    this.#writeString = createStringWriter(exports);
    this.#readString = createStringReader(exports);

    this.#outputChannel.appendLine('Zena compiler WASM loaded');
  }

  get isReady(): boolean {
    return this.#exports !== undefined;
  }

  /**
   * Check a source string and return VS Code diagnostics.
   */
  checkDocument(source: string, path: string): vscode.Diagnostic[] {
    const exports = this.#exports!;
    const writeString = this.#writeString!;
    const readString = this.#readString!;

    const sourceRef = writeString(source);
    const pathRef = writeString(path);
    const diagnosticsHandle = exports.check(sourceRef, pathRef);
    const count = exports.getDiagnosticCount(diagnosticsHandle);

    const diagnostics: vscode.Diagnostic[] = [];
    for (let i = 0; i < count; i++) {
      const line = exports.getDiagnosticLine(diagnosticsHandle, i);
      const column = exports.getDiagnosticColumn(diagnosticsHandle, i);
      const start = exports.getDiagnosticStart(diagnosticsHandle, i);
      const length = exports.getDiagnosticLength(diagnosticsHandle, i);
      const severity = exports.getDiagnosticSeverity(diagnosticsHandle, i);
      const msgRef = exports.getDiagnosticMessage(diagnosticsHandle, i);
      const msgLen = exports.$stringGetLength(msgRef);
      const message = readString(msgRef, msgLen);

      // Convert 1-based line/column to 0-based for VS Code
      const startPos = new vscode.Position(
        Math.max(0, line - 1),
        Math.max(0, column - 1),
      );

      // Use byte offset + length to compute end position from source
      let endPos: vscode.Position;
      if (start >= 0 && length > 0) {
        // Find end position by counting through source characters
        const endOffset = start + length;
        let endLine = 0;
        let endCol = 0;
        let offset = 0;
        for (const ch of source) {
          if (offset >= endOffset) break;
          if (ch === '\n') {
            endLine++;
            endCol = 0;
          } else {
            endCol++;
          }
          offset += Buffer.byteLength(ch, 'utf8');
        }
        endPos = new vscode.Position(endLine, endCol);
      } else {
        // No span info — underline just the start position
        endPos = startPos.translate(0, 1);
      }

      const range = new vscode.Range(startPos, endPos);

      let vsSeverity: vscode.DiagnosticSeverity;
      switch (severity) {
        case 0:
          vsSeverity = vscode.DiagnosticSeverity.Error;
          break;
        case 1:
          vsSeverity = vscode.DiagnosticSeverity.Warning;
          break;
        case 2:
          vsSeverity = vscode.DiagnosticSeverity.Information;
          break;
        default:
          vsSeverity = vscode.DiagnosticSeverity.Error;
      }

      const diagnostic = new vscode.Diagnostic(range, message, vsSeverity);
      diagnostic.source = 'zena';
      diagnostics.push(diagnostic);
    }

    return diagnostics;
  }
}
