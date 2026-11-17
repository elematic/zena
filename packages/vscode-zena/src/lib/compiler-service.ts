import * as vscode from 'vscode';
import {
  createCompiler,
  stdlibRelativeCandidates,
  type CompletionItem,
  type DefinitionInfo,
  type DocumentSymbolInfo,
  type HoverInfo,
  type LintFinding,
  type ZenaCompiler,
} from '@zena-lang/compiler';

export type {
  CompletionItem,
  DefinitionInfo,
  DocumentSymbolInfo,
  HoverInfo,
  LintFinding as LintFindingInfo,
};

export const STDLIB_SCHEME = 'zena-stdlib';
export const STDLIB_ROOT = '/stdlib';

const textDecoder = new TextDecoder('utf-8');

export function isStdlibPath(file: string): boolean {
  return (
    file.startsWith('zena:') ||
    file === STDLIB_ROOT ||
    file.startsWith(STDLIB_ROOT + '/')
  );
}

/**
 * Reconstructs a `vscode.Uri` from a POSIX path reported by `compiler.wasm`,
 * preserving workspace/document URI schemes (`file:`, `vscode-vfs:`, etc.)
 * and routing stdlib paths to `zena-stdlib:`.
 */
export function uriForCompilerPath(
  compilerPath: string,
  referenceUri?: vscode.Uri,
): vscode.Uri {
  if (isStdlibPath(compilerPath)) {
    const path = compilerPath.startsWith(STDLIB_ROOT + '/')
      ? compilerPath
      : compilerPath.startsWith('zena:')
        ? `${STDLIB_ROOT}/${compilerPath.slice('zena:'.length)}.zena`
        : `${STDLIB_ROOT}/${compilerPath}`;
    return vscode.Uri.from({
      scheme: STDLIB_SCHEME,
      path,
    });
  }
  const normalized = compilerPath.startsWith('/')
    ? compilerPath
    : '/' + compilerPath;
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.path === compilerPath || doc.uri.path === normalized) {
      return doc.uri;
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderPrefix = folder.uri.path.endsWith('/')
      ? folder.uri.path
      : folder.uri.path + '/';
    if (normalized === folder.uri.path || normalized.startsWith(folderPrefix)) {
      return folder.uri.with({path: normalized});
    }
  }
  if (referenceUri && referenceUri.scheme !== STDLIB_SCHEME) {
    return referenceUri.with({path: normalized});
  }
  return vscode.Uri.file(normalized);
}

/**
 * Manages the WASM-based Zena compiler and language service instance for VS Code.
 */
export class ZenaCompilerService {
  #service: ZenaCompiler | undefined;
  #outputChannel: vscode.OutputChannel;
  #extensionUri: vscode.Uri | undefined;
  #lastDocumentUri: vscode.Uri | undefined;
  #checkedPaths = new Set<string>();
  #stdlibCache = new Map<
    string,
    Promise<{relPath: string; content: string} | undefined>
  >();

  constructor(outputChannel: vscode.OutputChannel) {
    this.#outputChannel = outputChannel;
  }

  async #readStdlibEntry(
    rawPath: string,
  ): Promise<{relPath: string; content: string} | undefined> {
    if (!this.#extensionUri) return undefined;
    const candidates = stdlibRelativeCandidates(rawPath, STDLIB_ROOT);
    if (candidates.length === 0) return undefined;

    for (const relPath of candidates) {
      let cached = this.#stdlibCache.get(relPath);
      if (cached === undefined) {
        const uri = vscode.Uri.joinPath(
          this.#extensionUri,
          'dist',
          'stdlib',
          ...relPath.split('/'),
        );
        cached = (async () => {
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return {relPath, content: textDecoder.decode(bytes)};
          } catch {
            return undefined;
          }
        })();
        this.#stdlibCache.set(relPath, cached);
      }
      const entry = await cached;
      if (entry !== undefined) {
        return entry;
      }
    }
    return undefined;
  }

  async readStdlibContent(path: string): Promise<string | undefined> {
    return (await this.#readStdlibEntry(path))?.content;
  }

  async resolveStdlibUriPath(file: string): Promise<string> {
    const entry = await this.#readStdlibEntry(file);
    if (entry !== undefined) {
      return `${STDLIB_ROOT}/${entry.relPath}`;
    }
    return uriForCompilerPath(file).path;
  }

  async initialize(extensionUri: vscode.Uri): Promise<void> {
    this.#extensionUri = extensionUri;
    const wasmUri = vscode.Uri.joinPath(extensionUri, 'dist', 'compiler.wasm');
    const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);

    this.#outputChannel.appendLine(
      `Initializing Zena language service from ${wasmUri.toString()}`,
    );

    this.#service = await createCompiler({
      wasm: wasmBytes.slice(),
      stdlibRoot: STDLIB_ROOT,
      stdlibUrl: null,
      console: {
        log: (msg) => this.#outputChannel.appendLine(`[lsp] ${msg}`),
        warn: (msg) => this.#outputChannel.appendLine(`[lsp warn] ${msg}`),
        error: (msg) => this.#outputChannel.appendLine(`[lsp error] ${msg}`),
      },
      readFile: async (rawPath: string) => {
        const fromStdlib = await this.readStdlibContent(rawPath);
        if (fromStdlib !== undefined) {
          return fromStdlib;
        }
        if (
          rawPath === 'zena-package.json' ||
          rawPath === '/zena-package.json'
        ) {
          return undefined;
        }
        const normalized = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.uri.path === rawPath || doc.uri.path === normalized) {
            return doc.getText();
          }
        }
        const targetUri = uriForCompilerPath(normalized, this.#lastDocumentUri);
        try {
          const bytes = await vscode.workspace.fs.readFile(targetUri);
          return textDecoder.decode(bytes);
        } catch {
          return undefined;
        }
      },
    });

    this.#outputChannel.appendLine('Zena language service loaded');
  }

  get isReady(): boolean {
    return this.#service !== undefined;
  }

  closeDocument(path: string): void {
    this.#checkedPaths.delete(path);
    this.#service?.closeDocument(path);
  }

  /**
   * Checks `source` at `uri` and groups VS Code diagnostics by compiler file path.
   */
  async checkDocument(
    source: string,
    uri: vscode.Uri,
  ): Promise<Map<string, vscode.Diagnostic[]>> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    const diagnostics = await this.#service!.check(path, source);
    this.#checkedPaths.add(path);

    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const diag of diagnostics) {
      if (diag.line === 0 && diag.start < 0) {
        this.#outputChannel.appendLine(`[diagnostic] ${diag.message}`);
        continue;
      }

      const diagPath = diag.file.length > 0 ? diag.file : path;
      if (uri.scheme !== STDLIB_SCHEME && isStdlibPath(diagPath)) {
        continue;
      }

      const diagSource = diagPath === path ? source : undefined;
      const startPos = new vscode.Position(
        Math.max(0, diag.line - 1),
        Math.max(0, diag.column - 1),
      );

      let endPos: vscode.Position;
      if (diag.start >= 0 && diag.length > 0 && diagSource !== undefined) {
        const endOffset = Math.min(diagSource.length, diag.start + diag.length);
        let endLine = 0;
        let endCol = 0;
        for (let idx = 0; idx < endOffset; idx++) {
          if (diagSource.charCodeAt(idx) === 0x0a) {
            endLine++;
            endCol = 0;
          } else {
            endCol++;
          }
        }
        endPos = new vscode.Position(endLine, endCol);
      } else if (diag.start >= 0 && diag.length > 0) {
        endPos = startPos.translate(0, diag.length);
      } else {
        endPos = startPos.translate(0, 1);
      }

      const vsSeverity =
        diag.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : diag.severity === 'info'
            ? vscode.DiagnosticSeverity.Information
            : vscode.DiagnosticSeverity.Error;

      const vsDiag = new vscode.Diagnostic(
        new vscode.Range(startPos, endPos),
        diag.message,
        vsSeverity,
      );
      vsDiag.source = 'zena';

      let list = byFile.get(diagPath);
      if (list === undefined) {
        list = [];
        byFile.set(diagPath, list);
      }
      list.push(vsDiag);
    }

    return byFile;
  }

  async lintDocument(path: string): Promise<LintFinding[]> {
    try {
      return await this.#service!.lint(path);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`Lint failed: ${msg}`);
      return [];
    }
  }

  async getDefinition(
    uri: vscode.Uri,
    offset: number,
    source?: string,
  ): Promise<DefinitionInfo | null> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    try {
      const needsCheck = !this.#checkedPaths.has(path) && source !== undefined;
      if (needsCheck) {
        this.#checkedPaths.add(path);
      }
      return await this.#service!.definition(
        path,
        offset,
        needsCheck ? source : undefined,
      );
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getDefinition failed: ${msg}`);
      return null;
    }
  }

  async getHover(
    uri: vscode.Uri,
    offset: number,
    source?: string,
  ): Promise<HoverInfo | null> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    try {
      const needsCheck = !this.#checkedPaths.has(path) && source !== undefined;
      if (needsCheck) {
        this.#checkedPaths.add(path);
      }
      return await this.#service!.hover(
        path,
        offset,
        needsCheck ? source : undefined,
      );
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getHover failed: ${msg}`);
      return null;
    }
  }

  async getCompletions(
    uri: vscode.Uri,
    offset: number,
    source: string,
  ): Promise<CompletionItem[]> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    try {
      this.#checkedPaths.add(path);
      return await this.#service!.completions(path, offset, source);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getCompletions failed: ${msg}`);
      return [];
    }
  }

  async getDocumentSymbols(
    uri: vscode.Uri,
    source: string,
  ): Promise<DocumentSymbolInfo[]> {
    this.#lastDocumentUri = uri;
    try {
      return await this.#service!.documentSymbols(uri.path, source);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`getDocumentSymbols failed: ${msg}`);
      return [];
    }
  }

  formatDocument(source: string): string | null {
    try {
      return this.#service!.format(source);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`Format failed: ${msg}`);
      return null;
    }
  }
}
