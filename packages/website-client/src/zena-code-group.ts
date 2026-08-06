import {BehaviorElement} from './light-element.js';

/** Makes the generated tab/panel ids unique across groups on a page. */
let groupCount = 0;

/**
 * Tabbed code blocks.
 *
 * Authored as plain markup, so a code group needs no markdown syntax of its
 * own — one `<figure>` per tab, each labelled by its `<figcaption>`:
 *
 * ```html
 * <zena-code-group class="code-group vertical">
 *
 * <figure>
 * <figcaption>Functions</figcaption>
 *
 * ```zena
 * …
 * ```
 *
 * </figure>
 * </zena-code-group>
 * ```
 *
 * The blank lines matter: they end the HTML block so markdown-it parses the
 * fence between them as an ordinary code block.
 *
 * The tab strip is built here rather than served in the HTML, because the
 * caption is already the label and duplicating it into a button server-side
 * would mean two copies to keep in step. Until this upgrades, CSS shows the
 * first figure with its caption visible and hides the rest, so the group
 * degrades to one labelled code block — see the `:not(:defined)` rules in
 * css/zena-components.css.
 */
export class ZenaCodeGroup extends BehaviorElement {
  #upgraded = false;

  connectedCallback(): void {
    // connectedCallback runs again if the element is moved; the tab strip is
    // built exactly once.
    if (this.#upgraded) return;

    const panels = [...this.querySelectorAll<HTMLElement>(':scope > figure')];
    if (panels.length === 0) return;
    this.#upgraded = true;

    const signal = this.disconnectedSignal;
    const id = `code-group-${groupCount++}`;

    const tablist = document.createElement('div');
    tablist.className = 'tabs';
    tablist.setAttribute('role', 'tablist');
    // Drives which arrow keys move between tabs, and is what the keydown
    // handler below reads back.
    if (this.classList.contains('vertical')) {
      tablist.setAttribute('aria-orientation', 'vertical');
    }

    const tabs = panels.map((panel, i) => {
      const caption = panel.querySelector('figcaption');
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `${id}-tab-${i}`;
      tab.setAttribute('role', 'tab');
      tab.textContent = caption?.textContent?.trim() ?? `${i + 1}`;

      panel.id = `${id}-panel-${i}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      tab.setAttribute('aria-controls', panel.id);

      tablist.append(tab);
      return tab;
    });

    this.prepend(tablist);

    /** Roving tabindex: only the selected tab is in the tab order. */
    const select = (index: number) => {
      tabs.forEach((tab, i) => {
        tab.setAttribute('aria-selected', String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
      });
      panels.forEach((panel, i) =>
        panel.toggleAttribute('hidden', i !== index),
      );
    };
    select(0);

    tablist.addEventListener(
      'click',
      (e) => {
        const tab = (e.target as HTMLElement).closest('button');
        const index = tab ? tabs.indexOf(tab as HTMLButtonElement) : -1;
        if (index >= 0) select(index);
      },
      {signal},
    );

    tablist.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        const vertical =
          tablist.getAttribute('aria-orientation') === 'vertical';
        const [prev, next] = vertical
          ? ['ArrowUp', 'ArrowDown']
          : ['ArrowLeft', 'ArrowRight'];

        const current = tabs.findIndex(
          (tab) => tab.getAttribute('aria-selected') === 'true',
        );
        const index =
          e.key === next
            ? (current + 1) % tabs.length
            : e.key === prev
              ? (current - 1 + tabs.length) % tabs.length
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : -1;
        if (index < 0) return;

        e.preventDefault();
        select(index);
        tabs[index]?.focus();
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
