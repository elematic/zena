---
title: 'AT Protocol PDS'
description: 'An extendable, multi-tenant AT Protocol Personal Data Server written in Zena for custom account models, permission delegation, and content policies.'
status: 'In progress'
statusType: 'warning'
lead: 'An extendable, multi-tenant AT Protocol Personal Data Server written in Zena—built for systems that customize account creation, permission delegation, and allowed content, including accounts that represent documents, packages, and other objects.'
---

On the [AT Protocol](https://atproto.com/)—the open network protocol behind
Bluesky and other decentralized apps—a Personal Data Server (PDS) hosts accounts
and their data. Each account gets a portable identity, a signed repository of
records and files, and an event stream that other services can subscribe to,
while keeping the freedom to move to another server without losing its identity
or history.

Existing PDS implementations assume a standard social-app model: one account per
person, created with an email address and password, where that user can write
almost any kind of record into their repository.

We are building a multi-tenant PDS in Zena (growing out of `packages/pds` and
`packages/atproto` in the monorepo) for applications that need to customize how
accounts are created, how permissions are delegated across accounts, and what
content each account is allowed to store.

## Accounts for objects and documents

Because an AT Protocol account is a portable identity paired with a signed
collection of records and files, an account does not have to represent a person.
Separate accounts can represent:

- **Packages and scopes** — In Zena's package registry (`packages/registry`),
  publishing scopes (organizations), individual packages, and CI release bots
  are distinct accounts hosted on the PDS, each publishing signed release
  records into its own repository.
- **Collaborative documents and workspaces** — A document, project board, wiki
  space, or dataset can have its own account, versioned history, and independent
  storage quota, so moving a document between hosts uses standard AT Protocol
  account migration.
- **Autonomous services and devices** — Bots, build workers, or automated feeds
  can publish verifiable records under dedicated identities managed by an owning
  user or organization.

Giving objects and documents their own accounts aligns edit history,
cryptographic signatures, sync streams, and portability with the item itself
instead of tying shared data to one person's personal account.

## Account creation, delegation, and content policies

Supporting non-person accounts and domain-specific applications requires policy
hooks that a fixed social PDS does not provide:

- **Custom account creation** — Applications can provision accounts
  programmatically, gate creation on external identity providers or parent
  accounts, configure custom recovery and key-rotation rules, and create managed
  accounts that do not have human login credentials.
- **Permission delegation** — A user, team, or service can receive scoped
  permission to update specific collections or records inside another account
  (such as a shared document, organization scope, or package) without sharing
  full account credentials.
- **Allowed content and validation** — Operators and account types can restrict
  which record schemas an account may store, validate writes against application
  rules before they are committed, enforce file type and size limits, or reject
  changes that break cross-record invariants.

## WebAssembly extensions

Customization is designed around capability-sandboxed WebAssembly components
loaded via the
[`zena:host` extension interface](/projects/runtime/#sandboxed-wasm-extensions),
at two levels:

- **Server-level extensions** — Installed by the PDS operator to define custom
  API endpoints (XRPC queries and procedures), custom account provisioning
  flows, delegation checks, pre-commit write policies, and post-commit indexing
  hooks.
- **Per-account extensions** — Installed by an account owner (when permitted by
  the host) to attach custom validation rules, derived views, or webhook-style
  triggers to that repository.

Signing keys, password hashes, session secrets, and storage credentials stay
inside the trusted PDS core. Extension components run with bounded memory and
per-call CPU budgets, receive explicit capability handles for reading allowed
records and isolated extension key-value storage, and return structured
allow/deny decisions or API responses across WIT boundaries. Because extensions
are standard Wasm components, operators and developers can write them in Zena,
Rust, Go, or any language targeting the Component Model.

## Current status and roadmap

In the monorepo today, `packages/atproto` implements the core AT Protocol
identity, repository storage, cryptographic signing, and API libraries in Zena,
and `packages/pds` implements a working multi-tenant PDS with both in-memory
storage (for tests and local workflows) and encrypted Firestore + Google Cloud
Storage backends. That core already powers `packages/registry`, including
managed non-human accounts, custom recovery key ordering, and per-account
collection restrictions.

Upcoming work extracts and generalizes those capabilities into a standalone,
configurable server:

- Packaging the multi-tenant PDS so external projects can deploy and configure
  it outside the Zena registry.
- Implementing the WIT contract for server-level and per-account Wasm extensions
  (custom API routes, pre-commit policy hooks, and isolated extension storage).
- Built-in delegation primitives for object, group, and document accounts.
- Additional storage backends (such as SQLite and PostgreSQL + S3-compatible
  object stores) for single-node and self-hosted deployments.

→ Source: [`packages/pds`](https://github.com/elematic/zena/tree/main/packages/pds) ·
[`packages/atproto`](https://github.com/elematic/zena/tree/main/packages/atproto) ·
Design: [`docs/design/pds-extensions.md`](https://github.com/elematic/zena/blob/main/docs/design/pds-extensions.md)
