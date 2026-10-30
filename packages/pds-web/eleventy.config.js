/**
 * Eleventy configuration for the Zena package manager documentation site.
 *
 * Renders markdown pages under `site/docs/` into `out/docs/`, which the PDS
 * serves at `/docs/` from `PDS_WEB_DIR`. Reuses the main documentation site's
 * Shiki Zena highlighter, markdown-it plugins, TOC extractor, and sidebar
 * helpers from `../website/lib/`.
 */

import {createZenaHighlighter, renderCodeBlock} from '../website/lib/highlight.js';
import {configureMarkdown} from '../website/lib/markdown.js';
import {
  containsActive,
  flattenSidebar,
  sidebarFor,
} from '../website/lib/sidebar.js';
import {extractOutline} from '../website/lib/toc.js';

export default async function (eleventyConfig) {
  const highlighter = await createZenaHighlighter();

  eleventyConfig.amendLibrary('md', (md) => configureMarkdown(md, highlighter));

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

  return {
    dir: {
      input: 'site',
      output: 'out',
      includes: '_includes',
      layouts: '_layouts',
      data: '_data',
    },
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
  };
}
