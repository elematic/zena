---
title: 'AT Protocol PDS'
description: 'An extendable, multi-tenant AT Protocol Personal Data Server written in Zena for custom account models, permission delegation, and content policies.'
status: 'In progress'
statusType: 'warning'
lead: 'An extendable, multi-tenant AT Protocol Personal Data Server written in Zena—built for systems that customize account creation, permission delegation, and allowed content, including accounts that represent documents, packages, and other objects.'
---

On the [AT Protocol](https://atproto.com/), every account is an authenticated
data repository identified by a Decentralized Identifier (DID), backed by a
signed Merkle Search Tree (MST) of DAG-CBOR records, and hosted on a Personal
Data Server (PDS). Reference PDS implementations assume a social-network model
where each account belongs to one human user with a password, an email address,
and uniform write access to any Lexicon collection.

We are building a multi-tenant PDS in Zena (growing out of `packages/pds` and
`packages/atproto` in the monorepo) that treats the authenticated repository,
identity, and sync core as reusable infrastructure while opening up account
lifecycle, authorization, and record validation to customization.

## Accounts for objects and documents

Because an AT Protocol account is a portable DID plus a signed collection of
records and blobs, an account does not have to represent a person. Separate
accounts can represent:

- **Packages and scopes** — In Zena's own package registry (`packages/registry`),
  publishing scopes (organizations), individual packages, and CI release bots are
  distinct AT Protocol accounts hosted on the PDS, each publishing signed
  release records into its own repository.
- **Collaborative documents and workspaces** — A document, project board, wiki
  space, or dataset can have its own DID, versioned record history, and
  independent storage quota, so migrating a document between hosts uses standard
  AT Protocol repository export and import.
- **Autonomous services and devices** — Bots, build workers, or IoT feeds can
  publish verifiable records under dedicated identities managed by an owning
  organization.

Giving objects their own accounts keeps audit trails, cryptographic signatures,
firehose streams, and repository portability aligned with the unit of data being
shared.

## Account creation, delegation, and content policies

Supporting non-person accounts and domain-specific applications requires policy
hooks that a fixed social PDS cannot hardcode:

- **Custom account creation** — Applications can provision accounts
  programmatically, gate creation on external identity providers or parent
  records, mint `did:plc` or `did:key` identities with custom rotation key
  hierarchies (such as ordered user and service recovery keys), and create
  managed accounts without human credentials.
- **Permission delegation** — One account (a user or team) can hold delegated
  rights to write specific collections or records inside another account (a
  document, scope, or package) using scoped tokens, service authentication
  (`com.atproto.server.getServiceAuth`), or relationship records stored on the
  PDS.
- **Allowed content and schema enforcement** — Operators and account types can
  restrict which Lexicon collections an account may write to, validate incoming
  records against custom invariants before a commit is signed, enforce blob MIME
  and size rules, or reject mutations that violate cross-record constraints.

## WebAssembly extensions

Customization is designed around capability-sandboxed WebAssembly components
loaded via the [`zena:host` extension interface](/projects/runtime/#sandboxed-wasm-extensions),
at two levels:

- **Server-level extensions** — Installed by the PDS operator to define custom
  XRPC query and procedure endpoints, bespoke account provisioning flows,
  delegation resolvers, pre-commit write policies, and post-commit indexing
  hooks.
- **Per-account extensions** — Installed by an account owner (when permitted by
  the host) to attach custom validation rules, derived views, or webhook-style
  triggers to that repository.

Signing keys, password hashes, session secrets, and raw storage credentials stay
inside the trusted PDS core. Extension components run with bounded memory and
per-call CPU budgets, receive explicit capability handles for reading allowed
repository records and isolated extension key-value storage, and return
structured allow/deny decisions or XRPC responses across WIT boundaries. Because
extensions are standard Wasm components, operators and developers can write them
in Zena, Rust, Go, or any language targeting the Component Model.

## Current status and roadmap

In the monorepo today, `packages/atproto` implements DIDs, handles, CIDs,
DAG-CBOR, Merkle Search Trees, CAR serialization, XRPC, and cryptographic
signing in Zena, and `packages/pds` implements a working multi-tenant PDS with
both in-memory storage (for tests and local workflows) and encrypted Firestore +
Google Cloud Storage backends. That core already powers `packages/registry`,
including managed non-human accounts, custom PLC recovery key ordering, and
collection write restrictions.

Upcoming work extracts and generalizes those capabilities into a standalone,
configurable server:

- Packaging the multi-tenant PDS so external projects can deploy and configure
  it outside the Zena registry.
- Implementing the WIT contract for server-level and per-account Wasm extensions
  (custom XRPC routes, pre-commit policy hooks, and isolated extension storage).
- Built-in delegation primitives for object, group, and document accounts.
- Additional storage backends (such as SQLite and PostgreSQL + S3-compatible
  object stores) for single-node and self-hosted deployments.

→ Source: [`packages/pds`](https://github.com/elematic/zena/tree/main/packages/pds) ·
[`packages/atproto`](https://github.com/elematic/zena/tree/main/packages/atproto) ·
Design: [`docs/design/pds-extensions.md`](https://github.com/elematic/zena/blob/main/docs/design/pds-extensions.md)
