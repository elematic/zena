# registry

The Zena package manager's App View, written in Zena: it mints package and organization DIDs, keeps their accounts on a PDS (`pds`), serves the `dev.zena-lang.registry.*` XRPC methods, and renders the package registry web pages.

It serves web pages, rendered on the server (`registry/web/routes`), beside its XRPC routes (`registry/xrpc/routes`): a visitor browses the App View's scopes and packages there, and a person signs in with atproto OAuth to see their own. For that, the App View serves the pages' OAuth client metadata at `/oauth/client-metadata.json`, resolves handles (`com.atproto.identity.resolveHandle`), and trades a service-auth token for a web session cookie (`dev.zena-lang.registry.createWebSession`). The DIDs in `APP_VIEW_ADMIN_DIDS` are the App View's admins, who sign in as anyone does and see every account it holds, at `/admin`, and every private entry. `APP_VIEW_WEB_DIR` names the build of the pages' stylesheet and script, which it serves at `/assets/`.

The App View reads other PDSes, for maintainers' attestations, profiles, and the dependencies of the releases it is given, only at public HTTPS names: a DID document that names any other PDS resolves as naming none, and a release whose dependency cannot be found is refused without the error behind it. `APP_VIEW_PRIVATE_READS=1` lifts that, for a stack on one machine, such as a local demo.

The App View keeps its accounts on a PDS in the same process by default (`registry/service`), and reaches it through `InProcessPds`. With `APP_VIEW_PDS_URL`, it keeps them on a PDS elsewhere instead, which trusts it (`PDS_TRUSTED_APP_VIEWS`), and reaches it through `XrpcPds`, with service-auth tokens signed by its own signing key, which its DID document lists.

## Usage

```zena
import {configFromEnv, serve} from 'registry/service';
import {getEnv} from 'zena:cli';

let config = configFromEnv((name) => getEnv(name));
await serve(config);
```

## Libraries

- `registry` (`registry/main`): the App View server and operator CLI entry point.
- `registry/app-view`: the App View's methods, and what it keeps beside the accounts: scopes, names in them, and private membership entries.
- `registry/firestore`: the App View's stores in Firestore, beside the PDS's or under a tenant of their own.
- `registry/handles`: the DNS records that make the App View's handles resolve, in memory, and a DNS-over-HTTPS resolver that answers from them.
- `registry/plc-directory`: the PLC directory a staging App View is, which records the DIDs it makes and reads the rest from the public directory.
- `registry/release-contents`: what the App View derives from a release's archive for its pages (files and rendered README).
- `registry/egress`: what the App View may reach when it reads another server for someone.
- `registry/web-sessions`: the site's sessions and the signatures of the URLs its pages make, under the App View's own secret.
- `registry/server`: the HTTP application: the PDS's routes (`pds/server`) when the PDS is in the same process, the registry methods (`registry/xrpc/routes`), and the site (`registry/web/routes`).
- `registry/service`: the configuration, read from the environment, and the server it describes; `registry/main` is the two together.

## Configuration

`registry/main` reads its configuration from the environment: the App View's variables are `APP_VIEW_*` (`registry/service` lists them), and a PDS it runs in the same process reads its own, `PDS_*`, as padstone alone does (`pds/service`). It needs `APP_VIEW_DOMAIN`; with nothing else, it keeps everything in memory on port 2583. A PDS alone starts from `pds/main`.

A deployment keeps its data in Firestore, for a tenant, with blob bytes in a Cloud Storage bucket, writes its handles' TXT records to the Cloud DNS zone that holds its domain, and gives the App View's PLC rotation key, a secp256k1 private key in hex, and the secret that signs the site's sessions, 32 bytes in hex, from secrets:

```sh
PDS_STORAGE=firestore PDS_TENANT=pkg PDS_BLOB_BUCKET=<bucket> \
APP_VIEW_DOMAIN=pkg.zena-lang.dev APP_VIEW_ROTATION_KEY=<hex> APP_VIEW_SESSION_SECRET=<hex> \
APP_VIEW_HANDLE_RECORDS=cloud-dns APP_VIEW_DNS_ZONE=<managed zone>
```

With its PDS elsewhere, the App View takes no `PDS_*` variable. It keeps its own stores in Firestore under a tenant of its own, and what it derives from releases in a bucket; signs the site's sessions with a secret of its own; and gives the signing key its tokens to the PDS are checked with:

```sh
APP_VIEW_PDS_URL=https://padstone.zena-lang.dev \
APP_VIEW_STORAGE=firestore APP_VIEW_TENANT=pkg APP_VIEW_BUCKET=<bucket> APP_VIEW_SESSION_SECRET=<hex> \
APP_VIEW_DOMAIN=pkg.zena-lang.dev APP_VIEW_ROTATION_KEY=<hex> APP_VIEW_SIGNING_KEY=<hex> \
APP_VIEW_HANDLE_RECORDS=cloud-dns APP_VIEW_DNS_ZONE=<managed zone>
```

A staging App View adds `APP_VIEW_PLC=staging`: the server is then a PLC directory itself, at `/plc`, that records the DIDs the App View makes and reads every other DID from the public directory, so nothing it makes reaches the public one.

The same configuration with the argument `sync-handles` writes every handle record again from the App View's store and exits, for after a record write failed or records were lost. `sync-indexes` writes the package summary and membership mention indexes again from the repositories and exits. With `create-scope <name> --owner <did> [--recovery-key <did:key>]...`, it creates a scope owned by that DID and exits. `set-limit <DID or handle> <limit> <number>|default` raises one of the storage or rate limits (`registry/app-view`'s `Limit`, such as `packageBytes` or `userActions`) for a package, a scope's organization and its packages, or a caller, or takes the setting away, and exits.

## Configuration reference

Every variable the App View, padstone, the image, and the deploy scripts read, with its value in the demo and in the two deployments. `registry/service` and `pds/service` describe each variable in full, and `test/configuration_test.zena` fails when one is missing here.

### The App View (`registry/service`)

| Variable                        | What it is                                                                                                                                             | Default                                        | Demo                       | Staging                                  | Production                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------- | ---------------------------------------- | -------------------------------- |
| `APP_VIEW_DOMAIN`               | The domain of its site and handles. Required.                                                                                                          |                                                | `pkg.test`                 | `pkg-staging.zena-lang.dev`              | `pkg.zena-lang.dev`              |
| `APP_VIEW_PDS_URL`              | The origin of the PDS its accounts are on, when that runs elsewhere. Without it, the PDS runs in the same process, from the `PDS_*` variables.         | the same process                               |                            | `https://padstone-staging.zena-lang.dev` | `https://padstone.zena-lang.dev` |
| `APP_VIEW_PDS_DID`              | That PDS's DID.                                                                                                                                        | the `did:web` of its host                      |                            |                                          |                                  |
| `APP_VIEW_PUBLIC_URL`           | Its own origin, with a PDS elsewhere.                                                                                                                  | `https://<domain>`                             |                            |                                          |                                  |
| `APP_VIEW_STORAGE`              | `memory` or `firestore`, with a PDS elsewhere.                                                                                                         | `memory`                                       |                            | `firestore`                              | `firestore`                      |
| `APP_VIEW_TENANT`               | Its tenant, with `firestore`.                                                                                                                          |                                                |                            | `pkg`                                    | `pkg`                            |
| `APP_VIEW_FIRESTORE_DATABASE`   | Its Firestore database.                                                                                                                                | `(default)`                                    |                            | `zena-pkg-staging`                       | `zena-pkg`                       |
| `APP_VIEW_BUCKET`               | The Cloud Storage bucket for what it derives from releases, with `firestore`, under `<tenant>/app-view/`. With its PDS in the same process, the PDS's. |                                                |                            | `<project>-zena-pkg-staging`             | `<project>-zena-pkg`             |
| `APP_VIEW_OBJECT_DIR`           | A directory for it instead, for a server on one machine.                                                                                               |                                                |                            |                                          |                                  |
| `APP_VIEW_SESSION_SECRET`       | 32 bytes in hex, which signs web sessions and avatar URLs. Required with Firestore.                                                                    | made up                                        | made up                    | secret `zena-pkg-staging-jwt-secret`     | secret `zena-pkg-jwt-secret`     |
| `APP_VIEW_ROTATION_KEY`         | The online PLC rotation key, secp256k1 in hex. This or the next is required with Firestore.                                                            | made up in memory                              | made up                    | with `ROTATION_KMS=0`, its secret        |                                  |
| `APP_VIEW_ROTATION_KMS_KEY`     | The online rotation key as a Cloud KMS key version.                                                                                                    |                                                |                            | KMS `zena-pkg-staging/rotation`          | KMS `zena-pkg/rotation`          |
| `APP_VIEW_SIGNING_KEY`          | Its own signing key, in hex, for its tokens to a PDS elsewhere. This or the next is required with `APP_VIEW_PDS_URL` and Firestore.                    | made up                                        | made up                    |                                          |                                  |
| `APP_VIEW_SIGNING_KMS_KEY`      | Its signing key as a Cloud KMS key version.                                                                                                            |                                                |                            | KMS `zena-pkg-staging/signing`           | KMS `zena-pkg/signing`           |
| `APP_VIEW_OFFLINE_ROTATION_KEY` | The operator's offline rotation key, a `did:key`, ranked above the online one. Required with Firestore and the public PLC directory.                   | none                                           |                            | none                                     | `OFFLINE_ROTATION_KEY`, required |
| `APP_VIEW_ALLOW_NO_OFFLINE_KEY` | `1` starts such an App View without the offline key, on purpose.                                                                                       | off                                            |                            |                                          |                                  |
| `APP_VIEW_DID`                  | Its DID.                                                                                                                                               | the `did:web` of the origin its methods are at | `did:web:localhost%3A2583` |                                          |                                  |
| `APP_VIEW_SITE_URL`             | The site's origin, when the pages have a name of their own.                                                                                            | none: every name serves both                   |                            |                                          |                                  |
| `APP_VIEW_ADMIN_DIDS`           | The DIDs of its admins, separated by commas or spaces.                                                                                                 | none                                           | yours, if you set it       | `ADMIN_DIDS`                             | `ADMIN_DIDS`                     |
| `APP_VIEW_RESERVED_SCOPES`      | Scope names no one may take, beside `www`, `api`, `admin`, `zena`, `zena-lang`, `pkg` and `mail`.                                                      | none                                           |                            |                                          |                                  |
| `APP_VIEW_SCOPE_CREATORS`       | Who may create a scope: `anyone`, or `listed`, only its admins and the accounts they list with `zena pkg admin allow`.                                 | `anyone`                                       |                            | `SCOPE_CREATORS`, `listed`               | `SCOPE_CREATORS`, `listed`       |
| `APP_VIEW_MIN_CLIENT_VERSION`   | The oldest `zena` its methods take, such as `0.2.0`; an older one is refused with `UpgradeRequired`.                                                   | any                                            |                            | `MIN_CLIENT_VERSION`                     | `MIN_CLIENT_VERSION`             |
| `APP_VIEW_CLIENT_NOTICE`        | A message `describeRegistry` gives, which `zena` prints before each command that calls the App View.                                                   | none                                           |                            | `CLIENT_NOTICE`                          | `CLIENT_NOTICE`                  |
| `APP_VIEW_PRIVATE_READS`        | `1` lets it read PDSes on this machine or a private network.                                                                                           | off                                            | `1`                        |                                          |                                  |
| `APP_VIEW_HANDLE_RECORDS`       | Where it writes its handles' DNS records: `memory` or `cloud-dns`. Required with Firestore.                                                            | `memory`                                       | `memory`                   | `cloud-dns`                              | `cloud-dns`                      |
| `APP_VIEW_DNS_ZONE`             | The Cloud DNS zone, with `cloud-dns`.                                                                                                                  |                                                |                            | `zena-pkg-staging`                       | `zena-pkg`                       |
| `APP_VIEW_DNS_PROJECT`          | That zone's project.                                                                                                                                   | the server's                                   |                            | the project                              | the project                      |
| `APP_VIEW_PLC_DIRECTORY`        | Where DIDs are resolved.                                                                                                                               | `https://plc.directory`                        | the stand-in               |                                          |                                  |
| `APP_VIEW_DNS_OVER_HTTPS`       | Where handles are resolved. In the demo, where its resolver asks about names outside `pkg.test`.                                                       | Cloudflare's                                   | Cloudflare's               |                                          |                                  |
| `APP_VIEW_PLC`                  | `public`: it sends its accounts' operations to the PLC directory. `staging`: it is a PLC directory itself, at `/plc`.                                  | `public`                                       | `public`, to the stand-in  | `staging`                                | `public`                         |
| `APP_VIEW_WEB_DIR`              | The build of the pages' stylesheet and script (`packages/pds-web`).                                                                                    | none: unstyled pages                           | `/web`                     | `/web`, from the image                   | `/web`, from the image           |

### The PDS (`pds/service`)

padstone reads these, and so does the App View for the PDS it runs in the same process. With `APP_VIEW_PDS_URL`, the App View refuses them.

| Variable                     | What it is                                                                                                           | Default                                  | Demo                    | Staging                                           | Production                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------- | ------------------------------------------------- | ----------------------------------------- |
| `PORT`                       | The port to listen on. The App View reads it too.                                                                    | `2583`                                   | `2583`                  | `8080`, from the image                            | `8080`, from the image                    |
| `PDS_STORAGE`                | `memory` or `firestore`.                                                                                             | `memory`                                 | `memory`                | `firestore`                                       | `firestore`                               |
| `PDS_TENANT`                 | Its tenant, with `firestore`.                                                                                        |                                          |                         | `pkg`                                             | `pkg`                                     |
| `PDS_BLOB_BUCKET`            | The Cloud Storage bucket for blob bytes, with `firestore`.                                                           |                                          |                         | `<project>-zena-pkg-staging`                      | `<project>-zena-pkg`                      |
| `PDS_BLOB_DIR`               | A directory for blob bytes instead, for a server on one machine.                                                     |                                          |                         |                                                   |                                           |
| `PDS_FIRESTORE_DATABASE`     | Its Firestore database.                                                                                              | `(default)`                              |                         | `zena-pkg-staging`                                | `zena-pkg`                                |
| `PDS_KEY_ENCRYPTION_KMS_KEY` | The Cloud KMS key that encrypts accounts' signing keys in Firestore.                                                 | none: kept in the clear                  |                         | KMS `zena-pkg-staging/signing-keys`               | KMS `zena-pkg/signing-keys`               |
| `PDS_PUBLIC_URL`             | The origin the accounts' DID documents name as their PDS.                                                            | the server's own                         | `http://127.0.0.1:2583` | `https://padstone-staging.zena-lang.dev`          | `https://padstone.zena-lang.dev`          |
| `PDS_DID`                    | Its DID, which App Views' tokens are addressed to.                                                                   | the `did:web` of `PDS_PUBLIC_URL`'s host |                         |                                                   |                                           |
| `PDS_TRUSTED_APP_VIEWS`      | The App Views it keeps managed accounts for, each `<did>=<did:key>` of its online rotation key, separated by spaces. | none; the App View in the same process   |                         | `did:web:pkg-staging.zena-lang.dev=<its did:key>` | `did:web:pkg.zena-lang.dev=<its did:key>` |
| `PDS_PLC_DIRECTORY`          | Where DIDs are resolved and managed accounts' operations read.                                                       | `https://plc.directory`                  | the stand-in            | `https://pkg-staging.zena-lang.dev/plc`           |                                           |
| `PDS_PASSWORD_SESSIONS`      | `1` serves password sessions, which managed accounts have no use for.                                                | `0`                                      |                         |                                                   |                                           |
| `PDS_JWT_SECRET`             | 32 bytes in hex, which signs password sessions' tokens. Required with them and `firestore`.                          | made up in memory                        |                         |                                                   |                                           |
| `PDS_CLOCK_ID`               | 0 to 1023, which keeps this server's revisions apart from another's.                                                 | random                                   |                         |                                                   |                                           |

### Google Cloud and the runtime

| Variable                           | What it is                                                                                                                            | Default                      | Demo                   | Staging and production                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------- | ------------------------------------------ |
| `GOOGLE_CLOUD_PROJECT`             | The project Firestore and Cloud DNS are reached in.                                                                                   | the metadata server's        |                        | the project, set by `deploy`               |
| `FIRESTORE_EMULATOR_HOST`          | The Firestore emulator's address, in place of Firestore.                                                                              |                              | to run on the emulator |                                            |
| `GOOGLE_OAUTH_ACCESS_TOKEN`        | An access token to call Google Cloud with, such as `gcloud auth print-access-token`'s. `operator.sh` and `deploy`'s `did-key` set it. | the metadata server's tokens |                        |                                            |
| `GCE_METADATA_HOST`                | The metadata server's host.                                                                                                           | `metadata.google.internal`   |                        |                                            |
| `HOST`                             | The address the server listens on.                                                                                                    | `127.0.0.1`                  |                        | `0.0.0.0`, from the image                  |
| `ZENA_DENY_PRIVATE_EGRESS`         | `1`: the server connects only to public addresses.                                                                                    | off                          |                        | `1`, from the image                        |
| `ZENA_ALLOW_EGRESS`                | Host names exempt from that, separated by commas.                                                                                     | none                         |                        | `metadata.google.internal`, from the image |
| `ZENA_HTTP_HEADER_TIMEOUT_SECONDS` | How long a client may take to send a request's headers.                                                                               | `30`                         |                        |                                            |
| `ZENA_HTTP_MAX_CONNECTIONS`        | How many connections the server keeps open at once.                                                                                   | `1024`                       |                        |                                            |

### The environments' settings

Each environment's settings are checked in to the operator's private repository, as `staging.sh` and `production.sh`, shaped as `deploy/environments/example.sh` is. `deploy/env.sh` reads `$ZENA_DEPLOY_SETTINGS/<PDS_ENV>.sh`. They hold public values only, but this repository does not name the project or the admins. A deploy script refuses a missing setting, and a `ZENA_*` variable that once gave one, such as `ZENA_GCP_PROJECT`, when it disagrees with the file.

| Setting                | What it is                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROJECT`              | The Google Cloud project.                                                                                                                  |
| `REGION`               | The region of the services, the bucket and the image.                                                                                      |
| `REPO`                 | The Artifact Registry repository of the image.                                                                                             |
| `FIRESTORE_LOCATION`   | The Firestore database's location.                                                                                                         |
| `KMS_LOCATION`         | The key ring's location.                                                                                                                   |
| `DOMAIN`               | The App View's domain, for `APP_VIEW_DOMAIN`: `pkg-staging.zena-lang.dev` and `pkg.zena-lang.dev`.                                         |
| `PDS_DOMAIN`           | padstone's domain: `padstone-staging.zena-lang.dev` and `padstone.zena-lang.dev`.                                                          |
| `PLC_MODE`             | `APP_VIEW_PLC`. Production must be `public`.                                                                                               |
| `ROTATION_KMS`         | `1` keeps the online rotation key in Cloud KMS; `0` in a Secret Manager secret. Changing it needs a reset staging. Production must be `1`. |
| `OFFLINE_ROTATION_KEY` | The `did:key` of the operator's offline rotation key, for `APP_VIEW_OFFLINE_ROTATION_KEY`. Production must have one.                       |
| `ADMIN_DIDS`           | The admins' DIDs, for `APP_VIEW_ADMIN_DIDS`.                                                                                               |
| `SCOPE_CREATORS`       | `APP_VIEW_SCOPE_CREATORS`: `anyone`, or `listed`, only the admins and the accounts they list.                                              |
| `MIN_CLIENT_VERSION`   | `APP_VIEW_MIN_CLIENT_VERSION`, or empty for any.                                                                                           |
| `CLIENT_NOTICE`        | `APP_VIEW_CLIENT_NOTICE`, or empty for none. Commas are fine: `deploy` passes the App View's variables as a file.                          |
| `WEEKLY_BACKUPS`       | `1` adds a weekly backup, kept 14 weeks, to the daily ones.                                                                                |
| `SOFT_DELETE`          | How long a deleted blob stays recoverable from the bucket.                                                                                 |
| `SMOKE_SCOPE`          | The scope of the smoke test's canary package.                                                                                              |
| `DNS_PARENT_PROJECT`   | The project of `zena-lang.dev`'s Cloud DNS zone, by default the project.                                                                   |
| `DNS_PARENT_ZONE`      | That zone's name. Empty while `zena-lang.dev` is at the registrar: the scripts print the records to add there.                             |

### The deploy scripts (`deploy/`)

| Variable               | What it is                                                                                                                            | Default   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `PDS_ENV`              | The environment: `staging` or `production`.                                                                                           | `staging` |
| `ZENA_DEPLOY_SETTINGS` | The directory of the environments' settings, `staging.sh` and `production.sh`: a checkout of the private deploy repository. Required. |           |
| `ZENA_ALERT_EMAIL`     | Where `deploy:alerts` sends alerts. Required by it.                                                                                   |           |
| `ZENA_MONTHLY_BUDGET`  | A monthly budget on the project, in US dollars, for `deploy:alerts`.                                                                  | none      |
