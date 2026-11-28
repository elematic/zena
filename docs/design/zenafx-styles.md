# ZenaFX Styles: Properties, Facts, Conditions and Rules

## Status

In progress. Three pieces are built today:

- The legacy list of state styles described under [Styles today](#styles-today),
  retained for backward compatibility while existing example widgets migrate.
- Step 1 of the guest [Authoring surface](#authoring-surface): untagged node
  literal builders in the compiler, unified `Style` / `When` / `Rule` /
  `Stylesheet` builders and the `Condition` algebra with flat post-order
  serialization in `examples/zenafx/style.zena` and `examples/zenafx/ui.zena`,
  and the updated `@ui` example widgets.
- **Platform style engine (Track B, built in `packages/zenafx-platform/src/style.zena`):**
  built-in and custom properties (`define-property`, `define-fact`), unified
  5-step resolution (ordinary declarations, inheritance across slots/widget
  boundaries, default priority, `use-prop`, `use-fact`, cycle safety),
  declarative flat post-order conditions (`flag`, `range`, `under`, `within`,
  `all`, `any`, `negate`), standalone scoped stylesheets with widget-boundary
  isolation (`reach: node | scope`, `set-scope-owner`), automatic `watch-flags`
  derivation into `RenderCore` (`hovered`, `pressed`, `focused`, `size`,
  `scroll`), slot `index` facts, and reactive `watch-condition` / `watch-property`
  streams exposed on `zenafx:platform/runtime@0.1.0` and
  `zenafx:host/style@0.1.0` (tested in `packages/zenafx/tests/styles.rs` and
  `examples/zenafx/styles/`).

Remaining work: Step 2 isolated window-component functions over
`borrow<style-node>` ([isolated-functions.md](./isolated-functions.md)) and
migrating existing `@ui` examples off legacy `state-style` records.

The rest of this document asks for nine platform-protocol decisions:

1. A property is declared: a key, a type and whether it inherits. The built-in
   properties are declarations of the same form as an application's own, and
   all property resolution (built-in and custom, inheritance and defaults) runs
   in one place inside the platform component. A property has one definition,
   made with its key, so two definitions cannot conflict. See
   [Properties](#properties).
2. A fact is a flag or a number on a node that the runtime or a component
   writes and a condition tests. See [Facts](#facts).
3. The key of a property or a fact is a symbol: only code that holds it can
   set, read or test it. Between components it is shared by handing over a
   handle, and never by a name. See [Keys](#keys).
4. A rule is a condition and a set of declarations. Rules are attached to a
   node, and apply to that node alone or to the subtree rooted at that node,
   stopping at the interior boundary of any nested widget. Only inheriting
   properties cross widget boundaries. See [Rules](#rules).
5. The platform component evaluates conditions, and there is no separate
   selector language. Fixed structural facts are resolved once per static
   fragment; dynamic predicates can be declarative tests or pure functions
   compiled into a window component reading a `borrow<style-node>` resource
   ([isolated-functions.md](./isolated-functions.md)). See
   [Conditions](#conditions) and
   [One condition, tested in two stages](#one-condition-tested-in-two-stages).
6. Inheritance is decided for each property by its declaration. A theme is a
   set of inheriting properties. See [Inheritance](#inheritance).
7. A component can watch a condition and be told when it starts or stops
   holding. See [Condition watchers](#condition-watchers).
8. The platform component has no variables, imports, functions or expressions.
   A constant is imported in the guest language and sent as a value, and a
   function is a function of that language. A property is only for a value that
   depends on where a node is in the tree. See
   [What is left to the language](#what-is-left-to-the-language).
9. Styling and layout are extended with WebAssembly. Code that has to run
   during a frame — a style value function, a dynamic condition predicate, or a
   custom layout — is a component of its own that the platform component runs
   on the window's thread, and a declaration or condition can call a function
   it exports. See [Window components](#window-components).

[Layout extension](#layout-extension) says how a custom layout algorithm would
fit the same constraints. It is a direction and not yet a design.

## Overview

A ZenaFX window is structured in three layers:

1. **The native core (`zfx`, Rust).** Owns the OS window and input (`winit`),
   layout (`taffy`), text shaping (`parley`), compositing and painting
   (`vello`), hit testing, and scrolling over a minimal retained **render
   tree**. Each node in the render tree holds only flat, already-resolved
   built-in layout and paint properties plus a small bitmask of host states
   (`hovered`, `focused`, `pressed`, `size`, `scroll`) that the platform
   component asked to be notified about. The native core has no knowledge of
   slots, custom properties, inheritance, stylesheets, or rules.
2. **The platform component (WebAssembly, written in Zena).** Bundled with
   `zfx` and independently versioned and upgradeable, running on the window
   thread directly above the native core. It exposes the component-facing UI
   API to apps and widgets written in any language, resolves slots (including
   future multi-slot projection) into the flat render tree, and owns all
   styling — built-in and custom properties, inheritance, defaults, facts,
   stylesheets, Stage-1/Stage-2 rules, `style-node` resources, and caches. On
   watched state transitions or app updates it flushes flat resolved style
   diffs down to the native core in batches. _(In today's prototype,
   `packages/zenafx-render/src/scene.rs` still holds `Scene` directly in Rust;
   splitting the platform component out is part of the target architecture. In
   the sections below, "host" refers to this platform/scene layer unless
   "native core" is named explicitly.)_
3. **App and widget components (user-authored, loaded on the fly in any
   language).** The root app component and any child widget components it
   loads. They run on their own thread(s), hold widget state and event
   handlers, and talk to the platform component.

A button that changes colour under the pointer is styled by a condition: this
fill while the pointer is over the button, that one otherwise. So is a layout
that has two columns in a wide window and one in a narrow window, and a header
that gains a shadow once the page has scrolled. CSS expresses all three with
selectors, pseudo-classes and media or container queries.

Three constraints shape the answer here.

- **A resize, a scroll, a hover and an animation frame must not call an app or
  widget component.** Each can happen sixty or more times a second, and the
  window's thread does not wait for app or widget threads.
- **The native core stays small, and the platform layer stays upgradeable.**
  Layout, text shaping, paint, hit testing, and scrolling stay in Rust over a
  flat resolved render tree; slots, styling, inheritance, and caches live in
  the WebAssembly platform component so the UI layer can evolve independently
  of the native binary.
- **Built-in behaviour and an application's own behaviour use one mechanism.**
  `hovered` is the same kind of thing as an application's `selected`, and
  `background` is resolved by the same property, inheritance, and default rules
  as a theme's `accent` before flat resolved built-ins are flushed to the
  native core.

The proposal has four parts. A **property** is a declared value a node has,
such as a background or a theme's accent colour. A **fact** is something true
of a node, such as being hovered, being 600 wide or being tagged as a title. A
**condition** tests facts. A **rule** is a condition and the property values
to use where it holds.

The platform component evaluates all of it, and divides the work by when a fact
can change. Fixed structural facts (tags, node kinds, and static nesting) are
evaluated once when a subtree or static template fragment is attached. Hover,
focus, sizes, scroll positions, and dynamic fact holes change afterwards and
are evaluated on demand as those inputs change.

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
inline style. On the wire, a node of a template carries a `box` record and a
`layout` with its eleven layout fields between them, and a `node-style`
carrying a `box-style` or `text-style` record. A hole can replace a whole
record for one instance. A node also names its cursor in a `cursor` field that
no hole writes.

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

Four limits of the wire protocol are what the rest of the document removes.

- A state style replaces the whole record. When a node is hovered and pressed,
  the later entry wins everything, and a hovered fill cannot combine with a
  pressed border.
- The states are a closed `enum`. An application cannot add `selected`.
- A condition is one state of one node. It cannot test a size.
- Every text node carries its whole text style. Nothing is taken from the node
  above, so there is no way to say that everything in a panel is in one colour.

## Authoring surface

Even before the host protocol moves from fixed records (`box`, `layout`,
`box-style`, `text-style`) to sparse declarations, widget authoring in Zena
runs into two ergonomic problems when it mirrors the wire records directly.

First, placing layout properties directly on `Box` and `Flow` (`width`,
`height`, `padding`, `axis`, `justify`, `align`, `gap`, `cursor`) while
confining `style` to visual fill and border prevents bundling and reusing
layouts. Every full-screen page repeats `width: full`, `height: full`,
`justify: Justify.Center`, `align: Align.Center`; every button repeats its
padding, alignment, radius, and state styles separately.

Second, constructing the WIT records directly (`new BoxStyle(some(surface),
some(edge), 1.0, 12.0, 1.0)`, `new TextStyle('system-ui', 64.0, 600 as u16,
false, ink)`, `new Edges(12.0, 24.0, 12.0, 24.0)`) forces positional
arguments, `Option` wrappers, and repeated defaults for every style value.

### One unified `Style`

A single `Style` value bundles every style property of a node — sizing, flex
and flow layout, visual fill and border, typography, cursor, text selection,
and conditional rules — matching the property model in [Properties](#properties).

```zena
let centeredPage = Style {
  width: full
  height: full
  justify: Justify.Center
  align: Align.Center
};

let pageStyle = Style {
  ...centeredPage
  background: pageBg
  gap: 24.0
};

let buttonStyle = Style {
  background: resting
  cornerRadius: 10.0
  padding: { x: 24.0, y: 12.0 }
  justify: Justify.Center
  align: Align.Center

  When(hovered) { background: hoveredBg }
  When(pressed) { background: pressedBg }
};

let labelStyle = Style { fontSize: 16.0 fontWeight: 600 color: paper };
```

A node then takes one `style` property alongside its structural content and
behaviour:

```zena
@ui Box {
  style: buttonStyle,
  onDown: () => { this.#onPress(); },

  Text(this.#label) { style: labelStyle }
}
```

Four rules shape this boundary:

- **Layout and visual properties live together in `Style`.** A library can
  export layout bundles (`centeredPage`, `toolbarRow`), surface bundles
  (`cardSurface`), or complete control styles (`buttonStyle`) as ordinary
  values and compose them with `...spread`.
- **Behaviour and structure stay on the node.** Text content, child nodes,
  `Slot {}`, `focusable`, `editable`, and event handlers (`onDown`, `onKey`)
  remain node properties, matching the split under
  [The cursor and text selection](#the-cursor-and-text-selection).
- **A `Style` is an ordered list of rules, not just a flat record.** Base
  declarations form the unconditional base, and each `When(...)` child appends
  a conditional rule in source order. Spreading `...buttonStyle` preserves
  `buttonStyle`'s conditional rules instead of shallowly overwriting them, so
  later rules override only the properties they redeclare. Today the guest
  merges each host-state override (`hovered`, `pressed`, `focused`) onto the
  base visual style when lowering to `state-style`; once host rules land, each
  override becomes a rule directly.
- **Value constructors stay lightweight.** Edge insets use a presence-optional
  record (`{ all: 16.0 }`, `{ x: 24.0, y: 12.0 }`,
  `{ top: 18.0, x: 22.0, bottom: 22.0 }`), font weights take plain `i32`
  literals, and small helpers (`rgb`, `rgba`, `px`, `pct`, `full`, `auto`)
  replace positional class constructors.

Inline `Style` builders (`Box { style: Style { axis: Axis.Row gap: 10.0 } }`)
and typed record literals (`StyleProps { axis: Axis.Row gap: 10.0 }`) stay
available as lightweight shorthand when a node needs no separate binding. In
`@ui`, module-level `Style` constants fold directly into the call-site-cached
`Template` with zero runtime bindings. A dynamic or reactive `style` expression
(`style: titleStyle(this.#accent)` or `style: $(...)`) declares bindings for
the node's underlying `box`, `layout`, and `style` targets and diffs per target
on updates, so changing only a background sends only a `style` hole.

### Builder syntax, stylesheets, and macro conditions

Flat records cover unconditional inline styles well, but hit four limits as
soon as styles carry rules:

- Record keys are a fixed schema and cannot express arbitrary application facts
  (`selected`, `disabled`), compound boolean conditions, or range queries
  (`panelWidth >= 600.0`).
- Record fields are unordered and each key appears once, whereas rule order
  decides which conditional declaration wins.
- Shallow record spread (`{ ...a, ...b }`) overwrites nested state objects
  wholesale rather than concatenating rules so declarations combine
  property-by-property.
- Scoped rules matching descendants within a widget's scope need a condition
  per rule and a `scope` reach rather than one flat property bag.

Zena's untagged node-literal grammar ([declarative.md](./declarative.md))
handles all four without adding a CSS parser. A class opts into untagged
node-literal syntax explicitly with a symbol-named constructor
`new [Builder.construct](args..., desc)` (`Builder` in `zena:core`), accepting
leading positional arguments and a descriptor record declaring whichever of the
four slots (`spreads`, `props`, `entries`, `children`) the class supports.
Because construction happens in a single constructor call, `Style`, `When`,
`Rule`, and `Stylesheet` are immutable classes with no `var` fields and no
setter boilerplate.

Custom properties (`PropertyKey<T>`, from [Keys](#keys)) use Zena's existing
`key => value` map-entry syntax inside the same block. A class declaring a
generic `static [Builder.entry]<T>(key: PropertyKey<T>, value: T)` wraps each
`key => value` entry with per-key static type checking (so `surface => 600.0`
is a type error when `surface` is `PropertyKey<Color>`), while a homogeneous
map builder without `static [Builder.entry]` receives a `HashMap` literal in
`entries`.

**Step 1 — untagged builder nodes with typed condition builders (built).**
Most styles live at module level (`let buttonStyle = Style { ... };`), so they
already execute once at module initialization and need no call-site tag.
Conditions are built with typed functions (`all`, `any`, `not`, `gte`, `gt`,
`lte`, `lt`, `under`, `within`) over `FlagKey` and `NumberKey` symbols, and
`Stylesheet` supports CSS-style nesting: a nested `Rule(child)` inside
`Rule(parent)` conjoins with `within(parent)`, and `When(state)` inside a
`Rule` conjoins with `all(...)`:

```zena
let surface = colorProperty('surface', true);
let panelWidth = numberProperty('panel-width', true);

let rowStyle = Style {
  padding: { x: 14.0, y: 10.0 }
  cursor: Cursor.Pointer
  surface => rgb(0.09, 0.10, 0.11)

  When(hovered) { background: rowHover }
  When(all([selected, not(disabled)])) { background: accentSoft color: accent }
  When(gte(panelWidthKey, 600.0)) { axis: Axis.Row gap: 16.0 }
};

export let cardStyles = Stylesheet {
  Rule(card) {
    background: paper
    cornerRadius: 8.0
    padding: { all: 16.0 }

    Rule(title) {
      fontSize: 18.0
      fontWeight: 600

      When(hovered) { color: accent }
    }
  }
};
```

A guest serializes any rule set's condition trees into the flat post-order
`list<condition>` table under [Conditions](#conditions) (`flattenRules` in
`examples/zenafx/style.zena`), ready for the host wire protocol once host rules
land.

**Step 2 — Isolated window-component functions over `StyleNode` (planned).**
Once Zena's isolated-function extraction
([isolated-functions.md](./isolated-functions.md)) lands, dynamic conditions
and computed style values can be written as ordinary pure Zena functions taking
a borrowed `StyleNode` WIT resource:

```zena
let isWide = (node: StyleNode) => node.use(panelWidth) >= 600.0;

Stylesheet {
  Rule(card) {
    background: paper
    cornerRadius: 8.0

    Rule(title) {
      fontSize: 18.0
      When((node) => node.hovered && !node.fact(disabled) && isWide(node)) {
        color: (node) => lighten(node.use(accent), 0.2)
      }
    }
  }
}
```

Structural nesting (`Rule(card) { Rule(title) { ... } }`) stays declarative
data evaluated across the attached node's subtree (stopping at nested widget
boundaries). For each lambda passed to `When(...)` or to a style property —
typed via `ConditionFn = Isolated<Window, (node: StyleNode) => boolean>` and
`StyleValueFn<T>` so ordinary closures are rejected — the compiler checks
purity and captures and extracts the function and its pure callees (such as
`isWide` and `lighten`) into the widget's companion window component. At the
call site, the lambda lowers to a `call` record carrying the export index and
any captured immutable values from the enclosing scope.

Because `StyleNode` is a fixed WIT resource (`borrow<style-node>`) with runtime
dependency recording in the platform component, no compiler access-analysis or
body rewriting is needed: `isWide` compiles as an ordinary helper function, and
widgets written in Rust or other languages implement the exact same WIT
interface without compiler or macro support. Predicates can express modulo
(`node.index % 2 == 0`), aspect ratios (`node.width / node.height > 1.5`), and
comparisons between two live facts (`node.scrollY >= node.scrollRangeY - 500.0`)
without protocol changes, and color/layout libraries export a single pure
`lighten(color, amount)` function instead of maintaining a second
`Value`-building overload. Step 1 combinators (`all`, `not`, `gte`) remain
available for simple declarative `flag` and `range` conditions.

### Terminology

The interface and documentation use **style** (and **state style** for
conditional overrides) uniformly rather than mixing "appearance", "look", and
"style". On the wire, `node-def.style` holds a `node-style` variant (`nothing`,
`fill`, `text`).

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
to lay it out and paint it, as it reads a node's `box` record today. One of
an application's properties is read in three places only: a declaration that
applies to a node and uses it as its value, a condition that tests it, and a
component that asks for it. So a theme with fifty properties costs nothing on
a node that uses none of them. The work is in proportion to the declarations
that set a property and the places that use it, and not to the number of
nodes times the number of properties.
[What the platform component keeps](#what-the-platform-component-keeps) has the
tables that make it so.

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

Layout properties are declarations too. A flex node's `box` and `layout` have
eleven fields between them, and a record grows with every property added:
grid tracks, margins or size limits would each be a field on every node. A
list holding only what differs from the initial values is smaller for most
nodes and has room to grow.

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
its default style. An application gives them other values at its
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
`layout` and `style`. A field cannot carry a condition and no hole writes
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
how it is styled, as `tabindex` and `contenteditable` are attributes in HTML and
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
the selection moves, and the row's style follows in the host.

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
/// True while `value` lies within `[min, max]` (inclusive or exclusive per
/// bound). A missing bound is unbounded.
record range-test {
  key: key,
  min: option<f32>,
  min-inclusive: bool,
  max: option<f32>,
  max-inclusive: bool,
}

variant condition {
  /// A flag is set on the node.
  flag(key),
  /// A number on the node is in a range.
  range(range-test),
  /// A pure predicate exported by a window component, returning `flag`.
  /// Uses the same `call` record as style value functions.
  predicate(call),
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

Static facts set directly on a node (not via a dynamic hole), a node's kind,
and static structural relationships are fixed once the subtree is built.
Interactive states (`hovered`, `focused`, `pressed`), layout sizes, scroll
positions, slot `index`, and facts written through dynamic holes change
afterwards. So the platform component evaluates a condition in two stages:

1. When nodes are attached in a rule's scope (stopping at nested widget
   boundaries), the platform component evaluates the part of each condition
   that reads only fixed facts, producing the candidate rules that can apply to
   each node. When a subtree comes from a reusable static template fragment,
   this first-stage answer can be cached once for that static fragment (or
   `(stylesheet, fragment)` pair) as an internal optimization.
2. What is left stays as a dynamic condition on those nodes, tested only when a
   fact or inherited property it reads changes.

The first stage runs once per static fragment or node attachment, whatever the
number of instances on screen, and never re-runs when the pointer moves or the
window changes size. The platform component's condition evaluator is shared by
all apps and widgets regardless of guest language.

### Evaluation

For the second stage the platform component keeps, for each dynamic condition
on a node, its last result and the keys it depends on. Three mechanisms keep
re-evaluation cheap:

- **Flags.** A table from a flag's key to the declarative conditions that test
  it. When a flag changes on a node, only those conditions re-evaluate (plus
  descendants in the same scope whose conditions read it through `under` or
  `within`).
- **Numbers.** The bounds that declarative `range` conditions give for one key
  on one node, sorted, divide the number line into intervals. The platform
  component remembers which interval the current value is in; a new value is
  compared against the two ends, and no `range` condition re-evaluates unless
  it has crossed a bound.
- **Window-component predicates.** When the platform component evaluates a
  `predicate(call)` against `borrow<style-node>`, every getter called on
  `style-node` records that key in the read-set for that run (a `u16` bitmask
  for built-in host states plus a small list of custom fact/property keys).
  Only predicates subscribed to a changed key re-evaluate; when a re-run takes
  a different branch, its recorded read-set replaces the old one (so
  short-circuited reads like `node.hovered && node.use(panelWidth) >= 600.0`
  unsubscribe from `panelWidth` while unhovered). Results are memoized per
  `(function, captures)` in a bounded read-check trie (with an LRU or per-frame
  cap on continuous float values like `width` and `scrollY`), so a thousand
  rows sharing an inherited `panelWidth` enter WebAssembly once per distinct
  input tuple and hit the cache in the platform component for the rest.

The native core keeps a small `watched_states` bitmask per render node derived
from those subscriptions. Pointer moves over unwatched nodes or scrolling in
containers with no scroll-watching rules stay entirely in Rust with zero WIT
calls; watched transitions flush in one batched call to the platform component,
which returns one batched diff of resolved built-in styles.

A window dragged from 801 to 802 pixels wide therefore costs two comparisons
for each width that has `range` conditions on it (and at most one batched
size-change notification for containers that publish size facts). This is the
property that makes a size condition usable during a resize.

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
  /// The subtree rooted at that node, stopping at the interior boundary of
  /// any nested widget.
  scope,
}

record rule-set {
  reach: reach,
  rules: list<rule>,
}

record node-def {
  // ... its layout, its style and the rest
  /// The rules attached to this node.
  rules: list<rule-set>,
}
```

A node carries its rules directly. Whether a node was created from a single
template, from several composed templates, or through a widget-independent node
API, the scope rule is the same: rules with reach `scope` attached to a node
apply throughout that node's subtree and stop at the lower boundary of any
nested widget. Only inheriting properties cross widget boundaries.

**Subtree and widget boundaries.** A widget owns the nodes it places (whether
from its root template, composed sub-templates, or direct node calls),
including the outer node of each child widget it instantiates or passes into a
slot. It does not reach into a child widget's interior: that interior belongs
to the child widget's scope.

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
pressed border combine, which whole-record state styles cannot do. The order is:

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

- A dynamic child binding (such as a `repeat` list or conditional branch)
  renders nested `@ui` templates into a slot. Those nodes belong to the widget
  that rendered them. The host keeps the answer for each pair of a rule set and
  a child template.
- A child widget's node has the facts the child's template fixed and the ones
  the parent set on it.

### Holes

A binding (written `hole` in the current WIT record) is a place in a template
that is filled in for each instance and can be filled in again later.
[Rules for templates and bindings](./zenafx-widget-authoring.md#rules-for-templates-and-bindings)
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
stylesheet to its node and gets the card's style without being a `Card`
widget. It can do so only if it holds the keys, so a stylesheet's tags are
shared on purpose: exported from the library that owns the stylesheet. In the
terms of
[What a predicate matches on](./zenafx-widget-authoring.md#what-a-predicate-matches-on),
a rule on a widget class's own tag is like naming a class, and a rule on an
exported tag is like naming an interface: any node can opt in.

The platform component is sent a stylesheet once, independently of any
template, and gets an ID that any node across the app can attach. There is no
structural coupling between a stylesheet and a template: a stylesheet applies
to the subtree rooted at the node it is attached to, stopping at nested widget
boundaries. When a subtree happens to come from a reusable static template
fragment, the platform component caches the Stage-1 static-tag matches per
`(stylesheet, fragment)` pair purely as an internal optimization.

A stylesheet is data, so a component written in Rust can attach one that a
Zena library defined, given the same records and handles to the same keys.

Two things a stylesheet cannot do, both for reasons already given.

- **Reach into another widget.** A card cannot style the content placed in it
  beyond the nodes it placed itself, and an application cannot restyle the
  inside of a widget it uses. A widget offers what it wants restyled as
  properties.
- **Count the children of a slot.** "Every second row" depends on which row a
  node is in. The host writes an `index` number fact on each child of a slot;
  a compiled window-component predicate (`node.index % 2 == 0`) tests it
  directly without adding a `remainder` case to the WIT condition grammar.

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

**Structural attachment is data; dynamic predicates can be compiled window
functions.** The first stage of a condition — matching fixed tags, `under`,
`within`, and widget scope boundaries — is declarative data so the platform
component resolves it without calling guest code. The second stage can use
either the small declarative tests (`flag`, `range`) or a pure function
compiled into a window component reading `borrow<style-node>`
([isolated-functions.md](./isolated-functions.md)), just like a style value
function.

## Window components

Styling and layout are extended with WebAssembly. Code that has to run during
a frame — a function over style values, a dynamic condition predicate, or a
layout algorithm — is a component of its own that the platform component runs
on the window's thread.

It is apart from the app or widget component because the window's thread never
waits for widget threads, which
[Alternatives considered](#alternatives-considered) goes into. Four rules
follow from where it runs.

- **It imports only the interface it serves.** A style function or condition
  predicate receives a `borrow<style-node>` resource exposing only the current
  node's facts and inherited properties (no `parent` or `children`), plus any
  captured immutable values, and returns a value (`bool` for a predicate). A
  layout algorithm measures and places children. It has no scene mutation, no
  files and no clock.
- **The platform component calls it directly**, on the window's thread, with no
  message and no wait.
- **Its functions are pure**: a result depends solely on the values read from
  `style-node` and the captures. The platform component records every getter
  read on `style-node` for invalidation indexing and memoizes results in a
  bounded read-check trie, may call in any order, and may make a second
  instance or a fresh one. Zena checks purity and captures at compile time
  ([pure-functions.md](./pure-functions.md),
  [isolated-functions.md](./isolated-functions.md)). In another language it is
  the author's promise, as it is for a worklet in CSS Houdini.
- **A call that runs too long is cut off**, and the declaration or condition
  that made it does not apply.

### The flow of a value

1. A widget component writes a value into the platform component (statically on
   a node or dynamically through a hole).
2. The platform component keeps the value on the node. If its property
   inherits, every node beneath can read it (crossing widget boundaries).
3. A declaration or condition on some node reads it, with `use` or via
   `node.use(key)` inside a window-component function.
4. The platform component resolves all properties — built-in and custom,
   inheritance and defaults — consistently in one place. For a window-component
   call it checks its bounded read-check trie and enters the window component
   only on a cache miss.
5. The platform component flushes the final flat resolved built-in property
   values down to the native core's render tree in a batch, and the native core
   lays out or paints as needed.
6. When a value changes, the platform component re-evaluates only the
   declarations and predicates subscribed to that key, hitting its memoization
   trie across nodes with equal inputs.

The widget component runs in step 1 and in no later step.

### Calling a function from a declaration or condition

A call is one more kind of value (and condition predicate), targeting a fixed
WIT world (`window-component` in
[isolated-functions.md](./isolated-functions.md#context-resources-and-runtime-dependency-tracking)):

```wit
variant value {
  // ... the cases under Declarations
  /// The result of a function that a window component exports.
  call(call),
}

record call {
  /// Entry ID dispatched by the window component's `eval-value` or
  /// `eval-predicate` export.
  function: u32,
  /// Immutable values (including key IDs) captured when the rule was built.
  captures: list<value>,
}
```

In source, a computed value or condition predicate is written as an isolated
function over `StyleNode`:
`background: (node) => lighten(node.use(accent), 0.2)` or
`When((node) => node.hovered && !node.fact(disabled))`. The compiler verifies
purity and captures, extracts the function and its pure callees into the
widget's window component, and emits the `call` record above
([isolated-functions.md](./isolated-functions.md#type-representation)). A color
library exports one pure `lighten(color, amount)` function, which runs in the
widget component on constant colors and in the window component when called
inside a `(node) => ...` style function. Non-Zena guests implement the same
`window-component` WIT world directly without any compiler plugin or macro.

### What is not designed

- **How a window component reaches the platform component.** A widget names the
  ones it uses, and two widgets that name the same one share an instance. Where
  the bytes come from is the question
  [zenafx-navigation-and-assets.md](./zenafx-navigation-and-assets.md) asks of
  every asset.
- **Packaging compiler-generated window components.**
  [isolated-functions.md](./isolated-functions.md) designs how the compiler
  extracts pure style functions and predicates into a window component; whether
  those bytes ship as a sidecar component or bundled inside the widget
  component is still open.
- **The cost of a call** from the platform component into a window component on
  its own thread, including `borrow<style-node>` getter reads on cache misses.
  Nothing has measured it, and it decides how small a predicate is worth
  running in a window component versus a declarative `flag`/`range` test.

## What the platform component keeps

A window can hold a thousand instances of one widget, each mentioning the same
properties and carrying the same rules. A further instance should cost a few
table lookups and no new copy of anything that is the same as before. Five
tables (plus the Stage-2 predicate subscription/memoization tables under
[Evaluation](#evaluation)) do that, each keyed by what its entries have in
common.

1. **Keys, once for a window.** The table of keys described under
   [Where definitions live](#where-definitions-live), each with its
   definition. A component's `declare` makes or finds each of its keys once,
   which gives a table from the component's positions to the window's
   numbers. Rules and stylesheets are rewritten to the window's numbers
   when they arrive. No instance and no node holds anything about a
   definition.
2. **Rules, cached per static fragment.** When a subtree comes from a reusable
   static template fragment, the first stage's answer — which rules can apply
   to each slot in that fragment, in order — is cached once for that fragment
   (or `(stylesheet, fragment)` pair). Each rule's declarations are one block,
   held once and referred to by every node the rule applies to.
3. **Inheriting values, once for each distinct set.** The inheriting values
   in force at a node, ordinary and default, are a set that is never changed
   after it is made. A node that declares none of them uses its parent's set.
   A node that declares some gets a set made from its parent's, and the
   platform component keeps a table from a parent's set and a block of
   declarations to the set that results. So the buttons of one toolbar share
   one set, and two sets are compared by comparing two pointers.
4. **A node's values, once for each distinct outcome.** What a node's values
   are depends on two things: the blocks of the rules that apply to it and
   hold, and the set of inheriting values it starts from. The platform
   component keeps a table from that pair to the worked-out built-in values
   flushed to the native core. Two buttons in the same state under the same
   theme get the same entry, and the second is a lookup. Browsers keep the same
   table and call it a matched-properties cache.
5. **A subtree instance, once for each situation.** Every instance of a static
   fragment has the same nodes and the same rules. So the values of all of an
   instance's nodes can be kept together, under the fragment, the set of
   inheriting values at its root, what its parent declares for its node, and
   which of its conditions hold. A list of a thousand rows in the same state is
   then one entry, and each row after the first is one lookup. This last table
   is worth building only if a measurement of the fourth says so.

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
- **Opaque selector functions supplied by the widget component.** The platform
  component would call a function in the widget's instance with a navigable
  node handle to ask whether a node matches. The platform cannot tell what such
  a function reads, so it would have to call it again after any change nearby.
  A function that walks the tree would read content that belongs to other
  widgets, and a busy widget component would hold up hover feedback. Stage-2
  predicates in a window component
  ([isolated-functions.md](./isolated-functions.md)) avoid all three: the
  function runs on the window thread, receives a `borrow<style-node>` resource
  with no parent/child navigation, and records every key it reads on the
  resource for invalidation indexing and memoization.
- **Flat-parameter lifting and compiler read masks.** Scanning Zena predicates
  at compile time to rewrite them into per-predicate flat signatures or emit
  static built-in read masks avoids `borrow<style-node>` getter crossings on
  cache misses, but requires custom compiler analysis that non-Zena guest
  languages lack. Keeping `borrow<style-node>` as a single static WIT resource
  works uniformly for every language; see
  [isolated-functions.md](./isolated-functions.md#alternatives-considered).
- **A `@cond` macro serializing Zena expressions to a WIT condition AST.** A
  syntactic macro could rewrite `hovered && !disabled && panelWidth >= 600.0`
  into `all` / `negate` / `range` records. That removes builder verbosity for
  the operations in the fixed WIT grammar, while still requiring protocol
  additions for modulo, aspect ratios, or comparisons between two facts, and
  cannot look inside helper functions across modules. Extracting pure
  predicates into the window component handles arbitrary expressions and helper
  functions with the same machinery already needed for style value functions.
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
   `box-style`, `text-style`, `box` and `layout` become a rule set with the reach
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
  rest of the disabled style. Against that, they are not style anywhere else,
  and a rule that changes what `Tab` reaches is harder to find than a field.
- **Names for the terms.** "Declaration" and "rule" are CSS's, and
  "definition" is this document's. Whether to keep them is open.
- **Remainder tests.** With compiled window-component predicates, a host
  `index` fact lets authors write `node.index % 2 == 0` without a bespoke
  `remainder` test in WIT. Whether to add `even` and `odd` convenience flags
  for non-Zena guests that do not compile a window component is open.
- **A size condition on a node that sizes to its content.** The containment
  rules refuse it. Whether the template is rejected when it is defined, or the
  condition is treated as never holding, is undecided.
- **Platform component versioning and discovery.** The native binary bundles
  one or more platform components, and an app may declare the platform version
  it targets (loading a bundled version or downloading one on the fly), while
  each platform component declares the native core WIT version it requires. WIT
  package imports express exact semver versions (with semver-compatible
  matching in the linker) rather than arbitrary version ranges; how an app
  manifest or loader resolves compatible platform/core version ranges is open.
- **The cost of a call into a layout module**, as under
  [A custom algorithm](#a-custom-algorithm). It decides whether that design is
  worth making.
