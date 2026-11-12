# The App View (For AI Agents)

`packages/registry` is the Zena App View: the package manager's service,
its `dev.zena-lang.registry.*` methods, its site, and the service that
runs it, with its PDS (`packages/pds`) in the same process or reaching one
elsewhere. Its protocol is in
[docs/design/package-manager.md](../../docs/design/package-manager.md),
"Hosting, keys and maintainers" and "Abuse and moderation", and its
lexicons are in `packages/package-manager/lexicons`.

The App View's remaining work is listed in #684, the MVP section first.
When a pull request closes an item there, tick its box.

## Where code goes

- This package holds what only the App View does. What a PDS does goes in
  `packages/pds`, which this package imports (`pds:`) and which never
  imports it; general atproto code goes in `packages/atproto`.
- XRPC routes go in `src/xrpc/`, one module per area of the App View's
  methods, which `xrpc/routes.zena` adds. `server.zena` puts them, the
  PDS's routes and the pages in `src/web/` together. A method's route is
  added with `registryQuery` or `registryProcedure`, which check the
  caller's token for the same method.
- Method names come from `atproto/methods` and
  `package-manager/registry-methods`, never from a string literal, here and
  in `zena`. A new method needs its lexicon and its constant; the lexicon
  test fails without either. Tests keep the literals, since they check the
  wire.
- The pages in `src/web/` are the site's (`pkg.zena-lang.dev`), served
  with the App View's methods; the PDS is padstone
  (`padstone.zena-lang.dev`), a service of its own. A page reaches the App View only with calls it could
  make over the network: an App View method, or a public atproto read.
  Changes go through registry methods with the person's token, never on
  the strength of the site's cookie (package-manager.md, "Names and
  addresses" and "Finding an App View"). `packages/pds-web/CONTEXT.md`
  has the rules of the pages.
- The App View reaches its accounts' repositories only through `PdsClient`
  (`pds/pds-client`), in `com.atproto`'s terms, and keeps its own record
  of its accounts, their kinds, scopes and names, in `AppViewStore`. It does
  not read `Pds` or `Storage`; `InProcessPds` is the PDS in the same
  process, and `XrpcPds` one elsewhere (`APP_VIEW_PDS_URL`). Automation accounts are managed accounts too: CI calls with a
  token the App View issued (`AppView.authenticate`), and the App View
  writes their attestations.

## Storage

- `registry/app-view` declares `AppViewStore` and keeps it in memory;
  `registry/firestore` keeps it in Firestore, under the PDS's tenant, or
  under its own (`APP_VIEW_TENANT`) when the PDS is elsewhere. Both
  pass `test/store-conformance.zena`; add a test there for anything a
  store must do.
- The package listings read `AppViewStore.summaries`, and memberships and
  public roles start from `AppViewStore.mentionsOf`, which the App View
  writes after each commit it makes (`AppView.#index`). A method a page
  calls must not read every account or repository. These indexes are
  where the App View's index starts, with only the accounts it holds
  (package-manager.md, "The index").
- Several servers may share a store. Take names with
  `AppViewStore.claimScope` and `claimName`, never with a read and then a
  write.
- What the App View derives from a release's archive for its pages (the
  files, the rendered README) is `registry/release-contents`, kept as one
  object per release in `AppView.derived`: a bucket, or memory. Pages read
  `AppView.releaseContents`, never the archive; a file's own route reads
  only that file's span of it (`releaseFile`, `PdsClient.getBlobRange`).
  A change to what is derived bumps
  `CONTENTS_FORMAT`, so that kept contents are derived again
  (package-manager.md, "What the App View derives from releases").
- The emulator run is `npm run test:emulator -w @zena-lang/registry`. It
  is not part of `npm test`, so run it after changing `registry/firestore`
  or `registry/service`.
