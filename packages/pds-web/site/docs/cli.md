---
title: CLI Commands
---

The `zena` CLI includes all package manager commands alongside the compiler, test runner, formatter, and linter.

## Dependency management

### `zena add`

```sh
zena add <package>[@<version>] [--name <local-name>]
```

Adds a published package to the current package's `zena-package.json`, runs minimal version selection across the workspace, updates `zena-lock.json`, and fetches the resolved archives into the package cache.

- `<package>`: `@scope/name`, a handle (`router.acme.pkg.zena-lang.dev`), or a DID (`did:plc:...`, `did:web:...`).
- `@<version>`: Optional minimum version to require (defaults to the package's latest non-retracted release).
- `--name <local-name>`: Local import alias in `zena-package.json` (defaults to the name in the package's profile).

### `zena update`

```sh
zena update [<local-name>...]
```

Raises the specified dependencies (or all dependencies when none are named) to the latest non-retracted version within their current major version, updates `zena-lock.json`, and fetches any new archives.

### `zena fetch`

```sh
zena fetch
```

Downloads and unpacks every package archive pinned in `zena-lock.json` into the local package cache, verifying every release record and source archive against its pinned CID. Modifies no workspace files.

---

## Authentication

### `zena login`

```sh
zena login <handle-or-did> [--password-stdin]
```

Signs in to an AT Protocol account using an app password (prompted on the terminal, read from stdin with `--password-stdin`, or read from `ZENA_APP_PASSWORD`). Saves the session to `$ZENA_CONFIG_DIR/session.json`.

### `zena logout`

```sh
zena logout
```

Ends the current session and removes `$ZENA_CONFIG_DIR/session.json`.

---

## Publishing & releases

### `zena publish`

```sh
zena publish [--scope <name>] [--host <url>] [--yes]
```

Packs and publishes the package in the current directory at the `version` in `zena-package.json`. Creates the package account on first publish when `zena-package.json` has no `did`.

### `zena package create`

```sh
zena package create [--scope <name>] [--host <url>] [--yes]
```

Creates the package's account on the package host and writes its `did` into `zena-package.json` without publishing a release.

### `zena approve`

```sh
zena approve [<package>@]<version> | @<scope> | <package> [--yes]
```

Without `--yes`, displays the pending release or pending membership/settings change waiting for maintainer attestations. With `--yes`, writes your attestation record to your repository and submits it to the package host.

### `zena retract`

```sh
zena retract <version> [--reason <text>]
```

Publishes a `dev.zena-lang.package.retraction` record for `<version>` so version selection skips it.

### `zena ci create`

```sh
zena ci create <scope>/<name>
```

Creates an automation account in `<scope>` for CI pipelines to authenticate and publish with.

---

## Scopes, teams & maintainers

### `zena scope`

```sh
zena scope create <scope> [--yes]
zena scope info <scope>
zena scope profile <scope> [--display-name <text>] [--description <text>] [--website <url>]
zena scope members <scope>
zena scope add <scope> <person> [--role <owner|admin|member>] [--public]
zena scope remove <scope> <person>
zena scope settings <scope> [--owner-threshold <n>]
zena scope policy <scope> [--min-release-threshold <n>] [--default-release-threshold <n>] [--min-owner-threshold <n>] [--package-creators <admin|member>]
```

Creates and manages organization scopes, their public profile, members, approval thresholds, and package security policies.

### `zena team`

```sh
zena team create <scope> <team>
zena team delete <scope> <team>
zena team members <scope> <team>
zena team add <scope> <team> <person> [--role <maintainer|member>]
zena team remove <scope> <team> <person>
zena team settings <scope> <team> [--threshold <n>]
```

Creates and manages teams within an organization scope.

### `zena owner`

```sh
zena owner list [<package>]
zena owner add [<package>] <person-or-team> [--role <owner|publisher>] [--public]
zena owner remove [<package>] <person-or-team>
zena owner settings [<package>] [--threshold <n>] [--owner-threshold <n>]
```

Lists and modifies a package's maintainers (`owner` and `publisher` roles) and release/owner approval thresholds.

---

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ZENA_PACKAGE_HOST` | `https://pkg.zena-lang.dev` | Default package host URL for `publish`, `scope`, `team`, `owner`, and `@scope/name` lookups |
| `ZENA_CONFIG_DIR` | `~/.config/zena` | Directory where `session.json` is stored |
| `ZENA_CACHE_DIR` | `~/.cache/zena` | Base directory for the unpacked package cache (`packages/sources/<cid>`) |
| `ZENA_PROJECT_CACHE` | *(unset)* | When set, stores the package cache in `.zena/packages` inside the workspace |
| `ZENA_APP_PASSWORD` | *(unset)* | App password used by `zena login` when not reading from terminal or stdin |
| `ZENA_PLC_DIRECTORY` | `https://plc.directory` | PLC directory URL used to resolve `did:plc:` identities |
| `ZENA_DNS_OVER_HTTPS` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS endpoint used to resolve `_atproto.<handle>` TXT records |
