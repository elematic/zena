---
title: Decentralized Packages
---

No single registry owns Zena packages. Each package keeps its identity and its data wherever it is hosted, so a registry that goes away, or turns against you, does not take your packages, or the projects that depend on them, with it.

## A package's identity is its own

A project depends on a package by its permanent identifier, a DID, which `zena pkg add` writes into `zena-package.json`. The names people type, such as `acme:router`, point to that identifier. Since projects record the identifier, a package can be renamed or move to another host without breaking them. (Commands for moving a package are not built yet.)

## Your data stays in your accounts

You publish and approve with the account you already have, and your approvals are records in that account. A package's own records, its profile, its maintainers and its releases, are in a repository of its own, signed with its own key. Anyone can read these records and check their signatures, without trusting the registry that shows them.

## Anyone can serve and build on packages

Every release and archive is addressed by its content hash, so any cache or mirror can serve it, and a client can check what it gets. The records are public and in standard formats, so anyone can build indexes, search and tools over them.

## Labels from anyone (planned)

Anyone will be able to run a labeler that marks packages, for example as reviewed, deprecated or malicious, and you choose which labelers your projects follow ([Security](/docs/security/)).

## Built on the AT Protocol

If you know the AT Protocol, the network Bluesky runs on: every package and every scope is an atproto account, with a DID, a handle and a signed repository, and maintainers are ordinary atproto accounts. [AT Protocol Architecture](/docs/architecture/) has the details.
