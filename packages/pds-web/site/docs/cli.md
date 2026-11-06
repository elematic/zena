---
title: CLI Commands
---

The `zena` CLI includes all package manager commands alongside the compiler, test runner, formatter, and linter.

## Dependency management

### `zena pkg add`

```sh
zena pkg add <package>[@<version>] [--name <local-name>]
```

Adds a published package to the current package's `zena-package.json`, runs minimal version selection across the workspace, updates `zena-lock.json`, and fetches the resolved archives into the package cache.

- `<package>`: `@scope/name`, a handle (`router.acme.pkg.zena-lang.dev`), or a DID (`did:plc:...`, `did:web:...`).
- `@<version>`: Optional minimum version to require (defaults to the package's latest non-retracted release).
- `--name <local-name>`: Local import alias in `zena-package.json` (defaults to the name in the package's profile).

### `zena pkg update`

```sh
zena pkg update [<local-name>...]
```

Raises the specified dependencies (or all dependencies when none are named) to the latest non-retracted version within their current major version, updates `zena-lock.json`, and fetches any new archives.

### `zena pkg fetch`

```sh
zena pkg fetch
```

Downloads and unpacks every package archive pinned in `zena-lock.json` into the local package cache, verifying every release record and source archive against its pinned CID. Modifies no workspace files.

---

## Authentication

### `zena pkg login`

```sh
zena pkg login <handle-or-did> [--password-stdin]
```

Signs in to an AT Protocol account using an app password (prompted on the terminal, read from stdin with `--password-stdin`, or read from `ZENA_APP_PASSWORD`). Saves the session to `$ZENA_CONFIG_DIR/session.json`.

### `zena pkg logout`

```sh
zena pkg logout
```

Ends the current session and removes `$ZENA_CONFIG_DIR/session.json`.

---

## Publishing & releases

### `zena pkg publish`

```sh
zena pkg publish [--scope <name>] [--registry <url>] [--yes]
```

Packs and publishes the package in the current directory at the `version` in `zena-package.json`. Creates the package account on first publish when `zena-package.json` has no `did`.

### `zena pkg create`

```sh
zena pkg create [--scope <name>] [--registry <url>] [--yes]
```

Creates the package's account on the registry and writes its `did` into `zena-package.json` without publishing a release.

### `zena pkg approve`

```sh
zena pkg approve [<package>@]<version> | @<scope> | <package> [--yes]
```

Without `--yes`, displays the pending release or pending membership/settings change waiting for maintainer attestations. With `--yes`, writes your attestation record to your repository and submits it to the registry.

### `zena pkg retract`

```sh
zena pkg retract <version> [--reason <text>]
```

Publishes a `dev.zena-lang.package.retraction` record for `<version>` so version selection skips it.

### `zena pkg ci create`

```sh
zena pkg ci create <scope>/<name>
```

Creates an automation account in `<scope>` for CI pipelines to publish as, and prints its token once. CI keeps the token as the secret `ZENA_REGISTRY_TOKEN` and runs `zena pkg publish`, signed in to nothing.

### `zena pkg ci token`

```sh
zena pkg ci token <scope>/<name>
```

Gives the automation account a new token, for one that leaked or was lost. The old token stops working.

---

## Scopes, teams & maintainers

### `zena pkg scope`

```sh
zena pkg scope create <scope> [--yes]
zena pkg scope info <scope>
zena pkg scope profile <scope> [--display-name <text>] [--description <text>] [--website <url>]
zena pkg scope members <scope>
zena pkg scope add <scope> <person> [--role <owner|admin|member>] [--public]
zena pkg scope remove <scope> <person>
zena pkg scope settings <scope> [--owner-threshold <n>]
zena pkg scope policy <scope> [--min-release-threshold <n>] [--default-release-threshold <n>] [--min-owner-threshold <n>] [--package-creators <admin|member>]
```

Creates and manages organization scopes, their public profile, members, approval thresholds, and package security policies.

### `zena pkg team`

```sh
zena pkg team create <scope> <team>
zena pkg team delete <scope> <team>
zena pkg team members <scope> <team>
zena pkg team add <scope> <team> <person> [--role <maintainer|member>]
zena pkg team remove <scope> <team> <person>
zena pkg team settings <scope> <team> [--threshold <n>]
```

Creates and manages teams within an organization scope.

### `zena pkg owner`

```sh
zena pkg owner list [<package>]
zena pkg owner add [<package>] <person-or-team> [--role <owner|publisher>] [--public]
zena pkg owner remove [<package>] <person-or-team>
zena pkg owner settings [<package>] [--threshold <n>] [--owner-threshold <n>]
```

Lists and modifies a package's maintainers (`owner` and `publisher` roles) and release/owner approval thresholds.

---

## Environment variables

| Variable              | Default                                | Description                                                                   |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `ZENA_REGISTRY`       | `https://padstone.zena-lang.dev`       | The registry `publish`, `scope`, `team` and `owner` call                      |
| `ZENA_CONFIG_DIR`     | `~/.config/zena`                       | Directory where `session.json` is stored                                      |
| `ZENA_CACHE_DIR`      | `~/.cache/zena`                        | Base directory for the unpacked package cache (`packages/sources/<cid>`)      |
| `ZENA_PROJECT_CACHE`  | _(unset)_                              | When set, stores the package cache in `.zena/packages` inside the workspace   |
| `ZENA_APP_PASSWORD`   | _(unset)_                              | App password used by `zena pkg login` when not reading from terminal or stdin |
| `ZENA_REGISTRY_TOKEN` | _(unset)_                              | An automation account's token, which `zena pkg publish` uses in CI            |
| `ZENA_PLC_DIRECTORY`  | `https://plc.directory`                | PLC directory URL used to resolve `did:plc:` identities                       |
| `ZENA_DNS_OVER_HTTPS` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS endpoint used to resolve `_atproto.<handle>` TXT records       |
