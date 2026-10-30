---
title: Workspaces & Lockfiles
lead: Develop multiple packages together in one repository and pin dependencies reproducibly with zena-lock.json.
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
      index.zena
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
    "router": {"did": "did:plc:routerrouterrouterrouter", "version": "1.4.2"}
  }
}
```

When you publish `packages/server` with `zena publish`, the CLI replaces `{"path": "../core"}` in the published release record with `core`'s `did` and `version` from `packages/core/zena-package.json`. Publish `packages/core` first so that it has a `did` and a published release on the host.

## Minimal version selection

Zena uses **minimal version selection** (as in Go modules) rather than SAT-based range solving:

- Every dependency specifies a **minimum version** (e.g., `1.4.2`), which accepts `1.4.2` or any later `1.x` release.
- Within a single major version (`1.x`), the version selected for the workspace is the **highest minimum version** requested by any package in the workspace's dependency graph.
- Different major versions (`1.x` and `2.x`) are treated as distinct compatibility lines (`<did>@1` and `<did>@2`) and can coexist in the same build when different parts of the dependency graph require them.
- New releases published upstream never enter your build automatically; versions only change when you run `zena add` or `zena update`.

## `zena-lock.json`

`zena add` and `zena update` write `zena-lock.json` at the workspace root. Do not edit it by hand, and always commit it to version control.

```json [zena-lock.json]
{
  "resolved": {
    "did:plc:routerrouterrouterrouter@1": {
      "version": "1.4.2",
      "release": "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      "source": "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      "dependencies": {
        "json": "did:web:json.example.com@2"
      }
    },
    "did:web:json.example.com@2": {
      "version": "2.1.0",
      "release": "bafyreibvjvcv745gig4mvqs4hctx4zfkono4rjejm2ta6gtyzkqxfjeily",
      "source": "bafkreibvjvcv745gig4mvqs4hctx4zfkono4rjejm2ta6gtyzkqxfjeily"
    }
  }
}
```

Each entry under `resolved` is keyed by `<did>@<major-version>` and records:

- **`version`**: The exact semantic version selected for that major version.
- **`release`**: The CID of the `dev.zena-lang.package.release` record in the package's atproto repository.
- **`source`**: The CID of the source archive blob (`application/vnd.ipld.car`), which `zena fetch` verifies and unpacks into `sources/<source-cid>` in the package cache.
- **`dependencies`**: Map from the local names used inside that package's source to the `<did>@<major>` keys of its own dependencies.
