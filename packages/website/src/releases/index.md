---
layout: page.njk
title: Releases
description: Install the standalone Zena CLI and VS Code extension, verify SHA-256 checksums, and browse prebuilt archives across macOS, Linux, and Windows.
---

<p class="lead">
  Standalone prebuilt binaries for the <code>zena</code> CLI and the
  <code>vscode-zena</code> Visual Studio Code extension, bundling the compiler,
  standard library, formatter, linter, test runner, and language service.
</p>

## Install the CLI

The installer detects your operating system and CPU architecture, downloads the
matching release archive, verifies its SHA-256 checksum against `SHA256SUMS`,
and installs `zena` into `~/.zena/bin`:

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

Set `ZENA_VERSION` to pin a specific release tag, or `ZENA_NO_MODIFY_PATH=1`
(`--no-modify-path`) to skip editing your shell profile:

<zena-code-group class="code-group">

<figure>
<figcaption>macOS &amp; Linux</figcaption>

```sh
curl -fsSL https://zena-lang.dev/install.sh | ZENA_VERSION=v0.0.1-preview.1 sh
```

</figure>

<figure>
<figcaption>Windows (PowerShell)</figcaption>

```powershell
$env:ZENA_VERSION = 'v0.0.1-preview.1'; irm https://zena-lang.dev/install.ps1 | iex
```

</figure>

</zena-code-group>

## Install the VS Code extension

Install [**Zena Language**](https://marketplace.visualstudio.com/items?itemName=zena-lang.vscode-zena)
from the VS Code Marketplace (works in VS Code Desktop and `vscode.dev`):

```sh
code --install-extension zena-lang.vscode-zena
```

Each release also attaches a self-contained `vscode-zena` `.vsix` package in
the release table below for offline or pinned installation via the `code` CLI
or **Extensions: Install from VSIX...**:

```sh
code --install-extension vscode-zena-v0.1.0.vsix
```

## JavaScript & WebAssembly packages (npm)

Zena's browser and Node.js packages are published to npm under `@zena-lang/*`
(`next` dist-tag for preview releases, `latest` for stable releases):

```sh
npm install @zena-lang/compiler@next @zena-lang/runtime@next
```

- `@zena-lang/runtime` — WebAssembly-GC host imports and `instantiate` / `run` helpers
- `@zena-lang/compiler` — `-O2` `compiler.wasm` (compiler, language service, formatter, and linter), TypeScript API, and bundled standard library (`stdlib/`)
- `@zena-lang/codemirror` — CodeMirror 6 Zena language support and themes
- `@zena-lang/playground` — `<zena-playground>` custom element and Web Worker compiler host
- `@zena-lang/wasm-web-ui` — DOM template and custom-element host for WebAssembly UI modules

## Direct downloads and checksum verification

Every release on [GitHub Releases](https://github.com/elematic/zena/releases)
attaches:

- Versioned CLI archives (`zena-v<version>-<target>.tar.gz` or `.zip`), the
  versioned VS Code extension (`vscode-zena-v<ext_version>.vsix`), and `.sha256`
  sidecar files
- Unversioned copies (`zena-<target>.tar.gz`, `.zip`, and `vscode-zena.vsix`)
  for stable
  `https://github.com/elematic/zena/releases/latest/download/<asset>` links once
  non-preview releases are published
- A combined `SHA256SUMS` manifest covering every archive and `.vsix` in that
  release

To verify a downloaded archive manually against `SHA256SUMS`:

<zena-code-group class="code-group">

<figure>
<figcaption>Linux</figcaption>

```sh
sha256sum --ignore-missing -c SHA256SUMS
```

</figure>

<figure>
<figcaption>macOS</figcaption>

```sh
shasum -a 256 --ignore-missing -c SHA256SUMS
```

</figure>

<figure>
<figcaption>Windows (PowerShell)</figcaption>

```powershell
Get-FileHash .\zena-v0.0.1-preview.1-x86_64-pc-windows-msvc.zip -Algorithm SHA256
```

</figure>

</zena-code-group>

## Release history

<zena-releases repo="elematic/zena"></zena-releases>
