---
title: Scopes, Orgs & Teams
---

Every package on a registry is in a scope, such as `acme` on `pkg.zena-lang.dev`. A scope is an AT Protocol account of its own (`acme.pkg.zena-lang.dev`), and its maintainers decide who creates packages in it. A scope can be upgraded to an organization, which also has members and teams. Other scopes can belong to an organization, which groups them with it.

## Scope maintainers

A scope's maintainers record names people, or teams, in one of two roles:

| Role            | Can                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`publisher`** | Create packages in the scope, starting as an owner of each                                                                                                                              |
| **`owner`**     | Also change the scope's maintainers, policy and profile, create its CI automation accounts, upgrade it to an organization or put it in one, and change any of its packages' maintainers |

Whoever creates a scope is its first owner, and has no other standing in it: like any owner, they can later be removed. Publishing a release stays with each package's own maintainers.

```sh
# Create a scope; you are its first owner
zena pkg scope create acme --yes

# Its profile, how many owners and publishers it has, and its organization
zena pkg scope info acme

# Its maintainers, as far as you may see them
zena pkg scope maintainers acme

# Add a person as a publisher (the default) or as an owner
zena pkg scope add acme bob.bsky.social
zena pkg scope add acme carol.bsky.social --role owner

# Add a team, so that each of its members creates packages
zena pkg scope add acme --team acme/core

# Remove a person or a team
zena pkg scope remove acme bob.bsky.social
```

## Organizations

An organization is a scope with **members**, the people its teams are made of, and **teams**. Its owners are its scope's owners, and they change its members and teams. Being a member gives no role by itself: a person acts on a scope or a package only through its maintainers record, as themselves or through a team.

```sh
# Upgrade the scope; its owners become its first members
zena pkg scope upgrade acme --yes

# Add and remove members, and list those you may see
zena pkg org add acme dave.bsky.social
zena pkg org remove acme dave.bsky.social
zena pkg org members acme
```

### Teams

A team is a named group of an organization's members, which any scope's or package's maintainers record can name in a role. Changing who is on a team changes it everywhere the team is named. Each member of a team has one of two roles in it:

- **`maintainer`**: changes the team, as the organization's owners can.
- **`member`**: acts in the role the team is given.

```sh
zena pkg team create acme/core
zena pkg team add acme/core bob.bsky.social --role maintainer
zena pkg team add acme/core carol.bsky.social
zena pkg team members acme/core
zena pkg team remove acme/core carol.bsky.social
zena pkg team delete acme/core
```

### Scopes in an organization

A scope belongs to an organization once the owners of both have approved it. Belonging groups the scope with the organization: the organization's page lists it. It gives the organization's people no role in the scope. Give a team a role in the scope's maintainers for that.

```sh
# Ask for acme-labs to join acme; acme's owners approve it with zena pkg approve acme-labs
zena pkg scope join acme-labs acme

# Take it out, as an owner of either side
zena pkg scope leave acme-labs
```

## Package maintainers

Each package has its own `dev.zena-lang.package.maintainers` record of who publishes it and who changes its maintainers. A maintainer is a person or an organization's team:

| Role            | Can                                                                |
| --------------- | ------------------------------------------------------------------ |
| **`publisher`** | Publish and approve releases, and retract versions                 |
| **`owner`**     | Also change the package's maintainers, and its approval thresholds |

The owners of the package's scope can change its maintainers too.

```sh
# In the package's directory, or with --package acme:router
zena pkg owner list
zena pkg owner add bob.bsky.social                # a publisher
zena pkg owner add dave.bsky.social --role owner
zena pkg owner add --team acme/core               # the team publishes it
zena pkg owner remove bob.bsky.social
```

## Private membership

Maintainers, members and team members are recorded in the public repositories as **cryptographic commitments** to private entries, not as DIDs:

- **Private until acting**: a visitor to `pkg.zena-lang.dev`, or a reader of the repository, sees "a private member" until that person approves a release or a change.
- **Seen by those who decide**: signed in to `pkg.zena-lang.dev` or to `zena`, you see your own entries; a scope's owners see every entry of the scope, its organization and its packages; a team's maintainers see the team's; and a package's owners see the package's.
- **Accountable when acting**: an approval is a signed attestation record in the approver's own repository. A package's page shows who approved each release.
