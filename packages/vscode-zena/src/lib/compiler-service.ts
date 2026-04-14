import * as vscode from 'vscode';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
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
  init(stdlibRoot: unknown): void;
  check(source: unknown, path: unknown): unknown;
  getDiagnosticCount(diagnostics: unknown): number;
  getDiagnosticLine(diagnostics: unknown, index: number): number;
  getDiagnosticColumn(diagnostics: unknown, index: number): number;
  getDiagnosticStart(diagnostics: unknown, index: number): number;
  getDiagnosticLength(diagnostics: unknown, index: number): number;
  getDiagnosticSeverity(diagnostics: unknown, index: number): number;
  getDiagnosticMessage(diagnostics: unknown, index: number): unknown;
  getDiagnosticFile(diagnostics: unknown, index: number): unknown;
  format(source: unknown): unknown;
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
    let writeString: ((s: string) => unknown) | undefined;
    let readString: ((ref: unknown, len: number) => string) | undefined;

    const consoleImports = createConsoleImports(() => exports);

    // Host import: read a file by absolute path and return a WASM String.
    const compilerImports = {
      read_file: (pathRef: unknown, pathLen: number): unknown => {
        const reader = readString!;
        const writer = writeString!;
        const filePath = reader(pathRef, pathLen);
        try {
          const content = readFileSync(filePath, 'utf8');
          return writer(content);
        } catch {
          this.#outputChannel.appendLine(
            `Warning: could not read file: ${filePath}`,
          );
          return writer('');
        }
      },
    };

    const result = await WebAssembly.instantiate(wasmBuffer, {
      console: consoleImports,
      compiler: compilerImports,
    });

    const instance =
      (result as unknown as {instance: WebAssembly.Instance}).instance ??
      result;
    exports = instance.exports as LspExports;
    this.#exports = exports;
    writeString = createStringWriter(exports);
    readString = createStringReader(exports);
    this.#writeString = writeString;
    this.#readString = readString;

    // Initialize the compiler with the stdlib source path.
    const stdlibRoot = resolve(extensionPath, '../stdlib/zena');
    const stdlibRootRef = writeString(stdlibRoot);
    exports.init(stdlibRootRef);

    this.#outputChannel.appendLine('Zena compiler WASM loaded');
    this.#outputChannel.appendLine(`Stdlib root: ${stdlibRoot}`);
  }

  get isReady(): boolean {
    return this.#exports !== undefined;
  }

  /**
   * Check a source string and return VS Code diagnostics grouped by file.
   *
   * The returned map keys are file paths. Diagnostics from dependency
   * files are keyed under the dependency's path rather than the entry.
   */
  checkDocument(
    source: string,
    path: string,
  ): Map<string, vscode.Diagnostic[]> {
    const exports = this.#exports!;
    const writeString = this.#writeString!;
    const readString = this.#readString!;

    const sourceRef = writeString(source);
    const pathRef = writeString(path);
    const diagnosticsHandle = exports.check(sourceRef, pathRef);
    const count = exports.getDiagnosticCount(diagnosticsHandle);

    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (let i = 0; i < count; i++) {
      const line = exports.getDiagnosticLine(diagnosticsHandle, i);
      const column = exports.getDiagnosticColumn(diagnosticsHandle, i);
      const start = exports.getDiagnosticStart(diagnosticsHandle, i);
      const length = exports.getDiagnosticLength(diagnosticsHandle, i);
      const severity = exports.getDiagnosticSeverity(diagnosticsHandle, i);
      const msgRef = exports.getDiagnosticMessage(diagnosticsHandle, i);
      const msgLen = exports.$stringGetLength(msgRef);
      const message = readString(msgRef, msgLen);
      const fileRef = exports.getDiagnosticFile(diagnosticsHandle, i);
      const fileLen = exports.$stringGetLength(fileRef);
      const file = readString(fileRef, fileLen);

      // Skip diagnostics without a source location.
      if (line === 0 && start < 0) {
        this.#outputChannel.appendLine(`[diagnostic] ${message}`);
        continue;
      }

      // Determine which file this diagnostic belongs to.
      const diagPath = file.length > 0 ? file : path;

      // For diagnostics in the entry file we can compute precise end
      // positions from the in-memory source. For other files we fall
      // back to the byte-length span reported by the compiler.
      const diagSource = diagPath === path ? source : undefined;

      // Convert 1-based line/column to 0-based for VS Code
      const startPos = new vscode.Position(
        Math.max(0, line - 1),
        Math.max(0, column - 1),
      );

      // Use byte offset + length to compute end position from source
      let endPos: vscode.Position;
      if (start >= 0 && length > 0 && diagSource !== undefined) {
        // Find end position by counting through source characters
        const endOffset = start + length;
        let endLine = 0;
        let endCol = 0;
        let offset = 0;
        for (const ch of diagSource) {
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
      } else if (start >= 0 && length > 0) {
        // No source text available — approximate end from start + length columns
        endPos = startPos.translate(0, length);
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

      let arr = byFile.get(diagPath);
      if (arr === undefined) {
        arr = [];
        byFile.set(diagPath, arr);
      }
      arr.push(diagnostic);
    }

    return byFile;
  }

  /**
   * Format a source string and return the formatted result.
   * Returns null if formatting fails (e.g. parse error).
   */
  formatDocument(source: string): string | null {
    const exports = this.#exports!;
    const writeString = this.#writeString!;
    const readString = this.#readString!;

    try {
      const sourceRef = writeString(source);
      const resultRef = exports.format(sourceRef);
      const resultLen = exports.$stringGetLength(resultRef);
      return readString(resultRef, resultLen);
    } catch (e) {
      const msg =
        e instanceof Error
          ? (e.stack ?? e.message)
          : e != null && typeof e === 'object' && 'stack' in e
            ? String((e as {stack: unknown}).stack)
            : String(e);
      this.#outputChannel.appendLine(`Format failed: ${msg}`);
      return null;
    }
  }
}
