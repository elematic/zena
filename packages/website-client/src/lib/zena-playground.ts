import {LitElement, html, css} from 'lit';
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
import {keymap, hoverTooltip} from '@codemirror/view';
import {Prec} from '@codemirror/state';
import 'codemirror-elements';
import './cm-lang-zena.js';
import './cm-themes.js';
import type {
  PlaygroundDiagnostic,
  WorkerResponse,
  WorkerRequest,
  ConsoleEntry,
} from './types.js';

/**
 * Zena Playground Lit Web Component.
 *
 * Embeds CodeMirror editor alongside a live diagnostic & output console pane,
 * powered by the self-hosted Zena compiler running in a Web Worker.
 */
@customElement('zena-playground')
export class ZenaPlayground extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
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

    .main-pane {
      display: flex;
      flex: 1;
      min-height: 0;
      width: 100%;
    }

    .editor-pane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      background: #1e293b;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
    }

    cm-editor {
      width: 100%;
      height: 100%;
      border: none !important;
      outline: none !important;
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace;
      font-size: 14px;
      line-height: 1.5;
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
      width: 380px;
      min-width: 280px;
      display: flex;
      flex-direction: column;
      background: #090d16;
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
      font-size: 0.85rem;
    }

    .console-header {
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
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
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
  `;

  /** Initial Zena source code */
  @property({type: String})
  value = `// Welcome to the Zena Playground!

let greet = (name: String) => {
  return \`Hello \${name}!\`;
};

export let main = () => {
  console.log(greet('Zena Developer'));
};
`;

  /** Path to the lsp.wasm module or WASM binary */
  @property({type: String})
  wasmUrl = '/wasm/lsp.wasm';

  /** Selected CodeMirror theme name */
  @property({type: String})
  theme = 'one-dark';

  @state()
  private status: 'loading' | 'ready' | 'checking' | 'error' = 'loading';

  @state()
  private diagnostics: PlaygroundDiagnostic[] = [];

  @state()
  private consoleLogs: ConsoleEntry[] = [];

  @query('cm-editor')
  private codeMirrorEl?: HTMLElement & {
    value?: string;
    editorView?: any;
    addExtensions?: (exts: any[]) => void;
  };

  private worker?: Worker;
  private checkDebounceTimer?: number;
  private nextRequestId = 1;

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
    this.initWorker();
  }

  override firstUpdated() {
    this.attachCodeMirrorExtensions();
    this.scheduleCheck(0, false);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
  }

  private requestId = 0;

  private pendingHoverResolvers = new Map<
    number,
    (res: WorkerResponse['hover']) => void
  >();

  private pendingCompletionResolvers = new Map<
    number,
    (res: WorkerResponse['completions']) => void
  >();

  public queryHover(
    path: string = 'main.zena',
    offset: number = 0,
  ): Promise<WorkerResponse['hover']> {
    if (!this.worker || this.status === 'loading') {
      return Promise.resolve(null);
    }
    const id = ++this.requestId;
    return new Promise((resolve) => {
      this.pendingHoverResolvers.set(id, resolve);
      this.worker!.postMessage({
        type: 'hover',
        id,
        path,
        offset,
      } as WorkerRequest);
    });
  }

  public queryCompletions(
    path: string = 'main.zena',
    source: string,
    offset: number = 0,
  ): Promise<WorkerResponse['completions']> {
    if (!this.worker || this.status === 'loading') {
      return Promise.resolve([]);
    }
    const id = ++this.requestId;
    return new Promise((resolve) => {
      this.pendingCompletionResolvers.set(id, resolve);
      this.worker!.postMessage({
        type: 'completions',
        id,
        path,
        source,
        offset,
      } as WorkerRequest);
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
      const items = await this.queryCompletions(
        'main.zena',
        fullSource,
        context.pos,
      );
      if (!items || items.length === 0) return null;

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
    console.log(
      '[Zena Playground] Initializing worker. wasmUrl:',
      this.wasmUrl,
    );

    try {
      this.worker = new Worker(
        new URL('./worker/compiler-worker.js', import.meta.url),
        {type: 'module'},
      );
      console.log('[Zena Playground] Worker created successfully.');

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        console.log('[Zena Playground] Received message from worker:', e.data);
        this.handleWorkerResponse(e.data);
      };

      this.worker.onerror = (err) => {
        console.error('[Zena Playground] Worker onerror exception:', err);
        this.status = 'error';
        this.addLog('error', `Worker Exception: ${err.message}`);
      };

      const cacheBustUrl =
        this.wasmUrl +
        (this.wasmUrl.includes('?') ? '&' : '?') +
        't=' +
        Date.now();
      const initReq: WorkerRequest = {
        type: 'init',
        wasmUrl: cacheBustUrl,
      };
      console.log('[Zena Playground] Posting init request to worker:', initReq);
      this.worker.postMessage(initReq);
    } catch (err: any) {
      console.error('[Zena Playground] Exception initializing worker:', err);
      this.status = 'error';
      this.addLog('error', `Failed to start worker: ${err.message || err}`);
    }
  }

  private handleWorkerResponse(res: WorkerResponse) {
    if (res.type === 'ready') {
      this.status = 'ready';
      console.log('[Zena Playground] Compiler worker ready.');
      this.scheduleCheck(0, false);
    } else if (res.type === 'diagnostics') {
      const diags = res.diagnostics || [];
      this.status = diags.some((d) => d.severity === 'error')
        ? 'error'
        : 'ready';
      this.diagnostics = diags;
      this.updateCodeMirrorDiagnostics(this.diagnostics);
    } else if (res.type === 'console') {
      if (res.level && res.message) {
        this.addLog(res.level, res.message);
      }
    } else if (res.type === 'hover' && res.id !== undefined) {
      const resolver = this.pendingHoverResolvers.get(res.id);
      if (resolver) {
        this.pendingHoverResolvers.delete(res.id);
        resolver(res.hover ?? null);
      }
    } else if (res.type === 'completions' && res.id !== undefined) {
      const resolver = this.pendingCompletionResolvers.get(res.id);
      if (resolver) {
        this.pendingCompletionResolvers.delete(res.id);
        resolver(res.completions ?? []);
      }
    } else if (res.type === 'error') {
      this.status = 'error';
      this.addLog('error', res.message || 'Compiler error');
    }
  }

  private updateCodeMirrorDiagnostics(diagnostics: PlaygroundDiagnostic[]) {
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

  private onCodeInput(e: Event) {
    const target = e.target as HTMLElement & {value?: string};
    const code = target.value ?? '';
    // Do NOT mutate this.value = code here to avoid Lit re-render selection reset
    this.scheduleCheck(250, false);
  }

  private scheduleCheck(delayMs: number = 250, shouldRun: boolean = false) {
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
    }
    this.checkDebounceTimer = window.setTimeout(() => {
      this.triggerCheck(shouldRun);
    }, delayMs);
  }

  private triggerCheck(shouldRun: boolean = false) {
    if (!this.worker || this.status === 'loading') return;
    const code = this.codeMirrorEl?.value ?? this.value;

    this.status = 'checking';
    const reqId = this.nextRequestId++;
    const checkReq: WorkerRequest = {
      type: 'check',
      id: reqId,
      path: 'main.zena',
      source: code,
      run: shouldRun,
    };
    this.worker.postMessage(checkReq);
  }

  public runProgram() {
    this.scheduleCheck(0, true);
  }

  private addLog(level: 'log' | 'warn' | 'error' | 'info', message: string) {
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
          <cm-editor
            .value=${this.value}
            @input=${this.onCodeInput}
            @codemirror-document-change=${this.onCodeInput}
          >
            <cm-lang-zena></cm-lang-zena>
            ${this.renderThemeElement()}
            <cm-hover-zena .playground=${this}></cm-hover-zena>
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
    `;
  }
}
