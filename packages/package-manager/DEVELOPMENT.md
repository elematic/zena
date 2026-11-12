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
- `org/`: an organization's members and team records, and the private entries their commitments stand for.
- `registry/`: the App View's XRPC methods ([docs/design/package-manager.md](../../docs/design/package-manager.md), "The App View's methods").
- `authPublish.json`: the OAuth permission set `zena pkg login` asks for: writing attestations and calling the App View's methods.

`test/lexicons_test.zena` checks that each file is named by its NSID, that its references resolve, and that the permission set covers every App View method.

## Running Tests

From the repository root:

```sh
npm test -w @zena-lang/package-manager
```

Or run a test file directly with `zena-cli`:

```sh
./target/release/zena-cli test packages/package-manager/test/manifest_test.zena
```
