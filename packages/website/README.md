# @zena-lang/website

The Zena documentation site: [Eleventy](https://www.11ty.dev/) for the build,
[Lit](https://lit.dev/) for the interactive parts, and a port of the
[VitePress](https://vitepress.dev/) default theme for the design.

```bash
npm run serve -w @zena-lang/website   # dev server with live reload
npm run build -w @zena-lang/website   # production build into _site/
```

## Layout

```
lib/                     Build-time modules used by eleventy.config.js
  highlight.js             Shiki, incl. Zena's TextMate grammar
  markdown.js              markdown-it: anchors, custom containers, code groups
  search-index.js          Builds _site/search-index.json from rendered pages
  sidebar.js               Sidebar lookup, flattening, prev/next
  toc.js                   Outline extraction from rendered HTML
scripts/
  scaffold-docs.js         Creates placeholder pages from the sidebar plan
  print-outline.js         Regenerates CONTENT.md from the sidebar plan
src/
  _data/                   site, nav, sidebar, eleventyComputed
  _includes/               nav bar, sidebar, outline, doc footer
  _layouts/                base, home, doc, page
  css/                     Stylesheet (see below)
  public/                  Copied verbatim to the site root
  guide/  reference/       Content
```

## Content

[`src/_data/sidebar.js`](src/_data/sidebar.js) is the source of truth for site
structure. Each leaf carries an `outline` — the sections that page is meant to
cover — which makes the sidebar the content plan as well as the navigation.

To add a page:

1. Add it to the sidebar with an `outline`.
2. `npm run scaffold -w @zena-lang/website` — creates the stub and updates
   [`CONTENT.md`](CONTENT.md). Existing files are never modified.
3. Write it, and drop the `status: Draft` front matter when it's real.

Prev/next links, the search index, and the outline rail are all derived, so
none of them need touching.

### Markdown extras

Beyond CommonMark, pages can use:

- `::: tip` / `note` / `info` / `important` / `warning` / `danger` — callouts
- `::: details Summary` — a collapsed block
- `::: code-group` — consecutive fences become tabs; label them with
  ` ```zena [main.zena] `
- ` ```zena ` — highlighted with the same grammar the VS Code extension uses

## Styling

`src/css/theme/` began as the VitePress 1.6.4 default theme and is now ours.
Class names are unprefixed and kebab-case (`button`, `sidebar-item`, `prose`,
`icon-chevron-right`); only the design tokens still carry the upstream `--vp-`
prefix. Zena's own decisions live in `src/css/brand.css` and
`src/css/zena-components.css`.

See [`src/css/theme/README.md`](src/css/theme/README.md) for the file-by-file
provenance, the five renames that needed more than a mechanical strip, and two
caveats worth knowing before editing: base rules must precede their media
queries, and several selectors are deliberate `>` chains so they don't capture a
nested component's `.container` or `.content`.

## Interactivity

Everything interactive is a Lit element in
[`@zena-lang/website-client`](../website-client), bundled by esbuild from an
Eleventy `before` hook so the dev server rebuilds it on change.

All of them render into **light DOM**, so the global stylesheet applies to them
exactly as it does to server-rendered markup. Most only enhance HTML Eleventy
already produced — the sidebar, outline, and nav all work without JavaScript.
