import {createRequire} from 'node:module';
import * as esbuild from 'esbuild';
import MarkdownIt from 'markdown-it';
import {createZenaHighlighter, renderCodeBlock} from './lib/highlight.js';
import {configureMarkdown} from './lib/markdown.js';
import {writeSearchIndex} from './lib/search-index.js';
import {extractOutline} from './lib/toc.js';

const require = createRequire(import.meta.url);

const CLIENT_ENTRY = require.resolve('@zena-lang/website-client');
const CSS_ENTRY = './src/css/index.css';
// The playground starts this with `new URL('./worker/compiler-worker.js',
// import.meta.url)`, so it has to land next to the client bundle in `js/`.
const WORKER_ENTRY = require.resolve('@zena-lang/website-client/worker');

/** Held across rebuilds so esbuild's watcher is started exactly once. */
let assetContext;

/**
 * Bundles the Lit client and the stylesheet straight into `_site`.
 *
 * In watch/serve mode esbuild watches its own input graph. It has to: the
 * client lives in a sibling package, and registering that as an Eleventy watch
 * target moves chokidar's watch root up to `packages/`, after which every
 * "File changed" path Eleventy reports is prefixed (`./website/src/…`) and no
 * longer matches the `./src/…` keys in its template registry. Eleventy then
 * invalidates nothing, rebuilds every page, and re-renders all of them from a
 * cache seeded at startup — so the site silently stops updating.
 *
 * Keep every Eleventy watch target inside this package.
 */
const bundleAssets = async () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const isWatching = process.env.ELEVENTY_RUN_MODE !== 'build';

  const options = {
    entryPoints: [
      {in: CLIENT_ENTRY, out: 'js/zena'},
      {in: WORKER_ENTRY, out: 'js/worker/compiler-worker'},
      {in: CSS_ENTRY, out: 'css/style'},
    ],
    outdir: '_site',
    bundle: true,
    format: 'esm',
    target: ['es2022', 'chrome111', 'firefox113', 'safari16.4'],
    minify: isProduction,
    sourcemap: !isProduction,
    logLevel: 'warning',
  };

  if (!isWatching) {
    await esbuild.build(options);
    return;
  }

  if (assetContext) return;
  assetContext = await esbuild.context(options);
  await assetContext.rebuild();
  await assetContext.watch();
};

export default async function (eleventyConfig) {
  const highlighter = await createZenaHighlighter();

  /* Markdown ------------------------------------------------------------- */

  eleventyConfig.amendLibrary('md', (md) => configureMarkdown(md, highlighter));

  /* Assets --------------------------------------------------------------- */

  eleventyConfig.on('eleventy.before', bundleAssets);

  // Inside this package, so it doesn't move chokidar's watch root (see
  // bundleAssets). esbuild does the rebuild; this is what triggers the reload.
  eleventyConfig.addWatchTarget('./src/css/');

  // esbuild owns the stylesheet tree; Eleventy would otherwise turn the docs
  // in there into pages.
  eleventyConfig.ignores.add('src/css/**');

  eleventyConfig.addPassthroughCopy({'src/public': '.'});
  eleventyConfig.addPassthroughCopy({
    '../language-service/lsp.wasm': 'wasm/lsp.wasm',
  });

  /* Search index --------------------------------------------------------- */

  eleventyConfig.on('eleventy.after', async ({dir, results}) => {
    const count = await writeSearchIndex(dir.output, results);
    console.log(`[zena] search index: ${count} sections`);
  });

  /* Filters -------------------------------------------------------------- */

  /** Builds the right-hand "On this page" tree from rendered HTML. */
  eleventyConfig.addFilter('outline', extractOutline);

  /**
   * Marks a nav/sidebar entry active. `link` matches when it is the current
   * page; a `match` prefix matches anywhere in the section, which is what
   * makes "Guide" stay lit while you read any guide page.
   */
  eleventyConfig.addFilter('isActive', (url, link, match) =>
    match ? url.startsWith(match) : url === link,
  );

  /** True when any descendant of a sidebar group is the current page. */
  const containsActive = (item, url) => {
    if (item.link && url === item.link) return true;
    return (item.items ?? []).some((child) => containsActive(child, url));
  };
  eleventyConfig.addFilter('containsActive', containsActive);

  /** Picks the sidebar tree whose prefix matches the current URL. */
  eleventyConfig.addFilter('sidebarFor', (sidebar, url) => {
    const prefix = Object.keys(sidebar)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? sidebar[prefix] : null;
  });

  /** Flattens a sidebar tree to the ordered list of linked pages. */
  const flatten = (items) =>
    items.flatMap((item) => [
      ...(item.link ? [item] : []),
      ...flatten(item.items ?? []),
    ]);
  eleventyConfig.addFilter('flattenSidebar', flatten);

  /**
   * Renders a markdown string. Used for the design docs, which are read from
   * `docs/design/` as data rather than being Eleventy templates. Its own
   * markdown-it instance, configured identically to Eleventy's.
   */
  const standaloneMarkdown = configureMarkdown(new MarkdownIt(), highlighter);
  eleventyConfig.addFilter('markdown', (content) =>
    standaloneMarkdown.render(String(content ?? '')),
  );

  /** Renders a code sample outside markdown (used by the home page). */
  eleventyConfig.addFilter('highlight', (code, lang = 'zena', label) =>
    renderCodeBlock(highlighter, String(code).trim() + '\n', lang, label),
  );

  eleventyConfig.addFilter('date', (value) =>
    new Date(value).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
  );

  /* Shortcodes ----------------------------------------------------------- */

  eleventyConfig.addPairedShortcode('zena', (code, label) =>
    renderCodeBlock(highlighter, String(code).trim() + '\n', 'zena', label),
  );

  return {
    dir: {
      input: 'src',
      output: '_site',
      includes: '_includes',
      layouts: '_layouts',
      data: '_data',
    },
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
  };
}
