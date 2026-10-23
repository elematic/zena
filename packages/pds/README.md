# A PDS written in Zena

An [AT Protocol](https://atproto.com) Personal Data Server written in Zena,
ported from [pds.js](https://tangled.org/chadtmiller.com/pds.js). It is to
be the Zena project's package host: a PDS with the `dev.zena-lang.host.*`
extension, which creates package accounts and lets their maintainers
publish to them ([docs/design/package-manager.md](../../docs/design/package-manager.md)).

The server answers `/` and `/xrpc/_health` so far.
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

- `zena/`: the server, the Zena package `pds`, imported as `pds:<library>`.
- `zena/test/`: its tests.
