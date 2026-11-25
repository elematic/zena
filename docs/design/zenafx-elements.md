# ZenaFX Elements: A Standard Library of Widgets

## Status

Proposal. None of it is built. There is no library of widgets today: each
example under `examples/zenafx/` defines its own over
`examples/zenafx/framework.zena`.

It asks for four decisions:

1. The host has capabilities and no widgets. It does not know what a button
   or a heading is. See [What the host provides](#what-the-host-provides).
2. What a node means to assistive technology is a role, a name and some
   state on the node, and not the type of the widget that made it. See
   [Roles](#roles).
3. A standard set of widgets, called elements here, is a Zena package beside
   the host's interface, compiled into each component that uses it. See
   [The package](#the-package).
4. The set is the list under [The elements](#the-elements).

[The word for a widget](#the-word-for-a-widget) asks whether "widget" should
give way to "element" everywhere.

## Overview

A ZenaFX window has two programs in it. The **host** is the Rust process: it
holds the tree of nodes, lays it out, paints it and reads input. A
**component** is the application, a WebAssembly component that describes the
tree through the interface in `packages/zenafx/wit/zenafx.wit`. A **widget** is
a class in the component with a template for its nodes, as
[zenafx-widget-authoring.md](./zenafx-widget-authoring.md) describes.

Three things call for a standard set of widgets.

- **Text and controls that agree.** Two widgets written by different people
  should set a heading in the same size and move through a list of tabs with
  the same keys. A rule cannot reach into another widget
  ([Where rules attach](./zenafx-styles.md#where-rules-attach)), so the two
  agree by being built from the same parts.
- **A document format.** A format in the manner of HTML needs a fixed list of
  things a document can name: a heading, a paragraph, a link, an image.
- **Accessibility without asking for it.** A button that says it is a button,
  can be reached by `Tab` and is pressed by a space should be what an author
  gets by writing `Button`.

The proposal is three layers. The host gives every node the same abilities.
The elements are a small library of widgets over those abilities. An
application, or another library of widgets, is built from the elements and
from nodes of its own.

## Terms

- **Node**: one item in the tree the host holds.
- **Widget**: a class in a component, with a template that describes its
  nodes.
- **Element**: a widget in the standard library this document proposes.
- **Capability**: something the host does for any node that asks: scroll it,
  give it the focus, keep a caret in it.
- **Role**: what a node is to assistive technology, such as a button or a
  heading.

## What the host provides

The host's part is capabilities. Each is a property or a field of a node, or
a call on one, and any widget can use it.

| Capability                                    | State                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| Boxes laid out by flex                        | built                                                                     |
| Text in one style                             | built                                                                     |
| Text in several styles, links                 | proposed in [zenafx-text-flow.md](./zenafx-text-flow.md)                  |
| State styles for hovered, pressed and focused | built                                                                     |
| Rules, properties that inherit, themes        | proposed in [zenafx-styles.md](./zenafx-styles.md)                        |
| Pointer and key listeners, pointer capture    | built                                                                     |
| The focus, moved by `Tab` and by a press      | built                                                                     |
| Scrolling                                     | built                                                                     |
| A cursor for a node                           | built                                                                     |
| A caret and a selection in a text field       | built                                                                     |
| Selecting any text, copying and pasting       | built                                                                     |
| Roles for assistive technology                | proposed here, under [Roles](#roles)                                      |
| One event for pressing a control              | proposed here, under [Activation](#activation)                            |
| Images                                        | not designed                                                              |
| Menus, dialogs and tooltips above other nodes | sketched in [Drawing outside a box](./zenafx-ui.md#drawing-outside-a-box) |

The host has no widgets because a widget in the host cannot be changed
without a new host, and because each choice a widget makes would need an
option in the interface: what `Enter` does in a text field, which characters
it accepts, how a value is shown. `examples/zenafx/input/` is a text field
whose editing is in Zena for that reason. The host does the parts that need
what only it has: where the glyphs are, where the pointer is, what the
platform's clipboard holds.

### Activation

A button is pressed by the pointer, by `Enter` and by a space. Today a widget
listens for all three itself, as `examples/zenafx/disclosure/` does. Every
control needs this, and platforms differ in the details, such as whether a
space acts when the key goes down or when it comes up.

The proposal is one event, `activate`, that the host sends to a node that can
have the focus when it is pressed in any of those ways. A widget listens for
it and for nothing else. The same event is what assistive technology sends
when a person asks it to press a control.

## Roles

HTML gives an element its meaning by its type: a `<button>` is a button. An
application that built a button from a `<div>` then had no way to say so, and
ARIA was added to say it with an attribute. The meaning and the type had been
two things all along.

Here the meaning is on the node from the start.

```wit
enum role {
  /// Nothing to assistive technology beyond what is in it.
  none,
  heading, paragraph, list, list-item, quote, code,
  link, image,
  button, checkbox, radio, text-input, slider, select,
  tab-list, tab, tab-panel, dialog,
}

record node-def {
  // ... its layout, its style and the rest
  role: role,
  /// What assistive technology calls the node, when its own text does not
  /// say: "Close" on a button that shows a cross.
  name: option<string>,
}
```

The list is a sketch. A heading also needs its level, and a slider its value
and range.

A node's state reaches assistive technology through facts. A checkbox is
checked, a row is selected and a control is disabled by a fact the component
sets, as [Facts](./zenafx-styles.md#facts) describes. For the states assistive
technology knows, the host gives the keys: `checked`, `selected`, `expanded`,
`disabled`. A component that sets `checked` on a node changes its style, by
whatever rules test the fact, and what a screen reader says of it, in one
write.

The host builds the tree that assistive technology reads from the tree of
nodes it holds, and hands it to the platform through AccessKit, as
[AccessKit](./zenafx-libraries-and-examples.md#accesskit) describes. A
component supplies the role, the name and the facts. It is told nothing about
who is reading.

An element sets its own role, so an author who writes `Button` has said
`button`. A widget that is not built from elements sets a role on its node
itself.

## The elements

An element is in the set for one of two reasons. A document format needs to
name it. Or nearly every application needs it and it should behave the same
in all of them.

**Text.** Each is a flow container, in the sense of
[zenafx-text-flow.md](./zenafx-text-flow.md), with a role and a style.

| Element               | Role                |
| --------------------- | ------------------- |
| `Heading`, of a level | `heading`           |
| `Paragraph`           | `paragraph`         |
| `Quote`               | `quote`             |
| `List`, `ListItem`    | `list`, `list-item` |
| `CodeBlock`           | `code`              |

**In a line.** Each is a span or a box in a line.

| Element              | Role    |
| -------------------- | ------- |
| `Emphasis`, `Strong` | `none`  |
| `Code`               | `code`  |
| `Link`               | `link`  |
| `Image`              | `image` |

**Controls.**

| Element     | Role         | A prototype today         |
| ----------- | ------------ | ------------------------- |
| `Button`    | `button`     | `examples/zenafx/button/` |
| `Checkbox`  | `checkbox`   |                           |
| `Radio`     | `radio`      |                           |
| `TextInput` | `text-input` | `examples/zenafx/input/`  |
| `Select`    | `select`     |                           |
| `Slider`    | `slider`     |                           |

**Containers.**

| Element      | Role                           | A prototype today             |
| ------------ | ------------------------------ | ----------------------------- |
| `ScrollView` | `none`                         | `examples/zenafx/scroll/`     |
| `Disclosure` | `button` on its summary        | `examples/zenafx/disclosure/` |
| `Tabs`       | `tab-list`, `tab`, `tab-panel` |                               |
| `Dialog`     | `dialog`                       |                               |

A table of data, a date picker and an editor for rich text are not in the
set. An application needs one of them only sometimes, and each can be a
library built from these.

### How elements are styled

An element comes with rules for its own nodes: a heading's size, a button's
fill, a ring round what has the focus.

The values in those rules are properties of a theme: a scale of text sizes, a
unit of spacing, a few colours. They inherit, as
[Inheritance](./zenafx-styles.md#inheritance) describes, and each element
declares the theme's own value as a default. An application that sets them at
its root changes every element in the window, in its own widgets and in
anyone else's.

That is how text is the same across widgets that know nothing of each other.
Both use `Heading`. `Heading` reads its size from the theme. The theme is set
once, above both.

## The package

The elements are a Zena package, kept in this repository beside
`packages/zenafx`. The classes every widget is built on, which are in
`examples/zenafx/framework.zena` today, become a package too, and the
elements depend on it.

The package is compiled into each component that uses it. An application can
take a new version of the elements with the host it already has, and a host
can change without the elements changing.

**Other languages.** A component written in Rust cannot use a Zena package.
It needs the elements written again in Rust. What keeps the two alike is how
much the host does: the focus, activation, text input, selection, scrolling
and roles are the same for both. A theme's properties and a stylesheet are
data, and both can use the same ones.

**A document format.** An importer for a format in the manner of HTML makes an
element for each thing the document names, and adds the flow containers that
[What a flow container holds](./zenafx-text-flow.md#what-a-flow-container-holds)
leaves to it. The list of elements is the list of things such a document can
say.

## The word for a widget

"Widget" suits a button. It reads oddly for a paragraph and for an
emphasised word, which this document also makes widgets. "Component" is taken
by WebAssembly. A document format will call the things it names elements
whatever the code calls them.

One answer is to say "element" for all of them: the class an author writes,
the ones in the standard library, and what a document names. "Node" stays the
word for an item in the host's tree, as "node" and "element" are two words in
the DOM. It would be a change of names across the documents and the examples,
and nothing else. This document keeps "widget" until that is decided.

## Alternatives considered

- **Widgets in the host**, as a browser implements `<input>` and `<select>`.
  Every language gets them and they are the same everywhere. A change to one
  needs a new host. Each choice a widget makes becomes an option in the
  interface. And the host would hold a second kind of thing beside nodes.
- **Meaning from the type of a widget.** A role would not be needed if the
  host knew which widget made a node. That is HTML's arrangement before ARIA,
  and it fails in the same place: a widget that is not one of the standard
  ones has no way to say what it is.
- **The elements as one component that others share.** One copy would serve
  every component in a window, in any language. A widget across a boundary
  between components needs one component to place nodes inside another's
  tree, which [Interior and content](./zenafx-ui.md#interior-and-content)
  designs and nothing builds, and each call to an element would cross that
  boundary.
- **No standard set.** Each library of widgets would bring its own heading
  and its own button. Text would differ between them, and a document format
  would have nothing to map to.

## Build order

1. Roles and names on nodes, and the tree for assistive technology in the
   host. [AccessKit](./zenafx-libraries-and-examples.md#accesskit) gives the
   reason to do this before more widgets are written: a field added to
   `node-def` later touches every template.
2. The classes every widget is built on, moved from the examples into a
   package.
3. `Button` and `TextInput`, from the examples, with `activate`.
4. The text elements and the elements in a line, as
   [Build order](./zenafx-text-flow.md#build-order) in the text flow design
   allows.
5. A theme, once [zenafx-styles.md](./zenafx-styles.md) has properties that
   inherit.
6. The remaining controls and containers.

## Open questions

- **The word**, as under [The word for a widget](#the-word-for-a-widget).
- **Which states the host names.** `checked`, `selected`, `expanded` and
  `disabled` are a start. ARIA has many more.
- **A reader across components.** A parent cannot read its child's nodes, and
  a screen reader has to read both.
  [zenafx-libraries-and-examples.md](./zenafx-libraries-and-examples.md)
  already asks this.
- **What `activate` does on a link, a checkbox and a tab.** Each could be left
  to its element, or the host could do more for a role it knows.
- **Names for the packages.**
