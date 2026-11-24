# ZenaFX Styles: Properties, Facts, Conditions and Rules

## Status

Proposal. None of it is built, except the list of state styles described under
[Styles today](#styles-today), which this would replace.

It asks for nine decisions:

1. A property is declared: a key, a type and whether it inherits. The built-in
   properties are declarations of the same form as an application's own. A
   property has one definition, made with its key, so two definitions cannot
   conflict. See [Properties](#properties).
2. A fact is a flag or a number on a node that the host or a component writes
   and a condition tests. See [Facts](#facts).
3. The key of a property or a fact is a symbol: only code that holds it can
   set, read or test it. Between components it is shared by handing over a
   handle, and never by a name. See [Keys](#keys).
4. A rule is a condition and a set of declarations. Rules are attached to a
   node, and apply to that node alone or to it and the nodes beneath it that
   the same widget placed. They never reach into another widget's interior.
   See [Rules](#rules).
5. The host evaluates conditions, and there is no separate selector language.
   The part of a condition that a template fixes is evaluated once for each
   template. See [Conditions](#conditions) and
   [One condition, tested in two stages](#one-condition-tested-in-two-stages).
6. Inheritance is decided for each property by its declaration. A theme is a
   set of inheriting properties. See [Inheritance](#inheritance).
7. A component can watch a condition and be told when it starts or stops
   holding. See [Condition watchers](#condition-watchers).
8. The host has no variables, imports, functions or expressions. A constant is
   imported in the guest language and sent as a value, and a function is a
   function of that language. A property is only for a value that depends on
   where a node is in the tree. See
   [What is left to the language](#what-is-left-to-the-language).
9. Styling and layout are extended with WebAssembly. Code that has to run
   during a frame is a component of its own that the host runs on the window's
   thread, and a declaration's value can be a call to a function it exports.
   See [Window components](#window-components).

[Layout extension](#layout-extension) says how a custom layout algorithm would
fit the same constraints. It is a direction and not yet a design.

## Overview

A ZenaFX window has two programs in it. The **host** is the Rust process: it
holds the tree of nodes, lays it out, paints it and reads input. A
**component** is the application, a WebAssembly component that describes the
tree and writes values into it through the interface in
`packages/zenafx/wit/zenafx.wit`. The two run on different threads, and a call
from one to the other copies its arguments.

A button that changes colour under the pointer is styled by a condition: this
fill while the pointer is over the button, that one otherwise. So is a layout
that has two columns in a wide window and one in a narrow window, and a header
that gains a shadow once the page has scrolled. CSS expresses all three with
selectors, pseudo-classes and media or container queries.

Three constraints shape the answer here.

- **A resize, a scroll, a hover and an animation frame must not call the
  component.** Each can happen sixty or more times a second, and the window's
  thread does not wait for a component.
- **The host stays small.** A feature belongs in the host when it cannot work
  anywhere else.
- **Built-in behaviour and an application's own behaviour use one mechanism.**
  The host's `hovered` should be the same kind of thing as an application's
  `selected`, and the host's `background` the same kind of thing as a theme's
  `accent`.

The proposal has four parts. A **property** is a declared value a node has,
such as a background or a theme's accent colour. A **fact** is something true
of a node, such as being hovered, being 600 wide or being tagged as a title. A
**condition** tests facts. A **rule** is a condition and the property values
to use where it holds.

The host evaluates all of it, and divides the work by when a fact can change.
A node's tags and its place in a template are fixed when the template is
built, so the part of a condition that tests them is evaluated once for each
template. Hover, focus, sizes and scroll positions change with no component
involved, so the rest is tested by the host as they change.

## Terms

- **Node**: one box or one run of text in the tree the host holds.
- **Template**: the description of a widget's nodes, shared by every instance
  of that widget. A component sends a template once.
- **Hole**: a place in a template that is filled in for each instance and can
  be filled in again later. A child hole takes nodes and a property hole takes
  a value for a node the template has. [Holes](#holes) says how each reaches
  the host.
- **Interior**: the nodes a widget's templates put beneath its own node.
- **Content**: nodes in a slot of a widget's interior, which another widget
  supplied.
- **Property**: a declared value a node has. It has a key and a type, and it
  inherits or does not.
- **Declaration**: a property and a value for it, such as a background of
  blue. CSS uses the word this way. A property's own declaration is called
  its **definition** here, to keep the two apart.
- **Fact**: a flag or a number on a node, written by the host or by a
  component, which a condition tests.
- **Key**: the identity of a property or a fact.
- **Condition**: a test of facts that is true or false for a node.
- **Rule**: a condition and the declarations to apply where it holds.
- **Scope**: the nodes a set of rules can apply to.

"Declaration" and "rule" are CSS's words, used because a reader is likely to
know them. Better names are an open question.

## Styles today

Every style is written on the node it applies to, which is what CSS calls an
inline style. A node of a template carries a `flex` record with its eleven
layout fields, and a `box-style` or `text-style` record with its look. A hole
can replace a whole record for one instance. A node also names its cursor, in
a `cursor` field that no hole writes.

A template also has a `states` list, which is the only conditional style:

```wit
enum state { hovered, pressed, focused }

record state-style {
  node: u32,      // the node that changes
  when: state,
  of: u32,        // the node whose state is read
  style: restyle, // a whole box-style or text-style
}
```

The host applies the list when it draws. `examples/zenafx/button/` uses it for
a hovered and a pressed fill, and [State styles](./zenafx-ui.md#state-styles)
gives the reasons the host resolves it.

Four limits of this are what the rest of the document removes.

- A look replaces the whole record. When a node is hovered and pressed, the
  later entry wins everything, and a hovered fill cannot combine with a
  pressed border.
- The states are a closed `enum`. An application cannot add `selected`.
- A condition is one state of one node. It cannot test a size.
- Every text node carries its whole text style. Nothing is taken from the node
  above, so there is no way to say that everything in a panel is in one colour.

## Properties

A property is a value a node has: its background, its width, the size of its
text, the cursor shown over it. A style is a set of values for properties.

Every property has a definition, which says the type of its values and
whether it inherits. Making a property gives it a key, which is how everything
else refers to it.

```wit
/// What kind of value a property holds.
enum value-type { flag, number, length, color, keyword, text }

record property-def {
  %type: value-type,
  /// Whether a node that is given no value takes the value of the node
  /// above it.
  inherits: bool,
}
```

The built-in properties are definitions of this form, fixed by the interface.
Two things set them apart. The host does something with their values: it
paints a `background` and lays out a `width`. And each has an initial value,
because the host needs a value for every node it lays out and paints. A few of
them:

| Property        | Type    | Inherits | Initial     | A change costs |
| --------------- | ------- | -------- | ----------- | -------------- |
| `background`    | color   | no       | transparent | a paint        |
| `corner-radius` | number  | no       | 0           | a paint        |
| `width`         | length  | no       | auto        | a layout       |
| `gap`           | number  | no       | 0           | a layout       |
| `text-color`    | color   | yes      | black       | a paint        |
| `text-size`     | number  | yes      | 16          | a layout       |
| `cursor`        | keyword | yes      | `default`   | nothing        |

The whole table belongs in the interface's reference, and it is the same
table an application's package would publish for its own properties.

An application defines properties of its own in the same way: a theme's
`accent`, a toolkit's unit of spacing, a button's `tone`. The host stores and
inherits their values and does nothing else with them. They matter because a
declaration can use one as its value, as [Declarations](#declarations) shows.

A definition is needed, and a bare key is not enough, for two reasons. The
host has to know whether the property inherits. And it has to know the type,
to store the value and to check a declaration that uses it.

### How a node gets a value

Defining a property puts nothing on any node. A node holds only the values
that declarations give it, and a property's value for a node is looked up when
something reads it. The first of these that exists is the value:

1. an ordinary declaration on the node, from the rules that apply to it
2. for a property that inherits, an ordinary declaration on the nearest node
   above that has one
3. a default declaration on the node
4. for a property that inherits, a default declaration on the nearest node
   above that has one
5. for a built-in property, its initial value

One of an application's properties that none of the first four gives a value
has no value. A declaration that uses it does not apply, and a condition that
tests it does not hold.

**What reads a value.** The host reads the built-in properties of every node,
to lay it out and paint it, as it reads a node's `flex` record today. One of
an application's properties is read in three places only: a declaration that
applies to a node and uses it as its value, a condition that tests it, and a
component that asks for it. So a theme with fifty properties costs nothing on
a node that uses none of them. The work is in proportion to the declarations
that set a property and the places that use it, and not to the number of
nodes times the number of properties. [What the host keeps](#what-the-host-keeps)
has the tables that make it so.

### Defaults

A widget often wants a value of its own that anything above it can replace: a
button is blue unless the application has a theme. An ordinary declaration on
the button's node cannot say that, because it wins over whatever is above. So
a declaration can be marked as a default, as Sass marks a variable with
`!default`.

```
accent: blue (default)              on a button's own node
background: use(accent)
```

A default gives way to any ordinary declaration of the property, on the node
or, for a property that inherits, on any node above it, however far. With no
theme the button is blue. An application that declares `accent` on its root
makes the button the theme's colour. Among defaults the nearest wins, so a
button inside a card that has a default `accent` of its own keeps the
button's.

This is the default a class gives a field. It belongs to the widget, two
widgets give the same property different ones, and the widget's parent or
anything above can still say otherwise.

CSS has no such priority. A declaration on an element always wins over an
inherited value, so a stylesheet puts the fallback at each use, as
`var(--accent, blue)`, or reads the value from above with `inherit()` and
declares it again. [Alternatives considered](#alternatives-considered) says
why a priority is proposed in place of those.

A default can be another property's value. A button whose template declares
`button-fill: use(accent)` as a default and `background: use(button-fill)`
takes the theme's accent, and a theme that declares `button-fill` colours
buttons and nothing else.

### Initial values

A built-in property has an initial value, fixed by the interface: no
background, a size taken from the content, black text. It is what a node has
when no declaration, ordinary or default, is found on it or above it. It is
set on no node.

One of an application's properties has none. Its definition says what it is
and nothing about what value it has, and a node is responsible for its own
defaults. There are two reasons.

- The widget that uses a property is the one that knows what it should look
  like when nobody has said. Two widgets can want different fallbacks for the
  same property, and a value in the definition would be a second place to
  look for a default, after the node's own.
- Nothing is lost. A theme package still says what `accent` is when nobody
  sets it: its property carries that value in source, and a widget that
  mentions the property declares it as a default on its own node. The
  declaration is part of the widget's template, so it is sent once and shared
  by every instance.

### Where definitions live

A definition is not a rule, and it is not attached to a node. A rule gives
nodes values for a property. A definition says what the property is, which
does not depend on where in the tree it is used.

**In source, a property is a value that a library makes and exports**, as it
exports a function or a class. The key and the definition are made together,
so there is no key without a definition.

```zena
// In the package acme:theme.
export let accent = property<Color>({inherits: true, default: blue});

// In a widget library that uses the theme.
import { accent } from 'acme:theme';

// Private to this library, because it is not exported.
let tone = property<Color>({inherits: true, default: use(accent)});
```

This is a sketch, and the Zena surface is not designed. What it shows is where
things are. One generic `property` serves every type of value. No name is
written: a property is known by the variable that holds it. Whatever mentions
a property imports it: a declaration that sets it, a declaration that uses it
as a value, a default, a condition that tests it. That is what a key being a
symbol comes to in source. It also lets the compiler check a declaration,
since the imported value carries the property's type.

- **A built-in property** is defined in the interface. Zena code imports it
  from the library that binds the interface, as it imports `accent` from a
  theme.
- **A property of one component** is made by a library compiled into it. If
  the library does not export it, only that library's rules can mention it. If
  it does, any library compiled into the same component can import it.
- **A property shared between components** is made by one component, which
  gives the others a handle to it.

**On the wire**, each component tells the host which properties and facts it
mentions, once, before its first template.

```wit
/// A key, as something one component can hand to another.
resource key-handle {
  /// Another handle to the same key.
  clone: func() -> key-handle;
}

variant property-source {
  /// A property this component makes.
  make(property-def),
  /// A property another component made, by a handle it gave.
  given(key-handle),
}

/// The properties and facts this component mentions. A key `own(n)` is the
/// n-th entry afterwards, counting properties first.
declare: func(properties: list<property-source>, facts: list<fact-source>);

/// A handle to one of this component's keys, to give to another component.
handle: func(own: u32) -> key-handle;
```

`fact-source` is the same pair of cases for a fact, whose definition says only
whether it is a flag or a number.

A property has one definition: the `make` that created it. The host gives it a
key no other property has, so nothing can conflict with it, and no other
component can mention it until the one that made it hands out a handle. The
host keeps one table of keys for a window. A `make` adds an entry and a
`given` finds one.

**Two components share a property by importing it from the same instance of a
third.** A theme package that other components share is built as a component.
When it starts it makes its properties, and its interface has a function for
each that returns a handle:

```wit
package acme:theme;

interface tokens {
  use zenafx:host/style.{key-handle};

  accent: func() -> key-handle;
  surface: func() -> key-handle;
}
```

An application and a widget component that both import `acme:theme/tokens`,
and are given the same instance of it, get handles to the same keys, and each
passes them to `declare` as `given`. No text names a property anywhere. The
theme's Zena library wraps the import, so source still reads
`import { accent } from 'acme:theme'` and `accent` still carries its type.

Three things follow.

- **Whoever links decides who shares.** A component given the same instance
  of the theme as its parent takes the parent's theme. One given an instance
  of its own is untouched by it. Two versions of a theme package in one window
  are two instances and two sets of properties, with no rule needed to choose
  between their definitions.
- **A key is known only to those it was handed to.** A list and its rows can
  share `selected` without any other component being able to mention it.
- **A copy does not share.** Two components that each compile the theme's
  source in, and do not import it, each make properties of their own. Sharing
  is decided when components are linked, and does not follow from using the
  same source.

A handle is a resource the host defines, so passing one from one component to
another is what [runtime-components.md](./runtime-components.md) already
describes for resources. What that document has not designed is the linking:
an import that a component satisfies at run time, which it calls an imported
component. Sharing a property between components waits on that. A window runs
one component today, where a property is a variable and none of this is
needed.

The same export is what gets documented. A package's reference lists the
properties it defines beside its functions and classes, with the type, the
default and whether it inherits, as the table above does for the built-in
ones.

### Declarations

A declaration gives a property a value.

```wit
variant value {
  flag(bool),
  number(f32),
  length(length),
  color(color),
  /// One of the keywords the property's definition lists, by position.
  keyword(u32),
  text(string),
  /// The value this node has for another property of the same type.
  use(key),
  /// The value this node has for a fact of the same type.
  fact(key),
}

record declaration {
  property: key,
  value: value,
  /// Whether this gives way to any ordinary declaration of the property, on
  /// the node or above it.
  default: bool,
}
```

One record serves the built-in properties and an application's own. A button
that takes its fill from a theme declares `background` as `use(accent)`, and
its `background` is then whatever `accent` is at that node.

A declaration is checked when it reaches the host: the property must be
defined, and the value must have its type. Two declarations that use each
other's properties have no value to settle on, and neither applies.

Layout properties are declarations too. `flex` has eleven fields, which come to
sixteen values once its records and variants are flattened. That is the most
the canonical ABI passes without spilling to memory, so grid tracks, margins
or size limits would take it past that. A list holding only what differs from
the initial values is smaller for most nodes and has room to grow.

### Inheritance

A property inherits or it does not, and its definition says which. A node that
no rule gives a value for an inheriting property has the value of the node
above it. [How a node gets a value](#how-a-node-gets-a-value) has the whole
order.

Among the built-in properties, the ones that inherit are the text properties
(colour, size, family, weight and italic), `cursor` and `user-select`. A
background does not: a card's background is not its children's.

The node above is the parent in the host's tree. Content placed in a slot is
beneath the node that holds the slot, so a label placed in a button takes the
button's text colour, and neither widget knows about the other. Inheritance
crosses from one widget to the next and from one component to the next, which
a rule does not.

Sparse declarations need this as soon as they exist. Today every text node
carries a whole `text-style` with all five fields. Once a text node's style is
only what differs from the initial values, a text node that says nothing about
its size needs a size from somewhere, and the node above is the useful place.

**A theme is a set of inheriting properties.** A theme package defines
`surface`, `ink` and `accent` as colours that inherit, with defaults that are
its default look. An application gives them other values at its
root, and a widget uses them without knowing what they are:

```
surface: #16181d, ink: #e8eaf0       on the root, when flag(dark)

background: use(accent)              in a button's template
```

Three things follow from the values being in the host.

- **Switching theme calls no widget.** `dark` is a fact the application sets
  on its root, so a switch is one hole write there. The host works out the
  styles that use the changed properties again and draws a frame. A host fact
  for the system's light or dark setting would make a switch that follows the
  system no call at all.
- **A part of a window can have its own theme.** A dark sidebar in a light
  window declares the properties again on its own root, and everything in it
  follows.
- **A template stays shared.** A widget's template is sent once and used by
  every instance. If a widget read the theme and sent the colours themselves,
  two instances under different themes would need two templates.

**What a change costs.** The host works out a node's values from the rules
that apply to it, the properties those use and what it inherits, and keeps the
result. A built-in property's definition says what a change to it needs: a
layout, a paint, or nothing, as the table shows. A change to one of an
application's own properties needs nothing by itself, and costs what the
declarations that use it cost. When an inheriting property changes on a node,
the nodes beneath it that use the property and take its value from that node
are worked out again. A
theme switch at the root is one pass over the tree, a frame, and a layout if a
size changed. That is coarse, and a theme switch is rare enough for it.

### One mechanism for values that go down the tree

An inheriting property is not only for styles. It is a value that a node
gives to everything beneath it, which is what React calls context, and
[Context](./zenafx-ui.md#context-values-that-inherit-down-the-tree) designs
the same thing for a locale, a text direction and a density setting, with
`provide` and `inherited`. The two are one mechanism, and this document's
properties are its definition: a key, a type, and a value found at the
nearest node above that gives one.

- **It is given** by a declaration. A rule can give it under a condition, and
  a component gives it for one instance through a hole, which is what
  `provide` is.
- **It is read** in three ways. A declaration reads it with `use`, which costs
  no call. A condition tests it. A component's own code reads it by watching
  it, as it watches a condition, and hears when the value at its node changes:
  a chart that draws with the theme's colour, a label that formats a date for
  the locale.

What it carries is a value of one of the property types. Something richer,
such as a service or a document model, is given to a component when it is
linked, as Context already says.

This is dynamic scoping: what `accent` is at a node depends on where the node
is at run time, and not on anything in the source around the declaration that
reads it. Programming languages gave that up for good reasons, and three
things keep those reasons from applying here.

- Nothing is dynamic unless it says so. A value is read from the tree only by
  `use`, a condition or a watcher, each naming a key. Everything else in a
  style is an ordinary value of the guest language.
- A key is a symbol, so a node between a provider and a reader cannot give
  the property a new value by accident. It has to hold the key.
- A property has a type, so a reader gets a value of the kind it expects from
  wherever it comes.

### The cursor and text selection

Two built-in properties paint nothing.

**`cursor`** names the cursor to show while the pointer is over the node, with
one of CSS's `cursor` keywords. Today it is a field of `node-def`, beside
`layout` and `appearance`. A field cannot carry a condition and no hole writes
it, so a cursor that changes with state takes a new render. As a property it
has both. Something that can be dragged has two rules:

```
cursor: grab
cursor: grabbing      when flag(pressed)
```

The host changes the cursor when the button goes down, and no component code
runs. With pointer capture the node stays the one the pointer is over, so
`grabbing` shows for the whole of a drag.

`cursor` inherits, and the host needs its value only for the node the pointer
is over. So it walks up from that node when the node changes or a fact on the
path does, and copies nothing down the tree. A change of cursor draws no
frame, because the platform draws the cursor.

**`user-select`** says whether the pointer can select the text of a node, with
CSS's values `text` and `none`. It inherits, so a button leaves its label out
with one declaration on its own box. Today it is the `unselectable` field of
`node-def`.

Two other fields of `node-def` stay fields. `focusable` says that a node can
have the keyboard focus. `editable` says that a person edits a text node's
content. They say what a node does and not
how it looks, as `tabindex` and `contenteditable` are attributes in HTML and
not properties in CSS. [Open questions](#open-questions) asks whether a
condition should be able to turn them off.

## Facts

A fact is a flag or a number on a node. Conditions test facts, and that is
all a fact is for.

| Fact              | Example                             | Value  | Written by | Changes                  |
| ----------------- | ----------------------------------- | ------ | ---------- | ------------------------ |
| Tag               | `card`, `title`                     | flag   | component  | when the tree is written |
| Kind              | text, box                           | flag   | host       | when the tree is written |
| State             | `hovered`, `focused`                | flag   | host       | on interaction           |
| Application state | `selected`, `invalid`               | flag   | component  | when a hole is written   |
| Measured quantity | a node's width, how far it scrolled | number | host       | on a resize or a scroll  |

The host writes the facts that only it knows.

```wit
/// The facts the host writes.
enum host-fact {
  /// The node draws text, or is a box.
  text,
  box,
  hovered,
  pressed,
  focused,
  /// The node's own size, once layout has run.
  width,
  height,
  /// How far the node has scrolled, and how far it can.
  scroll-x,
  scroll-y,
  scroll-range-x,
  scroll-range-y,
}
```

A component writes its own. A template sets a fact on one of its nodes, and
that is what a tag is: `title` on the text node that is a card's title. A hole
writes a fact that changes: `selected` on a list row is one hole write when
the selection moves, and the row's look follows in the host.

The host writes `hovered`, `pressed` and `focused` because it owns the pointer
and the focus. Nothing else about those three is special: a condition tests
them the same way it tests `selected`.

A rule never writes a fact. That is the difference between a fact and a
property, and it is CSS's difference between a class or a state and a
property. Conditions read facts and rules set properties, so no rule can
change whether a rule applies to the same node, and the host can work a
node's style out in one pass.

### Facts from a node above

A grid changes its columns with the width of the panel it is in, and the panel
is another widget's. A fact does not inherit, so the panel offers its width as
a property that does:

```
panel-width: fact(width)            on the panel
```

`panel-width` is a number property that inherits, and a condition on any node
beneath the panel can test the value that node inherits. The window's size
reaches every node the same way, from the root, and a media query is a
condition on it.

## Keys

The key of a property or a fact is a symbol. It is an identity and not a
piece of text, and code can set, read or test a property or a fact only if it
holds the key.

- **Inside a component** a key is private unless the library that made it
  exports it. A widget's tags for its own nodes are keys nothing else holds.
  A key a widget's library exports is one other widgets can use on purpose:
  a list exports `selected`, sets it on the rows it places, and a row's own
  rules test it.
- **Between components** a key is shared by handing over a handle to it. The
  component that made the key gives a handle to each component it wants to
  share it with, usually through an interface they import from it, as
  [Where definitions live](#where-definitions-live) shows for a theme. No name
  crosses, and a component that was handed nothing cannot mention the key.
- **The built-in properties and the host's facts** are keys the interface
  gives every component.

On the wire a key is a number. A component gives the host one list of the
properties and facts it mentions, as
[Where definitions live](#where-definitions-live) shows, and refers to each by
its position in the list afterwards, so the host compares numbers.

```wit
variant key {
  host(host-fact),
  builtin(builtin-property),
  /// One of the component's own, by the position it was declared at.
  own(u32),
}
```

CSS's names for classes and custom properties are text that anyone can
write, so two libraries can pick the same name without knowing, and custom
properties are given prefixes by convention to avoid it. That matters wherever
one party's key meets another party's nodes: in a property that inherits into
other widgets, and in a rule that applies to a child widget's node. A symbol
removes the problem there, and costs nothing where a rule only tests the
facts of its own widget's nodes.

A key is therefore a capability in both places. Inside a component it is a
variable that a library exports or does not. Between components it is a
handle that was given or was not.

## Conditions

A condition is a test of facts on a node, a test of the nodes above it, or a
combination of conditions.

```wit
/// True while `min <= value < max`. A missing bound is unbounded.
record range-test { key: key, min: option<f32>, max: option<f32> }

variant condition {
  /// A flag is set on the node.
  flag(key),
  /// A number on the node is in a range.
  range(range-test),
  /// The node's parent satisfies condition `n`.
  under(u32),
  /// Some node above it, inside the rule's scope, satisfies condition `n`.
  within(u32),
  /// Indexes into the template's list of conditions, which is flat for the
  /// reason its list of nodes is.
  all(list<u32>),
  any(list<u32>),
  negate(u32),
}
```

What CSS calls a selector is a condition of this kind. "Tagged `title`",
"inside a node tagged `card`" and "hovered" are all tests of facts, and one
condition can combine them. "A title inside a hovered card" is
`all(flag(title), within(all(flag(card), flag(hovered))))`.

A key in a `flag` or a `range` is a fact's key, or the key of an inheriting
property. A property is tested by the value the node inherits, before any
rule has given the node a value of its own. "While the panel above is at
least 600 wide" is `range({panel-width, min: 600, max: none})`.

So a condition reads facts, and the values of properties as they arrive from
above. It never reads a value a rule gives the node it is testing. The host
works styles out from the root down, and each node's conditions depend only on
things already settled.

`under` and `within` look at nodes inside the rule's
[scope](#where-rules-attach). Anything from outside the scope reaches a
condition through a property that inherits.

### One condition, tested in two stages

A rule applies to every node in its scope for which its condition holds. No
node is tested against every rule each time something changes, because facts
differ in when they can change.

A fact a template sets with no hole is fixed for that template, and so are a
node's kind and its place among the template's nodes. A state, a size, a
scroll position and a fact written by a hole change afterwards. So the host
evaluates a condition in two stages.

1. When a template arrives, the host evaluates the part of each condition that
   reads only fixed facts, against each node of the template in the rule's
   scope. The answer is the list of nodes the rule can apply to. The host
   finds candidates through a table from a flag to the rules that require it,
   so a node is tested against the rules that name one of its tags.
2. What is left stays as a condition on those nodes, which the host tests when
   a fact it reads changes.

The first stage runs once for each template, whatever the number of instances
on screen, and nothing is evaluated again for it when the pointer moves or the
window changes size. The condition evaluator is the only matcher there is: a
component in any language sends conditions, and no language needs a library
that matches selectors.

### Evaluation

For the second stage the host keeps, for each condition, whether it holds for
each node it is used on. Two indexes keep that cheap.

- **Flags.** A table from a flag's key to the conditions that test it. When a
  flag changes on a node, the host evaluates those conditions again for that
  node and for the nodes whose conditions read it through `under` or `within`.
- **Numbers.** The bounds that conditions give for one key on one node, sorted,
  divide the number line into intervals. The host remembers which interval the
  current value is in. A new value is compared with that interval's two ends,
  and no condition is evaluated unless it has left the interval.

A window dragged from 801 to 802 pixels wide therefore costs two comparisons
for each width that has conditions on it. This is the property that makes a
size condition usable during a resize.

### Facts that depend on layout

A node's size is known after layout, and a declaration can change layout. A
rule that makes a node narrower while it is wide would never settle.

CSS avoids this with containment: an element whose size is queried must have a
size that does not depend on its content, and the query can style only what is
inside it. The same two rules apply here.

- A declaration can take its value from `width` or `height` only on a node
  that layout gives that size without looking at its content: a fixed or
  proportional size, or the room a parent gives it.
- A condition tests a size through such a property, as the node inherits it.
  So it applies to nodes beneath the one that was measured.

With those rules a frame lays out the tree, compares the measured sizes with
their intervals, and lays out again only if one moved to another interval. The
second layout cannot change a measured size, so there is no third.

`hovered` also depends on layout, since the node under the pointer is found
from the rectangles. The host already handles that case: it tests the pointer
again after each layout and draws one more frame when the answer changed.

## Rules

A rule is a condition and a set of declarations. The declarations apply to a
node while the condition holds for it.

```wit
record rule {
  /// An index into the template's conditions. Applies always when missing.
  when: option<u32>,
  then: list<declaration>,
}
```

The rule is the unit, as it is in CSS. A hovered button changes its fill, its
border and its label's colour together, and that is one condition written
once with the declarations under it.

### Where rules attach

Rules are attached to a node, with one of two reaches. They are the two CSS
has, an inline style and a stylesheet in a scope.

```wit
enum reach {
  /// The node the rules are attached to, and no other.
  node,
  /// That node, and the nodes beneath it that the same widget placed.
  scope,
}

record rule-set {
  reach: reach,
  rules: list<rule>,
}

record node-def {
  // ... its layout, its appearance and the rest
  /// The rules attached to this node.
  rules: list<rule-set>,
}
```

A node carries its rules as it carries its layout. `node-def` is the
description of one node in a template, so a rule set is written there, on the
node it is attached to.

**Which nodes a widget placed.** A widget places the nodes of its own
templates. It also places the node of each child widget it uses, whether it
puts the child in a slot of its own or hands it to another widget as content.
It does not place what is inside a child: that is the child's interior, and
the child placed it.

So rules a page attaches to its own node, with the reach `scope`, apply to the
page's boxes and text, to the node of a card the page uses, and to the node of
a label the page put in that card. They do not apply to the title the card
draws for itself. A scope never reaches into a widget's interior from outside.
This is where shadow DOM draws the line: a stylesheet applies to the elements
of its own tree, the host elements of the components in it included, and to
nothing inside those components.

**A widget's own node** is the widest place it can attach rules, and they
then reach its whole interior. That is the nearest thing here to a shadow
root. It is not a separate object, because a widget's node is both the box its
parent placed and the root of its interior. Rules attached to a node inside
the interior reach less, so a toolbar's rules do not apply to the rest of its
widget.

**A child widget's node is in two scopes.** The child's own rules apply to it,
as the root of the child's interior. The parent's rules apply to it, as a node
the parent placed. That is how a parent says how a child sits in its layout:
whether it grows, how it is aligned, the room around it. The parent can set
facts of its own on that node, as a page puts a class on a custom element, and
its conditions can test those and any fact the child set under a key the
parent holds. Where both give the same property a value, the parent's wins, as
it does in CSS, so what a widget says about its own node is a default.

**Why a scope stops at an interior.**
[Where each one stops](./zenafx-widget-authoring.md#where-each-one-stops)
gives the reason: a widget's interior is not something another widget should
depend on, and a widget cannot read the content it is given. What should cross
that edge, a text colour or a theme, crosses by
[Inheritance](#inheritance).

### Order

A node's values are the declarations of the rules that apply to it and whose
conditions hold. A later declaration replaces an earlier one for the same
property and leaves the other properties alone, so a hovered fill and a
pressed border combine, which the whole-record looks cannot do. The order is:

1. rule sets with the reach `scope`, those attached higher in the tree first
2. within one rule set, the rules in the order they are listed
3. a rule set with the reach `node` after every scope's rules, as an inline
   style comes last in CSS
4. on a child widget's node, the parent's rules after the child's

There is no specificity to compute. Two rules are told apart by where they are
attached and where they are listed.

[Defaults](#defaults) are ordered among themselves in the same way, and every
ordinary declaration of a property comes after every default one.

A rule with no condition is a base style. Conditional styles are therefore the
same thing as ordinary ones, with a condition.

### What the host is sent

Rules are attached to nodes, and a template is how a component describes
nodes: it is sent once, and each instance of a widget is a copy of the nodes
it describes. So a template is where rule sets are written down, each on the
node that carries it, and every instance has them on its own nodes. The
conditions those rules name are in one list beside the template's nodes.

When the template arrives, the host runs the first stage of
[One condition, tested in two stages](#one-condition-tested-in-two-stages)
for each rule set against the nodes of the template in its scope. Two kinds of
node in a scope are outside the template, and are tested when they are
rendered:

- A loop in a widget's build compiles to a slot and a template for the loop's
  body, which the widget renders once for each item. The body's nodes are the
  widget's own. The host keeps the answer for each pair of a rule set and a
  body template.
- A child widget's node has the facts the child's template fixed and the ones
  the parent set on it.

### Holes

A hole is a place in a template that is filled in for each instance and can be
filled in again later. [Rules for template and holes](./zenafx-widget-authoring.md#rules-for-template-and-holes)
has two kinds, and they reach the host in different ways.

- **A child hole** is a place where nodes go: a child widget, the items of a
  loop, a branch of a condition. In the interface it is a slot. The widget
  asks the host for a number of nodes in the slot, with `content`, and renders
  a template into each, with `render`. A text node arrives this way, as part
  of whatever template is rendered there.
- **A property hole** is a value for a node the template already has: the
  string a text node shows, and today a node's whole style record or layout
  record. These are the `hole` records passed to `render`.

Styling has to do with property holes only, and two of them carry something
this document describes.

- **A fact on a node**, such as `selected` on a row.
- **The declarations of one rule on a node**, which are that rule's values for
  this instance. A button whose colour its parent chooses has one, and so does
  an application's root, where the theme's properties are given their values.

A property hole changes values. It does not change which rules a node carries,
what a rule's condition is or what its reach is. Those are the same for every
instance of the template.

### Stylesheets

A stylesheet is a rule set kept apart from any one template, so that several
can attach it.

```zena
export let cardStyles = [
  rule(card, [background(paper), cornerRadius(8.0)]),
  rule(all([title, within(card)]), [textSize(18.0)]),
  rule(all([title, within(card), hovered]), [textColor(use(accent))]),
];
```

This is a sketch. `card`, `title`, `hovered` and `accent` are keys, which are
ordinary values, and `rule`, `all` and `within` are ordinary functions that
build the records. A stylesheet is an ordinary value that a library exports
and another imports. [Selectors as data](./zenafx-widget-authoring.md#selectors-as-data)
proposes a pattern syntax for the same thing, which could be added over these
functions and is not needed for them.

A widget that tags a box `card` and a text node `title` attaches the
stylesheet to its node and gets the card's look without being a `Card`
widget. It can do so only if it holds the keys, so a stylesheet's tags are
shared on purpose: exported from the library that owns the stylesheet. In the
terms of
[What a predicate matches on](./zenafx-widget-authoring.md#what-a-predicate-matches-on),
a rule on a widget class's own tag is like naming a class, and a rule on an
exported tag is like naming an interface: any node can opt in.

The host is sent a stylesheet once, as it is sent a template once, and a node
that attaches it names it by an id in place of a list of rules. The first
stage's answer is kept for each pair of a stylesheet and a template.

A stylesheet is data, so a component written in Rust can attach one that a
Zena library defined, given the same records and handles to the same keys.

Two things a stylesheet cannot do, both for reasons already given.

- **Reach into another widget.** A card cannot style the content placed in it
  beyond the nodes it placed itself, and an application cannot restyle the
  inside of a widget it uses. A widget offers what it wants restyled as
  properties.
- **Count the children of a slot.** "Every second row" depends on which row a
  node is in. The host would write an `index` number on each child of a slot.
  That needs a remainder test beside the range test, or `even` and `odd`
  flags.

## What is left to the language

The host is sent data: declarations with values, conditions, and keys. It has
no variables, no imports, no functions and no expressions. Those belong to the
language a component is written in, and a style is always written from one.

**A value known when a template is built is a value of the language.** A unit
of spacing, a brand colour and a set of text sizes are constants that a
library exports and another imports, and a declaration that uses one is sent
with the value itself. This is lexical: what `spacing.medium` means is decided
by the import at the top of the file. Most of what a CSS author wants from
variables is this, and it needs nothing from the host.

**A property is for the one thing an import cannot do**: a value that depends
on where a node is in the tree when it is drawn. A theme that a person
switches, a sidebar with colours of its own, and the width of the panel a grid
is in are of this kind. A declaration reads such a value with `use`, and that
is the whole of what the host offers. There is no fallback, no arithmetic and
no second form of reference.

**A function over values is a function of the language.** A lighter shade of
a colour and half a unit of spacing are calls. Where they run depends on when
their inputs are known.

- When the inputs are constants, the call runs in the component as the
  template is built, and the result is sent as a value.
- When an input is a property, whoever gives the property can give the result
  too. An application that declares `accent` on its root declares
  `accent-soft` beside it, computed by the same code at the same moment. Most
  values derived from a theme are derived once, where the theme is set.
- A widget that needs its own function of a value it only inherits is the case
  left over. The value is known in the host, on the window's thread, and the
  component runs on another thread that the window's thread never waits for.
  So the host cannot call a function in the component's instance. The
  function goes in a component the host runs on the window's thread, which is
  what [Window components](#window-components) are.

**A condition is data and cannot be a function**, because the host tests it
when no component is running. It is still built by ordinary functions, as the
sketch under [Stylesheets](#stylesheets) shows, and a test the algebra lacks
is a fact the component computes and sets.

## Window components

Styling and layout are extended with WebAssembly. Code that has to run during
a frame, such as a function over style values or a layout algorithm, is a
component of its own that the host runs on the window's thread. An application
is several components already, and one for the window's thread is one more.

It is apart from the application's component because the window's thread
never waits for the application, which
[Alternatives considered](#alternatives-considered) goes into. Four rules
follow from where it runs.

- **It imports only the interface it serves.** A style function takes values
  and returns a value. A layout algorithm measures and places children. It has
  no scene, no files and no clock.
- **The host calls it directly**, on the window's thread, with no message and
  no wait.
- **Its functions are pure**: a result depends on the arguments alone. The
  host keeps each result by its arguments, calls in any order, and may make a
  second instance or a fresh one. Zena checks this
  ([pure-functions.md](./pure-functions.md)). In another language it is the
  author's promise, as it is for a worklet in CSS Houdini, which is the same
  arrangement.
- **A call that runs too long is cut off**, and the declaration that made it
  does not apply.

### The flow of a value

1. The application's component writes a value into the host. A value that is
   the same for every instance of a widget is in the widget's template. A
   value that belongs to one instance, or that changes, is written through a
   hole. A hole write is the call that sets a value, and no other is needed.
2. The host keeps the value on the node. If its property inherits, every node
   beneath can read it.
3. A declaration on some node reads it, with `use` or as an argument to a
   function.
4. The host works the declaration out. For a function it looks for the result
   under the function and its arguments, and calls the window component only
   if there is none.
5. The result is the declaration's value, and the frame goes on to lay out or
   paint as the property needs.
6. When a value changes, the host works out again the declarations that read
   it. A function is called only for arguments it has not been given before,
   so a theme that changes costs one call for each distinct use of a function
   and not one for each node.

The application's component runs in step 1 and in no later step.

### Calling a function from a declaration

A call is one more kind of value.

```wit
variant value {
  // ... the cases under Declarations
  /// The result of a function that a window component exports.
  call(call),
}

record call {
  /// An index into the template's list of functions.
  function: u32,
  /// Indexes into the template's list of values, which is flat for the
  /// reason its list of conditions is.
  arguments: list<u32>,
}
```

A function is one export of one window component, and its parameters and
result are of the types a property can have. An argument is any value: one
sent as it is, a `use`, a `fact`, or another call. The host checks a call
against the export's signature when the template arrives.

In source a call reads as a call, `background(lighten(use(accent), 0.2))`. The
library that exports `lighten` gives it two forms: the function itself, which
runs in the application's component when its arguments are constants, and one
that takes a value read from the tree and builds the record above. The Zena
surface for that is not designed.

### What is not designed

- **How a window component reaches the host.** An application names the ones
  it uses, and two components that name the same one share an instance. Where
  the bytes come from is the question
  [zenafx-navigation-and-assets.md](./zenafx-navigation-and-assets.md) asks of
  every asset.
- **Building one from an application's own source.** The toolchain could
  compile the pure functions a style names into a window component, so that an
  author who needs one function does not make a component by hand.
- **The cost of a call** from the host into a component on its own thread,
  with a few values copied each way. Nothing has measured it, and it decides
  how small a function is worth calling.

## What the host keeps

A window can hold a thousand instances of one widget, each mentioning the same
properties and carrying the same rules. A further instance should cost a few
table lookups and no new copy of anything that is the same as before. Five
tables do that, each keyed by what its entries have in common.

1. **Keys, once for a window.** The table of keys described under
   [Where definitions live](#where-definitions-live), each with its
   definition. A component's `declare` makes or finds each of its keys once,
   which gives a table from the component's positions to the window's
   numbers. Templates and stylesheets are rewritten to the window's numbers
   when they arrive. No instance and no node holds anything about a
   definition.
2. **Rules, once for a template.** The first stage's answer: for each node of
   a template, the rules that can apply to it, in order. A stylesheet's answer
   is kept for each pair of a stylesheet and a template. Each rule's
   declarations are one block, held once and referred to by every node the
   rule applies to.
3. **Inheriting values, once for each distinct set.** The inheriting values
   in force at a node, ordinary and default, are a set that is never changed
   after it is made. A node that declares none of them uses its parent's set.
   A node that declares some gets a set made from its parent's, and the host
   keeps a table from a parent's set and a block of declarations to the set
   that results. So the buttons of one toolbar share one set, and two sets
   are compared by comparing two pointers.
4. **A node's values, once for each distinct outcome.** What a node's values
   are depends on two things: the blocks of the rules that apply to it and
   hold, and the set of inheriting values it starts from. The host keeps a
   table from that pair to the worked-out values. Two buttons in the same
   state under the same theme get the same entry, and the second is a lookup.
   Browsers keep the same table and call it a matched-properties cache.
5. **An instance, once for each situation.** Every instance of a template has
   the same nodes and the same rules. So the values of all of an instance's
   nodes can be kept together, under the template, the set of inheriting
   values at its root, what its parent declares for its node, and which of its
   conditions hold. A list of a thousand rows in the same state is then one
   entry, and each row after the first is one lookup. This last table is worth
   building only if a measurement of the fourth says so.

What is left for each node is a pointer to its values. A hole that writes
declarations for one instance gives that instance a block of its own, and the
node shares an entry with any other node whose block has the same content.

A change goes through the same tables. A condition that starts to hold on a
node changes which blocks apply to it, and the node's values are looked up
again. A theme that changes at the root makes a new set of inheriting values
there, and each node beneath is looked up under the new set: the first button
is worked out and the rest are found.

## Condition watchers

A layout that shows a sidebar in a wide window and a drawer in a narrow one
changes structure, which is more than a declaration can do. The component has
to render something else, so it has to be told.

`ResizeObserver` on the web reports every change of size, and the application
compares the size with its own thresholds. Here the component gives the host
the condition and hears only when its answer changes.

```wit
resource node {
  /// Hear when a condition starts or stops holding for a node of this
  /// node's interior. The stream's first element is the answer now.
  watch: func(target: u32, when: condition) -> stream<bool>;

  /// Hear the value a node has for a property, now and each time it
  /// changes. `none` while nothing gives it one.
  watch-value: func(target: u32, property: key) -> stream<option<value>>;
}
```

`watch-value` is how a component's own code reads a value that goes down the
tree, as
[One mechanism for values that go down the tree](#one-mechanism-for-values-that-go-down-the-tree)
says. It is told once for each change, and only if it watches.

A watcher uses the indexes that styles use, so a watched width costs two
comparisons a frame until it crosses a bound. The component then hears once,
on its own thread, and the frame it writes follows the one that crossed.

Two uses beyond breakpoints:

- **Long lists.** A list that renders only the rows near the viewport needs to
  know when the scroll position enters the next block of rows. That is a range
  test on `scroll-y`, heard once for each block and not once for each pixel.
- **Loading on approach.** "Within 500 of the end" is a range test on
  `scroll-y` against `scroll-range-y`.

A component never reads a size by calling the host. It has no such call today,
and adding one would let a component force a layout in the middle of its own
update, which is the cost the web pays for `getBoundingClientRect`. Sizes reach
a component as answers to conditions it watches.

## Layout extension

Custom layout is where an application most needs to add behaviour of its own.
CSS took years to gain grid, and masonry has taken longer. The web's
alternative is to observe sizes, compute positions in script and set
them, which costs a script call and a second layout for each change.

This section is a direction. It names the levels of extension, cheapest first,
and what has to be measured before the last one is designed.

### Declarations with size conditions

Many layouts that need script on the web are a few layouts chosen by size. A
grid with one, two or three columns by its panel's width is three sets of
layout declarations with range conditions. This level needs nothing beyond the
sections above, and a resize does not call the component.

### Structure chosen by a watcher

When the tree itself differs by size, the component watches the condition and
renders again. It is called once for each bound crossed.

### A custom algorithm

Masonry places each item in whichever column is shortest so far. No fixed set
of declarations expresses that: it is an algorithm over the children's sizes.

Layout in the host is a conversation, as
[Layout is a recursive query, not two passes](./zenafx-ui.md#layout-is-a-recursive-query-not-two-passes)
records. A parent asks a child how wide it would like to be, how narrow it
could be, and how tall it is at a given width, and one text leaf is asked four
or more times in a solve. A custom algorithm takes part in that conversation
from both sides. Its parent asks it those questions, and it asks them of its
children.

So a custom algorithm is a function the host calls during a solve, several
times, and which calls back to measure children. That rules out the simplest
hosting.

- **In the application's component.** The component runs on its own thread,
  and the window's thread reaches it by passing a message and waiting. A
  pointer event written to a component and answered was measured at about 3µs
  ([Implementation status of events](./zenafx-ui.md#implementation-status-of-events)).
  A solve would make several such exchanges for each custom node, each waiting
  on a component that may be busy. The window's thread would wait on the application, which
  nothing else in the design allows.
- **In a module of its own, run by the host.** The algorithm is compiled as a
  separate WebAssembly module that imports only the layout interface: measure
  this child, place that child. It holds no application state. The host
  instantiates it on the window's thread and calls it directly, with no
  message and no wait. Its parameters are properties of the node, declared as
  any property is. Because its result depends only on its inputs
  and its children's answers, the host can cache the result as it caches a
  built-in algorithm's.
- **As data.** A language of expressions or constraints that the host
  evaluates. Masonry needs a running minimum across columns, so the language
  would need loops and state, and would become a second programming language
  to specify.
- **In the component, from watched sizes.** The component watches its
  children's sizes and writes positions. This works with the sections above
  and nothing more. It is a frame late and costs a call for each change, so it
  suits a layout that changes at a few sizes and not one that follows a resize.

The second is the candidate. It is the arrangement the web's CSS Layout API
gives a layout worklet, and it keeps to the principle from the overview: flex
in the host and masonry in a module answer the same questions through the same
interface, and differ in where they were compiled. Taffy, the host's layout
library, is built for this. Its `LayoutPartialTree` trait lets each node name
the algorithm that lays it out, where `packages/zenafx/src/ui/layout.rs` uses
the simpler `TaffyTree` today.

Before it is designed, three things need answers.

- **The cost of a call.** Nobody has measured a direct call from the host into
  a module on the same thread, with a list of sizes copied each way. The 3µs
  above is for an event delivered through a stream to a component on another
  thread, and says little about it.
- **How a module reaches the host.** It could travel inside the application's
  component, beside it as a second file, or be installed separately.
- **What a module may be trusted with.** It runs on the window's thread, so
  one that loops forever freezes the window. Wasmtime can interrupt a call that
  runs too long, and the design has to say what the node shows then.

Such a module is a [window component](#window-components), and a function
over style values is hosted the same way. A custom condition and a custom
painter could be too. This document proposes neither of those.

### Limits on what a write invalidates

The host lays out the whole tree again after a component writes to one node.
The earlier result can instead be kept for every part of the tree the write cannot affect. A node
whose size does not depend on its content bounds the effect of anything
written beneath it, and the host can find such nodes from their declarations
without the component marking them. CSS asks an author to declare this with
`contain`. Flutter derives it, and calls the node a relayout boundary.

This is an improvement inside the host with no interface, so it is not designed
here. It matters to this document because it decides what a custom layout
costs: a module's result is reused whenever nothing beneath its node changed.

## Values that change continuously

A condition is true or false, so a style changes in steps. A shadow that fades
in over the first 40 pixels of scrolling, and a colour that eases to its
hovered value over 150 milliseconds, both need a value between two
declarations.

Those need a second mechanism in the host: a declaration whose value is
interpolated along a number, where the number is a fact such as `scroll-y` or
the time since a condition changed. It is not designed here. It is named
because animation and scroll-linked effects are the frames that most need to
stay out of the component, and because it would reuse facts. A property's
type, which its definition gives, is what tells the host how to interpolate
one of an application's own.

## Alternatives considered

- **Keys that are text.** A tag or a property named by a string that anyone
  can write, as a CSS class or custom property is. It needs no declaration of
  keys and reads well in a debugger. Two libraries can then pick the same name
  without knowing, a widget's tags are open to anything that can guess them,
  and the host compares strings or interns them.
- **A fixed list of properties, with inheritance fixed by the interface.** One
  variant case for each built-in property, a short list of the ones that
  inherit, and a separate mechanism of named values for themes. An
  application's values would then be a different kind of thing from the
  host's, with their own way to inherit and no type.
- **An initial value in every definition**, as `@property` has. A property
  would never be without a value. But the value would be part of the
  definition, so two versions of a package with different defaults would
  define two properties or need something to choose between them, and a
  widget could not have a default of its own. Default declarations give the
  same fallback and belong to the node.
- **A set of definitions on each node, inherited down the tree**, as values
  are. Two definitions that differ could then live in different parts of a
  window. What a widget's rules mean would depend on where the widget is
  placed, so a template could not be checked once when it arrives, and content
  moved to another place would have to be checked again. With one definition
  for each key there is nothing left for a place in the tree to decide, and
  which components share a property is decided when they are linked.
- **A shared key known by the export it comes from**, such as
  `acme:theme/accent`, written by the compiler and sent to the host as text.
  Two components that each compiled the theme's source in would then share
  its properties with no shared instance and no linking. The text makes the
  key public to anything that can spell it. And two components can then give
  the host two definitions for one name, so the host needs a rule: refuse the
  second, or treat definitions that differ as different properties.
- **A widget's default written with the inherited value.** CSS is gaining
  `inherit()`, which reads the value a property has on the parent, so a
  widget can declare `accent` as the inherited `accent` or else blue. The
  declaration is an ordinary one, so the blue it settles on is then what
  everything beneath the widget inherits. A button placed in a card that did
  this takes the card's fallback and never reaches its own, though neither
  meant to theme the other. A default priority keeps the two apart: any
  ordinary declaration wins over any default, and among defaults the nearest
  wins. Reading the value from above is still useful for working a value out
  from the parent's, and could be added as a value beside `use`.
- **Facts and properties as one kind of thing.** A condition could then test
  any value on a node, a rule's included. A rule could change whether a rule
  applies to the same node, and the host would need to find and refuse such
  loops. CSS keeps classes and states apart from properties for this reason.
- **Selectors matched by a library in the component.** The library would run
  the first stage and send each rule with the nodes it applies to. The host
  would hold no tags. Each language would need the library, a stylesheet could
  not be attached by a component in another language without it, and the
  parent's rules for a child widget's node would have to be matched by the
  parent with facts the child set, which it cannot read.
- **Rules that reach into other widgets' interiors.** This is a stylesheet on
  a document in CSS, before shadow DOM. An application could restyle the
  inside of a widget it did not write. With keys that are symbols a rule could
  only match what the widget exported, so it would be less open than it is in
  CSS. It still makes two scopes' rules apply deep inside a widget, and every
  render would be tested against the rules of every scope above it. Properties
  that inherit are how an application reaches a widget's inside here.
- **The component on the window's thread.** A window has two threads today.
  The window's thread runs the operating system's event loop, finds what the
  pointer is over, lays out, paints and presents. The component's thread runs
  the application and writes to the tree, which the two share behind a lock.
  With the component on the window's thread, the host could call a function
  the component exports in the middle of a frame, and a style function or a
  layout would need no module of its own. A browser's main thread works this
  way: script, style and layout take turns on it. The cost is the one browsers
  have spent years working round. While the application computes, nothing is
  laid out or painted and no hover or scroll is answered, which is why
  browsers moved scrolling and some animation to a compositor thread. Here the
  window's thread already does more than a compositor does, since it lays out
  and restyles as well, and it never waits for the application. That is what
  the first constraint in the [Overview](#overview) protects.
  `packages/zenafx/src/loader/mod.rs` records a second obstacle: the
  runtime's call that drives a component does not hand the thread back between
  the component's steps, so it could not be run a slice at a time between
  frames.
- **A function the application's own instance exports, entered by the window's
  thread.** A component that several threads can enter at once could let the
  window's thread call one of its exports while its own thread runs. Wasmtime
  lets one thread into a store at a time, and the proposal that would change
  that, shared-everything threads, is years away by its maintainers' account,
  as [Serialization across components](./zenafx-ui.md#serialization-across-components)
  records. It would also not remove the rule that matters. A function called
  in the middle of a frame must not wait on anything the application holds, so
  it would have to be as free of the application's state as a window
  component's function is. What it would save is the second instance. If it
  arrives, the host could call the same pure function in the application's
  instance, and nothing a style says would change.
- **Expressions in the host**, as CSS has `calc()`, `color-mix()` and a
  fallback in `var()`. Each is a piece of a programming language, and the
  list grows: CSS has since added conditions, functions and typed arithmetic.
  A component is always written in a language that has all of them, so the
  host is sent their results. The one thing they cannot do, a function of a
  value known only in the host, is a function of that same language run by
  the host.
- **Selector functions supplied by the component.** The host would call a
  function to ask whether a node matches. The host cannot tell what such a
  function reads, so it would have to call it again after any change nearby. A
  function that walks the tree would read content that belongs to other
  widgets. And a component that is busy would hold up its own hover feedback.
  A function with declared inputs and no state avoids the first two, and that
  is what [A custom algorithm](#a-custom-algorithm) describes for layout.
- **More cases on the `states` list.** Adding `selected`, then sizes, then
  combinations to the list in [Styles today](#styles-today) arrives at
  conditions one special case at a time.
- **A condition on each declaration**, with a node's style as one flat list. A
  state usually changes several properties at once, so the condition would be
  repeated for each. A rule holds the declarations and names the condition
  once.
- **The component resolves the theme.** Each widget would read the theme when
  it builds its template and send the colours themselves. A switch of theme
  would then send every template again or write a hole for every instance, in
  every component, and each component would have to be told. Two instances of
  a widget under different themes could not share a template.

## Changes to what exists

In the order they could be made, each working without the next:

1. Property definitions and declarations for the built-in properties.
   `box-style`, `text-style` and `flex` become a rule set with the reach
   `node` on each node, and so do `node-def`'s `cursor` and `unselectable`
   fields. The properties that inherit
   do so from this step on. Nothing is conditional yet, and the `states` list
   stays.
2. Conditions on rules, with `flag` tests of the host's three states.
   `state-style` and `restyle` are removed.
3. A component's own facts with private keys, set in a template and through
   holes.
4. Rule sets with the reach `scope`, `under` and `within`, and the first stage
   run when a template arrives.
5. A component's own properties, shared keys, `use`, and default
   declarations.
6. Range tests, number facts, and a declaration that takes its value from a
   fact.
7. `watch`.
8. Stylesheets, and the `rules` syntax in Zena.

## Open questions

- **Linking a shared component.** Sharing a property between components needs
  one instance of the component that made it, imported by the others.
  [runtime-components.md](./runtime-components.md) names that an imported
  component and has not designed it: when the shared component is started,
  and who decides that two components get the same instance.
- **A property with no value.** One of an application's properties that nothing
  gives a value has none, and a declaration that uses it does not apply. That
  is quiet when it is a mistake. Whether the host should log the first such
  read is open.
- **The parent's rules on a child's node.** They can set any property there,
  as in CSS, and win over the child's own. Whether a child should be able to
  keep some properties of its own node from its parent is open.
- **Order between a stylesheet and a widget's own rules.** Both can be attached
  to the same node with the reach `scope`. Which comes later decides which
  wins, and [Open questions](./zenafx-widget-authoring.md#open-questions) in
  the authoring document asks the same of stylesheets attached at different
  depths.
- **Turning the focus and editing off by a condition.** A disabled button
  should not take the focus, and a read-only field should not be edited.
  `focusable` and `editable` are fields of a node, so today that is a new
  render. Making them properties would let a `disabled` flag do it with the
  rest of the disabled look. Against that, they are not style anywhere else,
  and a rule that changes what `Tab` reaches is harder to find than a field.
- **Names for the terms.** "Declaration" and "rule" are CSS's, and
  "definition" is this document's. Whether to keep them is open.
- **Remainder tests.** Whether "every second row" is common enough to add a
  test, or whether `even` and `odd` flags written by the host are enough.
- **A size condition on a node that sizes to its content.** The containment
  rules refuse it. Whether the template is rejected when it is defined, or the
  condition is treated as never holding, is undecided.
- **The cost of a call into a layout module**, as under
  [A custom algorithm](#a-custom-algorithm). It decides whether that design is
  worth making.
