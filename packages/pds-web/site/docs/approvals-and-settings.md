---
title: Approvals & Policies
---

A package can require more than one maintainer to approve each release, so that one stolen account cannot publish alone. The same goes for changes to who maintains a package or a scope, and who belongs to an organization or a team. [Security](/docs/security/) describes the other protections.

## How maintainer attestations work

When a maintainer publishes a release, or proposes a change to a package's or a scope's maintainers, a scope's policy, an organization's members, or a team:

1. The author's CLI writes a `dev.zena-lang.package.attestation` record into the author's own atproto repository, naming the target record's AT-URI and its content hash (CID).
2. If the target's approval threshold is `1`, the registry verifies the attestation against the author's DID document signing key and commits the record immediately.
3. If the threshold is greater than `1` (or the release was uploaded by a CI automation account that requires human approval), the registry holds the proposed record in a pending state until enough eligible maintainers have written matching attestations in their own repositories.

Because each maintainer's attestation lives in their own PDS repository and is signed by their own key, compromising one maintainer account—or even the registry itself—cannot forge approvals from other maintainers on the public checksum log.

## Reviewing and approving changes

Use `zena pkg approve` to inspect pending releases or membership changes and write your attestation:

```sh
# Inspect a held release
zena pkg approve acme:router@2.0.0

# Approve the release (writes an attestation to your repository and notifies the registry)
zena pkg approve acme:router@2.0.0 --yes

# Inspect and approve changes waiting on a scope (its maintainers, policy,
# organization, members and teams) or on a package (its maintainers)
zena pkg approve acme
zena pkg approve acme --yes
zena pkg approve acme:router --yes
```

When signed in to `pkg.zena-lang.dev`, your `/me` page and each package's page also list all releases waiting for your approval, along with the exact `zena pkg approve` command to run.

## Configuring thresholds

Every package, scope and team has its own approval thresholds:

### Package thresholds (`zena pkg owner settings`)

- **`--threshold <n>`**: How many maintainers (`owner` or `publisher`) must attest a release before it takes effect.
- **`--owner-threshold <n>`**: How many `owner`s must attest a change to the package's maintainers list or thresholds. The scope's owners can approve one instead, as many as the scope's own owner threshold.
- **`--humans <n>`**: How many of a release's approvals must come from people, not automation accounts.

```sh
# Show the thresholds of the package in this directory, or of --package acme:router
zena pkg owner settings

# Require 2 maintainer approvals for every release, and 2 owners to change maintainers
zena pkg owner settings --threshold 2 --owner-threshold 2
```

### Scope and team thresholds

- **`zena pkg scope settings <scope> [--owner-threshold <n>]`**: How many of the scope's owners must approve a change to its maintainers, its policy, its organization, and an organization's members and teams.
- **`zena pkg team settings <org>/<team> [--threshold <n>]`**: How many of the team's maintainers must approve a change to the team; the organization's owners can approve one instead.

A scope joining an organization needs both: the scope's owners and the organization's.

## Scope policies (`zena pkg scope policy`)

A scope's owners set its `dev.zena-lang.scope.policy` record: what every release of every package in the scope needs at least, and what a new package's maintainers record starts with:

```sh
# View the scope's current policy
zena pkg scope policy acme

# Require at least 2 approvals, 1 of them a person's, on every release in acme,
# and start new packages with the team acme/core as publishers and a threshold of 2
zena pkg scope policy acme \
  --minimum-threshold 2 \
  --minimum-humans 1 \
  --default-teams acme/core:publisher \
  --default-threshold 2
```

The registry holds every release in `acme` until it meets the higher of the package's threshold and the scope's minimum, and refuses a maintainers record that could never meet them. Who may create packages is the scope's maintainers record: its publishers and owners.

## CI automation accounts (`zena pkg ci create`)

To publish from GitHub Actions or another CI pipeline without giving CI a human maintainer's app password:

```sh
zena pkg ci create acme/release-bot
```

`zena pkg ci create` creates a dedicated automation account under `acme` (`release-bot.acme.pkg.zena-lang.dev`) and prints its token once. CI keeps the token as the secret `ZENA_REGISTRY_TOKEN` and runs `zena pkg publish`; `zena pkg ci token acme/release-bot` gives it a new one if it leaks, and the old one stops working. The registry writes the automation account's attestations itself. You can then add the automation account as a `publisher` on specific packages:

```sh
zena pkg owner add release-bot.acme.pkg.zena-lang.dev --automation --package acme:router
```

Combined with a release threshold or human-approval requirement, CI can build and upload release candidates automatically while a human maintainer gives the final `zena pkg approve` from their workstation.
