# A PDS written in Zena

An [AT Protocol](https://atproto.com) Personal Data Server written in Zena,
ported from [pds.js](https://tangled.org/chadtmiller.com/pds.js). It is
padstone, the PDS the Zena project's App View keeps its accounts on
([docs/design/package-manager.md](../../docs/design/package-manager.md),
"Managed accounts"). The App View, its site, and the service that runs
the two in one process are in [`packages/registry`](../registry).

It holds many accounts, with its data in memory, or in Firestore with blob
bytes in Cloud Storage or a directory. Each account's
repository takes writes, which sign a new commit, and the server answers the
reads of `com.atproto.sync` (`getRecord`, `getRepo`, `getLatestCommit`,
`getBlob`) and `com.atproto.repo` (`getRecord`, `listRecords`,
`describeRepo`). An account with an app password signs in with
`com.atproto.server.createSession`, and with its session refreshes it,
gets service-auth tokens (`getServiceAuth`), and writes its own repository
(`putRecord`, `deleteRecord`).

It creates managed accounts for the App Views its operator trusts
(`pds:managed`): `com.atproto.server.reserveSigningKey` makes the signing
key of an account an App View is about to create, and
`com.atproto.server.createAccount` creates it once the App View has minted
its DID. A managed account has no password; it takes writes only with a
service-auth token from its App View, and holds only the records and
artifacts of Zena packages (`ManagedLimits`). An App View reaches the PDS
through `pds:pds-client`: `XrpcPds` over the network, or `InProcessPds` in
the same process.

pds.js's license is in `LICENSE-pds-js`.
[docs/design/pds.md](../../docs/design/pds.md) describes the reference
implementation, what is still missing, and the order of the work.

The atproto libraries it is built on are in [`packages/atproto`](../atproto).

## Commands

From the repository root:

```sh
npm test -w @zena-lang/pds                       # its tests, through wireit
npm run test:emulator -w @zena-lang/pds          # the storage tests against the Firestore emulator
./target/release/zena-cli test "packages/pds/zena/test/*_test.zena"
```

The service that serves it, alone or with the App View, is
`packages/registry/zena/main.zena`; see its [README](../registry/README.md).

## Layout

- `zena/`: the Zena package `pds`, imported as `pds:<library>`:
  - `storage`: the storage interfaces, and `MemoryStorage`;
  - `firestore`: the storage in Firestore, and where blob bytes go beside
    it;
  - `key-encryption`: accounts' signing keys encrypted with a Cloud KMS
    key, for Firestore to keep;
  - `repository`: an account's repository: writes, commits, proofs and
    exports;
  - `pds`: the accounts and their repositories;
  - `managed`: managed accounts, and the checks on their App Views'
    tokens;
  - `sessions`: password sessions, for the accounts that sign in with an
    app password;
  - `signer`: the keys an App View signs with, held here or in Cloud KMS,
    which `XrpcPds` signs its tokens with;
  - `pds-client`: the PDS as an App View reaches it;
  - `server`: the HTTP application, whose routes are in `xrpc/`.
- `zena/test/`: its tests.
