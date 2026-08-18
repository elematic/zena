/**
 * JavaScript API for `lsp.wasm` — the Zena language service and compiler,
 * compiled to WebAssembly.
 *
 * The module is host-agnostic: it never touches the filesystem or the network
 * by itself. Callers supply the Wasm bytes and a `readFile` hook, so the same
 * code runs in a browser (bundled stdlib, see {@link createVirtualFileReader}),
 * in a Web Worker, in Node, and in a VS Code extension host.
 *
 * ```ts
 * import {createLanguageService, lspWasmUrl} from '@zena-lang/language-service';
 *
 * const service = await createLanguageService({wasm: lspWasmUrl});
 * const diagnostics = service.check('main.zena', 'export let main = () => 0;');
 * ```
 */

import {
  createStringReader,
  createStringWriter,
  createConsoleImports,
} from '@zena-lang/runtime';

/**
 * URL of the `lsp.wasm` shipped with this package.
 *
 * Bundlers that understand `new URL(..., import.meta.url)` — Vite, webpack 5,
 * Rollup, Parcel — emit the binary as an asset and rewrite this to its final
 * URL. esbuild leaves the expression alone, so an esbuild-based site has to
 * copy `lsp.wasm` next to its output bundle (or pass an explicit URL).
 */
export const lspWasmUrl = new URL('./lsp.wasm', import.meta.url).href;

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
  /** Length of the highlighted range, in bytes. */
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

/** Anything {@link createLanguageService} can instantiate. */
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
 * Return `undefined` or `null` when the path does not exist; the compiler sees
 * an empty file and reports it as a missing module.
 */
export type FileReader = (path: string) => string | undefined | null;

/** Sink for `console.*` calls made by checked or compiled Zena code. */
export interface ConsoleSink {
  log?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  info?(message: string): void;
  debug?(message: string): void;
}

export interface LanguageServiceOptions {
  /** Wasm module, bytes, `Response`, or URL. Defaults to {@link lspWasmUrl}. */
  wasm?: WasmSource;
  /** Resolves imports the service does not have as an open document. */
  readFile?: FileReader;
  /** Root the compiler resolves `zena:` imports against. Defaults to `/stdlib`. */
  stdlibRoot?: string;
  /** Where `console.*` from Zena code goes. Defaults to the global console. */
  console?: ConsoleSink;
}

/**
 * The subset of `lsp.wasm`'s exports this package uses.
 *
 * Handles (`unknown`) are Wasm GC objects held as externrefs: opaque to JS,
 * collected once JS drops them. Field access goes through the getters.
 */
export interface LspExports extends WebAssembly.Exports {
  init(stdlibRoot: unknown): void;
  check(path: unknown, source: unknown): unknown;
  openDocument?(path: unknown, source: unknown): void;
  closeDocument?(path: unknown): void;
  compileToWasm(path: unknown, source: unknown): unknown;
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
  $stringGetByte(str: unknown, index: number): number;
  $stringGetLength(str: unknown): number;
  $stringCreate(len: number): unknown;
  $stringSetByte(str: unknown, index: number, value: number): void;
  [key: string]: any;
}

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

/**
 * Loads `lsp.wasm` and returns a service bound to it.
 *
 * Each service owns one Wasm instance and one set of open documents, so
 * separate instances are fully independent. Instantiation is not cheap
 * (the binary is a few megabytes) — create one and keep it.
 */
export async function createLanguageService(
  options: LanguageServiceOptions = {},
): Promise<ZenaLanguageService> {
  const {
    wasm = lspWasmUrl,
    readFile,
    stdlibRoot = '/stdlib',
    console: consoleSink,
  } = options;

  // Bound after instantiation; the imports close over these lazily because
  // the module can call back into the host during its own start function.
  let exports: LspExports | undefined;
  let readString: ((ref: unknown, len: number) => string) | undefined;
  let writeString: ((s: string) => unknown) | undefined;

  const openDocuments = new Map<string, string>();

  const readFileImport = (pathRef: unknown, pathLen: number): unknown => {
    const rawPath = readString!(pathRef, pathLen);
    const cleaned = cleanPath(rawPath);
    const normalized = normalizePath(rawPath);
    const contents =
      openDocuments.get(rawPath) ??
      openDocuments.get(cleaned) ??
      openDocuments.get(normalized) ??
      openDocuments.get('./' + cleaned) ??
      readFile?.(rawPath) ??
      readFile?.(cleaned) ??
      readFile?.(normalized);
    if (contents == null) {
      return null;
    }
    return writeString!(contents);
  };

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
    compiler: {read_file: readFileImport},
    // lsp.wasm is built for the host target and does not use WASI, but the
    // stdlib can still import these; stub them so instantiation succeeds.
    wasi_snapshot_preview1: {
      fd_write: () => 0,
      proc_exit: () => 0,
      environ_get: () => 0,
      environ_sizes_get: () => 0,
      clock_time_get: () => 0,
    },
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
    },
  };

  const instance = await instantiate(wasm, imports);
  exports = instance.exports as LspExports;
  readString = createStringReader(exports);
  writeString = createStringWriter(exports);

  exports.init(writeString(stdlibRoot));

  return new ZenaLanguageService({
    exports,
    readString,
    writeString,
    openDocuments,
    readFile,
  });
}

/** Instantiates from whichever of the accepted Wasm sources was given. */
async function instantiate(
  wasm: WasmSource,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  if (wasm instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(wasm, imports);
  }

  if (typeof wasm === 'string' || wasm instanceof URL) {
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

  const {instance} = await WebAssembly.instantiate(wasm, imports);
  return instance;
}

async function instantiateResponse(
  response: Response,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  // Streaming needs an `application/wasm` content type, which not every static
  // server sends. Buffering always works, so fall back to it rather than fail.
  if (response.headers.get('content-type')?.startsWith('application/wasm')) {
    const {instance} = await WebAssembly.instantiateStreaming(
      response,
      imports,
    );
    return instance;
  }
  const {instance} = await WebAssembly.instantiate(
    await response.arrayBuffer(),
    imports,
  );
  return instance;
}

const isResponse = (value: unknown): value is Response =>
  typeof Response !== 'undefined' && value instanceof Response;

const isThenable = (value: unknown): value is Promise<Response> =>
  typeof (value as {then?: unknown} | null)?.then === 'function';

/**
 * The language service bound to one `lsp.wasm` instance.
 *
 * Analysis is stateful: `check()` (or passing `source` to a query) parses and
 * types a document, and the position queries read back from that analysis. A
 * query for a document that was never checked returns nothing.
 *
 * Every method is synchronous — the Wasm module runs on the calling thread.
 * A full check of a large file takes long enough to drop frames, so browsers
 * should run this in a Web Worker.
 */
export class ZenaLanguageService {
  readonly #exports: LspExports;
  readonly #readString: (ref: unknown, len: number) => string;
  readonly #writeString: (s: string) => unknown;
  readonly #openDocuments: Map<string, string>;
  readonly #readFile: FileReader | undefined;

  /** @internal Use {@link createLanguageService}. */
  constructor(init: {
    exports: LspExports;
    readString: (ref: unknown, len: number) => string;
    writeString: (s: string) => unknown;
    openDocuments: Map<string, string>;
    readFile?: FileReader;
  }) {
    this.#exports = init.exports;
    this.#readString = init.readString;
    this.#writeString = init.writeString;
    this.#openDocuments = init.openDocuments;
    this.#readFile = init.readFile;
  }

  /** The raw Wasm exports — an escape hatch for APIs not wrapped here. */
  get exports(): LspExports {
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
      this.#exports.closeDocument(this.#writeString(path));
    }
  }

  /**
   * Parses and type checks `path`, and returns everything it found wrong.
   *
   * Pass `source` to check unsaved contents; without it the document's open
   * copy is used, or the `readFile` hook when it was never opened.
   *
   * This is also what makes the position queries below meaningful: they read
   * the analysis this call leaves behind.
   */
  check(path: string, source?: string): Diagnostic[] {
    if (source !== undefined) {
      this.openDocument(path, source);
    }
    const handle = this.#exports.check(
      this.#writeString(path),
      this.#writeString(this.#sourceOf(path)),
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
    return diagnostics;
  }

  /**
   * Compiles a document to a WebAssembly binary.
   *
   * Returns `null` when compilation failed; call {@link check} for the reason.
   *
   * The `ArrayBuffer` in the return type is not decoration: `BufferSource`
   * excludes views over a `SharedArrayBuffer`, so a plain `Uint8Array` would
   * not be accepted by `WebAssembly.instantiate`.
   */
  compileToWasm(path: string, source?: string): Uint8Array<ArrayBuffer> | null {
    if (source !== undefined) {
      this.openDocument(path, source);
    }
    const handle = this.#exports.compileToWasm(
      this.#writeString(path),
      this.#writeString(this.#sourceOf(path)),
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

  /** Type information at a byte offset, or `null` if there is nothing there. */
  hover(path: string, offset: number, source?: string): HoverInfo | null {
    if (source !== undefined) {
      this.check(path, source);
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

  /** Completion proposals for a byte offset. */
  completions(path: string, offset: number, source?: string): CompletionItem[] {
    if (source !== undefined) {
      this.check(path, source);
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

  /** Where the symbol at a byte offset is declared. */
  definition(
    path: string,
    offset: number,
    source?: string,
  ): DefinitionInfo | null {
    if (source !== undefined) {
      this.check(path, source);
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
  documentSymbols(path: string, source?: string): DocumentSymbolInfo[] {
    if (source !== undefined) {
      this.openDocument(path, source);
    }
    const handle = this.#exports.getDocumentSymbols(
      this.#writeString(path),
      this.#writeString(this.#sourceOf(path)),
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
    const handle = this.#exports.format(this.#writeString(source));
    return handle ? this.#readRef(handle) : source;
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

  /** Reads a Zena `String` handle, whose length only Wasm knows. */
  #readRef(ref: unknown): string {
    return ref
      ? this.#readString(ref, this.#exports.$stringGetLength(ref))
      : '';
  }

  /**
   * The current contents of a document: the open copy if there is one, else
   * whatever the `readFile` hook has. Empty when neither knows the path — the
   * compiler then reports it the way it reports any missing module.
   */
  #sourceOf(path: string): string {
    return (
      this.#openDocuments.get(path) ??
      this.#openDocuments.get(normalizePath(path)) ??
      this.#readFile?.(path) ??
      ''
    );
  }
}

/**
 * A {@link FileReader} over an in-memory file map — what a browser host uses
 * to serve a bundled copy of the stdlib.
 *
 * Keys are paths as the compiler asks for them (`/stdlib/string.zena`) or
 * module specifiers (`zena:collections`). Lookup also tries the obvious
 * variants of a path — leading slash, `.zena` suffix, `zena:` mapped under the
 * stdlib root, and `index.zena`/`host.zena` for a directory — so a map keyed
 * either way resolves.
 */
export function createVirtualFileReader(
  files: Record<string, string>,
  stdlibRoot = '/stdlib',
): FileReader {
  return (rawPath: string): string | undefined => {
    const path = normalizePath(rawPath);
    const candidates = [rawPath, path, rawPath + '.zena', path + '.zena'];

    if (
      rawPath.startsWith('zena:') ||
      rawPath.startsWith(stdlibRoot) ||
      path.startsWith(stdlibRoot)
    ) {
      const module = rawPath.startsWith('zena:')
        ? rawPath.slice('zena:'.length)
        : rawPath.startsWith(stdlibRoot)
          ? rawPath.slice(stdlibRoot.length).replace(/^\//, '')
          : path.slice(stdlibRoot.length).replace(/^\//, '');
      candidates.push(
        `${stdlibRoot}/${module}`,
        `${stdlibRoot}/${module}.zena`,
      );
      if (!module.endsWith('.zena')) {
        candidates.push(
          `${stdlibRoot}/${module}/index.zena`,
          `${stdlibRoot}/${module}/host.zena`,
        );
      }

      // Last resort for stdlib: basename lookup within stdlib root.
      const basename = path.split('/').pop();
      if (basename) {
        candidates.push(
          `${stdlibRoot}/${basename.endsWith('.zena') ? basename : basename + '.zena'}`,
        );
      }
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
