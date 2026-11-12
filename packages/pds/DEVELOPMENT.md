# Development

`packages/pds` is padstone, the PDS the Zena project's App View ([`packages/registry`](../registry)) keeps its accounts on ([docs/design/package-manager.md](../../docs/design/package-manager.md), "Managed accounts"). [docs/design/pds.md](../../docs/design/pds.md) describes the reference implementation (`pds.js`, whose license is in `LICENSE-pds-js`), what is still missing, and the order of the work. The atproto libraries it is built on are in [`packages/atproto`](../atproto).

## Layout

```
zena-package.json      Package manifest
src/                   Zena library sources and server entry point (main.zena)
  xrpc/                com.atproto.* XRPC route handlers
test/                  Unit and conformance tests (*_test.zena)
  emulator/            Firestore emulator conformance tests
```

## Commands

From the repository root:

```sh
npm test -w @zena-lang/pds                       # its tests, through wireit
npm run test:emulator -w @zena-lang/pds          # the storage tests against the Firestore emulator
./target/release/zena-cli test "packages/pds/test/*_test.zena"
./target/release/zena-cli run packages/pds/src/main.zena   # padstone alone, on $PORT, default 2583
```
