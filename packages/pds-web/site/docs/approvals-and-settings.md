---
title: Approvals, Thresholds & Policies
---

The Zena package manager protects packages against single-account compromise by separating proposing a change from approving it, and verifying approvals through independent AT Protocol repositories.

## How maintainer attestations work

When a maintainer publishes a release or proposes a change to a package's maintainers, a scope's members, or a team:

1. The author's CLI writes a `dev.zena-lang.maintainer.attestation` record into the author's own atproto repository, naming the target record's AT-URI and its content hash (CID).
2. If the target's approval threshold is `1`, the package host verifies the attestation against the author's DID document signing key and commits the record immediately.
3. If the threshold is greater than `1` (or the release was uploaded by a CI automation account that requires human approval), the host holds the proposed record in a pending state until enough eligible maintainers have written matching attestations in their own repositories.

Because each maintainer's attestation lives in their own PDS repository and is signed by their own key, compromising one maintainer account—or even the package host itself—cannot forge approvals from other maintainers on the public checksum log.

## Reviewing and approving changes

Use `zena approve` to inspect pending releases or membership changes and write your attestation:

```sh
# Inspect a held release
zena approve @acme/router@2.0.0

# Approve the release (writes an attestation to your repository and notifies the host)
zena approve @acme/router@2.0.0 --yes

# Inspect and approve pending membership or team changes on a scope or package
zena approve @acme
zena approve @acme --yes
zena approve @acme/router --yes
```

When signed in to `pkg.zena-lang.dev`, your `/me` page and each package's page also list all releases waiting for your approval, along with the exact `zena approve` command to run.

## Configuring thresholds

Every package, scope, and team has configurable approval thresholds:

### Package thresholds (`zena owner settings`)

- **`--threshold <n>`**: How many maintainers (`owner` or `publisher`) must attest a release before it takes effect.
- **`--owner-threshold <n>`**: How many `owner`s must attest a change to the package's maintainers list or thresholds.

```sh
# Show current thresholds for a package
zena owner settings @acme/router

# Require 2 maintainer approvals for every release, and 2 owners to change maintainers
zena owner settings @acme/router --threshold 2 --owner-threshold 2
```

### Scope and team thresholds

- **`zena scope settings <scope> [--owner-threshold <n>]`**: How many organization owners must approve changes to the scope's members or policies.
- **`zena team settings <scope> <team> [--threshold <n>]`**: How many team maintainers must approve changes to the team's membership.

## Scope policies (`zena scope policy`)

Organization owners can set a `dev.zena-lang.org.policy` record on a scope to enforce minimum security requirements across every package in the scope:

```sh
# View the scope's current policy
zena scope policy acme

# Require at least 2 maintainer approvals on every package in @acme,
# and allow any organization member to create new packages
zena scope policy acme \
  --min-release-threshold 2 \
  --default-release-threshold 2 \
  --min-owner-threshold 2 \
  --package-creators member
```

A package in `@acme` cannot set its `threshold` below the scope's `minReleaseThreshold`, and the package host refuses any release that does not meet the higher of the package's threshold and the scope's minimum.

## CI automation accounts (`zena ci create`)

To publish from GitHub Actions or another CI pipeline without giving CI a human maintainer's app password:

```sh
zena ci create acme/release-bot
```

`zena ci create` creates a dedicated automation account under `@acme` (`release-bot.acme.pkg.zena-lang.dev`) and prints an app password for CI. You can then add the automation account as a `publisher` on specific packages:

```sh
zena owner add @acme/router release-bot.acme.pkg.zena-lang.dev --role publisher
```

Combined with a release threshold or human-approval requirement, CI can build and upload release candidates automatically while a human maintainer gives the final `zena approve` from their workstation.
