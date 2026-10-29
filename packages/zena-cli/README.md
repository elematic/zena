# Zena CLI (`zena-cli`)

The `zena` command: build, run and test Zena programs, build targets,
format and lint them, extract API docs, benchmark, serve a language server,
and add and fetch published packages.

The command is a Zena program. `zena/main.zena` and the files beside it
are the **CLI module**, compiled to `out/zena.wasm` with the compiler,
zb, zenadoc and the formatter linked in. `zena-cli` is the Rust binary
that runs it on wasmtime. See
[docs/design/cli-module.md](../../docs/design/cli-module.md).

The host-side pieces (engine configuration, the `.cwasm` cache, the
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
zena-cli build ./packages/zb:test      # a wireit target, run with zb
zena-cli --help
zena-cli <command> --help
```

Global flags go before the command: `-g` / `--debug` names functions in
compiled modules and turns off inlining, so traps name them; `-O <0|1|2|s>`
sets the optimization level (default `1`); `-v` / `--verbose` prints more
of what the command does.

## Commands

| Command                                                          | What it does                                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build <file.zena> -o <out.wasm\|.wat>`                          | Compiles a file. `--target` (`zena-cli`, `component`, `js`, `freestanding`), `--wit` and `--world` for components, `--extension-wit` to check the world against an extension's WIT, `--time`. |
| `build [target]`                                                 | Runs a wireit build target with zb, such as `build test` or `build ./packages/zb:test`.                                                                                                       |
| `run <file.zena\|file.wasm> [-- args...]`                        | Compiles through the compile cache and runs. `--dir HOST[::GUEST]`, `--allow-spawn`, `--allow-extensions`, `--invoke <fn>`, `--no-cache`, `--time`.                                           |
| `test [paths or globs...]`                                       | Runs `*_test.zena` files in parallel. `-f` / `--filter`, `--exclude <glob>`.                                                                                                                  |
| `fmt [--write \| --check] <files...>`                            | Formats Zena files, printing the result, rewriting the files, or failing if any is not formatted.                                                                                             |
| `lint [--fix] <paths...>`                                        | Reports what the lint rules find, or with `--fix` applies the fixes the type checker accepts. `--only`, `--skip`, `--list-rules`.                                                             |
| `add <package>[@<version>] [--name <local>]`                     | Adds a published package to the current package's dependencies, pins versions in `zena-lock.json`, and fetches them.                                                                          |
| `update [<name>...]`                                             | Raises the current package's dependencies, or the named ones, to the latest version of their major version that is not retracted.                                                             |
| `fetch`                                                          | Fetches the packages `zena-lock.json` pins into the package cache.                                                                                                                            |
| `login <handle or DID> [--password-stdin]`                       | Signs in to your atproto account with an app password, to publish.                                                                                                                            |
| `logout`                                                         | Ends the session `login` started.                                                                                                                                                             |
| `publish [--scope <name> --yes] [--host <url>]`                  | Publishes the package you are in at its manifest's `version`, creating it on the host first, in the scope `--scope` names, when it has no `did`.                                              |
| `approve [<package>@]<version> \| @<scope> \| <package> [--yes]` | Shows a release, or changes to who belongs, waiting for approval, and with `--yes` approves them.                                                                                             |
| `package create --scope <name> --yes [--host <url>]`             | Creates the package you are in on the host, and writes its DID into `zena-package.json`, without publishing.                                                                                  |
| `doc <path> [-o <out.json>]`                                     | Extracts a package's public API as JSON.                                                                                                                                                      |
| `bench <suite.json> [-o <out.json>]`                             | Runs a benchmark suite.                                                                                                                                                                       |
| `lsp`                                                            | Runs the language server over stdin and stdout.                                                                                                                                               |
| `precompile <file.wasm>`                                         | Compiles a module to machine code (`.cwasm`) ahead of its first run.                                                                                                                          |

## Packages

A workspace is a directory with a `zena-package.json`, and the packages it
lists under `workspace.packages`, with one `zena-lock.json` beside the
root's manifest. See
[docs/design/package-manifest.md](../../docs/design/package-manifest.md)
for the files and
[docs/design/package-manager.md](../../docs/design/package-manager.md) for
how packages are published on atproto.

`zena add` takes a package by DID, by handle, or as `@scope/name`, which
means `name.scope.pkg.zena-lang.dev` unless the root manifest's `scopes`
maps the scope to another domain. Without a version it takes the latest
that is not retracted, and without `--name` the name the package's profile
suggests:

```bash
zena-cli add @acme/router@1.4.2
zena-cli add router.acme.com --name routing
zena-cli update            # every dependency of the current package
zena-cli update router     # only router
zena-cli fetch             # what zena-lock.json pins, e.g. in CI
```

`add` and `update` change the manifest of the package the command is run
in: the workspace package whose directory holds the current directory, or
else the root, whose manifest `add` creates if there is none. They then
select versions for the whole workspace, so every package uses one
version of each package and major version, write `zena-lock.json`, and
fetch what it pins. `fetch` checks each release against the CIDs the
lockfile pins and the signed proofs its package's PDS serves.

Publishing acts as you, through your own atproto account: the one you
use for Bluesky or any other app. `zena login` signs in with an app
password, which your PDS issues and can revoke on its own (on bsky.social:
Settings, Privacy and security, App passwords). It reads the password from
`--password-stdin`, then `ZENA_APP_PASSWORD`, then the terminal without
showing it, and keeps the session in `session.json` in the configuration
directory, readable only by you. `zena logout` ends the session.

```bash
zena-cli login alice.bsky.social
echo "$APP_PASSWORD" | zena-cli login alice.bsky.social --password-stdin
```

Packages on a package host are in scopes: `router.acme.<host domain>` is
the package `router` in the scope `acme`. `zena scope create acme --yes`
creates a scope, with you as its only owner, and `zena scope info acme`
describes one. Publishing never creates a scope.

`zena publish` publishes the package you are in, at the `version` its
`zena-package.json` gives, which needs a `description` and an SPDX
`license`, such as `"MIT"`. The first time, the package has no `did`, and
`zena publish --yes` creates it on the package host in the scope its
manifest's `"scope"` names, else its workspace root's, else `--scope`.
It writes the DID into the manifest, with the scope when only `--scope`
gave it. Later publishes check that the package's handle is still in that
scope.

The host holds the package's keys, as a PDS holds its users'. If you keep
a recovery key, a secp256k1 private key in hex in `recovery-key` in the
configuration directory, it is ranked above the host's, so you can move
the package without the host. None is made for you. Each publish uploads
the package's source archive, which the host checks, writes your
attestation of the release to your own repository, and asks the host to
complete it. The host writes the release once the attestations meet the
package's maintainers record, its `threshold` of maintainers, of whom
`humans` are people; with one maintainer, that is your own. Until then
the release waits, for seven days, and the other maintainers approve it
with `zena approve <package>@<version>`, which shows the release first and
approves it with `--yes`. Raise `version` to publish again.

```bash
zena-cli scope create acme --yes       # once per scope
zena-cli publish --scope acme --yes    # the first time, or with "scope": "acme"
zena-cli publish                       # after raising "version"
zena-cli retract 1.4.1 --reason "Routes with a trailing slash matched the wrong handler"
```

To publish from CI, a scope's admin creates an automation account, and a
package's owner adds it as a publisher. CI keeps its app password as the
secret `ZENA_APP_PASSWORD`, and runs `zena login <handle>` and
`zena publish`:

```bash
zena-cli ci create acme/ci                          # prints the app password, once
zena-cli owner add ci.acme.pkg.zena-lang.dev --automation
```

The host holds an automation account's keys, so its attestation counts
only together with a person's: a release CI publishes waits until a
maintainer approves it.

```bash
zena-cli approve @acme/router@1.5.0         # shows the release, and who has approved it
zena-cli approve @acme/router@1.5.0 --yes   # approves it
```

`zena retract <version>` marks a release as retracted. Builds whose
lockfiles pin it keep using it, and `zena add` and `zena update` skip it.
Any maintainer may retract a release.

A scope's owners change who belongs to it, and a package's owners who
maintains it. Each change asks the host for the new record, attests it in
your own repository, and asks the host to write it. The host writes it
once the record before it allows it: with thresholds of 1, at once, and
otherwise once enough of its owners, admins or team maintainers have
approved it with `zena approve @<scope>` or `zena approve <package>`. Who
belongs stays private: records list commitments, and the host shows the
entries behind them only to those who may see them.

```bash
zena-cli scope add acme bob.example.com --role admin   # member, admin or owner
zena-cli scope remove acme bob.example.com
zena-cli scope members acme
zena-cli team create acme/core
zena-cli team add acme/core bob.example.com --role maintainer   # member or maintainer
zena-cli owner add --team acme/core      # in a package: the team publishes it
zena-cli owner add carol.example.com --role owner   # publisher or owner
zena-cli owner list

zena-cli owner settings --threshold 2 --humans 1   # releases need 2 approvals, 1 of them a person's
zena-cli owner settings --owner-threshold 2        # changes to the maintainers need 2 owners
zena-cli scope settings acme --owner-threshold 2 --admin-threshold 2
zena-cli team settings acme/core --threshold 2
```

The `settings` commands change thresholds, and with no flags print them.
A change to a threshold is approved under the thresholds it replaces: one
owner raises `--owner-threshold` from 1 to 2, and lowering it again needs
both.

The workspace's root is the repository root, `ZENA_REPO_ROOT`, which
defaults to the checkout the binary was built in, or the current directory
for a standalone binary.

| Variable              | Effect                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ZENA_CACHE_DIR`      | The cache directory, holding fetched packages under `packages/`. Defaults to `$XDG_CACHE_HOME/zena`, or `~/.cache/zena`. |
| `ZENA_PROJECT_CACHE`  | When set, caches go in `.zena/` in the workspace.                                                                        |
| `ZENA_PLC_DIRECTORY`  | The PLC directory DIDs are resolved with, in place of `https://plc.directory`, for mirrors and tests.                    |
| `ZENA_DNS_OVER_HTTPS` | The DNS-over-HTTPS endpoint handles are resolved with, in place of Cloudflare's.                                         |
| `ZENA_CONFIG_DIR`     | Where `login` keeps the session. Defaults to `$XDG_CONFIG_HOME/zena`, or `~/.config/zena`.                               |
| `ZENA_APP_PASSWORD`   | The app password `login` uses when `--password-stdin` is not given.                                                      |
| `ZENA_PACKAGE_HOST`   | The package host `publish` and `package create` use, in place of `https://pkg.zena-lang.dev`.                            |

## Development and Architecture

For architectural insights, design constraints, and AI agent instructions
regarding this application, please refer to [CONTEXT.md](./CONTEXT.md).
