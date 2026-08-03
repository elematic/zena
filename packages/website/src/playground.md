---
title: 'Playground'
layout: page.njk
description: 'Write and check Zena in the browser.'
---

Write Zena and check it in the browser. Nothing is uploaded — the language
server runs locally as a WebAssembly module in a background worker, so
diagnostics, completions, and hovers all come from the same self-hosted compiler
the CLI uses.

<zena-playground></zena-playground>

To build and run programs outside the browser, use the CLI:

```bash
zena run main.zena
```
