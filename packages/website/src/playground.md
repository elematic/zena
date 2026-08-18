---
title: 'Playground'
layout: page.njk
description: 'Write and check Zena in the browser.'
---

Write Zena and check it in the browser. Nothing is uploaded — the language
server runs locally as a WebAssembly module in a background worker, so
diagnostics, completions, and hovers all come from the same self-hosted compiler
the CLI uses.

<zena-playground>
  <script type="sample/zena" filename="main.zena">
    import { add, greet } from './math.zena';
    export let main = () => {
      console.log(greet('Zena Developer'));
      console.log(`1 + 2 = ${add(1, 2)}`);
    };
  </script>
  <script type="sample/zena" filename="math.zena">
    export let add = (a: i32, b: i32): i32 => a + b;
    export let greet = (name: String): String => {
      return 'Hello ' + name + '!';
    };
  </script>
</zena-playground>

To build and run programs outside the browser, use the CLI:

```bash
zena run main.zena
```
