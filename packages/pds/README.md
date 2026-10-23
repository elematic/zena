# A PDS written in Zena

An [AT Protocol](https://atproto.com) Personal Data Server written in Zena,
ported from [pds.js](https://tangled.org/chadtmiller.com/pds.js). It is to
be the Zena project's package host: a PDS with the `dev.zena-lang.host.*`
extension, which creates package accounts and lets their maintainers
publish to them ([docs/design/package-manager.md](../../docs/design/package-manager.md)).

It holds many accounts, with its data in memory so far. Each account's
repository takes writes, which sign a new commit, and the server answers the
reads of `com.atproto.sync` (`getRecord`, `getRepo`, `getLatestCommit`,
`getBlob`) and `com.atproto.repo` (`getRecord`, `listRecords`,
`describeRepo`). pds.js's license is in `LICENSE-pds-js`.
[docs/design/pds.md](../../docs/design/pds.md) describes the reference
implementation, what is still missing, and the order of the work.

The atproto libraries it is built on are in [`packages/atproto`](../atproto).

## Commands

From the repository root:

```sh
npm test -w @zena-lang/pds                       # its tests, through wireit
./target/release/zena-cli test packages/pds/zena/test
./target/release/zena-cli run packages/pds/zena/main.zena   # serve on $PORT, default 2583
```

## Layout

- `zena/`: the server, the Zena package `pds`, imported as `pds:<library>`:
  - `storage`: the storage interfaces, and `MemoryStorage`;
  - `repository`: an account's repository: writes, commits, proofs and
    exports;
  - `pds`: the accounts and their repositories;
  - `server`: the HTTP routes.
- `zena/test/`: its tests.
