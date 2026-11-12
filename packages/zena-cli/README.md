# Zena CLI (`zena-cli`)

The `zena` command: build, run and test Zena programs, build targets,
format and lint them, extract API docs, benchmark, serve a language server,
and add and fetch published packages.

The command is a Zena program. `zena/main.zena` and the files beside it
are the **CLI module**, compiled to `out/zena.wasm` with the compiler,
zebra, zenadoc and the formatter linked in. `zena-cli` is the Rust binary
that runs it on wasmtime. See
[docs/design/cli-module.md](../../docs/design/cli-module.md).

The registry-side pieces (engine configuration, the `.cwasm` cache, the
stack-trace, `zena:process` and `zena:wasm` imports) live in the
[`zena-runtime`](../zena-runtime) crate. [`zena-run`](../zena-run) embeds
the same crate to run any compiled module.

## Building

```bash
npm run build -w @zena-lang/zena-cli
```

That builds the binary (`build:host`), then the compiler from the
checked-in bootstrap, then the CLI module with that compiler
(`build:module`).

## Usage

```bash
zena-cli run examples/hello-world.zena
zena-cli build main.zena -o main.wasm
zena-cli test packages/stdlib/tests
zena-cli build ./packages/zebra:test   # a build target, run with zebra
zena-cli --help
zena-cli <command> --help
```

Global flags go before the command: `-g` / `--debug` names functions in
compiled modules and turns off inlining, so traps name them, and compiles
`debug` contract clauses; `-O <0|1|2|s>`
sets the optimization level (default `1`); `-v` / `--verbose` prints more
of what the command does.

## Commands

| Command                                                         | What it does                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build <file.zena> -o <out.wasm\|.wat>`                         | Compiles a file. `--target` (`zena-component`, `component`, `js`, `zena-js`, `core`), `--wit` and `--world` for components, `--extension-wit` to check the world against an extension's WIT, `--time`. |
| `build [target]`                                                | Runs a build target with zebra, such as `build`, `build test`, or `build ./packages/zebra:test`.                                                                                                       |
| `run <file.zena\|file.wasm> [-- args...]`                       | Compiles through the compile cache and runs. `--dir HOST[::GUEST]`, `--allow-spawn`, `--allow-extensions`, `--invoke <fn>`, `--no-cache`, `--time`.                                                    |
| `test [paths or globs...]`                                      | Runs `*_test.zena` files in parallel. `-f` / `--filter`, `--exclude <glob>`.                                                                                                                           |
| `fmt [--write \| --check] <files...>`                           | Formats Zena files, printing the result, rewriting the files, or failing if any is not formatted.                                                                                                      |
| `lint [--fix] <paths...>`                                       | Reports what the lint rules find, or with `--fix` applies the fixes the type checker accepts. `--only`, `--skip`, `--list-rules`.                                                                      |
| `add <package>[@<version>] [--name <local>]`                    | Adds a published package to the current package's dependencies, pins versions in `zena-lock.json`, and fetches them.                                                                                   |
| `update [<name>...]`                                            | Selects again, without keeping the pins of the named dependencies or of all, so each gets the latest version its ranges allow that is not retracted. `--duplicates allow\|warn\|error`.                |
| `fetch`                                                         | Fetches the packages `zena-lock.json` pins into the package cache.                                                                                                                                     |
| `login <handle or DID> [--password-stdin]`                      | Signs in to your atproto account with an app password, to publish.                                                                                                                                     |
| `logout`                                                        | Ends the session `login` started.                                                                                                                                                                      |
| `publish [--scope <name> --yes] [--registry <url>]`             | Publishes the package you are in at its manifest's `version`, creating it on the registry first, in the scope `--scope` names, when it has no `did`.                                                   |
| `approve [<package>@]<version> \| <scope> \| <package> [--yes]` | Shows a release, or changes to who belongs, waiting for approval, and with `--yes` approves them.                                                                                                      |
| `package create --scope <name> --yes [--registry <url>]`        | Creates the package you are in on the registry, and writes its DID into `zena-package.json`, without publishing.                                                                                       |
| `doc <path> [-o <out.json>]`                                    | Extracts a package's public API as JSON.                                                                                                                                                               |
| `bench <suite.json> [-o <out.json>]`                            | Runs a benchmark suite.                                                                                                                                                                                |
| `lsp`                                                           | Runs the language server over stdin and stdout.                                                                                                                                                        |
| `precompile <file.wasm>`                                        | Compiles a module to machine code (`.cwasm`) ahead of its first run.                                                                                                                                   |

## Packages

A workspace is a directory with a `zena-package.json`, and the packages it
lists under `workspace.packages`, with one `zena-lock.json` beside the
root's manifest. See
[docs/design/package-manifest.md](../../docs/design/package-manifest.md)
for the files and
[docs/design/package-manager.md](../../docs/design/package-manager.md) for
how packages are published on atproto.

`zena pkg add` takes a package by DID, by handle, or as `scope:name`, which
means `name.scope.pkg.zena-lang.dev` unless the root manifest's `scopes`
maps the scope to another domain, or `ZENA_REGISTRY` names another
registry, whose domain it then asks for. Without a version it takes the latest
that is not retracted. Without `--name`, a package in a scope is named
`scope:name`, which its imports use (`'acme:router/server'`), and a
package with a handle on its own domain gets the name its profile
suggests (docs/design/import-names.md):

```bash
zena-cli pkg add acme:router@1.4.2           # as "acme:router"
zena-cli pkg add router.acme.com --name routing
zena-cli pkg update                 # every dependency of the current package
zena-cli pkg update acme:router    # only router
zena-cli pkg fetch             # what zena-lock.json pins, e.g. in CI
```

`add` and `update` change the manifest of the package the command is run
in: the workspace package whose directory holds the current directory, or
else the root, whose manifest `add` creates if there is none. They then
select versions for the whole workspace, so every package uses one
version of each package and major version, write `zena-lock.json`, and
fetch what it pins. They print what changed in the lockfile: packages
added and removed, versions upgraded and downgraded. A release the
lockfile pins that now has other CIDs at the same version was changed in
place, which a published version never is, so they refuse and write
nothing, unless you pass `--allow-changed`. `fetch` checks each release
against the CIDs the lockfile pins and the signed proofs its package's PDS
serves.

Publishing acts as you, through your own atproto account: the one you
use for Bluesky or any other app. `zena pkg login` signs in with an app
password, which your PDS issues and can revoke on its own (on bsky.social:
Settings, Privacy and security, App passwords). It reads the password from
`--password-stdin`, then `ZENA_APP_PASSWORD`, then the terminal without
showing it, and keeps the session in `session.json` in the configuration
directory, readable only by you. `zena pkg logout` ends the session.

```bash
zena-cli pkg login alice.bsky.social
echo "$APP_PASSWORD" | zena-cli pkg login alice.bsky.social --password-stdin
```

Packages on a registry are in scopes: `router.acme.<registry domain>` is
the package `router` in the scope `acme`. `zena pkg scope create acme --yes`
creates a scope, with you as its only owner, and `zena pkg scope info acme`
describes one. Publishing never creates a scope.

`zena pkg publish` publishes the package you are in, at the `version` its
`zena-package.json` gives, which needs a `description` and an SPDX
`license`, such as `"MIT"`. The first time, the package has no `did`, and
`zena pkg publish --yes` creates it on the registry in the scope its
manifest's `"scope"` names, else its workspace root's, else `--scope`.
It writes the DID into the manifest, with the scope when only `--scope`
gave it. Later publishes check that the package's handle is still in that
scope.

The release holds the files the manifest's `files` patterns name, such as
`["src", "docs", "!src/internal"]`, or without them every file but tests
(`*_test.zena`, and `test` and `tests` directories). Any file can go in:
documentation, images, demos. The manifest, a README and a license always
do, and hidden files, `node_modules` and the lockfile never do. See
docs/design/package-manifest.md, "files".

The registry holds the package's keys, as a PDS holds its users'. If you keep
a recovery key, a secp256k1 private key in hex in `recovery-key` in the
configuration directory, it is ranked above the registry's, so you can move
the package without the registry. None is made for you. Each publish uploads
the package's source archive, which the registry checks, writes your
attestation of the release to your own repository, and asks the registry to
complete it. The registry writes the release once the attestations meet the
package's maintainers record, its `threshold` of maintainers, of whom
`humans` are people; with one maintainer, that is your own. Until then
the release waits, for seven days, and the other maintainers approve it
with `zena pkg approve <package>@<version>`, which shows the release first and
approves it with `--yes`. Raise `version` to publish again.

```bash
zena-cli pkg scope create acme --yes       # once per scope
zena-cli pkg publish --scope acme --yes    # the first time, or with "scope": "acme"
zena-cli pkg publish                       # after raising "version"
zena-cli pkg retract 1.4.1 --reason "Routes with a trailing slash matched the wrong handler"
```

To publish from CI, a scope's admin creates an automation account, and a
package's owner adds it as a publisher. CI keeps the account's token as
the secret `ZENA_REGISTRY_TOKEN`, and runs `zena pkg publish`, signed in to
nothing:

```bash
zena-cli pkg ci create acme/ci                          # prints the token, once
zena-cli pkg owner add ci.acme.pkg.zena-lang.dev --automation
zena-cli pkg ci token acme/ci                           # a new token, for one that leaked; the old one stops working
```

The registry holds an automation account and writes its attestations, so
its attestation counts only together with a person's: a release CI
publishes waits until a maintainer approves it.

```bash
zena-cli pkg approve acme:router@1.5.0         # shows the release, and who has approved it
zena-cli pkg approve acme:router@1.5.0 --yes   # approves it
```

`zena pkg retract <version>` marks a release as retracted. Builds whose
lockfiles pin it keep using it, and `zena pkg add` and `zena pkg update` skip it.
Any maintainer may retract a release.

A scope's owners change who belongs to it, and a package's owners who
maintains it. Each change asks the registry for the new record, attests it in
your own repository, and asks the registry to write it. The registry writes it
once the record before it allows it: with thresholds of 1, at once, and
otherwise once enough of its owners, admins or team maintainers have
approved it with `zena pkg approve <scope>` or `zena pkg approve <package>`. Who
belongs stays private: records list commitments, and the registry shows the
entries behind them only to those who may see them.

```bash
zena-cli pkg scope add acme bob.example.com --role admin   # member, admin or owner
zena-cli pkg scope remove acme bob.example.com
zena-cli pkg scope members acme
zena-cli pkg team create acme/core
zena-cli pkg team add acme/core bob.example.com --role maintainer   # member or maintainer
zena-cli pkg owner add --team acme/core      # in a package: the team publishes it
zena-cli pkg owner add carol.example.com --role owner   # publisher or owner
zena-cli pkg owner list

zena-cli pkg owner settings --threshold 2 --humans 1   # releases need 2 approvals, 1 of them a person's
zena-cli pkg owner settings --owner-threshold 2        # changes to the maintainers need 2 owners
zena-cli pkg scope settings acme --owner-threshold 2 --admin-threshold 2
zena-cli pkg team settings acme/core --threshold 2
zena-cli pkg scope policy acme --minimum-threshold 2 --default-teams core:publisher --default-threshold 2 --creators core
zena-cli pkg scope profile acme --name "Acme Corp" --website https://acme.example
```

The `settings` commands change thresholds, and with no flags print them.
`zena pkg scope policy` sets the scope's policy for its packages: minimums
every release in the scope needs at once, the teams and thresholds new
packages start with, and the teams whose members may create packages
besides its admins. `zena pkg scope profile` sets how the scope presents
itself on the registry's pages.
A change to a threshold is approved under the thresholds it replaces: one
owner raises `--owner-threshold` from 1 to 2, and lowering it again needs
both.

`zena` finds the workspace it acts on by walking up from where it runs, as
npm and Cargo do: the nearest `zena-package.json` is the package, and the
nearest manifest above it whose `workspace.packages` lists it is the
workspace's root, else the package is a workspace of its own. With no
manifest above, the current directory is the workspace. Start a new
project inside another one with a `zena-package.json` of its own.

These are the `zena` command's variables. The registry's servers, the
App View and padstone, read their own, `APP_VIEW_*` and `PDS_*`, which
the configuration reference in
[`packages/registry`'s README](../registry/README.md#configuration-reference)
lists with their values in the demo, staging and production.

| Variable                           | Effect                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ZENA_CACHE_DIR`                   | The cache directory, holding fetched packages under `packages/`. Defaults to `$XDG_CACHE_HOME/zena`, or `~/.cache/zena`.         |
| `ZENA_PROJECT_CACHE`               | When set, caches go in `.zena/` in the workspace.                                                                                |
| `ZENA_PLC_DIRECTORY`               | The PLC directory DIDs are resolved with, in place of `https://plc.directory`, for mirrors and tests.                            |
| `ZENA_DNS_OVER_HTTPS`              | The DNS-over-HTTPS endpoint handles are resolved with, in place of Cloudflare's.                                                 |
| `ZENA_CONFIG_DIR`                  | Where `login` keeps the session. Defaults to `$XDG_CONFIG_HOME/zena`, or `~/.config/zena`.                                       |
| `ZENA_APP_PASSWORD`                | The app password `login` uses when `--password-stdin` is not given.                                                              |
| `ZENA_REGISTRY_TOKEN`              | An automation account's token, from `zena pkg ci create`, which `publish` calls the registry with, as CI, in place of a session. |
| `ZENA_DENY_PRIVATE_EGRESS`         | `1`: outgoing requests, the command's and those of the programs it runs, connect only to public addresses.                       |
| `ZENA_ALLOW_EGRESS`                | Host names exempt from `ZENA_DENY_PRIVATE_EGRESS`, separated by commas.                                                          |
| `ZENA_HTTP_HEADER_TIMEOUT_SECONDS` | How long a connection to a server a program runs may take to send a request's headers before it is closed. 30 by default.        |
| `ZENA_HTTP_MAX_CONNECTIONS`        | How many connections such a server keeps open at once; the next waits. 1024 by default.                                          |
| `ZENA_REGISTRY`                    | The registry the `zena pkg` commands call, in place of the Zena project's App View, `https://pkg.zena-lang.dev`.                 |

## Development and Architecture

For architectural insights, design constraints, and AI agent instructions
regarding this application, please refer to [CONTEXT.md](./CONTEXT.md).
