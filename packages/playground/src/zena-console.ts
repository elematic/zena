import {html, css} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import '@radica/ui/components/button/button.js';
import {PlaygroundConnectedElement} from './connected-element.js';

/**
 * An output console pane connected to a `<zena-project>`.
 *
 * Displays program execution output (`console.log`, warnings, errors),
 * diagnostics summary, compiler status, and Run/Clear buttons using Radica controls.
 *
 * ```html
 * <zena-console project="my-project"></zena-console>
 * ```
 */
@customElement('zena-console')
export class ZenaConsole extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: grid;
      grid-template-rows: min-content 1fr;
      min-width: 280px;
      min-height: 0;
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
      overflow: hidden;
      color: var(--rad-neutral-text-normal);
    }

    .console-header {
      grid-row: 1;
      padding: 8px 12px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--rad-neutral-text-muted);
      border-bottom: 1px solid var(--rad-neutral-stroke-faint);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75rem;
      color: var(--rad-neutral-text-muted, #94a3b8);
      text-transform: none;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #e2e8f0;
    }

    .dot-ready {
      background: var(--rad-success-fill-solid, #10b981);
      box-shadow: 0 0 8px var(--rad-success-fill-solid, #10b981);
    }

    .dot-checking {
      background: var(--rad-warning-text-normal, #f59e0b);
      animation: pulse 1.5s infinite;
    }

    .dot-error {
      background: var(--rad-danger-text-normal, #ef4444);
      box-shadow: 0 0 8px var(--rad-danger-text-normal, #ef4444);
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

    .console-body {
      grid-row: 2;
      min-height: 0;
      height: 100%;
      overflow-y: auto;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      text-align: left;
    }

    .log-item {
      padding: 6px 8px;
      border-radius: var(--rad-border-radius-small, 4px);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      display: flex;
      flex-direction: column;
      gap: 2px;
      text-align: left;
    }

    .log-item-log {
      color: var(--rad-neutral-text-normal, #f8fafc);
      background: rgba(255, 255, 255, 0.03);
    }

    .log-item-info {
      color: var(--rad-primary-text-normal, #38bdf8);
      background: var(--rad-primary-fill-ghost, rgba(56, 189, 248, 0.05));
    }

    .log-item-warn {
      color: var(--rad-warning-text-normal, #fbbf24);
      background: rgba(251, 191, 36, 0.05);
      border-left: 2px solid var(--rad-warning-text-normal, #fbbf24);
    }

    .log-item-error {
      color: var(--rad-danger-text-normal, #f87171);
      background: rgba(248, 113, 113, 0.08);
      border-left: 2px solid var(--rad-danger-text-normal, #f87171);
    }
  `;

  /** If true, hides the console header and run buttons. */
  @property({type: Boolean, attribute: 'hide-header'})
  hideHeader = false;

  private get isMac(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/.test(
        navigator.userAgent || navigator.platform || '',
      )
    );
  }

  protected override onProjectUpdate() {
    super.onProjectUpdate();
    this.updateComplete.then(() => {
      const body = this.shadowRoot?.querySelector('.console-body');
      if (body) {
        body.scrollTop = body.scrollHeight;
      }
    });
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
    const logs = project?.consoleLogs ?? [];
    const shortcutLabel = this.isMac ? '⌘↵' : 'Ctrl+Enter';

    return html`
      ${!this.hideHeader
        ? html`
            <div class="console-header">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span>Output Console</span>
                ${diagnostics.length > 0
                  ? html`
                      <span
                        style="font-size: 0.75rem; color: var(--rad-danger-text-normal, #f87171);"
                      >
                        ${errorCount} Err, ${warningCount} Warn
                      </span>
                    `
                  : ''}
              </div>

              <div class="header-actions">
                <div class="status-indicator">
                  <span
                    class="dot ${status === 'ready'
                      ? 'dot-ready'
                      : status === 'checking'
                        ? 'dot-checking'
                        : 'dot-error'}"
                  ></span>
                  <span>
                    ${status === 'loading'
                      ? 'Loading...'
                      : status === 'checking'
                        ? 'Checking...'
                        : status === 'error'
                          ? 'Error'
                          : 'Ready'}
                  </span>
                </div>
                <rad-button
                  size="small"
                  variant="success"
                  @click=${() => this.runProgram()}
                  title="Run Program (${shortcutLabel})"
                >
                  <svg slot="prefix" class="run-icon" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Run
                </rad-button>
                <rad-button
                  size="small"
                  variant="neutral"
                  outline
                  @click=${() => this.clearConsole()}
                >
                  Clear
                </rad-button>
              </div>
            </div>
          `
        : ''}

      <div class="console-body">
        ${logs.length === 0
          ? html`<div
              style="color: var(--rad-neutral-text-muted, #475569); font-style: italic; padding: 4px; text-align: left;"
            >
              Click ▶ Run or press ${shortcutLabel} to execute program.
            </div>`
          : logs.map(
              (log) =>
                html`<div class="log-item log-item-${log.level}">
                  ${log.message}
                </div>`,
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-console': ZenaConsole;
  }
}
