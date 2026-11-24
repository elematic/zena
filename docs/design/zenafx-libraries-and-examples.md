# ZenaFX libraries and examples

## Status

- **Status**: Proposed. Nothing in this document is built. It records which
  Rust libraries the ZenaFX host should take next, and which example programs
  to write to find what the design is missing.
- **Date**: 2026-11-22
- **Scope**: the host libraries behind [zenafx-ui.md](./zenafx-ui.md), and the
  examples under `examples/zenafx/`. The protocol and the authoring surface
  are designed in that document and in
  [zenafx-widget-authoring.md](./zenafx-widget-authoring.md).

## Overview

ZenaFX keeps layout, text and rasterization in Rust and reaches them through
WIT. [The rule](./zenafx-ui.md#the-rule) for that split is that Rust holds the
algorithms that have large, correct existing implementations. This document
applies that rule to the parts that are not built yet: input, focus, scrolling,
overlays, text editing, accessibility and images.

Two sources prompted it. Raph Levien's
[post of November 2026][next-100] on Rust GUI toolkits says which problems he
considers solved and which are open. The [Linebender][linebender] projects, and
the projects their authors keep in neighbouring organisations, cover most of
the unbuilt parts as separate crates.

The second half lists example programs. Each one is chosen because it needs
capabilities ZenaFX lacks, and each names a number a test can assert.

[next-100]: https://linebender.org/blog/next-100-guis/
[linebender]: https://linebender.org/

## Libraries in use

| Library                    | Version | Used for                         |
| -------------------------- | ------- | -------------------------------- |
| [`parley`][parley]         | 0.11    | text shaping, line breaking      |
| [`taffy`][taffy]           | 0.14    | flexbox solving                  |
| [`vello_cpu`][vello]       | 0.2     | rasterizing quads and glyphs     |
| [`winit`][winit]           | 0.30    | the window and OS input          |
| [`softbuffer`][softbuffer] | 0.4.8   | presenting the rasterized buffer |

`kurbo`, `peniko` and `color` arrive through `vello_cpu`, and `fontique`,
`harfrust` and `skrifa` through `parley`.

The post calls Parley "a good solution" to text layout and names Cosmic Text as
an alternative. Nothing in it argues for replacing a library ZenaFX uses.

[parley]: https://github.com/linebender/parley
[taffy]: https://github.com/DioxusLabs/taffy
[vello]: https://github.com/linebender/vello
[winit]: https://github.com/rust-windowing/winit
[softbuffer]: https://github.com/rust-windowing/softbuffer

## Libraries to take

The order is the order the examples below need them in.

### Parley's editor, for a text field

`parley` 0.11 already contains `PlainEditor` (`src/editing/editor.rs`). It
holds a buffer and a selection, and it provides the parts of a text field that
are hard to write: `set_compose` and `clear_compose` for an input method's
composition text, `cursor_geometry` and `selection_geometry` for what to paint,
`ime_cursor_area` for where the OS places its candidate window, and
`accessibility` behind the crate's `accesskit` feature.

A component never holds a shaped run, so it cannot compute a caret position.
The host can. The proposal is an editable text node: the host owns the buffer
and the selection in a `PlainEditor`, handles keys and composition itself, and
reports changes to the component as events. This is the shape of HTML's
`<input>`. The alternative is to expose run queries (offset to rectangle,
point to offset) and let a component write an editor. That needs a call per
key press and per pointer move, and it leaves input method support to every
widget author.

### AccessKit

[AccessKit][accesskit] is a schema for an accessibility tree and adapters to
each platform's API. `accesskit_winit` is the adapter for the window ZenaFX
already uses. The post calls it "solid infrastructure".

The post says an immediate-mode toolkit has to rebuild and compare an
accessibility tree every frame, because its widgets have no stable identity.
ZenaFX's host holds a retained tree whose nodes keep their identity, so the
host can send AccessKit the nodes that changed.

What it requires of the protocol is a role and a label on a node. `node-def` in
[`zenafx.wit`](../../packages/zenafx/wit/zenafx.wit) should gain them before
more widgets are written against it, because adding a required field later
touches every template. The host derives the accessibility tree from the node
tree it holds ([The node tree in the host](./zenafx-ui.md#the-node-tree-in-the-host)),
and a component supplies only the role and label.

Two limits are stated upstream. AccessKit's README says its adapters "don't
yet support rich text or hypertext". The post says performance drops while
accessibility is enabled.

[accesskit]: https://github.com/AccessKit/accesskit

### ui-events

[`ui-events`][ui-events] defines pointer and keyboard event types modelled on
the W3C specifications, and `ui-events-winit` converts winit's events to them.
`key-event` in `zenafx:host/surface` is `{code, down, text}`: it has no
modifiers, no distinction between a physical key and the character it
produces, and no repeat flag. The W3C model has all three and is what authors
coming from the web expect.

The proposal is to shape the WIT event records after `ui-events` and convert
with `ui-events-winit` in `ui/surface.rs`. Its API has not been read yet; that
is the first step.

[ui-events]: https://github.com/forest-rs/ui-events

### Understory

[Understory][understory] is a family of small `no_std` crates, each one
algorithm a UI host needs, with no widget toolkit attached. Its README
describes a split into a widget tree, a box tree and a presentation tree, which
is close to ZenaFX's component, scene and display list. The crates that match
an unbuilt part of ZenaFX:

| Crate                                     | What it does                                                            | ZenaFX part                              |
| ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `understory_index`, `understory_box_tree` | spatial index over boxes with transforms, clips and z-order; damage     | hit testing, visibility, repaint regions |
| `understory_responder`                    | capture, target, bubble sequence; pointer capture                       | event dispatch                           |
| `understory_event_state`                  | hover enter and leave, click recognition, drag tracking                 | pointer events, state styles             |
| `understory_focus`                        | ordered and directional focus navigation                                | focus and tab order                      |
| `understory_anchor`, `understory_overlay` | popover placement with fallbacks; overlay stack, dismissal, focus scope | menus, tooltips, dialogs                 |
| `understory_virtual_list`                 | visible range from scroll offset, fixed or variable row extents         | virtualized lists                        |
| `understory_transition`                   | duration, delay, easing; retargeting an interrupted transition          | host-driven style transitions            |
| `understory_style`, `understory_property` | selector matching, cascade order, inheritance                           | rules and inherited values               |
| `understory_box_decoration`               | per-corner radii, corner shapes, border regions as paths                | richer `box-style`                       |

The repository is young: 41 stars, last pushed 2026-11-10. So the proposal is
to evaluate one crate at a time, in the host, behind the WIT that exists.
`understory_virtual_list`, `understory_anchor`, `understory_focus` and
`understory_transition` come first, because each is an algorithm ZenaFX would
otherwise write and none of them constrains the scene tree.

`understory_responder` and `understory_event_state` overlap the dispatch that
pointer events already has. Compare them before adding pointer capture and
drag: if they fit, capture and drag come with them.

`understory_style` needs a comparison with
[Selectors as data](./zenafx-widget-authoring.md#selectors-as-data) before
rules are built. The post describes an experiment
([xilem#75](https://github.com/linebender/xilem/pull/75)) in which selectors
compile to a state machine that evaluates incrementally, and says it gives up
sibling selectors to do so. ZenaFX's predicate algebra has `nth` and `under`.
Whether those two prevent incremental evaluation is unknown, and that pull
request has not been read.

[understory]: https://github.com/forest-rs/understory

### Icons: an SVG renderer

No part of the design draws an icon. [`vello_svg`][vello-svg] converts an SVG
document to Vello drawing commands, and its README sends anyone who needs a
correct renderer to [`resvg`][resvg]. Icons are simple documents, so either
works. The choice depends on the renderer question below, since `vello_svg`
targets the GPU renderer's scene type and
[`anyrender_svg`][anyrender] targets any backend.

[vello-svg]: https://github.com/linebender/vello_svg
[resvg]: https://github.com/linebender/resvg
[anyrender]: https://github.com/DioxusLabs/anyrender

### A GPU renderer, later

Vello now has three renderers. `vello_cpu` is the one ZenaFX uses, and Vello's
README calls it "the most mature choice". `vello_gpu`, formerly
`vello_hybrid`, prepares paths on the CPU and rasterizes on the GPU through
`wgpu` or WebGL2, and shares its core with `vello_cpu`. The compute-shader
renderer "remains an experimental implementation".

[AnyRender][anyrender] is a trait over all of them, with backends for
`vello_cpu`, `vello_gpu`, Skia and `tiny-skia`, and a `softbuffer` window
renderer. Writing `ui/paint.rs` against it would make the move to `vello_gpu`
a change of backend.

Neither is needed until a scene is too slow on the CPU, and the examples below
are how that gets measured.

### Compositor layers

The post calls the system compositor "still unsolved". Two cases need it. A
video should play in a layer the OS composites, which on a low-end device may
be the only way to reach a smooth frame rate. A scrolling region that is its
own layer moves without being rasterized again.

[`subduction`][subduction] is the library the post names. It has backends for
Android, Apple platforms, Wayland, X11, Windows, the web and `wgpu`. Its
README is empty and the post says it is "not yet commonly integrated", so
ZenaFX should not depend on it yet.

What to do now is keep the design compatible with layers. A scroll container
and a [Tier 3](./zenafx-ui.md#tiers-beyond-boxes-and-text) GPU node should each
be a node the host could give its own layer, with nothing in the protocol that
assumes one buffer per window. The post warns that layers cost memory and that
allocating one is a system call, so a layer per node would be slower.

[subduction]: https://github.com/forest-rs/subduction

### Smaller ones

- [`kompari`](https://github.com/linebender/kompari) compares images and
  reports differences. `ui/paint.rs` is tested by reading pixels today;
  snapshot tests of whole examples would use this.
- [`velato`](https://github.com/linebender/velato) renders Lottie animations
  and [`interpoli`](https://github.com/linebender/interpoli) animates values.
  Neither is needed by anything planned.

## Libraries not taken

**Masonry**, the widget layer under Xilem, has a text field, scrolling and
AccessKit support. Its widgets are Rust traits in the host's process. A ZenaFX
widget is a template in a guest, with ownership the host enforces per widget,
so Masonry's widget tree could not be the scene. Its source is still the best
reference for how Parley's editor and AccessKit fit together.

**Blitz** is a modular HTML and CSS engine built on Taffy, Parley and Vello.
The post sees it as the base for toolkits that mix web content with native
widgets. For ZenaFX it could later fill one node with a document. It is not a
base for the scene, for the reasons [Prior art](./zenafx-ui.md#prior-art)
gives against the DOM's global tables and document-wide cascade.

**Cosmic Text** is an alternative to Parley. Parley's editor and its AccessKit
feature are reasons to stay.

## Changes to the plan

These come from the post and apply whichever libraries are taken.

1. **Batch writes.** The post recommends "a lighter weight tree representation
   with a bulk mutation interface" in place of the DOM. ZenaFX makes one
   `render` call per node. `apply`, which sends a frame's writes in one call,
   is step 2 of
   [What to prototype](./zenafx-widget-authoring.md#what-to-prototype-in-what-order)
   and should stay early.
2. **Roles and labels on nodes**, as under AccessKit above.
3. **Sparse style declarations.** Grid, margins and size limits would take
   `flex` well past the sixteen values the canonical ABI passes without
   spilling to memory. A list of the declarations that differ from the default
   is also what a rule's `then` carries, so the two should be one type.
4. **Virtualized lists need their own design.** The post says the web has no
   good representation of one, and that a specification has to define how the
   list reaches the data model. In ZenaFX the host knows which rows are
   visible and the component holds the rows, so the host has to ask for them
   outside the frame.
5. **Mobile is out of scope for now.** The post recommends platform UI with
   shared logic on phones, because gestures, scroll physics and input methods
   that match the platform are "not yet fully solved".

## Examples

Each example is a component under `examples/zenafx/` with a headless test in
`packages/zenafx/tests/`, like the three that exist. The list is in the order
to build them. An example's capabilities are the ones it adds to those before
it.

### Split pane

Two panels and a divider the pointer drags.

- **Adds:** pointer capture, so the drag continues when the pointer leaves the
  divider; a cursor style; minimum and maximum sizes.
- **Finds out:** what a layout change per pointer move costs when the
  component is in the loop. Each move is one event in and one layout hole out.
- **Asserts:** one component entry and one hole write per move; the solve
  after it touches only the two panels.

If that cost is visible, the alternative is a host-driven drag: the component
declares that a node's size follows the pointer between two limits, and hears
only the result.

### Disclosure

A summary row that shows and hides the content under it, as HTML's
`<details>` does.

- **Adds:** [detached nodes and `set-slot`](./zenafx-ui.md#detached-nodes-and-slot-assignment),
  so that showing or parking a branch is one slot update (via the guest `cache`
  directive); hover, pressed and focused styles resolved by the host; focus,
  and activation by Enter and Space; the expanded state as an accessibility
  property; a transition on height.
- **Finds out:** whether a transition to a height the layout computes can run
  in the host with no call per frame.
- **Asserts:** a toggle is one entry and one write; hover enters the component
  zero times; the animation's frames enter it zero times.

### Scroll view

A fixed-height box over content taller than it, then one inside another.

- **Adds:** clipping in the scene walk (`PushClip` exists and nothing emits
  it); a scroll offset the host holds; the wheel event, which
  `ui/surface.rs` does not read from winit; scroll bars; hit testing through
  an offset.
- **Finds out:** which container a wheel event scrolls when two are nested,
  and what a component may learn about its scroll position.
- **Asserts:** scrolling enters the component zero times and solves layout
  zero times.

### Article

A long document: headings, paragraphs with bold, italic, code and links, and
a quotation. At least 100 KB of text, inside the scroll view.

- **Adds:** more than one style within a run, which Parley supports and
  `text-content` does not; line height, alignment and decoration; inherited
  text style, so a paragraph does not repeat its font; a link as a hit target
  inside a run; text selection and copy; registering a font the component
  ships.
- **Finds out:** the answer to
  [open question 10](./zenafx-ui.md#open-questions), whether a wrapped
  paragraph is shaped once or once per frame; and whether `vello_cpu` holds a
  frame rate on a full window of text at a high pixel density.
- **Asserts:** a resize enters the component zero times; time to re-break all
  runs at a new width; time to paint one screen.

### Gallery

A grid of images that changes its column count with the window's width.

- **Adds:** grid tracks and placement from Taffy, through sparse declarations;
  aspect ratio; the [assets interface](./zenafx-navigation-and-assets.md#assets)
  and the image content case; a size before the image has loaded; how an image
  fits its box; icons from SVG.
- **Finds out:** whether the column count can be declared, or the component
  has to hear about each resize.
- **Asserts:** an image named by two components is decoded once; a resize
  enters the component zero times.

### Form

Labelled text fields, a checkbox and a submit button.

- **Adds:** the editable text node over `PlainEditor`; input method
  composition; tab order; AccessKit, checked with a screen reader on one
  platform.
- **Finds out:** which events an editable node reports, and whether a
  component can restrict what is typed without a call per key.
- **Asserts:** typing a character enters the component at most once.

### Menu

A button that opens a popover with items, and a submenu.

- **Adds:** a layer above the tree; placement against another node's box with
  a fallback when it would leave the window; dismissal by a press outside,
  which is the `intercept` phase's first user; focus held inside the menu.
- **Finds out:** who owns a node in the top layer, given that it is drawn
  outside its owner's box.

### Table of 100,000 rows

- **Adds:** the virtualized list design from item 4 above.
- **Finds out:** what the host shows for a row it has asked for and not yet
  received.
- **Asserts:** nodes alive are proportional to rows visible; scrolling within
  rows already delivered enters the component zero times.

### Video

A playing video inside a scrolling page, with text over it.

- **Adds:** the Tier 3 node, a texture the component fills through
  `wasi:webgpu` at its own rate; then a compositor layer for it.
- **Finds out:** what decodes the video. No library is chosen. The first
  version can show the `zfx` triangle fixture animating in a node, which
  tests the node and its frame rate without a decoder.
- **Asserts:** a video frame does not rasterize the page again.

## Open questions

1. **Whether Understory's event crates replace ZenaFX's dispatch or sit beside
   it.** Dispatch has to list the listeners an input reaches before calling a
   component. Whether `understory_responder` can produce that list has not
   been checked.
2. **Whether an editable node is one node kind or several.** A single-line
   field, a multi-line field and a rich-text editor share the buffer and
   differ in what they report.
3. **Whether the accessibility tree crosses a boundary between components.**
   A parent cannot read its child's nodes. A screen reader has to read both.
   The host builds the tree, so it can, but a component then describes itself
   to a reader its parent did not choose.

## Related

- [zenafx-ui.md](./zenafx-ui.md) — the architecture, the protocol and the
  milestones
- [zenafx-widget-authoring.md](./zenafx-widget-authoring.md) — the authoring
  surface, events from an author's side, and selectors
- [zenafx-navigation-and-assets.md](./zenafx-navigation-and-assets.md) — the
  assets interface the gallery needs
