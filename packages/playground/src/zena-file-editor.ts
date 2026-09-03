import {html, css, type PropertyValues} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  lintGutter,
  setDiagnostics,
  type Diagnostic as CMLintDiagnostic,
} from '@codemirror/lint';
import {Prec} from '@codemirror/state';
import {EditorView, keymap, type ViewUpdate} from '@codemirror/view';
import 'codemirror-elements';
import '@zena-lang/codemirror';
import type {ZenaHoverProvider} from '@zena-lang/codemirror';
import {PlaygroundConnectedElement} from './connected-element.js';

/**
 * A CodeMirror 6 editor connected to a `<zena-project>`.
 *
 * Renders the active file from the connected project (or a specific file if
 * the `filename` attribute is set). Features syntax highlighting, diagnostics,
 * autocompletions, and hover tooltips.
 *
 * ```html
 * <zena-file-editor project="my-project"></zena-file-editor>
 * ```
 */
@customElement('zena-file-editor')
export class ZenaFileEditor extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }

    cm-editor {
      display: block;
      height: 100%;
      width: 100%;
      border: none !important;
      outline: none !important;
    }

    .cm-editor {
      height: 100%;
      border: none !important;
      outline: none !important;
    }

    .cm-editor.cm-focused {
      outline: none !important;
    }

    .cm-gutters {
      border: none !important;
      border-right: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.12)) !important;
      background: transparent;
    }

    .cm-lineNumbers .cm-gutterElement {
      min-width: 20px;
      padding: 0 4px 0 10px;
      text-align: right;
    }

    .cm-foldGutter {
      width: 16px;
    }

    .cm-foldGutter .cm-gutterElement {
      text-align: center;
      padding: 0 2px;
      color: var(--rad-neutral-text-muted, #94a3b8);
      cursor: pointer;
    }

    .cm-foldGutter .cm-gutterElement:hover {
      color: var(--rad-neutral-text-emphasis, #f8fafc);
    }

    .cm-gutter-lint {
      order: -1;
      width: 14px;
    }

    .cm-gutter-lint:not(:has(.cm-lint-marker)) {
      display: none !important;
    }

    .cm-gutter-lint .cm-gutterElement {
      padding: 0 0 0 2px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .cm-lint-marker {
      width: 10px;
      height: 10px;
    }

    .cm-line {
      padding: 0 2px 0 8px;
    }

    .cm-scroller {
      font-family: var(
        --rad-font-family-mono,
        'JetBrains Mono',
        'Fira Code',
        Consolas,
        monospace
      );
      font-size: 0.9rem;
      line-height: 1.6;
    }

    .cm-tooltip-hover {
      background: var(--rad-surface-overlay, #1e293b) !important;
      border: 1px solid var(--rad-color-border-focused, #38bdf8) !important;
      border-radius: var(--rad-border-radius-medium, 6px) !important;
      padding: 8px 12px !important;
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.5),
        0 4px 6px -4px rgba(0, 0, 0, 0.4);
      max-width: 480px;
      font-family: var(
        --rad-font-family-mono,
        'JetBrains Mono',
        'Fira Code',
        Consolas,
        monospace
      );
      font-size: 0.85rem;
      color: var(--rad-neutral-text-normal, #f8fafc);
      z-index: 100;
    }

    .zena-hover-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .zena-hover-signature {
      font-weight: 600;
      color: var(--rad-primary-text-emphasis, #38bdf8);
      white-space: pre-wrap;
      word-break: break-all;
    }

    .zena-hover-doc {
      color: var(--rad-neutral-text-muted, #94a3b8);
      font-size: 0.8rem;
      line-height: 1.4;
      white-space: pre-wrap;
      border-top: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.1));
      padding-top: 4px;
      margin-top: 4px;
    }
  `;

  /** The file to edit. If omitted, edits the project's activeFile. */
  @property({type: String})
  filename?: string;

  /** Selected CodeMirror theme name. */
  @property({type: String})
  theme = 'one-dark';

  @query('cm-editor')
  private codeMirrorEl?: HTMLElement & {
    value?: string;
    editorView?: any;
    addExtensions?: (exts: any[]) => void;
  };

  private currentRenderedFile = '';
  private isSwitchingFile = false;

  private readonly hoverProvider: ZenaHoverProvider = (offset) => {
    const project = this.projectElement;
    if (!project) return Promise.resolve(null);
    return project.queryHover(offset, this.effectiveFilename);
  };

  get effectiveFilename(): string {
    return this.filename ?? this.projectElement?.activeFile ?? 'main.zena';
  }

  override firstUpdated(_changedProperties: PropertyValues) {
    super.firstUpdated(_changedProperties);
    this.#attachCodeMirrorExtensions();
    const targetFile = this.effectiveFilename;
    const content = this.projectElement?.getAllFiles()[targetFile] ?? '';
    this.currentRenderedFile = targetFile;
    if (this.codeMirrorEl) {
      this.isSwitchingFile = true;
      this.codeMirrorEl.value = content;
      this.isSwitchingFile = false;
    }
    this.#updateDiagnostics();
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    const targetFile = this.effectiveFilename;
    const content = this.projectElement?.getAllFiles()[targetFile] ?? '';

    if (this.currentRenderedFile !== targetFile) {
      this.isSwitchingFile = true;
      this.currentRenderedFile = targetFile;
      if (this.codeMirrorEl) {
        this.codeMirrorEl.value = content;
      }
      this.isSwitchingFile = false;
      this.#updateDiagnostics();
    } else {
      const editorDoc =
        this.codeMirrorEl?.editorView?.state?.doc?.toString() ??
        this.codeMirrorEl?.value;
      if (
        this.codeMirrorEl &&
        editorDoc !== undefined &&
        editorDoc !== content &&
        !this.codeMirrorEl.editorView?.hasFocus
      ) {
        this.isSwitchingFile = true;
        this.codeMirrorEl.value = content;
        this.isSwitchingFile = false;
      }
      this.#updateDiagnostics();
    }
  }

  #attachCodeMirrorExtensions() {
    if (!this.codeMirrorEl) return;

    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            this.projectElement?.run();
            return true;
          },
        },
      ]),
    );

    const tabCompletionKeymap = keymap.of([
      {key: 'Tab', run: acceptCompletion},
      ...completionKeymap,
    ]);

    const updateListener = EditorView.updateListener.of(
      (update: ViewUpdate) => {
        if (update.docChanged && !this.isSwitchingFile) {
          const newContent = update.state.doc.toString();
          const project = this.projectElement;
          if (project) {
            const existing = project.getAllFiles()[this.effectiveFilename];
            if (existing !== newContent) {
              project.setFileContent(this.effectiveFilename, newContent);
            }
          }
        }
      },
    );

    const zenaCompletions = async (
      context: CompletionContext,
    ): Promise<CompletionResult | null> => {
      const project = this.projectElement;
      if (!project) return null;

      const word = context.matchBefore(/[\w#.]*/);
      if (!word) return null;
      if (word.from === word.to && !context.explicit) return null;

      const lastDot = word.text.lastIndexOf('.');
      const from = lastDot >= 0 ? word.from + lastDot + 1 : word.from;

      const fullSource = context.state.doc.toString();
      const items = await project.queryCompletions(
        fullSource,
        context.pos,
        this.effectiveFilename,
      );
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

    const gutterTheme = EditorView.theme({
      '.cm-gutters': {
        borderRight:
          '1px solid var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.12)) !important',
        backgroundColor: 'transparent !important',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '20px',
        padding: '0 4px 0 10px',
        textAlign: 'right',
      },
      '.cm-foldGutter': {
        width: '16px',
      },
      '.cm-foldGutter .cm-gutterElement': {
        textAlign: 'center',
        padding: '0 2px',
        color: 'var(--rad-neutral-text-muted, #94a3b8)',
        cursor: 'pointer',
      },
      '.cm-foldGutter .cm-gutterElement:hover': {
        color: 'var(--rad-neutral-text-emphasis, #f8fafc)',
      },
      '.cm-gutter-lint': {
        order: -1,
        width: '14px',
      },
      '.cm-gutter-lint:not(:has(.cm-lint-marker))': {
        display: 'none !important',
      },
      '.cm-gutter-lint .cm-gutterElement': {
        padding: '0 0 0 2px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      '.cm-lint-marker': {
        width: '10px',
        height: '10px',
      },
      '.cm-line': {
        padding: '0 2px 0 8px',
      },
    });

    try {
      if (typeof this.codeMirrorEl.addExtensions === 'function') {
        this.codeMirrorEl.addExtensions([
          Prec.highest(gutterTheme),
          lintGutter(),
          runKeymap,
          tabCompletionKeymap,
          updateListener,
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

  private onCodeInput = (e?: Event) => {
    if (this.isSwitchingFile) return;
    const project = this.projectElement;
    if (!project) return;
    let currentVal: string | undefined;
    if (e && 'transaction' in e && (e as any).transaction?.newDoc) {
      currentVal = (e as any).transaction.newDoc.toString();
    } else if (this.codeMirrorEl?.editorView?.state?.doc) {
      currentVal = this.codeMirrorEl.editorView.state.doc.toString();
    } else {
      currentVal = this.codeMirrorEl?.value;
    }
    if (currentVal !== undefined) {
      const existing = project.getAllFiles()[this.effectiveFilename];
      if (existing !== currentVal) {
        project.setFileContent(this.effectiveFilename, currentVal);
      }
    }
  };

  #updateDiagnostics() {
    const project = this.projectElement;
    if (!project || !this.codeMirrorEl?.editorView) return;
    const diagnostics = project.getFileDiagnostics(this.effectiveFilename);
    const view = this.codeMirrorEl.editorView;
    const doc = view.state?.doc;
    if (!doc) return;

    const rawDiagnostics: CMLintDiagnostic[] = diagnostics.map((d) => {
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

    // CodeMirror setDiagnostics requires diagnostics to be sorted by `from` position.
    rawDiagnostics.sort((a, b) => a.from - b.from || a.to - b.to);

    // Deduplicate identical diagnostics at the same position.
    const cmDiagnostics: CMLintDiagnostic[] = [];
    for (const d of rawDiagnostics) {
      const last = cmDiagnostics[cmDiagnostics.length - 1];
      if (
        last &&
        last.from === d.from &&
        last.to === d.to &&
        last.severity === d.severity &&
        last.message === d.message
      ) {
        continue;
      }
      cmDiagnostics.push(d);
    }

    try {
      view.dispatch(setDiagnostics(view.state, cmDiagnostics));
    } catch (e) {
      console.warn(
        '[Zena Playground] Failed to dispatch CodeMirror diagnostics:',
        e,
      );
    }
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
    return html`
      <cm-editor
        @input=${this.onCodeInput}
        @codemirror-document-change=${this.onCodeInput}
      >
        <cm-lang-zena></cm-lang-zena>
        ${this.renderThemeElement()}
        <cm-hover-zena .hoverProvider=${this.hoverProvider}></cm-hover-zena>
      </cm-editor>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-file-editor': ZenaFileEditor;
  }
}
