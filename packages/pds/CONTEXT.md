# The PDS (For AI Agents)

`packages/pds` is an AT Protocol PDS written in Zena, ported from pds.js,
and the base of the Zena package host. Read
[docs/design/pds.md](../../docs/design/pds.md) before starting work: it
pins the pds.js revision being ported and sets the order of the work. The
package host's protocol is in
[docs/design/package-manager.md](../../docs/design/package-manager.md),
"Hosting, keys and maintainers" and "Abuse and moderation", and its
lexicons are in `packages/package-manager/lexicons`.

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
  does: storage, accounts, serving repositories, and the host extension.
- When Zena itself is missing something, the fix goes in the compiler or
  the standard library, in the same change if it is small.
- XRPC routes go in `zena/xrpc/`, one module per `com.atproto` namespace
  (`sync.zena`, `repo.zena`, `server.zena`) and, under `xrpc/host/`, one
  per area of the package host's methods, which `xrpc/host/routes.zena`
  adds. `server.zena` only puts them, and the pages in `zena/web/`,
  together. A host method's route is added with `hostQuery` or
  `hostProcedure`, which check the caller's token for the same method.
- Method names come from `atproto:methods` and
  `package-manager:host-methods`, never from a string literal, here and
  in `zena`. A new host method needs its lexicon and its constant; the
  lexicon test fails without either. Tests keep the literals, since they
  check the wire.

## Storage

- `pds:storage` declares the storage interfaces and keeps everything in
  memory; `pds:firestore` keeps it in Firestore, under a tenant, with blob
  bytes in Cloud Storage. Both pass `zena/test/storage-conformance.zena`;
  add a test there for anything a store must do.
- An account's signing key comes from `Account.signingKey()`, which
  decrypts it the first time when the store keeps it encrypted
  (`FirestoreStorage` with a `KeyEncryption`, `pds:key-encryption`).
  Never write a key in the clear where a store has key encryption.
- The package listings read `HostStore.summaries`, which the host writes
  from `Pds.onCommit` after each commit to a package's repository. A
  method that lists every package must not read every repository.
- Several servers may share a store. Write through `AccountStore.commit`,
  which checks the head, and take names with `HostStore.claimScope` and
  `claimName`, never with a read and then a write.
- The emulator run is `npm run test:emulator -w @zena-lang/pds`. It is not
  part of `npm test`, so run it after changing `pds:firestore`.
