# The PDS (For AI Agents)

`packages/pds` is an AT Protocol PDS written in Zena, ported from pds.js:
padstone, the PDS the Zena App View (`packages/registry`) keeps its
accounts on. Read [docs/design/pds.md](../../docs/design/pds.md) before
starting work: it pins the pds.js revision being ported and sets the
order of the work. Its managed accounts are in
[docs/design/package-manager.md](../../docs/design/package-manager.md),
"Managed accounts".

The package manager's remaining work is listed in #684, the MVP section
first. When a pull request closes an item there, tick its box.

## Porting

- Each ported module's header comment names the pds.js file it comes from,
  relative to the pds.js repository root, for example
  `packages/core/src/mst.js`.
- Port behaviour, not JavaScript idiom: use Zena classes, sealed classes and
  typed records where pds.js uses plain objects and string tags.
- Port the tests that come with a module where they exercise logic that does
  not depend on JavaScript. Known-answer vectors go under
  `zena/test/fixtures/`, with their source and revision recorded beside
  them.
- When the pinned pds.js revision changes, update docs/design/pds.md.
- pds.js is MIT licensed, and its notice is in `LICENSE-pds-js`.

## Where code goes

- General atproto code, which a client or another service could use too,
  goes in `packages/atproto`: encodings, the data model, repositories,
  identity, service auth, sessions. This package holds what only a PDS
  does: storage, accounts, serving repositories, and managed accounts.
  What only the App View does goes in `packages/registry`, which depends
  on this package; nothing here imports `registry:`.
- When Zena itself is missing something, the fix goes in the compiler or
  the standard library, in the same change if it is small.
- XRPC routes go in `zena/xrpc/`, one module per `com.atproto` namespace
  (`sync.zena`, `repo.zena`, `server.zena`), and `managed.zena` for the
  methods that create managed accounts. `server.zena` puts them together
  (`pdsRoutes`); `registry:server` adds the App View's beside them.
- Method names come from `atproto:methods`, never from a string literal.
  Tests keep the literals, since they check the wire.
- `pds:pds-client` is the PDS as an App View reaches it, in
  `com.atproto`'s terms: `XrpcPds` over the network and `InProcessPds` in
  the same process, held to the same tests (`pds-client_test.zena`).

## Storage

- `pds:storage` declares the storage interfaces and keeps everything in
  memory; `pds:firestore` keeps it in Firestore, under a tenant, with blob
  bytes in Cloud Storage. Both pass `zena/test/storage-conformance.zena`;
  add a test there for anything a store must do. The App View's stores
  share the tenant, and the helpers `pds:firestore` exports.
- An account's signing key comes from `Account.signingKey()`, which
  decrypts it the first time when the store keeps it encrypted
  (`FirestoreStorage` with a `KeyEncryption`, `pds:key-encryption`).
  Never write a key in the clear where a store has key encryption.
- Several servers may share a store. Write through `AccountStore.commit`,
  which checks the head, and take a reserved key with
  `Storage.takeReservedKey`, never with a read and then a write.
- The emulator run is `npm run test:emulator -w @zena-lang/pds`. It is not
  part of `npm test`, so run it after changing `pds:firestore`.
