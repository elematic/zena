import {LitElement, html, css, type PropertyValues} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {lspWasmUrl} from '@zena-lang/language-service';
import type {
  CompletionItem,
  ConsoleEntry,
  ConsoleLevel,
  Diagnostic,
  HoverInfo,
  PlaygroundStatus,
  ProjectManifest,
  SampleFile,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import type {
  HttpError,
  VirtualFile,
} from './preview-shared/service-worker-api.js';
import {unindent} from './util.js';

const CHECK_DEBOUNCE_MS = 250;

const extensionToMimeType = (filename: string): string | undefined => {
  const dotIndex = filename.lastIndexOf('.');
  const ext =
    dotIndex === -1 ? undefined : filename.slice(dotIndex + 1).toLowerCase();
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'application/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'wasm':
      return 'application/wasm';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'ico':
      return 'image/vnd.microsoft.icon';
    case 'txt':
    case 'zena':
      return 'text/plain; charset=utf-8';
    default:
      return undefined;
  }
};

/**
 * Coordinates project files, compilation worker lifecycle, diagnostics, and
 * console execution output for Zena playground components.
 *
 * Can receive files via slotted `<script type="sample/zena">` tags, a
 * `project-src` URL, a `config` object, or a `files` object.
 *
 * ```html
 * <zena-project id="project">
 *   <script type="sample/zena" filename="main.zena">
 *     export let main = () => {
 *       console.log('Hello world!');
 *     };
 *   </script>
 * </zena-project>
 * ```
 */
@customElement('zena-project')
export class ZenaProject extends LitElement {
  static override styles = css`
    :host {
      display: none !important;
    }
    slot {
      display: none !important;
    }
  `;

  /** A document-relative URL to a project manifest JSON file. */
  @property({attribute: 'project-src'})
  get projectSrc(): string | undefined {
    return this._projectSrc;
  }
  set projectSrc(url: string | undefined) {
    this._projectSrc = url;
    if (url) {
      void this.#loadProjectFromSrc(url);
    }
  }
  private _projectSrc?: string;

  /** Project configuration / manifest. */
  @property({attribute: false})
  get config(): ProjectManifest | undefined {
    return {
      files: Object.fromEntries(
        this._files.map((file) => [
          file.name,
          {
            content: file.content,
            contentType: file.contentType,
            label: file.label,
            hidden: file.hidden,
            selected: file.selected,
          },
        ]),
      ),
    };
  }
  set config(cfg: ProjectManifest | undefined) {
    if (cfg?.files) {
      const sampleFiles: SampleFile[] = Object.entries(cfg.files).map(
        ([name, data]) => ({
          name,
          content: data.content ?? '',
          contentType: data.contentType,
          label: data.label,
          hidden: data.hidden,
          selected: data.selected,
        }),
      );
      this.setFiles(sampleFiles);
    }
  }

  /** Project files mapping or array. */
  @property({attribute: false})
  get files(): SampleFile[] {
    return this._files;
  }
  set files(val: SampleFile[] | Record<string, string> | undefined) {
    if (!val) {
      this.setFiles([]);
      return;
    }
    if (Array.isArray(val)) {
      this.setFiles(val);
    } else {
      const sampleFiles: SampleFile[] = Object.entries(val).map(
        ([name, content]) => ({
          name,
          content,
        }),
      );
      this.setFiles(sampleFiles);
    }
  }

  /** Where to load the compiler from. Defaults to `lsp.wasm`. */
  @property({type: String, attribute: 'wasm-url'})
  wasmUrl = lspWasmUrl;

  /** Whether to suppress unused variable / never-mutated variable warnings. */
  @property({type: Boolean, attribute: 'allow-unused-variables'})
  allowUnusedVariables = false;

  /** Whether this project uses a web preview iframe instead of running `main()`. */
  @property({type: Boolean})
  preview = false;

  /** Current execution / compilation status. */
  @state()
  status: PlaygroundStatus = 'loading';

  /** Currently selected/active filename. */
  @state()
  activeFile = 'main.zena';

  /** Latest diagnostics from compiler. */
  @state()
  diagnostics: Diagnostic[] = [];

  /** Console log entries accumulated from runs. */
  @state()
  consoleLogs: ConsoleEntry[] = [];

  private _files: SampleFile[] = [];
  private _fileMap: Record<string, string> = {};
  private _isUserProvidedFiles = false;

  private worker?: Worker;
  private checkDebounceTimer?: ReturnType<typeof setTimeout>;
  private nextRequestId = 1;
  private mutationObserver?: MutationObserver;

  private pendingHovers = new Map<number, (hover: HoverInfo | null) => void>();
  private pendingCompletions = new Map<
    number,
    (items: CompletionItem[]) => void
  >();
  private pendingCompiles = new Map<
    number,
    (wasm: Uint8Array<ArrayBuffer> | null) => void
  >();
  private compiledWasmCache = new Map<
    string,
    Promise<Uint8Array<ArrayBuffer> | null>
  >();
  private workerReadyDeferred = Promise.withResolvers<void>();

  override connectedCallback() {
    super.connectedCallback();
    this.#initMutationObserver();
    this.#initWorker();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.mutationObserver?.disconnect();
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
    }
    this.worker?.terminate();
    this.worker = undefined;
  }

  override firstUpdated(_changedProperties: PropertyValues) {
    super.firstUpdated(_changedProperties);
    if (!this._isUserProvidedFiles && this._files.length === 0) {
      this.#parseScriptsFromDom();
    }
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has('allowUnusedVariables')) {
      this.dispatchEvent(
        new CustomEvent('diagnostics-changed', {
          bubbles: true,
          composed: true,
          detail: {diagnostics: this.diagnostics},
        }),
      );
    }
  }

  private setFiles(files: SampleFile[], preserveActive = true) {
    this._isUserProvidedFiles = true;
    this._files = [...files];
    this._fileMap = Object.fromEntries(
      this._files.map((file) => [file.name, file.content]),
    );
    this.compiledWasmCache.clear();

    if (this._files.length > 0) {
      const selectedFile = this._files.find((f) => f.selected)?.name;
      if (selectedFile) {
        this.activeFile = selectedFile;
      } else if (
        !preserveActive ||
        this._fileMap[this.activeFile] === undefined
      ) {
        this.activeFile = this._files[0].name;
      }
    } else {
      this.activeFile = 'main.zena';
    }

    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );

    this.scheduleCheck(0, false);
  }

  async #loadProjectFromSrc(url: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load project manifest: ${res.statusText}`);
      }
      const manifest = (await res.json()) as ProjectManifest;
      this.config = manifest;
    } catch (err) {
      this.status = 'error';
      this.#addLog(
        'error',
        `Error loading project config from ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  #initMutationObserver() {
    this.mutationObserver = new MutationObserver(() => {
      if (!this._isUserProvidedFiles) {
        this.#parseScriptsFromDom();
      }
    });
    this.mutationObserver.observe(this, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  }

  #onSlotChange = () => {
    if (!this._isUserProvidedFiles) {
      this.#parseScriptsFromDom();
    }
  };

  #parseScriptsFromDom() {
    const slot = this.shadowRoot?.querySelector('slot');
    const assigned = slot
      ? (slot.assignedNodes({flatten: true}) as HTMLElement[])
      : [];
    const assignedScripts = assigned.filter(
      (n): n is HTMLScriptElement =>
        n.nodeType === Node.ELEMENT_NODE &&
        n.tagName === 'SCRIPT' &&
        (n.getAttribute('type') ?? '').startsWith('sample/'),
    );
    const directScripts = Array.from(
      this.querySelectorAll<HTMLScriptElement>('script[type^="sample/"]'),
    );
    const host = (this.getRootNode() as ShadowRoot)?.host;
    const hostScripts = host
      ? Array.from(
          host.querySelectorAll<HTMLScriptElement>('script[type^="sample/"]'),
        )
      : [];
    const scripts =
      assignedScripts.length > 0
        ? assignedScripts
        : directScripts.length > 0
          ? directScripts
          : hostScripts;

    if (scripts.length === 0) {
      if (this._files.length === 0) {
        this._files = [{name: 'main.zena', content: ''}];
        this._fileMap = {'main.zena': ''};
        this.activeFile = 'main.zena';
        this.dispatchEvent(
          new CustomEvent('files-changed', {
            bubbles: true,
            composed: true,
            detail: {files: this._files, activeFile: this.activeFile},
          }),
        );
      }
      return;
    }

    const parsedFiles: SampleFile[] = [];
    let explicitSelected: string | undefined;

    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      const type = script.getAttribute('type') ?? '';
      let filename = script.getAttribute('filename') ?? '';
      const label = script.getAttribute('label') ?? undefined;
      const hidden = script.hasAttribute('hidden');
      const selected = script.hasAttribute('selected');
      const preserveWhitespace = script.hasAttribute('preserve-whitespace');

      if (!filename) {
        if (type === 'sample/html') {
          filename = 'index.html';
        } else if (type === 'sample/js' || type === 'sample/javascript') {
          filename = 'index.js';
        } else if (type === 'sample/css') {
          filename = 'style.css';
        } else if (scripts.length === 1) {
          filename = 'main.zena';
        } else if (type === 'sample/zena') {
          filename = i === 0 ? 'main.zena' : `module_${i}.zena`;
        } else if (type === 'sample/json') {
          filename = 'config.json';
        } else {
          filename = `file_${i}`;
        }
      }

      let rawContent = (script.textContent ?? '')
        .replace(/<\\\/script>/gi, '</script>')
        .replace(/&lt;\\?\/script(?:>|&gt;)/gi, '</script>');
      const content = preserveWhitespace ? rawContent : unindent(rawContent);

      if (selected) {
        explicitSelected = filename;
      }

      parsedFiles.push({
        name: filename,
        content,
        contentType: type.replace(/^sample\//, ''),
        label,
        hidden,
        selected,
      });
    }

    this._files = parsedFiles;
    this._fileMap = Object.fromEntries(
      this._files.map((file) => [file.name, file.content]),
    );
    this.compiledWasmCache.clear();

    if (explicitSelected) {
      this.activeFile = explicitSelected;
    } else if (this._fileMap['main.zena'] !== undefined) {
      this.activeFile = 'main.zena';
    } else {
      const firstZena = this._files.find((f) => f.name.endsWith('.zena'));
      if (firstZena) {
        this.activeFile = firstZena.name;
      } else if (this._files.length > 0) {
        this.activeFile = this._files[0].name;
      }
    }

    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );

    this.scheduleCheck(0, false);
  }

  #initWorker() {
    this.workerReadyDeferred = Promise.withResolvers<void>();
    try {
      this.worker = new Worker(
        new URL('./worker/compiler-worker.js', import.meta.url),
        {type: 'module'},
      );

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
        this.#handleWorkerResponse(e.data);

      this.worker.onerror = (err) => {
        this.status = 'error';
        this.#addLog('error', `Worker error: ${err.message}`);
        this.#dispatchStatusChanged();
      };

      this.worker.postMessage({
        type: 'init',
        wasmUrl: this.wasmUrl,
      } satisfies WorkerRequest);
    } catch (err) {
      this.status = 'error';
      this.#addLog(
        'error',
        `Failed to start the compiler worker: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.#dispatchStatusChanged();
    }
  }

  #handleWorkerResponse(res: WorkerResponse) {
    switch (res.type) {
      case 'ready':
        this.status = 'ready';
        this.workerReadyDeferred.resolve();
        this.#dispatchStatusChanged();
        this.scheduleCheck(0, false);
        break;
      case 'diagnostics':
        this.status = res.diagnostics.some((d) => d.severity === 'error')
          ? 'error'
          : 'ready';
        this.diagnostics = res.diagnostics;
        this.#dispatchStatusChanged();
        this.dispatchEvent(
          new CustomEvent('diagnostics-changed', {
            bubbles: true,
            composed: true,
            detail: {diagnostics: this.diagnostics},
          }),
        );
        break;
      case 'console':
        this.#addLog(res.level, res.message);
        break;
      case 'hover':
        this.pendingHovers.get(res.id)?.(res.hover);
        this.pendingHovers.delete(res.id);
        break;
      case 'completions':
        this.pendingCompletions.get(res.id)?.(res.completions);
        this.pendingCompletions.delete(res.id);
        break;
      case 'compile':
        this.status = res.diagnostics.some((d) => d.severity === 'error')
          ? 'error'
          : 'ready';
        this.diagnostics = res.diagnostics;
        this.#dispatchStatusChanged();
        this.dispatchEvent(
          new CustomEvent('diagnostics-changed', {
            bubbles: true,
            composed: true,
            detail: {diagnostics: this.diagnostics},
          }),
        );
        this.pendingCompiles.get(res.id)?.(res.wasm);
        this.pendingCompiles.delete(res.id);
        break;
      case 'error':
        if (res.id !== undefined && this.pendingCompiles.has(res.id)) {
          this.pendingCompiles.get(res.id)?.(null);
          this.pendingCompiles.delete(res.id);
        }
        this.status = 'error';
        this.#addLog('error', res.message);
        this.#dispatchStatusChanged();
        break;
    }
  }

  #dispatchStatusChanged() {
    this.dispatchEvent(
      new CustomEvent('status-changed', {
        bubbles: true,
        composed: true,
        detail: {status: this.status},
      }),
    );
  }

  #addLog(level: ConsoleLevel, message: string) {
    this.addConsoleLog(level, message);
  }

  /** Appends an entry to the project console log. */
  addConsoleLog(level: ConsoleLevel, message: string) {
    const entry: ConsoleEntry = {
      id: Date.now() + Math.random(),
      level,
      message,
    };
    this.consoleLogs = [...this.consoleLogs, entry];
    this.dispatchEvent(
      new CustomEvent('console-changed', {
        bubbles: true,
        composed: true,
        detail: {consoleLogs: this.consoleLogs, entry},
      }),
    );
  }

  /** Clears all accumulated console logs. */
  clearConsole() {
    this.consoleLogs = [];
    this.dispatchEvent(
      new CustomEvent('console-changed', {
        bubbles: true,
        composed: true,
        detail: {consoleLogs: this.consoleLogs},
      }),
    );
  }

  /** Returns all project files as a filename-to-content map. */
  getAllFiles(): Record<string, string> {
    return {...this._fileMap};
  }

  /** Returns diagnostics that apply to a specific filename. */
  getFileDiagnostics(filename: string): Diagnostic[] {
    const fileContent = this._fileMap[filename] ?? '';
    const ignoreUnused =
      this.allowUnusedVariables ||
      fileContent.includes('// @allow-unused') ||
      fileContent.includes('// @allow-unused-variables') ||
      fileContent.includes('// @no-unused-warnings');

    return this.diagnostics.filter((d) => {
      if (!d.file) return false;
      const matchesFile =
        d.file === filename ||
        d.file === `./${filename}` ||
        d.file.replace(/^\.\//, '') === filename.replace(/^\.\//, '') ||
        d.file.endsWith(`/${filename}`);
      if (!matchesFile) return false;

      if (ignoreUnused && d.severity === 'warning') {
        if (
          d.message.includes('is never read') ||
          d.message.includes('is declared as mutable but never written to')
        ) {
          return false;
        }
      }

      return true;
    });
  }

  /** Updates the content of a project file. */
  setFileContent(filename: string, content: string) {
    this._fileMap[filename] = content;
    this.compiledWasmCache.clear();
    const fileIndex = this._files.findIndex((f) => f.name === filename);
    if (fileIndex >= 0) {
      this._files[fileIndex] = {...this._files[fileIndex], content};
    } else {
      this._files.push({name: filename, content});
    }

    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );

    this.scheduleCheck(CHECK_DEBOUNCE_MS, false);
  }

  /** Selects a file tab as the currently active file. */
  selectFile(filename: string) {
    if (this.activeFile === filename) return;
    this.activeFile = filename;
    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );
  }

  /** Creates and selects a new file. */
  addFile(filename?: string, content = '// New file\n'): string {
    let candidate = filename;
    if (!candidate) {
      const baseName = 'module';
      candidate = `${baseName}.zena`;
      let counter = 1;
      while (this._fileMap[candidate] !== undefined) {
        candidate = `${baseName}_${counter}.zena`;
        counter++;
      }
    }

    this._files.push({name: candidate, content});
    this._fileMap[candidate] = content;
    this.compiledWasmCache.clear();
    this.activeFile = candidate;

    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );

    this.scheduleCheck(0, false);
    return candidate;
  }

  /** Renames a project file. */
  renameFile(oldFilename: string, newFilename: string): boolean {
    if (!newFilename || oldFilename === newFilename) return false;
    if (this._fileMap[newFilename] !== undefined) return false;

    const content = this._fileMap[oldFilename] ?? '';
    const nextFiles = this._files.map((f) =>
      f.name === oldFilename ? {...f, name: newFilename} : f,
    );

    delete this._fileMap[oldFilename];
    this._fileMap[newFilename] = content;
    this._files = nextFiles;
    this.compiledWasmCache.clear();

    if (this.activeFile === oldFilename) {
      this.activeFile = newFilename;
    }

    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );

    this.scheduleCheck(0, false);
    return true;
  }

  /** Deletes a project file. */
  deleteFile(filename: string): boolean {
    if (this._files.length <= 1) return false;
    if (this._fileMap[filename] === undefined) return false;

    this._files = this._files.filter((f) => f.name !== filename);
    delete this._fileMap[filename];
    this.compiledWasmCache.clear();

    if (this.activeFile === filename) {
      this.activeFile = this._files[0]?.name ?? 'main.zena';
    }

    this.dispatchEvent(
      new CustomEvent('files-changed', {
        bubbles: true,
        composed: true,
        detail: {files: this._files, activeFile: this.activeFile},
      }),
    );

    this.scheduleCheck(0, false);
    return true;
  }

  private getEntryFile(): string | undefined {
    if (this._fileMap['main.zena'] !== undefined) return 'main.zena';
    if (this._fileMap['main'] !== undefined) return 'main';
    const firstZena = this._files.find((f) => f.name.endsWith('.zena'));
    return firstZena?.name;
  }

  /**
   * Resolves the entry `.html` file for preview mode:
   * returns the single `.html` file if there is only one, or `index.html` if
   * there are multiple `.html` files.
   */
  getPreviewHtmlFile(): string | undefined {
    const htmlFiles = this._files.filter((f) => f.name.endsWith('.html'));
    if (htmlFiles.length === 0) return undefined;
    if (htmlFiles.length === 1) return htmlFiles[0].name;
    const indexHtml = htmlFiles.find((f) => f.name === 'index.html');
    return indexHtml ? indexHtml.name : htmlFiles[0].name;
  }

  /** Schedules a compiler type-check after debounce delay. */
  scheduleCheck(delayMs = CHECK_DEBOUNCE_MS, shouldRun = false) {
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
    }
    this.checkDebounceTimer = setTimeout(() => {
      this.#triggerCheck(shouldRun);
    }, delayMs);
  }

  #triggerCheck(shouldRun = false) {
    if (!this.worker || this.status === 'loading') return;

    const files = this.getAllFiles();
    const entryPath = this.getEntryFile();
    if (!entryPath) {
      this.status = 'ready';
      this.diagnostics = [];
      this.#dispatchStatusChanged();
      return;
    }
    const entrySource = files[entryPath] ?? '';

    this.status = 'checking';
    this.#dispatchStatusChanged();

    this.worker.postMessage({
      type: 'check',
      id: this.nextRequestId++,
      path: entryPath,
      source: entrySource,
      files,
      run: shouldRun,
    } satisfies WorkerRequest);
  }

  /**
   * Compiles a `.zena` file in the project to a WebAssembly binary (`Uint8Array`).
   */
  async compileFile(filename: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const cached = this.compiledWasmCache.get(filename);
    if (cached !== undefined) {
      return cached;
    }
    const promise = (async () => {
      await this.workerReadyDeferred.promise;
      if (!this.worker) return null;
      const files = this.getAllFiles();
      const source = files[filename];
      if (source === undefined) return null;

      const id = this.nextRequestId++;
      return new Promise<Uint8Array<ArrayBuffer> | null>((resolve) => {
        this.pendingCompiles.set(id, resolve);
        this.worker!.postMessage({
          type: 'compile',
          id,
          path: filename,
          source,
          files,
        } satisfies WorkerRequest);
      });
    })();
    this.compiledWasmCache.set(filename, promise);
    return promise;
  }

  /**
   * Serves a project file (or compiles `foo.zena` when `foo.wasm` is requested)
   * for `<zena-preview>`'s Service Worker `FileAPI`.
   */
  async getFile(filename: string): Promise<VirtualFile | HttpError> {
    let cleanName = filename;
    while (cleanName.startsWith('./')) {
      cleanName = cleanName.slice(2);
    }
    if (cleanName.startsWith('/')) {
      cleanName = cleanName.slice(1);
    }

    const directContent = this._fileMap[cleanName];
    if (directContent !== undefined) {
      return {
        name: cleanName,
        content: directContent,
        contentType: extensionToMimeType(cleanName),
      };
    }

    if (cleanName.endsWith('.wasm')) {
      const zenaName = cleanName.slice(0, -'.wasm'.length) + '.zena';
      if (this._fileMap[zenaName] !== undefined) {
        const wasm = await this.compileFile(zenaName);
        if (wasm !== null) {
          return {
            name: cleanName,
            content: wasm,
            contentType: 'application/wasm',
          };
        }
        const errors = this.diagnostics
          .filter((d) => d.severity === 'error')
          .map((d) => `${d.file}:${d.line}:${d.column}: ${d.message}`)
          .join('\n');
        const msg = errors || `Failed to compile ${zenaName}`;
        this.#addLog('error', msg);
        return {
          status: 500,
          body: msg,
        };
      }
    }

    return {
      status: 404,
      body: `Not found: ${cleanName}`,
    };
  }

  /** Compiles and runs the current source (or reloads the preview iframe). */
  run() {
    if (this.preview) {
      this.scheduleCheck(0, false);
      this.dispatchEvent(
        new CustomEvent('reload-preview', {
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }
    this.scheduleCheck(0, true);
  }

  /** Alias for run(). */
  runProgram() {
    this.run();
  }

  /** Type information at a byte offset — what the hover tooltip shows. */
  queryHover(offset: number, filename?: string): Promise<HoverInfo | null> {
    if (!this.worker || this.status === 'loading') {
      return Promise.resolve(null);
    }
    const id = this.nextRequestId++;
    const path = filename ?? this.activeFile;
    return new Promise((resolve) => {
      this.pendingHovers.set(id, resolve);
      this.worker!.postMessage({
        type: 'hover',
        id,
        path,
        offset,
        files: this.getAllFiles(),
      } satisfies WorkerRequest);
    });
  }

  /** Completion proposals at a byte offset in `source`. */
  queryCompletions(
    source: string,
    offset: number,
    filename?: string,
  ): Promise<CompletionItem[]> {
    if (!this.worker || this.status === 'loading') {
      return Promise.resolve([]);
    }
    const id = this.nextRequestId++;
    const path = filename ?? this.activeFile;
    return new Promise((resolve) => {
      this.pendingCompletions.set(id, resolve);
      this.worker!.postMessage({
        type: 'completions',
        id,
        path,
        source,
        offset,
        files: this.getAllFiles(),
      } satisfies WorkerRequest);
    });
  }

  override render() {
    return html`<slot @slotchange=${this.#onSlotChange}></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-project': ZenaProject;
  }
}
