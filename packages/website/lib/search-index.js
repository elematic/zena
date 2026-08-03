import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {toPlainText} from './toc.js';

const H2_SPLIT = /<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g;
const MAIN_RE = /<main class="main">([\s\S]*?)<\/main>/;
const TITLE_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/;

/**
 * Splits one page's rendered HTML into per-section search entries.
 *
 * Indexing by `<h2>` rather than by page means a hit can deep-link to the
 * section that actually matched, which matters on the long reference pages.
 */
const entriesForPage = (url, breadcrumb, html) => {
  const main = MAIN_RE.exec(html)?.[1];
  if (main === undefined) return [];

  const pageTitle = toPlainText(TITLE_RE.exec(main)?.[1] ?? '') || url;
  const entries = [];

  // Everything before the first h2 belongs to the page itself.
  const firstH2 = main.search(/<h2\b/);
  const lead = toPlainText(firstH2 === -1 ? main : main.slice(0, firstH2));
  if (lead) {
    entries.push({title: pageTitle, section: breadcrumb, url, text: lead});
  }

  const matches = [...main.matchAll(H2_SPLIT)];
  for (const [i, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = matches[i + 1]?.index ?? main.length;
    entries.push({
      title: toPlainText(match[2]),
      section: `${breadcrumb} › ${pageTitle}`,
      url: `${url}#${match[1]}`,
      text: toPlainText(main.slice(start, end)),
    });
  }

  return entries;
};

/**
 * Writes `_site/search-index.json` from the pages Eleventy just rendered.
 *
 * Runs in the `eleventy.after` hook so it sees final HTML, which keeps the
 * index in step with whatever the layouts and markdown plugins produced.
 */
const SECTIONS = [
  ['/guide/', 'Guide'],
  ['/reference/', 'Reference'],
  ['/development/design/', 'Design'],
  ['/development/', 'Development'],
];

export const writeSearchIndex = async (dir, results) => {
  const entries = [];

  for (const result of results) {
    const url = result.url;
    // Longest prefix wins, so design docs are labelled "Design" not
    // "Development".
    const section = SECTIONS.find(([prefix]) => url?.startsWith(prefix));
    if (!section) continue;
    entries.push(...entriesForPage(url, section[1], result.content));
  }

  const output = join(dir, 'search-index.json');
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(entries));
  return entries.length;
};
