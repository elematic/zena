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
import {unindent} from './util.js';

const CHECK_DEBOUNCE_MS = 250;

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

  private setFiles(files: SampleFile[], preserveActive = true) {
    this._isUserProvidedFiles = true;
    this._files = [...files];
    this._fileMap = Object.fromEntries(
      this._files.map((file) => [file.name, file.content]),
    );

    if (this._files.length > 0) {
      const selectedFile = this._files.find((f) => f.selected)?.name;
      if (selectedFile) {
        this.activeFile = selectedFile;
      } else if (!preserveActive || !this._fileMap[this.activeFile]) {
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
        if (scripts.length === 1) {
          filename = 'main.zena';
        } else if (type === 'sample/zena') {
          filename = i === 0 ? 'main.zena' : `module_${i}.zena`;
        } else if (type === 'sample/json') {
          filename = 'config.json';
        } else {
          filename = `file_${i}`;
        }
      }

      let rawContent = script.textContent ?? '';
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

    if (explicitSelected) {
      this.activeFile = explicitSelected;
    } else if (this._fileMap['main.zena'] !== undefined) {
      this.activeFile = 'main.zena';
    } else if (this._files.length > 0) {
      this.activeFile = this._files[0].name;
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
      case 'error':
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
    return this.diagnostics.filter((d) => {
      if (!d.file) return false;
      return (
        d.file === filename ||
        d.file === `./${filename}` ||
        d.file.replace(/^\.\//, '') === filename.replace(/^\.\//, '') ||
        d.file.endsWith(`/${filename}`)
      );
    });
  }

  /** Updates the content of a project file. */
  setFileContent(filename: string, content: string) {
    this._fileMap[filename] = content;
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
    if (!this._fileMap[filename]) return false;

    this._files = this._files.filter((f) => f.name !== filename);
    delete this._fileMap[filename];

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

  private getEntryFile(): string {
    if (this._fileMap['main.zena'] !== undefined) return 'main.zena';
    if (this._fileMap['main'] !== undefined) return 'main';
    return this._files[0]?.name ?? 'main.zena';
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

  /** Compiles and runs the current source, streaming output to consoleLogs. */
  run() {
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
