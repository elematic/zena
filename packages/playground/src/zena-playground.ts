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
      grid-template-columns: 1fr 380px;
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

    zena-project {
      display: none !important;
    }

    .editor-pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      height: 100%;
      background: var(--rad-surface-sunken);
      border-right: 1px solid var(--rad-neutral-stroke-faint);
      overflow: hidden;
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
      min-width: 280px;
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
      grid-template-rows: 1fr 200px;
    }

    :host([vertical]) .editor-pane,
    :host([layout='vertical']) .editor-pane {
      border-right: none;
      border-bottom: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.08));
    }

    @media (max-width: 768px) {
      :host {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr 220px;
        height: 640px;
      }
      .editor-pane {
        border-right: none;
        border-bottom: 1px solid
          var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.1));
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

  @query('zena-project')
  private internalProjectEl?: ZenaProject;

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
      if (changedProperties.has('files') && this.files) {
        target.files = this.files;
      } else if (changedProperties.has('value') && this.value !== undefined) {
        target.files = {'main.zena': this.value};
      }
      if (changedProperties.has('wasmUrl') && this.wasmUrl) {
        target.wasmUrl = this.wasmUrl;
      }
    }
  }

  /** Compiles and runs the current source, streaming output to console. */
  runProgram() {
    this.effectiveProject?.run();
  }

  /** Clears the console logs. */
  clearConsole() {
    this.effectiveProject?.clearConsole();
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

  override render() {
    const project = this.effectiveProject;
    const files = (project?.files ?? []).filter((f) => !f.hidden);
    const showTabs =
      this.tabs === 'always' || (this.tabs !== 'never' && files.length > 1);

    return html`
      <div class="editor-pane" @keydown=${this.onKeyDown}>
        ${showTabs
          ? html`
              <zena-tab-bar
                .project=${project}
                .theme=${this.theme}
                ?show-theme-selector=${this.showThemeSelector}
                @theme-change=${this.onThemeChange}
              >
                <slot name="actions" slot="actions"></slot>
              </zena-tab-bar>
            `
          : nothing}
        <zena-file-editor
          .project=${project}
          .theme=${this.theme}
        ></zena-file-editor>
      </div>

      <div class="output-pane">
        <zena-output .project=${project}>
          <slot name="output-actions" slot="actions"></slot>
        </zena-output>
      </div>

      ${!this.project
        ? html`
            <zena-project id="internal-project" .wasmUrl=${this.wasmUrl}>
              <slot></slot>
            </zena-project>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-playground': ZenaPlayground;
  }
}
