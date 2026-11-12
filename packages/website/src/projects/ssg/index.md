---
title: 'Static Site Generator'
description: 'An idea-stage static site generator combining zena:workflow, Zebra, Zena Markdown, and WebAssembly plugins.'
status: 'Idea'
statusType: 'info'
lead: 'A planned static site generator built on zena:workflow and Zebra—bringing build-system task graphs, content-addressed caching, and language-agnostic WebAssembly plugins to content sites.'
---

::: info Early design idea
This project has not started implementation yet. Today [`zena-lang.dev`](/) is
built with Eleventy and served in production by a Zena HTTP server component
(`packages/website/zena/server.zena`). Our goal is to eventually build the Zena
websites with this static site generator once its core pieces are ready.
:::

Static site generators and build systems do almost the same job, yet most SSGs
invent a bespoke pipeline that struggles as sites grow—re-rendering unchanged
pages, running slow single-language plugins with full machine access, and
bolting asset bundlers onto the side via shell scripts.

We want to build a static site generator directly on top of [`zena:workflow`](https://github.com/elematic/zena/tree/main/packages/workflow)
and [Zebra](/projects/zebra/), treating site generation as a first-class
incremental build graph extensible with WebAssembly components.

## Static site generators as build systems

Look closely at what a static site generator does during a build or local edit
cycle:

- Discover input files (Markdown documents, front matter, data files, templates,
  stylesheets, images, and client code).
- Run a directed graph of tasks that parse, query, transform, bundle, and render
  those inputs into HTML, feeds, search indexes, and hashed static assets.
- Copy and stage output files into a deterministic directory layout.
- Watch inputs during development, recompute only the outputs affected by an
  edit, and serve the result locally.
- Cache expensive steps (syntax highlighting, API doc extraction, image
  encoding, diagram rendering) across runs and CI builds.

Those are the exact primitives of an incremental build system. When an SSG has
real per-step and per-output dependency tracking, editing one guide page only
reparses that Markdown file and re-renders that page—while leaving untouched
pages, API reference extraction, and unchanged search shards cached unless an
upstream layout, sidebar tree, or collection query actually changed digest.

## Workflows, Zebra, and Markdown

Several building blocks for this SSG already exist in the Zena repository:

- **`zena:workflow` (`packages/workflow`)** — Pure task-graph scheduling and
  early-cutoff memoization. Dynamic discovery lets an initial scan of Markdown
  front matter or API symbols register per-page render tasks and collection
  aggregations in the same graph.
- **Zebra (`packages/zebra`)** — Supplies SHA-256 content-addressed caching,
  `(mtime, size)` input memoization, parallel execution, watch mode, and
  supervised dev servers—so compiling a `.wasm` playground bundle, extracting
  stdlib docs from `.zena` source files, bundling CSS, and rendering HTML pages
  all live in one unified build graph instead of two stacked tools.
- **Zena Markdown (`packages/markdown`)** — A zero-copy CommonMark and GitHub
  Flavored Markdown parser written in Zena with five extension hooks (container
  blocks, leaf blocks, inline rules, post-link inline transforms, and AST
  transforms) and pluggable renderers.
- **Declarative templates and Zena HTTP** — Type-checked HTML templates in Zena
  alongside the existing Zena static/HTTP server used to preview and deploy
  generated sites.

## WebAssembly pipeline plugins

In JavaScript, Ruby, or Go SSGs, plugins are tied to the host language and run
with unrestricted filesystem and network permissions. Making site pipelines
extensible via WebAssembly components changes both properties:

- **Write plugins in any language** — A syntax highlighter in Rust, a math or
  diagram renderer in C++, an API doc extractor in Zena, or a feed generator in
  Go can all plug into the same site build via standard WIT interfaces for
  Markdown extensions, data sources, template helpers, and asset transforms.
- **Sandboxed, deterministic builds** — Because plugins receive only declared
  inputs and configuration values (with no hidden reads of arbitrary files,
  clocks, or network URLs unless explicitly granted), Zebra can safely cache
  plugin outputs by content hash and reproduce identical site builds on any
  developer machine or CI runner.

## Current status

The static site generator itself is still at the idea stage—there is no SSG
package in the repository yet. Its foundations (`packages/workflow`,
`packages/zebra`, `packages/markdown`, `zena:host/extensions`, and the Zena HTTP
server powering `packages/website`) are all active in the monorepo today. Once
Zebra's Wasm plugin API lands, the Zena documentation site itself will be the
first real-world testbed for migrating onto the new generator.

→ Related foundations: [Zebra](/projects/zebra/) ·
[`packages/workflow`](https://github.com/elematic/zena/tree/main/packages/workflow) ·
[`packages/markdown`](https://github.com/elematic/zena/tree/main/packages/markdown)
