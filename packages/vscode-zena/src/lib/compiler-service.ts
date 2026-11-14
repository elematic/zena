import * as vscode from 'vscode';
import {
  createLanguageService,
  createVirtualFileReader,
  type CompletionItem,
  type DefinitionInfo,
  type DocumentSymbolInfo,
  type HoverInfo,
  type LintFinding,
  type ZenaLanguageService,
} from '@zena-lang/language-service';
import stdlibFiles from 'virtual:stdlib-data';

export type {
  CompletionItem,
  DefinitionInfo,
  DocumentSymbolInfo,
  HoverInfo,
  LintFinding as LintFindingInfo,
};

export const STDLIB_SCHEME = 'zena-stdlib';
export const STDLIB_ROOT = '/stdlib';

const stdlibReader = createVirtualFileReader(stdlibFiles, STDLIB_ROOT);
const textDecoder = new TextDecoder('utf-8');

export function isStdlibPath(file: string): boolean {
  return (
    file.startsWith('zena:') ||
    file === STDLIB_ROOT ||
    file.startsWith(STDLIB_ROOT + '/')
  );
}

/**
 * Maps a `zena:<module>` specifier or `/stdlib/...` compiler path to the
 * canonical `/stdlib/.../*.zena` key in `stdlibFiles` so virtual stdlib URIs
 * carry a `.zena` extension for syntax highlighting.
 */
export function toStdlibUriPath(file: string): string {
  const mod = file.startsWith('zena:')
    ? file.slice('zena:'.length)
    : file.startsWith(STDLIB_ROOT + '/')
      ? file.slice(STDLIB_ROOT.length + 1)
      : file;
  const candidates = [
    `${STDLIB_ROOT}/${mod}`,
    `${STDLIB_ROOT}/${mod}.zena`,
    `${STDLIB_ROOT}/${mod}/index.zena`,
    `${STDLIB_ROOT}/${mod}/host.zena`,
  ];
  for (const candidate of candidates) {
    if (stdlibFiles[candidate] !== undefined) {
      return candidate;
    }
  }
  const basename = mod.split('/').pop();
  if (basename) {
    const byBase = `${STDLIB_ROOT}/${basename.endsWith('.zena') ? basename : basename + '.zena'}`;
    if (stdlibFiles[byBase] !== undefined) {
      return byBase;
    }
  }
  return mod.endsWith('.zena')
    ? `${STDLIB_ROOT}/${mod}`
    : `${STDLIB_ROOT}/${mod}.zena`;
}

export function getStdlibContent(path: string): string | undefined {
  const content = stdlibReader(path);
  return typeof content === 'string' ? content : undefined;
}

/**
 * Reconstructs a `vscode.Uri` from a POSIX path reported by `lsp.wasm`,
 * preserving workspace/document URI schemes (`file:`, `vscode-vfs:`, etc.)
 * and routing stdlib paths to `zena-stdlib:`.
 */
export function uriForCompilerPath(
  compilerPath: string,
  referenceUri?: vscode.Uri,
): vscode.Uri {
  if (isStdlibPath(compilerPath)) {
    return vscode.Uri.from({
      scheme: STDLIB_SCHEME,
      path: toStdlibUriPath(compilerPath),
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
 * Manages the WASM-based Zena language service instance for VS Code.
 */
export class ZenaCompilerService {
  #service: ZenaLanguageService | undefined;
  #outputChannel: vscode.OutputChannel;
  #lastDocumentUri: vscode.Uri | undefined;
  #checkedPaths = new Set<string>();

  constructor(outputChannel: vscode.OutputChannel) {
    this.#outputChannel = outputChannel;
  }

  async initialize(extensionUri: vscode.Uri): Promise<void> {
    const wasmUri = vscode.Uri.joinPath(extensionUri, 'dist', 'lsp.wasm');
    const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);

    this.#outputChannel.appendLine(
      `Initializing Zena language service from ${wasmUri.toString()}`,
    );

    this.#service = await createLanguageService({
      wasm: wasmBytes.slice(),
      stdlibRoot: STDLIB_ROOT,
      console: {
        log: (msg) => this.#outputChannel.appendLine(`[lsp] ${msg}`),
        warn: (msg) => this.#outputChannel.appendLine(`[lsp warn] ${msg}`),
        error: (msg) => this.#outputChannel.appendLine(`[lsp error] ${msg}`),
      },
      readFile: async (rawPath: string) => {
        const fromStdlib = await stdlibReader(rawPath);
        if (typeof fromStdlib === 'string') {
          return fromStdlib;
        }
        // Skip cwd manifest discovery during `init()`: `DocumentHost.listDir`
        // returns null, so workspace globs cannot be expanded without a dir host.
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
