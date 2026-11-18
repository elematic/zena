import * as vscode from 'vscode';
import {
  createCompiler,
  stdlibRelativeCandidates,
  type CompletionItem,
  type DefinitionInfo,
  type Diagnostic,
  type DocumentSymbolInfo,
  type HoverInfo,
  type LintFinding,
  type ZenaCompiler,
} from '@zena-lang/compiler';
import type {WorkerMessage, WorkerRequest} from '../compiler-worker.js';

type CompilerBackend = Omit<
  ZenaCompiler,
  'exports' | 'compileToWasm' | 'compileToWat' | 'checkForTarget' | 'format'
> & {
  format(source: string): string | null | Promise<string | null>;
  dispose?(): Promise<void>;
};

export type {
  CompletionItem,
  DefinitionInfo,
  DocumentSymbolInfo,
  HoverInfo,
  LintFinding as LintFindingInfo,
};

export const STDLIB_SCHEME = 'zena-stdlib';
export const STDLIB_ROOT = '/stdlib';
export const DEFAULT_TARGET = 'zena-component';

const textDecoder = new TextDecoder('utf-8');

/**
 * When stdlib files exist as real addressable URIs (either
 * `<workspaceRoot>/packages/stdlib/zena` in the Zena monorepo, or
 * `<extensionPath>/dist/stdlib` on Desktop VS Code), holds that directory's URI
 * so stdlib paths open as real files with full breadcrumbs.
 */
let activeRealStdlibUri: vscode.Uri | undefined;

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
 * and routing stdlib paths to `activeRealStdlibUri` (when available) or
 * `zena-stdlib:`.
 */
export function uriForCompilerPath(
  compilerPath: string,
  referenceUri?: vscode.Uri,
): vscode.Uri {
  if (isStdlibPath(compilerPath)) {
    const candidates = stdlibRelativeCandidates(compilerPath, STDLIB_ROOT);
    const rel =
      candidates[0] ??
      (compilerPath.startsWith(STDLIB_ROOT + '/')
        ? compilerPath.slice(STDLIB_ROOT.length + 1)
        : compilerPath.startsWith('zena:')
          ? `${compilerPath.slice('zena:'.length)}.zena`
          : compilerPath);
    if (activeRealStdlibUri !== undefined) {
      return vscode.Uri.joinPath(activeRealStdlibUri, ...rel.split('/'));
    }
    return vscode.Uri.from({
      scheme: STDLIB_SCHEME,
      path: `${STDLIB_ROOT}/${rel}`,
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
  if (activeRealStdlibUri !== undefined) {
    const stdlibPrefix = activeRealStdlibUri.path.endsWith('/')
      ? activeRealStdlibUri.path
      : activeRealStdlibUri.path + '/';
    if (
      normalized === activeRealStdlibUri.path ||
      normalized.startsWith(stdlibPrefix)
    ) {
      return activeRealStdlibUri.with({path: normalized});
    }
  }
  if (referenceUri && referenceUri.scheme !== STDLIB_SCHEME) {
    return referenceUri.with({path: normalized});
  }
  return vscode.Uri.file(normalized);
}

function parentDirUri(uri: vscode.Uri): vscode.Uri | undefined {
  const path = uri.path.replace(/\/+$/, '');
  if (path === '' || path === '/') {
    return undefined;
  }
  const slash = path.lastIndexOf('/');
  const parentPath = slash <= 0 ? '/' : path.slice(0, slash);
  return uri.with({path: parentPath});
}

async function readUtf8IfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function listsPackage(
  rootManifestText: string,
  rootPath: string,
  pkgPath: string,
): boolean {
  try {
    const parsed = JSON.parse(rootManifestText) as {
      workspace?: {packages?: unknown};
    };
    const entries = parsed.workspace?.packages;
    if (!Array.isArray(entries)) {
      return false;
    }
    const cleanRoot = rootPath === '/' ? '' : rootPath.replace(/\/+$/, '');
    const cleanPkg = pkgPath.replace(/\/+$/, '');
    const pkgParentSlash = cleanPkg.lastIndexOf('/');
    const pkgParent =
      pkgParentSlash <= 0 ? '/' : cleanPkg.slice(0, pkgParentSlash);
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.replace(/^\.\//, '').replace(/\/+$/, '');
      if (trimmed.endsWith('/*')) {
        const parentRel = trimmed.slice(0, -2);
        const expectedParent =
          parentRel === '' ? cleanRoot || '/' : `${cleanRoot}/${parentRel}`;
        if (pkgParent === expectedParent) {
          return true;
        }
      } else {
        const expected = `${cleanRoot}/${trimmed}`;
        if (cleanPkg === expected) {
          return true;
        }
      }
    }
  } catch {
    // Ignore malformed manifests while walking ancestors.
  }
  return false;
}

/**
 * Finds the Zena workspace root matching `workspace_root_for` in `zena`:
 * nearest ancestor with `zena-package.json`, promoted to an enclosing
 * workspace root if one lists it in `workspace.packages`.
 */
async function findWorkspaceRootUri(
  seedUri?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const startUri =
    seedUri && seedUri.scheme !== STDLIB_SCHEME
      ? (parentDirUri(seedUri) ?? folderUri)
      : folderUri;
  if (!startUri) {
    return undefined;
  }

  let packageDir: vscode.Uri | undefined;
  for (
    let cur: vscode.Uri | undefined = startUri;
    cur !== undefined;
    cur = parentDirUri(cur)
  ) {
    const manifest = await readUtf8IfExists(
      vscode.Uri.joinPath(cur, 'zena-package.json'),
    );
    if (manifest !== undefined) {
      packageDir = cur;
      break;
    }
  }
  if (!packageDir) {
    return folderUri ?? startUri;
  }

  for (
    let cur = parentDirUri(packageDir);
    cur !== undefined;
    cur = parentDirUri(cur)
  ) {
    const manifest = await readUtf8IfExists(
      vscode.Uri.joinPath(cur, 'zena-package.json'),
    );
    if (
      manifest !== undefined &&
      listsPackage(manifest, cur.path, packageDir.path)
    ) {
      return cur;
    }
  }
  return packageDir;
}

async function directoryExists(uri: vscode.Uri): Promise<boolean> {
  if (typeof vscode.workspace.fs.readDirectory !== 'function') {
    return false;
  }
  try {
    await vscode.workspace.fs.readDirectory(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the package cache directory (`<cache>/sources/<cid>`) matching
 * `packageCacheDir()` in `zena` without importing `node:*` modules.
 */
async function resolvePackageCachePath(
  workspaceRootUri: vscode.Uri | undefined,
): Promise<string | undefined> {
  const env = (
    globalThis as {process?: {env?: Record<string, string | undefined>}}
  ).process?.env;

  if (workspaceRootUri !== undefined) {
    const inProject = vscode.Uri.joinPath(
      workspaceRootUri,
      '.zena',
      'packages',
    );
    if (
      env?.['ZENA_PROJECT_CACHE'] !== undefined ||
      env?.['ZENA_LOCAL_CACHE'] !== undefined ||
      (await directoryExists(inProject))
    ) {
      return inProject.path;
    }
  }

  if (
    env === undefined ||
    (workspaceRootUri !== undefined && workspaceRootUri.scheme !== 'file')
  ) {
    return undefined;
  }

  const custom = env['ZENA_CACHE_DIR'];
  if (custom) {
    return `${vscode.Uri.file(custom).path.replace(/\/+$/, '')}/packages`;
  }
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg) {
    return `${vscode.Uri.file(xdg).path.replace(/\/+$/, '')}/zena/packages`;
  }
  const localAppData = env['LOCALAPPDATA'];
  if (localAppData) {
    return `${vscode.Uri.file(localAppData).path.replace(/\/+$/, '')}/zena/packages`;
  }
  const home = env['HOME'] || env['USERPROFILE'];
  if (home) {
    return `${vscode.Uri.file(home).path.replace(/\/+$/, '')}/.cache/zena/packages`;
  }
  return workspaceRootUri
    ? vscode.Uri.joinPath(workspaceRootUri, '.zena', 'packages').path
    : undefined;
}

/**
 * Manages the WASM-based Zena compiler and language service instance for VS Code.
 */
export class ZenaCompilerService {
  #service: CompilerBackend | undefined;
  #outputChannel: vscode.OutputChannel;
  #extensionUri: vscode.Uri | undefined;
  #workspaceRootUri: vscode.Uri | undefined;
  #lastDocumentUri: vscode.Uri | undefined;
  #checkState = new Map<
    string,
    {source: string; settled: boolean; promise: Promise<Diagnostic[]>}
  >();
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

  async resolveDefinitionUri(
    file: string,
    referenceUri: vscode.Uri,
  ): Promise<vscode.Uri> {
    if (isStdlibPath(file)) {
      if (activeRealStdlibUri !== undefined) {
        const entry = await this.#readStdlibEntry(file);
        if (entry !== undefined) {
          return vscode.Uri.joinPath(
            activeRealStdlibUri,
            ...entry.relPath.split('/'),
          );
        }
        return uriForCompilerPath(file, referenceUri);
      }
      return vscode.Uri.from({
        scheme: STDLIB_SCHEME,
        path: await this.resolveStdlibUriPath(file),
      });
    }
    return uriForCompilerPath(file, referenceUri);
  }

  async dispose(): Promise<void> {
    const prev = this.#service;
    this.#service = undefined;
    this.#checkState.clear();
    if (prev?.dispose) {
      await prev.dispose();
    }
  }

  async #tryCreateWorkerBackend(
    workerScriptPath: string,
    opts: {
      wasm: Uint8Array;
      stdlibRoot: string;
      target: string;
      workspaceRoot: string | undefined;
      packageCache: string | undefined;
      readFile: (rawPath: string) => Promise<string | undefined>;
      listDir: (rawPath: string) => Promise<string[] | undefined>;
    },
  ): Promise<CompilerBackend | undefined> {
    let WorkerCtor: typeof import('node:worker_threads').Worker | undefined;
    try {
      const workerModuleName = 'node:worker_' + 'threads';
      const wt = (await import(
        workerModuleName
      )) as typeof import('node:worker_threads');
      WorkerCtor = wt.Worker;
    } catch {
      return undefined;
    }
    if (!WorkerCtor) return undefined;

    const worker = new WorkerCtor(workerScriptPath);
    worker.unref();

    let nextId = 1;
    let disposed = false;
    const pending = new Map<
      number,
      {resolve: (val: unknown) => void; reject: (err: Error) => void}
    >();

    const failAll = (err: Error) => {
      for (const entry of pending.values()) {
        entry.reject(err);
      }
      pending.clear();
      worker.unref();
    };

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.kind === 'log') {
        const prefix =
          msg.level === 'error'
            ? '[lsp error]'
            : msg.level === 'warn'
              ? '[lsp warn]'
              : '[lsp]';
        this.#outputChannel.appendLine(`${prefix} ${msg.msg}`);
        return;
      }
      if (msg.kind === 'fs') {
        void (async () => {
          const value =
            msg.op === 'readFile'
              ? await opts.readFile(msg.path)
              : await opts.listDir(msg.path);
          if (!disposed) {
            worker.postMessage({
              kind: 'fsResult',
              id: msg.id,
              value,
            } satisfies WorkerRequest);
          }
        })();
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (pending.size === 0) {
        worker.unref();
      }
      if (msg.kind === 'result') {
        entry.resolve(msg.value);
      } else {
        entry.reject(new Error(msg.message));
      }
    });

    worker.on('error', (err) => {
      if (!disposed) {
        this.#outputChannel.appendLine(
          `[lsp worker error] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
      failAll(err instanceof Error ? err : new Error(String(err)));
    });

    worker.on('exit', (code) => {
      if (!disposed && code !== 0) {
        this.#outputChannel.appendLine(
          `[lsp worker] exited unexpectedly with code ${code}`,
        );
        this.#service = undefined;
      }
      failAll(new Error(`Zena compiler worker exited (code ${code})`));
    });

    const send = <T>(req: WorkerRequest): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (disposed) {
          reject(new Error('Zena compiler worker has been disposed'));
          return;
        }
        if (pending.size === 0) {
          worker.ref();
        }
        pending.set(req.id, {
          resolve: resolve as (val: unknown) => void,
          reject,
        });
        worker.postMessage(req);
      });

    try {
      await send<boolean>({
        kind: 'init',
        id: nextId++,
        wasm: opts.wasm,
        stdlibRoot: opts.stdlibRoot,
        target: opts.target,
        workspaceRoot: opts.workspaceRoot,
        packageCache: opts.packageCache,
      });
    } catch (e) {
      disposed = true;
      await worker.terminate();
      throw e;
    }

    const call = <T>(
      method: Extract<WorkerRequest, {kind: 'call'}>['method'],
      args: unknown[],
    ): Promise<T> =>
      send<T>({
        kind: 'call',
        id: nextId++,
        method,
        args,
      });

    return {
      check: (path, source) => call<Diagnostic[]>('check', [path, source]),
      lint: (path) => call<LintFinding[]>('lint', [path]),
      definition: (path, offset, source) =>
        call<DefinitionInfo | null>('definition', [path, offset, source]),
      hover: (path, offset, source) =>
        call<HoverInfo | null>('hover', [path, offset, source]),
      completions: (path, offset, source) =>
        call<CompletionItem[]>('completions', [path, offset, source]),
      documentSymbols: (path, source) =>
        call<DocumentSymbolInfo[]>('documentSymbols', [path, source]),
      format: (source) => call<string | null>('format', [source]),
      openDocument: (path, source) => {
        void call('openDocument', [path, source]).catch(() => {});
      },
      closeDocument: (path) => {
        void call('closeDocument', [path]).catch(() => {});
      },
      dispose: async () => {
        disposed = true;
        failAll(new Error('Zena compiler worker disposed'));
        await worker.terminate();
      },
    };
  }

  async initialize(extensionUri: vscode.Uri, target?: string): Promise<void> {
    await this.dispose();
    this.#extensionUri = extensionUri;

    const wasmUri = vscode.Uri.joinPath(extensionUri, 'dist', 'compiler.wasm');
    const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);

    const activeDocUri = vscode.window.activeTextEditor?.document.uri;
    this.#workspaceRootUri = await findWorkspaceRootUri(activeDocUri);

    let stdlibRoot = STDLIB_ROOT;
    activeRealStdlibUri = undefined;
    if (this.#workspaceRootUri !== undefined) {
      const candidateStdlib = vscode.Uri.joinPath(
        this.#workspaceRootUri,
        'packages',
        'stdlib',
        'zena',
      );
      const coreIndex = await readUtf8IfExists(
        vscode.Uri.joinPath(candidateStdlib, 'core', 'index.zena'),
      );
      if (coreIndex !== undefined) {
        activeRealStdlibUri = candidateStdlib;
        stdlibRoot = candidateStdlib.path;
      }
    }
    if (activeRealStdlibUri === undefined && extensionUri.scheme === 'file') {
      const bundledStdlib = vscode.Uri.joinPath(extensionUri, 'dist', 'stdlib');
      activeRealStdlibUri = bundledStdlib;
      stdlibRoot = bundledStdlib.path;
    }

    const effectiveTarget =
      target ??
      vscode.workspace
        .getConfiguration?.('zena')
        ?.get<string>('target', DEFAULT_TARGET) ??
      DEFAULT_TARGET;
    const workspaceRoot = this.#workspaceRootUri?.path;
    const packageCache = await resolvePackageCachePath(this.#workspaceRootUri);

    const readFile = async (rawPath: string): Promise<string | undefined> => {
      if (activeRealStdlibUri === undefined || isStdlibPath(rawPath)) {
        const fromStdlib = await this.readStdlibContent(rawPath);
        if (fromStdlib !== undefined) {
          return fromStdlib;
        }
      }
      const normalized = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.path === rawPath || doc.uri.path === normalized) {
          return doc.getText();
        }
      }
      const targetUri = uriForCompilerPath(
        normalized,
        this.#lastDocumentUri ?? this.#workspaceRootUri,
      );
      try {
        const bytes = await vscode.workspace.fs.readFile(targetUri);
        return textDecoder.decode(bytes);
      } catch {
        return undefined;
      }
    };

    const listDir = async (rawPath: string): Promise<string[] | undefined> => {
      if (typeof vscode.workspace.fs.readDirectory !== 'function') {
        return undefined;
      }
      const normalized = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      if (
        activeRealStdlibUri === undefined &&
        (normalized === STDLIB_ROOT || normalized.startsWith(STDLIB_ROOT + '/'))
      ) {
        const rel =
          normalized === STDLIB_ROOT
            ? []
            : normalized.slice(STDLIB_ROOT.length + 1).split('/');
        const virtualStdlibDir = vscode.Uri.joinPath(
          extensionUri,
          'dist',
          'stdlib',
          ...rel,
        );
        try {
          const entries =
            await vscode.workspace.fs.readDirectory(virtualStdlibDir);
          return entries.map(([name]) => name);
        } catch {
          return undefined;
        }
      }
      const targetUri = uriForCompilerPath(
        normalized,
        this.#lastDocumentUri ?? this.#workspaceRootUri,
      );
      try {
        const entries = await vscode.workspace.fs.readDirectory(targetUri);
        return entries.map(([name]) => name);
      } catch {
        return undefined;
      }
    };

    this.#outputChannel.appendLine(
      `Initializing Zena language service (target=${effectiveTarget}, workspace=${workspaceRoot ?? 'none'}, stdlib=${stdlibRoot})`,
    );

    if (extensionUri.scheme === 'file') {
      const workerScriptUri = vscode.Uri.joinPath(
        extensionUri,
        'dist',
        'compiler-worker.cjs',
      );
      this.#service = await this.#tryCreateWorkerBackend(
        workerScriptUri.fsPath,
        {
          wasm: wasmBytes.slice(),
          stdlibRoot,
          target: effectiveTarget,
          workspaceRoot,
          packageCache,
          readFile,
          listDir,
        },
      );
      if (this.#service) {
        this.#outputChannel.appendLine(
          'Zena language service loaded (worker thread)',
        );
        return;
      }
    }

    this.#service = await createCompiler({
      wasm: wasmBytes.slice(),
      stdlibRoot,
      stdlibUrl: null,
      target: effectiveTarget,
      workspaceRoot,
      packageCache,
      console: {
        log: (msg) => this.#outputChannel.appendLine(`[lsp] ${msg}`),
        warn: (msg) => this.#outputChannel.appendLine(`[lsp warn] ${msg}`),
        error: (msg) => this.#outputChannel.appendLine(`[lsp error] ${msg}`),
      },
      readFile,
      listDir,
    });

    this.#outputChannel.appendLine('Zena language service loaded');
  }

  get isReady(): boolean {
    return this.#service !== undefined;
  }

  closeDocument(path: string): void {
    this.#checkState.delete(path);
    // Another open file may import `path`; drop settled cached checks so
    // switching back to an importer re-checks against disk.
    for (const [otherPath, entry] of this.#checkState) {
      if (entry.settled) {
        this.#checkState.delete(otherPath);
      }
    }
    this.#service?.closeDocument(path);
  }

  /**
   * Ensures `path` has been checked with `source`, sharing any in-flight or
   * settled check for the exact same `(path, source)` across concurrent
   * diagnostics, hover, definition, and completion requests.
   */
  #ensureChecked(path: string, source: string): Promise<Diagnostic[]> {
    const existing = this.#checkState.get(path);
    if (existing !== undefined && existing.source === source) {
      return existing.promise;
    }
    if (existing !== undefined && existing.source !== source) {
      // `path` actually changed: other open files may import it, so drop their
      // settled cached results so their next check sees the new exports.
      for (const [otherPath, other] of this.#checkState) {
        if (otherPath !== path && other.settled) {
          this.#checkState.delete(otherPath);
        }
      }
    }
    const entry = {
      source,
      settled: false,
      promise: undefined as unknown as Promise<Diagnostic[]>,
    };
    entry.promise = this.#service!.check(path, source).then(
      (diags) => {
        entry.settled = true;
        return diags;
      },
      (err) => {
        if (this.#checkState.get(path) === entry) {
          this.#checkState.delete(path);
        }
        throw err;
      },
    );
    this.#checkState.set(path, entry);
    return entry.promise;
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
    const diagnostics = await this.#ensureChecked(path, source);

    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const diag of diagnostics) {
      if (diag.line === 0 && diag.start < 0) {
        this.#outputChannel.appendLine(`[diagnostic] ${diag.message}`);
        continue;
      }

      const diagPath = diag.file.length > 0 ? diag.file : path;
      if (diagPath.startsWith('wit:')) {
        continue;
      }
      if (uri.scheme !== STDLIB_SCHEME && isStdlibPath(diagPath)) {
        continue;
      }
      if (
        activeRealStdlibUri !== undefined &&
        diagPath !== path &&
        diagPath.startsWith(activeRealStdlibUri.path + '/')
      ) {
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
    token?: vscode.CancellationToken,
  ): Promise<DefinitionInfo | null> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    try {
      if (source !== undefined) {
        await this.#ensureChecked(path, source);
      }
      if (token?.isCancellationRequested) {
        return null;
      }
      return await this.#service!.definition(path, offset);
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
    token?: vscode.CancellationToken,
  ): Promise<HoverInfo | null> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    try {
      if (source !== undefined) {
        await this.#ensureChecked(path, source);
      }
      if (token?.isCancellationRequested) {
        return null;
      }
      return await this.#service!.hover(path, offset);
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
    token?: vscode.CancellationToken,
  ): Promise<CompletionItem[]> {
    const path = uri.path;
    this.#lastDocumentUri = uri;
    try {
      await this.#ensureChecked(path, source);
      if (token?.isCancellationRequested) {
        return [];
      }
      return await this.#service!.completions(path, offset);
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

  async formatDocument(source: string): Promise<string | null> {
    try {
      return await this.#service!.format(source);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.#outputChannel.appendLine(`Format failed: ${msg}`);
      return null;
    }
  }
}
