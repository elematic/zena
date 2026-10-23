import {html, css, nothing, type PropertyValues} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';
import {lspWasmUrl} from '@zena-lang/language-service';
import {PlaygroundConnectedElement} from './connected-element.js';
import {ZenaProject} from './zena-project.js';
import './zena-project.js';
import './zena-tab-bar.js';
import './zena-file-editor.js';
import './zena-output.js';
import './zena-console.js';
import './zena-code-export-dialog.js';
import type {ZenaCodeExportDialog} from './zena-code-export-dialog.js';
import {
  exportCodeToPngBlob,
  type ExportCodeImageOptions,
} from './zena-code-export.js';
import '@radica/bootstrap-icons/icons/camera.svg.js';

/**
 * An embeddable Zena playground IDE.
 *
 * Combines project file tabs with theme selection, a CodeMirror editor with
 * live diagnostics and autocompletion, and an output console pane with
 * integrated Run/Clear controls and status indicator.
 *
 * Can accept inline `<script type="sample/zena">` tags or connect to an
 * external `<zena-project>` via the `project` attribute.
 *
 * ```html
 * <zena-playground>
 *   <script type="sample/zena" filename="main.zena">
 *     export let main = () => {
 *       console.log('Hello from Zena!');
 *     };
 *   </script>
 * </zena-playground>
 * ```
 */
@customElement('zena-playground')
export class ZenaPlayground extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: grid !important;
      grid-template-columns:
        minmax(180px, 1fr)
        auto
        clamp(180px, var(--zena-output-width, 380px), calc(100% - 180px));
      grid-template-rows: 1fr;
      width: 100%;
      height: 560px;
      font-family: var(
        --rad-font-family-sans,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        'Segoe UI',
        Roboto,
        sans-serif
      );
      background: var(--rad-surface);
      color: var(--rad-neutral-text-normal);
      border-radius: var(--rad-border-radius-large, 12px);
      overflow: hidden;
      border: 1px solid var(--rad-neutral-stroke-faint);
    }

    :host([preview]) {
      --zena-output-width: 45%;
    }

    :host([resizing]) {
      user-select: none;
      -webkit-user-select: none;
    }

    :host([resizing]) .editor-pane,
    :host([resizing]) .output-pane {
      pointer-events: none;
    }

    zena-project {
      display: none !important;
    }

    .editor-pane {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      height: 100%;
      background: var(--rad-surface-sunken);
      overflow: hidden;
    }

    .pane-resizer {
      position: relative;
      z-index: 15;
      width: 1px;
      height: 100%;
      background: var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.12));
      cursor: col-resize;
      touch-action: none;
      outline: none;
      transition: background-color 0.15s ease;
    }

    .pane-resizer::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: -4px;
      width: 9px;
    }

    .pane-resizer::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 3px;
      height: 28px;
      border-radius: 999px;
      background: var(--rad-neutral-text-muted, #94a3b8);
      opacity: 0;
      transition:
        opacity 0.15s ease,
        background-color 0.15s ease,
        transform 0.15s ease;
      pointer-events: none;
    }

    .pane-resizer:hover,
    .pane-resizer:focus-visible,
    :host([resizing]) .pane-resizer {
      background: var(--zena-c-brand-1, #38bdf8);
    }

    .pane-resizer:hover::after,
    .pane-resizer:focus-visible::after,
    :host([resizing]) .pane-resizer::after {
      opacity: 1;
      background: var(--zena-c-brand-1, #38bdf8);
    }

    .editor-floating-export {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 10;
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--rad-surface-chrome, rgba(30, 41, 59, 0.75));
      border: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.12));
      color: var(--rad-neutral-text-muted, #94a3b8);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      opacity: 0.75;
      transition:
        opacity 0.15s ease,
        transform 0.15s ease,
        background 0.15s ease,
        border-color 0.15s ease,
        color 0.15s ease,
        box-shadow 0.15s ease;
      box-sizing: border-box;
    }

    .editor-floating-export:hover {
      opacity: 1;
      color: var(--rad-neutral-text-normal, #f8fafc);
      background: var(--rad-surface, rgba(45, 55, 72, 0.9));
      border-color: var(--rad-neutral-stroke-strong, rgba(255, 255, 255, 0.25));
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
      transform: scale(1.06);
    }

    .editor-floating-export:active {
      transform: scale(0.96);
    }

    .editor-floating-export::part(button) {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      color: inherit;
      padding: 0;
    }

    zena-file-editor {
      display: block;
      flex: 1;
      min-width: 0;
      min-height: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
    }

    .output-pane {
      min-width: 180px;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }

    zena-output {
      border: none !important;
      border-radius: 0 !important;
      height: 100%;
      min-height: 0;
    }

    :host([vertical]),
    :host([layout='vertical']) {
      grid-template-columns: 1fr;
      grid-template-rows:
        minmax(120px, 1fr)
        auto
        clamp(100px, var(--zena-output-height, 220px), calc(100% - 120px));
    }

    :host([vertical][preview]),
    :host([layout='vertical'][preview]) {
      --zena-output-height: 45%;
    }

    :host([vertical]) .pane-resizer,
    :host([layout='vertical']) .pane-resizer {
      width: 100%;
      height: 1px;
      cursor: row-resize;
    }

    :host([vertical]) .pane-resizer::before,
    :host([layout='vertical']) .pane-resizer::before {
      top: -4px;
      bottom: auto;
      left: 0;
      right: 0;
      width: 100%;
      height: 9px;
    }

    :host([vertical]) .pane-resizer::after,
    :host([layout='vertical']) .pane-resizer::after {
      width: 28px;
      height: 3px;
    }

    @media (max-width: 768px) {
      :host {
        grid-template-columns: 1fr;
        grid-template-rows:
          minmax(120px, 1fr)
          auto
          clamp(100px, var(--zena-output-height, 220px), calc(100% - 120px));
        height: 640px;
      }
      .pane-resizer {
        width: 100%;
        height: 1px;
        cursor: row-resize;
      }
      .pane-resizer::before {
        top: -4px;
        bottom: auto;
        left: 0;
        right: 0;
        width: 100%;
        height: 9px;
      }
      .pane-resizer::after {
        width: 28px;
        height: 3px;
      }
    }
  `;

  /**
   * Layout orientation of the playground.
   * - 'horizontal' (default): side-by-side editor and output panes.
   * - 'vertical': stacked editor (top) and output (bottom) panes.
   */
  @property({type: String, reflect: true})
  layout: 'horizontal' | 'vertical' = 'horizontal';

  /**
   * Shorthand boolean attribute for vertical layout.
   */
  @property({type: Boolean, reflect: true})
  vertical = false;

  /**
   * Tab bar visibility mode:
   * - 'auto' (default): hide when there is only 1 file, show for multi-file projects.
   * - 'always': always show tab bar.
   * - 'never': never show tab bar.
   */
  @property({type: String})
  tabs: 'auto' | 'always' | 'never' = 'auto';

  /** Whether to show the theme selection button (opt-in). */
  @property({type: Boolean, attribute: 'show-theme-selector'})
  showThemeSelector = false;

  /** Initial Zena source files mapping filenames to code strings. */
  @property({type: Object})
  files?: Record<string, string>;

  /** Initial Zena source code (single file option). */
  @property({type: String})
  value?: string;

  /** Where to load the compiler from. Defaults to `lsp.wasm`. */
  @property({type: String, attribute: 'wasm-url'})
  wasmUrl = lspWasmUrl;

  /** Selected CodeMirror theme name. */
  @property({type: String})
  theme = 'one-dark';

  /** Whether to suppress unused variable warnings. */
  @property({type: Boolean, attribute: 'allow-unused-variables'})
  allowUnusedVariables = false;

  /** Whether to show the code image export button. Defaults to true. */
  @property({type: Boolean, attribute: 'show-export-button'})
  showExportButton = true;

  /** Custom watermark text for exported code images. */
  @property({type: String, attribute: 'watermark-text'})
  watermarkText?: string;

  /** Whether to show a sandboxed live web preview iframe in the output pane. */
  @property({type: Boolean, reflect: true})
  preview = false;

  /** Base URL for the preview sandbox origin and service worker files. */
  @property({type: String, attribute: 'sandbox-base-url'})
  sandboxBaseUrl = '/sandbox/';

  @query('zena-project')
  private internalProjectEl?: ZenaProject;

  @query('zena-code-export-dialog')
  private exportDialogEl?: ZenaCodeExportDialog;

  get effectiveProject(): ZenaProject | undefined {
    if (this.project) {
      return typeof this.project === 'string'
        ? (((this.getRootNode() as Document | ShadowRoot)?.getElementById?.(
            this.project,
          ) as ZenaProject | null) ??
            (typeof document !== 'undefined'
              ? (document.getElementById(this.project) as ZenaProject | null)
              : null) ??
            undefined)
        : this.project;
    }
    return (
      this.internalProjectEl ??
      (this.shadowRoot?.querySelector(
        '#internal-project',
      ) as ZenaProject | null) ??
      undefined
    );
  }

  override firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);
    if (!this.project) {
      const internal = this.shadowRoot?.querySelector(
        '#internal-project',
      ) as ZenaProject | null;
      if (internal) {
        internal.addEventListener('status-changed', () => this.requestUpdate());
        internal.addEventListener('diagnostics-changed', () =>
          this.requestUpdate(),
        );
        internal.addEventListener('files-changed', () => this.requestUpdate());
        this.requestUpdate();
      }
    }
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    const target = this.effectiveProject;
    if (target) {
      if (changedProperties.has('preview')) {
        target.preview = this.preview;
      }
      if (changedProperties.has('files') && this.files) {
        target.files = this.files;
      } else if (changedProperties.has('value') && this.value !== undefined) {
        target.files = {'main.zena': this.value};
      }
      if (changedProperties.has('wasmUrl') && this.wasmUrl) {
        target.wasmUrl = this.wasmUrl;
      }
      if (changedProperties.has('allowUnusedVariables')) {
        target.allowUnusedVariables = this.allowUnusedVariables;
      }
      if (
        this.preview &&
        (changedProperties.has('files') || changedProperties.has('preview'))
      ) {
        target.run();
      }
    }
  }

  /** Compiles and runs the current source, streaming output to console. */
  runProgram() {
    if (this.isUpdatePending) {
      void this.updateComplete.then(() => {
        this.effectiveProject?.run();
      });
      return;
    }
    this.effectiveProject?.run();
  }

  /** Clears the console logs. */
  clearConsole() {
    this.effectiveProject?.clearConsole();
  }

  /**
   * Opens the Carbon-style code image export dialog.
   *
   * @param filename Optional filename to export. Defaults to the active file.
   */
  openExportDialog(filename?: string) {
    const project = this.effectiveProject;
    const targetFile = filename ?? project?.activeFile ?? 'main.zena';
    let code = project?.getAllFiles()[targetFile] ?? this.value ?? '';
    if (!code) {
      const editor = this.shadowRoot?.querySelector('zena-file-editor') as any;
      const editorDoc =
        editor?.codeMirrorEl?.editorView?.state?.doc?.toString() ??
        editor?.codeMirrorEl?.value;
      if (editorDoc) {
        code = editorDoc;
      }
    }
    const dialog =
      this.exportDialogEl ??
      (this.shadowRoot?.querySelector(
        'zena-code-export-dialog',
      ) as ZenaCodeExportDialog | null);
    if (dialog) {
      dialog.filename = targetFile;
      dialog.code = code;
      dialog.theme = this.theme;
      dialog.watermarkText = this.watermarkText;
      dialog.showModal();
    }
  }

  /**
   * Programmatically exports a high-resolution PNG image of the current code.
   */
  async exportImage(options?: Partial<ExportCodeImageOptions>): Promise<Blob> {
    const project = this.effectiveProject;
    const filename = options?.filename ?? project?.activeFile ?? 'main.zena';
    const code =
      options?.code ?? project?.getAllFiles()[filename] ?? this.value ?? '';
    return exportCodeToPngBlob({
      code,
      filename,
      theme: options?.theme ?? this.theme,
      watermarkText: options?.watermarkText ?? this.watermarkText,
      ...options,
    });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.runProgram();
    }
  };

  private onThemeChange = (e: CustomEvent<{theme: string}>) => {
    if (e.detail?.theme) {
      this.theme = e.detail.theme;
    }
  };

  private onExportImageEvent = (e: CustomEvent<{filename?: string}>) => {
    this.openExportDialog(e.detail?.filename);
  };

  #isStackedLayout(): boolean {
    const editorEl = this.shadowRoot?.querySelector('.editor-pane');
    const outputEl = this.shadowRoot?.querySelector('.output-pane');
    if (editorEl && outputEl) {
      const editorRect = editorEl.getBoundingClientRect();
      const outputRect = outputEl.getBoundingClientRect();
      return outputRect.top >= editorRect.bottom - 4;
    }
    return this.vertical || this.layout === 'vertical';
  }

  #onResizerPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const resizer = e.currentTarget as HTMLElement;
    resizer.setPointerCapture(e.pointerId);
    this.setAttribute('resizing', '');

    const stacked = this.#isStackedLayout();
    const hostRect = this.getBoundingClientRect();

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (stacked) {
        const minEditorHeight = 120;
        const minOutputHeight = 100;
        const maxOutputHeight = Math.max(
          minOutputHeight,
          hostRect.height - minEditorHeight,
        );
        const rawHeight = hostRect.bottom - moveEvent.clientY;
        const clampedHeight = Math.min(
          maxOutputHeight,
          Math.max(minOutputHeight, rawHeight),
        );
        this.style.setProperty('--zena-output-height', `${clampedHeight}px`);
      } else {
        const minEditorWidth = 200;
        const minOutputWidth = 180;
        const maxOutputWidth = Math.max(
          minOutputWidth,
          hostRect.width - minEditorWidth,
        );
        const rawWidth = hostRect.right - moveEvent.clientX;
        const clampedWidth = Math.min(
          maxOutputWidth,
          Math.max(minOutputWidth, rawWidth),
        );
        this.style.setProperty('--zena-output-width', `${clampedWidth}px`);
      }
    };

    const stopResize = (endEvent: PointerEvent) => {
      if (resizer.hasPointerCapture(endEvent.pointerId)) {
        resizer.releasePointerCapture(endEvent.pointerId);
      }
      this.removeAttribute('resizing');
      resizer.removeEventListener('pointermove', onPointerMove);
      resizer.removeEventListener('pointerup', stopResize);
      resizer.removeEventListener('pointercancel', stopResize);
    };

    resizer.addEventListener('pointermove', onPointerMove);
    resizer.addEventListener('pointerup', stopResize);
    resizer.addEventListener('pointercancel', stopResize);
  };

  #onResizerDoubleClick = () => {
    this.style.removeProperty('--zena-output-width');
    this.style.removeProperty('--zena-output-height');
  };

  #onResizerKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const stacked = this.#isStackedLayout();
    const hostRect = this.getBoundingClientRect();
    const outputEl = this.shadowRoot?.querySelector(
      '.output-pane',
    ) as HTMLElement | null;
    if (!outputEl) return;
    const outputRect = outputEl.getBoundingClientRect();

    if (!stacked && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? step : -step;
      const next = Math.min(
        Math.max(180, hostRect.width - 200),
        Math.max(180, outputRect.width + delta),
      );
      this.style.setProperty('--zena-output-width', `${next}px`);
    } else if (stacked && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? step : -step;
      const next = Math.min(
        Math.max(100, hostRect.height - 120),
        Math.max(100, outputRect.height + delta),
      );
      this.style.setProperty('--zena-output-height', `${next}px`);
    }
  };

  override render() {
    const project = this.effectiveProject;
    const files = (project?.files ?? []).filter((f) => !f.hidden);
    const showTabs =
      this.tabs === 'always' || (this.tabs !== 'never' && files.length > 1);
    const isVertical = this.vertical || this.layout === 'vertical';

    return html`
      <div class="editor-pane" @keydown=${this.onKeyDown}>
        ${
          showTabs
            ? html`
                <zena-tab-bar
                  .project=${project}
                  .theme=${this.theme}
                  ?show-theme-selector=${this.showThemeSelector}
                  ?show-export-button=${this.showExportButton}
                  @theme-change=${this.onThemeChange}
                  @export-image=${this.onExportImageEvent}
                >
                  <slot name="start" slot="start"></slot>
                  <slot name="actions" slot="actions"></slot>
                </zena-tab-bar>
              `
            : this.showExportButton
              ? html`
                  <rad-icon-button
                    class="editor-floating-export"
                    icon-name="camera"
                    size="small"
                    variant="text"
                    title="Export code image..."
                    aria-label="Export code image"
                    @click=${() => this.openExportDialog()}
                  ></rad-icon-button>
                `
              : nothing
        }
        <zena-file-editor
          .project=${project}
          .theme=${this.theme}
        ></zena-file-editor>
      </div>

      <div
        class="pane-resizer"
        role="separator"
        tabindex="0"
        aria-orientation=${isVertical ? 'horizontal' : 'vertical'}
        aria-label="Resize editor and output panes"
        title="Drag to resize (double-click to reset)"
        @pointerdown=${this.#onResizerPointerDown}
        @dblclick=${this.#onResizerDoubleClick}
        @keydown=${this.#onResizerKeyDown}
      ></div>

      <div class="output-pane">
        <zena-output
          .project=${project}
          ?preview=${this.preview}
          .sandboxBaseUrl=${this.sandboxBaseUrl}
        >
          <slot name="output-actions" slot="actions"></slot>
        </zena-output>
      </div>

      <zena-code-export-dialog
        .theme=${this.theme}
        .watermarkText=${this.watermarkText}
      ></zena-code-export-dialog>

      ${
        !this.project
          ? html`
              <zena-project
                id="internal-project"
                .wasmUrl=${this.wasmUrl}
                ?allow-unused-variables=${this.allowUnusedVariables}
                ?preview=${this.preview}
              >
                <slot></slot>
              </zena-project>
            `
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-playground': ZenaPlayground;
  }
}
