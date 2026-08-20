import {html, css} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {PlaygroundConnectedElement} from './connected-element.js';

/**
 * An output console log stream element connected to a `<zena-project>`.
 *
 * Displays program execution output (`console.log`, warnings, errors) and
 * automatically scrolls to the bottom on new log output.
 *
 * ```html
 * <zena-console project="my-project"></zena-console>
 * ```
 */
@customElement('zena-console')
export class ZenaConsole extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      height: 100%;
      min-height: 0;
      background: var(--rad-surface-sunken);
      font-family: var(
        --rad-font-family-mono,
        'JetBrains Mono',
        'Fira Code',
        Consolas,
        monospace
      );
      font-size: 0.85rem;
      overflow-y: auto;
      padding: 8px 12px;
      box-sizing: border-box;
      text-align: left;
      color: var(--rad-neutral-text-normal);
    }

    .log-item {
      padding: 2px 6px;
      border-radius: var(--rad-border-radius-small, 4px);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      font-size: 0.85rem;
      text-align: left;
    }

    .log-item-log {
      color: var(--rad-neutral-text-normal, #f8fafc);
    }

    .log-item-info {
      color: var(--rad-primary-text-normal, #38bdf8);
      background: var(--rad-primary-fill-ghost, rgba(56, 189, 248, 0.06));
    }

    .log-item-warn {
      color: var(--rad-warning-text-normal, #fbbf24);
      background: rgba(251, 191, 36, 0.06);
      border-left: 2px solid var(--rad-warning-text-normal, #fbbf24);
    }

    .log-item-error {
      color: var(--rad-danger-text-normal, #f87171);
      background: rgba(248, 113, 113, 0.09);
      border-left: 2px solid var(--rad-danger-text-normal, #f87171);
    }

    .empty-hint {
      color: var(--rad-neutral-text-muted, #475569);
      font-style: italic;
      padding: 4px;
      text-align: left;
    }
  `;

  /** Optional placeholder text when there are no logs. */
  @property({type: String, attribute: 'empty-hint'})
  emptyHint?: string;

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
      this.scrollTop = this.scrollHeight;
    });
  }

  /** Clears all accumulated console logs. */
  clear() {
    this.projectElement?.clearConsole();
  }

  override render() {
    const logs = this.projectElement?.consoleLogs ?? [];
    const shortcutLabel = this.isMac ? '⌘↵' : 'Ctrl+Enter';
    const hint =
      this.emptyHint ??
      `Click ▶ Run or press ${shortcutLabel} to execute program.`;

    if (logs.length === 0) {
      return html`<div class="empty-hint">${hint}</div>`;
    }

    return logs.map(
      // prettier-ignore
      (log) => html`<div class="log-item log-item-${log.level}">${log.message}</div>`,
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-console': ZenaConsole;
  }
}
