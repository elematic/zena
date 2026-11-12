---
title: 'Wasm Web UI'
description: 'A protocol and host runtime for running isolated, multi-language web components in WebAssembly with declarative templates and SSR.'
status: 'Prototype'
statusType: 'warning'
lead: 'Wasm Web UI is a protocol and JavaScript host for building isolated web components in WebAssembly—giving untrusted components limited imports, no direct DOM access, declarative template rendering, and server-side rendering on any Wasm host.'
---

Standard custom elements in the browser run as ordinary JavaScript with ambient
access to `window`, `document`, `fetch`, cookies, `localStorage`, and every
other element on the page. Embedding a third-party or user-authored UI widget
means either trusting its code completely or isolating it inside a separate
`<iframe>` with awkward layout, styling, and communication boundaries.

Wasm Web UI (`packages/wasm-web-ui`, paired with Zena's `zena:web-templates` and
`zena:web-elements` libraries) defines a narrow ABI between a WebAssembly module
and a host renderer so custom elements can run inside the page's component tree
without direct DOM access or ambient browser APIs.

## Capability isolation and zero DOM access

Under Wasm Web UI, a component module is instantiated with only the WebAssembly
imports the host chooses to supply: the `wasm-web-ui` protocol callbacks plus
any explicit application capabilities (for example, a scoped data-fetching
function or formatter) passed by the embedder.

The Wasm module never receives references to DOM nodes, `window`, or `document`:

- **Shadow DOM encapsulation** — Each component instance renders into its own
  shadow root managed by the host. When the browser supports scoped
  `CustomElementRegistry`, child custom element tags registered by a module stay
  scoped to that shadow root instead of colliding on the global `customElements`
  registry.
- **Sanitized event projection** — When a user clicks a button or types into an
  input bound in a template, the host extracts structured event fields (such as
  input value, key code, or coordinates) and invokes the Wasm component's
  exported handler ID. Raw DOM `Event` objects and target elements never cross
  into the Wasm module.
- **Untrusted micro-frontends** — Because components cannot traverse parent
  nodes, read sibling shadow roots, or open network connections on their own,
  an application can safely mount plugin widgets, user-authored extensions, or
  AI-generated interactive components inline with first-party UI.

## Declarative templates across the boundary

Exposing imperative DOM APIs (`createElement`, `setAttribute`, `appendChild`,
`parentNode`) directly to WebAssembly modules has four drawbacks:

- **Large API surface area** — Binding the DOM's methods and properties inflates
  both the JavaScript host glue and the imports compiled into each Wasm module.
- **Boundary-crossing cost** — Fine-grained mutations cross the JS/Wasm boundary
  and touch handle tables on every node operation.
- **Harder security isolation** — Imperative node handles and traversal methods
  make it harder to stop a component from reading DOM state written by other
  code on the page.
- **Server-side rendering difficulty** — Imperative DOM code assumes a live,
  mutable tree and is very difficult to server-render without emulating a
  browser DOM.

Wasm Web UI crosses the boundary at the template level instead:

1. **Static template registration** — A tagged template literal registers its
   fixed HTML string array once with the host and receives an integer template
   ID. Because static strings come from compiled module data instead of runtime
   concatenation, the host parses each `<template>` once and clones it for new
   instances.
2. **Hole values per render** — On `render()`, the component sends the template
   ID together with an array of dynamic hole values: primitives, strings, nested
   template results, arrays of templates, or event handler IDs.
3. **Host template application** — The JavaScript host (`@zena-lang/wasm-web-ui`)
   diffs and updates only the DOM parts whose values changed. Client-side
   template application is currently backed by
   [`lit-html`](https://lit.dev/docs/libraries/standalone-templates/), and would
   ideally move to a standard browser DOM templating API in the future.

In Zena, reactive custom elements subclass `ZenaElement`, declare `@property`
and `@state` fields, attach scoped `css` stylesheets, and export element
definitions via `defineElement` or `declareElement`:

```zena
import {ZenaElement, property, defineElement, html} from 'zena:web-elements';

class Counter extends ZenaElement {
  @property var count: i32 = 0;
  @property var step: i32 = 1;

  render() {
    return html`
      <button @click=${(e) => { this.count += this.step; }}>
        Count: ${this.count}
      </button>`;
  }
}

export let counterElement = defineElement('x-counter', () => new Counter());
```

## Interactive example

Try editing `elements.zena`, `demo.js`, and `index.html` below—or open the
[Web Components example in the full-screen Playground](/playground/#example-web-components):

<zena-playground vertical preview allow-unused-variables>
{% include "wasm-web-ui-example-files.njk" %}
</zena-playground>

## Multi-language components and server-side rendering

The Wasm Web UI protocol is independent of Zena and supports two WebAssembly
memory models:

- **Wasm GC modules** — Languages targeting WebAssembly GC (such as Zena, Kotlin,
  or Dart) pass opaque `externref` / GC struct references for component instances
  and strings via JS String Builtins or host string helpers.
- **Linear-memory modules** — Languages targeting linear memory (such as Rust, C,
  C++, or Zig) identify component instances with `i32` handles and pass UTF-8
  slices out of exported `memory` buffers using the host's `LinearMemory`
  adapter. The repository includes a working Rust counter component alongside
  Zena components on the same page.

Because components produce declarative template descriptions and never call
browser APIs during `render()`, the same component definitions can be
**server-side rendered** in any server runtime that executes WebAssembly—Node.js,
Deno, Cloudflare Workers, or a native Wasmtime HTTP server.

`zena:web-elements` already supports SSR via `renderElement()`, serializing an
element's initial render as Declarative Shadow DOM
(`<template shadowrootmode="open">`) with hydration markers, while
`@zena-lang/wasm-web-ui` hydrates existing shadow roots on the client via
`@lit-labs/ssr-client` without re-rendering from scratch. The repository
includes a working SSR demo server written in Zena
([`packages/wasm-web-ui/demo/server.zena`](https://github.com/elematic/zena/blob/main/packages/wasm-web-ui/demo/server.zena)),
and building a Rust SSR demo server is on the roadmap.

## Current status and roadmap

Wasm Web UI is a working prototype in `packages/wasm-web-ui`, paired with
`zena:web-templates` and `zena:web-elements` in the Zena standard library.
Client-side `lit-html` template rendering, reactive `@property` and `@state`
fields, `css` constructable stylesheets (`adoptedStyleSheets`), sanitized event
dispatch, Wasm GC modules, Rust linear-memory modules (`examples/rust`), and a
Zena SSR + client hydration demo (`demo/server.zena`) all run today with unit
and Playwright tests.

Planned work includes:

- Building a Rust SSR demo server alongside the existing Zena server demo.
- Designing capability-safe host bridges for browser observation and layout
  APIs—such as `MutationObserver`, `ResizeObserver`, and computed styles
  (`getComputedStyle`)—without exposing raw DOM nodes.
- Moving client-side template application from `lit-html` to a standard browser
  DOM templating API as browser standards mature.
- Formalizing the wire ABI and WIT/core-Wasm specification so third-party
  language SDKs can target Wasm Web UI without depending on Zena packages.
- Stricter host policy hooks for URL sanitization and capability attenuation on
  rich attributes and slots.

→ Source: [`packages/wasm-web-ui`](https://github.com/elematic/zena/tree/main/packages/wasm-web-ui) ·
[Playground example](/playground/#example-web-components) ·
Design: [`docs/design/wasm-web-ui.md`](https://github.com/elematic/zena/blob/main/docs/design/wasm-web-ui.md)
