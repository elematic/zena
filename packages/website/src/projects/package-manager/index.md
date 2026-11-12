---
title: 'Package Manager'
description: 'An AT Protocol package manager and registry App View for managing package, scope, team, and organization accounts, permission delegation, and release publishing, with planned WebAssembly plugins.'
status: 'In progress'
statusType: 'warning'
lead: 'A package manager and registry built on the AT Protocol—managing accounts for packages, scopes, teams, and organizations, delegated publishing permissions, and a registry App View.'
---

Zena's package manager (`packages/package-manager`, invoked via `zena pkg`) and
registry service (`packages/registry`) publish, govern, and distribute packages
on the [AT Protocol](https://atproto.com/), backed by our
[multi-tenant AT Protocol PDS](/projects/pds/) or other compatible PDS hosts.

Today it is built specifically for Zena, with Zena manifest reading and README
extraction implemented directly in the CLI and registry. Its core, however, is
not inherently tied to Zena: account management for packages and organizations,
permission delegation, multi-party release approvals, version resolution, and
the registry App View operate on language-neutral identities and release
archives. There is no plugin system yet, though we plan to move Zena-specific
package processing into WebAssembly plugins over time.

## Accounts for packages, scopes, teams, and organizations

Instead of a custom user database and a single flat global namespace, the
package manager models every entity as an AT Protocol account:

- **Package accounts** — Each published package has its own persistent account
  identity, separate from the personal accounts of the people who maintain it.
  Maintainers can rotate, organizations can reorganize, and a package can move
  between hosts without breaking downstream workspaces. Manifests pin
  dependencies by persistent identity, while each workspace chooses its own
  local import alias (such as `acme:router`).
- **Scopes and organizations** — Human-readable package names always sit inside
  a scope—either under a registry domain (`router.acme.pkg.zena-lang.dev`) or
  under a domain controlled by the maintainers (`router.pkg.acme.com`). Each
  scope is owned by an organization account that manages members, roles, and
  scope-wide security policies.
- **Teams and private membership** — Organizations group members into teams
  (`owners`, `admins`, `publishers`) that maintain packages together. Membership
  records store salted cryptographic commitments so role checks and approvals
  are publicly verifiable without exposing an organization's full member list
  before someone acts.

## Permission delegation and release publishing

Because package accounts are managed entities separate from personal logins,
nobody holds a shared password or long-lived publishing key for a package:

- **Personal sign-in with delegated roles** — Maintainers sign in with their own
  AT Protocol accounts (`zena pkg login`), and the registry verifies their
  delegated permissions on the target organization, team, or package.
- **Threshold approvals** — Packages and scopes can require `M`-of-`N`
  maintainer approvals—including a minimum number of human approvals—before a
  release or governance change takes effect. Each maintainer writes a signed
  approval record to their own account, and the registry holds pending releases
  until the required threshold is satisfied.
- **CI and automation accounts** — Scoped automation accounts let CI pipelines
  upload release candidates without holding human maintainer keys, optionally
  paired with a required human approval before publication completes.
- **Minimal version selection and lockfiles** — On the client, dependency
  resolution uses Go-style minimal version selection and pins exact content
  hashes in `zena-lock.json`, verifying release signatures and archive hashes on
  fetch so caches and mirrors need no special trust:

```sh
# Create an organization scope and publish a release
zena pkg scope create acme
zena pkg publish --scope acme

# Add a scoped dependency to a workspace and fetch pinned archives
zena pkg add acme:router
zena pkg fetch
```

## The registry App View

In AT Protocol architecture, an **App View** indexes records from repositories
and serves domain-specific APIs and web views. `packages/registry` implements
the package manager's App View in Zena:

- **Account and release coordination** — Creates and manages package,
  organization, and automation accounts on a [PDS](/projects/pds/), validates
  maintainer attestations and threshold rules, and writes approved release
  records and deterministic source archives.
- **Indexing, search, and web UI** — Indexes scopes, package profiles, version
  histories, retractions, and derived release contents, serving both the XRPC
  endpoints called by `zena pkg` and server-rendered web pages for browsing
  packages, inspecting files and rendered READMEs, and managing scopes and teams
  in the browser via AT Protocol OAuth.

## Planned WebAssembly plugins

The package manager does not support plugins yet—today `zena-package.json`
parsing and README extraction are hardcoded directly in `packages/package-manager`
and `packages/registry`.

Because the governance and distribution core (accounts for packages, scopes,
teams, and organizations, permission delegation, threshold attestations, archive
storage, and the App View) has nothing specific to Zena's syntax or compiler,
the language-specific work it does today—and additional checks planned for the
future—could move into capability-sandboxed WebAssembly plugins (built on the
[`zena:host` extension interfaces](/projects/runtime/#sandboxed-wasm-extensions)):

- **Config and manifest adapters** — A plugin could read `zena-package.json` (or
  manifests from other ecosystems such as `Cargo.toml`, `package.json`, or WIT
  component worlds) to extract package metadata, exported entry points, file
  lists, and dependency declarations.
- **README and API documentation extraction** — Plugins could locate
  documentation files in a release archive, render Markdown, and generate
  browseable API docs (such as `zenadoc` output) for the App View without
  coupling the registry server to a single language's doc extractor.
- **Static analysis and publish checks** — Future plugins could run sandboxed
  pre-publish or derived-content checks on uploaded packages: lint rules,
  capability and import audits, public-API diffing for semantic versioning
  checks, or test compilation inside bounded memory and CPU limits.

Moving those steps into Wasm components would let new Zena analysis passes ship
without modifying the core registry, and would open the same package manager
core to general WebAssembly components and other languages.

## Current status and roadmap

The package manager client (`packages/package-manager`), `zena pkg` CLI
commands, and registry App View (`packages/registry`) are in active development
in Zena, with end-to-end test suites and a local self-contained stack
(`npm run demo -w @zena-lang/registry`). Today `zena pkg login`, `scope`,
`create`, `publish`, `add`, `update`, and `fetch`, minimal version selection,
`zena-lock.json` pinning, organization/team/maintainer threshold approvals,
built-in Zena manifest and README handling, and the server-rendered registry web
UI all run against in-memory and Firestore + Google Cloud Storage backends.

Planned work includes:

- Designing a Wasm plugin system so Zena config reading, README/API-doc
  extraction, and static package analysis are decoupled from the core client and
  registry.
- An append-only public checksum transparency log so clients independently
  verify that release contents and approvals match across all observers.
- Indexing packages hosted across external PDS instances from the AT Protocol
  firehose and supporting community moderation labelers.

→ Source: [`packages/package-manager`](https://github.com/elematic/zena/tree/main/packages/package-manager) ·
[`packages/registry`](https://github.com/elematic/zena/tree/main/packages/registry) ·
Design: [`docs/design/package-manager.md`](https://github.com/elematic/zena/blob/main/docs/design/package-manager.md)
