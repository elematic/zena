## zenafx

### Added

- A component's widgets hear the pointer. `node.listen-pointer` in `zenafx:host/scene` adds a listener for `down`, `up`, `move`, `enter` or `leave` at a node and returns the stream its events arrive on. A `down`, `up` or `move` carries a `reply`. A listener drops it to pass the event on, after calling `stop-propagation` on it to keep later listeners from being offered the event. `examples/zenafx/button/` is a button built on it.

### Changed

- A window is redrawn when its component writes the tree. It was redrawn without pause for as long as the component had work outstanding, such as a timer.
