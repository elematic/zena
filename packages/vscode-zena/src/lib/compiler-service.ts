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
  check(path: unknown, source: unknown): unknown;
  getDiagnosticCount(diagnostics: unknown): number;
  getDiagnosticLine(diagnostics: unknown, index: number): number;
  getDiagnosticColumn(diagnostics: unknown, index: number): number;
  getDiagnosticStart(diagnostics: unknown, index: number): number;
  getDiagnosticLength(diagnostics: unknown, index: number): number;
  getDiagnosticSeverity(diagnostics: unknown, index: number): number;
  getDiagnosticMessage(diagnostics: unknown, index: number): unknown;
  getDiagnosticFile(diagnostics: unknown, index: number): unknown;
  format(source: unknown): unknown;
  getDefinition(path: unknown, offset: number): unknown;
  getDefinitionFile(result: unknown): unknown;
  getDefinitionLine(result: unknown): number;
  getDefinitionColumn(result: unknown): number;
  getDefinitionStart(result: unknown): number;
  getDefinitionLength(result: unknown): number;
  getHover(path: unknown, offset: number): unknown;
  getHoverType(result: unknown): unknown;
  getHoverLabel(result: unknown): unknown;
  getHoverDoc(result: unknown): unknown;
  getDocumentSymbols(path: unknown, source: unknown): unknown;
  getSymbolCount(symbols: unknown): number;
  getSymbol(symbols: unknown, index: number): unknown;
  getSymbolName(sym: unknown): unknown;
  getSymbolKind(sym: unknown): number;
  getSymbolStart(sym: unknown): number;
  getSymbolEnd(sym: unknown): number;
  getSymbolSelStart(sym: unknown): number;
  getSymbolSelEnd(sym: unknown): number;
  getSymbolChildCount(sym: unknown): number;
  getSymbolChild(sym: unknown, index: number): unknown;
  $stringGetByte(str: unknown, index: number): number;
  $stringGetLength(str: unknown): number;
  $stringCreate(len: number): unknown;
  $stringSetByte(str: unknown, index: number, value: number): void;
}

/**
 * A document symbol with optional children for the outline view.
 */
export interface DocumentSymbolInfo {
  name: string;
  kind: number;
  start: number;
  end: number;
  selStart: number;
  selEnd: number;
  children: DocumentSymbolInfo[];
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
    const diagnosticsHandle = exports.check(pathRef, sourceRef);
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
   * Find the definition of the symbol at the given byte offset.
   * Uses the cached scope result from the last checkDocument() call.
   * Returns {file, line, column} or null if no definition was found.
   */
  getDefinition(
    path: string,
    offset: number,
  ): {
    file: string;
    line: number;
    column: number;
    start: number;
    length: number;
  } | null {
    const exports = this.#exports!;
    const readString = this.#readString!;

    try {
      const pathRef = this.#writeString!(path);
      const resultRef = exports.getDefinition(pathRef, offset);
      if (resultRef === null || resultRef === undefined) {
        this.#outputChannel.appendLine(`getDefinition(${offset}): no result`);
        return null;
      }

      const fileRef = exports.getDefinitionFile(resultRef);
      const fileLen = exports.$stringGetLength(fileRef);
      const file = readString(fileRef, fileLen);
      const line = exports.getDefinitionLine(resultRef);
      const column = exports.getDefinitionColumn(resultRef);
      const start = exports.getDefinitionStart(resultRef);
      const length = exports.getDefinitionLength(resultRef);

      this.#outputChannel.appendLine(
        `getDefinition(${offset}): ${file}:${line}:${column}`,
      );
      return {file, line, column, start, length};
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getDefinition failed: ${msg}`);
      return null;
    }
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

  /**
   * Get hover information at a byte offset.
   * Returns {type, label} or null if no info is available.
   */
  getHover(
    path: string,
    offset: number,
  ): {type: string; label: string; doc: string} | null {
    const exports = this.#exports!;
    const readString = this.#readString!;

    try {
      const pathRef = this.#writeString!(path);
      const resultRef = exports.getHover(pathRef, offset);
      if (resultRef === null || resultRef === undefined) {
        return null;
      }

      const typeRef = exports.getHoverType(resultRef);
      const typeLen = exports.$stringGetLength(typeRef);
      const type = readString(typeRef, typeLen);

      const labelRef = exports.getHoverLabel(resultRef);
      const labelLen = exports.$stringGetLength(labelRef);
      const label = readString(labelRef, labelLen);

      const docRef = exports.getHoverDoc(resultRef);
      const docLen = exports.$stringGetLength(docRef);
      const doc = readString(docRef, docLen);

      return {type, label, doc};
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getHover failed: ${msg}`);
      return null;
    }
  }

  /**
   * Get document symbols for the outline view.
   * Returns a tree of symbols (classes with members, test suites with tests).
   */
  getDocumentSymbols(path: string, source: string): DocumentSymbolInfo[] {
    const exports = this.#exports!;
    const readString = this.#readString!;

    try {
      const pathRef = this.#writeString!(path);
      const sourceRef = this.#writeString!(source);
      const symbolsRef = exports.getDocumentSymbols(pathRef, sourceRef);
      return this.#readSymbols(symbolsRef);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getDocumentSymbols failed: ${msg}`);
      return [];
    }
  }

  /**
   * Read an Array<DocumentSymbol> from WASM into JS objects, recursively.
   */
  #readSymbols(symbolsRef: unknown): DocumentSymbolInfo[] {
    const exports = this.#exports!;
    const readString = this.#readString!;
    const count = exports.getSymbolCount(symbolsRef);
    const result: DocumentSymbolInfo[] = [];

    for (let i = 0; i < count; i++) {
      const symRef = exports.getSymbol(symbolsRef, i);
      const nameRef = exports.getSymbolName(symRef);
      const nameLen = exports.$stringGetLength(nameRef);
      const name = readString(nameRef, nameLen);
      const kind = exports.getSymbolKind(symRef);
      const start = exports.getSymbolStart(symRef);
      const end = exports.getSymbolEnd(symRef);
      const selStart = exports.getSymbolSelStart(symRef);
      const selEnd = exports.getSymbolSelEnd(symRef);

      // Read children recursively.
      const childCount = exports.getSymbolChildCount(symRef);
      const children: DocumentSymbolInfo[] = [];
      for (let j = 0; j < childCount; j++) {
        const childRef = exports.getSymbolChild(symRef, j);
        const cNameRef = exports.getSymbolName(childRef);
        const cNameLen = exports.$stringGetLength(cNameRef);
        const cName = readString(cNameRef, cNameLen);
        const cKind = exports.getSymbolKind(childRef);
        const cStart = exports.getSymbolStart(childRef);
        const cEnd = exports.getSymbolEnd(childRef);
        const cSelStart = exports.getSymbolSelStart(childRef);
        const cSelEnd = exports.getSymbolSelEnd(childRef);

        // Support 2 levels of nesting (suite > test).
        const grandchildren: DocumentSymbolInfo[] = [];
        const gcCount = exports.getSymbolChildCount(childRef);
        for (let k = 0; k < gcCount; k++) {
          const gcRef = exports.getSymbolChild(childRef, k);
          const gcNameRef = exports.getSymbolName(gcRef);
          const gcNameLen = exports.$stringGetLength(gcNameRef);
          grandchildren.push({
            name: readString(gcNameRef, gcNameLen),
            kind: exports.getSymbolKind(gcRef),
            start: exports.getSymbolStart(gcRef),
            end: exports.getSymbolEnd(gcRef),
            selStart: exports.getSymbolSelStart(gcRef),
            selEnd: exports.getSymbolSelEnd(gcRef),
            children: [],
          });
        }

        children.push({
          name: cName,
          kind: cKind,
          start: cStart,
          end: cEnd,
          selStart: cSelStart,
          selEnd: cSelEnd,
          children: grandchildren,
        });
      }

      result.push({name, kind, start, end, selStart, selEnd, children});
    }

    return result;
  }
}
