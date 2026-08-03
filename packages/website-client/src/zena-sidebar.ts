import {BehaviorElement} from './light-element.js';

const COLLAPSIBLE = '.sidebar-item.collapsible';

/**
 * Makes the sidebar's `.sidebar-item.collapsible` sections expand and
 * collapse.
 *
 * Eleventy renders the initial state: any group containing the current page is
 * expanded, everything else respects its `collapsed` flag from the sidebar
 * config. Without JS the groups simply stay as rendered.
 */
export class ZenaSidebar extends BehaviorElement {
  connectedCallback(): void {
    const signal = this.disconnectedSignal;

    this.addEventListener(
      'click',
      (e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.item');
        const section = item?.parentElement?.closest<HTMLElement>(COLLAPSIBLE);
        if (!item || !section || item.parentElement !== section) return;

        // A group heading that is itself a link only toggles from the caret;
        // clicking the text should navigate.
        const isCaret = !!(e.target as HTMLElement).closest('.caret');
        if (section.classList.contains('is-link') && !isCaret) return;

        e.preventDefault();
        this.#toggle(section);
      },
      {signal},
    );

    this.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = (e.target as HTMLElement).closest<HTMLElement>(
          '.item[role="button"], .caret',
        );
        const section = item?.closest<HTMLElement>(COLLAPSIBLE);
        if (!section) return;
        e.preventDefault();
        this.#toggle(section);
      },
      {signal},
    );
  }

  #toggle(section: HTMLElement): void {
    const collapsed = section.classList.toggle('collapsed');
    section
      .querySelector('.item > .caret')
      ?.setAttribute('aria-expanded', String(!collapsed));
    section
      .querySelector('.item[role="button"]')
      ?.setAttribute('aria-expanded', String(!collapsed));
  }
}

customElements.define('zena-sidebar', ZenaSidebar);

declare global {
  interface HTMLElementTagNameMap {
    'zena-sidebar': ZenaSidebar;
  }
}
