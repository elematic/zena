# @zena-lang/wasm-web-ui

The JavaScript host for the Wasm Web UI protocol: a WebAssembly module
returns templates and the values for their holes, and this package renders
them into the DOM with lit-html. A second layer defines custom elements
whose lifecycle the module implements.

The protocol is language-neutral; `zena:web-templates` and
`zena:web-elements` are the Zena libraries that implement it. The design
is in [docs/design/wasm-web-ui.md](../../docs/design/wasm-web-ui.md).

## Instantiating a module

A module is instantiated with a plain `WebAssembly.instantiate`. The
import object merges the protocol's imports, from `webUiImports()`, with
the imports of the module's own runtime. For a module written in Zena
those come from `@zena-lang/runtime`:

```js
import {createImports, compileOptions} from '@zena-lang/runtime';
import {
  TemplateHost,
  ElementModule,
  webUiImports,
} from '@zena-lang/wasm-web-ui';

const zena = createImports();
const {instance} = await WebAssembly.instantiate(
  await fetch('elements.wasm').then((r) => r.arrayBuffer()),
  {...zena.imports, ...webUiImports()},
  compileOptions,
);
zena.attach(instance.exports);
```

`webUiImports()` holds `request_update`, `dispatch_event` and the
capability imports the page grants; `webUiImports({capabilities: []})`
grants none. `createImports()` is what a Zena module asks of its embedder
beyond the protocol (the Error stack hooks, Unicode case mapping and
`console`), none of which reach the page, and `attach` binds them to the
instance. `compileOptions` turns on the JS String Builtins the module's
strings use.

## Rendering a template

```zena
// greeting.zena, built with `zena build greeting.zena -o greeting.wasm --target js`
import { html, TemplateResult } from 'zena:web-templates';

export let greeting = (name: String, unread: i32): TemplateResult =>
  html`<p>Hello ${name}, you have ${unread} messages.</p>`;
```

```js
const host = new TemplateHost(instance.exports);
const {greeting, $stringCreate} = instance.exports;
host.render(greeting($stringCreate('Ada'), 3), document.body);
```

`host.result(ref)` turns a module result into a lit-html `TemplateResult`;
`host.render(ref, container)` renders one. `$stringCreate` is the Zena
module's own export, which wraps a JS string as a Zena `String` for an
export that takes one; the protocol's exports take and return JS strings
directly.

## Custom elements

```zena
import { ZenaElement, property, state, defineElement, html } from 'zena:web-elements';

class Counter extends ZenaElement {
  @property var count: i32 = 0;
  @state var pressed: boolean = false;

  render() {
    return html`<button @click=${(e) => { this.count += 1; this.pressed = true; }}>Count: ${this.count}</button>`;
  }
}

export let counterElement = defineElement('x-counter', () => new Counter());
```

`@property` declares the field to the host as a property of the element,
reflected from the attribute of the same name in lowercase; `@state` is
internal state that re-renders but has no attribute. Both ask for a render
when written. The declaration happens through the decorator's `context`
(the field's name and accessors) while `defineElement` constructs one probe
instance, so nothing is listed twice.

A module exports its element definitions as records: a tag, the
properties with their attributes, the styles, and a constructor that makes
an instance carrying the lifecycle. `ElementModule` reads them through the
module's exports and defines none of them on the page. `classFor` derives
the `HTMLElement` class from a record, and the page registers it under
the tag the module suggests or one of its own:

```js
const elements = new ElementModule(instance.exports);
for (const definition of elements.definitions) {
  if (definition.tag !== '') {
    customElements.define(definition.tag, elements.classFor(definition));
  }
}
const badge = elements.definitions.find((d) => d.tag === ''); // declared without one
customElements.define('my-badge', elements.classFor(badge));
```

An element has the declared properties, reflects the attributes named for
them, adopts the definition's `styles` into an open shadow root, renders on
connection, and renders again once per microtask after the module asks for
an update. Where the browser has scoped custom element registries, the
module's tagged definitions go into a registry of the module's own, which
its elements' shadow roots resolve tags from, so the module's elements can
use each other in their templates without the page defining them;
`new ElementModule(exports, {registry: customElements})` resolves from the
page's registry instead.

## Modules without Wasm GC

A module that keeps its objects in linear memory, written in Rust or C,
names them with integers, and the host keeps the identity: one `Handle`
per object the page holds, released to the module's `webui_release` when
the page drops it. The page makes a `LinearMemory` before instantiating,
since the imports close over it, and hands it to the host it builds:

```js
import {
  ElementModule,
  LinearMemory,
  webUiImports,
} from '@zena-lang/wasm-web-ui';

const linear = new LinearMemory();
const {instance} = await WebAssembly.instantiate(bytes, webUiImports({linear}));
const elements = new ElementModule(instance.exports, {linear});
```

`examples/rust` is a counter element written this way, with the support
code a `wasm-web-ui` crate would provide, and `src/test/linear_test.ts`
drives it through the same host as the Zena modules. The extension is
specified in the design document under Other languages. A module that
uses Wasm GC never touches it.

## Server rendering

The same source renders on a server. `zena:web-elements` compiled for the
`zena-cli` or `component` target has no DOM host: `requestUpdate` does
nothing, an event's methods throw, and `renderElement` writes an element
as declarative shadow DOM with the markers Lit's hydration reads.

```zena
import { renderElement } from 'zena:web-elements';
import { counterElement } from './elements.zena';

let attributes = new Map<String, String>();
attributes['count'] = '10';
let markup = renderElement(counterElement, attributes);
// <x-counter count="10"><template shadowroot="open" shadowrootmode="open">
//   <style>…</style><!--lit-part …-->…<!--/lit-part--></template></x-counter>
```

On the page, an element that arrives with that shadow root hydrates on
its first update instead of rendering (`@lit-labs/ssr-client`), and
updates in place from then on. `demo/server.zena` serves the demo this
way from a server written in Zena:

```sh
./target/release/zena-cli run --dir . packages/wasm-web-ui/demo/server.zena
```

The renderer's output is held to `@lit-labs/ssr`'s byte for byte by
`src/test/ssr_test.ts`.

## What the module can reach

A template-only module imports nothing from this package. The elements layer
adds two imports, `request_update` and `dispatch_event`, which act only on
the module's own element instances. Reading an event (`event.target.value`,
`event.key`) goes through capability imports the page grants with
`webUiImports({capabilities})`; a module that imports one the page left
out fails at instantiation.

## Demo

```sh
npm run build:demo -w @zena-lang/wasm-web-ui
python3 -m http.server   # from the repository root
```

Then open `http://localhost:8000/packages/wasm-web-ui/demo/`.
