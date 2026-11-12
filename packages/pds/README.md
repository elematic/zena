# pds

An [AT Protocol](https://atproto.com) Personal Data Server written in Zena, ported from [pds.js](https://tangled.org/chadtmiller.com/pds.js).

It holds many accounts, with its data in memory, or in Firestore with blob bytes in Cloud Storage or a directory. Each account's repository takes writes, which sign a new commit, and the server answers the reads of `com.atproto.sync` (`getRecord`, `getRepo`, `getLatestCommit`, `getBlob`, which also answers a `Range` of one span) and `com.atproto.repo` (`getRecord`, `listRecords`, `describeRepo`), and `com.atproto.server.describeServer`, which names its DID. With `PDS_PASSWORD_SESSIONS=1`, an account with an app password signs in with `com.atproto.server.createSession`, and with its session refreshes it, gets service-auth tokens (`getServiceAuth`), and writes its own repository (`putRecord`, `deleteRecord`). They are off by default: a managed account has no password, and nothing over the network gives an account one.

It also creates managed accounts for the App Views its operator trusts (`pds/managed`): `com.atproto.server.reserveSigningKey` makes the signing key of an account an App View is about to create, and `com.atproto.server.createAccount` creates it once the App View has minted its DID. A managed account has no password; it takes writes only with a service-auth token from its App View, and holds only the records and artifacts of Zena packages (`ManagedLimits`). An App View reaches the PDS through `pds/pds-client`: `XrpcPds` over the network, or `InProcessPds` in the same process.

## Usage

```zena
import {configFromEnv, serve} from 'pds/service';
import {getEnv} from 'zena:cli';

let config = configFromEnv((name) => getEnv(name));
await serve(config);
```

## Libraries

- `pds` (`pds/main`): the standalone PDS server entry point.
- `pds/storage`: the storage interfaces, and `MemoryStorage`.
- `pds/firestore`: the storage in Firestore, and where blob bytes go beside it.
- `pds/key-encryption`: accounts' signing keys encrypted with a Cloud KMS key, for Firestore to keep.
- `pds/repository`: an account's repository: writes, commits, proofs, and exports.
- `pds/pds`: the accounts and their repositories.
- `pds/managed`: managed accounts, and the checks on their App Views' tokens.
- `pds/sessions`: password sessions, for the accounts that sign in with an app password, and `HmacTokens`, the tokens they are made of.
- `pds/signer`: the keys an App View signs with, held in memory or in Cloud KMS, which `XrpcPds` signs its tokens with.
- `pds/pds-client`: the PDS as an App View reaches it (`InProcessPds` and `XrpcPds`).
- `pds/server`: the HTTP application, whose routes are in `pds/xrpc/*`.
- `pds/service`: the configuration, read from the environment (`PDS_*`), and the server it describes.

## Configuration

`pds/service` reads its configuration from `PDS_*` environment variables. With none, it runs a PDS in memory on port 2583, which keeps managed accounts for no App View. A PDS for an App View names its own origin and DID, and the App View it trusts, by its DID and the online rotation key that signs its accounts' genesis operations:

```sh
PDS_STORAGE=firestore PDS_TENANT=pkg PDS_BLOB_BUCKET=<bucket> \
PDS_PUBLIC_URL=https://padstone.zena-lang.dev PDS_DID=did:web:padstone.zena-lang.dev \
PDS_TRUSTED_APP_VIEWS="did:web:pkg.zena-lang.dev=did:key:zQ3sh..."
```
