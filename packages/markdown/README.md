# Markdown (`@zena-lang/markdown`)

A CommonMark and GitHub Flavored Markdown (GFM) parser, syntax tree, plugin
system, and HTML renderer written in Zena (`zena-lang:markdown/<library>`).
See [docs/design/markdown.md](../../docs/design/markdown.md) for the design.

## Usage

Add it with `zena pkg add zena-lang:markdown`, then import its main
library:

```zena
import {
  parse, renderHtml, markdownToHtml, gfmExtensions
} from 'zena-lang:markdown';

// Render CommonMark + GFM to safe HTML (raw HTML stripped, unsafe URLs blocked)
let html = markdownToHtml('# Hello\n\nSome ~~old~~ **new** text.', {
  extensions: gfmExtensions(),
  safe: true,
});

// Or parse to an AST first
let doc = parse('# Heading\n\nParagraph.', gfmExtensions());
let out = renderHtml(doc, {safe: true, extensions: gfmExtensions()});
```

## Running Tests

```bash
npm test -w @zena-lang/markdown
npm run test:quick -- packages/markdown/test
```
