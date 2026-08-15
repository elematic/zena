import {LitElement, html, css, nothing} from 'lit';
import {live} from 'lit/directives/live.js';
import {customElement, property, state, query} from 'lit/decorators.js';
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  setDiagnostics,
  lintGutter,
  type Diagnostic as CMLintDiagnostic,
} from '@codemirror/lint';
import {keymap} from '@codemirror/view';
import {Prec} from '@codemirror/state';
import {lspWasmUrl} from '@zena-lang/language-service';
import 'codemirror-elements';
import '@zena-lang/codemirror';
import type {ZenaHoverProvider} from '@zena-lang/codemirror';
import '@radica/ui/components/tab-group/tab-group.js';
import '@radica/ui/components/tab/tab.js';
import '@radica/ui/components/tab-panel/tab-panel.js';
import '@radica/ui/components/button/button.js';
import '@radica/ui/components/dialog/dialog.js';
import type {
  CompletionItem,
  ConsoleEntry,
  ConsoleLevel,
  Diagnostic,
  HoverInfo,
  WorkerResponse,
  WorkerRequest,
} from './types.js';

/** The single document the playground edits. */
const DOCUMENT_PATH = 'main.zena';

/** How long to wait after a keystroke before re-checking. */
const CHECK_DEBOUNCE_MS = 250;

/**
 * An embeddable Zena playground.
 *
 * A CodeMirror editor with live diagnostics, completions, and hover, next to a
 * console pane, all driven by the self-hosted Zena compiler running as
 * WebAssembly in a Web Worker.
 *
 * ```html
 * <zena-playground></zena-playground>
 * ```
 */
@customElement('zena-playground')
export class ZenaPlayground extends LitElement {
  static override styles = css`
    :host {
      display: grid !important;
      grid-template-rows: min-content 1fr !important;
      width: 100%;
      height: 600px;
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        'Segoe UI',
        Roboto,
        sans-serif;
      background: #0f172a;
      color: #f8fafc;
      border-radius: 12px;
      overflow: hidden;
      box-shadow:
        0 20px 25px -5px rgba(0, 0, 0, 0.5),
        0 8px 10px -6px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .toolbar {
      grid-row: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .main-pane {
      grid-row: 2;
      display: grid;
      grid-template-columns: 1fr 380px;
      grid-template-rows: 1fr;
      min-height: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
    }

    .editor-pane {
      grid-column: 1;
      display: grid;
      grid-template-rows: min-content 1fr;
      min-width: 0;
      min-height: 0;
      height: 100%;
      background: #1e293b;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      overflow: hidden;
    }

    .tabs-header {
      grid-row: 1;
      background: #0f172a;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
    }

    rad-tab-group {
      width: 100%;
      --track-color: transparent;
    }

    rad-tab::part(close-button) {
      display: inline-flex;
      align-items: center;
      line-height: 1;
      height: auto;
      opacity: 0;
      transition: opacity 0.15s ease-in-out;
    }

    rad-tab[active]::part(close-button),
    rad-tab:hover::part(close-button),
    rad-tab:focus-within::part(close-button) {
      opacity: 1;
    }

    rad-tab::part(close-button__button) {
      height: 20px !important;
      width: 20px !important;
      min-height: 0 !important;
      line-height: 1 !important;
    }

    .tab-rename-input {
      background: var(--rad-color-surface-sunken, rgba(0, 0, 0, 0.4));
      border: 1px solid var(--rad-color-border-focused, #38bdf8);
      border-radius: 4px;
      color: #f1f5f9;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.2;
      padding: 1px 6px;
      outline: none;
      width: 100px;
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.3);
    }

    rad-tab-panel {
      display: none !important;
    }

    .tab-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .tab-badge {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .tab-badge-error {
      background-color: #ef4444;
      box-shadow: 0 0 6px rgba(239, 68, 68, 0.7);
    }

    .tab-badge-warning {
      background-color: #f59e0b;
      box-shadow: 0 0 6px rgba(245, 158, 11, 0.7);
    }

    cm-editor {
      grid-row: 2;
      display: grid;
      grid-template-rows: 1fr;
      width: 100%;
      height: 100%;
      min-height: 0;
      border: none !important;
      outline: none !important;
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace;
      font-size: 14px;
      line-height: 1.5;
      overflow: hidden;
    }

    cm-editor .cm-editor,
    .cm-editor,
    .cm-scroller,
    .cm-content {
      min-height: 100% !important;
      height: 100% !important;
      box-sizing: border-box !important;
    }

    .cm-scroller {
      overflow: auto !important;
    }

    /* CodeMirror Dark Tooltip Overrides */
    .cm-tooltip-lint {
      background-color: #0f172a !important;
      border: 1px solid rgba(255, 255, 255, 0.2) !important;
      border-radius: 6px !important;
      color: #f8fafc !important;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.6) !important;
    }

    .cm-diagnostic {
      padding: 6px 10px !important;
      font-family:
        system-ui,
        -apple-system,
        sans-serif !important;
      font-size: 0.85rem !important;
      color: #f8fafc !important;
    }

    .cm-diagnostic-error {
      border-left: 4px solid #ef4444 !important;
      background: rgba(239, 68, 68, 0.2) !important;
      color: #fca5a5 !important;
    }

    .cm-diagnostic-warning {
      border-left: 4px solid #f59e0b !important;
      background: rgba(245, 158, 11, 0.2) !important;
      color: #fde68a !important;
    }

    .console-pane {
      grid-column: 2;
      display: grid;
      grid-template-rows: min-content 1fr;
      min-width: 280px;
      min-height: 0;
      height: 100%;
      background: #090d16;
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
      font-size: 0.85rem;
      overflow: hidden;
    }

    .console-header {
      grid-row: 1;
      padding: 8px 12px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .console-body {
      grid-row: 2;
      min-height: 0;
      height: 100%;
      overflow-y: auto;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .action-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge-primary {
      background: rgba(99, 102, 241, 0.2);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.4);
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
      color: #94a3b8;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #e2e8f0;
    }

    .dot-ready {
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .dot-checking {
      background: #f59e0b;
      animation: pulse 1.5s infinite;
    }

    .dot-error {
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
    }

    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }

    .btn-run {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
      transition: all 0.2s ease;
    }

    .btn-run:hover {
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
      transform: translateY(-1px);
    }

    .btn-run:active {
      transform: translateY(0);
    }

    .run-icon {
      width: 12px;
      height: 12px;
      fill: currentColor;
    }

    .key-shortcut {
      font-size: 0.7rem;
      background: rgba(0, 0, 0, 0.2);
      padding: 1px 5px;
      border-radius: 4px;
      margin-left: 2px;
      opacity: 0.9;
    }

    .btn-clear {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #cbd5e1;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-clear:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    .theme-select {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #cbd5e1;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      outline: none;
      transition: all 0.2s;
    }

    .theme-select:hover {
      background: #334155;
      color: #ffffff;
    }

    .log-item {
      padding: 6px 8px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .log-item-log {
      color: #f8fafc;
      background: rgba(255, 255, 255, 0.03);
    }

    .log-item-info {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.05);
    }

    .log-item-warn {
      color: #fbbf24;
      background: rgba(251, 191, 36, 0.05);
      border-left: 2px solid #fbbf24;
    }

    .log-item-error {
      color: #f87171;
      background: rgba(248, 113, 113, 0.08);
      border-left: 2px solid #f87171;
    }

    .loc-tag {
      font-size: 0.75rem;
      color: #64748b;
    }

    @media (max-width: 768px) {
      .main-pane {
        flex-direction: column;
      }
      .console-pane {
        width: 100%;
        height: 200px;
        border-right: none;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      }
    }

    .cm-zena-hover-tooltip {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      padding: 8px 12px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
      max-width: 450px;
    }

    .cm-zena-hover-label {
      font-size: 0.85rem;
      font-weight: 600;
      color: #38bdf8;
    }

    .cm-zena-hover-doc {
      font-size: 0.8rem;
      color: #cbd5e1;
      font-family:
        system-ui,
        -apple-system,
        sans-serif;
      white-space: pre-wrap;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 4px;
      margin-top: 4px;
    }

    .tabs-header {
      background: #0f172a;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
    }

    rad-tab-group {
      width: 100%;
    }

    rad-tab-group::part(body),
    rad-tab-panel {
      display: none;
    }

    .btn-add-file {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 1.1rem;
      cursor: pointer;
      padding: 0 8px;
      line-height: 1;
    }

    .btn-add-file:hover {
      color: #ffffff;
    }
  `;

  /** Initial Zena source files mapping filenames to code strings. */
  @property({type: Object})
  files?: Record<string, string>;

  /** Initial Zena source code (single file option). */
  @property({type: String})
  value?: string;

  /**
   * Where to load the compiler from.
   *
   * Defaults to the `lsp.wasm` shipped with `@zena-lang/language-service`,
   * resolved relative to this module. Bundlers that understand
   * `new URL(..., import.meta.url)` emit it automatically; set this when
   * yours does not, or to serve the binary from somewhere else.
   */
  @property({type: String})
  wasmUrl = lspWasmUrl;

  /** Selected CodeMirror theme name. */
  @property({type: String})
  theme = 'one-dark';

  /** Currently active file tab name. */
  @state()
  private activeFile = 'main.zena';

  /** Internal dictionary of file names to content. */
  @state()
  private fileMap: Record<string, string> = {
    'main.zena': `import { add, greet } from './math.zena';

export let main = () => {
  console.log(greet('Zena Developer'));
  console.log(\`1 + 2 = \${add(1, 2)}\`);
};
`,
    'math.zena': `export let add = (a: i32, b: i32): i32 => a + b;

export let greet = (name: String): String => {
  return 'Hello ' + name + '!';
};
`,
  };

  @state()
  private status: 'loading' | 'ready' | 'checking' | 'error' = 'loading';

  @state()
  private diagnostics: Diagnostic[] = [];

  @state()
  private consoleLogs: ConsoleEntry[] = [];

  @query('cm-editor')
  private codeMirrorEl?: HTMLElement & {
    value?: string;
    editorView?: any;
    addExtensions?: (exts: any[]) => void;
  };

  @state()
  private editingTab: string | null = null;

  @state()
  private editingName = '';

  @state()
  private deleteTargetFile: string | null = null;

  private worker?: Worker;
  private checkDebounceTimer?: number;
  private nextRequestId = 1;
  private isSwitchingTab = false;

  /** Editor queries in flight, waiting on the worker to answer. */
  private pendingHovers = new Map<number, (hover: HoverInfo | null) => void>();
  private pendingCompletions = new Map<
    number,
    (items: CompletionItem[]) => void
  >();

  /**
   * What `<cm-hover-zena>` calls to fill its tooltip.
   *
   * One bound instance, not an arrow in the template: setting the property
   * rebuilds the CodeMirror extension, so a fresh function each render would
   * rebuild it on every render.
   */
  private readonly hoverProvider: ZenaHoverProvider = (offset) =>
    this.queryHover(offset);

  private get isMac(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/.test(
        navigator.userAgent || navigator.platform || '',
      )
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.files && Object.keys(this.files).length > 0) {
      this.fileMap = {...this.files};
      this.activeFile = Object.keys(this.fileMap)[0];
    } else if (this.value !== undefined) {
      this.fileMap = {'main.zena': this.value};
      this.activeFile = 'main.zena';
    }
    this.initWorker();
  }

  private getAllFiles(): Record<string, string> {
    if (this.codeMirrorEl?.value !== undefined) {
      this.fileMap[this.activeFile] = this.codeMirrorEl.value;
    }
    return {...this.fileMap};
  }

  private getFileDiagnostics(filename: string): Diagnostic[] {
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

  private selectFile(filename: string) {
    if (filename === this.activeFile) return;
    if (this.codeMirrorEl?.value !== undefined) {
      this.fileMap[this.activeFile] = this.codeMirrorEl.value;
    }
    this.isSwitchingTab = true;
    this.activeFile = filename;
    if (this.codeMirrorEl) {
      this.codeMirrorEl.value = this.fileMap[filename] ?? '';
    }
    this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        this.updateCodeMirrorDiagnostics(this.getFileDiagnostics(filename));
        this.isSwitchingTab = false;
      });
    });
  }

  private addFile = () => {
    let baseName = 'module';
    let candidate = `${baseName}.zena`;
    let counter = 1;
    while (this.fileMap[candidate] !== undefined) {
      candidate = `${baseName}_${counter}.zena`;
      counter++;
    }
    this.fileMap = {
      ...this.fileMap,
      [candidate]: `// ${candidate}\n\nexport let example = () => {};\n`,
    };
    this.selectFile(candidate);
    this.startEditingTab(candidate);
  };

  private startEditingTab(filename: string) {
    if (filename === 'main.zena') return;
    this.editingTab = filename;
    this.editingName = filename;
    this.updateComplete.then(() => {
      const input =
        this.shadowRoot?.querySelector<HTMLInputElement>('.tab-rename-input');
      if (input) {
        input.focus();
        const dotIdx = input.value.lastIndexOf('.');
        if (dotIdx > 0) {
          input.setSelectionRange(0, dotIdx);
        } else {
          input.select();
        }
      }
    });
  }

  private commitRename(oldFilename: string) {
    if (this.editingTab !== oldFilename) return;
    let newName = (this.editingName || '').trim();
    this.editingTab = null;

    if (!newName || newName === oldFilename) {
      this.requestUpdate();
      return;
    }
    if (!newName.endsWith('.zena')) {
      newName += '.zena';
    }
    if (newName === oldFilename) {
      this.requestUpdate();
      return;
    }
    if (newName === 'main.zena' || this.fileMap[newName] !== undefined) {
      this.requestUpdate();
      return;
    }

    const nextFiles: Record<string, string> = {};
    for (const [name, content] of Object.entries(this.fileMap)) {
      if (name === oldFilename) {
        nextFiles[newName] = content;
      } else {
        nextFiles[name] = content;
      }
    }
    this.fileMap = nextFiles;
    if (this.activeFile === oldFilename) {
      this.activeFile = newName;
    }
    this.scheduleCheck(0, false);
  }

  private cancelRename() {
    this.editingTab = null;
    this.requestUpdate();
  }

  private getEntryFile(): string {
    if (this.fileMap['main.zena'] !== undefined) return 'main.zena';
    if (this.fileMap['main'] !== undefined) return 'main';
    return Object.keys(this.fileMap)[0] ?? 'main.zena';
  }

  private requestCloseFile(filename: string, e: Event) {
    e.stopPropagation();
    e.preventDefault();
    if (filename === 'main.zena') return;
    this.deleteTargetFile = filename;
  }

  private executeDeleteFile = () => {
    const filename = this.deleteTargetFile;
    this.deleteTargetFile = null;
    if (!filename || filename === 'main.zena') return;

    const filenames = Object.keys(this.fileMap);
    if (filenames.length <= 1) return;

    const nextFiles = {...this.fileMap};
    delete nextFiles[filename];
    this.fileMap = nextFiles;

    if (this.activeFile === filename) {
      const remaining = Object.keys(this.fileMap);
      this.selectFile(remaining[0]);
    }
    this.scheduleCheck(0, false);
  };

  /** Type information at a byte offset — what the hover tooltip shows. */
  queryHover(offset: number): Promise<HoverInfo | null> {
    if (!this.worker || this.status === 'loading') {
      return Promise.resolve(null);
    }
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingHovers.set(id, resolve);
      this.worker!.postMessage({
        type: 'hover',
        id,
        path: this.activeFile,
        offset,
        files: this.getAllFiles(),
      } satisfies WorkerRequest);
    });
  }

  /** Completion proposals at a byte offset in `source`. */
  queryCompletions(source: string, offset: number): Promise<CompletionItem[]> {
    if (!this.worker || this.status === 'loading') {
      return Promise.resolve([]);
    }
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingCompletions.set(id, resolve);
      this.worker!.postMessage({
        type: 'completions',
        id,
        path: this.activeFile,
        source,
        offset,
        files: this.getAllFiles(),
      } satisfies WorkerRequest);
    });
  }

  private attachCodeMirrorExtensions() {
    if (!this.codeMirrorEl) return;

    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            this.runProgram();
            return true;
          },
        },
      ]),
    );

    const tabCompletionKeymap = keymap.of([
      {key: 'Tab', run: acceptCompletion},
      ...completionKeymap,
    ]);

    const zenaCompletions = async (
      context: CompletionContext,
    ): Promise<CompletionResult | null> => {
      const word = context.matchBefore(/[\w#.]*/);
      if (!word) return null;
      if (word.from === word.to && !context.explicit) return null;

      const lastDot = word.text.lastIndexOf('.');
      const from = lastDot >= 0 ? word.from + lastDot + 1 : word.from;

      const fullSource = context.state.doc.toString();
      const items = await this.queryCompletions(fullSource, context.pos);
      if (items.length === 0) return null;

      return {
        from,
        options: items.map((item) => ({
          label: item.label,
          type:
            item.kind === 14
              ? 'keyword'
              : item.kind === 7
                ? 'class'
                : item.kind === 3
                  ? 'function'
                  : item.kind === 2
                    ? 'method'
                    : 'variable',
          detail: item.detail || undefined,
          info: item.doc || undefined,
        })),
      };
    };

    try {
      if (typeof this.codeMirrorEl.addExtensions === 'function') {
        this.codeMirrorEl.addExtensions([
          lintGutter(),
          runKeymap,
          tabCompletionKeymap,
          autocompletion({
            override: [zenaCompletions],
            selectOnOpen: true,
            defaultKeymap: true,
          }),
        ]);
      }
    } catch (err) {
      console.warn(
        '[Zena Playground] Could not attach CodeMirror extensions:',
        err,
      );
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.runProgram();
    }
  };

  private initWorker() {
    try {
      this.worker = new Worker(
        new URL('./worker/compiler-worker.js', import.meta.url),
        {type: 'module'},
      );

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
        this.handleWorkerResponse(e.data);

      this.worker.onerror = (err) => {
        this.status = 'error';
        this.addLog('error', `Worker error: ${err.message}`);
      };

      this.worker.postMessage({
        type: 'init',
        wasmUrl: this.wasmUrl,
      } satisfies WorkerRequest);
    } catch (err) {
      this.status = 'error';
      this.addLog(
        'error',
        `Failed to start the compiler worker: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private handleWorkerResponse(res: WorkerResponse) {
    switch (res.type) {
      case 'ready':
        this.status = 'ready';
        this.scheduleCheck(0, false);
        break;
      case 'diagnostics':
        this.status = res.diagnostics.some((d) => d.severity === 'error')
          ? 'error'
          : 'ready';
        this.diagnostics = res.diagnostics;
        this.updateCodeMirrorDiagnostics(
          this.getFileDiagnostics(this.activeFile),
        );
        break;
      case 'console':
        this.addLog(res.level, res.message);
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
        this.addLog('error', res.message);
        break;
    }
  }

  private updateCodeMirrorDiagnostics(diagnostics: Diagnostic[]) {
    if (!this.codeMirrorEl?.editorView) return;
    const view = this.codeMirrorEl.editorView;
    const doc = view.state?.doc;
    if (!doc) return;

    const cmDiagnostics: CMLintDiagnostic[] = diagnostics.map((d) => {
      const lineNo = Math.min(Math.max(d.line, 1), doc.lines);
      const line = doc.line(lineNo);
      const from = Math.min(line.from + Math.max(d.column - 1, 0), line.to);
      const to = Math.min(from + Math.max(d.length, 1), line.to);
      return {
        from,
        to,
        severity:
          d.severity === 'error'
            ? 'error'
            : d.severity === 'warning'
              ? 'warning'
              : 'info',
        message: d.message,
      };
    });

    try {
      view.dispatch(setDiagnostics(view.state, cmDiagnostics));
    } catch (e) {
      console.warn(
        '[Zena Playground] Failed to dispatch CodeMirror diagnostics:',
        e,
      );
    }
  }

  private onCodeInput() {
    if (this.isSwitchingTab) return;
    if (this.codeMirrorEl?.value !== undefined) {
      this.fileMap[this.activeFile] = this.codeMirrorEl.value;
    }
    this.scheduleCheck(CHECK_DEBOUNCE_MS, false);
  }

  private scheduleCheck(delayMs = CHECK_DEBOUNCE_MS, shouldRun = false) {
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
    }
    this.checkDebounceTimer = window.setTimeout(() => {
      this.triggerCheck(shouldRun);
    }, delayMs);
  }

  private triggerCheck(shouldRun = false) {
    if (!this.worker || this.status === 'loading') return;

    const files = this.getAllFiles();
    const entryPath = this.getEntryFile();
    const entrySource = files[entryPath] ?? '';

    this.status = 'checking';
    this.worker.postMessage({
      type: 'check',
      id: this.nextRequestId++,
      path: entryPath,
      source: entrySource,
      files,
      run: shouldRun,
    } satisfies WorkerRequest);
  }

  /** Compiles and runs the current source, streaming output to the console. */
  runProgram() {
    this.scheduleCheck(0, true);
  }

  private addLog(level: ConsoleLevel, message: string) {
    const entry: ConsoleEntry = {
      id: Date.now() + Math.random(),
      level,
      message,
    };
    this.consoleLogs = [...this.consoleLogs, entry];

    this.updateComplete.then(() => {
      const body = this.shadowRoot?.querySelector('.console-body');
      if (body) {
        body.scrollTop = body.scrollHeight;
      }
    });
  }

  private clearConsole() {
    this.consoleLogs = [];
  }

  private renderThemeElement() {
    switch (this.theme) {
      case 'dracula':
        return html`<cm-theme-dracula></cm-theme-dracula>`;
      case 'github-dark':
        return html`<cm-theme-github-dark></cm-theme-github-dark>`;
      case 'monokai':
        return html`<cm-theme-monokai></cm-theme-monokai>`;
      case 'nord':
        return html`<cm-theme-nord></cm-theme-nord>`;
      case 'vscode-dark':
        return html`<cm-theme-vscode-dark></cm-theme-vscode-dark>`;
      case 'solarized-dark':
        return html`<cm-theme-solarized-dark></cm-theme-solarized-dark>`;
      case 'one-dark':
      default:
        return html`<cm-theme-one-dark></cm-theme-one-dark>`;
    }
  }

  override render() {
    const errorCount = this.diagnostics.filter(
      (d) => d.severity === 'error',
    ).length;
    const warningCount = this.diagnostics.filter(
      (d) => d.severity === 'warning',
    ).length;

    const shortcutLabel = this.isMac ? '⌘↵' : 'Ctrl+Enter';

    return html`
      <div class="toolbar">
        <div class="title-group">
          <span class="badge badge-primary">Zena Playground</span>
          <div class="status-indicator">
            <span
              class="dot ${this.status === 'ready'
                ? 'dot-ready'
                : this.status === 'checking'
                  ? 'dot-checking'
                  : 'dot-error'}"
            ></span>
            <span>
              ${this.status === 'loading'
                ? 'Loading Wasm Compiler...'
                : this.status === 'checking'
                  ? 'Checking...'
                  : this.status === 'error'
                    ? `Error (${errorCount} errors, ${warningCount} warnings)`
                    : 'Ready'}
            </span>
          </div>
        </div>

        <div class="action-group">
          <select
            class="theme-select"
            .value=${this.theme}
            @change=${(e: Event) => {
              this.theme = (e.target as HTMLSelectElement).value;
            }}
            title="Select CodeMirror Theme"
          >
            <option value="one-dark">One Dark</option>
            <option value="dracula">Dracula</option>
            <option value="github-dark">GitHub Dark</option>
            <option value="monokai">Monokai</option>
            <option value="nord">Nord</option>
            <option value="vscode-dark">VS Code Dark</option>
            <option value="solarized-dark">Solarized Dark</option>
          </select>
          <button
            class="btn-run"
            @click=${() => this.runProgram()}
            title="Run Program (${shortcutLabel})"
          >
            <svg class="run-icon" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Run
            <span class="key-shortcut">${shortcutLabel}</span>
          </button>
          <button class="btn-clear" @click=${this.clearConsole}>
            Clear Console
          </button>
        </div>
      </div>

      <div class="main-pane" @keydown=${this.onKeyDown}>
        <div class="editor-pane">
          <div class="tabs-header">
            <rad-tab-group .selected=${this.activeFile}>
              ${Object.keys(this.fileMap).map((filename) => {
                const fileDiags = this.getFileDiagnostics(filename);
                const errorCount = fileDiags.filter(
                  (d) => d.severity === 'error',
                ).length;
                const warningCount = fileDiags.filter(
                  (d) => d.severity === 'warning',
                ).length;
                return html`
                  <rad-tab
                    slot="tabs"
                    panel=${filename}
                    ?active=${this.activeFile === filename}
                    ?closable=${filename !== 'main.zena' &&
                    Object.keys(this.fileMap).length > 1}
                    @click=${() => this.selectFile(filename)}
                    @close=${(e: Event) => this.requestCloseFile(filename, e)}
                    @dblclick=${(e: MouseEvent) => {
                      e.stopPropagation();
                      this.startEditingTab(filename);
                    }}
                  >
                    ${this.editingTab === filename
                      ? html`
                          <input
                            class="tab-rename-input"
                            .value=${this.editingName}
                            @click=${(e: MouseEvent) => e.stopPropagation()}
                            @dblclick=${(e: MouseEvent) => e.stopPropagation()}
                            @input=${(e: InputEvent) => {
                              this.editingName = (
                                e.target as HTMLInputElement
                              ).value;
                            }}
                            @keydown=${(e: KeyboardEvent) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                this.commitRename(filename);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                this.cancelRename();
                              }
                            }}
                            @blur=${() => this.commitRename(filename)}
                          />
                        `
                      : html`
                          <span class="tab-label">
                            ${filename}
                            ${errorCount > 0
                              ? html`<span
                                  class="tab-badge tab-badge-error"
                                  title="${errorCount} error${errorCount === 1
                                    ? ''
                                    : 's'}"
                                ></span>`
                              : warningCount > 0
                                ? html`<span
                                    class="tab-badge tab-badge-warning"
                                    title="${warningCount} warning${warningCount ===
                                    1
                                      ? ''
                                      : 's'}"
                                  ></span>`
                                : nothing}
                          </span>
                        `}
                  </rad-tab>
                `;
              })}
              <button
                class="btn-add-file"
                slot="tabs"
                @click=${this.addFile}
                title="Add file"
              >
                +
              </button>
              ${Object.keys(this.fileMap).map(
                (filename) => html`
                  <rad-tab-panel name=${filename}></rad-tab-panel>
                `,
              )}
            </rad-tab-group>
          </div>
          <cm-editor
            .value=${live(this.fileMap[this.activeFile] ?? '')}
            @input=${this.onCodeInput}
            @codemirror-document-change=${this.onCodeInput}
          >
            <cm-lang-zena></cm-lang-zena>
            ${this.renderThemeElement()}
            <cm-hover-zena .hoverProvider=${this.hoverProvider}></cm-hover-zena>
          </cm-editor>
        </div>

        <div class="console-pane">
          <div class="console-header">
            <span>Output Console</span>
            ${this.diagnostics.length > 0
              ? html`
                  <span style="font-size: 0.75rem; color: #f87171;">
                    ${errorCount} Errors, ${warningCount} Warnings
                  </span>
                `
              : ''}
          </div>
          <div class="console-body">
            ${this.consoleLogs.length === 0
              ? html`
                  <div
                    style="color: #475569; font-style: italic; padding: 4px;"
                  >
                    Click ▶ Run or press ${shortcutLabel} to execute program.
                  </div>
                `
              : this.consoleLogs.map(
                  (log) => html`
                    <div class="log-item log-item-${log.level}">
                      <span>${log.message}</span>
                    </div>
                  `,
                )}
          </div>
        </div>
      </div>

      <rad-dialog
        ?open=${this.deleteTargetFile !== null}
        title="Delete File"
        @close=${() => (this.deleteTargetFile = null)}
      >
        <p
          style="margin: 0; font-size: 14px; line-height: 1.5; color: var(--rad-on-surface-overlay, var(--rad-neutral-text-normal, #cbd5e1));"
        >
          Are you sure you want to delete
          <strong>${this.deleteTargetFile}</strong>?
        </p>
        <div
          slot="footer"
          style="display: flex; justify-content: flex-end; gap: 8px;"
        >
          <rad-button @click=${() => (this.deleteTargetFile = null)}
            >Cancel</rad-button
          >
          <rad-button variant="danger" @click=${this.executeDeleteFile}
            >Delete</rad-button
          >
        </div>
      </rad-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-playground': ZenaPlayground;
  }
}
