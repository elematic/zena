---
title: 'Playground Test Bed'
layout: page.njk
permalink: '/_dev/playground/'
description: 'Test bed for single-file, multi-file, and detached playground layouts.'
---

This page tests the `<zena-playground>`, `<zena-project>`, `<zena-tab-bar>`, `<zena-file-editor>`, and `<zena-output>` components under various configurations.

## 1. Single File Playground

A standard `<zena-playground>` with a single `main.zena` file.

<zena-playground>
  <script type="sample/zena" filename="main.zena">
    export let main = () => {
      let message = 'Hello from single-file Zena playground!';
      console.log(message);
      let sum = 10 + 20 + 30;
      console.log(`Sum: ${sum}`);
    };
  </script>
</zena-playground>

---

## 2. Multi-File Playground

A `<zena-playground>` with multiple files (`main.zena`, `math.zena`, `greeter.zena`).

<zena-playground>
  <script type="sample/zena" filename="main.zena">
    import { add, multiply } from './math.zena';
    import { formatGreeting } from './greeter.zena';
    export let main = () => {
      console.log(formatGreeting('Zena Developer'));
      console.log(`add(5, 7) = ${add(5, 7)}`);
      console.log(`multiply(6, 7) = ${multiply(6, 7)}`);
    };
  </script>
  <script type="sample/zena" filename="math.zena">
    export let add = (a: i32, b: i32): i32 => a + b;
    export let multiply = (a: i32, b: i32): i32 => a * b;
  </script>
  <script type="sample/zena" filename="greeter.zena">
    export let formatGreeting = (name: String): String => {
      return 'Welcome, ' + name + '!';
    };
  </script>
</zena-playground>

---

## 3. Detached Editor & Output (Inline in Prose)

In this layout, the `<zena-project>` manages the virtual file system and language service independently. The `<zena-tab-bar>` and `<zena-file-editor>` are placed above the explanatory text, while the `<zena-output>` (with integrated status indicator, Run button, and Clear button) is placed below the prose.

<zena-project id="detached-demo">
  <script type="sample/zena" filename="main.zena">
    import { fibonacci } from './fib.zena';
    export let main = () => {
      console.log('Calculating Fibonacci sequence:');
      for (var i = 0; i <= 8; i += 1) {
        console.log(`fib(${i}) = ${fibonacci(i)}`);
      }
    };
  </script>
  <script type="sample/zena" filename="fib.zena">
    export let fibonacci = (n: i32): i32 => {
      if (n <= 1) return n;
      return fibonacci(n - 1) + fibonacci(n - 2);
    };
  </script>
</zena-project>

<div style="margin: 1.5rem 0; border: 1px solid var(--rad-neutral-stroke-faint, rgba(255, 255, 255, 0.1)); border-radius: 8px; overflow: hidden; background: #1e293b;">
  <zena-tab-bar project="detached-demo"></zena-tab-bar>
  <zena-file-editor project="detached-demo" style="height: 240px;"></zena-file-editor>
</div>

### Interactive Execution

The code above imports the `fibonacci` recursive function from `fib.zena` and computes the first 9 Fibonacci numbers. Both the tab bar and the editor above are bound to the `detached-demo` project.

You can edit either file above, switch tabs, change themes, or add new files. When you're ready, click the **Run** button in the console below or press <kbd>⌘↵</kbd> / <kbd>Ctrl+Enter</kbd> to execute!

<zena-output project="detached-demo" style="margin: 1.5rem 0; height: 180px;"></zena-output>

---

## 4. Vertical Layout Playground (`<zena-playground vertical>`)

A `<zena-playground>` with the `vertical` attribute (or `layout="vertical"`), placing the editor on top and the output console pane on the bottom.

<zena-playground vertical>
  <script type="sample/zena" filename="main.zena">
    export let main = () => {
      console.log('Vertical layout demo:');
      for (var i = 1; i <= 5; i += 1) {
        console.log(`Step ${i}: ${(i * (i + 1)) / 2}`);
      }
    };
  </script>
</zena-playground>

---

## 5. Multi-File with Opt-in Palette Theme Selector

A multi-file `<zena-playground>` with `show-theme-selector`, featuring the palette icon dropdown.

<zena-playground show-theme-selector>
  <script type="sample/zena" filename="main.zena">
    import { square } from './math.zena';
    export let main = () => {
      console.log(`square(8) = ${square(8)}`);
    };
  </script>
  <script type="sample/zena" filename="math.zena">
    export let square = (x: i32): i32 => x * x;
  </script>
</zena-playground>
