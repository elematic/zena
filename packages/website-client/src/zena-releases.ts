import {html, nothing, type TemplateResult} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {LightElement} from './light-element.js';
import {
  formatByteSize,
  parseGitHubReleases,
  type GitHubReleaseRaw,
  type ParsedRelease,
  type PlatformDownload,
} from './release-data.js';

type LoadState = 'loading' | 'ready' | 'error';

const SAFE_URL = /^(https?:\/\/|\/)/i;

/**
 * Renders inline Markdown spans (`code`, `**bold**`, and `[text](url)`) using
 * Lit templates so untrusted HTML is never injected.
 */
const renderInlineMarkdown = (text: string): Array<string | TemplateResult> => {
  const out: Array<string | TemplateResult> = [];
  const tokenPattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      out.push(text.slice(cursor, start));
    }
    if (match[1] !== undefined) {
      out.push(html`<code>${match[1]}</code>`);
    } else if (match[2] !== undefined) {
      out.push(html`<strong>${match[2]}</strong>`);
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[4];
      if (SAFE_URL.test(href)) {
        out.push(
          html`<a href=${href} target="_blank" rel="noopener">${match[3]}</a>`,
        );
      } else {
        out.push(match[0]);
      }
    }
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }
  return out;
};

/**
 * Renders Keep a Changelog prose (`###` headings, bullet lists, and paragraphs)
 * into light-DOM elements styled by `.prose`.
 */
const renderChangelog = (markdown: string): TemplateResult | typeof nothing => {
  if (!markdown) return nothing;

  const blocks: TemplateResult[] = [];
  const lines = markdown.split(/\r?\n/);
  let listItems: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const joined = paragraphLines.join(' ');
    paragraphLines = [];
    blocks.push(html`<p>${renderInlineMarkdown(joined)}</p>`);
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    blocks.push(
      html`<ul>
        ${items.map((item) => html`<li>${renderInlineMarkdown(item)}</li>`)}
      </ul>`,
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^(#{2,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push(html`<h4>${renderInlineMarkdown(headingMatch[2])}</h4>`);
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      flushParagraph();
      if (listItems.length > 0 && rawLine.startsWith('  ')) {
        listItems[listItems.length - 1] += ` ${bulletMatch[1]}`;
      } else {
        listItems.push(bulletMatch[1]);
      }
      continue;
    }

    if (listItems.length > 0 && /^\s{2,}\S/.test(rawLine)) {
      listItems[listItems.length - 1] += ` ${line}`;
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();

  return html`<div class="release-changelog">${blocks}</div>`;
};

/**
 * Fetches published releases from GitHub Releases and renders platform archive
 * links, SHA-256 checksums, and changelog notes.
 */
@customElement('zena-releases')
export class ZenaReleases extends LightElement {
  @property({type: String}) repo = 'elematic/zena';
  @property({type: String, attribute: 'api-url'}) apiUrl = '';

  @state() private status: LoadState = 'loading';
  @state() private releases: ParsedRelease[] = [];
  @state() private copiedKey = '';

  #abort?: AbortController;
  #copyTimer?: ReturnType<typeof setTimeout>;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#copyTimer !== undefined) {
      clearTimeout(this.#copyTimer);
    }
  }

  async #load(): Promise<void> {
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;
    this.status = 'loading';

    const endpoint =
      this.apiUrl ||
      `https://api.github.com/repos/${this.repo}/releases?per_page=25`;

    try {
      const res = await fetch(endpoint, {
        headers: {Accept: 'application/vnd.github+json'},
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as GitHubReleaseRaw[];
      if (controller.signal.aborted) return;
      this.releases = parseGitHubReleases(Array.isArray(data) ? data : []);
      this.status = 'ready';
    } catch {
      if (controller.signal.aborted) return;
      this.status = 'error';
    }
  }

  async #copyHash(key: string, sha256: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(sha256);
    } catch {
      return;
    }
    this.copiedKey = key;
    if (this.#copyTimer !== undefined) {
      clearTimeout(this.#copyTimer);
    }
    this.#copyTimer = setTimeout(() => {
      this.copiedKey = '';
    }, 2000);
  }

  #renderPlatformRow(tagName: string, item: PlatformDownload): TemplateResult {
    const sizeLabel = formatByteSize(item.sizeBytes);
    const copyKey = `${tagName}:${item.target}`;
    const isCopied = this.copiedKey === copyKey;

    return html`
      <tr>
        <td class="release-platform-cell">${item.label}</td>
        <td class="release-archive-cell">
          <a href=${item.archiveUrl}><code>${item.archiveName}</code></a>
          ${
            sizeLabel
              ? html`<span class="release-size">(${sizeLabel})</span>`
              : nothing
          }
        </td>
        <td class="release-checksum-cell">
          ${
            item.sha256
              ? html`
                  <div class="release-checksum-wrap">
                    <code class="release-checksum-code" title=${item.sha256}
                      >${item.sha256}</code
                    >
                    <button
                      type="button"
                      class="release-hash-copy ${isCopied ? 'copied' : ''}"
                      @click=${() => this.#copyHash(copyKey, item.sha256!)}
                      aria-label="Copy SHA-256 checksum for ${item.archiveName}"
                    >
                      ${isCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                `
              : item.sha256FileUrl
                ? html`<a href=${item.sha256FileUrl}><code>.sha256</code></a>`
                : html`<span class="release-muted">—</span>`
          }
        </td>
      </tr>
    `;
  }

  #renderRelease(release: ParsedRelease): TemplateResult {
    return html`
      <article class="release-card" id=${release.tagName}>
        <header class="release-card-header">
          <div class="release-card-title-group">
            <h3 class="release-card-title">
              <a href="#${release.tagName}" class="release-card-anchor"
                >${release.title}</a
              >
            </h3>
            ${
              release.isLatestStable
                ? html`<span class="badge success">Latest</span>`
                : nothing
            }
            ${
              release.prerelease
                ? html`<span class="badge warning">Pre-release</span>`
                : nothing
            }
            ${
              release.prerelease && release.isNewest && !release.isLatestStable
                ? html`<span class="badge info">Newest</span>`
                : nothing
            }
          </div>
          <div class="release-card-meta">
            ${
              release.publishedIso && release.publishedLabel
                ? html`<time datetime=${release.publishedIso}
                    >${release.publishedLabel}</time
                  >`
                : nothing
            }
            <a
              href=${release.htmlUrl}
              target="_blank"
              rel="noopener"
              class="release-github-link"
              >GitHub Release &nearr;</a
            >
          </div>
        </header>

        ${renderChangelog(release.changelog)}
        ${
          release.platforms.length > 0
            ? html`
                <div class="release-table-wrap">
                  <table class="release-downloads-table">
                    <thead>
                      <tr>
                        <th>Platform</th>
                        <th>Archive</th>
                        <th>SHA-256</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${release.platforms.map((item) =>
                        this.#renderPlatformRow(release.tagName, item),
                      )}
                    </tbody>
                  </table>
                </div>
              `
            : nothing
        }

        <footer class="release-card-footer">
          <span class="release-pin-hint">
            Pin this release:
            <code
              >curl -fsSL https://zena-lang.dev/install.sh |
              ZENA_VERSION=${release.tagName} sh</code
            >
          </span>
          ${
            release.sha256SumsUrl
              ? html`<a href=${release.sha256SumsUrl} class="release-sums-link"
                  ><code>SHA256SUMS</code></a
                >`
              : nothing
          }
        </footer>
      </article>
    `;
  }

  override render(): TemplateResult {
    const releasesPageUrl = `https://github.com/${this.repo}/releases`;

    if (this.status === 'loading') {
      return html`
        <div class="releases-status" role="status">
          <p>
            Loading releases from GitHub… Or view all releases directly at
            <a href=${releasesPageUrl} target="_blank" rel="noopener"
              >github.com/${this.repo}/releases</a
            >.
          </p>
        </div>
      `;
    }

    if (this.status === 'error') {
      return html`
        <div class="custom-block info">
          <p class="custom-block-title">GitHub Releases</p>
          <p>
            Could not load the live release feed right now. Browse all published
            archives, release notes, and <code>SHA256SUMS</code> manifests at
            <a href=${releasesPageUrl} target="_blank" rel="noopener"
              >github.com/${this.repo}/releases</a
            >.
          </p>
        </div>
      `;
    }

    if (this.releases.length === 0) {
      return html`
        <div class="custom-block info">
          <p class="custom-block-title">No releases published yet</p>
          <p>
            Prebuilt CLI archives will appear here automatically once the first
            release is published on
            <a href=${releasesPageUrl} target="_blank" rel="noopener"
              >GitHub Releases</a
            >. Until then, follow
            <a href="/guide/getting-started/">Getting Started</a> to build the
            toolchain from source.
          </p>
        </div>
      `;
    }

    return html`
      <div class="releases-list">
        ${this.releases.map((rel) => this.#renderRelease(rel))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-releases': ZenaReleases;
  }
}
