/**
 * Eleventy configuration for the Zena package manager documentation site
 * (`site/docs/` -> `out/docs/`) and the server-interpolated home page
 * template (`site/index.md` -> `out/home.html` and
 * `../pds/zena/web/pages/home-template.zena`).
 *
 * Reuses the main documentation site's Shiki Zena highlighter, markdown-it
 * plugins, TOC extractor, and sidebar helpers from `../website/lib/`.
 */

import {readFile, writeFile} from 'node:fs/promises';
import {createZenaHighlighter, renderCodeBlock} from '../website/lib/highlight.js';
import {configureMarkdown} from '../website/lib/markdown.js';
import {
  containsActive,
  flattenSidebar,
  sidebarFor,
} from '../website/lib/sidebar.js';
import {extractOutline} from '../website/lib/toc.js';

const HOME_ZENA_PATH = new URL(
  '../pds/zena/web/pages/home-template.zena',
  import.meta.url,
);

export default async function (eleventyConfig) {
  const highlighter = await createZenaHighlighter();

  eleventyConfig.amendLibrary('md', (md) => configureMarkdown(md, highlighter));

  /**
   * Emits a named slot sentinel (`<!--zena-slot-->name<!--zena-slot-->`) that
   * the Zena server (`packages/pds/zena/web/partials/slots.zena`) replaces at
   * request time with a server-rendered `HTMLPartial`.
   */
  eleventyConfig.addShortcode(
    'slot',
    (name) => `<!--zena-slot-->${name}<!--zena-slot-->`,
  );

  /** Builds the right-hand "On this page" tree from rendered HTML. */
  eleventyConfig.addFilter('outline', extractOutline);

  /** Marks a nav/sidebar entry active. */
  eleventyConfig.addFilter('isActive', (url, link, match) =>
    match ? url.startsWith(match) : url === link,
  );

  /** True when any descendant of a sidebar group is the current page. */
  eleventyConfig.addFilter('containsActive', containsActive);

  /** Picks the sidebar tree whose prefix matches the current URL. */
  eleventyConfig.addFilter('sidebarFor', sidebarFor);

  /** Flattens a sidebar tree to the ordered list of linked pages. */
  eleventyConfig.addFilter('flattenSidebar', flattenSidebar);

  /** Renders a code sample outside markdown. */
  eleventyConfig.addFilter('highlight', (code, lang = 'zena', label) =>
    renderCodeBlock(highlighter, String(code).trim() + '\n', lang, label),
  );

  eleventyConfig.addPairedShortcode('zena', (code, label) =>
    renderCodeBlock(highlighter, String(code).trim() + '\n', 'zena', label),
  );

  eleventyConfig.on('eleventy.after', async () => {
    const html = await readFile(new URL('./out/home.html', import.meta.url), 'utf8');
    const zenaSource = [
      '// Generated from packages/pds-web/site/index.md by Eleventy. Do not edit by hand.',
      `export let HOME_TEMPLATE = ${JSON.stringify(html)};`,
      '',
    ].join('\n');
    let existing = '';
    try {
      existing = await readFile(HOME_ZENA_PATH, 'utf8');
    } catch {
      // File does not exist yet.
    }
    if (existing !== zenaSource) {
      await writeFile(HOME_ZENA_PATH, zenaSource, 'utf8');
    }
  });

  return {
    dir: {
      input: 'site',
      output: 'out',
      includes: '../../website/src/_includes',
      layouts: '_layouts',
      data: '_data',
    },
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
  };
}
