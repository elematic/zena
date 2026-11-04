# The PDS (For AI Agents)

`packages/pds` is an AT Protocol PDS written in Zena, ported from pds.js,
and the base of the Zena App View. Read
[docs/design/pds.md](../../docs/design/pds.md) before starting work: it
pins the pds.js revision being ported and sets the order of the work. The
App View's protocol is in
[docs/design/package-manager.md](../../docs/design/package-manager.md),
"Hosting, keys and maintainers" and "Abuse and moderation", and its
lexicons are in `packages/package-manager/lexicons`.

The App View's remaining work is listed in #684, the MVP section
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
  does: storage, accounts, serving repositories, and the App View extension.
- When Zena itself is missing something, the fix goes in the compiler or
  the standard library, in the same change if it is small.
- XRPC routes go in `zena/xrpc/`, one module per `com.atproto` namespace
  (`sync.zena`, `repo.zena`, `server.zena`) and, under `xrpc/registry/`, one
  per area of the App View's methods, which `xrpc/registry/routes.zena`
  adds. `server.zena` only puts them, and the pages in `zena/web/`,
  together. An App View method's route is added with `registryQuery` or
  `registryProcedure`, which check the caller's token for the same method.
- Method names come from `atproto:methods` and
  `package-manager:registry-methods`, never from a string literal, here and
  in `zena`. A new App View method needs its lexicon and its constant; the
  lexicon test fails without either. Tests keep the literals, since they
  check the wire.
- The pages in `zena/web/` are the site's (`pkg.zena-lang.dev`), and the
  XRPC routes the PDS's (`padstone.zena-lang.dev`); they run in one
  service for now. A page reaches the App View only with calls it could make
  over the network: an App View method, or a public atproto read. Changes go
  through registry methods with the person's token, never on the strength of
  the site's cookie (package-manager.md, "Names and addresses" and
  "Finding an App View").
- The App View reaches its accounts' repositories only through `PdsClient`
  (`pds:pds-client`), in `com.atproto`'s terms, and keeps its own record
  of its accounts, their kinds, scopes and names, in `AppViewStore`. It does
  not read `Pds` or `Storage`; `InProcessPds` is the PDS in the same
  process. Creating automation accounts is the one exception, until #853.

## Storage

- `pds:storage` declares the storage interfaces and keeps everything in
  memory; `pds:firestore` keeps it in Firestore, under a tenant, with blob
  bytes in Cloud Storage. Both pass `zena/test/storage-conformance.zena`;
  add a test there for anything a store must do.
- An account's signing key comes from `Account.signingKey()`, which
  decrypts it the first time when the store keeps it encrypted
  (`FirestoreStorage` with a `KeyEncryption`, `pds:key-encryption`).
  Never write a key in the clear where a store has key encryption.
- The package listings read `AppViewStore.summaries`, and memberships and
  public roles start from `AppViewStore.mentionsOf`, which the App View writes
  after each commit it makes (`AppView.#index`). A method a page
  calls must not read every account or repository. These indexes are
  where the App View's index starts, with only the accounts it holds
  (package-manager.md, "The index").
- Several servers may share a store. Write through `AccountStore.commit`,
  which checks the head, and take names with `AppViewStore.claimScope` and
  `claimName`, never with a read and then a write.
- The emulator run is `npm run test:emulator -w @zena-lang/pds`. It is not
  part of `npm test`, so run it after changing `pds:firestore`.
