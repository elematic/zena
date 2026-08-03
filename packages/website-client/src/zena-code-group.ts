import {BehaviorElement} from './light-element.js';

/**
 * Tabbed code blocks, produced by the `::: code-group` markdown container.
 *
 * The first tab is rendered active, so with JS disabled the group degrades to
 * a single code block rather than a wall of duplicates.
 */
export class ZenaCodeGroup extends BehaviorElement {
  connectedCallback(): void {
    const signal = this.disconnectedSignal;
    const tabs = [...this.querySelectorAll<HTMLButtonElement>('.tabs button')];
    const blocks = [
      ...this.querySelectorAll<HTMLElement>(':scope > .blocks > *'),
    ];

    this.querySelector('.tabs')?.addEventListener(
      'click',
      (e) => {
        const button = (e.target as HTMLElement).closest('button');
        const index = button ? tabs.indexOf(button as HTMLButtonElement) : -1;
        if (index < 0) return;
        tabs.forEach((t, i) =>
          t.setAttribute('aria-selected', String(i === index)),
        );
        blocks.forEach((b, i) => b.toggleAttribute('hidden', i !== index));
      },
      {signal},
    );

    this.querySelector('.tabs')?.addEventListener(
      'keydown',
      (event) => {
        const e = event as KeyboardEvent;
        const delta =
          e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (delta === 0) return;
        e.preventDefault();
        const current = tabs.findIndex(
          (t) => t.getAttribute('aria-selected') === 'true',
        );
        tabs[(current + delta + tabs.length) % tabs.length]?.click();
        tabs[(current + delta + tabs.length) % tabs.length]?.focus();
      },
      {signal},
    );
  }
}

customElements.define('zena-code-group', ZenaCodeGroup);

declare global {
  interface HTMLElementTagNameMap {
    'zena-code-group': ZenaCodeGroup;
  }
}
