---
title: 'Getting Started'
description: 'Install the Zena toolchain, compile your first module, and run it under a WebAssembly GC runtime.'
---

## Install Zena

Install the `zena` command, which has the compiler, the standard library,
the test runner and the rest of the tools in it:

<zena-code-group class="code-group">

<figure>
<figcaption>macOS &amp; Linux</figcaption>

```sh
curl -fsSL https://zena-lang.dev/install.sh | sh
```

</figure>

<figure>
<figcaption>Windows (PowerShell)</figcaption>

```powershell
irm https://zena-lang.dev/install.ps1 | iex
```

</figure>

</zena-code-group>

Then open a new terminal and check it:

```sh
zena --version
```

See [Install](/guide/install/) for the install script's options, the VS Code extension,
manual downloads and building from source.

`zena run` runs a program on its own, with the WebAssembly runtime it
bundles. To run Zena's output elsewhere you need a runtime with WebAssembly
GC:

- **Node.js 25 or newer**, for the `zena-js` target, with
  `@zena-lang/runtime`
- **[wasmtime](https://wasmtime.dev/) 48 or newer**, for the `component`
  target
- Any browser released since 2023, for the web

## Create a project

A Zena project is a directory of `.zena` files. Start with one:

```zena [main.zena]
export function main(): i32 {
  console.log('Hello from Zena!');
  return 0;
}
```

Zena has no globals, so even `console` is imported. Every name in a file is
either declared there or imported into it.

## Build and run

`zena run` compiles and executes in one step:

```bash
zena run main.zena
```

```
Hello from Zena!
```

To keep the module around, build it:

```bash
zena build main.zena -o main.wasm
```

Pick the target that matches where the module will run:

<zena-code-group class="code-group">

<figure>
<figcaption>zena-js</figcaption>

```bash
# Core Wasm GC with console and host runtime imports, for @zena-lang/runtime
zena build main.zena -o main.wasm --target zena-js
```

</figure>

<figure>
<figcaption>component</figcaption>

```bash
# A WASI 0.3 component, for wasmtime and any other component runtime
zena build main.zena -o main.wasm --target component
wasmtime run -S p3=y main.wasm
```

</figure>

</zena-code-group>

Type-check without emitting anything — this is the fast inner loop:

```bash
zena check main.zena
```

## Editor setup

The VS Code extension has syntax highlighting and the language server:

```bash
code --install-extension zena-lang.vscode-zena
```

See [Editor support](/guide/editor-support/) for other editors and for running
the language server directly.

## Next steps

- [Your first program](/guide/first-program/) — build something with more than
  one line in it
- [Values and variables](/guide/values-and-variables/) — `let`, `var`, and why
  the default is immutable
- [CLI reference](/reference/cli/) — every command and flag
