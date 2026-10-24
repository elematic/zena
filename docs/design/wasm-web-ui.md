# Wasm Web UI

## Status

- **Status**: Proposed, with a prototype. The protocol below is implemented
  by `packages/wasm-web-ui` (the JavaScript host, over lit-html) and by
  the `zena:web-templates` and `zena:web-elements` libraries (the Zena
  side), and exercised by the tests and demos in that package.
  [Implementation status](#implementation-status) says what is built.
- **Date**: 2026-10-19

## Overview

Wasm Web UI is a protocol between a WebAssembly module and a JavaScript
host for building web user interfaces in a sandbox. A module written in
any language that compiles to WebAssembly defines HTML custom elements
and the templates they render. The host, a small JavaScript library,
derives an `HTMLElement` class from each element the module defines and
renders the module's templates into the DOM. The module is isolated from
the page: it imports nothing that can reach a document, a script or the
network, and the host reads what the module produces through a fixed set
of exports.

The protocol has two layers. In the **template layer** a module returns a
template result: a template, which is a list of fixed HTML strings with
holes between them, and one value per hole. In the **elements layer** a
module exports a list of element definitions, each a tag, properties,
styles and a constructor, and implements the element lifecycle for the
instances the host constructs. The host updates the DOM with lit-html. A
standard DOM template API could take lit-html's place, since a template
result is the strings and values such an API would take.

A page instantiates a module with an ordinary `WebAssembly.instantiate`,
with the protocol's imports and the imports of the module's own runtime
merged into one import object. It then reads the module's definitions
through the module's exports and registers the elements its markup uses:

```js
import {createImports, compileOptions} from '@zena-lang/runtime';
import {ElementModule, webUiImports} from '@zena-lang/wasm-web-ui';

const zena = createImports();
const {instance} = await WebAssembly.instantiate(
  bytes,
  {...zena.imports, ...webUiImports()},
  compileOptions,
);
zena.attach(instance.exports);

const elements = new ElementModule(instance.exports);
const counter = elements.definitions.find((d) => d.tag === 'x-counter');
customElements.define('x-counter', elements.classFor(counter));
document.body.innerHTML = '<x-counter count="3"></x-counter>';
```

`webUiImports()` is the protocol's import module, named `wasm-web-ui`:
a request for an update, an event dispatch, and the event capabilities
the page grants. `createImports()` is the Zena runtime's import object
and has nothing to do with the protocol: a module written in Zena asks
its embedder for the Error stack hooks, Unicode case mapping and
`console`, and `attach` binds them to the instance. A module in another
language brings its own runtime's imports instead. `ElementModule` reads
the definition records through the module's exports, once. `classFor`
derives an `HTMLElement` subclass from a record: its constructor calls
the module's constructor export, its property accessors call the module's
getters and setters, and its lifecycle callbacks call the module's
lifecycle exports. The result is a custom element like any other, which
the page registers under the tag it chooses. The module in the example is
written in Zena ([The Zena side](#the-zena-side)); a module in any other
language exports the same functions.

The module never sees the DOM. It cannot reach a node it does not own, run
a script, or make a request, because it imports nothing that could do so.
It produces markup it wrote at compile time with values in the holes, and
lit-html treats those values as text, attribute values, properties or
event listeners according to where the hole sits, never as markup. An
element can ask for an update and dispatch an event from its own
instance, and nothing else. Anything more it needs, an input's value or
a key, is a capability the host grants as an import, which the host sees
before the module runs. The import list is the security model.

The page registers elements; the module does not. A module names the tags
it suggests and defines nothing in the page's registry. Where the browser
has scoped custom element registries, the host gives the module one of
its own, so its elements can use each other, and the page defines what
its own markup uses.

The same source renders on a server. The Zena libraries compile on every
target. On a target without a DOM, `renderElement` writes an element as
declarative shadow DOM with the markers Lit's hydration reads, and on the
page the host hydrates an element that arrives with that markup instead
of rendering it.

The protocol and its JavaScript host are named **Wasm Web UI**: the
package is `@zena-lang/wasm-web-ui`, every protocol export begins with
`webui_`, and the one import module is named `wasm-web-ui`. The Zena
libraries are `zena:web-templates` for templates and `zena:web-elements`
for custom elements. Nothing in the protocol names lit-html.

## Terms

- **Template**: the fixed part of a piece of UI, a list of strings. In Zena
  it is the `TemplateStringsArray` of a tagged template literal.
- **Hole**: a position between two strings of a template. A result supplies
  one value per hole.
- **Result**: a template plus one value per hole. `TemplateResult` in Zena,
  the object `html` returns.
- **Strings object**: the module-side object that stands for a template.
  Its identity is what tells the host it has seen the template before.
- **Host value**: a JavaScript value the module holds without looking
  inside it: a JS string, an event, a DOM node. `externref` in Wasm.
- **Module object**: an object the module made and the host holds without
  looking inside it: a result, a list, a listener. A Wasm GC reference.
- **Definition**: one custom element the module declares: a record with a
  tag name, properties, styles and a constructor, read once at
  registration.
- **Property**: one declared property of a definition: a name, a value
  kind, and the attribute that reflects into it, if any. A record too.
- **Instance**: one element of a definition, a module object the host keeps
  on the DOM element and calls the lifecycle on.
- **Projection**: a copy of host data, plain values only, that the host
  hands a module in place of a live object.
- **Handle**: the host's object for a module object of a module without
  Wasm GC, which names its objects with integers; one per id, released
  to the module when the page drops it ([Other languages](#other-languages)).

## Prior art

**lit-html** separates a template's fixed strings from its values, keys its
template cache on the identity of the strings array, and on re-render
commits only the values that changed. The protocol carries that same
split across the boundary: the values cross and the strings do not.
lit-html also decides, from the position of a hole, whether a value is
text, an attribute, a property, a boolean attribute or an event listener;
the protocol relies on that and carries no binding kinds of its own.

**Lit's `ReactiveElement`** schedules one update per microtask after any
number of property sets, then calls `render` once. The elements layer keeps
that: a property set inside the module calls one import, the host coalesces,
and `render` runs once.

**Blazor WebAssembly** sends a `RenderBatch`, the diff of a render tree, from
.NET to JavaScript, which applies it to the DOM. That is the nearest
existing system, and the difference is where the diff happens: Blazor diffs
in the module and ships DOM edits; here the module ships templates and
values and the host diffs values. Shipping values keeps the module ignorant
of the DOM, which the isolation requires, and it is cheaper whenever a
template has fewer holes than nodes, which is the usual case.

**Dioxus, Leptos and `sledgehammer-bindgen`** (Rust) batch DOM operations
into a byte buffer that a small JavaScript interpreter replays. They are
fast and give the module the whole DOM API. They trade isolation away,
and the module needs the DOM bindings to exist.

**Salesforce Lightning Web Security** isolates third-party components by
running their JavaScript in a sandboxed realm with a "distorted" DOM,
patching the platform so a shadow root behaves as a security boundary.
This design has the same goal. A module here has no DOM to distort, and
the boundary is the Wasm sandbox, which the engine enforces.

**ZenaFX's scene protocol** ([zenafx-ui.md](zenafx-ui.md)) renders Zena
widgets into a retained node tree across a component boundary with the same
three ideas: a template sent once and named by identity afterwards, holes
written with values, and listeners that stay in the guest. It writes holes
sparsely, because every value that crosses a canonical ABI call is copied.
Here values cross as references and strings cross once, so a render sends
every value and lets lit-html's `!==` check skip the unchanged ones.

**JS String Builtins** (`wasm:js-string`, shipped in Chrome 130, Firefox 134
and Safari 26.2) and **imported string constants** let a module hold
JavaScript strings as `externref` and have its literals supplied as
engine-interned constants at instantiation. On the `js` target every Zena
string is such a handle ([targets.md](targets.md)), so a template's strings
and a text value cross without a copy.

**A platform template API.** A proposal to give the DOM a native notion of a
template with holes, taking a strings array and values, is the longer-term
home for the host side. The result object the host builds today is
lit-html's `{strings, values}`; the same object is what such an API would
take.

## The template layer

### Values that cross

Three kinds of value cross from module to host, and the host treats each
as opaque:

| Kind          | Wasm type      | Examples                          | What the host does with it             |
| ------------- | -------------- | --------------------------------- | -------------------------------------- |
| Host value    | `externref`    | a JS string, an event, a DOM node | uses it as the JS value it is          |
| Module object | a GC reference | a result, a list, a listener      | passes it back to the module's exports |
| Number        | `f64`          | a count, a boolean as 0 or 1      | uses it                                |

A module object is never constructed by the host and never inspected; the
host only passes it to the module's own accessor exports. A host value is
never inspected by the module; it is stored and handed back. Strings are
host values because a JS string is the cheapest representation to render
with, and a module that keeps its strings as JS strings produces one
without copying bytes. A module that keeps strings in linear memory
produces them with one host call per string
([Other languages](#other-languages)).

### Strings

Every string crosses as a JavaScript string, an `externref` the host uses
as it is: a template's strings, a text value, a tag name, a property
name. The protocol has no accessor form for strings, a length export and
a code-unit export the host would read through, because the host would
then copy every string one call per code unit, and the module would hold
strings it cannot hand to the DOM without that copy.

How a module makes a JavaScript string is its own concern. A module with
Wasm GC gets them from the JS String Builtins (`wasm:js-string`,
standardized and shipped), which the engine supplies when the page
compiles the module with `builtins: ['js-string']`, and its literals
arrive through imported string constants, interned by the engine at
instantiation. That is what `compileOptions` in the example above turns
on; on the `js` target every Zena string is already such a handle, so
nothing is copied. A module with linear memory and no GC returns a
pointer to the bytes in its memory, and the host decodes them with
`TextDecoder` ([Other languages](#other-languages)). Either way a
template's strings are read once per template, so the cost falls on
text values alone.

### Exports

A module implementing the template layer exports these functions. `result`
and `list` are module objects; `strings` is the strings object; `i` is an
index. The exports read three kinds of module object, a result, a strings
object and a container of values, and are grouped below by the object they
read. Each export reads one field or makes one call, and the groups
together are what the host needs to build a lit-html result.

The protocol:

| Export            | Returns | Meaning                                     |
| ----------------- | ------- | ------------------------------------------- |
| `webui_version()` | `i32`   | The protocol version this module speaks: 1. |

A result: its template and its kind.

| Export                         | Returns        | Meaning                                                                     |
| ------------------------------ | -------------- | --------------------------------------------------------------------------- |
| `webui_result_strings(result)` | strings object | The template of a result. The same object every time for the same template. |
| `webui_result_type(result)`    | `i32`          | 1 for HTML, 2 for SVG, 3 for MathML.                                        |

A strings object: a count and two strings per index, because lit-html
requires the raw strings beside the cooked ones.

| Export                             | Returns                 | Meaning                                               |
| ---------------------------------- | ----------------------- | ----------------------------------------------------- |
| `webui_strings_count(strings)`     | `i32`                   | Number of strings; one more than the number of holes. |
| `webui_strings_at(strings, i)`     | `externref` (JS string) | The cooked string at `i`.                             |
| `webui_strings_raw_at(strings, i)` | `externref` (JS string) | The raw string at `i`, escapes unprocessed.           |

A container of values, a result's holes or a list: a count, a kind per
index, and the value, read through one of three accessors by its type.
There are three because the JS API cannot read a Wasm GC object's fields,
so a module object crosses as a reference, and no builtin turns a number
into an `externref`, so a number crosses as `f64`.

| Export                             | Returns       | Meaning                                                  |
| ---------------------------------- | ------------- | -------------------------------------------------------- |
| `webui_value_count(container)`     | `i32`         | Number of values in a result (its holes) or a list.      |
| `webui_value_kind(container, i)`   | `i32`         | The kind of value `i`, from the table below.             |
| `webui_value_extern(container, i)` | `externref`   | The host value for a `text` or `host` value.             |
| `webui_value_ref(container, i)`    | module object | The object for a `template`, `list` or `listener` value. |
| `webui_value_number(container, i)` | `f64`         | The number for a `number` value, 0 or 1 for a `boolean`. |

A listener: the one call the host makes into a value.

| Export                                   | Returns | Meaning                                       |
| ---------------------------------------- | ------- | --------------------------------------------- |
| `webui_listener_invoke(listener, event)` | nothing | Calls a listener with an event, a host value. |

Value kinds:

| Kind | Name       | Read with            | lit-html value                                   |
| ---- | ---------- | -------------------- | ------------------------------------------------ |
| 0    | `nothing`  | nothing to read      | `nothing`                                        |
| 1    | `text`     | `webui_value_extern` | the string                                       |
| 2    | `number`   | `webui_value_number` | the number                                       |
| 3    | `boolean`  | `webui_value_number` | `true` or `false`                                |
| 4    | `template` | `webui_value_ref`    | a nested `TemplateResult`                        |
| 5    | `list`     | `webui_value_ref`    | an array of values, read with the same accessors |
| 6    | `listener` | `webui_value_ref`    | an event listener function                       |
| 7    | `host`     | `webui_value_extern` | the host value, unchanged                        |

`webui_value_count`, `webui_value_kind`, `webui_value_extern`, `webui_value_ref` and
`webui_value_number` take either a result or a list as their container, so a
nested list is read the same way as the holes of a result.

The host reads a result in one pass: template, then kinds and values, then
recursively into nested results and lists. Each value costs two calls into
the module (kind, then the value) and a nested container costs one more for
its count. These are JavaScript-to-Wasm calls, which V8 inlines when the
signatures are simple ([host-interop.md](host-interop.md), "Strings"), and
nothing is allocated on the module side to answer them.

### Template identity

lit-html caches the prepared `<template>` element for a template under the
identity of its strings array, and when a result is re-rendered into a part
that already holds the same template, it commits the new values and touches
no structure. Across the boundary, the host recognizes a template by its
strings object.

The module returns the same object for the same template on every
render, and the host keeps a `WeakMap` from that
object to the `TemplateStringsArray` it built the first time. A Wasm GC
object handed to JavaScript keeps its identity: the engine represents it as
one JS object, so `===` holds between two crossings of the same reference
and a `WeakMap` finds it. The prototype checks this on Node 26
(`packages/wasm-web-ui/probe/probe.js`): the strings object from two
evaluations of one `html` call site compares equal and hits the map on the
second render. Because the map is weak, a template the module stops using
is collected with its strings object, and the host keeps no registry and
hands out no ids.

The first time the host sees a strings object it reads every string through
`webui_strings_at` and `webui_strings_raw_at`, builds a frozen array with a `raw`
property (lit-html refuses a strings array without one, which is its guard
against a forged template), and from then on the template costs one
`WeakMap` lookup per render.

A module that cannot keep template identity stable, because its language
has no stable object for a call site, can still implement the protocol by
returning a fresh strings object each time. Every render then re-reads the
strings and lit-html re-creates the template; correct, and slow in
proportion to the template's size. [Other languages](#other-languages) has
the cheaper alternative.

### Values and lit-html

The host builds a lit-html result object directly, `{_$litType$: type,
strings, values}`, which is what lit-html's `html` tag returns and what
`render` accepts. The values array holds, per kind: the string, the number,
`true`/`false`, `nothing`, a nested result built the same way, a JS array
for a list, a function for a listener, and the host value itself for `host`.

Where a value lands is decided by lit-html from the strings: text content,
an attribute (`class=${…}`), a property (`.value=${…}`), a boolean attribute
(`?disabled=${…}`), an event (`@click=${…}`) or an element (`${ref}` on a
tag). The module writes those prefixes in its template as it would in
JavaScript, and the protocol carries no binding information at all. A
`number` in a property position sets a number; in text it becomes text. A
`host` value exists so a module can put a host object it was given, say a
DOM node for `.node=${…}` or a `Date` for a child element's property,
back into the tree.

Comparing values is lit-html's job and works unchanged. A text value is a
JS string, compared by content; a number by value; a nested result by its
strings' identity and then its own values. So a re-render that changes one
hole updates one text node, exactly as in JavaScript.

### Rendering a result

A module that only renders templates exports functions that return
results, and the page renders them where it chooses. In Zena:

```zena
import { html, TemplateResult } from 'zena:web-templates';

export let greeting = (name: String, unread: i32): TemplateResult =>
  html`<p>Hello ${name}, you have ${unread} messages.</p>`;
```

```js
const host = new TemplateHost(instance.exports);
const {greeting, $stringCreate} = instance.exports;
host.render(greeting($stringCreate('Ada'), 3), document.body);
```

`TemplateHost` checks the module's protocol version and reads results
through the exports above: `host.result(ref)` is the lit-html result for
a module result, and `host.render` renders one into a container.
`$stringCreate` is the Zena module's own export, which wraps a JS string
as a Zena `String` for an export that takes one; the protocol's exports
take and return JS strings directly.

### Listeners

A listener is a module object the host calls through `webui_listener_invoke`.
The host wraps each listener it meets in a JS function that forwards to that
export with the event, and gives lit-html the wrapper.

The wrapper is kept stable per hole. A module whose `render` writes
`@click=${() => this.increment()}` makes a new closure on every render,
and a new wrapper for each new listener would make lit-html remove and
re-add the DOM listener every time. So the wrapper the host hands lit-html
for a given part holds the latest listener object in a mutable slot, and a
render that produces a new listener object updates the slot. lit-html sees
the same function, re-adds nothing, and the previous listener object
becomes garbage. The wrapper is a lit-html directive, which is how a value
keeps state for its part across renders.

The event crosses as a host value, so a listener holds an opaque reference
and can do nothing with it on its own. What it can do is whatever the host
imported for it: `event.target.value` is reachable only through an import
that reads it. [Capabilities](#capabilities) covers what the host grants;
`zena:web-templates` names a small fixed set.

### Lists and keyed repeats

A list value is a module object that answers the same `webui_value_*`
accessors as a result; the host turns it into a JS array of converted values
and lit-html renders it as a sequence of child parts, reusing parts by
position. That is lit-html's behaviour for a plain array and it is right for
most lists.

A keyed repeat, lit-html's `repeat` directive, reuses DOM by key rather than
by position so that reordering moves nodes instead of rewriting them. The
protocol has no kind for it yet; it would be a `list` with a key per item,
read through one more accessor, and the host would hand lit-html `repeat`.
Other directives (`cache`, `classMap`, `styleMap`, `live`) have the same
shape: a kind, an accessor or two, and a host-side mapping. They are left
for a later version, and nothing in the current kinds prevents adding them.

### Imports

A module that only renders templates needs no import from the host. Its
strings come from the engine (imported string constants, or its own memory),
and it answers the host's reads through exports. On the `js` target a Zena
module of this shape imports `env.captureStackTrace`, which the error
library uses to decorate an `Error` with a JS stack, and whatever else
its own code asks of the Zena runtime, such as number formatting through
the host. None of those imports reaches the page; the runtime supplies
them and grants nothing by them.

This is why the security model is simple to state: a module's import
section lists what it can reach, and for a template module it is empty.
The host does not have to trust a manifest the module wrote or reason
about what a DOM binding permits, because there is no DOM binding.

## The elements layer

### Definitions

A module exports its elements as a list of records. Each definition is a
tag, its properties, its styles and a constructor: the parts the page
reads once when it registers the element, and the part it calls to make
an instance. Each property is a record too, with a name, a kind and the
attribute that reflects into it. In JavaScript the unit of registration
is a class, but the page reads the static side of that class once at
registration, after which it is data; what remains on the class is the
lifecycle, which the instance carries.

A core module cannot export a record. It exports functions, globals,
tables, memories and tags. A global or a function result can carry a Wasm
GC struct or array, but the JS API keeps those objects opaque. So a record
crosses the way a template result does: as an opaque object the host
keeps as its handle, with one accessor export per field. The list is a
count and `at(i)`. A module that defines custom elements exports, beside
the template layer:

The list of definitions:

| Export                  | Returns    | Meaning                                              |
| ----------------------- | ---------- | ---------------------------------------------------- |
| `webui_element_count()` | `i32`      | Number of definitions.                               |
| `webui_element_at(i)`   | definition | Definition `i`, the record the accessors below read. |

A definition's record: one accessor per field, and the constructor.

| Export                                 | Returns        | Meaning                                                      |
| -------------------------------------- | -------------- | ------------------------------------------------------------ |
| `webui_definition_tag(def)`            | JS string      | The tag name the module suggests, or the empty string.       |
| `webui_definition_property_count(def)` | `i32`          | Number of properties.                                        |
| `webui_definition_property(def, i)`    | property       | Property `i`, a record.                                      |
| `webui_definition_styles(def)`         | JS string/null | The definition's stylesheet text, adopted by every instance. |
| `webui_definition_create(def)`         | instance       | The constructor: a new instance of the definition.           |

A property's record:

| Export                               | Returns   | Meaning                                                             |
| ------------------------------------ | --------- | ------------------------------------------------------------------- |
| `webui_property_name(property)`      | JS string | The property's name on the element.                                 |
| `webui_property_kind(property)`      | `i32`     | 1 text, 2 number, 3 boolean, 7 host, from the value-kind table.     |
| `webui_property_attribute(property)` | JS string | The attribute that reflects into the property, or the empty string. |

An instance's lifecycle: the vtable, one export per callback, each
taking the instance. An attribute change is its own call rather than a
property set because the attribute's text is converted by the property's
kind and the instance is told about the attribute.

| Export                                                      | Returns        | Meaning                                                    |
| ----------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| `webui_element_connected(instance)`                         | nothing        | The element was inserted into a document.                  |
| `webui_element_disconnected(instance)`                      | nothing        | The element was removed.                                   |
| `webui_element_attribute_changed(instance, property, text)` | nothing        | The property's attribute changed to `text`, a JS string.   |
| `webui_element_attribute_removed(instance, property)`       | nothing        | The property's attribute was removed.                      |
| `webui_element_render(instance)`                            | result or null | What the element shows now.                                |
| `webui_element_updated(instance, first)`                    | nothing        | The result was rendered; `first` is 1 on the first render. |

An instance's properties: a getter and a setter for each of the two
representations, `externref` and `f64`, since a number cannot cross as an
`externref`.

| Export                                                | Returns     | Meaning                                                  |
| ----------------------------------------------------- | ----------- | -------------------------------------------------------- |
| `webui_element_get_extern(instance, property)`        | `externref` | The property's value, for text and host properties.      |
| `webui_element_get_number(instance, property)`        | `f64`       | The property's value, for number and boolean properties. |
| `webui_element_set_extern(instance, property, value)` | nothing     | Set the property from a host value.                      |
| `webui_element_set_number(instance, property, value)` | nothing     | Set the property from a number.                          |

And imports, from the module named `wasm-web-ui`:

| Import                                  | Meaning                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `request_update(instance)`              | The instance's state changed; render it again before the next frame.                                                                 |
| `dispatch_event(instance, type, flags)` | Dispatch an `Event` of `type` from the element; `flags` holds bubbles, composed and cancelable. Returns 0 if a listener canceled it. |

`ElementModule`, constructed over the instance's exports, reads every
definition into a plain record: the tag, the properties with their
attributes, the styles, and `create`, which makes an instance carrying
the lifecycle calls bound to the module's instance object. Where a
definition is registered is the page's decision
([Registration](#registration)), and `classFor` derives the
`HTMLElement` class from the record:

- The constructor calls the record's `create`, keeps the instance on the
  element, attaches an open shadow root, and adopts the definition's
  stylesheet into it: one constructed `CSSStyleSheet` per definition,
  built from the record's styles on the first instance, or a `<style>`
  element per instance where constructed stylesheets do not exist.
- `static observedAttributes` is the record's.
- Each property becomes an accessor on the prototype that reads and
  writes the instance's property, converting to and from its kind.
- `connectedCallback`, `disconnectedCallback` and
  `attributeChangedCallback` forward to the instance's lifecycle.

Two alternatives were considered for the records, and a third is kept
for later. A JSON description of every definition, returned by one
export, would replace the accessors for the static side. But a definition
also holds references: its constructor, and the property records the
instance calls name. A description cannot carry those, so there would be
one channel for the data and another for the references, where the
accessors are one channel for both. A table of function references could
give each record its own functions, but the lifecycle is the same for
every definition and takes the instance, so there is nothing per record
to hold. A custom section could carry the static side. It would be
readable before instantiation, and it is the easiest form for a
toolchain that knows its definitions at build time. Zena's properties are
registered when the definition's probe instance is constructed, so the
compiler does not have them today; a class decorator that reads the
class it is applied to and emits a section at compile time, the macro
tier of [decorators.md](decorators.md), would. A host that found such a
section would skip the accessors for the static side. Until then the
prototype builds the data at run time, in one place.

### Updates

The module asks for a render and the host schedules it. A
property set inside the module, by the host through a setter export or by
the module's own code, calls `request_update(instance)`. The host records
the instance and schedules one microtask per instance, if none is pending;
the microtask calls `webui_element_render`, renders the result into the shadow
root, and calls `webui_element_updated`. Many property sets in one task produce
one render, which is Lit's `requestUpdate` and `performUpdate` with the
microtask on the host side of the boundary.

The first render happens on connection, so an element constructed and set
up before insertion renders once. An element that is not connected never
renders.

`webui_element_render` may return null, which renders nothing, for an element
that only exists to carry behaviour.

### Registration

A module names tags, because its templates have to, but it registers
nothing. Defining an element in the page's global registry affects the
whole document: a module that could do it could shadow or collide with
the page's own elements, and the module's imports would not show it. So
`ElementModule` reads the definition records and hands them back, each
with its suggested tag, and the page defines what its own markup uses,
under the module's tags or its own:

```js
for (const definition of elements.definitions) {
  if (definition.tag !== '') {
    customElements.define(definition.tag, elements.classFor(definition));
  }
}
const badge = elements.definitions.find((d) => d.tag === '');
customElements.define('page-badge', elements.classFor(badge));
```

A module's elements also use each other, in their templates, by the tags
the module chose. Where the browser has scoped custom element
registries, `ElementModule` defines every tagged definition into a
registry of the module's own, and the classes `classFor` derives attach
their shadow roots with that registry and clone template content through
it. The tags inside a module's templates then resolve to the module's
elements whatever the page defined, and the page's registry never hears
of them. Where scoped registries do not exist, `elements.registry` is
null, the shadow roots resolve from the document's registry, and the
page has to define the tags the module's templates use. A page can pass
`{registry: customElements}` to `ElementModule` to resolve from the
page's registry everywhere.

### The host-side class

The class the page registers is an ordinary `HTMLElement` subclass
derived from the definition record, with the properties and attributes
the record named. From outside, nothing says the element is backed by
Wasm: it is set up with properties, listened to with `addEventListener`,
and styled through its shadow root like any other custom element. The
lifecycle is in the protocol so that a page uses the element without
knowing what it is written in, and without adopting a framework. A host
that is not a custom element registry, a framework binding for instance,
works from the same record and the same instances, with no class to
unwrap.

## Capabilities

The module reaches the host only through its imports, so the imports are
the capability list. The template layer needs none; the elements layer needs
two, which can only schedule an update and dispatch an event from the
element's own instance.

Everything else is granted explicitly. An input element's value, the key of
a keyboard event, `preventDefault`, a `fetch`, `localStorage`: each is an
import the host chooses to provide, and the host sees the full list before
instantiation in the module's import section. `zena:web-templates` declares a fixed
small set for listeners, `event_target_value`, `event_key`,
`event_prevent_default` and `event_stop_propagation`, each imported only
when a listener calls it. A page that does not want a module reading
input values leaves `event_target_value` out
(`webUiImports({capabilities: [...]})` in the host), and the module fails
to instantiate, before it runs.

Two rules keep a grant scoped to the instance that received it. An import
that acts on an element takes the instance as its first argument, so the
host can check that the module is asking about an element it owns. And a
host value the module holds, such as an event, is opaque until an import
reads it, so holding one grants nothing.

### No generic member access

A module reaches only what it was given. A generic member-access import,
`get(object, name)` and its kin, breaks that however small it is: from
an event a module would walk to its target, from the target to the
document, from any object to its prototype and from there to `Function`,
and nothing in the import list would say so. So the protocol will not
grow one, and the generic JS interop layer of
[host-interop.md](host-interop.md) is a separate decision a host makes
with an allowlist, not something this protocol links.

What crosses into a module instead is data: strings, numbers, booleans,
and records and lists of them, projected by the host from the objects it
holds. A projection is a copy with no path back, so a module can read it
however it likes and reach nothing. Reading it is then the guest
language's own concern. A value the host hands over as a JSON string is
readable by any language with a JSON library; a value handed over as a
host object is readable through a few host functions that read only the
own data properties of a plain object or array and the primitives in
them, and refuse everything else: a function, a DOM node, anything with
a prototype other than `Object` or `Array`. Those functions walk nothing,
because the host built the value and the reader stops at its edge.

A denylist over a live object cannot be made complete. Blocking
`__proto__`, `Object.prototype` and `Function` leaves `constructor`,
which reaches `Function` too, and `Object.getPrototypeOf`, a getter, a
symbol-keyed property, an iterator, a `valueOf` that returns an object,
and a proxy. Every object with a non-plain prototype reaches further
still: an event's target is a node, and a node's document holds the
window. Object-capability work on JavaScript reached the same
conclusion: either the realm is hardened so that every reachable
intrinsic is powerless, or nothing but data crosses. An allowlist of
shapes is complete where a denylist of names is not. The reader's rule
is that a value is readable only if it is a primitive, or an own data
property, not an accessor and not symbol-keyed, of an object whose
prototype is `Object.prototype`, `Array.prototype` or null. A function
is never readable, so the module never holds one, never calls one, and
cannot reach `new Function`. `__proto__` is an accessor and
`constructor` is inherited, and both read as nothing. The host's
projection and the reader's rule each suffice alone, and both are kept:
the rule holds even for a value a host passed by mistake.

The four capability imports are that projection done by hand, one
import per field of an event. The intended form is one projection per
event the host grants, a record such as `{type, key}` or
`{type, target: {value, checked}}`, read by the module with its data
reader; the import list then shows which events a module handles and
the record shows what of each it sees. Zena needs the reader: a value
type over `externref` with `kind`, `string`, `number`, `field` and
`index` backed by the host functions above, which belongs in
`zena:js` and is the next piece of Zena's host interop. Until it exists
the per-field imports stay.

## The Zena side

### `zena:web-templates`

```zena
import { html, svg, nothing, TemplateResult, TemplateValue } from 'zena:web-templates';
```

`html` and `svg` are template tags returning a `TemplateResult`, which holds
the `TemplateStringsArray` and a `FixedArray<TemplateValue>` of the
interpolated values. The compiler already caches a `TemplateStringsArray`
per tagged-template call site ([templates.zena](../../packages/zena-compiler/zena/lib/codegen/ir/templates.zena)),
which is the template identity the protocol needs, so the library adds no
registry.

```zena
export type TemplateValue =
  String
  | TemplateResult
  | Iterable<TemplateValue>
  | ((event: Event) => void)
  | Box<i32> | Box<f64> | Box<boolean>
  | HostValue
  | null;
```

`null` renders nothing, and `nothing` is a `null` of that type for reading
clarity. A nested `TemplateResult` and an iterable of values map to the
protocol's `template` and `list` kinds. A function is a listener, invoked
with the event as an `Event`, an extension class over the host reference
with the capability imports as methods. `HostValue` wraps an `externref`
so a host value can sit in the union.

Generic interfaces are invariant in Zena, so a list has to be typed by the
union: `new GrowableArray<TemplateValue>()`, or a `map` whose callback is
declared to return `TemplateValue`. A `GrowableArray<TemplateResult>` is
not an `Iterable<TemplateValue>` and is rejected at the interpolation. A
covariant read-only `Iterable` would lift that, and is listed under
[Zena changes](#zena-changes).

The library exports the `webui_*` accessor functions of the template layer;
each is a `match` over `TemplateValue` on the indexed value, and the
library's own types are what the exports take, so the host cannot hand the
module anything the checker did not type.

A primitive in a hole is boxed by the compiler, because the tag accepts
its box: `${count}` with `count: i32` constructs a `Box<i32>`
([Zena changes](#zena-changes), item 2).

### `zena:web-elements`

```zena
import { ZenaElement, property, defineElement, html, css } from 'zena:web-elements';

class Counter extends ZenaElement {
  @property var count: i32 = 0;

  styles() {
    return css`button { font: inherit; }`;
  }

  render() {
    return html`
      <button @click=${(e) => { this.count += 1; }}>
        Count: ${this.count}
      </button>`;
  }
}

export let counterElement = defineElement('x-counter', () => new Counter());
```

That code relies on three language details:

- `render()` carries no return type. Methods do not infer a return type
  from their bodies, so an unannotated method is `void`, and the checker
  now makes one exception: an override takes the overridden method's
  return type. The listener's parameter is typed from its context too:
  the hole's value type is a union with one function member, and an arrow
  written there takes that member's parameter types. Both were checker
  changes made for this prototype; before them, the override checked as
  `void` and failed in lowering, and the arrow needed `(e: Event)`.
- `create` is a closure, `() => new Counter()`, because a class is not a
  value in Zena: there is no constructor reference to pass. A reference
  typed `() => Counter` is the smallest feature that would let this read
  `defineElement('x-counter', Counter.new, …)`; [Zena changes](#zena-changes)
  has it.
- The definition is a module-level `let` because a module body holds only
  declarations; the entry module's declarations run at start, so the
  definition is registered before the host reads it.

A module may also leave naming to the page: `declareElement(create)`
records a definition with no tag, and the page builds the class with
`elements.classFor(definition)` and registers it under any tag, in any
registry. In both cases the page registers. `defineElement`'s tag is a
suggestion, which the module's own templates use and the page may.

`ZenaElement` has `render`, the lifecycle methods `connected`,
`disconnected`, `attributeChanged` and `updated` with empty defaults,
`styles`, and `requestUpdate`, which calls the `request_update` import
with `this`. `styles` is Lit's `static styles` as a method: a static is
reachable only through the class name, and a definition has no class
value to reach it through, so the host reads `styles` once per definition
from the instance `defineElement` constructs. That costs what the static
costs: one stylesheet per definition. `css` builds the stylesheet from
`css` results and numbers, `unsafeCSS` from text the author vouches for,
as in Lit. The
`property` decorator stores the value and calls `requestUpdate` on every
write; Lit's `@property` also compares against the old value first, which
the decorator can add once equality on an unconstrained type parameter is
settled. `on ZenaElement` in its declaration is what lets it call
`requestUpdate` on the host ([decorators.md](decorators.md), "Constraining
the host").

`defineElement` records a definition: a tag and a factory. The properties
come from the class's decorators. `@property` and `@state` read their
`context`, the decorated field's name and its accessors as functions over
a `ZenaElement` ([decorators.md](decorators.md), "The decorated field's
context"), and register them while `defineElement` constructs one probe
instance; `@state` registers without an attribute. The host reads the
properties through the `webui_element_*` exports, and each property's kind
(text, number, boolean, host value) is decided from the probe's value for
it. The one Lit spelling still missing is the argument form,
`@property({attribute: 'count'})`, which waits on decorator arguments;
until then the attribute's name is the property's, lowercased.

`Event` is a class over the event's host reference whose methods are the
capability imports: `targetValue()`, `key()`, `preventDefault()`,
`stopPropagation()`. A host that leaves one of those imports out fails the
module at instantiation, which is where a capability refusal should
surface.

### Zena changes

The changes the prototype needed from the language, built or still
wanted, most important first.

1. **`externref` conversions.** `externref` is a type, kept separate from
   `anyref` as Wasm keeps it. Two things were missing and are fixed with
   this document: `x as externref` on a GC reference lowers to
   `extern.convert_any`, `e as anyref` on an `externref` lowers to
   `any.convert_extern` (both total, both no-ops in the engines), and
   `externref | null` emits `ref.null extern`. Before this, the checker
   accepted the casts and the emitter rejected them, and a nullable
   `externref` failed at emit. Wrapping a host value in a class (`String`
   does it for its handle, `HostValue` does it here) stays the way to put
   one into a union or a collection, since it keeps a static type where a
   conversion to `anyref` would leave an opaque reference to test on every
   read.

2. **Primitives in tagged templates.** `${count}` with `count: i32` was
   a type error when the tag's value type is a union of references,
   because nothing boxes it, and every number in a template was written
   `${new Box(count)}`. The rule, implemented with this document: a tag
   opts into boxing by accepting `Box<P>` among its values. When an
   interpolation is a primitive the tag cannot take as it is, and the
   tag's value type accepts its box, the checker records the box and
   codegen constructs it around the value
   (`tests/language/execution/strings/tagged-template-boxing.zena`); a
   tag that accepts no box for that type keeps the error. An untagged
   literal converts a primitive to text, so this is the second conversion
   the position has, and the opt-in is the tag's own signature rather
   than an annotation on it. The value's type is preserved, so
   `.value=${n}` sets a number and a text position shows text; converting
   to `String` instead would have lost that. `css` accepts `Box<i32>` and
   `Box<f64>` and gets the same treatment.

3. **The field's name and accessors, from its decorator.** `@property`
   has to register each field it is applied to, by name, with accessors
   the host can call on any element. A decorator body now reads
   `context`: the decorated field's name and its getter and setter as
   functions over the host ([decorators.md](decorators.md), "The
   decorated field's context"), built for this prototype. The property
   table that the first prototype wrote out by hand is gone;
   `defineElement` takes a tag and a factory. Decorator arguments
   (`@property({attribute: 'count'})`) remain to do
   ([decorators.md](decorators.md), "Not yet implemented").

4. **A class decorator or registration form.** `@customElement('x-counter')`
   is the remaining piece of the Lit surface; `defineElement` is its
   function form and is enough until class decorators exist.

5. **A data reader in `zena:js`.** The host projects an event to a record
   of plain data ([Capabilities](#capabilities)), and the module reads it
   with a value type over `externref` whose operations, `kind`, `string`,
   `number`, `field` and `index`, are host functions that read own data
   properties of plain objects and arrays and nothing else. The four
   capability imports become one projection per granted event, and
   `Event` here becomes a thin typed view over the record. The reader is
   the next piece of Zena's host interop and is not built.

6. **Stable method values.** `@click=${this.increment}` allocates a closure
   per render if a bound method value is a fresh object each time. The host
   side's stable wrapper per hole makes that correct and avoids DOM listener
   churn, so this is an allocation, not a behaviour; a per-instance cache of
   method values, as Dart's tear-offs have, would remove it.

7. **A template manifest.** The compiler knows every tagged template in a
   module. Emitting their strings into a custom section would let a host
   prepare every template at load time and let a reviewer read every piece
   of markup a module can produce without running it. The protocol is
   unchanged by it: a host that finds the section pre-fills its cache, keyed
   by the index the module then reports with the strings object.

8. **Server rendering.** A `TemplateResult` is a plain pair of strings
   and values, rather than something closer to lit-html's internals, so
   that a string renderer and the DOM host can share it, as Lit's server
   rendering does. `renderResult` and `renderElement` in
   `zena:web-elements` are that renderer
   ([Server rendering and hydration](#server-rendering-and-hydration)).
   `zena:http` has an `html` tag of its own that renders to a string with
   escaping and streaming; the two do not share a result type yet.

9. **A covariant read-only `Iterable`.** Generic interfaces are
   invariant, so a `GrowableArray<TemplateResult>` cannot be interpolated
   where an `Iterable<TemplateValue>` is accepted; the array has to be
   typed by the union, or built through `map` with a `TemplateValue`
   return type. `Iterable<T>` only produces `T`s, so reading it as an
   `Iterable<Super>` is sound; declaring that variance would let any
   array of results or strings be interpolated as it is.

10. **A constructor reference.** `defineElement` takes a factory closure
    because a class cannot be passed as a value. The general design is
    [classes.md](classes.md) §11, a class as a value behind an interface
    of its static side, backed by a static vtable. The elements library
    needs less: a reference to one constructor, `Counter.new`, typed as
    the function `() => Counter`, which the compiler can lower to the
    same closure the author writes today. Dart's constructor tear-offs
    are the precedent.

11. **Contextual typing of method signatures.** An override now inherits
    the overridden method's return type. A method implementing an
    interface member does not yet, nor do its parameters, so a class
    implementing `Iterable<T>` still spells out `[Iterable.iterator]():
Iterator<T>`. The same lookup against the implemented interfaces
    would cover it.

## Server rendering and hydration

Elements written for this protocol render on a server: a
`TemplateResult` is a pair of strings and values, with no DOM object in
it. The renderer writes what Lit's server renderer writes, so that Lit's
hydration picks the output up. It has four parts:

1. **One source, two hosts.** `zena:web-templates` and `zena:web-elements` compile on
   every target. What differs per host sits behind one internal file
   per library that the manifest chooses per target, the host file: on
   the js target the DOM host's imports and the crossings between a Zena
   string and a JavaScript one; on a server, `requestUpdate` does
   nothing, an event's capability methods throw, since no listener runs
   there, and so do the string crossings. The `webui_*` exports and the
   string renderer are shared files, and the compiler roots the exports
   on the js target only, so a server program never compiles them. An
   element module written once is built for the browser with
   `--target js` and linked into a server program as it is. The
   compiler's virtual-library tests hold the two host files to one API;
   they differ in `String`, which is itself per target, and the test
   records that gap as it records the standard library's other ones.
2. **A string renderer for `TemplateResult`** (`renderResult` and
   `renderElement` in `zena:web-elements`, from `web-elements/ssr.zena`). It
   scans a template's strings the way lit-html prepares them and writes
   the markup Lit's hydration reads: `<!--lit-part HASH-->` and
   `<!--/lit-part-->` around each result, where the hash is Lit's digest
   of the template strings (two 32-bit DJB hashes over the strings' code
   units, base64); `<!--lit-part-->…<!--/lit-part-->` around each child
   value; `<!--lit-node N-->` before an element whose start tag holds a
   binding, where `N` counts elements and comments in source order, a
   child binding being a comment node in lit-html's template. Bound
   attributes are written from the values: an attribute from the text,
   a boolean attribute by presence, a property only where it reflects to
   an attribute, an event never. A list renders item by item inside one
   part; `null` renders an empty part. Two things differ from Lit's
   renderer on purpose: `null` in an attribute omits the attribute, as
   Lit's `nothing` does, since `nothing` is `null` here; and a boolean
   bound to a reflecting property (`.checked`) reflects by presence
   rather than as the text `true` or `false`. A binding inside a
   comment, a raw text element or a tag name is reported.
3. **Elements as declarative shadow DOM.** `renderElement` writes the
   tag with its attributes, a `<template shadowroot="open"
shadowrootmode="open">` holding a `<style>` with the definition's
   styles and the rendered result, and the end tag. The attributes are
   applied to a fresh instance before it renders, as the host applies
   them on the page, so the markup matches what the page's instance
   renders from the same attributes. An element of the module's own met
   inside a template renders the same way in place, with
   `defer-hydration`, as Lit's renderer does.
4. **Hydration in the browser.** An element whose constructor finds a
   shadow root already attached, which declarative shadow DOM gives it
   before it upgrades, hydrates on its first update instead of
   rendering: `hydrate(result, root)` from `@lit-labs/ssr-client` walks
   the markers and attaches lit-html's parts, after which `render`
   updates in place. The server wrote the styles into that root, so
   none are adopted. An element carrying `defer-hydration` waits for the
   attribute's removal, which Lit's hydration performs for the elements
   inside a host it hydrated. The module's state matches the server's
   where the server rendered from the same attributes; state the server
   computed and did not put in an attribute is handed over the way Lit
   applications hand it over, in an attribute or a data script.

The protocol is unchanged by this. Two tests hold it to Lit:
`ssr_test.ts` renders the same templates through `@lit-labs/ssr` from
the js-target module's results and through `renderResult` from the
`zena-cli` build of the same file, and the outputs agree byte for byte;
`hydrate_test.ts` upgrades an element over the server's markup and
checks that the server's nodes stay, that a property set and a listener
then update them in place, and that no second stylesheet is adopted.
`packages/stdlib/tests/web-elements/ssr_test.zena` checks the digest against
Lit's and the element markup directly.

`demo/server.zena` is the demo rendered by a server written in Zena: the
same `elements.zena` the browser module is built from, linked into a
`zena:http` application that writes the page with every element as
declarative shadow DOM and serves the repository's files beside it; the
page then loads the module as `index.html` does and hydrates. A Rust
server would run the same component through wasmtime with the same
exports.

## Other languages

The protocol asks three things of a module: hand out references the host
can keep, keep one of them stable per template, and produce JavaScript
strings. A language with Wasm GC, such as Kotlin/Wasm, Dart or OCaml, has
all three the way Zena does: results and templates are objects, and
strings are either JS strings already or convertible through
`wasm:js-string`.

A language with linear memory and no GC, such as Rust or C, has none of
the three, and the protocol has an extension for it: the host implements
it in `linear.ts`, and a Rust module in `packages/wasm-web-ui/examples/rust`
exercises it. The host detects the extension from two exports, `memory`
and `webui_release`, and a GC module never reaches that code: the host it
runs through is unchanged.

### Ids and handles

The module names its objects with integers, nonzero, and the host keeps
the identity. The objects the host holds across calls are **owned**: a
template's strings, a listener, a definition, a property and an element
instance. The host makes one `Handle` object per owned id, the same
object for as long as anything on the page holds it, and registers it
with a `FinalizationRegistry` whose callback calls the module's
`webui_release(id)`. The module frees the object then, and may reuse the
id after. A result and the lists in it are **transient**: the host reads
a result completely before it calls into the module through anything
but the accessors that read it, so the module keeps results in an arena
it empties on entry to the next render, and their ids cross bare.

Two releases come sooner than the finalizer. A listener is held by the
part that renders it and replaced on the next render, and a module that
makes a closure per render would otherwise accumulate one per render
until the engine collects. The host counts the parts holding a listener
handle and calls `webui_release` when the count reaches zero, which for a
listener is the next render. A listener id is therefore the host's once
it is in a result: a module that wants one closure across renders makes
a new id around a shared one each time. The second is the event in a
listener call, which lasts for the call. An element instance is released
when the DOM element is collected, which only the finalizer sees; the
module's state for an element lives as long as the element, as a GC
module's does.

Finalization is not prompt, and it is not guaranteed before the page goes
away. The module leaks until it runs, bounded by what the DOM holds,
which is the bound `wasm-bindgen`'s weak-reference table accepts for
Rust objects JavaScript holds. The host unregisters a handle it releases
early, so `webui_release` is called once per id.

### Strings and host values

A string out of the module is a pointer to a `{ptr, len}` record of
UTF-8 bytes in its memory, which the host decodes with `TextDecoder`; 0
is null, or the empty string where the protocol has no null. A
template's strings are decoded once per template; a text value is
decoded per render, which is the cost `wasm-bindgen` pays for every
string. A string into the module goes through the module's
`webui_alloc(len)`: the host writes the bytes, passes the pointer and
length, and the module owns them from then on. A capability import that
returns a string writes it into a buffer the module passes with its
capacity and returns the full length, so a module whose buffer was too
small calls again with a larger one.

A host value the module holds is an id into a table on the host's side:
the event in a listener call, for the call, and a value the page set into
a `host` property, until the module calls the `extern_release` import.

The whole extension, beside the exports and imports above taking ids:

| Module side                                                            | For                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| export `memory`                                                        | the strings the host reads and writes                   |
| export `webui_alloc(len) -> ptr`                                       | bytes for a string the host passes in                   |
| export `webui_release(id)`                                             | the host dropped its last reference to an owned object  |
| export `webui_element_attribute_changed(instance, property, ptr, len)` | the attribute's text as bytes, in place of a JS string  |
| export `webui_element_set_text(instance, property, ptr, len)`          | a text property, in place of `webui_element_set_extern` |
| import `dispatch_event(instance, ptr, len, flags)`                     | the event type as bytes                                 |
| import `event_target_value(event, buf, cap) -> len`, `event_key`       | a string written into the module's buffer               |
| import `extern_release(id)`                                            | the module dropped a host value                         |

### A Rust module

`examples/rust` is a counter element over the support code a
`wasm-web-ui` crate would provide, `webui.rs`: the protocol's exports
over a slab of objects, templates, values, listeners and the element
trait. The element:

```rust
static COUNTER: Template = template!("<button ?disabled=", " @click=", ">", ": ", "</button>");

struct Counter { count: i32, step: i32, label: String, disabled: bool }

impl Element for Counter {
    fn render(&mut self, cx: &Context) -> Option<TemplateResult> {
        Some(html(&COUNTER, vec![
            self.disabled.into(),
            cx.on(|counter: &mut Counter, cx: &Context, _event: &Event| {
                counter.count += counter.step;
                cx.dispatch_event("count-changed", EventFlags { bubbles: true, ..Default::default() });
            }),
            self.label.clone().into(),
            self.count.into(),
        ]))
    }
}

static DEFINITIONS: [Definition; 1] = [Definition {
    tag: Some("x-rust-counter"),
    styles: Some("button { font: inherit; }"),
    properties: &[
        property!(Counter, count: i32),
        property!(Counter, step: i32),
        property!(Counter, label: String),
        property!(Counter, disabled: bool),
    ],
    create: new_counter,
}];
```

Three things differ from the Zena version, and each names a piece of
language support the Rust side lacks. A template is the list of strings
around the holes, written out, because Rust has no tagged template
literal; a procedural macro could split one literal at `${}` marks, and
the support code's `template!` is where it would go. A property is
declared beside the struct with `property!`, which writes the accessors
by downcasting the element; a derive macro over the struct's fields
would write them from attributes on the fields, as `@property` does in
Zena through `context`. A listener takes the element as its first
parameter, `cx.on(|counter: &mut Counter, cx, event| …)`, because a
closure cannot borrow the element it is made in; the support code finds
the element by the instance the listener was made for, and asks for a
render after the listener ran. The support code is about 900 lines,
most of it the exports, and would be a crate.

The module imports three functions, `request_update`, `dispatch_event`
and `extern_release`, the ones its code references; a capability import
appears only when a listener calls it, as in Zena. Built with
`opt-level = "z"`, `lto` and `panic = "abort"`, it is 32,794 bytes,
most of it the standard library's allocator and number formatting.

## Implementation status

Built, in `packages/wasm-web-ui`, `packages/stdlib/zena/web-templates`
and `packages/stdlib/zena/web-elements`:

- The host's API: `webUiImports()` for the import object, and
  `TemplateHost` and `ElementModule` over an instance's exports. The
  Zena runtime's `createImports()` supplies a Zena module's other
  imports, so a page instantiates a module with `WebAssembly.instantiate`
  and nothing of the host's is Zena-specific.
- The template layer: every export in the table, the host's reader, the
  lit-html result it builds, the `WeakMap` template cache, the stable
  listener wrapper.
- The elements layer: definitions as records read once, instances
  carrying the lifecycle, the class derived from a record at
  registration, properties with attribute reflection, styles as one
  constructed stylesheet per definition, the microtask update,
  `dispatch_event`. `ElementModule` defines nothing on the page, and
  gives the module a scoped registry of its own where the browser has
  them.
- `zena:web-templates` and `zena:web-elements` as described: `@property` and `@state`
  declare the properties through their `context`, `styles` and `css`
  carry the stylesheet, and `defineElement` takes a tag and a factory.
- Server rendering: `renderResult` and `renderElement` on the server
  targets, hydration in the host, a Zena demo server, and the tests that
  hold the renderer to Lit's.
- The linear-memory extension ([Other languages](#other-languages)) in
  the host, and a Rust counter element over it, with tests that drive it
  through the same host as the Zena modules.
- The `externref` conversions and `ref.null extern`, with portable tests.
- Tests under Node with a DOM (`happy-dom`) that compile Zena sources with
  the in-process compiler, instantiate them, and render through lit-html;
  and a browser demo page.

Compiler changes the prototype needed, beyond the `externref` ones:

- **Protocol exports.** A program that imports `zena:web-templates` or
  `zena:web-elements` exports their `webui_*` functions under their own names.
  Reachability roots exactly those (`isWebUiProtocolLibrary` in
  `stdlib-manifest.zena`, used by `analysis.zena` and
  `module-generator.zena`), the way `zena:js`'s completion entry points
  are rooted. A library's other exports are reached only when a program
  imports them, which is what keeps a template-only module's import list
  to the one Error-stack hook: rooting the whole library had reached
  `Event`'s methods and with them every capability import.
- **Tagged-template interpolations are type-checked.** The checker typed
  an interpolation against the tag's value type for adaptation but never
  checked assignability, so an `html` template interpolating an `i32`
  passed the checker and failed in lowering, and a
  `GrowableArray<String>` interpolated into `zena:http`'s `html` passed
  and trapped in the tag. Both are errors at the interpolation now
  (`tests/language/semantics/strings/tagged-template-value-type.zena`).
- **A tag's value type opts into boxing.** A primitive interpolation a
  tag accepts the box of is boxed by the checker and codegen (change 2
  above), which removes `new Box(…)` from every template.
- **Harvest names the global** it cannot find, and the function that
  referenced it.
- **A re-exported type resolves to its origin.** A module that
  re-exports a type it does not declare (`export {X} from`) used to find
  the export's type by name across every dependency model the compile
  had, so with `zena:http` and `zena:web-templates` both loaded, whichever
  `TemplateValue` came first answered for both. The origin is the export
  symbol's target across the re-export, and its canonical type is keyed
  by that symbol
  (`tests/language/execution/imports/reexport-same-name/`). Two more
  name-only identities went with it: a per-check cache of materialized
  declaration types keyed by the declaration's byte offset, now keyed by
  its node id, and the key a self-referencing alias stands for in
  codegen's type keys, which was the bare name and is now the name
  qualified by the declaring module.
- **An override inherits its return type** when written without one
  (`tests/language/execution/classes/override-inherits-return-type.zena`),
  and **an arrow takes its parameter types from a union context** with
  exactly one function member
  (`tests/language/semantics/functions/arrow-param-from-union-context.zena`).
  Together they remove every annotation from an element's `render` and
  its listeners.
- **A decorator body reads its field's `context`**: the field's name,
  and its getter and setter as functions over the host
  ([decorators.md](decorators.md), "The decorated field's context").
  Reachability mints one wrapper per accessor and application, and the
  host constructor binds the decorator's type parameter per
  application, since one class applies `@property` to fields of several
  types (`tests/language/execution/decorators/context.zena` and
  `context-generic.zena`). A mixin intermediate's `on` type now survives
  instantiation, which the wrappers' host parameter needed.

Found and not fixed, each with a reproduction:

- A decorator body does not see its module's variables, only its
  functions, so `registerProperty` is a function and the definition
  being probed is reached through one
  (`packages/wasm-web-ui/probe/decorator-module-variable.zena`).
- A member access that fails inside a call argument is reported twice
  (`packages/wasm-web-ui/probe/duplicate-diagnostic.zena`), with or
  without a decorator in sight.
- Assigning `null` to a module-level `var` after a null check in the same
  function fails to lower
  (`tests/language/execution/variables/assign-null-after-null-check.zena`,
  skipped).
- `x is Iterable<T>` is false for a value packed as that interface, while
  `match (x) { case Iterable as it: … }` matches it; the library uses
  `match`.
- `zena fmt` traps on a `decorator … on …` declaration
  (`tests/language/execution/decorators/on-clause.zena` reproduces it),
  and `zena lint` checks at the default target, so it skips a library
  that only resolves on `js`.

Not built: keyed repeats and other directives, the template manifest,
decorator arguments, a `host` value in a linear-memory module's template
(the id crosses; the Rust support code has no value type for it yet).

## Measurements

From the prototype, on Node 26 (V8 with Wasm GC and JS String Builtins),
at `-O1` unless stated. The sizes are of the whole module, standard
library included.

| Module                                                                                | Size                       | Host imports                                       |
| ------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| one `html` template with a listener (`probe/tpl-only.zena`)                           | 2,692 B                    | `env.captureStackTrace`                            |
| the demo's counter, todo and badge elements (`demo/elements.zena`), with their styles | 14,956 B (`-O2`: 12,950 B) | the stack hook, two capabilities, `request_update` |

The demo module imports `event_target_value` and `event_key` because its
listeners read them, and not `event_prevent_default`,
`event_stop_propagation` or `dispatch_event`, which nothing in it calls:
the import list is the capability list.

The Rust counter (`examples/rust`, release profile, no name section) is
32,794 B and imports `request_update`, `dispatch_event` and
`extern_release`; its size is the standard library's allocator and
number formatting, not the protocol.

Reading a result through the accessors, measured in
`templates_test.ts` over 200 repetitions of a 100-item list (two export
calls per value, one per nested container, one `WeakMap` lookup per
template):

| Work                                           | Time     |
| ---------------------------------------------- | -------- |
| one 100-item list, read into a lit-html result | 0.041 ms |
| per item                                       | 0.4 µs   |

So the boundary costs well under a microsecond per hole, and a render of a
few hundred values spends more time in lit-html's DOM work than in the
protocol.

Template identity, checked in `probe/probe.js`: the strings object from
two evaluations of one `html` call site is `===` on the JS side and hits a
`WeakMap` on the second render.

## Alternatives considered

**Full DOM bindings** (`web-sys`, `dart:html`). The module creates and
mutates nodes directly through imports. It is the fastest option when
the page and the module trust each other, and it gives up the isolation
this design exists for: every DOM capability is an import the host must
grant, and a module with `createElement` and `appendChild` can reach any
node it can get a reference to.

**Shipping DOM edits** (Blazor's `RenderBatch`, `sledgehammer`). The module
diffs and sends operations. The module then needs a DOM model of its own,
the host needs an interpreter, and the security boundary has to be enforced
by the interpreter checking every operation's target. Templates and values
need neither.

**Pushing values through imports.** Instead of the host reading a result,
the module could call `wasm-web-ui.value_text(s)`, `value_number(n)`,
`begin_list()` and so on while walking its result, and the host would
assemble the lit-html result as the calls arrive. The call count is the
same. It was rejected because it makes the template layer import a dozen
functions where it otherwise imports none, and because Wasm-to-JS calls are
the direction engines optimise less ([host-interop.md](host-interop.md),
"Strings").

**Numeric template ids.** The module could assign each template an integer
and the host could keep a map from id to prepared template. Ids need a
registry on one side or both, a lifetime for entries, and a way to free
them; the strings object's identity gives all three on a GC language, and
the linear-memory extension gives them to the others.

**Serializing results.** A result could cross as JSON or a byte buffer. A
string value would then be copied at least once, template identity would
have to be encoded, and listeners would need a table. Reading by accessor
keeps every string a reference and every listener an object.

**The component model.** A WIT interface for results would give a typed,
language-neutral contract. WIT has no function type for listeners, no
reference identity for templates (a `resource` per template would do, at a
handle per template per instance), and lifts every string into linear
memory on the way across. It fits the elements layer's lifecycle calls, and
a future version could offer the elements layer as a WIT world over the
same template layer; the template layer itself is better served by core
Wasm references.

## Open questions

- **Export naming.** Protocol exports are `webui_`-prefixed identifiers because
  a Zena export name is an identifier. A namespaced spelling such as
  `wasm-web-ui/value-kind` reads better in a specification; it needs an
  `export { f as 'name' }` form or a compiler-level rename.
- **`render` on the host or the module.** The host renders because that is
  where the DOM is. An alternative moves the lit-html call into a
  `webui_element_update` export driven by the module, which would let a module
  render into several roots; nothing needs it yet.
- **Directives.** Which of lit-html's directives get a kind. `repeat` is
  the first candidate; `classMap` and `styleMap` are expressible as text
  values today.
- **Attribute reflection back out.** Lit reflects a property to its
  attribute when asked (`reflect: true`). The protocol has no call for it;
  the host could do it from the setter if the definition said so.
- **Form-associated and other element capabilities.** `ElementInternals`
  and focus delegation are host-side features a definition could request
  by flag.
- **Projections and legibility.** With events projected to records, the
  import list names the events a module handles rather than the fields it
  reads; the record's shape is the host's. Whether a module should declare
  the shape it wants, so that the import list alone says what the module
  sees, is open.
- **Typed events from a module.** A module dispatches plain events; an
  event class with fields of its own waits on defining a JavaScript class
  from a module.

## Related

- [host-interop.md](host-interop.md): the generic JS interop layer, string
  crossing, and extern class declarations.
- [targets.md](targets.md): the `js` target, whose strings are JS string
  handles.
- [decorators.md](decorators.md): field decorators, and the arguments and
  class-level registration this design waits on.
- [zenafx-ui.md](zenafx-ui.md): the same decomposition across a component
  boundary for a native runtime.
- [signals.md](signals.md): the reactivity library a `@property` built on
  `Tracker` would use.
