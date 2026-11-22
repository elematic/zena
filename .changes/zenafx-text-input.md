## zenafx

### Added

- A component can build a text field. A text node says whether a person edits it, in `node-def.editable`. The host keeps one selection for the window, and in such a node the pointer moves it with no call to the component: a press puts the caret where it landed, a drag selects, Shift with a press extends, a second press selects a word and a third the whole field. The host draws the caret and a highlight while the field has the keyboard focus, and scrolls the nearest `hidden` or `scroll` box to keep the caret in sight.
- `node.selection` says where the selection is in a text node and `node.select` puts it there, which is how a field edits when it hears a key. A key event carries `text`, the text the key press types. `examples/zenafx/input/` is two fields written in Zena.
- A text node's padding is inside its box: its text starts that far in.

### Changed

- **Breaking:** `node-def` has an `editable` field and `key-event` a `text` field, so a component built against the earlier interface does not load.
- A box that says `hidden` keeps a scroll position, which the host sets and the wheel does not. It was always at its start before.
