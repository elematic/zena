## zenafx

### Added

- One node in a window has the focus. A node says whether it can have it, in `node-def.focusable`, and a template says how a node looks while it does with the new `focused` state. `Tab` and `Shift` with `Tab` move the focus through those nodes in the order they come in the tree, and a press gives it to the nearest of them at or above the node pressed.
- A component hears the keyboard with `listen-keys`, which returns a stream of keys as `listen-pointer` returns a stream of pointer events. A key is offered along the path from the root to the node with the focus, named as the W3C's keyboard events name it (`key`, `code`, the modifiers held and whether it is repeating). A listener calls the new `prevent-default` on a key's reply to keep the host from acting on the key, which for `Tab` is moving the focus. `examples/zenafx/disclosure/` is two summaries that open from the keyboard.

### Changed

- **Breaking:** `node-def` has a `focusable` field, so a component built against the earlier interface does not load.
