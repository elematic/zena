## zenafx

### Added

- Text in more than one style. A node whose `layout` is `flow` is a flow container: the host joins the strings of its text children, each in its own style, and lays them out as one piece of text, so lines break across them and a word made of two children is one word to select. `flow` gives the alignment of the lines and their height. `examples/zenafx/richtext/` is a card of such paragraphs.
- A hole can write a node's `box`, and its `layout` in the case the node already has.

### Changed

- **Breaking:** a node says how it lays out its children in `layout`, a variant of `flex` and `flow`, and its size, padding and overflow are in a new `box` record. `flex` keeps `axis`, `justify-content`, `align-items` and `gap`. `node-def` has a `box` field and a `layout` field, and a hole that wrote a node's size through `layout` writes `box`. A component built against the earlier interface does not load.
