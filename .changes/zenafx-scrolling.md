## zenafx

### Added

- A box's layout says what becomes of content that does not fit, with `overflow-x` and `overflow-y`. `clip`, the default, is for a box whose content is expected to fit. `hidden` is for a box meant to hold more than fits, which may then be laid out smaller than its content. `scroll` is `hidden`, and the wheel moves the content. The host keeps how far a box has scrolled, so scrolling wakes no component. `examples/zenafx/scroll/` is a list built on it.

### Changed

- **Breaking:** `flex` in `zenafx:ui/style` has two more fields, `overflow-x` and `overflow-y`.
- **Breaking:** content that does not fit in a box is cut off at the box, where it was drawn outside it. There is no `visible` overflow.
