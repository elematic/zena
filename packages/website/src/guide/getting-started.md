---
title: 'Getting Started'
description: 'Install the Zena toolchain, compile your first module, and run it under a WebAssembly GC runtime.'
---

::: warning Early development
Zena has not been published to a package registry yet. For now, getting the
toolchain means building it from the repository. This page will get much shorter
once releases exist.
:::

## What you need

Zena compiles to WebAssembly GC, so you need a runtime that supports it:

- **Node.js 25 or newer** — for the `host` target, via
  `@zena-lang/runtime`
- **[wasmtime](https://wasmtime.dev/) 24 or newer** — for the `wasi` target
- Any browser released since 2023, if you're shipping to the web

## Install the toolchain

Clone the repository and build:

```bash
git clone https://github.com/elematic/zena.git
cd zena
npm install
npm run build
```

That produces the CLI at `target/release/zena-cli`. Add a shell alias so the
rest of these docs read the way they eventually will:

```bash
alias zena="$(pwd)/target/release/zena-cli"
```

::: tip Nix users
The repository ships a flake with the full toolchain — Node, wasmtime, and
`wasm-tools`. Run `nix develop` (or let `direnv` do it) and everything is on
your `PATH`.
:::

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
<figcaption>host</figcaption>

```bash
# Core Wasm GC with console imports, for @zena-lang/runtime and the browser
zena build main.zena -o main.wasm --target host
```

</figure>

<figure>
<figcaption>wasi</figcaption>

```bash
# Core Wasm GC with WASI imports, for wasmtime and jco
zena build main.zena -o main.wasm --target wasi
wasmtime main.wasm
```

</figure>

</zena-code-group>

Type-check without emitting anything — this is the fast inner loop:

```bash
zena check main.zena
```

## Editor setup

The repository includes a VS Code extension with syntax highlighting and
language-server integration:

```bash
code --install-extension packages/vscode-zena
```

See [Editor support](/guide/editor-support/) for other editors and for running
the language server directly.

## Next steps

- [Your first program](/guide/first-program/) — build something with more than
  one line in it
- [Values and variables](/guide/values-and-variables/) — `let`, `var`, and why
  the default is immutable
- [CLI reference](/reference/cli/) — every command and flag
