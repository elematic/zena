import {html, type TemplateResult} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {LightElement} from './light-element.js';

export const STORAGE_KEY = 'zena-appearance';

export type Appearance = 'light' | 'dark' | 'auto';

const prefersDark = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches;

export const resolveAppearance = (stored: string | null): boolean =>
  stored === 'dark' || (stored !== 'light' && prefersDark());

/**
 * The light/dark switch in the nav bar.
 *
 * The initial class on `<html>` is set by an inline script in `<head>` so the
 * page never flashes the wrong theme; this element only takes over once it
 * upgrades.
 */
@customElement('zena-appearance')
export class ZenaAppearance extends LightElement {
  @state() private isDark = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.isDark = document.documentElement.classList.contains('dark');

    // Follow the OS while the user hasn't made an explicit choice.
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e) => {
        if (localStorage.getItem(STORAGE_KEY) === null) {
          this.#apply(e.matches);
        }
      });
  }

  #apply(dark: boolean): void {
    this.isDark = dark;
    document.documentElement.classList.toggle('dark', dark);
  }

  #toggle(): void {
    const dark = !this.isDark;
    this.#apply(dark);
    localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
  }

  override render(): TemplateResult {
    return html`
      <button
        class="switch switch-appearance"
        type="button"
        role="switch"
        aria-checked=${this.isDark}
        title=${this.isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        @click=${this.#toggle}
      >
        <span class="check">
          <span class="icon">
            <span class="icon-sun sun"></span>
            <span class="icon-moon moon"></span>
          </span>
        </span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-appearance': ZenaAppearance;
  }
}
