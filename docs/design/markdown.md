# Markdown Parser (`packages/markdown`)

## Overview

`packages/markdown` (Zena package `markdown`) parses CommonMark and GitHub
Flavored Markdown (GFM) into a typed syntax tree and renders it to HTML. It
serves three main consumers in the repository and ecosystem:

1. **The package registry (`packages/registry`)**: rendering a published
   package's `README.md` and `zenadoc` prose on its web page, with raw HTML
   sanitized and relative links resolved.
2. **API documentation (`packages/zenadoc`)**: parsing doc-comment bodies,
   extracting summaries, and resolving intra-doc symbol links.
3. **Content management systems and documentation sites**: parsing Markdown
   with custom block directives, inline syntax, heading anchors, and custom
   node renderers.

The parser follows the two-phase strategy in Appendix A of the CommonMark
specification, modelled on `commonmark-java`'s parser and extension interfaces,
with two changes for Zena:

- **UTF-8 byte scanning and trigger-byte dispatch** (from `goldmark` and
  `markdig`): CommonMark and GFM delimiters are ASCII bytes (`< 0x80`), so the
  scanner operates on UTF-8 byte offsets into the source `String` with zero
  regular expressions. Block and inline extensions declare the ASCII bytes
  that can start them, and the parser dispatches through a 128-entry table.
- **Flat array children and `sealed class` node hierarchies**: core blocks and
  inlines are variants of `sealed class Block` and `sealed class Inline`
  holding `GrowableArray` children and byte spans, with `CustomBlock` and
  `CustomInline` base classes for extension-defined AST nodes.

## Architecture

Parsing runs in three phases, followed by rendering:

1. **Block parsing (`block-parser.zena`)**: reads the input line by line,
   expanding tabs to 4-column stops for indentation checks while keeping byte
   offsets into the original `String`. At each line, the parser checks whether
   open container blocks (`Document`, `BlockQuote`, `ListBlock`, `ListItem`, or
   a plugin container) continue, then checks whether the remaining line opens a
   new child block, and finally adds any remaining text to the active leaf
   block (such as a `Paragraph`, `FencedCodeBlock`, or `HtmlBlock`). When a
   paragraph closes, leading link reference definitions (`[label]: /url
"title"`) are extracted into the document's `LinkDef` map.
2. **Inline parsing (`inline-parser.zena`)**: once all blocks are closed, each
   block that carries inline text invokes the inline parser over its raw text.
   The inline parser scans characters, handles backslash escapes, code spans,
   autolinks, and raw HTML tags, pushes paired delimiters (`*`, `_`, `~`, or
   plugin delimiters) onto a doubly linked delimiter stack, and pushes `[` and
   `![` onto a bracket stack. When `]` arrives, it resolves inline, reference,
   collapsed, or shortcut links against the bracket stack and `LinkDef` map,
   and runs `processDelimiters` on the interior of the link text. At the end of
   the block, `processDelimiters` resolves remaining emphasis and plugin
   delimiters in linear time.
3. **AST transformation (`AstTransformer`)**: registered transformers walk or
   rewrite the completed `Document` tree. Built-in extensions use this phase to
   turn `> [!NOTE]` block quotes into `AlertBlock` nodes, extract `- [x]` task
   list markers on `ListItem` nodes, and assign deduplicated `id` slugs to
   `Heading` nodes.
4. **Rendering (`html.zena`)**: walks the `Document` tree and writes HTML to a
   `StringBuilder`, consulting registered `NodeRenderer` plugins for
   `CustomBlock` and `CustomInline` nodes and applying HTML sanitization and
   URL filtering when `safe` mode is enabled.

## Abstract syntax tree

Every AST node carries a `Span(start: i32, end: i32)` recording its 0-based
UTF-8 byte offsets in the source string.

```zena
export final class Span(start: i32, end: i32)

export final class Document(
  blocks: GrowableArray<Block>,
  links: HashMap<String, LinkDef>,
  span: Span
)
```

Core block and inline nodes form two `sealed class` hierarchies in
`markdown/ast`. Each hierarchy includes one open abstract variant
(`CustomBlock` and `CustomInline`) that plugins subclass for their own syntax
nodes:

```zena
export sealed class Block {
  case Paragraph(var inlines: GrowableArray<Inline>, var id: String | null, span: Span)
  case Heading(level: i32, var inlines: GrowableArray<Inline>, var id: String | null, span: Span)
  case BlockQuote(var blocks: GrowableArray<Block>, span: Span)
  case ListBlock(ordered: boolean, startNumber: i32, delimiter: i32, var tight: boolean, var items: GrowableArray<ListItem>, span: Span)
  case ListItem(var blocks: GrowableArray<Block>, var checked: Option<boolean>, span: Span)
  case FencedCodeBlock(info: String, literal: String, span: Span)
  case IndentedCodeBlock(literal: String, span: Span)
  case HtmlBlock(literal: String, span: Span)
  case ThematicBreak(span: Span)
  case CustomBlock
}

export abstract class CustomBlock extends Block {
  span: Span;
  new(this.span) : super();
}
```

And for inline nodes:

```zena
export sealed class Inline {
  case Text(var literal: String, span: Span)
  case CodeSpan(literal: String, span: Span)
  case Emphasis(delimiter: i32, var children: GrowableArray<Inline>, span: Span)
  case Strong(delimiter: i32, var children: GrowableArray<Inline>, span: Span)
  case Link(destination: String, title: String, var children: GrowableArray<Inline>, span: Span)
  case Image(destination: String, title: String, alt: String, var children: GrowableArray<Inline>, span: Span)
  case Autolink(destination: String, label: String, isEmail: boolean, span: Span)
  case HtmlInline(literal: String, span: Span)
  case SoftBreak(span: Span)
  case HardBreak(span: Span)
  case CustomInline
}

export abstract class CustomInline extends Inline {
  span: Span;
  new(this.span) : super();
}
```

A consumer matching a `Block` gets exhaustiveness checking across the nine core
variants and the `CustomBlock` branch, and a plugin renderer or transformer can
match concrete plugin subclasses (`case TableBlock as t: ...`) directly.

## Extension API

A plugin implements one or more of five interfaces in `markdown/plugin` and is
registered through a `MarkdownExtension` passed to `Parser` and `HtmlRenderer`:

1. **`BlockParserFactory`**: starts custom block containers or leaf blocks
   during Phase 1.
   - `triggerBytes(): Array<i32>` returns the ASCII bytes that can start the
     block (or an empty array if the factory can start on any character, such
     as a pipe table whose header row has no leading `|` and is detected on the
     delimiter row).
   - `tryStart(state: BlockLineState, matched: MatchedBlockInfo): CustomBlockStart | null`
     inspects the current line at `state.nextNonSpaceIndex` and the matched
     tip block (including any paragraph text accumulated so far) and returns a
     `CustomBlockStart` with the new `CustomBlockParser`, the column or byte index to
     advance to, and whether to replace the active paragraph.
2. **`DelimiterProcessor`**: processes paired inline delimiters in Phase 2 using
   CommonMark's delimiter stack.
   - `openingByte(): i32`, `closingByte(): i32`, `minLength(): i32`.
   - `process(opener: DelimiterRunInfo, closer: DelimiterRunInfo, children: GrowableArray<Inline>): inline (i32, Inline | null)`
     inspects the opening and closing delimiter runs, wraps `children` in a new
     node (such as `Strikethrough`), and returns the number of delimiters
     consumed (`0` if the runs do not match) and the wrapped node.
3. **`InlineContentParser`**: parses custom inline syntax starting at a trigger
   byte in Phase 2.
   - `triggerBytes(): Array<i32>` lists the ASCII starter bytes (for example
     `h`, `H`, `w`, `W`, or `@`).
   - `tryParse(source: String, baseOffset: i32, index: i32, precedingByte: i32, inlineParser: InlineParserRunner): InlineMatch | null`
     scans forward from `index` and returns the constructed `Inline` node and
     the new byte index when matched.
4. **`AstTransformer`**: runs in Phase 3 over the parsed `Document`.
   - `transform(doc: Document, inlineParser: InlineParserRunner): void` mutates
     or rewrites blocks and inlines in place.
5. **`NodeRenderer`**: renders `CustomBlock` and `CustomInline` nodes in Phase 4.
   - `renderBlock(block: CustomBlock, ctx: HtmlRenderContext): boolean`
   - `renderInline(inline: CustomInline, ctx: HtmlRenderContext): boolean`

## Built-in extensions

Every extension in `packages/markdown/src/plugins/` uses the public extension
interfaces above:

- **`strikethrough` (`DelimiterProcessor`)**: matches `~` or `~~` runs of equal
  length (1 or 2 tildes per GFM) and wraps the enclosed nodes in a
  `Strikethrough(children, span)` `CustomInline`, rendered as `<del>…</del>`.
- **`tables` (`BlockParserFactory` + `NodeRenderer`)**: detects GFM pipe tables
  when an open paragraph of one line is followed by a delimiter row (`| --- |
:-- | --: | :-: |`). Replaces the paragraph with a `TableBlock(alignments,
head, rows, span)` `CustomBlock` and parses subsequent rows until a blank
  line or interrupting block.
- **`task-list` (`AstTransformer`)**: inspects the leading `Text` of the first
  `Paragraph` in each `ListItem` for `[ ] `, `[x] `, or `[X] `, sets
  `item.checked` to `Some(false)` or `Some(true)`, and strips the prefix from
  the paragraph text. The HTML renderer emits `<input type="checkbox"
disabled="" checked="" />` inside `<li class="task-list-item">`.
- **`autolink` (`InlineContentParser`)**: scans bare `http://`, `https://`, and
  `www.` URLs (trimming trailing punctuation and balancing parentheses per the
  GFM autolink specification) into `Autolink` nodes.
- **`alerts` (`AstTransformer` + `NodeRenderer`)**: inspects `BlockQuote` nodes
  whose first paragraph begins with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]`, or `[!CAUTION]` followed by a line break or end of paragraph,
  and replaces the `BlockQuote` with an `AlertBlock(kind, title, blocks, span)`
  `CustomBlock`, rendered as `<div class="markdown-alert
markdown-alert-<kind>">`.
- **`heading-anchors` (`AstTransformer`)**: extracts plain text from each
  `Heading`'s inline children, normalizes it to a lowercase hyphenated slug,
  deduplicates collisions within the document (`slug`, `slug-1`, `slug-2`), and
  populates `heading.id`.
- **`gfm`**: convenience bundle returning all of the extensions above so callers
  can pass `gfmExtensions()` to `parse` and `renderHtml`.

## HTML rendering and sanitization

`renderHtml(doc, options)` takes `HtmlRenderOptions`:

- `safe: boolean` (default `false`): when `true`, raw `HtmlBlock` and
  `HtmlInline` nodes are omitted (or escaped when `escapeRawHtml: true`), and
  `Link` and `Image` destinations are checked with `isSafeUrl`.
- `isSafeUrl`: allows relative URLs (`/path`, `./path`, `../path`, `#fragment`,
  `?query`) and explicit `http:`, `https:`, and `mailto:` schemes (plus `irc:`
  and `xmpp:` for links), rejecting `javascript:`, `vbscript:`, `data:`, and
  control characters after entity decoding.
- `softBreak: String` (default `"\n"`): string emitted for `SoftBreak`.
- `extensions: Array<MarkdownExtension>`: custom `NodeRenderer` providers.

## Alternatives considered

### Porting `markdown-it`

`markdown-it` and its companion libraries (`linkify-it`, `mdurl`, `uc.micro`)
rely on JavaScript regular expressions with lookaheads and stateful `lastIndex`
matching, UTF-16 `charCodeAt` indexing, and untyped `Token` and `state.env`
objects. Because `zena:regex` is a Thompson NFA engine without lookahead or
backreferences, porting `markdown-it` requires rewriting its scanners by hand
while still carrying an untyped token stream instead of a syntax tree.

### Porting `pulldown-cmark`

`pulldown-cmark` is compact and UTF-8 byte-oriented, and produces a pull
iterator of `Event` values. However, it has no syntax plugin API—its GFM
extensions are hardcoded into its two-pass state machine—and post-processing an
event stream requires buffering and replaying events whenever a transformation
needs subtree lookahead (such as computing a heading's `id` slug from its child
text nodes before emitting the opening `<h2>` tag).
