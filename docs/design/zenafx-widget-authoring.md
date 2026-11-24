# ZenaFX Widget Authoring

## Status

Design. The protocol it lowers to is partly built —
[Implementation status of the protocol](./zenafx-ui.md#implementation-status-of-the-protocol)
says which parts — and the surface described here is not. `examples/zenafx/`
builds templates by hand through convenience functions, which is what this
document replaces.

It covers the Zena side: how a widget is written, where its state lives, how an
update reaches the host, how control flow and guest directives compose inside
templates, how children reach the widget that places them, how a subtree
appears twice, how a handler is attached, and how a subtree is styled.

The surface is the general-purpose node literal and `@` tag syntax from
[declarative.md](./declarative.md). `@ui` re-interprets a node literal as a
call-site-cached template with one-shot block-evaluation bindings and reactive
`$(...)` bindings. The scene protocol is in
[zenafx-ui.md](./zenafx-ui.md), under
[The scene protocol](./zenafx-ui.md#the-scene-protocol) and
[Events](./zenafx-ui.md#events-input-and-what-a-widget-reports). Where the two
documents would say the same thing, this one links.

## Trees in play

Three trees exist and they are not interchangeable.

**The widget tree** is Zena objects in the guest's heap, holding private state.
Neither the host nor the framework holds a registry of it; a widget is reachable
from whatever refers to it, like any other object.

**The template** is a widget's fixed interior structure, built once per `@ui`
call site, with a binding where each instance-specific or reactive value
arrives. [Template identity](#template-identity) gives the rules for templates,
one-shot bindings, constant folding, and reactive `$(...)` bindings.

**The scene tree** is what the host retains: nodes carrying a layout and an
appearance, each with an id. A widget occupies exactly one node — the template's
node 0 is the node it is rendered into — and the rest of the template hangs
beneath it. A node also records the widget that owns it, which is what makes input
routable: a hit test turns a position into a node, and the node has to say who to
tell.

The layout result and the display list are per frame and belong to the host.

### Widget ownership

A widget declares its interior and the slots in it. What hangs in a slot belongs
to whoever supplied it, and the host does the projection, so a widget can name
nothing inside its own content: it is handed a node per child and reads nothing
through it.

Within one component a container refers to its children as ordinary Zena objects,
and composing them is an ordinary call. Naming a child and naming what the child
rendered are separate things: the container has an object for the first and no id
for the second. Across a component boundary a child is not an object at all, and
the container refers to the node it gave away instead.

Whether a container should be able to introspect its content is open. A widget
that needs to is plausible and nothing here forecloses it.

### Reference, not expansion

A widget reference in a tree could be _expanded_ — called, its result spliced in,
recursively, until only primitives remain, which is React's model and leaves no
widget in the tree. Or it could stay a **reference**: a real node that owns a
region, which is the web's.

ZenaFX is the second, and parts of the existing design only work that way.
[Interior and content](./zenafx-ui.md#interior-and-content) has each widget
render into the one node it was handed.
[Context](./zenafx-ui.md#context-values-that-inherit-down-the-tree) says the
host holds the whole tree "including nodes belonging to other components".
[The scene protocol](./zenafx-ui.md#the-scene-protocol) writes values in place,
where expansion would re-derive a subtree to find out what changed.

Expansion also costs crossings. Obtaining a component's subtree means calling into
it, so expanding a tree of _n_ components costs _n_ crossings per render, which is
what [Reasons for a retained tree](./zenafx-ui.md#reasons-for-a-retained-tree)
measured.

Within one component the distinction is weaker, because reaching a local child is
an ordinary call. A local child still owns its own bindings, so it is a reference
there too.

## Node construction

The surface is the node literal syntax (`Type [arg] { ... }`) from
[declarative.md](./declarative.md#typed-node-block-grammar), prefixed with the
`@ui` tag. A type identifier opens a node, named entries are its properties,
nested node entries are its children, and `$(...)` marks reactive bindings and
dynamic children. `examples/zenafx/widgets/card.zena` becomes:

```zena
build(): TemplateResult {
  return @ui Box {
    style: cardStyle,
    align: Align.Stretch,
    gap: 10.0,
    padding: cardPadding,

    Text this.#title { style: titleStyle(this.#accent) }
    Slot { style: wellStyle, padding: wellPadding }
  };
}
```

Four provisions of that syntax carry the weight here:

- **One literal grammar, re-interpreted by `@ui`.** `Box { ... }` is the same
  syntax as a nominal record or class constructor (`Point { x: 1.0, y: 2.0 }`).
  Without `@ui`, `Box { ... }` constructs its objects eagerly; with `@ui`, the
  compiler caches the static node tree once per call site, evaluates plain
  expressions once when `build()` runs (folding constants into the template and
  sending non-constants as one-shot bindings), and turns `$(...)` expressions
  into reactive thunks. `@` never switches the parser into a separate grammar
  ([syntax-overhaul.md](./syntax-overhaul.md), [declarative.md](./declarative.md)).
- **Children are entries inside the brace.** Zena's grammar already reads
  `Expression "[" Expression "]"` as an index expression, so a trailing `[ … ]`
  holding children would collide with subscripting a node. Entries inside `{ … }`
  raise no such question.
- **A positional argument carries leaf content.** `Text this.#title` is the
  whole text node. `text(content, style)` exists in the prototype because a
  constructor call cannot take an argument that way.
- **Properties are named, so defaulting is ordinary record behaviour.** A node's
  `box` and `flex` have eleven fields between them and a call site usually sets
  two. `boxOf` and `flexOf` in `examples/zenafx/widgets/widget.zena` exist only to
  fill in the rest, and presence-optional fields
  ([record-presence.md](./record-presence.md)) retire them.

A node type is an ordinary Zena class. `Box`, `Slot` and `Card` are identifiers in
scope, nothing marks a type as usable in a node literal, and the type checker
validates each node's properties and whether it accepts children against its
type. The compiler needs no built-in knowledge of ZenaFX.

### Divergence from declarative.md

- The **component sigil** `<@Card>` separates a component reference from an
  element name in markup, where a tag can be a string. Node literals have no
  string tag names, so `<@Card>` belongs to markup alone.
- **Markup** earns its place where prose and structure interleave, since
  `<p>Hello <b>there</b></p>` is unreadable as nested blocks. A UI of boxes has
  no prose between its boxes, so ZenaFX uses `@ui` node literals while web UI
  uses `html` tagged template literals ([wasm-web-ui.md](./wasm-web-ui.md)) and
  markup stays for `.zhtml` and `.zmd`.

## State and updates

A widget's `build` runs once. It returns a `TemplateResult` pairing a cached
template with the instance's one-shot bindings and reactive `$(...)` bindings.
A later state change reaches the host by writing a binding, so nothing re-runs
`build` and nothing compares two descriptions.

```zena
import {signal} from 'zena:signals';

class Counter {
  @signal var count: i32 = 0;
  #period: Duration;

  new(this.#period) { this.#tick(); }

  increment(): void { this.count += 1; }

  build(): TemplateResult {
    return @ui Dial { digits: $(`${this.count}`) };
  }

  #tick(): void {
    sleep(this.#period).then(() => { this.count += 1; this.#tick(); });
  }
}
```

`@signal` is a field decorator ([decorators.md](./decorators.md)) backed by
`zena:signals`'s `Tracker` ([signals.md](./signals.md#signals-as-class-fields)):
it stores the value inline in the object and allocates a `Tracker` lazily on
the first read inside a reactive computation. The same program works with
explicit `State<i32>` and `Computed<T>` fields from `zena:signals`, which is
already implemented in `packages/stdlib/zena/signals.zena`.

### Evaluation phases: one-shot vs. reactive `$(...)` bindings

Inside `@ui`, expressions have two visible evaluation times:

- **Plain expressions outside `$(...)` evaluate once when `build()` runs.**
  This covers constants (`cardStyle`, `10.0`), immutable fields (`this.#title`),
  computed initial values (`titleStyle(this.#accent)`), mutable variables, and
  event handlers (`onPress: () => this.#press()`). No `const` restriction
  applies, and plain expressions allocate no thunk and no `Effect`. Provably
  constant expressions fold into the cached template; all other plain
  expressions become one-shot bindings sent on mount and then discarded.
- **`$(expr)` expressions evaluate as reactive thunks (`() => expr`).**
  On mount, the framework runs the thunk once inside a tracking scope:
  - Reading a `@signal` field (`this.count`) or calling `.get()` on a `State` /
    `Computed` subscribes an `Effect` that writes that binding when sources change.
  - Returning a `Signal<T>` directly (for example `$(this.countState)` or
    `$(this.selectedItem.titleSignal)`) causes the framework to call `.get()` on
    the returned signal inside the same `Effect`, tracking both the outer reads
    and the returned signal.
  - If the initial run records no signal sources (`hasSources == false`, such as
    a one-shot dynamic child `$(this.#footerWidget)`), the framework applies the
    value once and discards the thunk with no retained `Effect` or dependency
    `Link`s.

Because `onPress: () => this.#press()` sits outside `$(...)`, handlers are
ordinary Phase 2 expressions evaluated once at mount with no extra wrapper.

### Consequences of building once

**There is no reconciliation.** Nothing matches a new description against an
existing instance, so no widget needs a key and no framework tree exists to walk.
[Identity and host state](./zenafx-ui.md#identity-and-host-state) gives the
protocol side of the same property.

**There is no distinction between a stateless and a stateful widget.** Flutter
separates `StatelessWidget` from `StatefulWidget` because it re-runs `build` and
has to know what survives. Nothing survives a rebuild here, because there is no
rebuild.

**A widget is kept alive by what refers to it.** A signal read by a binding keeps
the signal alive; a timer continuation or an event handler that captured `this`
keeps the widget alive; a parent that intends to call a method on a child refers
to it. A widget that no one can act on is garbage, which needs no framework
bookkeeping. Flutter's element tree pins every `State` object whether or not
anything can reach it.

**A parent refers to a child only when it needs to.** Calling a method on a child —
`dialog.open()`, `list.scrollTo(…)` — needs a reference to the widget, because a
node handle has no such method. Within one component that reference is an ordinary
field. Across a component boundary it is a WIT resource, with handles and no shared
heap.

### Costs of building once

`build` running once is what Solid does, and it has the hazard Solid has: code
outside a reactive binding runs only once even if it reads state. Two guards
mitigate that here.

First, reactivity is visibly marked by `$(...)`. Reading a `@signal` field
outside `$(...)` (for example `Text this.summary`) evaluates once at `build()`
time as an ordinary Zena expression, and a `zena lint` rule can warn when a
`@signal` field is read inside `@ui` outside `$(...)`. Second, `@signal` puts
the reactivity decision at the field declaration, so a method mutating a plain
field cannot silently fail to notify an observer without that field being plain
at its declaration.

## Template identity

A widget's interior structure is fixed per `@ui` call site. The fixed template
travels to the host once and is named by its id afterwards; instance-specific
and reactive values arrive as binding updates (`record hole` in the current
WIT).

A template belongs to a `@ui` node literal in the source: the compiler builds
the `Template` once per call site and caches it in a Wasm global, just as Zena
caches `TemplateStringsArray` for tagged template literals. Rendering 1,000
instances of `Card` with 1,000 different titles shares one `Template` — no
runtime memoization cache is needed and template identity never thrashes.

### Rules for templates and bindings

Three rules decide how a `@ui` node literal compiles:

1. **Static node structure belongs to the call-site template.** Every
   `Type [arg] { ... }` node in child position becomes a node in the cached
   `Template`.
2. **Plain expressions outside `$(...)` evaluate once when `build()` runs.**
   If the expression is provably constant (a literal, an enum case, or an
   immutable module-level `let` of an immutable type such as `BoxStyle`,
   `TextStyle`, or `Edges` — never a `var`), the compiler folds it directly into
   the cached `Template`'s node definitions. Otherwise (`this.#title`,
   `titleStyle(this.#accent)`, a mutable `var`), it becomes a one-shot binding
   in the same shared `Template`, sent once in the initial `render` call with no
   thunk and no `Effect`.
3. **Expressions inside `$(...)` are reactive thunks.** In property or
   positional-argument position, `$(expr)` becomes a binding driven by a thunk
   and an `Effect`. In child position, `$(expr)` compiles to a slot node paired
   with a guest `SlotPart` driven by that thunk.

In `Card.build` under [Node construction](#node-construction), the whole node
structure plus `cardStyle`, `wellStyle`, `cardPadding`, `wellPadding`,
`Align.Stretch`, and `10.0` fold into the cached template. `this.#title` and
`titleStyle(this.#accent)` become two one-shot bindings on that same template.

Folding in rule 2 never changes evaluation semantics: whether a plain
expression folds into `Template.nodes` or travels once in the mount `render`
call, it runs once when `build()` runs and creates no thunk and no `Effect`.

### Binding cost in the host and on the wire

In the host (`packages/zenafx-render/src/scene.rs`), `Template.bindings` is a
flat `Vec<Binding>` (a `u32` node index and a 1-byte `BindingTarget`, roughly
8 bytes per entry) stored **once on the `Template`**, not per rendered node
instance. Per-instance host overhead for a binding is zero bytes — there are no
per-binding `Part` objects or marker nodes on the host side.

On the wire, binding updates are sparse, so a one-shot binding written on mount
and never touched again costs zero bytes on all later frames. Because
`BindingValue` is a WIT `variant`, each mount-time update carries the size of
the largest variant (`Flex`), so constant folding still saves mount-time wire
bytes by eliminating a binding entry.

Because host bindings are cheap and stateless per instance, `Template.bindings`
does not separate one-shot bindings from reactive bindings: there is one flat
list of bindings on the template, and on the guest side only `$(...)` bindings
retain an `Effect`.

### Compilation of a binding

A `@ui` tagged node literal compiles to one call-site-cached `Template` plus
per-instance mount data (`TemplateResult`):

| source                             | template (cached once per call site) | mount / update (per instance)                        |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `Box { style: cardStyle, … }`      | a node, constant style/flex folded   | nothing                                              |
| `Text 'Settings'`                  | a node, constant content folded      | nothing                                              |
| `Text this.#title`                 | a node + binding entry               | evaluate once; send on mount (no thunk, no `Effect`) |
| `Text $(this.summary)`             | a node + binding entry               | run thunk; write binding; keep `Effect` if tracked   |
| `Button { onPress: () => … }`      | a node                               | evaluate handler once; register listener             |
| `Card { title: this.#t, n: $(c) }` | a node of kind `Card`                | construct with `this.#t`; subscribe `n` if tracked   |
| `Slot { … }`                       | a node marked as a slot              | project parent content                               |
| `$(expr)` in child position        | a slot node                          | mount `SlotPart`; run thunk/directive; update slot   |

A property of a child _widget_ is passed or updated by a typed Zena call on
that widget rather than by writing a host binding, because the host neither
lays it out nor paints it. Binding indices therefore number only the bindings
the host sees.

## Control flow and directives

Node literals have no built-in `if`, `match`, or `for` statements. All control
flow is ordinary Zena code inside a `$(...)` child binding, and nested
templates carry an explicit `@ui` tag:

```zena
build(): TemplateResult {
  return @ui Column {
    // Plain `if`: drops the inactive branch when `loading` flips.
    $(if (this.loading) {
      @ui Spinner { style: spinnerStyle }
    } else {
      @ui Rows { items: $(this.items) }
    })

    // Cached `match`: parks inactive branches without destroying host nodes.
    $(cache(match (this.tab) {
      case Tab.Feed: @ui FeedView {}
      case Tab.Settings: @ui SettingsView {}
    }))

    // Keyed list via a directive (or `this.items.map(...)` for positional).
    $(repeat(this.items, (item) => item.id, (item) =>
      @ui Row {
        style: rowStyle,
        label: item.name,
        active: $(item.selected),
      }
    ))

    // Arbitrary helper method returning a TemplateResult, Widget, or Child.
    $(this.#renderFooter())
  };
}
```

Nested blocks keep an explicit `@ui` tag instead of inheriting one from an
enclosing block. Extracting any branch into `#renderFooter()` keeps the same
meaning and return type without non-local syntax effects.

Because `$(this.items)` inside `Rows` is its own thunk, changing `this.items`
while `loading == false` never re-runs the outer `if` binding; only `Rows`'s
inner binding updates.

### Directives in the guest

Directives such as `cache`, `cacheBy`, `repeat`, `guard`, and `until` are plain
exported Zena functions in guest libraries. Neither the host nor the scene
protocol knows about directives; the host provides only detachable `own<node>`
handles (`create-node`) and slot assignment (`set-slot`), described in
[Detached nodes and slot assignment](./zenafx-ui.md#detached-nodes-and-slot-assignment).

When a template mounts, each `$(...)` child binding gets a guest `SlotPart`
that holds the parent node, the slot index, the binding's `Effect`, and any
active `Directive` instance. A directive returns a typed `DirectiveResult`
whose `matches` method uses a WasmGC `is` test to keep the same `Directive`
instance alive across updates:

```zena
export type Child =
  | TemplateResult
  | Widget
  | Iterable<Child>
  | DirectiveResult
  | null;

export interface DirectiveResult {
  matches(active: Directive): boolean;
  create(): Directive;
  apply(active: Directive, part: SlotPart): void;
}

export interface Directive extends Disposable {
  pause(): void;
  resume(): void;
}
```

- **`cache(value)`** keys parked branches by `value.template` identity (or by
  an explicit key in `cacheBy(key, () => ...)`). On the first visit to a branch
  it calls `part.createNode()` and mounts the template; when switching away it
  calls `mounted.pause()` to suspend the branch's `Effect`s and swaps the new
  node into the slot with `part.setNodes([node])`. The parked node stays alive
  in the host with its shaped text runs intact, and unvisited branches are never
  allocated. Nested `cache()` directives compose because `pause()` and
  `resume()` cascade through child `SlotPart`s. Disposing the directive drops
  every parked `own<node>`.
- **`repeat(items, keyFn, renderFn)`** keeps a `HashMap<K, RowEntry>` of row
  `own<node>` handles and permutes the slot with a single `part.setNodes(...)`
  call when items reorder, keeping each row's interior and shaped text intact.
- **`until(future, placeholder)`** renders `placeholder` until a `Future<Child>`
  resolves and cancels the task in `[Disposable.dispose]()`.

An earlier version of this design compiled `if` and `match` into a host `choice`
node kind and `for ... keyed` into a host keyed-slot protocol. Moving both to
guest directives over `create-node` and `set-slot` avoids eagerly allocating
unvisited branches, supports dynamically keyed views, keeps branch-retention
policy in guest libraries, and lets directives compose as ordinary expressions.

## Children and slots

A widget's build asks the host for one node per child in each slot its template
declares, through `node.content(slot, …)`, and renders each child into the node it
was handed. The widget can read nothing through those nodes: no id for anything a
child rendered, and no way to reach one.

Children are written where they are used:

```zena
Card {
  title: 'First card',

  Label 'One child widget in this slot'
}
```

and the widget declares where they go, with no field for them at all:

```zena
export class Card implements Widget {
  #title: String;
  build(): TemplateResult {
    return @ui Box {
      style: cardStyle, align: Align.Stretch, gap: 10.0, padding: cardPadding,

      Text this.#title { style: titleStyle }
      Slot { style: wellStyle, padding: wellPadding }
    };
  }
}
```

**The host does the projection.** The enclosing widget's tree carries both the
`Card` and the content for it; the host, which holds Card's interior and its slot,
matches them. That is the only arrangement that works, because the enclosing
widget has no id for Card's slot node — it is inside Card's instance, which Card
created. It is also shadow DOM's arrangement, where the outer author declares
children of the host element and never references the `<slot>`.

So `content` names a slot index, never a slot node, and the host hands back the
nodes to render into. Slot fallback content is not free under that rule, because
a slot's children _are_ its content: showing a template's own children there when
nothing is assigned would need the host to tell the two apart. Nothing needs it
yet.

### Named slots without names

Several slots are the usual reason a framework invents slot names. Here they are
positional, resolved at compile time:

```zena
Dialog {
  header: [Text 'Delete this file?'],
  actions: [Button { label: 'Cancel' }, Button { label: 'Delete' }],

  Text 'This cannot be undone.'
}
```

The caller's property names pair against the order the child's type declares its
slots. The names exist in the source and never in the protocol, so nothing can be
misspelled and no content is silently unassigned.

## Mirroring a subtree

A subtree sometimes appears twice. A customizable `<select>` shows the selected
option both in the list and as the closed control's label; a presentation's
filmstrip shows every slide as a thumbnail while one is also on the canvas. HTML
resolves the first by copying the option's content into `<selectedcontent>`, and
a copy goes stale whenever the original changes.

Copying is avoidable, and neither purity nor immutability is the reason. Widgets
are not pure — `build` is a method on an object with private state. What makes a
mirror current is that **it is not a copy**: it references one scene subtree,
which the host resolves when it solves and paints, so a mutation is visible
everywhere with no propagation step.

### Two fits, because the cases differ

The select's label wants its own solve: it sizes to the closed control, a
different width from the list row, and a label that came out looking like a list
item is the bug.

The filmstrip wants the _source's_ solve, scaled. A thumbnail must wrap text where
the slide wraps it; re-solving at an eighth of the width would reflow everything
and show a picture of a different slide. That also makes forty slides cost forty
paints and no extra solves.

A detail hint goes with it, because scaling alone produces illegible output: 12px
text at one-eighth is a 1.5px smear that costs shaping and rasterisation to
produce noise. Dropping what will not read is a rasterizer decision, so it stays
on the host side.

### Input at a mirror belongs to the mirrorer

Nodes carry an owner and input routes by it, so a click on a mirror would
otherwise reach the mirrored content's owner. Both cases want the opposite:
clicking a filmstrip thumbnail should navigate, and clicking the select's label
should open the dropdown. So a mirror is presentational for input as well as for
focus. Mapping input back through one — a live thumbnail you can type into — is a
later question.

### What it costs to implement

Mirrors need per-placement derived data, and the prototype attaches some of it to
the node: `Retained` holds a shaped text run, and `measure_run` re-breaks when
asked about a different width. Two re-laid-out mirrors of one text node at
different widths would thrash a single run, re-breaking every frame and getting
the wrong answer for at least one. So a shaped run has to belong to the placement.
Layout rects already do. A scaled mirror needs neither, since it reuses both.

`bounds` also becomes ambiguous — a node in a mirrored subtree has as many rects
as there are mirrors — and the likely answer is that it reports the home placement
and a mirror's geometry is not readable.

## Events, from an author's side

The protocol is
[Events](./zenafx-ui.md#events-input-and-what-a-widget-reports): the host
dispatches along the scene path to registrations it holds as data. What matters
here is what an author writes.

```zena
@ui Box {
  style: buttonStyle,
  onPress: () => this.#press(),

  Text this.#label { style: labelStyle }
}
```

A property whose value is a function is a registration. The closure stays in a
table the framework keeps, keyed by node, because WIT carries no function type and
a handler cannot cross a boundary. What crosses is the node, the event type, a
scope and a phase — all data.

Three consequences reach the surface.

**A handler is not a binding.** A registration is per-instance and its closure
captures `this`, so registrations are issued when a template is instantiated,
alongside the initial binding values, and a handler changing identity does not
invalidate the template.

**Scope is part of the declaration.** `onPress` on a container means "this box or
anything in it", which is subtree scope. A property that wants only its own box
says so. The distinction has to be visible in the source, because it is the
difference between a container hearing its children and not.

**A container hears its children without holding them.** `Select` registers on the
slot node it owns and hears from an option whose boxes sit beneath it. That is why
a parent needs no reference to a child: the event arrives at a node the container
already has.

### What a container cannot do yet

Two things are absent, and they are separable rather than two halves of one
feature.

**Restricting what may be a child**, as HTML's content model says `<select>` takes
`<option>`s. A static check on the types in a node block, needing no runtime
channel.

**Calling a child directly**, for a message that is not a reply to an event. That
needs a reference, and every case examined so far is served by an event instead. A
reference may still travel upward in an event payload, if the child puts it there
— which keeps the direction consistent: a child may volunteer a handle, and a
parent may not demand one.

## Styling a subtree

Two mechanisms answer different questions.

**Inheritance** answers "everything below here is 14px".
[Context](./zenafx-ui.md#context-values-that-inherit-down-the-tree) already has
it, and says that inherited style properties are the same mechanism, with
`inherit` available as a case in the style records. Nothing further is proposed.

**Rules** answer "every title inside a card is in the accent colour". That is
matching rather than inheriting, and it is the part with no design yet. A rule set
attached to a node applies within its subtree, so the attachment point is the
scope.

### Where each one stops

Rules stop at an edge where ownership changes; inheritance crosses it.

Rules stop because content beyond that edge belongs to whoever supplied it. A card
cannot read its content, so letting the card restyle it would hand the card
authority the rest of the design withholds. Inheritance crosses because font size
and colour are what placed content should pick up from where it sits — a label
dropped into a card should look like it is in a card without knowing what a card
is. Shadow DOM draws both lines in the same places.

Both are stated about an **edge**, which is what makes them free: a slot is a node
whose children are owned by someone else, the host already keeps an owner per
node, and comparing a node's owner with its parent's is the whole test. Nothing
declares itself a boundary. It holds between a parent widget and a child widget in
one component as well, since ownership is per widget — so the encapsulation
arrives without needing a component boundary.

## Selectors as data

[zenafx-styles.md](./zenafx-styles.md) proposes a change to this section. The
syntax stays. The predicate algebra becomes its conditions, which test facts
whose keys are symbols in place of the text tags and the closed set of states
here. The host still evaluates them, and does the part a template fixes once
for each template.

### Why not exported predicates

Style resolution visits every node and may test a predicate against each, so
making that a call into a guest puts a boundary crossing in the innermost loop of
the frame. [Call direction](./zenafx-ui.md#call-direction-within-a-frame) forbids
synchronous guest calls on the frame path, and
[Reasons for a retained tree](./zenafx-ui.md#reasons-for-a-retained-tree) measured
what it costs when it happens anyway, at one call per layout query rather than one
per node per property.

So the guest ships a predicate and the host evaluates it. Generality then has
to come from the predicate language rather than from arbitrary code, which means
an algebra with composition.

### What a predicate matches on

CSS matches on names the author invents, and that layer is worth avoiding. The
facts here can be ones the system already knows.

**Kind** — box, text, or a widget type. Free; it is in the node.

**Origin** — the template the node came from, which is to say the widget class
that declared it. This is the interesting one, and it replaces most of what
classes are for: `Text` within `Card` is expressible with nothing named, cannot be
misspelled, and is how a widget author already thinks. Instantiation records it
per node range, so it costs nothing.

**State** — hovered, focused, pressed, disabled. A closed set the host owns,
because the host does hit testing.

**Position** — first, last, nth among siblings, depth.

**Tags** — an author-set list, for what provenance cannot express. This is classes
under another name, and it belongs last: including it keeps the algebra from being
a dead end, and putting it last keeps it from being the first thing anyone reaches
for.

### WIT

The predicate table is flat and rules refer to entries by index, for the same
reason the node list is flat.

```wit
interface selectors {
  use style.{declaration};

  enum state { hovered, focused, pressed, disabled }

  variant fact {
    is-kind(kind),
    /// The template that declared this node.
    from(u32),
    in-state(state),
    tagged(string),
  }

  variant predicate {
    holds(fact),
    /// Some ancestor matches predicate `n`.
    within(u32),
    /// The parent matches predicate `n`.
    under(u32),
    nth(tuple<u32, u32>),
    all(list<u32>),
    any(list<u32>),
    negate(u32),
  }

  record rule { when: u32, then: list<declaration> }

  record ruleset {
    predicates: list<predicate>,
    rules: list<rule>,
  }
}
```

A custom selector is a named composition in the same algebra, so it needs no
extension point:

```zena
let titleish = selector (Card >> Text) | (Panel >> Text);
```

For a predicate the algebra cannot express, the answer is to compute it in the
guest and set a tag, which keeps arbitrary logic off the frame path. Adding a fact
is the better answer whenever the fact is general.

### Zena syntax

Patterns are the right shape, and the constraint is that they must lower to the
variant above rather than to a closure:

```zena
export let cardStyles = rules {
  case Card >> Text: { color: heading }
  case Card > Slot: { padding: wellPadding }
  case Card >> Text when hovered: { color: accent }
  case Text nth(1, _): { weight: 600 }
};
```

`>>` is descendant, `>` is child, `when` tests state. The type names are widget
classes and node kinds, which is what makes this different from CSS rather than a
reimplementation of it.

This is a restricted pattern sublanguage, not first-class patterns. Patterns as
values would be a larger feature, nothing in the repository designs them, and
selectors do not need them: a selector has to be data by the time it crosses the
boundary, so composition happens at compile time regardless.

## What to prototype, in what order

1. **Signal-backed bindings and guest directives, with explicit closures.**
   `zena:signals` (`State`, `Computed`, `Effect`, `Tracker`, `hasSources`) is
   already implemented ([signals.md](./signals.md)). Wire `examples/zenafx/`
   bindings to closures tracked by `zena:signals` with a frame-scheduled flush,
   and implement `SlotPart` and `Directive` (`cache`, `repeat`) in the guest
   framework. No syntax change is needed, and the hand-written diff in the
   examples goes away.
2. **Detachable nodes (`create-node`, `set-slot`) and `apply`.** The first
   protocol change. `create-node` and `set-slot` let guest directives (`cache`,
   `repeat`) park, swap, and reorder nodes without destroying interiors or
   re-shaping text; `apply` batches a frame's binding updates into one call.
   Both are additive to `zenafx:host/scene`.
3. **Node literals, `@tag` lowering, and `$(...)` reactive bindings.**
   Implement the unified `Type [arg] { ... }` node literal grammar, `@ui Box { ... }`
   call-site template caching, one-shot block-eval bindings (with constant
   folding), and `$(...)` reactive thunks, retiring `box`, `slot`, `text`, and
   `flexOf`. The syntax lands in [declarative.md](./declarative.md)'s terms and
   ZenaFX is its first consumer.
4. **`@signal` field decorator.** Wire the field decorator lowering over
   `zena:signals`'s `Tracker` ([signals.md](./signals.md#signals-as-class-fields),
   [decorators.md](./decorators.md)) so widget state reads directly as
   `@signal var count: i32 = 0`.
5. **Input routing, with registration as data.** Hit test, the scene path,
   `listen` with a scope, one exported entry point per component. Built for the
   pointer and keyboard:
   [Implementation status of events](./zenafx-ui.md#implementation-status-of-events).
6. **Rules.** Inheritance is designed; rules need the attachment op and subtree
   scoping ([zenafx-styles.md](./zenafx-styles.md)).
7. **The rest of the predicate algebra**, which builds on steps 5 and 6.

Steps 1 and 2 settle how updates and guest directives drive the host before any
new syntax is committed to.

## Open questions

**What the host carries when it is only a courier.** An event payload has to be
one WIT type while event types are many. A closed variant of built-in input events
with an opaque tail keeps the common cases typed and gives up on the rest; a
generated interface per event type is fully typed and grows the world with every
event a program declares. This is the last unresolved thing in the protocol, and
[Open questions](./zenafx-ui.md#open-questions) holds it.

**Whether payload size matters.** Several decisions here assume payload cost is
negligible next to call cost. The canonical ABI spills parameters past sixteen
core values and `flex` has nine fields, so the assumption has a measurable edge
and nobody has measured it.

**How a container tells a child something** that is not a reply to an event. The
candidate that fits is a node-level state flag the child's own rules match on —
appearance without contact. That covers "you are selected" and not a child that
must change its content, and whether that case exists is worth finding out before
inventing a mechanism.

**Whether a slot needs marking beyond its index.** A node the compiler only ever
targets with `content` or `set-slot` needs no marker, but a marker makes "you
put content in a node that has template children" a diagnosable error rather
than a silent overwrite.

**The compiler-to-tag protocol for `@ui`.** `@ui Box { ... }` lowers to a
call-site-cached `Template` plus one-shot bindings and `$(...)` reactive
bindings. What remains to specify in detail is the exact builder interface a
tag implements so the compiler can type-check arbitrary node classes (`Box`,
`Text`, `Card`) and lower them without ZenaFX-specific logic in the compiler.

**Where the frame flush is driven from.** Signals mark bindings dirty and
[Batching and the frame](./zenafx-ui.md#batching-and-the-frame) wants one `apply`
per frame, so something has to decide when a frame is. For a component that owns
its window that is the surface's frame stream; for a component embedded in another
it is whatever drives the root. [Scheduling](./zenafx-ui.md#scheduling) has the
host side and the guest side is unspecified.

**Specificity.** Source order within a rule set is predictable and CSS's scoring
is widely held to be a mistake. What remains is the order between rule sets
attached at different depths, where the reasonable default is that a nearer
attachment wins.

## Related

- [zenafx-ui.md](./zenafx-ui.md) — the runtime design this lowers to, in
  particular [The scene protocol](./zenafx-ui.md#the-scene-protocol),
  [Interior and content](./zenafx-ui.md#interior-and-content),
  [Detached nodes and slot assignment](./zenafx-ui.md#detached-nodes-and-slot-assignment),
  [Identity and host state](./zenafx-ui.md#identity-and-host-state),
  [Reactive state](./zenafx-ui.md#reactive-state) and
  [Events](./zenafx-ui.md#events-input-and-what-a-widget-reports).
- [declarative.md](./declarative.md) — unified node literals, `@`-tagged
  templates, `$(...)` bindings, and template files.
- [signals.md](./signals.md) — `zena:signals` (`State`, `Computed`, `Effect`,
  `Tracker`) and the `@signal` field decorator lowering.
- [decorators.md](./decorators.md) — field decorators and `@` syntax.
- [record-presence.md](./record-presence.md) — presence-optional fields, which is
  how node properties default.
- [pattern-matching.md](./pattern-matching.md) — the pattern syntax selectors
  would restrict.
