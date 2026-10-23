import {html, css, nothing} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import '@radica/ui/components/button/button.js';
import {PlaygroundConnectedElement} from './connected-element.js';
import './zena-console.js';
import './zena-preview.js';

/**
 * An output console pane element with integrated status indicator and Run/Clear controls.
 *
 * Connects to a `<zena-project>` (via ancestor DOM, shadow DOM, or `project="id"` attribute)
 * and composes `<zena-console>` for log output streaming.
 *
 * ```html
 * <zena-output project="my-project"></zena-output>
 * ```
 */
@customElement('zena-output')
export class ZenaOutput extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: grid;
      grid-template-rows: min-content 1fr;
      min-width: 280px;
      min-height: 120px;
      height: 100%;
      background: var(--rad-surface-sunken);
      font-family: var(
        --rad-font-family-mono,
        'JetBrains Mono',
        'Fira Code',
        Consolas,
        monospace
      );
      font-size: 0.85rem;
      border-radius: var(--rad-border-radius-medium, 8px);
      border: 1px solid var(--rad-neutral-stroke-faint);
      overflow: hidden;
      color: var(--rad-neutral-text-normal);
    }

    .output-header {
      grid-row: 1;
      padding: 0 12px;
      background: var(--rad-surface-chrome);
      border-bottom: 1px solid var(--rad-neutral-stroke-faint);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      height: 40px;
      min-height: 40px;
      max-height: 40px;
      box-sizing: border-box;
    }

    .output-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(
        --rad-font-family-sans,
        system-ui,
        -apple-system,
        sans-serif
      );
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--rad-neutral-text-muted);
    }

    .mode-tabs {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      background: var(--rad-surface-sunken, rgba(0, 0, 0, 0.25));
      padding: 2px;
      border-radius: var(--rad-border-radius-small, 6px);
      border: 1px solid
        var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.08));
    }

    .mode-tab {
      appearance: none;
      background: transparent;
      border: none;
      color: var(--rad-neutral-text-muted, #94a3b8);
      font-family: var(
        --rad-font-family-sans,
        system-ui,
        -apple-system,
        sans-serif
      );
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      transition:
        background 0.15s ease,
        color 0.15s ease;
    }

    .mode-tab:hover {
      color: var(--rad-neutral-text-normal, #f8fafc);
    }

    .mode-tab[aria-selected='true'] {
      background: var(--rad-surface, rgba(255, 255, 255, 0.1));
      color: var(--rad-neutral-text-normal, #f8fafc);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }

    .diag-badge {
      font-size: 0.72rem;
      font-weight: 500;
      padding: 1px 6px;
      border-radius: var(--rad-border-radius-small, 4px);
    }

    .diag-badge-error {
      background: var(--rad-danger-fill-ghost, rgba(239, 68, 68, 0.15));
      color: var(--rad-danger-text-normal, #f87171);
      border: 1px solid var(--rad-danger-stroke-subtle, rgba(239, 68, 68, 0.3));
    }

    .diag-badge-warning {
      background: var(--rad-warning-fill-ghost, rgba(245, 158, 11, 0.15));
      color: var(--rad-warning-text-normal, #fbbf24);
      border: 1px solid
        var(--rad-warning-stroke-subtle, rgba(245, 158, 11, 0.3));
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(
        --rad-font-family-sans,
        system-ui,
        -apple-system,
        sans-serif
      );
      font-size: 0.78rem;
      color: var(--rad-neutral-text-muted, #94a3b8);
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #e2e8f0;
    }

    .dot-ready {
      background: var(--rad-success-fill-solid, #10b981);
      box-shadow: 0 0 6px var(--rad-success-fill-solid, #10b981);
    }

    .dot-checking {
      background: var(--rad-warning-text-normal, #f59e0b);
      animation: pulse 1.5s infinite;
    }

    .dot-error {
      background: var(--rad-danger-text-normal, #ef4444);
      box-shadow: 0 0 6px var(--rad-danger-text-normal, #ef4444);
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

    .run-icon {
      width: 12px;
      height: 12px;
      fill: currentColor;
      display: inline-block;
      vertical-align: -1px;
    }

    .key-shortcut {
      font-size: 0.68rem;
      opacity: 0.85;
      margin-left: 3px;
      font-family: inherit;
    }

    .output-body {
      grid-row: 2;
      min-height: 0;
      height: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
    }

    .output-body zena-console,
    .output-body zena-preview {
      flex: 1;
      height: 100%;
      min-height: 0;
      border: none;
      background: transparent;
    }

    .output-body [hidden] {
      display: none !important;
    }
  `;

  /** If true, hides the top controls header bar. */
  @property({type: Boolean, attribute: 'hide-header'})
  hideHeader = false;

  /** If true, shows the live web preview iframe with a Preview/Console toggle. */
  @property({type: Boolean, reflect: true})
  preview = false;

  /** Base URL for the preview sandbox origin and service worker files. */
  @property({type: String, attribute: 'sandbox-base-url'})
  sandboxBaseUrl = '/sandbox/';

  @state()
  private activeTab: 'preview' | 'console' = 'preview';

  private get isMac(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/.test(
        navigator.userAgent || navigator.platform || '',
      )
    );
  }

  private runProgram() {
    this.projectElement?.run();
  }

  private clearConsole() {
    this.projectElement?.clearConsole();
  }

  override render() {
    const project = this.projectElement;
    const diagnostics = project?.diagnostics ?? [];
    const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
    const warningCount = diagnostics.filter(
      (d) => d.severity === 'warning',
    ).length;
    const status = project?.status ?? 'loading';
    const shortcutLabel = this.isMac ? '⌘↵' : 'Ctrl+Enter';

    return html`
      ${
        !this.hideHeader
          ? html`
              <div class="output-header">
                <div class="output-title">
                  ${
                    this.preview
                      ? html`
                          <div class="mode-tabs" role="tablist">
                            <button
                              type="button"
                              role="tab"
                              class="mode-tab"
                              aria-selected=${
                                this.activeTab === 'preview' ? 'true' : 'false'
                              }
                              @click=${() => (this.activeTab = 'preview')}
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              role="tab"
                              class="mode-tab"
                              aria-selected=${
                                this.activeTab === 'console' ? 'true' : 'false'
                              }
                              @click=${() => (this.activeTab = 'console')}
                            >
                              Console
                            </button>
                          </div>
                        `
                      : html`<span>Output</span>`
                  }
                  ${
                    errorCount > 0
                      ? html`
                          <span class="diag-badge diag-badge-error">
                            ${errorCount} Error${errorCount === 1 ? '' : 's'}
                          </span>
                        `
                      : warningCount > 0
                        ? html`
                            <span class="diag-badge diag-badge-warning">
                              ${warningCount}
                              Warning${warningCount === 1 ? '' : 's'}
                            </span>
                          `
                        : ''
                  }
                </div>

                <div class="header-controls">
                  <div class="status-indicator">
                    <span
                      class="dot ${
                        status === 'ready'
                          ? 'dot-ready'
                          : status === 'checking'
                            ? 'dot-checking'
                            : 'dot-error'
                      }"
                    ></span>
                    <span>
                      ${
                        status === 'loading'
                          ? 'Loading...'
                          : status === 'checking'
                            ? 'Checking...'
                            : status === 'error'
                              ? 'Error'
                              : 'Ready'
                      }
                    </span>
                  </div>

                  <rad-button
                    size="small"
                    variant="success"
                    @click=${() => this.runProgram()}
                    title="${
                      this.preview ? 'Reload Preview' : 'Run Program'
                    } (${shortcutLabel})"
                  >
                    <svg slot="prefix" class="run-icon" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Run
                    <span class="key-shortcut" slot="suffix"
                      >${shortcutLabel}</span
                    >
                  </rad-button>

                  ${
                    !this.preview || this.activeTab === 'console'
                      ? html`
                          <rad-button
                            size="small"
                            variant="neutral"
                            outline
                            @click=${() => this.clearConsole()}
                          >
                            Clear
                          </rad-button>
                        `
                      : nothing
                  }

                  <slot name="actions"></slot>
                </div>
              </div>
            `
          : ''
      }

      <div class="output-body">
        ${
          this.preview
            ? html`
                <zena-preview
                  .project=${project}
                  .sandboxBaseUrl=${this.sandboxBaseUrl}
                  ?hidden=${this.activeTab !== 'preview'}
                ></zena-preview>
                <zena-console
                  .project=${project}
                  ?hidden=${this.activeTab !== 'console'}
                ></zena-console>
              `
            : html`<zena-console .project=${project}></zena-console>`
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-output': ZenaOutput;
  }
}
