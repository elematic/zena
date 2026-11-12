---
title: Security
---

The package manager is built so that a stolen account, a compromised CI job or a malicious package has a hard time reaching your project. This page lists what protects you today, and what is planned.

## What you install stays what you installed

- `zena-lock.json` pins every dependency to the content hashes (CIDs) of its release and its source archive. Fetching checks each download against them, so every machine builds the same code, whatever a registry serves later.
- A published version is never replaced. A registry refuses a second release of the same version, and `zena pkg add` and `zena pkg update` refuse a pinned release whose hashes changed unless you pass `--allow-changed`.
- A new release reaches your project only when you ask for it. Version selection picks the lowest version that every dependent accepts, so nothing moves until you, or a package you depend on, raise the lowest version of a range ([Workspaces & Lockfiles](/docs/workspaces/)).
- Installing a package runs none of its code. A Zena package is source code, compiled into your program when you build it.

## A release needs its maintainers

- A package can require several of its maintainers to approve each release. The registry holds a release until enough of them have approved it, so one stolen account cannot publish alone ([Approvals & Policies](/docs/approvals-and-settings/)).
- Each approval is a record in the maintainer's own account, which anyone can read. Approving takes that maintainer's account, not only the registry.
- Changes to who maintains a package, who belongs to a scope and who is on a team are approved the same way.
- CI publishes as an automation account that a scope creates. Its token can publish, but a person must approve every release it publishes.
- A scope's owners can set the least number of approvals for every package in the scope, and the teams that new packages start with.
- A release with a problem can be retracted with `zena pkg retract`, and version selection skips it.

## Planned

- **Labels.** Anyone can run a labeler that marks packages and releases, for example as malicious, deprecated or reviewed, and you choose which labelers your projects follow. A release that a labeler you follow marks as malicious will be refused, even where it is already pinned.
- **A checksum log** of every release and its approvals, so that a client can check that the release it fetches is the one every other client sees.
- **Security keys**: requiring a passkey or a hardware key for each approval.
