---
layout: page.njk
title: Releases
description: Install the standalone Zena CLI, verify SHA-256 checksums, and browse prebuilt archives across macOS, Linux, and Windows.
---

<p class="lead">
  Standalone prebuilt binaries for the <code>zena</code> CLI, bundling the
  compiler, standard library, formatter, linter, test runner, and language
  server.
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

## Direct downloads and checksum verification

Every release on [GitHub Releases](https://github.com/elematic/zena/releases)
attaches:

- Versioned archives (`zena-v<version>-<target>.tar.gz` or `.zip`) and `.sha256`
  sidecar files
- Unversioned copies (`zena-<target>.tar.gz` or `.zip`) for stable
  `https://github.com/elematic/zena/releases/latest/download/zena-<target>.<ext>`
  links once non-preview releases are published
- A combined `SHA256SUMS` manifest covering every archive in that release

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
