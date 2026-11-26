# ZenaFX Text Flow: Inline Nodes and Rich Text

## Status

Proposal, with its first step built: a flow container whose text children
are laid out as one piece of text, each in its own style.
[Build order](#build-order) says what that step leaves out. Spans and boxes
in a line are not built.

It asks for four decisions:

1. A bold word, an emphasised phrase and a link are nodes, as they are
   elements in HTML. See [Inline nodes](#inline-nodes).
2. A node says how it lays out its children: as flex items, or as text that
   flows in lines. It does not say how it sits in its parent, which the
   parent's layout decides. See [Two layouts](#two-layouts).
3. A node whose children flow as text holds text runs, spans and boxes placed
   in a line. Blocks and inline content are not mixed in one container, and
   the host makes no boxes that the tree does not have. See
   [What a flow container holds](#what-a-flow-container-holds).
4. A span has a rectangle for each line it is on, where every other node has
   one. See [Spans](#spans).

[Build order](#build-order) says what comes first.

## Overview

A ZenaFX window has two programs in it. The **host** is the Rust process: it
holds the tree of nodes, lays it out, paints it and reads input. A
**component** is the application, a WebAssembly component that describes the
tree through the interface in `packages/zenafx/wit/zenafx.wit`.

Rich text is text in which parts differ: a word in bold, a phrase that is a
link, a name in another colour. A paragraph of it is still one piece of text
to lay out. Its words are shaped together, its lines are broken across the
whole of it, and a mix of left-to-right and right-to-left text is ordered
across the whole of it.

HTML describes such a paragraph as a tree: a `<p>` holding text, a `<strong>`
holding more text, an `<a>` holding more. Layout then treats everything inside
the `<p>` as one sequence. This document proposes the same arrangement. The
parts are nodes, so each can have rules, state, a cursor and listeners as any
node can, and the host lays the nodes of one paragraph out as one piece of
text.

## Terms

- **Node**: one item in the tree the host holds.
- **Text run**: a node that is a string. It is a leaf.
- **Flow container**: a node whose children are laid out as text in lines.
- **Span**: a flow container inside a flow container. Its content is part of
  the lines of the container it is in.
- **Box in a line**: a node inside a flow container that is neither a text run
  nor a span, such as an icon. It is placed in a line as one box.
- **Inline node**: a text run, a span or a box in a line.
- **Flex item**: a child of a node that lays out its children with flex. This
  is every node today.

## Text today

A node's style is nothing, a fill or text. Text is one string and one
`text-style`: a family, a size, a weight, italic or not, and a colour.

- The host's text engine, `packages/zenafx-render/src/text.rs`, shapes each text
  node's string by itself and keeps the result until the node goes away.
- A text node is a flex item. The flex layout asks the engine how wide and how
  tall the text is at a width, and the engine breaks its lines at that width.
- The painter draws a text node's glyphs in the node's one colour.
- The window's selection is two places, each a text node and a count of bytes
  into its string. It can begin in one text node and end in another.

So a paragraph with one bold word, written as three text nodes in a row, is
three boxes. Each is shaped and broken by itself, which is right only while
the three fit on one line.

A node can also be a flow container, by the `flow` case of `layout` in its
`node-def`. The engine then shapes the strings of its text children as one
run, and the rest of this document builds on that.

## Two layouts

A node lays out its children in one of two ways.

- **Flex**, as every node does today: the children are items in a row or a
  column.
- **Flow**: the children are text and things placed in text. They are set in
  lines, and a line that is full continues on the next.

Which one is a property of the node, in the sense of
[zenafx-styles.md](./zenafx-styles.md#properties), with the other properties
that say how a node arranges what is in it. A custom layout from
[Window components](./zenafx-styles.md#window-components) would be a third
value of the same property.

In the interface the property is `layout` in `node-def`, a variant with a
case for each layout. A case holds what that layout needs and nothing else,
so a flow container has no `gap` to set and a row has no `line-height`.

```wit
variant layout {
  flex(flex),   // axis, justify-content, align-items, gap
  flow(flow),   // align, line-height
}
```

What every node has whichever way it lays out its children is in a second
record, `box`: its width and height, how it grows and shrinks, its padding,
and what becomes of content that does not fit.

A flow container has a few properties of its own.

| Property      | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `text-align`  | start, center, end or justify                             |
| `line-height` | the distance from one line to the next, or the font's own |
| `text-indent` | how far in the first line starts                          |

It is a box like any other in every other way. It has a width, padding and a
fill, and its parent places it. A paragraph and a heading are flow containers
with different text sizes, and the space between two paragraphs is their
parent's gap.

### How a node sits in its parent

CSS divides `display` in two: an outer part, which says whether an element is
a block or sits in a line, and an inner part, which says how it lays out its
children. Here a node has the inner part only. What a node is to its parent
follows from the parent's layout and the node's own.

| The parent lays out by | The node is                   | It is laid out as           |
| ---------------------- | ----------------------------- | --------------------------- |
| flex                   | anything                      | a flex item                 |
| flow                   | a text run                    | text in the parent's lines  |
| flow                   | a flow container              | a span                      |
| flow                   | anything else                 | a box in a line             |
| flex                   | a text run, with no container | a flow container of its own |

The last row keeps every template written so far working: a text node placed
straight into a row or a column is a flow container with one run in it.

CSS does this already inside flex and grid, where `display: inline` on an item
is ignored and the container decides.

### What a flow container holds

A flow container holds inline nodes and nothing else: text runs, spans, and
boxes in a line. It does not hold a block, in CSS's sense of a child that takes
the full width on lines of its own.

A page of several paragraphs is therefore a column, by flex, with a flow
container for each paragraph. Markdown has this shape already: its inline
content never contains a block.

CSS allows more. A `<div>` can hold loose text beside a `<p>`, and a `<span>`
can hold a `<div>`. The engine makes that work by adding boxes the document
does not have, around a stretch of loose text, and by cutting an inline
element in two where a block appears inside it. This document leaves both out
of the host. A tree here is always made by code, a widget or an importer for a
document format, and that code can make the container the loose text needs.

## Inline nodes

### Text runs

A text run is a string, as a text node is today. Its string is still written
through a property hole.

A run's style is the text properties in force at it: family, size, weight,
italic and colour. Until those are properties that inherit, as
[Inheritance](./zenafx-styles.md#inheritance) proposes, a run carries its
whole `text-style` as a text node does today, and a bold run says its weight
itself.

A run's string is used as written. Spaces are kept and a line feed ends a
line. HTML collapses runs of spaces and drops line feeds because its source is
written by hand and indented. A string here comes from code.

### Spans

A span is a node that groups part of a line: the text of a link, or a phrase
with a background. It holds runs, other spans and boxes in a line.

A span is a node in every way but its geometry.

- A rule can apply to it and give it text properties, a background and a
  cursor. Its children inherit from it.
- It is hovered while the pointer is over any of its text, and it can be
  pressed and focused. `hovered` on a link is how its colour changes under the
  pointer.
- A listener on it hears a press on its text.

Its geometry is a list of rectangles, one for each line it has text on. A link
that starts near the end of one line and finishes on the next has two. The
properties that size and place a box, such as width, height and padding, do
not apply to a span.

Where the rest of the design speaks of a node's box, a span has these.

| Where a box is used                | For a span                                                             |
| ---------------------------------- | ---------------------------------------------------------------------- |
| finding the node under the pointer | the pointer is over one of its rectangles                              |
| a background, a focus ring         | drawn for each rectangle                                               |
| the position a listener is given   | measured from the corner of the smallest rectangle that holds them all |
| the `width` and `height` facts     | of that smallest rectangle                                             |

### Boxes in a line

Any other node in a flow container is placed in a line as one box: an icon, a
button, a small chart. It is laid out by its own layout at the size it asks
for, and the line is broken round it as round a word. It sits on the line's
baseline. It is never broken across two lines.

## Layout and painting in the host

A flow container is one item to its parent. When the parent's layout asks how
wide and how tall it is at a width, the host builds one text layout from
everything inline beneath it:

1. It walks the container's inline nodes in the order of the tree and joins
   the strings of the runs into one string, noting where each run starts.
2. It gives the layout library that string and the style of each stretch.
   Parley, the library the host uses, takes text as a tree of styled spans or
   as a string with styled ranges, and orders right-to-left text across the
   whole string.
3. It gives each box in a line a place in the string and its size.
4. It breaks lines at the width asked for.

The result is kept as a text node's is kept today. It is built again when a
run's string or style changes, or when an inline node is added or taken away.
It is broken again when the width changes.

The host then answers every question about the inline nodes from this one
layout.

- **Painting.** Each stretch of glyphs is drawn in its own run's colour. A
  span's background is drawn under its rectangles.
- **The node under the pointer.** The layout gives the place in the string
  nearest the pointer, and the place gives the run and the spans round it.
- **The selection.** To the selection a flow container is one text, and a
  place in it is a count of bytes into the joined string. A second press
  selects a word by that string, so a word that is half bold is still one
  word. A component is told where the selection is only in a text field, whose
  text is one run, so nothing a component sees changes.
- **Copying.** Text from two runs of one container is joined with nothing
  between. A line feed goes between two containers.

## What is left out

- **Blocks beside inline content in one container**, as under
  [What a flow container holds](#what-a-flow-container-holds).
- **Floats**: text that goes round an image at the side of a column. A
  document needs them sooner or later, and nothing here gives them.
- **Styles for a part of the text that is not a node.** Three kinds are
  wanted in time. Marks over a large text that change only how it is painted,
  such as the colours of a highlighted source file or the matches of a search,
  where a node for each would be thousands of nodes. The first line and the
  first letter of a paragraph, which are known only once the lines are broken.
  CSS has the Custom Highlight API for the first and pseudo-elements for the
  others. The highlight the host draws for the selection is already of the
  first kind.
- **Editing rich text.** A text field's text is one run, as it is today.
- **Cutting text that does not fit**, with an ellipsis or after a number of
  lines.
- **Vertical text and ruby.**

## Alternatives considered

- **Ranges of style inside one text node.** A text node would hold a string
  and a list of ranges, each with a style. It is less to build, since a node
  keeps one box and the tree does not change. But a range is not a node. It
  has no rules, no state and no listeners, so a link would need a second way
  to find what the pointer is over and a second way to deliver a press, and
  the styles design would need a second place to put a text colour.
- **All of CSS's flow layout**, with blocks and inline content mixed in one
  container. A document written by hand in HTML needs it. It is where much of
  the difficulty of a browser's layout lies: boxes the document does not have,
  inline elements cut in two, margins that merge, floats. A tree made by code
  can be given the containers it needs, and an importer for an HTML-like
  format can add them as it builds.
- **An outer display as a property**, so that a rule could turn a span into a
  block. The parent's layout would then depend on a property of each child,
  and a container would hold both kinds again. A list of links that is set in
  a line in a wide window and stacked in a narrow one changes its own layout,
  from flow to a column, under a condition.
- **A paragraph as a kind of node.** What a paragraph needs from the host is
  what any flow container has. A paragraph, a heading and a list item differ
  in role and in style, which belong to the widgets that make them.
- **Collapsing white space as HTML does.** It serves a source format written
  by hand. An importer for such a format can do it before it writes a run.

## Build order

Each step works without the next.

1. **Flow containers with several runs.** Built. One text layout for the text
   children of a container, glyphs painted in each child's colour, and the
   selection found through the container. `examples/zenafx/richtext/` is
   paragraphs with bold, coloured and larger words. A node is a flow container
   when the `layout` in its `node-def` is the `flow` case, which also gives
   the alignment of its lines and their height. A hole can write a node's
   layout, in the case the node already has.

   What this step leaves out: a text child is not a node the pointer can be
   over, so it has no hovered style, no listener and no cursor of its own. It
   cannot be left out of selecting by itself. A child that is not text is not
   shown. `text-indent` is not built.

2. **Spans.** Nodes with a rectangle for each line: state, listeners, a
   cursor and a background. A link works after this step.
3. **Boxes in a line.** This needs the host to lay out a subtree while it
   builds a text layout, which the simple interface to the layout library in
   `packages/zenafx-render/src/layout.rs` does not allow. The lower-level
   interface that [A custom algorithm](./zenafx-styles.md#a-custom-algorithm)
   needs allows it.

Text properties that inherit are a separate piece of work, the first step of
[Changes to what exists](./zenafx-styles.md#changes-to-what-exists) in the
styles design. With them a span that says bold makes its runs bold. Until then
each run says its own style.

## Open questions

- **The position a listener on a span is given.** The corner of the smallest
  rectangle that holds a span's rectangles is one answer. A position in the
  flow container's box is another, and may be more use to a link that opens a
  popup beside the place pressed.
- **Where a box in a line sits.** On the baseline is the first answer. CSS
  also lets it line up by its own first line of text, its middle or its top.
- **A flex item that lines up with text beside it.** A label and a text field
  in a row want their first lines of text on one baseline, which is flex's
  baseline alignment and not built.
- **Faces a font does not have.** A bold or italic run looks no different
  where the font found for it has no such face, since the painter draws the
  face it is given. The layout library says when a face should be made bolder
  or slanted to stand in for one, and the painter does not yet do it.
