# A PDS written in Zena

An [AT Protocol](https://atproto.com) Personal Data Server written in Zena,
ported from [pds.js](https://tangled.org/chadtmiller.com/pds.js). It is to
be the Zena project's package host: a PDS with the `dev.zena-lang.host.*`
extension, which creates package accounts and lets their maintainers
publish to them ([docs/design/package-manager.md](../../docs/design/package-manager.md)).

It holds many accounts, with its data in memory, or in Firestore with blob
bytes in Cloud Storage or a directory. Each account's
repository takes writes, which sign a new commit, and the server answers the
reads of `com.atproto.sync` (`getRecord`, `getRepo`, `getLatestCommit`,
`getBlob`) and `com.atproto.repo` (`getRecord`, `listRecords`,
`describeRepo`). With a `PackageHost`, it also serves the package host's
`createOrganization`, `createPackage`, `uploadArtifact` and `publish`, each
checked with a service-auth token from the caller's PDS, and
`com.atproto.server.describeServer`, which tells `zena` its service DID and
handle domain. pds.js's license is
in `LICENSE-pds-js`.
[docs/design/pds.md](../../docs/design/pds.md) describes the reference
implementation, what is still missing, and the order of the work.

The atproto libraries it is built on are in [`packages/atproto`](../atproto).

## Commands

From the repository root:

```sh
npm test -w @zena-lang/pds                       # its tests, through wireit
npm run test:emulator -w @zena-lang/pds          # the storage tests against the Firestore emulator
npm run demo -w @zena-lang/pds                   # a package host to try zena against, on this machine
./target/release/zena-cli test "packages/pds/zena/test/*_test.zena"
./target/release/zena-cli run packages/pds/zena/main.zena   # serve on $PORT, default 2583
```

## The demo

`npm run demo -w @zena-lang/pds` starts a package host for `pkg.test`, a
stand-in PLC directory with a maintainer who has an app password, and a
DNS-over-HTTPS resolver that answers from the host's handle records, all
on this machine (`dev/demo.zena`). It prints the environment to give
`zena`, and the commands of a first `zena login` and `zena publish`; a
package it publishes can then be added by its handle and run from another
workspace. Nothing goes to the public PLC directory or to real DNS. It
builds the host from the environment as `main.zena` does, so it runs on
the Firestore emulator too, with `PDS_STORAGE=firestore` and the rest.

## Configuration

`main.zena` reads its configuration from the environment (`pds:service`
lists every variable). With none, it is a PDS in memory on port 2583.

A deployment keeps its data in Firestore, for a tenant, with blob bytes in
a Cloud Storage bucket, writes its handles' TXT records to the Cloud DNS
zone that holds its domain, and gives the host's PLC rotation key, a
secp256k1 private key in hex, from a secret:

```sh
PDS_STORAGE=firestore PDS_TENANT=pkg PDS_BLOB_BUCKET=<bucket> \
PDS_HOST_DOMAIN=pkg.zena-lang.dev PDS_ROTATION_KEY=<hex> \
PDS_HANDLE_RECORDS=cloud-dns PDS_DNS_ZONE=<managed zone> \
  ./target/release/zena-cli run packages/pds/zena/main.zena
```

A staging host adds `PDS_PLC=staging`: the server is then a PLC directory
itself, at `/plc`, that records the DIDs the host makes and reads every
other DID from the public directory, so nothing it makes reaches the
public one (docs/design/pds.md, "Staging").

The same configuration with the argument `sync-handles`
(`zena-cli run packages/pds/zena/main.zena -- sync-handles`) writes every
handle record again from the host's store and exits, for after a record
write failed or records were lost.

`PDS_BLOB_DIR=<dir>` keeps blob bytes in a directory instead, for a server
on one machine. `FIRESTORE_EMULATOR_HOST` points the server at the
emulator, and `GOOGLE_CLOUD_PROJECT` names the project. A configuration
the server cannot use stops it with every problem listed, and status 2.

## Layout

- `zena/`: the server, the Zena package `pds`, imported as `pds:<library>`:
  - `storage`: the storage interfaces, and `MemoryStorage`;
  - `firestore`: the storage in Firestore, and where blob bytes go beside
    it;
  - `repository`: an account's repository: writes, commits, proofs and
    exports;
  - `pds`: the accounts and their repositories;
  - `host`: the package host's methods, and what it keeps beside the
    accounts: scopes, names in them, and private membership entries;
  - `handles`: the DNS records that make the host's handles resolve, in
    memory, and a DNS-over-HTTPS resolver that answers from them;
  - `plc-directory`: the PLC directory a staging host is, which records
    the DIDs it makes and reads the rest from the public directory;
  - `server`: the HTTP routes;
  - `service`: the configuration, read from the environment, and the
    server it describes; `main` is the two together.
- `zena/test/`: its tests.
