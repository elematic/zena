---
title: Scopes, Orgs & Teams
---

Every scope on a package host (such as `@acme` on `pkg.zena-lang.dev`) is an organization backed by its own AT Protocol account (`acme.pkg.zena-lang.dev`). Organizations group packages under a shared namespace, manage members and teams, and enforce security policies across their packages.

## Organization roles

Each member of a scope has one of three roles:

| Role         | Permissions                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **`owner`**  | Full control: add or remove owners, admins, and members; change owner thresholds and scope policies; create teams and packages             |
| **`admin`**  | Manage members and teams; update the scope's profile (`displayName`, `description`, `website`); create packages and CI automation accounts |
| **`member`** | Belong to the organization and its teams; can create packages when the scope's policy sets `packageCreators` to `member`                   |

### Managing scope members

```sh
# Create a new scope (you become its initial owner)
zena scope create acme

# Inspect a scope's profile, policies, and visible members
zena scope info acme
zena scope members acme

# Add or change a person's role in the scope
zena scope add acme bob.bsky.social --role admin
zena scope add acme carol.bsky.social --role member

# Remove a member from the scope
zena scope remove acme carol.bsky.social
```

## Teams

Teams let an organization grant package publishing rights to a group of members and manage that group in one place.

Each member of a team has one of two roles within the team:

- **`maintainer`**: Can add or remove team members and view the team's private membership list.
- **`member`**: Can publish and attest releases for any package that lists the team as a maintainer.

```sh
# Create a team inside @acme
zena team create acme core

# Add members to the team
zena team add acme core bob.bsky.social --role maintainer
zena team add acme core carol.bsky.social --role member

# List team members or delete a team
zena team members acme core
zena team delete acme core
```

## Package maintainers

Each package has its own `dev.zena-lang.package.maintainers` record listing who can publish releases and who can change the package's maintainers. A maintainer entry can name either an individual person or an organization team:

| Role            | Permissions                                                                               |
| --------------- | ----------------------------------------------------------------------------------------- |
| **`owner`**     | Can publish and approve releases, retract versions, and add or remove package maintainers |
| **`publisher`** | Can publish and approve releases and retract versions                                     |

```sh
# List a package's maintainers
zena owner list @acme/router

# Add an individual publisher or owner
zena owner add @acme/router bob.bsky.social --role publisher
zena owner add @acme/router dave.bsky.social --role owner

# Grant a team publishing rights on a package
zena owner add @acme/router @acme/core --role publisher

# Remove a maintainer
zena owner remove @acme/router bob.bsky.social
```

## Private membership commitments

By default, organization members, team members, and package publishers are recorded in the public atproto repository as **cryptographic commitments** (`SHA-256(DID || role || 192-bit nonce)`) rather than plain DIDs:

- **Privacy before acting**: A visitor browsing `pkg.zena-lang.dev` or reading the organization's repository sees `"a private member"` until that person publishes or approves a release.
- **Role-based visibility**: When signed in to `pkg.zena-lang.dev` or the CLI, you can see your own memberships, and organization owners/admins, team maintainers, and package owners can see the members of the records they administer.
- **Public accountability when acting**: When a maintainer approves a release or a membership change, they write a signed attestation record in their own repository. The package page displays the approvers of each release.
