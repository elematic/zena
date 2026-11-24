## zenafx

### Added

- Text in more than one style. A node with `text-flow` set is a flow container: the host joins the strings of its text children, each in its own style, and lays them out as one piece of text, so lines break across them and a word made of two children is one word to select. `text-flow` gives the alignment of the lines and their height. `examples/zenafx/richtext/` is a card of such paragraphs.

### Changed

- **Breaking:** `node-def` has a `text-flow` field, so a component built against the earlier interface does not load.
