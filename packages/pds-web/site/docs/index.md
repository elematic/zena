---
title: Overview
status: Preview
---

::: warning Active Development
The Zena package manager and registry are under active development. Commands, manifest fields, and lexicon schemas may change as the system matures.
:::

Zena packages are libraries and tools for the Zena programming language. Add one to your project with `zena pkg add`, and publish your own with `zena pkg publish`.

## Install a package

Add a package by its `@scope/name`:

```sh
zena pkg add @acme/router
```

Then import its libraries by the name your project gives it:

```zena
import {Router} from 'router:server';
```

`zena pkg add` records the package in `zena-package.json` and pins the exact release in `zena-lock.json`, so every machine builds the same code. See [Installing Packages](/docs/installing/).

## Publish a package

Sign in with your Bluesky or other AT Protocol account, create a scope once, and publish:

```sh
zena pkg login alice.bsky.social
zena pkg scope create acme
zena pkg publish --scope acme
```

See [Publishing Packages](/docs/publishing/), and [Defining a Package](/docs/manifests/) for what goes in `zena-package.json`.

## Security

Every dependency is pinned by its content hash, a published version never changes, and a package can require several maintainers to approve each release. See [Security](/docs/security/).

## Scopes, organizations and teams

Packages are published under a scope, such as `@acme`, that an organization owns. Its owners give members and teams roles, and who belongs stays private until they act. See [Scopes, Orgs & Teams](/docs/orgs-and-teams/).

## Decentralized

No single registry owns your packages: each keeps its own identity and data wherever it is hosted, and the projects that depend on it name it by that identity. The package manager is built on the AT Protocol, the network Bluesky runs on. See [Decentralized Packages](/docs/decentralized/).

## Documentation guide

| Section                                               | Topics covered                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Installing Packages](/docs/installing/)              | Setting up a project, adding dependencies, importing libraries, updating, and fetching             |
| [Workspaces & Lockfiles](/docs/workspaces/)           | Multi-package workspaces, path dependencies, minimal version selection, and `zena-lock.json`       |
| [Publishing Packages](/docs/publishing/)              | Signing in, creating scopes, publishing releases, approving held releases, and retracting versions |
| [Defining a Package](/docs/manifests/)                | `zena-package.json` fields, `exports`, `virtual` targets, and dependency types                     |
| [Security](/docs/security/)                           | Pinned hashes, immutable versions, maintainer approvals, automation accounts, and what is planned  |
| [Approvals & Policies](/docs/approvals-and-settings/) | Release approvals, thresholds, scope policies, and CI automation accounts                          |
| [Scopes, Orgs & Teams](/docs/orgs-and-teams/)         | Organization scopes, member roles, teams, package maintainers, and private memberships             |
| [Decentralized Packages](/docs/decentralized/)        | Package identity, owning your data, mirrors and indexes, and labels                                |
| [AT Protocol Architecture](/docs/architecture/)       | DIDs, handles, repository records, `dev.zena-lang.*` lexicons, and source archives                 |
| [CLI Commands](/docs/cli/)                            | Subcommands, flags, and environment variables for `zena`                                           |
