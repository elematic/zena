# zenafx (`zfx`)

An experimental runtime for running graphical WebAssembly components with
Wasmtime, `wasi-gfx`, and `wasi:webgpu`.

```bash
zfx app.wasm
zfx --invoke start app.wasm
zfx -g app.wasm             # turn off Cranelift inlining for readable backtraces
zfx --ui                    # the ZenaFX host primitives, no component
```

## Overview

`zenafx` (`zfx`) runs WebAssembly components that target graphical interfaces.
It provides host-side support for:

- **`wasi:webgpu`**: GPU compute, shader modules, pipelines, command buffers,
  and render passes (backed by `wasi-webgpu-wasmtime` and `wgpu-core`).
- **`wasi-gfx:surface`**: OS window creation, sizing, and event handling
  (`on-frame`, `on-pointer-down`, `on-resize`, etc., backed by
  `surface-wasmtime` and `winit`).
- **`surface-webgpu`**: Presentation context connecting a `Surface` to a WebGPU
  `Device` to present rendered textures.
- **`frame-buffer-wasmtime`**: 2D software framebuffer presentation.
- **`wasi:cli`**: WASI 0.3 CLI and stdio, the same surface the zena host links.

Design document:
[docs/design/graphical-runtime.md](../../docs/design/graphical-runtime.md).

## The ZenaFX UI stack

A second, independent layer is being built alongside the `wasi-gfx` path: a
retained-mode UI whose applications are trees of components linked at run
time. Its interfaces are declared in [`wit/zenafx.wit`](wit/zenafx.wit) and
designed in [docs/design/zenafx-ui.md](../../docs/design/zenafx-ui.md).

`src/ui/` holds the Rust side — the four `zenafx:host` primitives:

| Module       | Serves                | Built on               |
| ------------ | --------------------- | ---------------------- |
| `text.rs`    | `zenafx:host/text`    | `parley`               |
| `layout.rs`  | `zenafx:host/layout`  | `taffy`                |
| `paint.rs`   | the host alone        | `vello_cpu`            |
| `surface.rs` | `zenafx:host/surface` | `winit` + `softbuffer` |

`paint.rs` serves no interface. Rasterizing and presenting belong to the host
alone: a component changes what is on screen by changing its nodes, and the
host walks the tree it already holds into a display list. Nothing a component
can call takes a display list or pixels.

Text measurement happens _inside_ the layout solve, because how tall a run is
depends on the width flexbox gives it. `layout::solve` hands taffy a closure
over the text engine, so a container that is too narrow makes its label wrap
and the solve sees the new height.

This stack does not use `wasi-gfx:surface`, which wakes every surface 60 times
a second whether or not anything changed. `ui::surface` runs its own `winit`
loop under `ControlFlow::Wait`: a frame happens when a redraw was requested,
and never otherwise.

`src/loader/` loads an application component and runs it in that window. It
compiles the component, builds a `Linker` for it, defines the `zenafx:host`
interfaces the component imports, instantiates it and asks it once what it
draws. A fresh `Linker` per instance is the shape the design needs: which
imports an instance gets is decided per instance, so that a component can be
given some interfaces and not others, and so that a binding to another
component can go through a host trampoline.

```bash
npm run build:widgets -w @zena-lang/zenafx    # compiles it to out/widgets.wasm
npm run zfx -w @zena-lang/zenafx -- --app out/widgets.wasm
```

There is one build script per example, so `build:widgets` compiles only the
widgets and `build:counter` only the counter. `build:examples` does both, and is
what `npm test` depends on.

`zfx --ui` shows the same scene assembled in Rust by `ui::demo`, with no Wasm
in the picture:

```bash
npm run zfx -w @zena-lang/zenafx -- --ui       # builds, then opens the window
npm run zfx -w @zena-lang/zenafx -- --ui 'Hello from ZenaFX'
cargo run -p zenafx -- --ui                    # unoptimised, no Wireit
```

A window opens showing the message in a rounded card, centred by a flexbox
layout. Resizing it re-solves and repaints; the layout is recomputed from the
new size rather than scaled. Close the window to exit. Nothing is drawn
between frames — the loop waits, and a frame happens only when a redraw was
requested.

### Widgets inside one component

[`examples/zenafx/widgets/`](../../examples/zenafx/widgets/) is one
component holding three widget classes, composed in the language: a page of
three cards, each with its own title, accent colour and content, and one of
them holding two labels in its slot.

Instances are what carry that variation. `Card` keeps its title and accent
as instance fields and reads them in `build`, so three cards in one tree
draw three titles; the shared constants — the card's fill, its border, its
corner radius — stay module-level, because every card draws them the same
way. `tests/app.rs` measures the three title runs and asserts they differ,
which is the assertion a module-level title fails.

A widget there is an ordinary Zena object with one method, `build(): Rendering`,
which names the template to show, one value per hole in it, and the widgets for
each of its slots. The template is module-level, built once per widget class, and
a box tree is written with nested calls and flattened into the flat node list the
host takes. Options are a record with every field optional, so a box names what it
cares about and nothing else.

```zena
let cardTemplate = template(
  box({style: cardStyle, align: Align.Stretch, gap: 10.0, padding: cardPadding}, [
    text('', titleStyle(surface)),
    box({style: wellStyle, padding: wellPadding}, [slot()]),
  ]),
  [new Binding(1 as u32, BindingTarget.Content),
   new Binding(1 as u32, BindingTarget.Style)],
);
```

The title is a hole rather than a value, which is what lets three cards share one
template. The well is a box _around_ the slot because a slot is not a box: it
contributes no geometry, so its content lays out in whatever contains the slot —
the same reason a `<slot>` gets wrapped in a styled `<div>`.

A box says how it looks as well as how it lays out, so the host paints the same
tree it solved — no widget builds a display list and none handles a shaped run.

The component exports `zenafx:host/app`, which is one function:

```wit
main: async func();
```

It builds its root widget, renders it, and calls `ready`. `async func` is about
the lift rather than the body: it is what lets the host re-enter a component that
started work, so an ordinary synchronous `main` can arm a timer and return — see
`examples/zenafx/counter/`. A component that starts nothing never needs
re-entering.

Building the tree goes through `zenafx:host/scene`, whose whole write surface is
one method:

```wit
resource node {
  render: func(template: template-ref, holes: list<hole>);
  content: func(slot: u32, count: u32) -> list<own<node>>;
}
```

`render` creates, patches or replaces, and the host decides which by comparing
template identity against what the node already shows — the guest never says
which it meant. Node 0 of a template _is_ the node rendered into, so a widget is
one box; the rest is its interior. `content` is how a parent gives each of its
children a node, and the only place a child is added or removed. A template's
definition travels with its first use and afterwards only its id does.

The host owns the tree from there. A resize is solved and painted host-side with
**no call into the component at all** — `tests/app.rs` resizes four times and
asserts the entry count stays at one, and `tests/counter.rs` makes the same
assertion for a component that is still working: re-entering the entry's task
through its callback is not another call to `main`.

### Updating what is on screen

[`examples/zenafx/counter/`](../../examples/zenafx/counter/) is the other half:
two counters in a row, one template used twice, each advancing on its own timer.

The rate belongs to the widget. A counter arms a `sleep` from `zena:time` over
`wasi:clocks` — 500ms for one and 1500ms for the other — and ZenaFX declares no
timer interface of its own; the display's refresh rate has nothing to do with
either. When a period comes due the counter advances its count and calls
`refresh`, and because the template has not changed, the only thing that crosses
the boundary is the digit string.

```bash
npm run build:counter -w @zena-lang/zenafx    # compiles it to out/counter.wasm
npm run zfx -w @zena-lang/zenafx -- --app out/counter.wasm
```

The host then patches that one node, keeping its id and the run it shaped for it.
`tests/counter.rs` is the evidence: the run id is the same after ten periods, so
nothing was rebuilt, while the run measures wider once the count reaches two
digits, so it really was reshaped. Four of those tests wait out real sleeps and
are `#[ignore]`d until a clock can be substituted for `wasi:clocks`; run them with
`cargo test -p zenafx --test counter -- --ignored`.

### Hearing the pointer

[`examples/zenafx/button/`](../../examples/zenafx/button/) is a count and a
button that adds one to it. The button changes colour while the pointer is over
it and while it is pressed, and a press anywhere else on the page sets the
count back to zero.

```bash
./target/release/zena build ./packages/zenafx:build:button   # compiles it to out/button.wasm
./target/release/zfx --app packages/zenafx/out/button.wasm
```

A handler is a function, and a function cannot cross to the host. So a widget
describes each one: which node of its template hears, and which kind of event.

```zena
return shows(buttonTemplate, [new BindingValueContent(this.#label)]).hearing([
  on(PointerKind.Down, () => {
    this.#pressed();
  })
]);
```

Each becomes one call when the template is built. The call adds a listener in
the host and returns a stream:

```wit
resource node {
  listen-pointer: func(target: u32, kind: pointer-kind, in-scope: scope, at: phase)
      -> stream<delivery>;
}

record delivery { event: pointer-event, reply: option<reply> }
resource reply { stop-propagation: func(); }
```

The host writes each event the listener hears to its stream. The framework
reads the stream in a loop and calls the handler with each event. Dropping the
stream removes the listener. When the node goes away, the host removes the
listener and ends the stream, and the framework's loop finishes. A widget has
no cleanup of its own to do for its listeners.

The host remembers the layout: the rectangle each node was given in the last
frame. From those rectangles it finds the node under the pointer, and from the
listeners it holds it finds which of them an input reaches, before it writes
anything to the component. An input that reaches none does not wake the
component.
`tests/button.rs` moves the pointer across the page, onto the button and about
inside it, and asserts that no event is written until the button is pressed.

A `down`, `up` or `move` is offered along the path between the root and the node
under the pointer, to one listener at a time. It comes with a `reply`. The next
listener is offered the event when this one drops the reply, and no listener is
if this one called `stop-propagation` first. A press on the button reaches the
button, which stops its propagation, so the page's listener does not set the
count back to zero.

`enter` and `leave` tell a listener that its scope gained or lost the pointer,
so a button hears nothing when the pointer moves from its padding onto its
label. They carry no reply. A position is measured from the listening node's
own box.

The handlers run on the component's thread, after the window's thread has moved
on. When one changes the tree, the `render` that changes it wakes the window for
a frame.

### How a node looks under the pointer

The button has no handler for the pointer arriving or leaving, and no field
saying whether it is hovered. Its template says how its box looks in each case,
beside its bindings:

```zena
[new StateStyle(0 as u32, State.Hovered, 0 as u32, new RestyleFill(hoveredStyle)),
 new StateStyle(0 as u32, State.Pressed, 0 as u32, new RestyleFill(pressedStyle))]
```

```wit
record state-style {
  node: u32,      // the node that changes
  when: state,    // hovered, pressed
  of: u32,        // the node whose state is read
  style: restyle, // a box-style, or a text-style
}
```

The host already knows which node the pointer is over, since it is what finds
it, so it draws whichever look holds. A hover or a press that only changes how
something looks costs a frame and wakes nobody: `tests/button.rs` takes the
button from resting to hovered to pressed and back, and the only event written
to the component is the `down` it listens for.

`node` and `of` are separate because a label can change while the button round
it is hovered. A state holds for a node when the pointer is over it or anything
beneath it, so the button stays hovered while the pointer is on its label.

A frame also notices when the tree moved and the pointer did not. If a layout
change slides a different node under a still pointer, the frame that solves the
new layout draws that node hovered, and the `enter` and `leave` calls that
follow from it are delivered afterwards.

### Scrolling

[`examples/zenafx/scroll/`](../../examples/zenafx/scroll/) is forty rows in a
box that shows six, under a line saying which row was pressed.

```bash
./target/release/zena build ./packages/zenafx:build:scroll   # compiles it to out/scroll.wasm
./target/release/zfx --app packages/zenafx/out/scroll.wasm
```

The list scrolls because its box says so, and for no other reason:

```zena
box({style: listStyle, align: Align.Stretch, width: new LengthPx(280.0),
     height: new LengthPx(240.0), overflowY: Overflow.Scroll}, [slot()])
```

```wit
enum overflow { clip, hidden, scroll }

record flex {
  // ...
  overflow-x: overflow,
  overflow-y: overflow,
}
```

Content that does not fit in a box is cut off at the box's edge, whichever of
the three the box says. Nothing is drawn outside a box. The values are CSS's,
with CSS's meanings, and CSS's `visible` is left out.

- `clip` is the default, for a box whose content is expected to fit. The box
  is never laid out smaller than its content. If the content still does not
  fit, because the box was given a size, it is cut off and the host logs a
  warning.
- `hidden` is for a box meant to hold more than fits. It may be laid out
  smaller than its content.
- `scroll` is `hidden`, and the wheel moves the content as far as it reaches.

A box whose content fits is drawn with no clip, so cutting off by default
costs nothing where there is nothing to cut.

How far a box has scrolled is the host's to keep, as what the pointer is over
is. The component has no handler for the wheel and holds no position:
`tests/scroll.rs` wheels the list to its end and back, and no event is written
to the component.

The rows say `shrink: 0.0`, because a box in a column otherwise gives up height
before it overflows, and forty rows that each gave up a little would fit.

What is cut off entirely is not drawn, so a frame costs the rows that show. It
is not under the pointer either: a press below the list reaches no row, though
rows are laid out there, and a press after scrolling reaches the row drawn under
it. The frame after a scroll tests the pointer again, so the row that scrolled
under a still pointer is the one drawn hovered.

The wheel goes to the nearest box under the pointer that scrolls that way and
has further to go, so a list at its last row passes the wheel to the page.

A box with further to scroll shows a thumb along its edge: as long, against the
box, as the box is against its content, and as far along.

A frame after a scroll solves no layout. The solver's answer stands until the
component writes the tree or the window changes size, and scrolling and
hovering do neither, so those frames are a walk of the tree and a paint.

### Dragging

[`examples/zenafx/split/`](../../examples/zenafx/split/) is two panels and a
divider between them that the pointer drags.

```bash
./target/release/zena build ./packages/zenafx:build:split   # compiles it to out/split.wasm
./target/release/zfx --app packages/zenafx/out/split.wasm
```

The pointer leaves a divider as soon as it moves, so a drag needs pointer
capture, which a listener asks for on the reply to a press, as
`setPointerCapture` does in the DOM:

```wit
resource reply {
  stop-propagation: func();
  capture: func();
}
```

From that answer until the button comes up, the node the listener is on is the
target of every move and stays the node the pointer is over, wherever the
pointer goes. The example's divider stays held, and its cursor stays the one
for a sideways drag, while the pointer is over a panel or past the window's
edge.

```zena
grab(2 as u32, (event) => {
  this.#held = event.x;
}),
whileCaptured(0 as u32, PointerKind.Move, (event) => {
  this.#moveTo(event.x - this.#held);
})
```

The divider, node 2, starts the drag. The split, node 0, hears the moves. A
listener is told where the pointer is in its own node's box, and the divider's
box moves with every write, so the moves are heard on the box that stays still.

The second listener's scope is `captured`: it hears only while the pointer is
captured for a node at or beneath its own. A pointer crossing the panels with
nothing being dragged reaches no listener. `tests/split.rs` asserts that, and
that each move of a drag is one event to the component and one write back.

Neither panel goes below 120 wide, and the component works out only the left
one's limit. The right panel does not shrink below its own width, so the layout
stops the left one at a width the component never learns: the window's.

`capture` works on the reply to a `down`, and on the reply to a `move` while
the primary button is down, so a press can become a drag once the pointer has
moved some way. On the reply to any other event it does nothing.

### Cursors

A node names the cursor to show while the pointer is over it, with one of
CSS's `cursor` keywords:

```wit
record node-def {
  // ...
  cursor: option<cursor>,
}

enum cursor { default, pointer, text, grab, grabbing, col-resize, /* and 28 more */ }
```

`none` leaves it to the node above, as `cursor` inherits in CSS. While the
pointer is captured, the cursor is the capturing node's.

The platform draws the cursor. The host tells the window which of the
platform's cursors to show when the node under the pointer changes, so a cursor
follows the person's settings for size and colour, and no component code runs
for it. [`examples/zenafx/cursors/`](../../examples/zenafx/cursors/) is a tile
for each of the 34 cursors:

```bash
./target/release/zena build ./packages/zenafx:build:cursors   # compiles it to out/cursors.wasm
./target/release/zfx --app packages/zenafx/out/cursors.wasm
```

### The keyboard and the focus

[`examples/zenafx/disclosure/`](../../examples/zenafx/disclosure/) is two
summaries, each showing and hiding the lines under it, worked from the keyboard
as well as with the pointer.

```bash
./target/release/zena build ./packages/zenafx:build:disclosure   # compiles it to out/disclosure.wasm
./target/release/zfx --app packages/zenafx/out/disclosure.wasm
```

One node in a window has the focus, or none does. A node says whether it can
have it, and a template says how a node looks while it does, beside its other
state styles:

```wit
record node-def {
  // ...
  focusable: bool,
}

enum state { hovered, pressed, focused }
```

`Tab` moves the focus to the next node that can have it, in the order the nodes
come in the tree, and `Shift` with `Tab` to the one before, going round at the
ends. A press gives the focus to the nearest such node at or above the one
pressed. The host does all of that and draws the ring. In the example no
handler hears `Tab`, and the first `Tab` in a window reaches no listener at
all.

A component hears keys on a stream per listener, as it hears the pointer:

```wit
listen-keys: func(target: u32, at: phase) -> stream<key-delivery>;

record key-event {
  down: bool,
  key: string,    // what the key means: `a`, ` `, `Enter`, `ArrowDown`
  code: string,   // which key it is: `KeyA`, `Space`
  modifiers: modifiers,
  repeat: bool,
}
```

A key travels the path from the root to the node with the focus and back, so a
listener hears the keys pressed while the focus is at its node or beneath it.
The names in `key` and `code` are the ones the W3C's keyboard events use.

```zena
[onKey('Enter', () => { this.#toggle(); }),
 onKey(' ', () => { this.#toggle(); })]
```

The host acts on a key after its listeners have answered, unless one of them
called `prevent-default` on the reply. A summary with the focus is offered
`Tab`, passes it on, and the focus moves, which `tests/disclosure.rs` asserts
through the built component. An editor that indents with `Tab` would call
`prevent-default`, and the focus would stay. `stop-propagation` is separate, as
it is in the DOM: it keeps later listeners from hearing the key, and the focus
still moves.

### A text field

[`examples/zenafx/input/`](../../examples/zenafx/input/) is two one-line text
fields, written in Zena.

```bash
./target/release/zena build ./packages/zenafx:build:input   # compiles it to out/input.wasm
./target/release/zfx --app packages/zenafx/out/input.wasm
```

The text is the component's, and so is what each key does to it.
`input/editing.zena` takes a text and a selection and says what a key makes of
them: the arrows, by character or by word, `Home` and `End`, Backspace and
Delete, Shift to extend the selection, and select all. It has no host in it,
and `input/editing_test.zena` tests it by itself. `input/text-input.zena` is
the widget.

The selection is the host's. A window has one selection, as it has one focus,
and a text node says whether a person edits it:

```wit
record node-def {
  // ...
  editable: bool,
}
```

In such a text node the host does everything the pointer does, with no call to
the component:

- A press anywhere in the field puts the caret at the place in the text
  nearest the pointer, and dragging from there selects.
- A press with Shift held moves the end of the selection to the pointer.
- A second press in the same place selects the word there, and a third all the
  field's text.
- A field that gets the focus gets the caret, at the end of its text.

The host draws the caret and a highlight over what is selected, while the
field has the focus. It scrolls the nearest box above the text that says
`hidden` or `scroll` to keep the caret in sight. A `hidden` box is scrolled by
the host alone and never by the wheel.

The component edits when it hears a key. It asks where the selection is,
writes the new text into its hole, and says where the caret now is:

```wit
resource node {
  selection: func(target: u32) -> option<text-selection>;
  select: func(target: u32, to: text-selection);
}

record text-selection { anchor: u32, focus: u32 }

record key-event {
  // ...
  text: option<string>,
}
```

A place in a text is a count of UTF-8 bytes from its start, on both sides.
`text` is the text a key press types on the keyboard's layout. A key that
types nothing has none, and neither does a letter pressed with Control or
Meta.

The field's template is a box and two text nodes. The box is a row that hides
what does not fit, so its text is laid out on one line and never wrapped. The
second text node is the placeholder, which says something only while the
first is empty.

`tests/input.rs` types into the built component with no window, and presses,
drags and presses twice in it. It checks the caret, the highlight and the
text drawn, and that the pointer selecting writes no event to the component.

### Selecting text, and the clipboard

[`examples/zenafx/selection/`](../../examples/zenafx/selection/) is a page of
text, a button and a text field.

```bash
./target/release/zena build ./packages/zenafx:build:selection   # compiles it to out/selection.wasm
./target/release/zfx --app packages/zenafx/out/selection.wasm
```

Any text in a window can be selected, as on a web page, and the component that
drew it does nothing for that and is told nothing:

- A press on text and a drag select from the one place to the other, through
  whatever text is between them in the order of the tree.
- A second press selects a word, and a third the whole of a text node.
- Control or Meta with `a` selects all of it.
- Control or Meta with `c` copies what is selected to the platform's
  clipboard, with a line break between one text node and the next.

A node says when its text is left out, as `user-select: none` does in CSS:

```wit
record node-def {
  // ...
  unselectable: bool,
}
```

Text at such a node, or beneath it, is not selected by a drag over it
or by selecting everything, and a press on it leaves the selection as it was.
The example's button leaves its label out, so pressing the button keeps what
was selected.

A text field uses the same selection and the same clipboard. Control with `x`
copies what is selected, and the field that hears the key deletes it.
Control with `v` is followed by a second key, named `Paste`, whose `text` is
what is on the clipboard. A field inserts a key's text whatever the key, so it
is pasted into with no code for pasting. No component is handed the
clipboard.

`tests/selection.rs` drags over the built example's text, copies it, and
pastes into and cuts from its field, with a clipboard of its own in place of
the platform's. It counts no event written to the component for the drag or
the copy.

### Text in more than one style

[`examples/zenafx/richtext/`](../../examples/zenafx/richtext/) is a card of
paragraphs in which words are bold, in another colour or in a larger size.

```bash
./target/release/zena build ./packages/zenafx:build:richtext   # compiles it to out/richtext.wasm
./target/release/zfx --app packages/zenafx/out/richtext.wasm
```

A paragraph is a flow container: a node whose text children the host lays out
together as one piece of text.

```wit
record node-def {
  // ...
  text-flow: option<text-flow>,
}

record text-flow {
  align: text-align,           // start, center, end or justify
  line-height: option<f32>,    // a multiple of the text size
}
```

Each text child keeps its own style, and its string is still written through
a hole. The host joins the strings in order, shapes them as one and breaks
lines across the whole, so a phrase in another colour can start on one line
and finish on the next. The container is a box in every other way: it has a
width, padding and a fill, and its parent places it.

```zena
flow({lineHeight: 1.5}, [
  text('Text in a flow container is ', plain),
  text('one piece of text', bold),
  text('. A phrase can be ', plain),
  text('in another colour', coloured),
])
```

To the selection a flow container is one text. A second press on a word that
is half in one child and half in the next selects the word, and what is copied
from a paragraph has nothing between its parts.

This is the first step of
[zenafx-text-flow.md](../../docs/design/zenafx-text-flow.md). A text child
cannot yet be hovered, listened to or left out of selecting by itself, and a
child that is not text is not shown. `tests/richtext.rs` checks the example's
paragraphs with no window.

Whether a bold or italic word looks different depends on the fonts installed.
The host asks for the weight and the style, and draws the face it is given.

### What is not here yet

A window shows one component. Embedding one component in another is designed
in [Interior and content](../../docs/design/zenafx-ui.md#interior-and-content) and
not implemented: an earlier prototype did it by
having each component export `render` and `measure`, which fixed one widget
to one component, and that was removed. Whatever replaces it will embed
components of this shape, each holding as many widgets as it likes.

That prototype was also where the cost of a component boundary was measured —
three components drawing one card came to 6 solves and 54 cross-component
`measure` calls per frame, against 0 and 0 for the retained tree. Those
numbers are no longer reproducible from this tree.

A text field has no undo, no text from an input method, and a caret that does
not blink. A component cannot put text of its own on the clipboard or change
what a copy takes. A component cannot move the focus itself, and a node that gets
the focus while it is scrolled out of sight stays there. A box has no minimum
or maximum size of its own, which the split
example gets from what shrinks and what does not. A scroll thumb cannot be dragged
or styled, a component cannot read or set how far a box has scrolled, and a
box's content is cut off at a rectangle, so it shows in the corners of a box
with rounded ones.
Navigation and asset loading are
designed in
[zenafx-navigation-and-assets.md](../../docs/design/zenafx-navigation-and-assets.md)
and not built. Milestone 1 of the UI design says what else that leaves out.

Everything but the window is covered by tests that need no display, including
rasterization: `src/ui/` has unit tests for each primitive, and
`tests/app.rs` loads the widgets component and asserts its geometry against
the same numbers the Rust scene is asserted against. The two windowed paths have
`#[ignore]`d smoke tests that watch for the first presented frame:

```bash
npm test -w @zena-lang/zenafx             # headless; builds the component first
npm run test:gui -w @zena-lang/zenafx     # opens windows
```

## Threading Architecture

Operating systems (specifically macOS/AppKit) require window management and OS
events to run on the main process thread. WebAssembly execution under the
Component Model async ABI runs cooperatively on an asynchronous executor.

`zfx` separates these responsibilities across two threads:

1. **Main Thread**: Runs the `winit` window event loop via
   `surface_wasmtime::winit::create_wasi_winit_event_loop()`.
2. **Background Thread**: Runs a Tokio runtime that initializes Wasmtime,
   instantiates the guest component, and executes its asynchronous entry point.
3. **Cross-Thread Dispatch**: `WasiWinitEventLoopProxy` forwards window
   creation, resizing, and input events across threads without blocking the main
   event loop.

## Engine Configuration

The Wasmtime `Engine` inherits Zena's base configuration from `zena-runtime`
(backtrace details, GC collector settings, and compiler inlining) and enables the
Component Model with async support (`wasm_component_model` and
`wasm_component_model_async`).

## Building and Testing

```bash
cargo build --release -p zenafx            # builds target/release/zfx
cargo test -p zenafx                       # runs CLI integration tests (headless-safe)
npm test -w @zena-lang/zenafx              # runs test suite via Wireit

# Run the end-to-end graphical smoke test (opens native window, requires display & GPU):
cargo test -p zenafx -- --ignored
npm run test:gui -w @zena-lang/zenafx
```

## Running the Demo Component

To run the reference WebGPU triangle component:

```bash
./target/release/zfx packages/zenafx/fixtures/triangle.wasm
```
