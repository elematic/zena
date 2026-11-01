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
`describeRepo`). An account with an app password signs in with
`com.atproto.server.createSession`, and with its session refreshes it,
gets service-auth tokens (`getServiceAuth`), and writes its own repository
(`putRecord`, `deleteRecord`); the accounts the package host creates have
no other password. With a `PackageHost`, it also serves the package host's
methods, each checked with a service-auth token from the caller's PDS, and
`com.atproto.server.describeServer`, which tells `zena` its service DID and
handle domain. `zena` refuses a host whose DID does not name its origin, so
`PDS_SERVICE_DID` defaults to `did:web:<domain>`, and the demo's to the
`did:web` of `127.0.0.1` and its port. pds.js's license is
in `LICENSE-pds-js`.
[docs/design/pds.md](../../docs/design/pds.md) describes the reference
implementation, what is still missing, and the order of the work.

With a package host, it serves web pages at its origin, rendered on the
server (`zena/web/`), beside its XRPC routes (`zena/xrpc/`): a visitor
browses the host's scopes and packages there, and a person signs in with
atproto OAuth to see their own. For
that, the host serves the pages' OAuth client metadata at
`/oauth/client-metadata.json`, resolves handles
(`com.atproto.identity.resolveHandle`), and trades a service-auth token
for a web session cookie (`dev.zena-lang.host.createWebSession`).
The DIDs in `PDS_ADMIN_DIDS` are the host's admins, who sign in as anyone
does and see every account it holds, at `/admin`, and every private entry.
`PDS_WEB_DIR` names the build of the pages' stylesheet and script
(`packages/pds-web`), which it serves at `/assets/`.

The host reads other PDSes, for maintainers' attestations, profiles and
the dependencies of the releases it is given, only at public HTTPS names:
a DID document that names any other PDS resolves as naming none, and a
release whose dependency cannot be found is refused without the error
behind it. `PDS_PRIVATE_READS=1` lifts that, for a stack
on one machine, such as the demo's. A public name can still point at a
private address, which only the runtime sees: the image sets
`ZENA_DENY_PRIVATE_EGRESS=1`, so `zena-run` connects only to public
addresses, with `ZENA_ALLOW_EGRESS=metadata.google.internal` for the
metadata server that gives the service its Google credentials
(`packages/zena-runtime`).

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
secp256k1 private key in hex, and the secret that signs sessions' tokens,
32 bytes in hex, from secrets:

```sh
PDS_STORAGE=firestore PDS_TENANT=pkg PDS_BLOB_BUCKET=<bucket> PDS_JWT_SECRET=<hex> \
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

The package listings, on the pages and from `listPackages` and
`listScopes`, read a summary of each package that the host writes with
every commit to the package's repository, rather than the repositories
themselves. The memberships of `/me` (`getMemberships`) and the roles on
a person's page start from a second index, of the accounts whose records
or entries mention each person and team, which the host writes with
every commit to an organization's members or teams or a package's
maintainers. `sync-indexes` writes both again from the repositories and
exits: for accounts made before the host kept them, and for a commit
whose indexes could not be written, which the server logs.

With `encrypt-keys`, it encrypts every account's signing key that
Firestore keeps in the clear with `PDS_KEY_ENCRYPTION_KMS_KEY`, and
exits. Keys are encrypted as they are written once the server has that
key, so this is for the ones written before it had one.

With `create-scope <name> --owner <did> [--recovery-key <did:key>]...`, it
creates a scope owned by that DID and exits. This is how the operator
takes a name the host reserves (`www`, `api`, `admin`, `zena`, `pkg`,
`mail`, and `PDS_RESERVED_SCOPES`), which no `zena scope create` can.

`PDS_BLOB_DIR=<dir>` keeps blob bytes in a directory instead, for a server
on one machine. `FIRESTORE_EMULATOR_HOST` points the server at the
emulator, and `GOOGLE_CLOUD_PROJECT` names the project. A configuration
the server cannot use stops it with every problem listed, and status 2.

## Deploying

The package host runs on Cloud Run, in two environments that `PDS_ENV`
picks: `staging`, the default, at `pkg-staging.zena-lang.dev`, with its
own PLC directory, so nothing it makes reaches `plc.directory`; and
`production`, at `pkg.zena-lang.dev`. `deploy/env.sh` names what each one
owns: a service, a Firestore database, a bucket, a service account with
roles on those alone, a rotation-key secret, a session secret, and a Cloud DNS zone
delegated from `zena-lang.dev`'s for its handle records. With `gcloud`
signed in to the project:

```sh
export ZENA_GCP_PROJECT=meta-garage-420114 PDS_ENV=staging
npm run deploy:setup -w @zena-lang/pds    # once: the resources, the key and the zone
npm run deploy -w @zena-lang/pds          # builds the image with Cloud Build, and deploys it
npm run deploy:domain -w @zena-lang/pds   # once: maps the domain, with gcloud's beta component
```

`deploy:setup` is idempotent, and makes the rotation key and the session
secret only when there are none; run it again after pulling a change that
adds a resource, such as the session secret, before `deploy`. When
`zena-lang.dev`'s DNS is not a Cloud DNS zone in the project, or in
`ZENA_DNS_PARENT_PROJECT`, it prints the `NS` records that delegate the
environment's domain, to add where that DNS is kept. Back up staging's
key with
`gcloud secrets versions access latest --secret zena-pkg-staging-rotation-key`.
`deploy` checks that the new revision answers `describeServer`. The
certificate for the domain can take a while after `deploy:domain`.

`zena` uses staging with two variables, which `deploy/staging.env` sets;
it also clears `ZENA_DNS_OVER_HTTPS`, which a shell that ran the demo still
points at the demo's own resolver:

```sh
source packages/pds/deploy/staging.env    # ZENA_PACKAGE_HOST and ZENA_PLC_DIRECTORY
export ZENA_CONFIG_DIR=$(mktemp -d)       # optional: a staging sign-in apart from your usual one
```

Every shell that runs `zena` against staging needs them, `zena add` and
`zena fetch` included: without `ZENA_PLC_DIRECTORY`, a staging package's
DID is looked up in `plc.directory`, which has never heard of it.

### Rotation keys

Every account the host creates lists, highest ranked first: any recovery
keys its owners gave, the operator's offline key, and the host's online
key, which signs its operations (docs/design/package-manager.md, "Keys").

- **The online key** is in Cloud KMS for production
  (`PDS_ROTATION_KMS_KEY`): an HSM-protected secp256k1 key that
  `deploy:setup` makes and the service account may only sign with. It
  cannot be read or backed up. Staging keeps the secret
  `zena-pkg-staging-rotation-key` (`PDS_ROTATION_KEY`), which its accounts
  were made with; `ZENA_ROTATION_KMS=1` moves it to Cloud KMS, which
  leaves the host unable to sign for the accounts it already has, so do
  that only for a staging whose data was reset.
- **The offline key** is the operator's, made on a machine you trust, and
  never on the server:

  ```sh
  zena-cli run packages/pds/zena/main.zena -- generate-key
  ```

  It prints the private key, to keep offline (on paper, or in a password
  manager you trust), and its `did:key`, which deploys as
  `PDS_OFFLINE_ROTATION_KEY` from `ZENA_OFFLINE_ROTATION_KEY`. `deploy`
  refuses production without it. Only accounts created after it is set
  list it.

**If the online key is stolen or misused**, the offline key undoes what it
signed, within 72 hours of the first operation to undo. Find the last
good operation's CID in the account's log
(`https://plc.directory/<did>/log/audit`), then, on the machine with the
offline key:

```sh
zena-cli run packages/pds/zena/main.zena -- plc-restore <did> <cid> < offline-key.txt         # shows the operation
zena-cli run packages/pds/zena/main.zena -- plc-restore <did> <cid> --yes < offline-key.txt   # sends it
```

It sends a copy of that operation, signed by the offline key, which the
directory takes in place of every operation after it. Then disable the
KMS key version, make a new one, and deploy with it; the accounts' DID
documents still list the old public key until each is updated with an
operation the offline key signs. Staging's own PLC directory does not take
an operation that replaces others, so the procedure cannot be rehearsed
there.

### Signing keys

Each account's repository signing key, which signs its commits and the
service-auth tokens it asks for, is in its Firestore document. With
`PDS_KEY_ENCRYPTION_KMS_KEY`, a Cloud KMS symmetric key that
`deploy:setup` makes for each environment (`signing-keys` in the
environment's key ring), it is kept encrypted, bound to the account's DID,
so that a backup or an export of the database holds no key that signs.
The server decrypts a key the first time it signs with it, and keeps it in
memory. The service account may encrypt and decrypt with that key, and
the key never leaves Cloud KMS: destroying it loses every signing key it
encrypted. Without the variable, keys are kept in the clear, as in tests
and on the emulator.

Keys written before the server had the variable stay in the clear until
`encrypt-keys` encrypts them. After the first deploy with it, run it once
with the deployment's configuration, as a user who may use the key:

```sh
GOOGLE_CLOUD_PROJECT=<project> PDS_STORAGE=firestore PDS_FIRESTORE_DATABASE=zena-pkg-staging PDS_TENANT=pkg \
PDS_BLOB_BUCKET=<bucket> PDS_JWT_SECRET=<hex> \
PDS_KEY_ENCRYPTION_KMS_KEY=projects/<project>/locations/<region>/keyRings/zena-pkg-staging/cryptoKeys/signing-keys \
  zena-cli run packages/pds/zena/main.zena -- encrypt-keys
```

## Layout

- `zena/`: the server, the Zena package `pds`, imported as `pds:<library>`:
  - `storage`: the storage interfaces, and `MemoryStorage`;
  - `firestore`: the storage in Firestore, and where blob bytes go beside
    it;
  - `key-encryption`: accounts' signing keys encrypted with a Cloud KMS
    key, for Firestore to keep;
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
- `deploy/`: the image and the Cloud Run scripts.
- `dev/demo.zena`: the demo.
