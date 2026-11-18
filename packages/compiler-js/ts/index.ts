/**
 * JavaScript API for `compiler.wasm` — the Zena compiler, language service,
 * formatter, and linter, compiled to WebAssembly.
 *
 * The module reads files asynchronously: by default it loads `compiler.wasm`
 * and resolves `zena:*` / `/stdlib/*` standard library files from `./stdlib/`
 * (from disk on `file:` URLs or via `fetch()` on HTTP URLs), while callers may
 * supply `readFile` (or {@link createVirtualFileReader}) for project files or
 * in-memory stdlib bundles.
 *
 * ```ts
 * import {createCompiler} from '@zena-lang/compiler';
 *
 * const compiler = await createCompiler();
 * const diagnostics = await compiler.check('main.zena', 'export let main = () => 0;');
 * ```
 */

import {
  createHostAsync,
  createPromiseHost,
  createStringReader,
  createStringWriter,
  createConsoleImports,
  numberImports,
  stringImports,
} from '@zena-lang/runtime';

/**
 * URL of the `compiler.wasm` shipped with this package.
 *
 * Bundlers that understand `new URL(..., import.meta.url)` — Vite, webpack 5,
 * Rollup, Parcel — emit the binary as an asset and rewrite this to its final
 * URL. esbuild leaves the expression alone, so an esbuild-based site has to
 * copy `compiler.wasm` next to its output bundle (or pass an explicit URL).
 */
export const compilerWasmUrl =
  typeof import.meta.url === 'string'
    ? new URL('./compiler.wasm', import.meta.url).href
    : './compiler.wasm';

/** Alias of {@link compilerWasmUrl}. */
export const lspWasmUrl = compilerWasmUrl;

/** Base URL of the `stdlib/` directory shipped alongside `index.js`. */
export const stdlibUrl =
  typeof import.meta.url === 'string'
    ? new URL('./stdlib/', import.meta.url).href
    : './stdlib/';

/** A diagnostic reported by the checker. */
export interface Diagnostic {
  /** File the diagnostic belongs to, as the compiler resolved it. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** 0-based offset into the file. */
  start: number;
  /** Length of the highlighted range. */
  length: number;
  severity: DiagnosticSeverity;
  message: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** Type information for a source position. */
export interface HoverInfo {
  /** Rendered declaration, e.g. `let greet: (name: String) => String`. */
  label: string;
  /** The type alone, when the label is unavailable. */
  type: string;
  /** Doc comment attached to the declaration, if any. */
  doc: string;
}

/**
 * A completion proposal.
 *
 * `kind` is an LSP `CompletionItemKind` — 3 function, 2 method, 7 class,
 * 14 keyword, 6 variable.
 */
export interface CompletionItem {
  label: string;
  kind: number;
  detail: string;
  doc: string;
}

/** Where a symbol is declared. */
export interface DefinitionInfo {
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** 0-based offset into the file. */
  start: number;
  length: number;
}

/** An entry in the document outline. `kind` is an LSP `SymbolKind`. */
export interface DocumentSymbolInfo {
  name: string;
  kind: number;
  start: number;
  end: number;
  /** Range to select when navigating to the symbol — usually its name. */
  selStart: number;
  selEnd: number;
  children: DocumentSymbolInfo[];
}

/**
 * A lint finding: a range of the document and the text that fixes it.
 * `rule` is the lint rule's name, `message` its one-line description.
 */
export interface LintFinding {
  start: number;
  end: number;
  rule: string;
  message: string;
  replacement: string;
  /**
   * A supporting edit (an import the rule's fixes need) rather than a
   * finding: show nothing for it, and apply it with any fix of its rule.
   */
  shared: boolean;
}

/** Anything {@link createCompiler} can instantiate. */
export type WasmSource =
  | WebAssembly.Module
  | BufferSource
  | Response
  | Promise<Response>
  | URL
  | string;

/**
 * Reads a file for the compiler.
 *
 * Called for every import the compiler resolves that is not an open document.
 * Return `undefined` or `null` when the path does not exist, and the compiler
 * reports it as a missing module. It may return a promise, so a host can read
 * from disk or fetch over HTTP when the compiler asks for a file.
 */
export type FileReader = (
  path: string,
) => string | undefined | null | Promise<string | undefined | null>;

/**
 * Lists the entry names in a directory for the compiler (used to expand
 * `workspace.packages` globs and read WIT directories). Return `undefined`
 * or `null` when the path is not a directory.
 */
export type DirReader = (
  path: string,
) => string[] | undefined | null | Promise<string[] | undefined | null>;

/** Sink for `console.*` calls made by checked or compiled Zena code. */
export interface ConsoleSink {
  log?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  info?(message: string): void;
  debug?(message: string): void;
}

export interface CompilerOptions {
  /** Wasm module, bytes, `Response`, or URL. Defaults to {@link compilerWasmUrl}. */
  wasm?: WasmSource;
  /** Resolves imports the service does not have as an open document. */
  readFile?: FileReader;
  /** Lists directory entry names for workspace globs and WIT directories. */
  listDir?: DirReader;
  /** Root the compiler resolves `zena:` imports against. Defaults to `/stdlib`. */
  stdlibRoot?: string;
  /**
   * Base URL (`file://.../` or `https://.../`) of individual stdlib `.zena`
   * files used as fallback when `stdlibRoot` is `/stdlib`. Defaults to
   * {@link stdlibUrl}; pass `null` to disable fallback stdlib loading.
   */
  stdlibUrl?: string | URL | null;
  /** Compilation target (`'zena-component'`, `'component'`, `'core'`, `'js'`, `'zena-js'`). Defaults to `'zena-js'`. */
  target?: string;
  /** Workspace root directory containing `zena-package.json`. */
  workspaceRoot?: string;
  /** Package cache directory containing `sources/<cid>` for `zena-lock.json` pins. */
  packageCache?: string;
  /** Where `console.*` from Zena code goes. Defaults to the global console. */
  console?: ConsoleSink;
}

/** Alias of {@link CompilerOptions}. */
export type LanguageServiceOptions = CompilerOptions;

/**
 * The subset of `compiler.wasm`'s exports this package uses.
 *
 * Handles (`unknown`) are Wasm GC objects held as externrefs: opaque to JS,
 * collected once JS drops them. Field access goes through the getters.
 */
export interface CompilerExports extends WebAssembly.Exports {
  init(stdlibRoot: unknown): Promise<void>;
  initWithOptions?(
    stdlibRoot: unknown,
    target: unknown,
    workspaceRoot: unknown,
    packageCache: unknown,
  ): Promise<void>;
  check(path: unknown, source: unknown): Promise<unknown>;
  checkForTarget?(
    path: unknown,
    source: unknown,
    target: unknown,
  ): Promise<unknown>;
  openDocument?(path: unknown, source: unknown): void;
  closeDocument?(path: unknown): void;
  compileToWasm(path: unknown, source: unknown): Promise<unknown>;
  compileToWasmForTarget?(
    path: unknown,
    source: unknown,
    target: unknown,
  ): Promise<unknown>;
  format(source: unknown): unknown;
  getByteArrayLength(bytes: unknown): number;
  getByteArrayByte(bytes: unknown, index: number): number;
  getDiagnosticCount(diagnostics: unknown): number;
  getDiagnosticLine(diagnostics: unknown, index: number): number;
  getDiagnosticColumn(diagnostics: unknown, index: number): number;
  getDiagnosticStart(diagnostics: unknown, index: number): number;
  getDiagnosticLength(diagnostics: unknown, index: number): number;
  getDiagnosticSeverity(diagnostics: unknown, index: number): number;
  getDiagnosticMessage(diagnostics: unknown, index: number): unknown;
  getDiagnosticFile(diagnostics: unknown, index: number): unknown;
  getHover(path: unknown, offset: number): unknown;
  getHoverType(hover: unknown): unknown;
  getHoverLabel(hover: unknown): unknown;
  getHoverDoc(hover: unknown): unknown;
  getCompletions(path: unknown, offset: number): unknown;
  getCompletionCount(items: unknown): number;
  getCompletionItem(items: unknown, index: number): unknown;
  getCompletionLabel(item: unknown): unknown;
  getCompletionKind(item: unknown): number;
  getCompletionDetail(item: unknown): unknown;
  getCompletionDoc(item: unknown): unknown;
  lint(path: unknown): unknown;
  getLintCount(findings: unknown): number;
  getLintStart(findings: unknown, index: number): number;
  getLintEnd(findings: unknown, index: number): number;
  getLintRule(findings: unknown, index: number): unknown;
  getLintMessage(findings: unknown, index: number): unknown;
  getLintReplacement(findings: unknown, index: number): unknown;
  getLintShared(findings: unknown, index: number): number;
  getDefinition(path: unknown, offset: number): unknown;
  getDefinitionFile(result: unknown): unknown;
  getDefinitionLine(result: unknown): number;
  getDefinitionColumn(result: unknown): number;
  getDefinitionStart(result: unknown): number;
  getDefinitionLength(result: unknown): number;
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
  $stringGetByte?(str: unknown, index: number): number;
  $stringGetLength?(str: unknown): number;
  $stringCreate?(lenOrHandle: number | string): unknown;
  $stringSetByte?(str: unknown, index: number, value: number): void;
  $stringGetHandle?(str: unknown): string;
  [key: string]: any;
}

/** Alias of {@link CompilerExports}. */
export type LspExports = CompilerExports;

/** Normalizes paths to leading slash (e.g. '/math.zena') for absolute compiler lookups. */
const normalizePath = (path: string): string => {
  let p = path;
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/./')) p = '/' + p.slice(3);
  return p.startsWith('/') || p.startsWith('zena:') ? p : '/' + p;
};

/** Normalizes paths to clean relative filename (e.g. 'math.zena'). */
const cleanPath = (path: string): string => {
  let p = path;
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  return p;
};

// Kept in a variable so browser/worker bundlers (Vite, Rollup, esbuild) do not
// rewrite or attempt to bundle `node:fs/promises` statically.
const nodeFsPromisesSpecifier = 'node:fs/promises';
let nodeFsPromise: Promise<any> | undefined;
const getNodeFs = (): Promise<any> =>
  (nodeFsPromise ??= import(/* webpackIgnore: true */ nodeFsPromisesSpecifier));

const stdlibFileCache = new Map<string, Promise<string | undefined>>();

const readUrlText = (url: URL): Promise<string | undefined> => {
  const key = url.href;
  let pending = stdlibFileCache.get(key);
  if (pending === undefined) {
    pending = (async () => {
      try {
        if (url.protocol === 'file:') {
          const fs = await getNodeFs();
          return (await fs.readFile(url, 'utf8')) as string;
        }
        const res = await fetch(url);
        return res.ok ? await res.text() : undefined;
      } catch {
        return undefined;
      }
    })();
    stdlibFileCache.set(key, pending);
  }
  return pending;
};

/**
 * Candidate relative paths inside `stdlib/` for a `zena:*` or `/stdlib/*` path,
 * ordered so already-resolved `.zena` paths hit on the first probe.
 */
export function stdlibRelativeCandidates(
  rawPath: string,
  stdlibRoot = '/stdlib',
): string[] {
  const path = normalizePath(rawPath);
  const isStdlib =
    rawPath.startsWith('zena:') ||
    rawPath.startsWith(stdlibRoot + '/') ||
    path.startsWith(stdlibRoot + '/');
  if (!isStdlib) {
    return [];
  }
  const rel = rawPath.startsWith('zena:')
    ? rawPath.slice('zena:'.length)
    : rawPath.startsWith(stdlibRoot + '/')
      ? rawPath.slice(stdlibRoot.length + 1)
      : path.slice(stdlibRoot.length + 1);
  if (!rel || rel.includes('..')) {
    return [];
  }
  const out: string[] = [];
  const push = (c: string) => {
    if (!out.includes(c)) out.push(c);
  };
  if (rel.endsWith('.zena') || rel.endsWith('.wit')) {
    push(rel);
  } else {
    push(`${rel}.zena`);
    push(`${rel}/index.zena`);
    push(`${rel}/component.zena`);
    push(`${rel}/host.zena`);
    push(rel);
  }
  const base = rel.split('/').pop();
  if (base && base !== rel) {
    push(base.endsWith('.zena') ? base : `${base}.zena`);
  }
  return out;
}

const createBundledStdlibReader = (
  baseUrl: string | URL | null,
  stdlibRoot: string,
): FileReader | undefined => {
  if (baseUrl === null || stdlibRoot !== '/stdlib') {
    return undefined;
  }
  const baseHref = typeof baseUrl === 'string' ? baseUrl : baseUrl.href;
  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
  if (
    !normalizedBase.startsWith('file:') &&
    !normalizedBase.startsWith('http:') &&
    !normalizedBase.startsWith('https:')
  ) {
    return undefined;
  }
  return async (rawPath: string): Promise<string | undefined> => {
    const candidates = stdlibRelativeCandidates(rawPath, stdlibRoot);
    for (const candidate of candidates) {
      const content = await readUrlText(new URL(candidate, normalizedBase));
      if (content !== undefined) {
        return content;
      }
    }
    return undefined;
  };
};

const createBundledStdlibDirReader = (
  baseUrl: string | URL | null,
  stdlibRoot: string,
): DirReader | undefined => {
  if (baseUrl === null || stdlibRoot !== '/stdlib') {
    return undefined;
  }
  const baseHref = typeof baseUrl === 'string' ? baseUrl : baseUrl.href;
  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
  if (!normalizedBase.startsWith('file:')) {
    return undefined;
  }
  return async (rawPath: string): Promise<string[] | undefined> => {
    const path = normalizePath(rawPath).replace(/\/+$/, '');
    if (path !== stdlibRoot && !path.startsWith(stdlibRoot + '/')) {
      return undefined;
    }
    const rel =
      path === stdlibRoot ? '' : path.slice(stdlibRoot.length + 1) + '/';
    if (rel.includes('..')) {
      return undefined;
    }
    try {
      const fs = await getNodeFs();
      return (await fs.readdir(new URL(rel, normalizedBase))) as string[];
    } catch {
      return undefined;
    }
  };
};

/**
 * Loads `compiler.wasm` and returns a compiler and language service bound to it.
 *
 * Each instance owns one Wasm module and one set of open documents, so
 * separate instances are independent. Instantiation is a few megabytes — create
 * one and reuse it.
 */
export async function createCompiler(
  options: CompilerOptions = {},
): Promise<ZenaCompiler> {
  const {
    wasm = compilerWasmUrl,
    readFile,
    listDir,
    stdlibRoot = '/stdlib',
    stdlibUrl: customStdlibUrl = stdlibUrl,
    target,
    workspaceRoot,
    packageCache,
    console: consoleSink,
  } = options;

  const fallbackStdlibReader = createBundledStdlibReader(
    customStdlibUrl,
    stdlibRoot,
  );
  const fallbackStdlibDirReader = createBundledStdlibDirReader(
    customStdlibUrl,
    stdlibRoot,
  );

  let exports: CompilerExports | undefined;
  let readString: ((ref: unknown, len?: number) => string) | undefined;
  let writeString: ((s: string) => unknown) | undefined;

  const openDocuments = new Map<string, string>();

  const readFileImport = async (
    pathRef: unknown,
    pathLen: number,
  ): Promise<string> => {
    const rawPath = readString!(pathRef, pathLen);
    const cleaned = cleanPath(rawPath);
    const normalized = normalizePath(rawPath);
    const contents =
      openDocuments.get(rawPath) ??
      openDocuments.get(cleaned) ??
      openDocuments.get(normalized) ??
      openDocuments.get('./' + cleaned) ??
      (await readFile?.(rawPath)) ??
      (await readFile?.(cleaned)) ??
      (await readFile?.(normalized)) ??
      (await fallbackStdlibReader?.(rawPath));
    if (contents == null) {
      throw new Error(`File not found: ${rawPath}`);
    }
    return contents;
  };
  const listDirImport = async (
    pathRef: unknown,
    pathLen: number,
  ): Promise<string> => {
    const rawPath = readString!(pathRef, pathLen);
    const cleaned = cleanPath(rawPath);
    const normalized = normalizePath(rawPath);
    const entries =
      (await listDir?.(rawPath)) ??
      (await listDir?.(cleaned)) ??
      (await listDir?.(normalized)) ??
      (await fallbackStdlibDirReader?.(rawPath));
    if (entries == null) {
      throw new Error(`Directory not found: ${rawPath}`);
    }
    return [...entries].sort().join('\n');
  };
  const hostAsync = createHostAsync(() => exports);
  const promiseHost = createPromiseHost(() => exports);

  const defaultConsole = createConsoleImports(() => exports);
  const consoleImports: Record<string, Function> = {...defaultConsole};
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const sink = consoleSink?.[level];
    if (sink) {
      consoleImports[`${level}_string`] = (strRef: unknown, len: number) =>
        sink(readString!(strRef, len));
    }
  }

  const imports: WebAssembly.Imports = {
    console: consoleImports,
    compiler: {
      read_file: hostAsync.wrap(readFileImport, 'string'),
      list_dir: hostAsync.wrap(listDirImport, 'string'),
    },
    js: promiseHost.imports as WebAssembly.ModuleImports,
    time: {
      now_ms: () => performance.now(),
      sleep_ms: () => {},
      sleep_cancel: () => {},
    },
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
    },
    'zena:host:string': stringImports,
    'zena:host:number': numberImports,
  };

  const instance = await instantiate(wasm, imports);
  exports = instance.exports as CompilerExports;
  readString = createStringReader(exports);
  writeString = createStringWriter(exports);

  if (
    exports.initWithOptions &&
    (target !== undefined ||
      workspaceRoot !== undefined ||
      packageCache !== undefined)
  ) {
    await exports.initWithOptions(
      writeString(stdlibRoot),
      writeString(target ?? 'zena-js'),
      writeString(workspaceRoot ?? '.'),
      writeString(packageCache ?? ''),
    );
  } else {
    await exports.init(writeString(stdlibRoot));
  }

  return new ZenaCompiler({
    exports,
    readString,
    writeString,
    openDocuments,
    readFile,
    fallbackStdlibReader,
  });
}

/** Alias of {@link createCompiler}. */
export const createLanguageService = createCompiler;

/** Instantiates from whichever of the accepted Wasm sources was given. */
async function instantiate(
  wasm: WasmSource,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const compileOptions = {
    builtins: ['js-string'],
    importedStringConstants: '_',
  };
  if (wasm instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(wasm, imports);
  }

  if (typeof wasm === 'string' || wasm instanceof URL) {
    const href = typeof wasm === 'string' ? wasm : wasm.href;
    if (href.startsWith('file:')) {
      const fs = await getNodeFs();
      const bytes = await fs.readFile(new URL(href));
      const {instance} = await (WebAssembly.instantiate as any)(
        bytes,
        imports,
        compileOptions,
      );
      return instance;
    }
    const response = await fetch(wasm);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${String(wasm)}: ${response.status} ${response.statusText}`,
      );
    }
    return instantiateResponse(response, imports);
  }

  if (isThenable(wasm) || isResponse(wasm)) {
    return instantiateResponse(await wasm, imports);
  }

  const {instance} = await (WebAssembly.instantiate as any)(
    wasm,
    imports,
    compileOptions,
  );
  return instance;
}

async function instantiateResponse(
  response: Response,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const compileOptions = {
    builtins: ['js-string'],
    importedStringConstants: '_',
  };
  if (response.headers.get('content-type')?.startsWith('application/wasm')) {
    const {instance} = await (WebAssembly.instantiateStreaming as any)(
      response,
      imports,
      compileOptions,
    );
    return instance;
  }
  const {instance} = await (WebAssembly.instantiate as any)(
    await response.arrayBuffer(),
    imports,
    compileOptions,
  );
  return instance;
}

const isResponse = (value: unknown): value is Response =>
  typeof Response !== 'undefined' && value instanceof Response;

const isThenable = (value: unknown): value is Promise<Response> =>
  typeof (value as {then?: unknown} | null)?.then === 'function';

/**
 * Compiler and language service bound to one `compiler.wasm` instance.
 *
 * Analysis is stateful: `check()` (or passing `source` to a query) parses and
 * types a document, and the position queries read back from that analysis. A
 * query for a document that was never checked returns nothing.
 */
export class ZenaCompiler {
  readonly #exports: CompilerExports;
  readonly #readString: (ref: unknown, len?: number) => string;
  readonly #writeString: (s: string) => unknown;
  readonly #openDocuments: Map<string, string>;
  readonly #readFile: FileReader | undefined;
  readonly #fallbackStdlibReader: FileReader | undefined;

  /** @internal Use {@link createCompiler}. */
  constructor(init: {
    exports: CompilerExports;
    readString: (ref: unknown, len?: number) => string;
    writeString: (s: string) => unknown;
    openDocuments: Map<string, string>;
    readFile?: FileReader;
    fallbackStdlibReader?: FileReader;
  }) {
    this.#exports = init.exports;
    this.#readString = init.readString;
    this.#writeString = init.writeString;
    this.#openDocuments = init.openDocuments;
    this.#readFile = init.readFile;
    this.#fallbackStdlibReader = init.fallbackStdlibReader;
  }

  /** The raw Wasm exports — an escape hatch for APIs not wrapped here. */
  get exports(): CompilerExports {
    return this.#exports;
  }

  /**
   * Makes `source` the contents of `path` for subsequent compiler file reads,
   * shadowing whatever the `readFile` hook would return.
   */
  openDocument(path: string, source: string): void {
    const cleaned = cleanPath(path);
    const normalized = normalizePath(path);
    this.#openDocuments.set(path, source);
    this.#openDocuments.set(cleaned, source);
    this.#openDocuments.set(normalized, source);
    this.#openDocuments.set('./' + cleaned, source);
    if (this.#exports.openDocument) {
      try {
        this.#exports.openDocument(
          this.#writeString(path),
          this.#writeString(source),
        );
        if (cleaned !== path) {
          this.#exports.openDocument(
            this.#writeString(cleaned),
            this.#writeString(source),
          );
        }
        if (normalized !== path && normalized !== cleaned) {
          this.#exports.openDocument(
            this.#writeString(normalized),
            this.#writeString(source),
          );
        }
      } catch {
        // Document content is registered in JS openDocuments; subsequent check() handles errors.
      }
    }
  }

  /** Drops an open document, so `path` resolves through `readFile` again. */
  closeDocument(path: string): void {
    const cleaned = cleanPath(path);
    const normalized = normalizePath(path);
    this.#openDocuments.delete(path);
    this.#openDocuments.delete(cleaned);
    this.#openDocuments.delete(normalized);
    this.#openDocuments.delete('./' + cleaned);
    if (this.#exports.closeDocument) {
      try {
        this.#exports.closeDocument(this.#writeString(path));
      } catch {
        // Best-effort cache cleanup.
      }
    }
  }

  /**
   * Parses and type checks `path`, and returns everything it found wrong.
   *
   * Pass `source` to check unsaved contents; without it the document's open
   * copy is used, or the `readFile` hook when it was never opened.
   */
  async check(path: string, source?: string): Promise<Diagnostic[]> {
    if (source !== undefined) {
      this.openDocument(path, source);
    }
    const handle = await this.#exports.check(
      this.#writeString(path),
      this.#writeString(await this.#sourceOf(path)),
    );
    const count = this.#exports.getDiagnosticCount(handle);
    const diagnostics: Diagnostic[] = [];
    for (let i = 0; i < count; i++) {
      const severity = this.#exports.getDiagnosticSeverity(handle, i);
      diagnostics.push({
        file: this.#readRef(this.#exports.getDiagnosticFile(handle, i)),
        line: this.#exports.getDiagnosticLine(handle, i),
        column: this.#exports.getDiagnosticColumn(handle, i),
        start: this.#exports.getDiagnosticStart(handle, i),
        length: this.#exports.getDiagnosticLength(handle, i),
        severity:
          severity === 0 ? 'error' : severity === 1 ? 'warning' : 'info',
        message: this.#readRef(this.#exports.getDiagnosticMessage(handle, i)),
      });
    }
    diagnostics.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.line !== b.line) return a.line - b.line;
      if (a.column !== b.column) return a.column - b.column;
      return a.start - b.start;
    });
    return diagnostics;
  }

  /**
   * What the lint rules find in a document, each with its fix.
   */
  async lint(path: string, source?: string): Promise<LintFinding[]> {
    if (source !== undefined) {
      await this.check(path, source);
    }
    const handle = this.#exports.lint(this.#writeString(path));
    const count = this.#exports.getLintCount(handle);
    const findings: LintFinding[] = [];
    for (let i = 0; i < count; i++) {
      findings.push({
        start: this.#exports.getLintStart(handle, i),
        end: this.#exports.getLintEnd(handle, i),
        rule: this.#readRef(this.#exports.getLintRule(handle, i)),
        message: this.#readRef(this.#exports.getLintMessage(handle, i)),
        replacement: this.#readRef(this.#exports.getLintReplacement(handle, i)),
        shared: this.#exports.getLintShared(handle, i) !== 0,
      });
    }
    return findings;
  }

  /**
   * Compiles a document to a WebAssembly binary.
   *
   * Returns `null` when compilation failed; call {@link check} for the reason.
   */
  async compileToWasm(
    path: string,
    source?: string,
    target?: string,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (source !== undefined) {
      this.openDocument(path, source);
    }
    const srcText = await this.#sourceOf(path);
    const handle =
      target !== undefined && this.#exports.compileToWasmForTarget
        ? await this.#exports.compileToWasmForTarget(
            this.#writeString(path),
            this.#writeString(srcText),
            this.#writeString(target),
          )
        : await this.#exports.compileToWasm(
            this.#writeString(path),
            this.#writeString(srcText),
          );
    if (!handle) {
      return null;
    }
    const length = this.#exports.getByteArrayLength(handle);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = this.#exports.getByteArrayByte(handle, i) & 0xff;
    }
    return bytes;
  }

  /** Type information at an offset, or `null` if there is nothing there. */
  async hover(
    path: string,
    offset: number,
    source?: string,
  ): Promise<HoverInfo | null> {
    if (source !== undefined) {
      await this.check(path, source);
    }
    const handle = this.#exports.getHover(this.#writeString(path), offset);
    if (!handle) {
      return null;
    }
    return {
      label: this.#readRef(this.#exports.getHoverLabel(handle)),
      type: this.#readRef(this.#exports.getHoverType(handle)),
      doc: this.#readRef(this.#exports.getHoverDoc(handle)),
    };
  }

  /** Completion proposals for an offset. */
  async completions(
    path: string,
    offset: number,
    source?: string,
  ): Promise<CompletionItem[]> {
    if (source !== undefined) {
      await this.check(path, source);
    }
    const handle = this.#exports.getCompletions(
      this.#writeString(path),
      offset,
    );
    if (!handle) {
      return [];
    }
    const count = this.#exports.getCompletionCount(handle);
    const items: CompletionItem[] = [];
    for (let i = 0; i < count; i++) {
      const item = this.#exports.getCompletionItem(handle, i);
      items.push({
        label: this.#readRef(this.#exports.getCompletionLabel(item)),
        kind: this.#exports.getCompletionKind(item),
        detail: this.#readRef(this.#exports.getCompletionDetail(item)),
        doc: this.#readRef(this.#exports.getCompletionDoc(item)),
      });
    }
    return items;
  }

  /** Where the symbol at an offset is declared. */
  async definition(
    path: string,
    offset: number,
    source?: string,
  ): Promise<DefinitionInfo | null> {
    if (source !== undefined) {
      await this.check(path, source);
    }
    const handle = this.#exports.getDefinition(this.#writeString(path), offset);
    if (!handle) {
      return null;
    }
    return {
      file: this.#readRef(this.#exports.getDefinitionFile(handle)),
      line: this.#exports.getDefinitionLine(handle),
      column: this.#exports.getDefinitionColumn(handle),
      start: this.#exports.getDefinitionStart(handle),
      length: this.#exports.getDefinitionLength(handle),
    };
  }

  /** The document outline, as a tree. */
  async documentSymbols(
    path: string,
    source?: string,
  ): Promise<DocumentSymbolInfo[]> {
    if (source !== undefined) {
      this.openDocument(path, source);
    }
    const handle = this.#exports.getDocumentSymbols(
      this.#writeString(path),
      this.#writeString(await this.#sourceOf(path)),
    );
    if (!handle) {
      return [];
    }
    const count = this.#exports.getSymbolCount(handle);
    const symbols: DocumentSymbolInfo[] = [];
    for (let i = 0; i < count; i++) {
      symbols.push(this.#readSymbol(this.#exports.getSymbol(handle, i)));
    }
    return symbols;
  }

  /** Formats a whole document. Returns the source unchanged if it cannot. */
  format(source: string): string {
    try {
      const handle = this.#exports.format(this.#writeString(source));
      return handle ? this.#readRef(handle) : source;
    } catch {
      return source;
    }
  }

  #readSymbol(sym: unknown): DocumentSymbolInfo {
    const childCount = this.#exports.getSymbolChildCount(sym);
    const children: DocumentSymbolInfo[] = [];
    for (let i = 0; i < childCount; i++) {
      children.push(this.#readSymbol(this.#exports.getSymbolChild(sym, i)));
    }
    return {
      name: this.#readRef(this.#exports.getSymbolName(sym)),
      kind: this.#exports.getSymbolKind(sym),
      start: this.#exports.getSymbolStart(sym),
      end: this.#exports.getSymbolEnd(sym),
      selStart: this.#exports.getSymbolSelStart(sym),
      selEnd: this.#exports.getSymbolSelEnd(sym),
      children,
    };
  }

  #readRef(ref: unknown): string {
    return ref
      ? this.#readString(ref, this.#exports.$stringGetLength?.(ref))
      : '';
  }

  async #sourceOf(path: string): Promise<string> {
    return (
      this.#openDocuments.get(path) ??
      this.#openDocuments.get(normalizePath(path)) ??
      (await this.#readFile?.(path)) ??
      (await this.#fallbackStdlibReader?.(path)) ??
      ''
    );
  }
}

export {ZenaCompiler as ZenaLanguageService};

/**
 * A {@link FileReader} over an in-memory file map — what a bundled browser
 * worker (like `<zena-playground>`) uses to serve an inlined stdlib map.
 */
export function createVirtualFileReader(
  files: Record<string, string>,
  stdlibRoot = '/stdlib',
): FileReader {
  return (rawPath: string): string | undefined => {
    const path = normalizePath(rawPath);
    const candidates = [rawPath, path, rawPath + '.zena', path + '.zena'];

    for (const rel of stdlibRelativeCandidates(rawPath, stdlibRoot)) {
      candidates.push(`${stdlibRoot}/${rel}`);
    }

    for (const candidate of candidates) {
      const contents = files[candidate];
      if (contents !== undefined) {
        return contents;
      }
    }
    return undefined;
  };
}

/**
 * A {@link DirReader} over an in-memory file map — lists direct entry names
 * under `rawPath` (for bundled WIT directories like `/stdlib/wit`).
 */
export function createVirtualDirReader(
  files: Record<string, string>,
): DirReader {
  const keys = Object.keys(files);
  return (rawPath: string): string[] | undefined => {
    const norm = normalizePath(rawPath).replace(/\/+$/, '');
    const prefix = norm === '' ? '/' : norm + '/';
    const entries = new Set<string>();
    for (const key of keys) {
      const normKey = normalizePath(key);
      if (normKey.startsWith(prefix)) {
        const rest = normKey.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        if (name.length > 0) {
          entries.add(name);
        }
      }
    }
    return entries.size > 0 ? [...entries].sort() : undefined;
  };
}
