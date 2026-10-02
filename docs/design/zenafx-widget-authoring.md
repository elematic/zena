# ZenaFX Widget Authoring

## Status

Design. The protocol it lowers to is partly built —
[Implementation status of the protocol](./zenafx-ui.md#implementation-status-of-the-protocol)
says which parts — and the surface described here is not. `examples/zenafx/`
builds templates by hand through convenience functions, which is what this
document replaces.

It covers the Zena side: how a widget is written, where its state lives, how an
update reaches the host, how control flow becomes part of a template, how children
reach the widget that places them, how a subtree appears twice, how a handler is
attached, and how a subtree is styled.

The surface itself is not ZenaFX's. It is the node-block grammar from
[declarative.md](./declarative.md), and what this document adds is the split of a
tree into a template and its holes. The protocol is in
[zenafx-ui.md](./zenafx-ui.md), under
[The scene protocol](./zenafx-ui.md#the-scene-protocol) and
[Events](./zenafx-ui.md#events-input-and-what-a-widget-reports). Where the two
documents would say the same thing, this one links.

## Trees in play

Three trees exist and they are not interchangeable.

**The widget tree** is Zena objects in the guest's heap, holding private state.
Neither the host nor the framework holds a registry of it; a widget is reachable
from whatever refers to it, like any other object.

**The template** is a widget's interior, declared once per widget class, with a
hole where every value that varies arrives. It is a compile-time artifact of a node
block, and [Template identity](#template-identity) gives the rules that decide
which parts of the block become holes.

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

Within one component a container does refer to its children, because they are
ordinary Zena objects and composing them is an ordinary call. That costs nothing
the host cares about, since the container still has no id for anything a child
rendered. Across a component boundary a child is not an object at all, and the
container refers to the node it gave away instead.

Whether a container should be able to introspect its content is open. A widget
that needs to is plausible and nothing here forecloses it.

### Reference, not expansion

A widget reference in a tree could be _expanded_ — called, its result spliced in,
recursively, until only primitives remain, which is React's model and leaves no
widget in the tree. Or it could stay a **reference**: a real node that owns a
region, which is the web's.

ZenaFX is the second, and parts of the existing design only work that way.
[Viewports](./zenafx-ui.md#the-viewport-is-the-capability-nodes-are-ids-inside-it)
has each component build into its own region.
[Context](./zenafx-ui.md#context-values-that-inherit-down-the-tree) says the
runtime holds the whole tree "including nodes belonging to other components".
[The scene protocol](./zenafx-ui.md#the-scene-protocol) writes values in place,
where expansion would re-derive a subtree to find out what changed.

Expansion also costs crossings. Obtaining a component's subtree means calling into
it, so expanding a tree of _n_ components costs _n_ crossings per render, which is
what [Reasons for a retained tree](./zenafx-ui.md#reasons-for-a-retained-tree)
measured.

Within one component the distinction is weaker, because reaching a local child is
an ordinary call. A local child still owns its own holes, so it is a reference
there too.

## Node construction

The surface is the typed node-block grammar from
[declarative.md](./declarative.md#typed-node-block-grammar): a type identifier
opens a node, named entries are its properties, and nested statements are its
children. `examples/zenafx/widgets/card.zena` becomes:

```zena
build(): Template {
  return Box {
    style: cardStyle,
    align: Align.Stretch,
    gap: 10.0,
    padding: cardPadding,

    Text this.#title { style: titleStyle(this.#accent) }
    Slot { style: wellStyle, padding: wellPadding }
  };
}
```

Three provisions of that grammar carry the weight here:

- **Children are statements rather than an array.** Zena's grammar already reads
  `Expression "[" Expression "]"` as an index expression, so a trailing `[ … ]`
  holding children would collide with subscripting a node. Statements inside the
  brace raise no such question.
- **A positional argument carries what a leaf is mostly made of.**
  `Text this.#title` is the whole text node. `text(content, style)` exists in the
  prototype because a constructor call cannot take an argument that way.
- **Properties are named, so defaulting is ordinary record behaviour.** A `flex`
  has nine fields and a call site usually sets two. `flexOf` in
  `examples/zenafx/widgets/widget.zena` exists only to fill in the rest, and
  presence-optional fields ([record-presence.md](./record-presence.md)) retire it.

A node type is an ordinary Zena class. `Box`, `Slot` and `Card` are identifiers in
scope, nothing marks a type as usable in a node block, and the type checker
validates each statement's properties against its class. Statement position is
what makes a statement a node, so the compiler needs no notion of ZenaFX and no
interface for a type to implement.

### Divergence from declarative.md

- The **component sigil** `<@Card>` separates a component reference from an
  element name in markup, where a tag can be a string. Node blocks have no string
  tag names, so the sigil belongs to markup alone.
- **Markup** earns its place where prose and structure interleave, since
  `<p>Hello <b>there</b></p>` is unreadable as nested blocks. A UI of boxes has no
  prose between its boxes, so ZenaFX uses node blocks and markup stays for
  `.zhtml` and `.zmd`.
- **Control flow inside a node block** was missing from declarative.md, whose
  `${ for }` and `${ if }` are defined for markup mode and unnecessary for
  `.zconf`. ZenaFX needs conditional and repeated children constantly, so
  [Control Flow in Node Blocks](./declarative.md#control-flow-in-node-blocks)
  adds them as plain statements.

## State and updates

A widget's `build` runs once. It returns a tree whose holes hold expressions rather
than values, and a change reaches the host by writing a hole, so nothing re-runs
`build` and nothing compares two descriptions.

```zena
class Counter {
  signal var count: i32 = 0;
  #period: Duration;

  new(this.#period) { this.#tick(); }

  increment(): void { this.count += 1; }

  build(): Node {
    return Dial { digits: `${this.count}` };
  }

  #tick(): void {
    sleep(this.#period).then(() => { this.count += 1; this.#tick(); });
  }
}
```

`signal var` declares a field whose reads are tracked and whose writes mark the
holes that read it. The declaration is where reactivity is chosen, so there is no
plain-field version of `count` to write by mistake. Inside a node block
`` `${this.count}` `` is lifted to a tracked expression; in `increment` and
`#tick` the same text reads a value, which is what a method body wants.

[Reactive state](./zenafx-ui.md#reactive-state) covers the signals themselves.
They are a Zena library and need nothing from the host, because a hole is already
addressable from the guest. `signal var` and the lifting inside a node block are
sugar over that library: the same program can be written today with an explicit
`Signal<i32>` field and explicit closures in hole position, which is how this will
first be built.

### Consequences of building once

**There is no reconciliation.** Nothing matches a new description against an
existing instance, so no widget needs a key and no framework tree exists to walk.
[Identity and host state](./zenafx-ui.md#identity-and-host-state) gives the
protocol side of the same property.

**There is no distinction between a stateless and a stateful widget.** Flutter
separates `StatelessWidget` from `StatefulWidget` because it re-runs `build` and
has to know what survives. Nothing survives a rebuild here, because there is no
rebuild.

**A widget is kept alive by what refers to it.** A signal read by a hole keeps the
signal alive; a timer continuation or an event handler that captured `this` keeps
the widget alive; a parent that intends to call a method on a child refers to it. A
widget that no one can act on is garbage, which is the right answer and needs no
framework bookkeeping to reach. Flutter's element tree pins every `State` object
whether or not anything can reach it.

**A parent refers to a child only when it needs to.** Calling a method on a child —
`dialog.open()`, `list.scrollTo(…)` — needs a reference to the widget, because a
node handle has no such method. Within one component that reference is an ordinary
field. Across a component boundary it is a WIT resource, with handles and no shared
heap.

### Costs of building once

`build` running once is what Solid does, and it has the hazard Solid has: code that
looks as though it re-evaluates does not. Two guards are available here that are
not available in JavaScript.

A hole's type can require a tracked expression, so passing a bare value is a type
error wherever the value is expected to change. And `signal var` puts the choice at
the declaration, so a method that mutates a plain field cannot silently fail to
update the screen — the field would have to have been declared plain, which is a
visible decision at a fixed place in the class.

What remains is that a read inside a method body and a read inside a hole look the
same and are tracked differently. The tracked contexts are node blocks and explicit
effects, and nothing else.

## Template identity

A widget's interior is mostly fixed. The fixed part travels to the host once and is
named by its id afterwards; the rest arrives as hole values. Which is which is
derived from the source, and the source carries no marker.

A template belongs to a node block in the source, so there is one template per node
block and the compiler assigns its id. No two trees are ever compared at run time
to find out whether they are the same template.

### Rules for template and holes

Three rules decide, each from the source alone:

1. A `Type { … }` statement in child position is part of the template.
2. Anything else in child position is a child hole: a conditional, a `for`, a call,
   a variable holding a widget. [Control flow](#control-flow) covers the first two,
   which reify rather than becoming plain holes.
3. A property value is a hole, unless its expression has no free variable that can
   differ between two evaluations, in which case it is folded into the template.

In the `Card.build` under [Node construction](#node-construction) the whole shape
is template and there are two holes: the positional argument `this.#title` and the
computed `titleStyle(this.#accent)`. `cardStyle`, `wellStyle`, `cardPadding`,
`wellPadding`, `Align.Stretch` and `10.0` all fold, each being a module-level
`let`, an enum case or a literal.

Rule 3 is an optimisation and nothing depends on its precision. Folding less than
it could costs one hole that never changes, which is one subscription that never
fires. Folding a value that can in fact vary is the error that matters, and that is
the condition the rule tests.

Consider a card whose accent arrives as a parameter:

```zena
let cardFor = (accent: Color) => {
  let style = new BoxStyle(some(accent), none, 1.0, 12.0, 1.0);
  return Box { style: style, … };
};
```

`style` is a fresh object on every call, so rule 3 makes it a hole. One template
serves every accent, which is the outcome to want: folding `style` would need a
template per distinct colour.

### Compilation of a binding

A node block compiles to two artifacts:

- **A template** — data, sent to the host with the first render that uses it and
  named by its id every time after.
- **A build program** — guest code that runs once, constructs child widgets, sends
  the first render, and subscribes each hole's expression so that a later change
  writes that hole.

Every entry in the block appears in the template. They differ in how much of the
entry also lives in the code:

| source                      | template                     | build program                   |
| --------------------------- | ---------------------------- | ------------------------------- |
| `Box { … }`                 | a node, flex folded          | nothing                         |
| `Text 'Settings'`           | a node, content folded       | nothing                         |
| `Text this.#title`          | a node, content bound        | subscribe; write the hole        |
| `Card { title: this.#t }`   | a node of kind `Card`        | construct it; subscribe the property |
| `Slot { … }`                | a node marked as a slot      | ask for content nodes           |
| `if (…) { … } else { … }`   | a `choice` node per branch   | subscribe; write `active`       |
| `for (…) { Row { … } }`     | a slot plus the `Row` template | subscribe; resize the content   |

A property of a child *widget* is set by a typed call to that widget rather than by
writing a hole, because the host has no use for its value and neither lays it out
nor paints it. Hole indices therefore number only the holes the host can see, which
is what lets a template mark them in place and count them.

## Control flow

Control flow in a node block becomes part of the template. The author writes
ordinary `if` and `for`, and the compiler reifies both, because the host needs the
shapes a position can take in order to allocate its nodes once.

```zena
build(): Node {
  return Column {
    if (this.loading) { Spinner {} } else { Rows { items: this.items } }

    for (let item in this.items) keyed item.id { Row { label: item.name } }
  };
}
```

(`keyed` is provisional syntax; the grammar is in
[declarative.md](./declarative.md#control-flow-in-node-blocks).)

**`if` and `match` compile to a `choice` node**, with one child per branch and an
`active` hole saying which child shows. Flipping a branch is a `u32` write, and the
host keeps every branch's nodes so flipping back reshapes no text. Each branch is
its own subtree of the one template.

The alternatives have to be enumerable for this to work. A shape that is not, such
as a tree view over recursive data, compiles to a child hole instead: the guest
renders a different template into that node, at the cost of rebuilding its
interior.

**`for` compiles to a slot**, with the loop body as a template of its own. The build
program resizes the slot's content when the list length changes and renders one body
per item. [Interior and content](./zenafx-ui.md#interior-and-content) is the
protocol underneath.

Reordering is where `for` needs a decision from the author, and the compiler should
require one rather than guess. Keyed and positional differ in where state goes when
items move: keyed follows the item, positional follows the slot. Solid exposes the
same two as `<For>` and `<Index>`, and conflating them is a common source of
confusion.

Neither choice is needed for correctness of state in ZenaFX, because widget state
lives in guest objects rather than in the scene tree, and because no host-side state
lives on a node either —
[Identity and host state](./zenafx-ui.md#identity-and-host-state) has the rule that
keeps that true. Keys are an optimisation here: they keep node handles valid across
a reorder, so a long list is permuted rather than rebuilt and re-sent.

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
  build(): Template {
    return Box {
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
a slot's children *are* its content: showing a template's own children there when
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
which the runtime resolves when it solves and paints, so a mutation is visible
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
Box {
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
whose children are owned by someone else, the runtime already keeps an owner per
node, and comparing a node's owner with its parent's is the whole test. Nothing
declares itself a boundary. It holds between a parent widget and a child widget in
one component as well, since ownership is per widget — so the encapsulation
arrives without needing a component boundary.

## Selectors as data

### Why not exported predicates

Style resolution visits every node and may test a predicate against each, so
making that a call into a guest puts a boundary crossing in the innermost loop of
the frame. [Call direction](./zenafx-ui.md#call-direction-within-a-frame) forbids
synchronous guest calls on the frame path, and
[Reasons for a retained tree](./zenafx-ui.md#reasons-for-a-retained-tree) measured
what it costs when it happens anyway, at one call per layout query rather than one
per node per property.

So the guest ships a predicate and the runtime evaluates it. Generality then has
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

**State** — hovered, focused, pressed, disabled. A closed set the runtime owns,
because the runtime does hit testing.

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

1. **Signals as a library, with explicit closures.** A `Signal<T>` with
   `get`/`set`, dependency tracking, and a frame-scheduled flush that coalesces
   holes per node. Holes in `examples/zenafx/` take a closure instead of a value.
   No protocol change and no language change, and it is what makes everything below
   testable: once a hole is a subscription, the hand-written diff in the examples
   goes away.
2. **`choice` and `apply`.** The first protocol change. `choice` makes a branch
   flip a hole write, and `apply` batches a frame's writes into one call. Both are
   additive to the interface that exists.
3. **Node blocks.** A grammar and a lowering that build the same flat node list the
   convenience functions build, retiring `box`, `slot`, `text` and `flexOf`. The
   grammar is a language feature rather than a ZenaFX one, so it lands in
   [declarative.md](./declarative.md)'s terms and ZenaFX is its first consumer.
4. **Control flow and hole lifting in a node block.** Needs step 3's grammar and
   steps 1 and 2's runtime. This is where
   [Rules for template and holes](#rules-for-template-and-holes) is implemented,
   and where `if` and `for` become template structure. Rule 3 is the only analysis;
   the other two are read off the syntax.
5. **`signal var`.** Sugar over step 1, and the last thing needed before a widget
   reads the way this document shows.
6. **Input routing, with registration as data.** Hit test, the scene path, `listen`
   with a scope, one exported entry point per component. Unblocks a container
   hearing its children, the `state` facts, and every interactive widget. The
   largest single piece.
7. **Rules.** Inheritance is designed; rules need the attachment op and the subtree
   scoping, and can ship with `is-kind` and `from` only.
8. **The rest of the predicate algebra**, which needs step 6.

Steps 1 and 2 are the ones worth doing first, because they settle how an update
reaches the host before any syntax is committed to.

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

**Whether an author can see what folded.** Rules 1 and 2 are visible in the
source, and rule 3 is not: two properties that look alike can land on opposite
sides of the template boundary, and the consequence is a performance difference
with no syntax to point at. A compiler report naming what folded at each node
block, in the way an inlining report does, would make it inspectable without
putting a marker in the language. Nobody has written one, and whether the problem
bites in practice is unknown.

**Whether a slot needs marking beyond its index.** A node the compiler only ever
targets with `content` needs no marker, but a marker makes "you put content in a
node that has template children" a diagnosable error rather than a silent
overwrite.

**What a tracked context looks like in the source.** A read of a `signal var`
inside a hole is subscribed and the same text inside a method body is not. The
tracked contexts are node blocks and explicit effects, so the rule is short, but
nothing at the read marks which one it is in. Whether that needs syntax is
unknown until someone writes enough widgets to be caught by it.

**Where the frame flush is driven from.** Signals mark holes dirty and
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
  [Identity and host state](./zenafx-ui.md#identity-and-host-state),
  [Reactive state](./zenafx-ui.md#reactive-state) and
  [Events](./zenafx-ui.md#events-input-and-what-a-widget-reports).
- [declarative.md](./declarative.md) — the node-block grammar, template files and
  control-flow mapping.
- [record-presence.md](./record-presence.md) — presence-optional fields, which is
  how node properties default.
- [pattern-matching.md](./pattern-matching.md) — the pattern syntax selectors
  would restrict.
