## zenafx

### Added

- Pointer capture. A listener captures the pointer by calling `capture` on the reply to a `down`, or to a `move` while the primary button is down. Until the button comes up, the node it is on is the target of every `move` and `up`, wherever the pointer goes. A listener with the new `captured` scope hears only while the pointer is captured. `examples/zenafx/split/` is two panels and a divider built on both.
- A node names the cursor to show while the pointer is over it, in `node-def.cursor`, as one of CSS's 34 `cursor` keywords. The platform draws it. `examples/zenafx/cursors/` shows each one.
