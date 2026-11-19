---
title: Install
description: Install the Zena CLI on macOS, Linux or Windows, add the VS Code extension, and verify downloads against their SHA-256 checksums.
---

The `zena` command is one file with everything in it: the compiler, the
standard library, the formatter, the linter, the test runner, the language
server and the package manager. Prebuilt binaries are published for macOS,
Linux and Windows.

## Install the CLI

The install script detects your operating system and CPU, downloads the
matching archive from the newest release, checks it against the release's
`SHA256SUMS`, installs `zena` into `~/.zena/bin` and adds that directory to
your `PATH`:

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

Open a new terminal, then check it:

```sh
zena --version
```

The newest release is the newest stable one, or the newest preview while
there is no stable release yet. To choose another:

| macOS & Linux (`sh -s --`) | Windows (PowerShell) | Environment variable    | Effect                                      |
| -------------------------- | -------------------- | ----------------------- | ------------------------------------------- |
| `--version <tag>`          | `-Version <tag>`     | `ZENA_VERSION=<tag>`    | Install that release, such as `v0.0.1`      |
| `--preview`                | `-Preview`           | `ZENA_PREVIEW=1`        | Install the newest release, previews too    |
| `--install-dir <dir>`      | `-InstallDir <dir>`  | `ZENA_INSTALL=<dir>`    | Install into `<dir>/bin`, not `~/.zena/bin` |
| `--no-modify-path`         | `-NoModifyPath`      | `ZENA_NO_MODIFY_PATH=1` | Leave your shell profile and `PATH` alone   |

<zena-code-group class="code-group">

<figure>
<figcaption>macOS &amp; Linux</figcaption>

```sh
curl -fsSL https://zena-lang.dev/install.sh | sh -s -- --version v0.0.2-preview.1
```

</figure>

<figure>
<figcaption>Windows (PowerShell)</figcaption>

```powershell
$env:ZENA_VERSION = 'v0.0.2-preview.1'; irm https://zena-lang.dev/install.ps1 | iex
```

</figure>

</zena-code-group>

To update, run the install command again. To uninstall, delete `~/.zena`,
and take `~/.zena/bin` out of your `PATH`: the line the script added to your
shell profile, or on Windows your user `Path` variable.

[Releases](/reference/releases/) lists every release, with its downloads and
release notes.

## Install the VS Code extension

Install [**Zena Language**](https://marketplace.visualstudio.com/items?itemName=zena-lang.vscode-zena)
from the VS Code Marketplace. It works in VS Code and in `vscode.dev`:

```sh
code --install-extension zena-lang.vscode-zena
```

Each release also has the extension as a `.vsix` file, for installing a
particular version or installing offline, with `code` or **Extensions:
Install from VSIX...**:

```sh
code --install-extension vscode-zena-v0.1.0.vsix
```

See [Editor support](/guide/editor-support/) for other editors.

## JavaScript and WebAssembly packages

The packages for browsers and Node.js are on npm, under `@zena-lang/`.
Preview releases have the `next` tag, and stable ones `latest`:

```sh
npm install @zena-lang/compiler@next @zena-lang/runtime@next
```

- `@zena-lang/runtime`: the host imports Zena modules need, and
  `instantiate` and `run`
- `@zena-lang/compiler`: the compiler as `compiler.wasm`, built at `-O2`,
  with the language service, the formatter and the linter in it; a
  TypeScript API; and the standard library (`stdlib/`)
- `@zena-lang/codemirror`: Zena for CodeMirror 6, with themes
- `@zena-lang/playground`: the `<zena-playground>` element, and its
  compiler in a Web Worker
- `@zena-lang/wasm-web-ui`: DOM templates and custom elements for user
  interfaces written in WebAssembly

## Download a release by hand

Every [GitHub release](https://github.com/elematic/zena/releases) has:

- the CLI for each platform, `zena-v<version>-<target>.tar.gz` (or `.zip`
  on Windows), and the extension, `vscode-zena-v<version>.vsix`, each with
  a `.sha256` file;
- copies without the version in their names (`zena-<target>.tar.gz`,
  `vscode-zena.vsix`), so that
  `https://github.com/elematic/zena/releases/latest/download/<file>` always
  names the newest stable release's;
- `SHA256SUMS`, the checksums of every file in the release.

To check what you downloaded against `SHA256SUMS`, in the same directory:

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
Get-FileHash .\zena-v0.0.2-preview.1-x86_64-pc-windows-msvc.zip -Algorithm SHA256
```

</figure>

</zena-code-group>

On Windows, compare the hash it prints with the file's line in
`SHA256SUMS`.

## Build from source

To run the newest code on `main`, build it from the repository. You need
Node.js 25 or newer and a Rust toolchain; the repository's Nix flake has
both (`nix develop`).

```sh
git clone https://github.com/elematic/zena.git
cd zena
npm ci
npm run build
```

The CLI is then `target/release/zena`.
