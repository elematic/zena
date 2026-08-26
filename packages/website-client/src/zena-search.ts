import {html, nothing, type TemplateResult} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {LightElement} from './light-element.js';

/** One indexed chunk: a page section, keyed by its heading anchor. */
export interface SearchEntry {
  /** Heading text, or the page title for the lead section. */
  title: string;
  /** Breadcrumb of the owning page, e.g. "Reference › Classes". */
  section: string;
  /** URL including the heading fragment. */
  url: string;
  /** Plain text of the section, used for matching and excerpts. */
  text: string;
}

const MAX_RESULTS = 12;
const EXCERPT_RADIUS = 60;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Site search: a nav-bar button plus a modal over a prebuilt JSON index.
 *
 * The index is generated at build time (see `search-index.njk`) and fetched
 * lazily the first time the modal opens, so it costs nothing on page load.
 */
@customElement('zena-search')
export class ZenaSearch extends LightElement {
  @state() private open = false;
  @state() private query = '';
  @state() private selected = 0;
  @state() private entries: SearchEntry[] | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.#onGlobalKeydown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.#onGlobalKeydown);
  }

  #onGlobalKeydown = (e: KeyboardEvent) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.#setOpen(!this.open);
    } else if (e.key === 'Escape' && this.open) {
      this.#setOpen(false);
    } else if (
      e.key === '/' &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !this.open &&
      !this.#isEditableTarget(e)
    ) {
      e.preventDefault();
      this.#setOpen(true);
    }
  };

  #isEditableTarget(e: KeyboardEvent): boolean {
    for (const node of e.composedPath()) {
      if (node instanceof HTMLElement) {
        if (
          node.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) ||
          node.classList.contains('cm-content') ||
          node.classList.contains('cm-editor') ||
          node.tagName.toLowerCase().includes('editor') ||
          node.tagName.toLowerCase().includes('playground')
        ) {
          return true;
        }
      }
    }
    return false;
  };

  async #setOpen(open: boolean): Promise<void> {
    this.open = open;
    if (!open) return;

    this.entries ??= await this.#load();
    await this.updateComplete;
    this.querySelector('input')?.focus();
  }

  async #load(): Promise<SearchEntry[]> {
    try {
      const response = await fetch('/search-index.json');
      return (await response.json()) as SearchEntry[];
    } catch {
      return [];
    }
  }

  get #results(): SearchEntry[] {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0 || this.entries === undefined) return [];

    const scored: Array<{entry: SearchEntry; score: number}> = [];
    for (const entry of this.entries) {
      const title = entry.title.toLowerCase();
      const text = entry.text.toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (title.startsWith(term)) score += 12;
        else if (title.includes(term)) score += 8;
        else if (text.includes(term)) score += 2;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) scored.push({entry, score});
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((s) => s.entry);
  }

  #onInput(e: Event): void {
    this.query = (e.target as HTMLInputElement).value;
    this.selected = 0;
  }

  #onKeydown(e: KeyboardEvent): void {
    const results = this.#results;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selected = (this.selected + 1) % Math.max(results.length, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selected =
        (this.selected - 1 + results.length) % Math.max(results.length, 1);
    } else if (e.key === 'Enter') {
      const target = results[this.selected];
      if (target) location.href = target.url;
    }
  }

  /** Renders a snippet around the first match, with the terms marked. */
  #excerpt(entry: SearchEntry): TemplateResult | typeof nothing {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const lower = entry.text.toLowerCase();
    const at = terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (at === undefined) return nothing;

    const start = Math.max(0, at - EXCERPT_RADIUS);
    const raw = entry.text.slice(start, at + EXCERPT_RADIUS * 2);
    const pattern = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'ig');

    const parts = raw.split(pattern);
    return html`<span class="result-excerpt"
      >${start > 0 ? '…' : ''}${parts.map((part, i) =>
        i % 2 === 1 ? html`<mark>${part}</mark>` : part,
      )}…</span
    >`;
  }

  override render(): TemplateResult {
    return html`
      <button
        class="search-button"
        type="button"
        aria-label="Search"
        @click=${() => this.#setOpen(true)}
      >
        <span class="icon-search search-icon"></span>
        <span class="search-placeholder">Search</span>
        <span class="search-keys"><kbd>⌘</kbd><kbd>K</kbd></span>
      </button>
      ${this.#renderModal()}
    `;
  }

  #renderModal(): TemplateResult {
    const results = this.#results;
    return html`
      <div
        class="search-modal"
        ?hidden=${!this.open}
        role="dialog"
        aria-modal="true"
        aria-label="Search docs"
        @click=${(e: Event) =>
          e.target === e.currentTarget && this.#setOpen(false)}
      >
        <div class="shell">
          <div class="search-bar">
            <span class="icon-search"></span>
            <input
              type="search"
              placeholder="Search docs"
              aria-label="Search docs"
              .value=${this.query}
              @input=${this.#onInput}
              @keydown=${this.#onKeydown}
            />
            <button class="close" @click=${() => this.#setOpen(false)}>
              esc
            </button>
          </div>

          ${this.query === ''
            ? html`<p class="empty">Type to search the guide and reference.</p>`
            : results.length === 0
              ? html`<p class="empty">No results for “${this.query}”.</p>`
              : html`
                  <ul class="results" role="listbox">
                    ${results.map(
                      (entry, i) => html`
                        <li role="option" aria-selected=${i === this.selected}>
                          <a href=${entry.url}>
                            <span class="result-section">${entry.section}</span>
                            <span class="result-title">${entry.title}</span>
                            ${this.#excerpt(entry)}
                          </a>
                        </li>
                      `,
                    )}
                  </ul>
                `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-search': ZenaSearch;
  }
}
