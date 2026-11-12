---
title: 'ZenaFX'
description: 'A capability-isolated graphical runtime where WebAssembly components render into a shared scene graph.'
status: 'Prototype'
statusType: 'warning'
lead: 'ZenaFX is a secure graphical runtime for WebAssembly components: isolated Wasm components write to a shared scene graph, pairing a Rust host runtime with a scene graph, layout, and styling engine in Zena.'
---

Graphical hosts usually pick between two extremes: native toolkits where every
widget shares one address space and full OS privileges, or embedded browser
views (`WebView` / Electron) that ship a complete HTML engine to isolate UI
plugins.

ZenaFX (`packages/zenafx`, CLI `zfx`) takes a third path built on the
WebAssembly Component Model. Untrusted or mutually distrusting Wasm components
compose into a single native window or surface by writing retained nodes into a
shared scene graph, while remaining isolated from one another and from the host
operating system.

## Isolation and the shared scene graph

In ZenaFX, an application—or an individual widget, panel, or embedded
micro-app—is a WebAssembly component instantiated with its own linear memories,
GC heap, and WIT capability table. Components never share memory and cannot
read or mutate nodes owned by sibling components.

To render UI, a component imports ZenaFX's WIT scene interfaces (`zenafx:host`)
and constructs reusable node templates with typed dynamic holes (text runs,
style attributes, layout properties, and child slots) plus event subscriptions.
When state changes, the component updates only the holes it owns.

Composition across trust boundaries uses capability handles: a parent component
creates a child container slot and passes just that slot capability to an
embedded child component. The child can populate and animate its subtree and
receive input events targeted at its nodes, without gaining visibility into the
surrounding window, sibling subtrees, clipboard, filesystem, or network. The
runtime stays idle (`ControlFlow::Wait`) between events and redraws only when a
component marks part of the scene dirty.

ZenaFX also supports low-level graphics components that import draft
`wasi:webgpu` and `wasi-gfx:surface` interfaces directly for custom 2D/3D
shaders alongside retained UI subtrees.

## Authoring components

In ZenaFX's current guest library (`examples/zenafx`), a widget class declares
its interior structure once as a `Template` and fills dynamic holes on each
render. A `Card` widget, for example, shares one template across every card on
screen while supplying its own title, accent style, and slotted child widgets:

```zena
import {Color, Align} from 'zenafx:ui/style';
import {
  Binding, BindingTarget, BindingValueContent, BindingValueTextStyle,
} from 'zenafx:host/scene';
import {Rendering, Widget} from './framework.zena';
import {box, slot, text, template} from './widget.zena';

let cardTemplate = template(
  box({style: cardStyle, align: Align.Stretch, gap: 10.0, padding: cardPadding}, [
    text('', titleStyle(surface)),
    box({style: wellStyle, align: Align.Stretch, padding: wellPadding}, [slot()]),
  ]),
  [
    new Binding(1 as u32, BindingTarget.Content),
    new Binding(1 as u32, BindingTarget.Style),
  ],
);

export class Card extends Widget {
  #title: String;
  #accent: Color;
  #content: Array<Widget>;

  new(title: String, accent: Color, content: Array<Widget>)
      : #title = title, #accent = accent, #content = content, super();

  build(): Rendering {
    return new Rendering(
      cardTemplate,
      [
        new BindingValueContent(this.#title),
        new BindingValueTextStyle(titleStyle(this.#accent)),
      ],
      [this.#content],
    );
  }
}
```

`Card` places `#content` into its `slot()` without seeing any scene node IDs
inside its children—the host projects child subtrees into the slot and sizes the
card around them in a single layout pass.

Today templates are built with helper calls (`box`, `text`, `slot`) and manual
breadth-first node indices (`1 as u32`) in the binding list. We may add JSX or a
declarative builder syntax to Zena so components can write trees with inline
bindings while the compiler extracts static templates and hole indices
automatically.

## Architecture: Rust host and Zena engine

ZenaFX splits responsibilities between a thin native host in Rust and a
self-hosted UI engine in Zena:

- **Rust core runtime** — Owns OS window creation and input loops, Wasmtime
  component instantiation and per-instance capability linkers, font discovery
  and text shaping, vector path rasterization, and GPU surface compositing.
  Keeping this layer small makes it easier to audit and port across native
  platforms.
- **Zena scene, layout, and styling engine** — Owns the retained scene graph,
  template instantiation, flexbox/grid-style layout calculation, style cascade
  and resolution, hit testing, and focus routing, compiled to WebAssembly GC.
  Writing the engine in Zena keeps high-level tree and style logic in a
  garbage-collected, type-safe language and lets the same compiled engine run on
  both native hosts and the web.

::: info Current prototype state
In the current monorepo prototype (`packages/zenafx`), the `zfx` Rust binary
already hosts both raw WebGPU components and retained-UI Zena components
(`counter` and `widgets` examples) with per-instance `Linker` isolation and
demand-driven redraw, while temporarily delegating layout and text measurement
to Rust crates (`taffy`, `parley`, `vello_cpu`, and `winit`). Migrating the
scene graph, layout, and styling layers from Rust into Zena is an active part of
the ZenaFX roadmap.
:::

## Target platforms and use cases

Because application components talk to abstract WIT scene and surface interfaces
instead of platform SDKs, the same compiled `.wasm` UI components can target
several environments:

- **Desktop and mobile apps** — Single-binary native shells via the Rust host on
  macOS, Linux, Windows, iOS, and Android, without bundling a browser engine.
- **Web applications** — Running the Zena scene, layout, and styling engine in
  the browser over a thin JavaScript + WebGPU/Canvas2D host adapter.
- **Micro-apps and plugin surfaces** — Hosting third-party extensions,
  dashboards, IDE panels, chat cards, or AI-generated interactive views inside a
  larger application with strict capability sandboxing and predictable memory
  footprints.

## Current status and roadmap

ZenaFX is an early prototype in `packages/zenafx`. Today `zfx run <component.wasm>`
opens a native window, wires WASI and `zenafx:host` WIT interfaces, renders
vector shapes and shaped text, and dispatches pointer and keyboard events to
Zena guest components.

Planned milestones include:

- Implementing the retained scene graph, layout solver, and styling engine in
  Zena and hosting it as a privileged engine component inside `zfx`.
- Exploring JSX or builder syntax in Zena for ergonomic template and binding
  authoring.
- Multi-component slot delegation so a host component can mount untrusted child
  components into subtrees with fine-grained capabilities.
- Hardware-accelerated GPU compositing on desktop and mobile, plus a browser
  host backend sharing the same WIT contract.
- Accessibility tree projection from the retained scene graph to platform
  accessibility APIs.

→ Source: [`packages/zenafx`](https://github.com/elematic/zena/tree/main/packages/zenafx) ·
[`examples/zenafx`](https://github.com/elematic/zena/tree/main/examples/zenafx) ·
Design: [`docs/design/zenafx-ui.md`](https://github.com/elematic/zena/blob/main/docs/design/zenafx-ui.md) ·
[`docs/design/zenafx-widget-authoring.md`](https://github.com/elematic/zena/blob/main/docs/design/zenafx-widget-authoring.md)
