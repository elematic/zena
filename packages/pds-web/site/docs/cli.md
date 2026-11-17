---
title: CLI Commands
---

The `zena` CLI includes all package manager commands alongside the compiler, test runner, formatter, and linter.

## Starting a package

### `zena pkg init`

```sh
zena pkg init [<dir>] [--name <name>] [--scope <scope>]
```

Makes the current directory, or `<dir>`, a package by writing its `zena-package.json`. It creates `<dir>` if it does not exist yet.

- `--name <name>`: The package's name. Defaults to the directory's name, which must then be a valid package name: lowercase letters, digits and `-`, starting with a letter.
- `--scope <scope>`: The scope the package is published in.

The version starts at `0.1.0`. `zena pkg init` never overwrites an existing `zena-package.json`.

## Dependency management

### `zena pkg add`

```sh
zena pkg add <package>[@<version>] [--name <local-name>]
```

Adds a published package to the current package's `zena-package.json`, selects versions across the workspace, updates `zena-lock.json`, and fetches the resolved archives into the package cache.

- `<package>`: `scope:name`, a handle (`router.acme.pkg.zena-lang.dev`), or a DID (`did:plc:...`, `did:web:...`).
- `@<version>`: Optional version to start the range from; the manifest gets `^<version>` (defaults to the package's latest non-retracted release).
- `--name <local-name>`: Local import alias in `zena-package.json` (defaults to the name in the package's profile).

### `zena pkg update`

```sh
zena pkg update [<local-name>...]
```

Selects versions again for the specified dependencies (or all dependencies when none are named), taking the latest non-retracted version their ranges allow instead of the version `zena-lock.json` pins, updates `zena-lock.json`, and fetches any new archives. The manifests do not change.

`zena pkg add` and `zena pkg update` both take `--duplicates allow|warn|error`: what to do when no one version of a package is in every range that asks for it, so that two are installed. `allow`, the default, lists them; `warn` prints a warning; `error` refuses and writes nothing. `"duplicates"` in the workspace root's `zena-package.json` sets the default.

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
zena pkg approve [<package>@]<version> | <scope> | <package> [--yes]
```

Without `--yes`, shows the release, or the changes to who belongs and to settings, waiting for approval. With `--yes`, writes your attestation record to your repository and submits it to the registry.

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

### `zena pkg ci retire`

```sh
zena pkg ci retire <scope>/<name>
```

Retires the automation account, for CI that no longer runs: its token stops working, and it gets no other. The registry refuses while a package's maintainers name it.

---

## Scopes, organizations, teams & maintainers

### `zena pkg scope`

```sh
zena pkg scope create <scope> [--yes]
zena pkg scope info <scope>
zena pkg scope profile <scope> [--name <text>] [--description <text>] [--website <url>]
zena pkg scope maintainers <scope>
zena pkg scope add <scope> <person> [--role <publisher|owner>]
zena pkg scope add <scope> --team <org>/<team> [--role <publisher|owner>]
zena pkg scope remove <scope> <person>
zena pkg scope remove <scope> --team <org>/<team>
zena pkg scope settings <scope> [--owner-threshold <n>]
zena pkg scope policy <scope> [--minimum-threshold <n>] [--minimum-humans <n>] [--default-teams <org>/<team>:<role>,...] [--default-threshold <n>] [--default-owner-threshold <n>] [--default-humans <n>]
zena pkg scope upgrade <scope> --yes
zena pkg scope join <scope> <org>
zena pkg scope leave <scope>
```

Creates scopes and manages their profile, their maintainers (`publisher` and `owner`), how many owners must approve a change, and their policy for their packages. `upgrade` makes a scope an organization; `join` and `leave` put a scope in an organization and take it out. See [Scopes, Orgs & Teams](/docs/orgs-and-teams/).

### `zena pkg org`

```sh
zena pkg org add <org> <person>
zena pkg org remove <org> <person>
zena pkg org members <org>
```

Manages an organization's members, the people its teams can have.

### `zena pkg team`

```sh
zena pkg team create <org>/<team>
zena pkg team delete <org>/<team>
zena pkg team members <org>/<team>
zena pkg team add <org>/<team> <person> [--role <member|maintainer>]
zena pkg team remove <org>/<team> <person>
zena pkg team settings <org>/<team> [--threshold <n>]
```

Creates and manages an organization's teams.

### `zena pkg owner`

```sh
zena pkg owner list [--package <package>]
zena pkg owner add <person> [--role <publisher|owner>] [--automation] [--package <package>]
zena pkg owner add --team <org>/<team> [--role <publisher|owner>] [--package <package>]
zena pkg owner remove <person> [--package <package>]
zena pkg owner remove --team <org>/<team> [--package <package>]
zena pkg owner settings [--threshold <n>] [--owner-threshold <n>] [--humans <n>] [--package <package>]
```

Lists and changes a package's maintainers (`publisher` and `owner`) and its approval thresholds: the package in the current directory, or the one `--package` names by `scope:name`, handle or DID. `--automation` marks an automation account from `zena pkg ci create`.

---

## Environment variables

| Variable              | Default                                | Description                                                                   |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `ZENA_REGISTRY`       | `https://pkg.zena-lang.dev`            | The registry `publish`, `scope`, `org`, `team` and `owner` call               |
| `ZENA_CONFIG_DIR`     | `~/.config/zena`                       | Directory where `session.json` is stored                                      |
| `ZENA_CACHE_DIR`      | `~/.cache/zena`                        | Base directory for the unpacked package cache (`packages/sources/<cid>`)      |
| `ZENA_PROJECT_CACHE`  | _(unset)_                              | When set, stores the package cache in `.zena/packages` inside the workspace   |
| `ZENA_APP_PASSWORD`   | _(unset)_                              | App password used by `zena pkg login` when not reading from terminal or stdin |
| `ZENA_REGISTRY_TOKEN` | _(unset)_                              | An automation account's token, which `zena pkg publish` uses in CI            |
| `ZENA_PLC_DIRECTORY`  | `https://plc.directory`                | PLC directory URL used to resolve `did:plc:` identities                       |
| `ZENA_DNS_OVER_HTTPS` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS endpoint used to resolve `_atproto.<handle>` TXT records       |
