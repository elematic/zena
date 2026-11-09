# The Markdown Parser (For AI Agents)

`packages/markdown` is Zena's CommonMark and GitHub Flavored Markdown (GFM)
parser, syntax tree, plugin API, and HTML renderer (`markdown`, imported as
`markdown:<library>`). See [docs/design/markdown.md](../../docs/design/markdown.md)
for the architecture.

## Layout

- `zena/ast.zena`: `Span`, `Document`, `LinkDef`, and the `Block` and `Inline`
  `sealed class` hierarchies (including `CustomBlock` and `CustomInline` for
  extension nodes).
- `zena/plugin.zena`: the five extension interfaces (`BlockParserFactory`,
  `DelimiterProcessor`, `InlineContentParser`, `AstTransformer`,
  `NodeRenderer`) and `MarkdownExtension`.
- `zena/scanner.zena`: UTF-8 byte scanning helpers, tab-stop column math, HTML
  entity decoding, backslash unescaping, and link destination/title/label
  scanners.
- `zena/block-parser.zena`: CommonMark Phase 1 block parser (`BlockParser`,
  open-block stack, lazy continuation, link reference definitions, and
  trigger-byte dispatch for `BlockParserFactory` plugins).
- `zena/inline-parser.zena`: CommonMark Phase 2 inline parser (delimiter stack,
  bracket stack for links and images, code spans, autolinks, raw HTML tags, and
  `DelimiterProcessor` / `InlineContentParser` dispatch).
- `zena/html.zena`: `renderHtml` and `HtmlRenderOptions`, including `safe` mode
  (raw HTML stripping/escaping and URL scheme checks) and `NodeRenderer`
  dispatch.
- `zena/plugins/`: built-in extensions implemented against `markdown:plugin`:
  - `strikethrough.zena`: `~` / `~~` strikethrough (`DelimiterProcessor` +
    `Strikethrough` inline node + `NodeRenderer`).
  - `tables.zena`: GFM pipe tables (`BlockParserFactory` + `TableBlock` node +
    `NodeRenderer`).
  - `task-list.zena`: `- [ ]` / `- [x]` task list items (`AstTransformer`).
  - `autolink.zena`: bare `http://`, `https://`, and `www.` autolinks
    (`InlineContentParser`).
  - `alerts.zena`: GitHub alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`,
    `> [!WARNING]`, `> [!CAUTION]`) (`AstTransformer` + `AlertBlock` +
    `NodeRenderer`).
  - `heading-anchors.zena`: heading `id` slug generation and deduplication
    (`AstTransformer`).
  - `gfm.zena`: bundles the GFM extensions, alerts, and heading anchors.
- `zena/index.zena`: public facade re-exporting the AST, plugin interfaces,
  `parse`, `renderHtml`, `markdownToHtml`, and the built-in extensions.
- `zena/test/`: test suites (`commonmark_test.zena`, `plugins_test.zena`,
  `sanitize_test.zena`).

## Conventions

- Keep the core parser free of regular expressions; scan UTF-8 bytes directly.
- New syntax extensions belong under `zena/plugins/` and must use the public
  interfaces in `zena/plugin.zena` rather than adding special cases to
  `block-parser.zena`, `inline-parser.zena`, or `html.zena`.
