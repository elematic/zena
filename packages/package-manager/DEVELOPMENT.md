# Development

## Layout

```
zena-package.json      Package manifest
src/                   Zena library sources
  testing/             In-process fake PDS and PLC directory for tests
test/                  Unit tests (*_test.zena)
lexicons/              AT Protocol lexicons (dev.zena-lang.*)
```

## Lexicons

`lexicons/dev/zena-lang/` holds the lexicons for `zena-lang.dev`:

- `package/`: a package's records: profile, releases, retractions, the maintainers record, and attestations, which maintainers write to their own repositories. `package-manager/records` reads and checks the first three, and their lexicons state only constraints it checks.
- `scope/`: a scope's maintainers record of its owners and publishers, its policy for its packages, its profile, and the organization it belongs to.
- `org/`: an organization's members and team records, and the private entries their commitments stand for.
- `registry/`: the App View's XRPC methods ([docs/design/package-manager.md](../../docs/design/package-manager.md), "The App View's methods").
- `authPublish.json`: the OAuth permission set for writing attestations and calling the App View's methods, which is to replace the scope `zena pkg login` asks for (`package-manager/cli-client`) once the lexicon is published where PDSes resolve it.

`test/lexicons_test.zena` checks that each file is named by its NSID, that its references resolve, and that the permission set covers every App View method.

A new or renamed record or method changes the registry's operations document, which lists the record names and says which records each account holds; `packages/registry/CONTEXT.md`, "The operations document", says how to change it.

## Running Tests

From the repository root:

```sh
npm test -w @zena-lang/package-manager
```

Or run a test file directly with `zena`:

```sh
./target/release/zena test packages/package-manager/test/manifest_test.zena
```
