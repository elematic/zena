# ZenaFX Widget Authoring

## Status

Exploration. Nothing here is built. The working prototype is
`examples/zenafx/widgets/`, which builds node trees by hand through convenience
functions, and this document is about replacing that surface.

It covers the Zena side: how a node is written, how the static and dynamic parts
of a tree are separated, how children reach the widget that places them, how a
subtree appears twice, how a handler is attached, and how a subtree is styled.
The protocol it lowers to is in [zenafx-ui.md](./zenafx-ui.md) — templates and
bindings under
[Widgets, templates and bindings](./zenafx-ui.md#widgets-templates-and-bindings),
dispatch under [Events](./zenafx-ui.md#events-input-and-what-a-widget-reports).
Where the two documents would say the same thing, this one links.

## Which tree, and what a widget owns

Several trees are in play and they are not interchangeable.

**The widget tree** lives in the guest's heap: widget instances holding private
state. The runtime has no representation of it.

**The template** is a widget's interior, declared once, with a marked place for
every value that varies. It is a compile-time artifact of a node block.

**The scene graph** is what the runtime retains: nodes carrying a layout and a
kind-specific content, each with an id, produced by instantiating templates.
Every node also records the widget that owns it, which is what makes input
routable — a hit test turns a position into a node, and the node has to say who
to tell.

**The layout result** is per frame and per placement, kept parallel to the
flattened order rather than on the node. **The display list** is per frame.

### A widget owns its interior, not its children

That is the sentence the rest of this follows from. A widget declares its
interior and a slot in it; what fills the slot belongs to whoever supplied it,
and the host does the projection. A widget cannot read, name, count or hold its
children, because it is never given them.

Whether children should stay fully opaque is open — a widget that needs to
introspect them is plausible and nothing here forecloses it. The property worth
keeping is the ownership one.

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
[The retained scene](./zenafx-ui.md#the-retained-scene) mutates values in place,
where expansion would re-derive a subtree to find out what changed.

Expansion is also what
[What the widget prototype found](./zenafx-ui.md#what-the-widget-prototype-found)
measured: obtaining a component's subtree means calling into it, so expanding a
tree of _n_ components costs _n_ crossings per render.

Within one component the distinction is weaker. A local child's result is
collected into its parent's first send, because reaching it is an ordinary call —
but it still owns its bindings afterwards, so it is a reference there too.

## Node construction

`examples/zenafx/widgets/card.zena` builds its tree like this:

```zena
box({look: cardLook, align: Align.Stretch, gap: 10.0, padding: cardPadding}, [
  text(this.#title, titleLook),
  slot({look: wellLook, padding: wellPadding}),
])
```

`box`, `slot` and `text` exist because a constructor call is positional and
unmemorable, and because a `Box` needs all nine fields of a `flex` when a call
site cares about two. Every new node kind would want its own such function, each
a second name for a type that already has one.

The node-block grammar [declarative.md](./declarative.md) proposes removes both
reasons. Properties are named, so defaulting is ordinary record behaviour, and
the type name is the statement:

```zena
Box {
  look: cardLook,
  align: Align.Stretch,
  gap: 10.0,
  padding: cardPadding,

  Text 'Settings' { look: titleLook }
  Slot { look: wellLook, padding: wellPadding }
}
```

Properties and children share one brace: an entry of the form `key: value,` is a
property, and a statement of the form `Type { … }` is a child. A positional
argument carries what markup gets from text content, which matters because text
is the commonest leaf.

### No sigil

declarative.md proposes `<@Card>` to distinguish a component reference from an
element name, replacing JSX's capitalisation rule. That distinction is needed
where tag names can be _strings_ — `<div>` means `'div'` and `<Card>` means the
identifier `Card`, and the syntax has to know which to emit.

A node block has no string tag names. `Box` and `Card` are both identifiers in
scope, and which is a built-in kind and which a widget is known from their types.
There is nothing to disambiguate, so the sigil buys nothing here. It belongs in
the markup form, where tags genuinely can be strings.

### Markup

declarative.md keeps markup as 1:1 sugar over node blocks. It earns its place
where prose and structure interleave, because `<p>Hello <b>there</b></p>` is
unreadable as nested blocks. A UI of boxes has no prose between the boxes, so the
recommendation is node blocks for ZenaFX and markup for `.zhtml` and `.zmd`.

### `new`

In node-block position `new` does not appear: the statement's type name is the
constructor. For expression position the recommendation is to make it optional
rather than remove it. A class name in call position can only mean construction,
so `Card('First', plum)` is unambiguous, and the keyword is noise in a
declarative tree. What it buys is a reading cue — Zena has case classes with
value equality and ordinary classes with reference identity, and `new` marks the
second — so making it optional keeps the cue available to code that wants it.

## Static and dynamic

A widget's interior is mostly constant. What varies is marked, and marking is
explicit:

```zena
Box {
  look: cardLook,                      // program-lifetime: in the template
  gap: 10.0,                           // literal: in the template
  Text ${this.#title} {                // binding 0
    look: ${titleLook(this.#accent)}   // binding 1
  }
}
```

Which reads as a template literal does: what you see is the structure, and `${}`
is where values enter.

### Why it is marked and not inferred

Inferring the split — bake what is constant, bind what is not — is unsound,
because immutable is not static:

```zena
let cardFor = (accent: Color) => {
  let look = new BoxLook(some(accent), none, 1.0, 12.0, 1.0);  // immutable
  return Box { look: look, … };
};
```

`look` is an immutable `let` and a fresh object per call. Inference that treated
an immutable binding as static would bake the first one into the template and
every later card would be wrong, silently. Zena has no `const` and no comptime,
so there is nothing for the analysis to stand on.

### What "static" means

Not compile-time constant, because template registration is a runtime call. It
means **fixed for the template's lifetime** — one registration per widget class
per program — so a module-level `let cardLook = new BoxLook(…)` qualifies even
though it is a heap object built at module init, and anything reached through
`this`, a parameter or a closure capture does not.

That makes it **checkable** rather than inferred: an unmarked value must be
program-lifetime, and the compiler rejects one that is not with "this varies per
instance — wrap it in `${}`".

### What a binding compiles to

A node block compiles to two artifacts, and keeping them apart explains the rest:

- **A template** — data, registered with the host once per program.
- **A build program** — guest code that constructs child widgets, assembles the
  first render, and on update re-evaluates the binding expressions and routes
  each change.

Every entry in the block appears in the template; they differ in how much lives
in the code.

| source                 | template                | build program                  |
| ---------------------- | ----------------------- | ------------------------------ |
| `Box { … }`            | a node, flex given      | nothing                        |
| `Text 'Settings'`      | a node, content given   | nothing                        |
| `Text ${this.#title}`  | a node, content bound   | compute it, write the binding  |
| `Card { title: ${t} }` | a node of kind `Card`   | construct it; set the property |
| `Slot { … }`           | a node marked as a slot | assign content to it           |

The build program holds every binding's last value and does one diff, with two
kinds of action — an op to the host, or a call to a child widget:

```zena
// generated
update(): void {
  let v0 = this.#gap;
  let v1 = this.#title;
  let v2 = this.#name;

  var ops = [];
  if (v0 != this.#lastGap)   { ops.push(setBinding(this.#base, 0, v0)); }
  if (v1 != this.#lastTitle) { ops.push(setBinding(this.#base, 1, v1)); }
  if (ops.length > 0) { this.#viewport.apply(ops); }

  if (v2 != this.#lastName) { this.#card.setTitle(v2); }   // a call, not an op

  this.#lastGap = v0; this.#lastTitle = v1; this.#lastName = v2;
}
```

So the uniformity is at the surface and in the diff loop, and not on the wire. A
widget property is set by a typed call to the widget that owns it, because the
host has no use for its value — it does not lay it out or paint it. Binding
indices therefore number only the bindings the host can see, which is what lets
the template mark them in place and count them.

## Children and slots

`expand(widget, children)` is what the prototype does today: a widget builds a
tree with a `Slot` in it and the framework walks for the slot and pushes children
into it. The property worth keeping is that the widget never receives them; the
cost is an API nobody expects, with a constructor for inputs and a second
function for content.

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
  build(): Box {
    return Box {
      look: cardLook, align: Align.Stretch, gap: 10.0, padding: cardPadding,

      Text ${this.#title} { look: titleLook }
      Slot { look: wellLook, padding: wellPadding }
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

So `assign-content` names the child and a slot index, never a slot node. Slot
fallback content is free: a slot node's own children in the template are what is
shown when nothing is assigned.

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
the node: `SceneNode` holds a shaped text run, and `measure_run` re-breaks when
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
  look: buttonLook,
  onPress: () => this.#press(),

  Text ${this.#label} { look: labelLook }
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
[What the widget prototype found](./zenafx-ui.md#what-the-widget-prototype-found)
measured what it costs when it happens anyway — and that was one call per layout
query, not one per node per property.

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

1. **Slots without a children value.** Remove `expand`; a widget declares a slot
   and nothing else. Needs no protocol change in the current prototype, because
   everything is one component and one tree today. Smallest change with the
   largest effect on how the prototype reads.
2. **Node blocks.** A grammar and a lowering, with no protocol change: a node
   block can build the same flat node list the convenience functions build. Also
   retires `box`, `slot` and `text`.
3. **Templates and bindings.** The first protocol change, and what gives a node a
   template id to match on later.
4. **Input routing, with registration as data.** Hit test, the scene path,
   `listen` with a scope, one exported entry point per component. Unblocks a
   container hearing its children, the `state` facts, and every interactive
   widget. The largest single piece.
5. **Rules.** Inheritance is designed; rules need the attachment op and the
   subtree scoping, and can ship with `is-kind` and `from` only.
6. **The rest of the predicate algebra**, which needs step 4.

Steps 1 and 2 need no protocol change, which is why they come first: they improve
how the prototype reads without committing the interface to anything.

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

**Whether a slot needs marking beyond its index.** A node authored with no
children that the compiler only ever targets with `assign-content` needs no
marker, but a marker makes "you assigned content to a node with template children"
a diagnosable error rather than a silent overwrite.

**Specificity.** Source order within a rule set is predictable and CSS's scoring
is widely held to be a mistake. What remains is the order between rule sets
attached at different depths, where the reasonable default is that a nearer
attachment wins.

## Related

- [zenafx-ui.md](./zenafx-ui.md) — the runtime design this lowers to, in
  particular
  [Widgets, templates and bindings](./zenafx-ui.md#widgets-templates-and-bindings),
  [Events](./zenafx-ui.md#events-input-and-what-a-widget-reports),
  [Children and slots](./zenafx-ui.md#children-and-slots) and
  [The retained scene](./zenafx-ui.md#the-retained-scene).
- [declarative.md](./declarative.md) — the node-block grammar, template files and
  control-flow mapping.
- [record-presence.md](./record-presence.md) — presence-optional fields, which is
  how node properties default.
- [pattern-matching.md](./pattern-matching.md) — the pattern syntax selectors
  would restrict.
