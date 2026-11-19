---
title: 'Zena CLI Preview Releases and a Distributed Package Manager'
description: 'Announcing the first prebuilt Zena CLI releases, a distributed package manager built on AT Protocol, and our initial set of packages.'
date: 2026-11-19T18:00:00Z
author: justinfagnani
tags:
  - announcements
hero:
  image: 'https://images.unsplash.com/photo-1510681916233-314f497f3301?auto=format&fit=crop&w=1600&q=80'
  alt: 'Aerial photo of a shipping container lot'
  credit: 'Photo by Ammiel J Wan on Unsplash'
---

Today we're excited to announce the first prebuilt releases of the `zena` CLI,
the launch of the Zena package manager at
[pkg.zena-lang.dev](https://pkg.zena-lang.dev), and our initial set of published
packages.

Until now, trying Zena meant either using the [browser playground](/playground/)
or cloning the repository and building the toolchain from source. With prebuilt
binaries for macOS (Apple Silicon), Linux (x86_64 and ARM64), and Windows
(x86_64), you can install `zena` locally in one command and start writing,
running, and testing Zena programs on your machine.

Zena is still early and very unstable. The language, standard library, and tools
are changing rapidly, and releases before 1.0 will introduce breaking changes.
If you build something on Zena today, expect to update it as the language
evolves.

## Installing the `zena` CLI

Install the latest preview release with the install script, which downloads the
archive for your platform from
[GitHub Releases](https://github.com/elematic/zena/releases), verifies its
SHA-256 checksum, and puts `zena` in `~/.zena/bin`:

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

See the [Install guide](/guide/install/) for script options, manual downloads,
and the VS Code extension.

Distributing the CLI through GitHub Releases and an install script is our
starting point. We'd like feedback on how well this works for you and what other
distribution channels you want — Homebrew, Nix, OS package managers, or
something else.

## What's in the CLI

The `zena` executable is a single binary that bundles the compiler, standard
library, and development tools:

- **`zena build`**: Compiles Zena libraries to WebAssembly (`.wasm` or `.wat`),
  or runs project build targets via Zebra.
- **`zena run`**: Compiles (with caching) and executes `.zena`, `.wasm`, or
  `.wat` files.
- **`zena test`**: Discovers and runs `*_test.zena` files in parallel.
- **`zena lint`**: Checks Zena source files and applies type-checked fixes with
  `--fix`.
- **`zena fmt`**: Formats `.zena` source files.
- **`zena bench`**: Runs statistical benchmark suites.
- **`zena lsp`**: Runs the Language Server Protocol server over stdin/stdout for
  editor integrations.
- **`zena pkg`**: Initializes projects, manages dependencies, signs in, and
  publishes packages.

Aside from how much is bundled into one binary, `zena` works much like other
language CLIs.

Under the hood, the CLI is a Zena program compiled to WebAssembly and hosted by
a small Rust binary that embeds [Wasmtime](https://wasmtime.dev/). Along with
standard WebAssembly execution, the host exposes a small set of `zena:host`
interfaces for capabilities that WASI does not yet standardize or that the
toolchain needs: spawning child processes, starting HTTP servers, formatting
stack traces, and reading raw terminal input.

`zena run` executes three kinds of WebAssembly output:

- Core WebAssembly modules (`--target core`)
- Standard WASI 0.3 components (`--target component`)
- The default `zena-component` target (`--target zena-component`), which is a
  WASI 0.3 component with access to those extra `zena:host` interfaces

## The Zena Package Manager

Every modern language needs a package manager, so we wanted one working before
inviting wider trials of Zena. We also needed a place to publish libraries we
have built that belong outside the standard library, including
`zena-lang:markdown`, `zena-lang:workflow`, `zena-lang:protobuf`, and
`zena-lang:terminal`.

### Trying a package

To use a published package in a project, initialize a manifest and add the
dependency with `zena pkg add`:

```sh
mkdir hello-markdown && cd hello-markdown
zena pkg init
zena pkg add zena-lang:markdown
```

`zena pkg add` resolves `zena-lang:markdown` to its decentralized identifier
(DID), records the DID and version range in `zena-package.json`, writes the
resolved versions and content hashes to `zena-lock.json`, and fetches the
package into your local cache.

Your `zena-package.json` records the local name you import the package under
alongside its DID:

```json
{
  "name": "hello-markdown",
  "version": "0.1.0",
  "dependencies": {
    "zena-lang:markdown": {
      "did": "did:plc:...",
      "version": "^0.0.1-preview.1"
    }
  }
}
```

From there, import the package in your Zena code:

```zena
import {markdownToHtml, gfmExtensions} from 'zena-lang:markdown';

export function main(): i32 {
  let html = markdownToHtml('# Hello from Zena\n\nSome ~~old~~ **new** text.', {
    extensions: gfmExtensions(),
    safe: true,
  });
  console.log(html);
  return 0;
}
```

Run it with `zena run main.zena`.

Notice that the key in `dependencies` is a local name that your package chooses.
When you install `zena-lang:compiler`, you can keep the scoped name
`zena-lang:compiler`, drop the scope to `compiler`, or rename it entirely to
`zena-compiler` with `--name`:

```sh
zena pkg add zena-lang:compiler --name zena-compiler
```

Your code imports whatever local name you picked, while the manifest binds that
name to the package's DID.

`zena-lock.json` pins every resolved package by DID and version, along with the
CID (content identifier — a SHA-256 hash) of both its release record and its
source archive:

```json
{
  "lockfileVersion": 1,
  "workspace": {
    ".": {
      "zena-lang:markdown": "did:plc:...@0.0.1-preview.1"
    }
  },
  "resolved": {
    "did:plc:...@0.0.1-preview.1": {
      "release": "bafyrei...",
      "source": "bafkrei..."
    }
  }
}
```

When `zena pkg fetch` or `zena pkg add` downloads a package, it checks the
fetched bytes against those CIDs. If a release's content changes under the same
version number, `zena` refuses it.

### Why a distributed architecture

Package managers have been a major addition to language toolchains, but years of
running them at scale have exposed recurring failure modes:

- **Name land rushes and squatting**: A flat global namespace rewards grabbing
  short names early and makes typosquatting easy.
- **Supply-chain attacks**: Compromised maintainer credentials or automated
  publishing tokens can push malicious releases directly to downstream users.
- **Availability and left-pad failures**: Unpublishing a package or suffering a
  registry outage breaks builds across an entire ecosystem.
- **Weak or disconnected trust signals**: Security audits, quality scores, and
  deprecation notices usually live on separate websites, disconnected from the
  CLI that installs packages.
- **Lock-in and single points of failure**: A single organization controls the
  registry, the namespace, and the web interface.

The Zena package manager (which does not have a special name yet) addresses
these problems with a distributed architecture built on the
[AT Protocol](https://atproto.com/) (atproto), the protocol behind Bluesky. The
design is heavily inspired by the [FAIR](https://fair.pm/) package manager.

In this architecture:

- **Packages are atproto accounts.** Every package has its own DID (`did:plc` or
  `did:web`), its own handle, and its own repository storing release records and
  source archive blobs.
- **Repositories live on PDSes.** Packages are stored on atproto Personal Data
  Servers (PDSes), and anyone can run a PDS. Because packages are ordinary
  atproto accounts, they are portable across PDSes just like Bluesky accounts —
  a package can move to another host while keeping its DID and history.
- **App Views index and serve the web UI.** An App View consumes package publish
  events, builds a searchable index, and renders package pages. The CLI connects
  to an App View to search, resolve handles, and download packages.
- **No registry lock-in.** Anyone can run a PDS, an App View, or an alternative
  CLI. Because packages keep their DID when they move or rename, moving off a
  service does not break downstream projects.

Right now, the Zena project runs the only Zena package PDS at
`padstone.zena-lang.dev`, paired with our App View at
[pkg.zena-lang.dev](https://pkg.zena-lang.dev). While the protocol allows
packages to live on any PDS, our App View still needs to add support for
indexing external PDSes from the AT Protocol firehose.

### Handles, shorthands, and DIDs

By default, packages published through `pkg.zena-lang.dev` receive handles under
that domain in the form `<package>.<scope>.pkg.zena-lang.dev` — for example,
`markdown.zena-lang.pkg.zena-lang.dev`.

Typing full domain handles on the command line is verbose, so `zena pkg`
supports a `<scope>:<package>` shorthand. Running
`zena pkg add zena-lang:markdown` expands to
`markdown.zena-lang.pkg.zena-lang.dev`. The default registry domain used for
shorthands will be configurable, and manifests can already map individual scopes
to other domains. Projects that own a domain can also host handles under their
own domain directly.

Handles are for humans; the DID is the package's real identity. Because
manifests and lockfiles store the DID, a package can change its handle — to
rebrand, move to a new scope, or resolve a squatting dispute — without breaking
any project that depends on it.

### Scopes, organizations, and teams

The package manager includes **scopes**, **organizations**, and **teams** for
managing publishing and maintenance. All of them are atproto accounts with their
own DIDs. Their repositories hold public records describing roles, policies, and
membership commitments (using salted hashes so individual members stay private
until they act, while every authorization check remains publicly verifiable).

Even though packages can be renamed over time, every package on an App View must
live inside a scope. Requiring scopes eliminates the top-level package name land
rush and groups related packages under a clear namespace.

While we test the service and refine our moderation and quota controls, creating
new scopes — which is required to publish packages — is invite-only. If you want
to try publishing Zena packages, reach out to
[@zena-lang.dev on Bluesky](https://bsky.app/profile/zena-lang.dev) for an
invite.

### Signing in with your atproto account

You sign in to both the CLI (`zena pkg login`) and the web interface at
`pkg.zena-lang.dev` using an existing AT Protocol account via OAuth. There is no
separate Zena account or package password to create. Maintainers authenticate as
themselves, and the CLI requests narrow OAuth scopes limited to package
attestations and registry calls.

We're excited about the broader "Log in with Atmosphere" effort across the
atproto ecosystem, and building package publishing on top of portable user
identities fits right into that model.

### Padstone: a PDS written in Zena

Our PDS, `padstone.zena-lang.dev`, is written in Zena — as are the compiler, the
CLI, the App View, and our web servers.

Padstone is largely a standard atproto PDS, with one notable addition for
package hosting: **managed accounts**. On a general-purpose PDS like Bluesky's,
creating an account through `com.atproto.server.createAccount` requires an
email address, a password, and usually an invite code or phone verification.
Requiring a maintainer to go through email and password signup for every new
package or scope would make publishing painful and would leave shared package
passwords lying around.

Instead, Padstone lets a trusted App View create managed accounts when a user
publishes a package or creates a scope:

1. The App View calls `com.atproto.server.reserveSigningKey` on Padstone with a
   service-auth token.
2. The App View mints the new `did:plc` genesis operation, signed with its
   rotation key and naming Padstone's reserved signing key.
3. The App View calls `com.atproto.server.createAccount` with that DID and a
   service-auth token — no email, password, or invite code.

Padstone verifies that the genesis operation was signed by the trusted App View
and references the reserved key, then creates the account. Managed accounts have
no password and accept writes only from their App View.

Publishing policies sit on top of this. Packages, scopes, and organizations can
configure approval thresholds — for example, requiring two maintainers with
publishing permission to approve a release before it is published. Each approver
signs an **attestation** record in their own atproto repository, naming the
exact release by URI and CID. The App View holds the release pending until the
required attestations arrive.

To keep Padstone from becoming a vector for Bluesky spam or free file hosting,
it enforces content policies on managed accounts: automatically created accounts
for packages, scopes, organizations, and teams can store records only in
official `dev.zena-lang.*` lexicons, and are subject to rate limits and blob
size limits. A package account cannot post to Bluesky or store arbitrary files.

### Labelers for security and quality

Because the package manager runs on AT Protocol, it inherits atproto's
**labeler** architecture. Independent services can inspect published packages
and publish signed labels on them — marking a release as having passed or failed
a security check, flagging vulnerabilities, or noting maintenance and quality
signals.

We hope security and ecosystem tools — services like Sentry or Snyk, or
community efforts like [e18e](https://e18e.dev/) in the npm ecosystem — will run
labelers for packages. Next, we plan to surface labels in the App View UI and
add label-based policies to the `zena` CLI so projects can require specific
labels (or block packages carrying warning labels) before installing.

### The App View today and next

Today, [pkg.zena-lang.dev](https://pkg.zena-lang.dev) shows each package's
README, dependencies, release history, and source files.

We want the App View to raise the baseline for package documentation so
maintainers do not have to build and deploy a separate website just to give
their library good docs. Planned additions include:

- **Generated API documentation** extracted directly from package source via
  `zena doc`, and eventually full microsites for packages.
- **Embedded Zena playgrounds** on package pages so libraries can include
  interactive, editable demos right in their docs.
- **MCP support in the Zena CLI** so coding agents can search the package index
  and inspect package APIs directly.
- **Bluesky posts for releases**: Since packages and scopes are already AT
  Protocol accounts, another feature we might explore is automatically
  publishing Bluesky posts when new releases go out, letting users follow a
  package or scope for release updates right in their feed.

## Beyond Zena

We are starting with Zena, but very little of this package manager architecture
is Zena-specific. Portable package identities, multi-maintainer attestations,
content-addressed lockfiles, and federated labeling solve problems that every
package ecosystem faces.

We plan to publish the underlying lexicons, libraries, and server components so
other ecosystems can build on them too. One of the first non-Zena use cases we
want to support is publishing WebAssembly components with full dependency
declarations. Smaller language ecosystems should also be able to bootstrap a
package manager on this foundation without building centralized
infrastructure from scratch.

We're grateful to the [FAIR](https://fair.pm/) project for demonstrating how a
distributed package manager can work in practice, and to the
[AT Protocol](https://atproto.com/) community for building the network this runs
on.

## Get started

- Install the CLI from the [Install guide](/guide/install/) and run through
  [Getting Started](/guide/getting-started/).
- Browse the initial packages at [pkg.zena-lang.dev](https://pkg.zena-lang.dev).
- Read the full [package manager design document](https://github.com/elematic/zena/blob/main/docs/design/package-manager.md)
  for the technical details.
- Reach out to [@zena-lang.dev on Bluesky](https://bsky.app/profile/zena-lang.dev)
  for feedback on CLI distribution or an invite to create a scope.
