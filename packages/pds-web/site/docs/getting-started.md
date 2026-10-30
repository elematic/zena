---
title: Getting Started
lead: Create a package manifest, add published dependencies, and import them in Zena code.
---

## Creating a package

Every Zena package is a directory with a `zena-package.json` manifest and one or more `.zena` source files (called libraries).

Create a directory for your project and write a minimal `zena-package.json`:

```json [zena-package.json]
{
  "name": "my-app",
  "version": "0.1.0"
}
```

Create a `main.zena` file in the same directory:

```zena [main.zena]
export function main(): void {
  console.log('Hello from my-app');
}
```

Run it with `zena run`:

```sh
zena run main.zena
```

## Adding a dependency

Use `zena add` to add a published package to your project. You can refer to a package by `@scope/name`, by its full handle, or by its DID:

```sh
# By @scope/name on the default host (pkg.zena-lang.dev)
zena add @acme/router

# By full handle (including packages on custom domains)
zena add router.acme.pkg.zena-lang.dev

# Pinning a specific minimum version
zena add @acme/router@1.4.2
```

When you run `zena add`, the CLI performs three steps:

1. Resolves the package's identity and records its DID and minimum version in `zena-package.json` under `dependencies`.
2. Selects versions across your workspace using minimal version selection and writes the exact versions and content hashes (CIDs) to `zena-lock.json`.
3. Fetches each package's source archive into the local package cache and verifies its CID against `zena-lock.json`.

After running `zena add @acme/router`, your `zena-package.json` looks like this:

```json [zena-package.json]
{
  "name": "my-app",
  "version": "0.1.0",
  "dependencies": {
    "router": {
      "did": "did:plc:routerrouterrouterrouter",
      "version": "1.4.2"
    }
  }
}
```

## Importing libraries

Libraries in your package import a dependency using the local key in `dependencies` followed by `:` and the exported library name:

```zena [main.zena]
import {Router} from 'router:server';

export function main(): void {
  let app = new Router();
}
```

### Choosing a custom local name

By default, `zena add` uses the name suggested by the dependency's profile. If that name collides with another dependency or you prefer a shorter alias, pass `--name`:

```sh
zena add @acme/router --name http-router
```

Your code then imports from `http-router:<library>` while other packages in the dependency graph continue using their own local names.

## Updating dependencies

To raise dependencies to the latest non-retracted release within their current major version:

```sh
# Update all dependencies
zena update

# Update specific dependencies by their local name
zena update router
```

To upgrade a dependency to a new major version, pass the new version explicitly to `zena add`:

```sh
zena add @acme/router@2.0.0
```

## Fetching locked packages

In CI or after cloning a repository that already has a `zena-lock.json`, run `zena fetch` to populate the local package cache without changing `zena-package.json` or `zena-lock.json`:

```sh
zena fetch
```

`zena fetch` downloads every archive pinned in `zena-lock.json` and checks that both the release record CID and source archive CID match the lockfile.

::: tip Package cache location
Downloaded source archives are unpacked under `$ZENA_CACHE_DIR/packages` (or `$XDG_CACHE_HOME/zena/packages`, defaulting to `~/.cache/zena/packages`). Set `ZENA_PROJECT_CACHE=1` to store unpacked packages inside `.zena/packages` in the workspace instead.
:::
