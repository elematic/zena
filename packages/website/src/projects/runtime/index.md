---
title: 'Zena CLI & Host Runtime'
description: 'Shared Wasmtime host crates and WIT interfaces extending WASI with process management, sandboxed Wasm plugins, stack traces, and caching.'
status: 'In progress'
statusType: 'success'
lead: 'The Zena CLI, zena-runtime crate, and zena:host WIT interfaces extend standard WASI with practical host capabilities—spawning processes, running sandboxed Wasm plugins, caching AOT code, and formatting stack traces.'
---

When we self-hosted the Zena compiler, build tool, and HTTP servers as
WebAssembly components, standard WASI (`wasi:cli`, `wasi:filesystem`,
`wasi:http`) covered basic files, clocks, sockets, and streams, but left gaps
that real developer tools and extensible servers hit right away: spawning child
processes with signal forwarding, compiling and running nested Wasm components,
loading untrusted plugins with resource limits, prompting for secrets safely,
and printing readable Wasm stack traces on crash.

To support the self-hosted toolchain without bloating the native binary, we
built a small layered Rust host (`zena-runtime`, `zena-run`, and `zena-cli`) and
a set of WIT interfaces (`zena:host`). While built for Zena today, these crates
and WIT contracts solve problems shared by any native CLI or server written as a
WebAssembly component.

## Extending WASI with zena:host

`packages/stdlib/zena/host-wit/host.wit` (`zena:host@1.0.0`) defines host
interfaces alongside WASI Preview 2 / 0.3:

- **`zena:host/process`** — Spawns child OS processes with explicit working
  directories and environment variables, manages Unix process groups, forwards or
  delivers `SIGINT`/`SIGTERM`, and supports streaming or inherited `stdio`—used
  by [Zebra](/projects/zebra/) to supervise build steps and dev servers.
- **`zena:host/wasm`** — Instantiates and runs child WebAssembly components from
  inside a guest component, mapping preopened directories and selective
  `zena:host` capability grants (`process`, `wasm`, `extensions`, `secrets`,
  `network`) per child, plus `precompile` for ahead-of-time `.cwasm` compilation.
- **`zena:host/extensions`** — Loads long-lived Wasm plugin components with
  capability attenuation, host-implemented WIT resource proxies, linear-memory
  ceilings, and per-call fuel/epoch timeouts.
- **`zena:host/stack-trace`** — Captures Wasm call frames from Wasmtime and
  resolves function names and DWARF / custom name sections into formatted stack
  traces when an unhandled exception or trap occurs.
- **`zena:host/http-server` and `zena:host/secrets`** — Provides multi-threaded
  HTTP request serving for Wasm server components (used by `zena-lang.dev` in
  production) and secret helpers such as no-echo terminal prompts and `0600`
  credential file creation.

## Layered host crates

The native Rust side is split into three small crates so production containers
never carry compiler weight:

| Crate / Binary      | Role                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zena-runtime`      | Library crate configuring Wasmtime (Wasm GC, Component Model, WASI 0.3 async), content-addressed `.cwasm` AOT caching on disk, and the `zena:host` linker bindings.                                   |
| `zena-run`          | Minimal standalone runner binary (~a few megabytes) that executes any precompiled `.cwasm` or `.wasm` component on `zena-runtime`—ideal for slim container images and deployed servers.               |
| `zena-cli` (`zena`) | Thin (~100-line) Rust entry point that embeds the self-hosted `zena.wasm` CLI component and delegates `build`, `run`, `test`, `fmt`, `lint`, and LSP commands to Zena code running on `zena-runtime`. |

Caching Wasmtime's compiled `.cwasm` artifacts keyed by engine version and input
digest lets self-hosted Wasm CLIs start in a few milliseconds without cold-JIT
overhead on every invocation.

## Sandboxed Wasm extensions

Several projects in the Zena ecosystem—[Zebra](/projects/zebra/) build plugins,
[AT Protocol PDS](/projects/pds/) policy hooks, and future
[Static Site Generator](/projects/ssg/) transforms—need a host component written
in Zena to load _another_ WebAssembly component as an untrusted plugin without
giving that plugin ambient host privileges.

`zena:host/extensions` solves this directly in the runtime:

- The parent component passes plugin `.wasm` bytes, resource limits (maximum
  memory bytes and per-call timeout milliseconds), and a declarative list of
  imported WIT functions or resource methods implemented by the parent.
- `zena-runtime` instantiates the plugin in a fresh Wasmtime `Store` with zero
  WASI filesystem or network authority unless explicitly wired, proxying calls
  between the parent component and the plugin across WIT value tables.
- Misbehaving plugins trap or time out cleanly and return structured error
  variants to the caller without crashing the host process.

## Generalizing beyond Zena

Right now `zena-runtime`, `zena-run`, and `zena:host` live inside the Zena
monorepo and carry `zena` naming and defaults tuned for Zena's Wasm GC +
Component Model toolchain. Generalizing them away from Zena will take time, and
that decoupling is not an immediate priority while the WASI 0.3 and Component
Model ecosystems are still settling.

Even so, nothing in `zena:host` is tied to Zena syntax or semantics: any
component compiled from Rust, Go, C++, Python, or Zena can import `zena:host`
WIT interfaces and run on `zena-run`. Over the longer term, as WASI standardizes
some of these surfaces and the remaining host extensions stabilize, `zena-runtime`
and its WIT packages can be published as a general-purpose Wasmtime host for
self-hosted CLIs, build systems, and plugin-driven servers.

→ Source: [`packages/zena-cli`](https://github.com/elematic/zena/tree/main/packages/zena-cli) ·
[`packages/stdlib/zena/host-wit/host.wit`](https://github.com/elematic/zena/blob/main/packages/stdlib/zena/host-wit/host.wit) ·
Design: [`docs/design/runtime-components.md`](https://github.com/elematic/zena/blob/main/docs/design/runtime-components.md)
