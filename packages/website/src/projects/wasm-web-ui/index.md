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

Chatty imperative DOM bindings (`createElement`, `setAttribute`, `appendChild`
per node) pay boundary-crossing overhead on every mutation and require the host
to expose mutable node handles.

Wasm Web UI crosses the boundary at the template level instead, modeled on
[`lit-html`](https://lit.dev/docs/libraries/standalone-templates/):

1. **Static template registration** — A tagged template literal registers its
   fixed HTML string array once with the host and receives an integer template
   ID. Because static strings come from compiled module data instead of runtime
   concatenation, the host parses each `<template>` once and clones it for new
   instances.
2. **Hole values per render** — On `render()`, the component sends the template
   ID together with an array of dynamic hole values: primitives, strings, nested
   template results, arrays of templates, or event handler IDs.
3. **Host diffing** — The JavaScript host (`@zena-lang/wasm-web-ui`, backed by
   `lit-html` on the client) updates only the DOM parts whose values changed.

In Zena, reactive custom elements use `@property` and `@state` decorators that
batch updates and emit `webui_*` lifecycle exports (`instantiate`, `connect`,
`disconnect`, `attributeChanged`, `render`, `handleEvent`):

```zena
import {html} from 'zena:web-templates';
import {Element, property, state} from 'zena:web-elements';

export class CounterElement extends Element {
  @property label: String = 'Count';
  @state count: i32 = 0;

  render() {
    return html`<button @click=${() => { this.count += 1; }}>
      ${this.label}: ${this.count}
    </button>`;
  }
}
```

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

Because components produce pure template descriptions and never call browser
APIs during `render()`, the exact same `.wasm` binary can be **server-side
rendered** in any server runtime that executes WebAssembly—Node.js, Deno,
Cloudflare Workers, or a native Wasmtime / Zena HTTP server. An SSR host
evaluates the component's initial properties, serializes its shadow root as
Declarative Shadow DOM (`<template shadowrootmode="open">`) with hydration
markers, and streams HTML that paints before client Wasm downloads.

## Current status and roadmap

Wasm Web UI is a working prototype in `packages/wasm-web-ui`, paired with
`zena:web-templates` and `zena:web-elements` in the Zena standard library.
Client-side template rendering, reactive properties, event dispatch, nested
templates, Wasm GC modules, and Rust linear-memory modules (`examples/rust`) all
run today with end-to-end Playwright tests.

Planned work includes:

- Server-side rendering and client hydration using Declarative Shadow DOM.
- Constructable stylesheet (`adoptedStyleSheets`) registration across the
  protocol boundary.
- Formalizing the wire ABI and WIT/core-Wasm specification so third-party
  language SDKs can target Wasm Web UI without depending on Zena packages.
- Stricter host policy hooks for URL sanitization and capability attenuation on
  rich attributes and slots.

→ Source: [`packages/wasm-web-ui`](https://github.com/elematic/zena/tree/main/packages/wasm-web-ui) ·
Design: [`docs/design/wasm-web-ui.md`](https://github.com/elematic/zena/blob/main/docs/design/wasm-web-ui.md)
