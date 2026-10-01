import {html, css, LitElement} from 'lit';
import {customElement, property, state, query} from 'lit/decorators.js';
import {unsafeHTML} from 'lit/directives/unsafe-html.js';
import '@radica/ui/components/dialog/dialog.js';
import type {Dialog as RadDialog} from '@radica/ui/components/dialog/dialog.js';
import '@radica/ui/components/button/button.js';
import '@radica/ui/components/icon-button/icon-button.js';
import '@radica/bootstrap-icons/icons/download.svg.js';
import '@radica/bootstrap-icons/icons/clipboard.svg.js';
import '@radica/bootstrap-icons/icons/check2.svg.js';
import {
  generateCodeSvg,
  copyCodeImageToClipboard,
  downloadCodeImage,
  getAvailableThemes,
  getAvailableBackgrounds,
  type ExportCodeImageOptions,
} from './zena-code-export.js';

/**
 * An interactive modal dialog for customizing and exporting code images (Carbon style).
 *
 * Composes Radica's `<rad-dialog>` element promoted to the browser Top Layer via `showModal()`.
 */
@customElement('zena-code-export-dialog')
export class ZenaCodeExportDialog extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    rad-dialog::part(dialog) {
      width: min(920px, 94vw);
      max-width: 920px;
      max-height: 92vh;
      padding: 0;
      gap: 0;
      overflow: hidden;
      background-color: var(--rad-surface-overlay, #181825);
      border: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.12));
      border-radius: var(--rad-border-radius-large, 12px);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }

    rad-dialog::part(dialog)::backdrop {
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    rad-dialog::part(header) {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-bottom: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.08));
      background: var(--rad-surface-chrome, #1e293b);
    }

    rad-dialog::part(title) {
      font-size: 16px;
      font-weight: 600;
      color: var(--rad-neutral-text-normal, #f8fafc);
      margin: 0;
    }

    rad-dialog::part(body) {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
      max-height: calc(92vh - 130px);
    }

    rad-dialog::part(footer) {
      display: flex;
      align-items: center;
      padding: 12px 20px;
      border-top: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.08));
      background: var(--rad-surface-chrome, #1e293b);
    }

    .dialog-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }

    .controls-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px 20px;
      padding: 12px 14px;
      background: var(--rad-surface-sunken, rgba(0, 0, 0, 0.25));
      border-radius: var(--rad-border-radius-medium, 8px);
      border: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.06));
    }

    .control-group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--rad-neutral-text-muted, #94a3b8);
    }

    .control-label {
      font-weight: 500;
      white-space: nowrap;
    }

    .select-input {
      background: var(--rad-surface-chrome, #1e293b);
      color: var(--rad-neutral-text-normal, #f8fafc);
      border: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.15));
      border-radius: var(--rad-border-radius-small, 4px);
      padding: 5px 10px;
      font-size: 13px;
      outline: none;
      cursor: pointer;
      font-family: inherit;
    }

    .select-input:focus {
      border-color: var(--rad-color-border-focused, #38bdf8);
      box-shadow: 0 0 0 1px var(--rad-color-border-focused, #38bdf8);
    }

    .checkbox-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 13px;
      color: var(--rad-neutral-text-normal, #f1f5f9);
      user-select: none;
    }

    .checkbox-input {
      accent-color: var(--zena-c-brand-1, #38bdf8);
      cursor: pointer;
    }

    .preview-viewport {
      display: flex;
      justify-content: center;
      align-items: center;
      height: clamp(280px, 52vh, 540px);
      padding: 24px;
      overflow: hidden;
      box-sizing: border-box;
      border-radius: var(--rad-border-radius-medium, 8px);
      background-color: #0b0f19;
      background-image:
        radial-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px),
        radial-gradient(rgba(255, 255, 255, 0.08) 1px, #0b0f19 1px);
      background-size: 20px 20px;
      background-position:
        0 0,
        10px 10px;
      border: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.08));
    }

    .preview-card {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }

    .preview-card svg {
      display: block;
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
    }

    .preview-card:not([data-background='transparent']) svg {
      box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.6);
    }

    .footer-actions-right {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .copied-badge {
      color: #10b981 !important;
      font-weight: 600;
    }
  `;

  /** The source code to export. */
  @property({type: String})
  code = '';

  /** The filename of the active code (e.g. 'main.zena'). */
  @property({type: String})
  filename = 'main.zena';

  /** Selected syntax highlight theme. */
  @property({type: String})
  theme = 'one-dark';

  @state()
  private background = 'sunset';

  @state()
  private padding = 48;

  @state()
  private showLineNumbers = true;

  @state()
  private showWindowControls = true;

  @state()
  private showWatermark = true;

  /** Custom watermark text. */
  @property({type: String, attribute: 'watermark-text'})
  watermarkText?: string;

  @state()
  private copiedImage = false;

  @state()
  private copiedSvg = false;

  @query('rad-dialog')
  private radDialogEl?: RadDialog;

  private copyTimeout?: ReturnType<typeof setTimeout>;

  /**
   * Opens the dialog in the browser Top Layer via Radica's Dialog.
   */
  showModal() {
    this.copiedImage = false;
    this.copiedSvg = false;
    this.requestUpdate();
    this.updateComplete.then(() => {
      const radDialog =
        this.radDialogEl ??
        (this.shadowRoot?.querySelector('rad-dialog') as RadDialog | null);
      radDialog?.showModal();
    });
  }

  /**
   * Closes the dialog.
   */
  close = () => {
    const radDialog =
      this.radDialogEl ??
      (this.shadowRoot?.querySelector('rad-dialog') as RadDialog | null);
    radDialog?.close();
  };

  private onDialogClose = () => {
    this.dispatchEvent(
      new CustomEvent('close', {bubbles: true, composed: true}),
    );
  };

  private onDialogClick = (e: MouseEvent) => {
    const nativeDialog = this.radDialogEl?.shadowRoot?.querySelector('dialog');
    if (!nativeDialog) return;
    const rect = nativeDialog.getBoundingClientRect();
    const isInDialog =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!isInDialog) {
      this.close();
    }
  };

  private get exportOptions(): ExportCodeImageOptions {
    return {
      code: this.code,
      filename: this.filename,
      theme: this.theme,
      background: this.background,
      padding: this.padding,
      showLineNumbers: this.showLineNumbers,
      showWindowControls: this.showWindowControls,
      showWatermark: this.showWatermark,
      watermarkText: this.watermarkText,
    };
  }

  private onCopyImage = async () => {
    const success = await copyCodeImageToClipboard(this.exportOptions);
    if (success) {
      this.copiedImage = true;
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
      this.copyTimeout = setTimeout(() => {
        this.copiedImage = false;
      }, 2500);
    }
  };

  private onCopySvg = async () => {
    const svg = generateCodeSvg(this.exportOptions);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(svg);
      this.copiedSvg = true;
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
      this.copyTimeout = setTimeout(() => {
        this.copiedSvg = false;
      }, 2500);
    }
  };

  private onDownloadPng = () => {
    downloadCodeImage(this.exportOptions, 'png');
  };

  private onDownloadSvg = () => {
    downloadCodeImage(this.exportOptions, 'svg');
  };

  override render() {
    const themes = getAvailableThemes();
    const backgrounds = getAvailableBackgrounds();
    const svgString = generateCodeSvg(this.exportOptions);

    return html`
      <rad-dialog
        title="Export Code Image"
        @click=${this.onDialogClick}
        @close=${this.onDialogClose}
      >
        <div class="controls-toolbar">
          <div class="control-group">
            <span class="control-label">Theme:</span>
            <select
              class="select-input"
              .value=${this.theme}
              @change=${(e: Event) => {
                this.theme = (e.target as HTMLSelectElement).value;
              }}
            >
              ${themes.map(
                (t) =>
                  html`<option value=${t.id} ?selected=${this.theme === t.id}>
                    ${t.label}
                  </option>`,
              )}
            </select>
          </div>

          <div class="control-group">
            <span class="control-label">Background:</span>
            <select
              class="select-input"
              .value=${this.background}
              @change=${(e: Event) => {
                this.background = (e.target as HTMLSelectElement).value;
              }}
            >
              ${backgrounds.map(
                (b) =>
                  html`<option
                    value=${b.id}
                    ?selected=${this.background === b.id}
                  >
                    ${b.label}
                  </option>`,
              )}
            </select>
          </div>

          <div class="control-group">
            <span class="control-label">Padding:</span>
            <select
              class="select-input"
              .value=${String(this.padding)}
              @change=${(e: Event) => {
                this.padding = Number((e.target as HTMLSelectElement).value);
              }}
            >
              <option value="0" ?selected=${this.padding === 0}>
                None (0px)
              </option>
              <option value="16" ?selected=${this.padding === 16}>16px</option>
              <option value="32" ?selected=${this.padding === 32}>32px</option>
              <option value="48" ?selected=${this.padding === 48}>48px</option>
              <option value="64" ?selected=${this.padding === 64}>64px</option>
            </select>
          </div>

          <label class="checkbox-label">
            <input
              type="checkbox"
              class="checkbox-input"
              ?checked=${this.showLineNumbers}
              @change=${(e: Event) => {
                this.showLineNumbers = (e.target as HTMLInputElement).checked;
              }}
            />
            Line numbers
          </label>

          <label class="checkbox-label">
            <input
              type="checkbox"
              class="checkbox-input"
              ?checked=${this.showWindowControls}
              @change=${(e: Event) => {
                this.showWindowControls = (
                  e.target as HTMLInputElement
                ).checked;
              }}
            />
            Window header
          </label>

          <label class="checkbox-label">
            <input
              type="checkbox"
              class="checkbox-input"
              ?checked=${this.showWatermark}
              @change=${(e: Event) => {
                this.showWatermark = (e.target as HTMLInputElement).checked;
              }}
            />
            Watermark
          </label>
        </div>

        <div class="preview-viewport">
          <div class="preview-card" data-background=${this.background}>
            ${unsafeHTML(svgString)}
          </div>
        </div>

        <div slot="footer" class="dialog-footer">
          <rad-button
            variant="text"
            size="small"
            @click=${this.onCopySvg}
            title="Copy raw SVG to clipboard"
          >
            ${this.copiedSvg ? '✓ SVG Copied' : 'Copy SVG'}
          </rad-button>

          <div class="footer-actions-right">
            <rad-button variant="default" @click=${this.onDownloadSvg}>
              Download SVG
            </rad-button>
            <rad-button variant="default" @click=${this.onDownloadPng}>
              Download PNG
            </rad-button>
            <rad-button
              variant="primary"
              class=${this.copiedImage ? 'copied-badge' : ''}
              @click=${this.onCopyImage}
            >
              ${this.copiedImage ? '✓ Image Copied!' : 'Copy Image'}
            </rad-button>
          </div>
        </div>
      </rad-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-code-export-dialog': ZenaCodeExportDialog;
  }
}
