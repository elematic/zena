## zenafx

### Added

- Any text in a window can be selected, with no call to the component that drew it. A press and a drag select from one text to another, a second press selects a word and a third a whole text node, and Control or Meta with `a` selects everything. A node says when its text is left out, in `node-def.unselectable`.
- Control or Meta with `c` copies what is selected to the platform's clipboard, and with `x` copies it for the text field that hears the key to delete. Control or Meta with `v` pastes into a text field: the key is followed by one named `Paste` whose `text` is the text on the clipboard. `examples/zenafx/selection/` is a page of text to select and copy and a field to paste into.

### Changed

- **Breaking:** `node-def` has an `unselectable` field, so a component built against the earlier interface does not load.
