# A PDS written in Zena

`packages/pds` is a port of an existing AT Protocol PDS (Personal Data
Server) to Zena, and the base of the Zena project's package host
([package-manager.md](package-manager.md)). This document records which
implementation it ports, what is still missing, and the order the work
lands in.

## Goals

The first target is a single-account server that does what pds.js does.
Beyond it:

- **Multiple accounts** on one server, as the reference PDS supports.
- **Organizations**: an organization groups several accounts and has
  administrators who manage them.
- **Several tenants in one deployment**: one deployment serves many
  organizations, and each one's data is kept apart from the others'.
- **Extensions as Wasm components.** A user, or a tenant's administrators,
  can install small atproto applications into the PDS. Each runs in a Wasm
  sandbox and reaches only what it is granted, so a multi-tenant server can
  let tenants install them. pds.js mounts its own features through an
  extension interface that limits each to the record collections it
  declares (`docs/architecture.md#extensions` in pds.js); the port turns
  that interface into a WIT world.
- **Hosting Zena packages.** Zena's package manager publishes each package
  as an atproto account ([package-manager.md](package-manager.md)). This
  PDS, with the `dev.zena-lang.host.*` extension, is the Zena project's
  package host: it creates package accounts on request, lets their
  maintainers publish to them through service auth, confines them to
  package records, and refuses changes to release records. Extensions are
  distributed as such packages.

The package host comes first, since the Zena package ecosystem needs it to
start.

The single-account server is built so these do not require a rewrite; see
[Accounts, organizations and tenants](#accounts-organizations-and-tenants).

## Status

The server holds many accounts, in memory (`MemoryStorage`) or in
Firestore with blob bytes in Cloud Storage (`pds:firestore`), whose
documents are keyed by tenant and account. An account's repository applies
writes and signs a commit for each batch, rebuilding the record tree from
the record index; pds.js updates the tree along the changed paths, and
porting that is still to do. Several servers can share one store: a commit
is stored only if the head it was built on is still the head, and is
otherwise built again, and the host takes a scope or package name in one
call that fails when it is taken. The server answers `/`,
`/xrpc/_health`, the `com.atproto.sync` reads `getRecord`, `getRepo`,
`getLatestCommit` and `getBlob`, and the `com.atproto.repo` reads
`getRecord`, `listRecords` and `describeRepo`. Of the package host
(milestone 6), it has account kinds that confine package, organization and
automation accounts to `dev.zena-lang.*` records, and the methods
`createOrganization`, `createPackage` (which signs and submits each new
account's `did:plc` genesis operation), `uploadArtifact` and `publish`,
each checked with a service-auth token and the caller's role. Teams, the
limits on creating accounts, sessions for automation accounts, and the other
methods are still to do. The atproto libraries it needs
are in `packages/atproto`, because the package manager needed them first:
the data model, DAG-CBOR, CIDs, CAR, the MST, commits and their proofs,
P-256 and secp256k1 signatures and `did:key`, DID and handle resolution, an
XRPC client, service-auth tokens and password sessions. Milestones 2 to 4
below are done there.

## Reference implementation

The port follows **pds.js** by Chad Miller,
<https://tangled.org/chadtmiller.com/pds.js>, MIT licensed, at commit
`1bdeef0fc968552e825ece84d0a4893cc073b0d9` (2026-10-17, version 2.5.2). It is
a single-account PDS in JavaScript with JSDoc types that runs on Node.js,
Deno and Cloudflare Workers. It federates with the live network, and the
author's own account is hosted on it.

pds.js was chosen over the other PDSes that implement atproto spaces, for
these reasons:

- **Language.** It is JavaScript with JSDoc types. Most of it maps onto Zena
  line by line.
- **Dependencies.** Its core has none. CBOR, CID, CAR, the MST, BLAKE3, LtHash
  and base32/base64url are all written in the repository, so the port can
  translate them instead of replacing a library. Zena has none of these
  yet, so they have to be written either way.
- **Storage boundary.** Core reaches storage only through the ports in
  `packages/core/src/ports.js`: `ActorStoragePort`, `SharedStoragePort`,
  `BlobPort`, and the spaces package's storage port. Its Workers build keeps
  the repository in Durable Objects with no persistent disk. Cloud Run has
  no persistent disk either, so a Firestore adapter can stand in for those
  ports.
- **Spaces.** It implements the spaces proposal at the 2026-10-01 wire
  format. `scripts/space-reference/` tests pds.js and the reference
  `@atproto/space` against each other in both directions.
- **Conformance suite.** `test/e2e.test.js` (124 cases) talks to the server
  only over HTTP and WebSocket, and picks the server through its `PLATFORM`
  variable. A `zena` platform that starts this server lets the port run
  the original suite.

Other implementations are references for the parts pds.js does not cover:

| Implementation                                                                                                                                            | Used for                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference TypeScript PDS, [bluesky-social/atproto PR #5187](https://github.com/bluesky-social/atproto/pull/5187) (`permissioned-data` branch, `619c6e85`) | The authority on the spaces wire format and OAuth behaviour. Multi-account features: account creation with invites, admin endpoints.                                         |
| [Cocoon](https://github.com/haileyok/cocoon) (Go, `9feb4e62`)                                                                                             | A multi-account PDS with spaces. Its tests name the reference test case each one ports.                                                                                      |
| [vlpds](https://github.com/jazware/vlpds) (Rust, `3d5cb8ab`)                                                                                              | `testdata/spaces-alpha/`: LtHash, commit, HTTP-signature and token vectors generated by the reference. Its key layout over object storage is a model for a Firestore schema. |
| [arroba](https://github.com/snarfed/arroba) (Python)                                                                                                      | A PDS repository stored in Google Cloud Datastore, a document database like Firestore.                                                                                       |

pds.js serves one account. Multi-account features come from the reference
PDS after the single-account server works.

### Parts of pds.js left out

pds.js carries applications beyond the PDS. These packages are not ported:
`git`, `git-ci`, `git-host`, `git-ui`, `drive`, `sites`, `npm`, `oci`,
`appview`, `readonly`, `start` (the Cloudflare deploy wizard), `deno`,
`blobs-deno` and `cloudflare`. Passkeys (`passkey.js`, `webauthn.js`) wait
until after OAuth.

## Accounts, organizations and tenants

pds.js builds its server object around one account. `PersonalDataServer`
(`packages/core/src/pds.js`) is constructed with one `actorStorage`. It
reads the account's DID and signing key from that storage once and hands
the same storage to every handler. The firehose numbers its events in that
account's storage.

The port changes this structure as it translates, so that one account is a
special case:

- Each request resolves the tenant and the account it is for. Handlers get
  the account's storage and keys from that resolution, never from the
  server object.
- Storage keys start with the tenant, then the account's DID. The ports keep
  pds.js's split between per-account storage (records, blocks, commits,
  blobs) and shared storage (handles, sessions, OAuth state). Shared storage
  is per tenant.
- The firehose sequence spans all the accounts of a tenant. pds.js numbers
  events per account.
- What pds.js reads from the environment for its one account (DID, signing
  key, handle, password) becomes per-account data in storage. Deployment
  configuration holds only what every tenant shares.

A single-account deployment is then one tenant with one account.

The reference PDS serves many accounts under one host name and one service
DID. It has no organizations, and its administration endpoints
(`com.atproto.admin.*`) serve the operator of the whole server. Organizations
and tenants are therefore designed here. Open questions:

- Whether each tenant is its own PDS to the network, with its own host name,
  service DID and firehose, or tenants share one. The answer decides how a
  request's tenant is found: from its host name, or from the account.
- What an organization's administrators can do to member accounts: create
  and deactivate them, reset passwords, move them to another PDS.
- Whether an account can belong to more than one organization.
- Whether an organization can be a space authority, so that its members
  share spaces it controls.

## What Zena is missing

The standard library and `packages/atproto` have what the first endpoints
need: an HTTP server with streaming bodies, async functions and streams,
JSON, SHA-256, HMAC and HKDF, ECDSA on both curves, base encodings, random
bytes, Firestore and Cloud Storage clients (`google-cloud:firestore`,
`google-cloud:storage`) and the atproto libraries listed in
[Status](#status). What is left:

| Need                                                    | Status in Zena                                                                     | Plan                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| PBKDF2 for passwords                                    | None                                                                               | Over HMAC-SHA256, in `zena:crypto`                                                                                              |
| BLAKE3                                                  | None                                                                               | Port pds.js `packages/spaces/src/blake3.js`, for spaces                                                                         |
| WebSocket server, for `com.atproto.sync.subscribeRepos` | None. The `zena-cli` host serves HTTP/1.1 and HTTP/2 through hyper with no upgrade | Add an upgrade API to the host                                                                                                  |
| Writing a package host's handle records                 | None                                                                               | A Cloud DNS client in `google-cloud`, which the host writes `_atproto` TXT records with (package-manager.md, "Serving handles") |
| Wall-clock dates                                        | `wasi:clocks/system-clock` directly, and no ISO-8601 formatting                    | Add both to `zena:time`                                                                                                         |

## Milestones

Each milestone ends with tests that pass, so the port is checked as it
grows. Milestones 1 to 4 are done.

1. **Skeleton.** The server answers `/` and `/xrpc/_health`.
2. **Data model**, in `packages/atproto`: base encodings, varints,
   CID, DAG-CBOR, and the syntax of DIDs, handles, NSIDs and AT-URIs.
   Tested with the syntax and data-model vectors in
   [atproto-interop-tests](https://github.com/bluesky-social/atproto-interop-tests).
3. **Cryptography**, in `packages/atproto`: HMAC-SHA256, P-256 and
   secp256k1 ECDSA, `did:key`, and JWT signing and verification. pds.js
   signs with P-256 by default. secp256k1 is needed for accounts that
   bring a secp256k1 signing key and for verifying service-auth tokens
   signed with one. Tested with the interop crypto vectors.
4. **Repository**, in `packages/atproto`: MST, commits and CAR. Tested with
   the interop MST and commit-proof vectors.
5. **Storage ports and the first endpoints.** An in-memory adapter for the
   storage ports, accounts kept in storage, writing records into an
   account's repository, `com.atproto.sync.*` except `subscribeRepos`,
   blobs, `com.atproto.server.*` sessions and identity. Handlers get their
   account from the request from the start.
6. **The package host.** Package and organization accounts created on
   request, each with a `did:plc` whose genesis operation the host signs;
   the `dev.zena-lang.host.*` methods, checked with service auth
   (`atproto:service-auth`); package accounts confined to `dev.zena-lang.*`
   records; and the limits on accounts and storage. The `zena` command's
   publishing tests run against it, in memory.
7. **Deployment.** A Firestore adapter for the storage ports, GCS for blobs,
   and a Cloud Run image running under `zena-cli`, with the host's handle
   records in its DNS zone.
   Firestore documents are keyed by tenant and account from the start. The
   adapters are done, tested against the Firestore emulator with a suite
   every storage passes (`zena/test/storage-conformance.zena`), and so is
   the server's configuration (`pds:service`), read from the environment.
   The host writes a TXT record for each handle it gives out, to a Cloud
   DNS zone or in memory (`pds:handles`), and `npm run demo` runs it on
   this machine. The image and the zone itself are not done.
8. **Conformance.** The pds.js e2e suite, run against this server, with
   `com.atproto.repo.*` and AppView proxying for ordinary accounts.
9. **Firehose.** `subscribeRepos`, after the Zena host can upgrade a request
   to a WebSocket, so that relays and the package index can follow the
   host. Events are numbered per tenant.
10. **OAuth.** The authorization server (PAR, DPoP, PKCE, scopes) and the
    account pages, from `oauth.js`, `scope.js` and `handlers/oauth.js`.
11. **Multiple ordinary accounts.** Account creation with invite codes,
    deletion and deactivation, and the operator's administration endpoints,
    from the reference PDS (`packages/pds/src/account-manager`,
    `packages/pds/src/api/com/atproto/admin`) and Cocoon.
12. **Organizations and tenants**, once the open questions in
    [Accounts, organizations and tenants](#accounts-organizations-and-tenants)
    are settled.
13. **Spaces.** LtHash, space commits, delegation tokens, space credentials,
    HTTP message signatures, simplespace and write notifications, from
    `packages/spaces`. Tested with the vlpds vectors and the pds.js spaces
    suites.

Spaces come last for two reasons. Every spaces write endpoint requires
OAuth. And the wire format will change before the general release, which
Bluesky expects "some time in November" 2026
([post-alpha plans](https://discourse.atmosphere.community/t/1278),
2026-10-08). The changes named there: repository export moves from CAR to
STAR files, and commits may move to Diffie-Hellman key agreement, which
would add a key to every DID document. When the port reaches spaces,
compare pds.js against the reference branch of the day and port from
whichever is newer.

## Tests

- **Unit tests** are `packages/pds/zena/test/*_test.zena`, and use the
  interop vectors and vlpds vectors as known answers.
- **Storage**: `zena/test/storage-conformance.zena` holds the tests every
  `Storage` and `HostStore` passes. `npm test` runs them in memory, and
  `npm run test:emulator -w @zena-lang/pds` against the Firestore
  emulator, which the root `emulators:start` service runs. There is no
  emulator for Cloud Storage's gRPC API, so that run keeps blob bytes in
  memory.
- **Conformance**: the pds.js e2e suite, run from a pinned pds.js checkout
  with a `zena` platform helper that starts `packages/pds/zena/main.zena`.
