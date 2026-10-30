---
title: Overview
status: Preview
---

::: warning Active Development
The Zena package manager and registry are under active development. Commands, manifest fields, and lexicon schemas may change as the system matures.
:::

Zena's package manager is built on the [AT Protocol](https://atproto.com) (atproto). Every package and organization scope is an atproto account with its own Decentralized Identifier (`did:plc` or `did:web`) and signed Merkle repository.

## Core concepts

- **Identity by DID**: A package is identified by its DID, such as `did:plc:routerrouterrouterrouter`. It can change handles, maintainers, or hosting servers while keeping the same identity.
- **Scoped handles for discovery**: People find and add packages by their handle (`router.acme.pkg.zena-lang.dev`) or shorthand (`@acme/router`). `zena add` resolves the handle to a DID and records the DID in `zena-package.json`.
- **Local import names**: Each package chooses its own local name for every dependency it imports (`import {Router} from 'router:server'`). Two packages in the same workspace can use different local names for the same dependency.
- **Minimal version selection**: Across a workspace, the version selected for a major version of a package is the highest minimum version any package in the dependency graph requests.
- **Cryptographic verification**: Release records are fetched with Merkle proofs from the package's signed repository, and source archives are addressed by SHA-256 CID and pinned in `zena-lock.json`.
- **Maintainer attestations**: Maintainers sign in with their own atproto accounts. A package has no password of its own; instead, maintainers approve releases and membership changes by writing signed attestation records into their own repositories.

## Workflow at a glance

### Using packages

Add a dependency by `@scope/name`, handle, or DID:

```sh
zena add @acme/router
```

`zena add` resolves `@acme/router`, adds its DID and version to `zena-package.json`, writes the resolved dependency graph and CIDs to `zena-lock.json`, and unpacks the source archive into the local cache.

Import the package's exported libraries in Zena source using its local name:

```zena
import {Router} from 'router:server';
```

### Publishing packages

Sign in with an Atmosphere account, create a scope once, and publish:

```sh
zena login alice.bsky.social
zena scope create acme
zena publish --scope acme
```

On the first publish, the package host creates an atproto account for the package under `@acme`, writes the new `did` field into `zena-package.json`, uploads the source archive blob, and records your release attestation.

## Documentation guide

| Section | Topics covered |
| --- | --- |
| [Getting Started](/docs/getting-started/) | Creating `zena-package.json`, adding dependencies, importing libraries, updating, and fetching |
| [Publishing Packages](/docs/publishing/) | Signing in, creating scopes, publishing releases, approving held releases, and retracting versions |
| [Package Manifests](/docs/manifests/) | `zena-package.json` fields, open vs. closed packages, `exports`, `virtual` targets, and dependency types |
| [Workspaces & Lockfiles](/docs/workspaces/) | Multi-package workspaces, path dependencies, minimal version selection, and `zena-lock.json` |
| [Scopes, Orgs & Teams](/docs/orgs-and-teams/) | Organization scopes, member roles, teams, package maintainers, and private membership commitments |
| [Approvals, Thresholds & Policies](/docs/approvals-and-settings/) | M-of-N release approvals, owner thresholds, scope policies, and CI automation accounts |
| [CLI Commands](/docs/cli/) | Subcommands, flags, and environment variables for `zena` |
| [AT Protocol Architecture](/docs/architecture/) | DIDs, handles, repository records, `dev.zena-lang.*` lexicons, CAR archives, and transparency logs |
