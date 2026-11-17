---
title: Workspaces & Lockfiles
---

A **workspace** is the root directory you work in: either a single package or a multi-package repository sharing one `zena-lock.json` lockfile.

## Single-package vs. multi-package workspaces

A single package with a `zena-package.json` is already a workspace of one. To grow it into a multi-package workspace, add a `workspace` field to the root `zena-package.json` listing member directories or `/*` globs:

```
my-workspace/
  zena-package.json        # workspace root
  zena-lock.json           # shared lockfile for all workspace packages
  packages/
    core/
      zena-package.json    # name: "core"
      main.zena
    server/
      zena-package.json    # name: "server", depends on "core" via path
      server.zena
```

```json [my-workspace/zena-package.json]
{
  "scope": "acme",
  "workspace": {
    "packages": ["packages/*"]
  }
}
```

- If the root `zena-package.json` also has a `name`, the root directory is a workspace package alongside the directories in `workspace.packages`.
- If the root `zena-package.json` has `scope`, member packages without their own `scope` inherit it when publishing.

## Cross-package dependencies

Workspace packages depend on each other using `path` dependencies:

```json [packages/server/zena-package.json]
{
  "name": "server",
  "version": "1.0.0",
  "description": "HTTP server built on core",
  "license": "MIT",
  "exports": {
    "server": {}
  },
  "dependencies": {
    "core": {"path": "../core"},
    "router": {"did": "did:plc:routerrouterrouterrouter", "version": "^1.4.2"}
  }
}
```

When you publish `packages/server` with `zena pkg publish`, the CLI replaces `{"path": "../core"}` in the published release record with `core`'s `did`, and `^` and the `version` from `packages/core/zena-package.json`. Publish `packages/core` first so that it has a `did` and a published release on the registry.

## Version selection

- Every dependency gives the versions it accepts as a range, in npm's syntax: `^1.4.2` accepts `1.4.2` or any later `1.x` release, and `zena pkg add` writes ranges of that form.
- Selection installs as few versions of each package as the ranges asking for it allow: one version when one is in every range, and the highest such version. Two packages asking for `^1.0.0` and `~1.1.0` share `1.1.x`.
- When no one version is in every range, as for `^1.0.0` and `^2.0.0`, selection installs more than one, and each package uses the highest selected version in its own range. `zena pkg add` and `zena pkg update` list such packages, and `--duplicates warn` or `error` makes them a warning or an error.
- Once `zena-lock.json` pins a version, `zena pkg add` keeps it while the ranges allow; it lowers a version only to share one with another package, and says so with a warning.
- New releases published upstream never enter your build automatically; versions only change when you run `zena pkg add` or `zena pkg update`.

## `zena-lock.json`

`zena pkg add` and `zena pkg update` write `zena-lock.json` at the workspace root. Do not edit it by hand, and always commit it to version control.

```json [zena-lock.json]
{
  "lockfileVersion": 1,
  "workspace": {
    "packages/server": {"router": "did:plc:routerrouterrouterrouter@1.4.2"}
  },
  "resolved": {
    "did:plc:routerrouterrouterrouter@1.4.2": {
      "release": "bafyreiacaqzs6eeir3sujrd7r2olqqvv5pz7u6u52fnefvplhfizfbbngi",
      "source": "bafkreibcvpjyzvstyfv4tuymmku7cbry7rzwusztpf3dappir5wh55kpsy",
      "dependencies": {
        "json": "did:web:json.example.com@2.1.0"
      }
    },
    "did:web:json.example.com@2.1.0": {
      "release": "bafyreiav6xyaoqpx6byrh727pez7ovomlndqwwqiatiwvvq5qlxfrlri6e",
      "source": "bafkreidte7rh73ye5s7ctf2qzmb2ciuroxpoe2t6fgvknkstljoody2aba"
    }
  }
}
```

**`lockfileVersion`** is the version of the lockfile's format, a number of its own, unrelated to any package's version. It is `1`. A `zena` that reads another version refuses the lockfile: given a newer one, upgrade `zena`; given an older one, or a lockfile without the field, delete it and run `zena pkg update` to write it again.

`workspace` gives, for each workspace package by its directory (`.` for the root), the pinned version each of its published dependencies stands for. Each entry under `resolved` is keyed by `<did>@<version>`, the package and the version selected, and records:

- **`release`**: The CID of the `dev.zena-lang.package.release` record in the package's atproto repository: a hash of the record, which names the version, the source archive and the dependencies.
- **`source`**: The CID of the source archive blob (`application/vnd.ipld.car`): a hash of its bytes. `zena pkg fetch` checks the archive against it, and unpacks it into `sources/<source-cid>` in the package cache.
- **`dependencies`**: Map from the local names used inside that package's source to the `<did>@<version>` keys of its own dependencies, which are keys of `resolved` too.

Both CIDs are checksums: `zena pkg fetch` refuses a release record or an archive that does not match its pin, so a build from a committed `zena-lock.json` gets the same bytes or fails.
