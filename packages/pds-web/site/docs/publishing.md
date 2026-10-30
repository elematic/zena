---
title: Publishing Packages
---

Packages on `pkg.zena-lang.dev` do not have separate registry usernames or package passwords. You sign in with your own AT Protocol (Atmosphere) account—such as a Bluesky account or an account on your own PDS—and publish under an organization scope.

## 1. Sign in to the CLI

Create an app password in your Atmosphere account settings and sign in with `zena login`:

```sh
zena login alice.bsky.social
```

For scripts or non-interactive shells, pipe the app password over standard input or set `ZENA_APP_PASSWORD`:

```sh
echo "$APP_PASSWORD" | zena login alice.bsky.social --password-stdin
```

`zena login` stores the session in `$ZENA_CONFIG_DIR/session.json` (default `~/.config/zena/session.json`) with owner-only file permissions (`0600`). Run `zena logout` at any time to end the session and remove the file.

## 2. Create a scope

Every package hosted on `pkg.zena-lang.dev` belongs to a scope, such as `@acme`. A scope is an organization account on the package host (`acme.pkg.zena-lang.dev`).

Create a scope before publishing your first package to it:

```sh
zena scope create acme
```

You can also set a display name, description, and website for the scope's public page:

```sh
zena scope profile acme \
  --display-name "Acme Corp" \
  --description "HTTP and routing libraries for Zena" \
  --website "https://acme.example.com"
```

## 3. Prepare `zena-package.json`

To be published, a package's `zena-package.json` must include `name`, `version`, `description`, and `license` (an SPDX license expression such as `MIT` or `Apache-2.0`):

```json [zena-package.json]
{
  "name": "router",
  "scope": "acme",
  "version": "1.0.0",
  "description": "HTTP request router for Zena",
  "license": "MIT",
  "exports": {
    "server": {"path": "src/server.zena"}
  }
}
```

::: note Closed exports
Defining `exports` makes the package closed: dependents can only import the library names listed in `exports`, keeping internal helper files private to your package. See [Package Manifests](/docs/manifests/) for details.
:::

## 4. Publish a release

From the package directory, run `zena publish`:

```sh
zena publish
```

If `scope` is not set in `zena-package.json`, pass `--scope <name>` on the command line:

```sh
zena publish --scope acme
```

When `zena publish` runs:

1. **Account creation (first publish only)**: When `zena-package.json` has no `did` field, the CLI asks the package host to create a new package account (`router.acme.pkg.zena-lang.dev`) and writes the resulting `did` into `zena-package.json`. Commit this updated `zena-package.json` so future releases publish to the same DID.
2. **Archive packing and upload**: The CLI packs the package's source files and manifest into a deterministic IPLD CAR archive and uploads it as a blob to the package host.
3. **Attestation**: The CLI writes a signed `dev.zena-lang.maintainer.attestation` record into your own atproto repository, attesting to the release record's AT-URI and CID.
4. **Release commit**: Once the package's required number of maintainers (`threshold`) have attested the release, the package host commits the `dev.zena-lang.package.release` record into the package's repository.

## 5. Approving multi-maintainer releases

When a package is configured to require more than one maintainer approval (for example, 2 of 3 maintainers, or human approval of a CI publish), `zena publish` holds the release in a pending state on the host.

Other maintainers can inspect the pending release and its diff or metadata with `zena approve`:

```sh
# Inspect what is waiting for approval
zena approve router.acme.pkg.zena-lang.dev@1.0.0

# Write your attestation and complete the release once the threshold is met
zena approve router.acme.pkg.zena-lang.dev@1.0.0 --yes
```

Pending releases also appear on the package's web page and on `/me` when signed in to `pkg.zena-lang.dev`.

## Retracting a version

Published versions are immutable and cannot be overwritten. If a release has a critical bug or security issue, mark it as retracted so version selection skips it:

```sh
zena retract 1.0.0 --reason "Broken header parsing on empty values; upgrade to 1.0.1"
```

Existing workspaces that already pinned `1.0.0` in `zena-lock.json` continue to build reproducibly, while `zena add` and `zena update` skip retracted versions and the web UI marks the version as retracted.
