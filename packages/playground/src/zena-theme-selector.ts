import {html, css, LitElement} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import '@radica/ui/components/dropdown/dropdown.js';
import '@radica/ui/components/icon-button/icon-button.js';
import '@radica/ui/components/menu/menu.js';
import '@radica/ui/components/menu-item/menu-item.js';
import '@radica/bootstrap-icons/icons/palette.svg.js';

export const THEME_OPTIONS = [
  {value: 'one-dark', label: 'One Dark'},
  {value: 'dracula', label: 'Dracula'},
  {value: 'github-dark', label: 'GitHub Dark'},
  {value: 'monokai', label: 'Monokai'},
  {value: 'nord', label: 'Nord'},
  {value: 'vscode-dark', label: 'VS Code Dark'},
  {value: 'solarized-dark', label: 'Solarized Dark'},
];

/**
 * An opt-in dropdown button for choosing CodeMirror editor themes.
 *
 * Renders a palette icon button that opens a selection menu with checkable items.
 *
 * ```html
 * <zena-theme-selector theme="one-dark"></zena-theme-selector>
 * ```
 */
@customElement('zena-theme-selector')
export class ZenaThemeSelector extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
    }

    rad-dropdown {
      display: inline-flex;
    }

    rad-icon-button {
      color: var(--rad-neutral-text-muted, #94a3b8);
      transition: color 0.15s ease;
    }

    rad-icon-button:hover,
    rad-icon-button:focus-visible {
      color: var(--rad-neutral-text-normal, #f8fafc);
    }
  `;

  /** The currently selected theme name. */
  @property({type: String})
  theme = 'one-dark';

  private onSelectTheme(value: string) {
    this.theme = value;
    this.dispatchEvent(
      new CustomEvent('theme-change', {
        detail: {theme: value},
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return html`
      <rad-dropdown>
        <rad-icon-button
          slot="trigger"
          icon-name="palette"
          size="small"
          variant="text"
          title="Select Editor Theme"
        ></rad-icon-button>
        <rad-menu>
          ${THEME_OPTIONS.map(
            (opt) => html`
              <rad-menu-item
                value=${opt.value}
                ?checked=${this.theme === opt.value}
                checkable
                @click=${() => this.onSelectTheme(opt.value)}
              >
                ${opt.label}
              </rad-menu-item>
            `,
          )}
        </rad-menu>
      </rad-dropdown>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-theme-selector': ZenaThemeSelector;
  }
}
