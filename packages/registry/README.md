# The Zena App View

The Zena project's App View, written in Zena: the package manager's
service ([docs/design/package-manager.md](../../docs/design/package-manager.md)).
It mints its packages' and organizations' DIDs, keeps their accounts on a
PDS ([`packages/pds`](../pds), padstone), and serves the
`dev.zena-lang.registry.*` methods `zena` calls, each checked with a
service-auth token from the caller's PDS, and
`dev.zena-lang.registry.describeRegistry`, which tells `zena` its service
DID and handle domain. `zena` refuses an App View whose DID does not name its
origin, so `APP_VIEW_DID` defaults to `did:web:<domain>`. The demo's is
`did:web:localhost%3A<port>`, since atproto allows a port in a `did:web`
only for `localhost` and a real PDS refuses tokens for any other; `zena`
takes it for the App View at `127.0.0.1` on that port.

It serves web pages, rendered on the server (`zena/web/`), beside its
XRPC routes (`zena/xrpc/`): a visitor browses the App View's scopes and
packages there, and a person signs in with atproto OAuth to see their own.
For that, the App View serves the pages' OAuth client metadata at
`/oauth/client-metadata.json`, resolves handles
(`com.atproto.identity.resolveHandle`), and trades a service-auth token
for a web session cookie (`dev.zena-lang.registry.createWebSession`).
The DIDs in `APP_VIEW_ADMIN_DIDS` are the App View's admins, who sign in as anyone
does and see every account it holds, at `/admin`, and every private entry.
`APP_VIEW_WEB_DIR` names the build of the pages' stylesheet and script
(`packages/pds-web`), which it serves at `/assets/`.

The App View reads other PDSes, for maintainers' attestations, profiles and
the dependencies of the releases it is given, only at public HTTPS names:
a DID document that names any other PDS resolves as naming none, and a
release whose dependency cannot be found is refused without the error
behind it. `APP_VIEW_PRIVATE_READS=1` lifts that, for a stack
on one machine, such as the demo's. A public name can still point at a
private address, which only the runtime sees: the image sets
`ZENA_DENY_PRIVATE_EGRESS=1`, so `zena-run` connects only to public
addresses, with `ZENA_ALLOW_EGRESS=metadata.google.internal` for the
metadata server that gives the service its Google credentials
(`packages/zena-runtime`).

The App View keeps its accounts on a PDS in the same process by default
(`registry:service`), and reaches it through `InProcessPds`. With
`APP_VIEW_PDS_URL`, it keeps them on a PDS elsewhere instead, which trusts
it (`PDS_TRUSTED_APP_VIEWS`), and reaches it through `XrpcPds`, with
service-auth tokens signed by its own signing key, which its DID document
lists.

## Commands

From the repository root:

```sh
npm test -w @zena-lang/registry                  # its tests, through wireit
npm run test:emulator -w @zena-lang/registry     # the store tests against the Firestore emulator
npm run demo -w @zena-lang/registry              # an App View to try zena against, on this machine
./target/release/zena-cli test "packages/registry/zena/test/*_test.zena"
APP_VIEW_DOMAIN=pkg.test ./target/release/zena-cli run packages/registry/zena/main.zena   # serve on $PORT, default 2583
```

## The demo

`npm run demo -w @zena-lang/registry`, from the repository root, starts
everything a first publish needs on this machine, in one process
(`dev/demo.zena`):

- The App View for the domain `pkg.test`, with the PDS its accounts are on
  in the same process, at `http://127.0.0.1:2583` (`PORT` changes the
  port). The web pages are there too. Deployments run the App View and
  padstone as two services; the demo runs them as one, as `main.zena` does
  without `APP_VIEW_PDS_URL`.
- A stand-in PLC directory, which records the demo's DIDs and reads every
  other DID from `plc.directory`, and a PDS with one maintainer,
  `did:plc:maintainermaintainermain`, whose app password is
  `demo-app-password`, at `http://127.0.0.1:2584`, the port after the
  App View's.
- A DNS-over-HTTPS resolver that answers for the handles under `pkg.test`
  and asks Cloudflare about every other name, at `http://127.0.0.1:2585`.

Nothing reaches the public PLC directory or real DNS, and everything is in
memory: Ctrl-C forgets it all. The limits on actions and creations apply
(docs/design/package-manager.md, "Limits on creating accounts"), so the
maintainer can create two scopes before the demo is restarted.

### Publishing a package

The demo prints the variables `zena` needs. Set them in each shell that
runs `zena pkg`: without `ZENA_REGISTRY`, `zena` calls the Zena project's
registry, `https://pkg.zena-lang.dev`. They stay right when the demo is
started again, with the same `PORT`, though what the demo held is gone:
a session made against its maintainer needs `zena pkg login` again.

```sh
export ZENA_PLC_DIRECTORY=http://127.0.0.1:2584/plc
export ZENA_DNS_OVER_HTTPS=http://127.0.0.1:2585/dns-query
export ZENA_REGISTRY=http://127.0.0.1:2583
export ZENA_CONFIG_DIR=$(mktemp -d)   # keeps the demo's sign-in apart from yours
alias zena="$PWD/target/release/zena-cli"   # run in the repository root
```

Then make a package outside the repository, sign in as the demo's
maintainer, create a scope, and publish. A package's manifest needs a
name, a version, a description and a license.

```sh
mkdir -p ~/demo/hello && cd ~/demo/hello
echo '{"name": "hello", "version": "1.0.0", "description": "Says hello", "license": "MIT"}' > zena-package.json
echo 'export let greeting = "hello";' > hello.zena
echo demo-app-password | zena pkg login did:plc:maintainermaintainermain --password-stdin
zena pkg scope create acme --yes
zena pkg publish --scope acme --yes
```

`publish` creates the package `hello.acme.pkg.test`, writes its DID into
`zena-package.json`, and publishes 1.0.0. With one maintainer, nothing
waits for approval. Publish as the demo's maintainer rather than as
yourself: `publish` writes an attestation to the publisher's repository,
which for you is on your real PDS.

In another workspace, with the same variables, add the package and import
its libraries as `'<name>:<library>'`:

```sh
mkdir -p ~/demo/app && cd ~/demo/app
echo '{"name": "app"}' > zena-package.json
zena pkg add hello.acme.pkg.test
cat > main.zena <<'EOF'
import {greeting} from 'hello:hello';

export function main(): i32 {
  console.log(greeting);
  return 0;
}
EOF
zena run main.zena
```

### The pages

Open `http://127.0.0.1:2583` to browse the demo's scopes and packages, and
sign in there with your own atproto account: the stand-in PLC directory
reads real DIDs from `plc.directory`. Start the demo with
`APP_VIEW_ADMIN_DIDS=<your DID>` to see `/admin` as well. Open the pages
at `127.0.0.1`, not `localhost`: signing in sends the browser back to
`127.0.0.1`.

### Reserved scopes

`zena pkg scope create` refuses the names the App View reserves, `zena`
among them; the operator creates those with `create-scope`, which acts on a
server's store. The demo's store is in its own process, so the demo creates
them itself, as the operator, from `DEMO_SCOPES`: scope and owner pairs,
the owner by DID or handle, separated by spaces.

```sh
DEMO_SCOPES="zena=alice.bsky.social" npm run demo -w @zena-lang/registry
```

The owner can then add packages to the scope, and people to it, as with
any other.

The demo builds its App View from the environment as `main.zena` does,
apart from the PLC directories and handle records it provides, so the
variables below change it too.

## Configuration

`main.zena` reads its configuration from the environment: the App View's
variables are `APP_VIEW_*` (`registry:service` lists them), and a PDS it
runs in the same process reads its own, `PDS_*`, as padstone alone does
(`pds:service`). It needs `APP_VIEW_DOMAIN`; with nothing else, it keeps
everything in memory on port 2583. A PDS alone starts from
`packages/pds/zena/main.zena`.

A deployment keeps its data in Firestore, for a tenant, with blob bytes in
a Cloud Storage bucket, writes its handles' TXT records to the Cloud DNS
zone that holds its domain, and gives the App View's PLC rotation key, a
secp256k1 private key in hex, and the secret that signs sessions' tokens,
32 bytes in hex, from secrets:

```sh
PDS_STORAGE=firestore PDS_TENANT=pkg PDS_BLOB_BUCKET=<bucket> PDS_JWT_SECRET=<hex> \
APP_VIEW_DOMAIN=pkg.zena-lang.dev APP_VIEW_ROTATION_KEY=<hex> \
APP_VIEW_HANDLE_RECORDS=cloud-dns APP_VIEW_DNS_ZONE=<managed zone> \
  ./target/release/zena-cli run packages/registry/zena/main.zena
```

With its PDS elsewhere, the App View takes no `PDS_*` variable. It keeps
its own stores in Firestore under a tenant of its own, and what it
derives from releases in a bucket; signs the site's sessions with a
secret of its own; and gives the signing key its tokens to the PDS are
checked with:

```sh
APP_VIEW_PDS_URL=https://padstone.zena-lang.dev \
APP_VIEW_STORAGE=firestore APP_VIEW_TENANT=pkg APP_VIEW_BUCKET=<bucket> APP_VIEW_SESSION_SECRET=<hex> \
APP_VIEW_DOMAIN=pkg.zena-lang.dev APP_VIEW_ROTATION_KEY=<hex> APP_VIEW_SIGNING_KEY=<hex> \
APP_VIEW_HANDLE_RECORDS=cloud-dns APP_VIEW_DNS_ZONE=<managed zone> \
  ./target/release/zena-cli run packages/registry/zena/main.zena
```

A staging App View adds `APP_VIEW_PLC=staging`: the server is then a PLC directory
itself, at `/plc`, that records the DIDs the App View makes and reads every
other DID from the public directory, so nothing it makes reaches the
public one (docs/design/pds.md, "Staging").

The same configuration with the argument `sync-handles`
(`zena-cli run packages/registry/zena/main.zena -- sync-handles`) writes every
handle record again from the App View's store and exits, for after a record
write failed or records were lost.

The package listings, on the pages and from `listPackages` and
`listScopes`, read a summary of each package that the App View writes with
every commit to the package's repository, rather than the repositories
themselves. The memberships of `/me` (`getMemberships`) and the roles on
a person's page start from a second index, of the accounts whose records
or entries mention each person and team, which the App View writes with
every commit to an organization's members or teams or a package's
maintainers. `sync-indexes` writes both again from the repositories and
exits: for accounts made before the App View kept them, and for a commit
whose indexes could not be written, which the server logs.

With `create-scope <name> --owner <did> [--recovery-key <did:key>]...`, it
creates a scope owned by that DID and exits. This is how the operator
takes a name the App View reserves (`www`, `api`, `admin`, `zena`, `pkg`,
`mail`, and `APP_VIEW_RESERVED_SCOPES`), which no `zena pkg scope create` can.

The App View limits the storage releases take: 4 MiB for one release, 64
MiB for a package's releases, those waiting for approval included, and 256
MiB for the releases of a scope's packages, and it stores only source
archives for now. It also counts each day's actions on each package and
scope and by each caller, and the scopes and packages created
(docs/design/package-manager.md, "Limits on creating accounts").
`set-limit <DID or handle> <limit> <number>|default` raises one of these
limits (`registry:app-view`'s `Limit`, such as `packageBytes` or
`userActions`) for a package, a scope's organization and its packages, or
a caller, or takes the setting away, and exits.

`deploy/operator.sh` runs `create-scope`, `sync-handles`, `sync-indexes`
and `set-limit` on your machine against a deployed environment, with its service's
configuration: the variables `deploy` gives it, its secrets from Secret
Manager, and an access token for its service account, which
`deploy:setup` lets the gcloud account that ran it act as:

```sh
PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 packages/registry/deploy/operator.sh create-scope zena --owner did:plc:...
```

`PDS_BLOB_DIR=<dir>` keeps blob bytes in a directory instead, for a server
on one machine. `FIRESTORE_EMULATOR_HOST` points the server at the
emulator, and `GOOGLE_CLOUD_PROJECT` names the project. A configuration
the server cannot use stops it with every problem listed, and status 2.

## Configuration reference

Every variable the App View, padstone, the image and the deploy scripts
read, with its value in the demo and in the two deployments. The
deployments' values come from `deploy/env.sh` and `deploy/deploy.sh`; a
blank cell means the variable is not set, and the default applies.
`registry:service` and `pds:service` describe each variable in full, and
`zena/test/configuration_test.zena` fails when one is missing here.

### The App View (`registry:service`)

| Variable                        | What it is                                                                                                                                             | Default                                            | Demo                       | Staging                                  | Production                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------- | ---------------------------------------- | ------------------------------------- |
| `APP_VIEW_DOMAIN`               | The domain of its site and handles. Required.                                                                                                          |                                                    | `pkg.test`                 | `pkg-staging.zena-lang.dev`              | `pkg.zena-lang.dev`                   |
| `APP_VIEW_PDS_URL`              | The origin of the PDS its accounts are on, when that runs elsewhere. Without it, the PDS runs in the same process, from the `PDS_*` variables.         | the same process                                   |                            | `https://padstone-staging.zena-lang.dev` | `https://padstone.zena-lang.dev`      |
| `APP_VIEW_PDS_DID`              | That PDS's DID.                                                                                                                                        | the `did:web` of its host                          |                            |                                          |                                       |
| `APP_VIEW_PUBLIC_URL`           | Its own origin, with a PDS elsewhere.                                                                                                                  | `https://<domain>`                                 |                            |                                          |                                       |
| `APP_VIEW_STORAGE`              | `memory` or `firestore`, with a PDS elsewhere.                                                                                                         | `memory`                                           |                            | `firestore`                              | `firestore`                           |
| `APP_VIEW_TENANT`               | Its tenant, with `firestore`.                                                                                                                          |                                                    |                            | `pkg`                                    | `pkg`                                 |
| `APP_VIEW_FIRESTORE_DATABASE`   | Its Firestore database.                                                                                                                                | `(default)`                                        |                            | `zena-pkg-staging`                       | `zena-pkg`                            |
| `APP_VIEW_BUCKET`               | The Cloud Storage bucket for what it derives from releases, with `firestore`, under `<tenant>/app-view/`. With its PDS in the same process, the PDS's. |                                                    |                            | `<project>-zena-pkg-staging`             | `<project>-zena-pkg`                  |
| `APP_VIEW_OBJECT_DIR`           | A directory for it instead, for a server on one machine.                                                                                               |                                                    |                            |                                          |                                       |
| `APP_VIEW_SESSION_SECRET`       | 32 bytes in hex, which signs web sessions and avatar URLs. Required with `APP_VIEW_PDS_URL` and Firestore.                                             | `PDS_JWT_SECRET` in the same process, else made up | made up                    | secret `zena-pkg-staging-jwt-secret`     | secret `zena-pkg-jwt-secret`          |
| `APP_VIEW_ROTATION_KEY`         | The online PLC rotation key, secp256k1 in hex. This or the next is required with Firestore.                                                            | made up in memory                                  | made up                    | secret `zena-pkg-staging-rotation-key`   |                                       |
| `APP_VIEW_ROTATION_KMS_KEY`     | The online rotation key as a Cloud KMS key version.                                                                                                    |                                                    |                            | with `ZENA_ROTATION_KMS=1`               | KMS `zena-pkg/rotation`               |
| `APP_VIEW_SIGNING_KEY`          | Its own signing key, in hex, for its tokens to a PDS elsewhere. This or the next is required with `APP_VIEW_PDS_URL` and Firestore.                    | made up                                            | made up                    |                                          |                                       |
| `APP_VIEW_SIGNING_KMS_KEY`      | Its signing key as a Cloud KMS key version.                                                                                                            |                                                    |                            | KMS `zena-pkg-staging/signing`           | KMS `zena-pkg/signing`                |
| `APP_VIEW_OFFLINE_ROTATION_KEY` | The operator's offline rotation key, a `did:key`, ranked above the online one.                                                                         | none                                               |                            | `ZENA_OFFLINE_ROTATION_KEY`              | `ZENA_OFFLINE_ROTATION_KEY`, required |
| `APP_VIEW_DID`                  | Its DID.                                                                                                                                               | the `did:web` of the origin its methods are at     | `did:web:localhost%3A2583` |                                          |                                       |
| `APP_VIEW_SITE_URL`             | The site's origin, when the pages have a name of their own.                                                                                            | none: every name serves both                       |                            |                                          |                                       |
| `APP_VIEW_ADMIN_DIDS`           | The DIDs of its admins, separated by commas or spaces.                                                                                                 | none                                               | yours, if you set it       | `ZENA_ADMIN_DIDS`                        | `ZENA_ADMIN_DIDS`                     |
| `APP_VIEW_RESERVED_SCOPES`      | Scope names no one may take, beside `www`, `api`, `admin`, `zena`, `pkg` and `mail`.                                                                   | none                                               |                            |                                          |                                       |
| `APP_VIEW_PRIVATE_READS`        | `1` lets it read PDSes on this machine or a private network.                                                                                           | off                                                | `1`                        |                                          |                                       |
| `APP_VIEW_HANDLE_RECORDS`       | Where it writes its handles' DNS records: `memory` or `cloud-dns`. Required with Firestore.                                                            | `memory`                                           | `memory`                   | `cloud-dns`                              | `cloud-dns`                           |
| `APP_VIEW_DNS_ZONE`             | The Cloud DNS zone, with `cloud-dns`.                                                                                                                  |                                                    |                            | `zena-pkg-staging`                       | `zena-pkg`                            |
| `APP_VIEW_DNS_PROJECT`          | That zone's project.                                                                                                                                   | the server's                                       |                            | the project                              | the project                           |
| `APP_VIEW_PLC_DIRECTORY`        | Where DIDs are resolved.                                                                                                                               | `https://plc.directory`                            | the stand-in               |                                          |                                       |
| `APP_VIEW_DNS_OVER_HTTPS`       | Where handles are resolved. In the demo, where its resolver asks about names outside `pkg.test`.                                                       | Cloudflare's                                       | Cloudflare's               |                                          |                                       |
| `APP_VIEW_PLC`                  | `public`: it sends its accounts' operations to the PLC directory. `staging`: it is a PLC directory itself, at `/plc`.                                  | `public`                                           | `public`, to the stand-in  | `staging`                                | `public`                              |
| `APP_VIEW_WEB_DIR`              | The build of the pages' stylesheet and script (`packages/pds-web`).                                                                                    | none: unstyled pages                               | `/web`                     | `/web`, from the image                   | `/web`, from the image                |

### The PDS (`pds:service`)

padstone reads these, and so does the App View for the PDS it runs in the
same process. With `APP_VIEW_PDS_URL`, the App View refuses them.

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
| `PDS_JWT_SECRET`             | 32 bytes in hex, which signs sessions' tokens. Required with `firestore`.                                            | made up in memory                        | made up                 | secret `zena-pkg-staging-jwt-secret`              | secret `zena-pkg-jwt-secret`              |
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

The runtime's other variables choose its garbage collector and turn on
profiling and logging, for debugging (`packages/zena-runtime`).

### The `zena` command

The variables the `zena pkg` commands read are in
[`packages/zena-cli`'s README](../zena-cli/README.md): the demo needs
`ZENA_REGISTRY`, `ZENA_PLC_DIRECTORY`, `ZENA_DNS_OVER_HTTPS` and
`ZENA_CONFIG_DIR`, and CI publishes with `ZENA_REGISTRY_TOKEN`.

### The deploy scripts (`deploy/`)

| Variable                    | What it is                                                                                                          | Default                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `PDS_ENV`                   | The environment: `staging` or `production`.                                                                         | `staging`                       |
| `ZENA_GCP_PROJECT`          | The Google Cloud project. Required.                                                                                 |                                 |
| `ZENA_GCP_REGION`           | The region of the services, the bucket and the image.                                                               | `us-central1`                   |
| `ZENA_GCP_REPO`             | The Artifact Registry repository of the image.                                                                      | `cloud-run-images`              |
| `ZENA_FIRESTORE_LOCATION`   | The Firestore database's location.                                                                                  | the region                      |
| `ZENA_KMS_LOCATION`         | The key ring's location.                                                                                            | the region                      |
| `ZENA_ROTATION_KMS`         | `1` keeps staging's online rotation key in Cloud KMS, as production's is. Only for a staging whose data was reset.  | `0` on staging                  |
| `ZENA_OFFLINE_ROTATION_KEY` | The `did:key` of the operator's offline rotation key, for `APP_VIEW_OFFLINE_ROTATION_KEY`. Required for production. |                                 |
| `ZENA_ADMIN_DIDS`           | The admins' DIDs, for `APP_VIEW_ADMIN_DIDS`.                                                                        |                                 |
| `ZENA_DNS_PARENT_PROJECT`   | The project of `zena-lang.dev`'s Cloud DNS zone.                                                                    | the project                     |
| `ZENA_DNS_PARENT_ZONE`      | That zone's name.                                                                                                   | the zone named `zena-lang.dev.` |
| `ZENA_SMOKE_SCOPE`          | The scope of the smoke test's canary package.                                                                       | `zena`                          |
| `ZENA_ALERT_EMAIL`          | Where `deploy:alerts` sends alerts. Required by it.                                                                 |                                 |
| `ZENA_MONTHLY_BUDGET`       | A monthly budget on the project, in US dollars, for `deploy:alerts`.                                                | none                            |

## Deploying

The App View and padstone run on Cloud Run, in two environments that
`PDS_ENV` picks: `staging`, the default, with its own PLC directory, so
nothing it makes reaches `plc.directory`; and `production`. Each has two
names, each a service of its own, both from one image
(docs/design/package-manager.md, "Names and addresses"):

| Environment  | The App View, its site and its handles | padstone                         |
| ------------ | -------------------------------------- | -------------------------------- |
| `staging`    | `pkg-staging.zena-lang.dev`            | `padstone-staging.zena-lang.dev` |
| `production` | `pkg.zena-lang.dev`                    | `padstone.zena-lang.dev`         |

The App View keeps its accounts on padstone (`APP_VIEW_PDS_URL`), which
trusts it by its DID, `did:web:<domain>`, and its online rotation key.
`deploy/env.sh` names what the two share: a Firestore database, under one
tenant, a bucket, a service account with roles on those alone, a
rotation key, a signing key, a session secret, and a Cloud DNS zone
delegated from `zena-lang.dev`'s for its handle records. With `gcloud`
signed in to the project:

```sh
export ZENA_GCP_PROJECT=meta-garage-420114 PDS_ENV=staging
npm run deploy:setup -w @zena-lang/registry    # once: the resources, the key and the zone
npm run deploy -w @zena-lang/registry          # builds the image with Cloud Build, and deploys both services
npm run deploy:domain -w @zena-lang/registry   # once: maps both names, with gcloud's beta component
ZENA_ALERT_EMAIL=you@example.com npm run deploy:alerts -w @zena-lang/registry   # once both names answer
packages/registry/deploy/smoke.sh setup        # once, signed in to zena as an owner of the scope zena
npm run deploy:smoke -w @zena-lang/registry    # after every deploy
```

`deploy:setup` is idempotent, and makes the keys and the session secret
only when there are none; run it again after pulling a change that adds a
resource, such as the App View's signing key, before `deploy`. When
`zena-lang.dev`'s DNS is not a Cloud DNS zone in the project, or in
`ZENA_DNS_PARENT_PROJECT`, it prints the `NS` records that delegate the
environment's domain, to add where that DNS is kept. Back up staging's
key with
`gcloud secrets versions access latest --secret zena-pkg-staging-rotation-key`.
`deploy` gives padstone the `did:key` of the App View's rotation key
(`PDS_TRUSTED_APP_VIEWS`), which the App View's module reads
(`main.zena -- did-key`), and checks that padstone answers
`describeServer` and the App View `describeRegistry`. `deploy:domain`
writes the App View's records into the environment's zone, and padstone's
`CNAME` into `zena-lang.dev`'s, or prints it when that zone is not in
Cloud DNS. It maps a name again when it is mapped to the other service.
The certificates for the names can take a while after it.

`zena` uses staging with two variables, which `deploy/staging.env` sets;
it also clears `ZENA_DNS_OVER_HTTPS`, which a shell that ran the demo still
points at the demo's own resolver:

```sh
source packages/registry/deploy/staging.env   # ZENA_REGISTRY and ZENA_PLC_DIRECTORY
export ZENA_CONFIG_DIR=$(mktemp -d)           # optional: a staging sign-in apart from your usual one
```

Every shell that runs `zena` against staging needs them, `zena pkg add` and
`zena pkg fetch` included: without `ZENA_PLC_DIRECTORY`, a staging package's
DID is looked up in `plc.directory`, which has never heard of it.

### Backups and alerts

Releases are permanent, so `deploy:setup` keeps the database from
deletion and backs it up. Point-in-time recovery keeps every version of
the last 7 days, a daily backup is kept 7 days, and in production a
weekly backup is kept 14 weeks. A blob deleted from the bucket can be
restored for 7 days on staging and 30 in production. A restore makes a
new database beside the old one:

```sh
gcloud firestore backups list --location us-central1
gcloud firestore databases restore --source-backup <backup> --destination-database zena-pkg-restored
gcloud firestore databases clone --source-database projects/meta-garage-420114/databases/zena-pkg \
  --snapshot-time 2026-11-08T10:20:00Z --destination-database zena-pkg-restored
gcloud storage restore gs://meta-garage-420114-zena-pkg/pkg/<did>/<cid>
```

To serve from a restored database, set `DATABASE` in `deploy/env.sh` to
it, then run `deploy:setup`, which gives the service account its role
on it, and `deploy`.

`deploy:smoke` checks an environment as its clients see it, with no
browser and no personal account (`dev/smoke.zena`): both names' health,
DID documents and descriptions, the site's home page, assets and OAuth
client, and the canary package `@zena/smoke` (`ZENA_SMOKE_SCOPE` names
another scope): its DID document, its repository on padstone, its page,
and a new workspace that adds it and runs a program importing it. Then
it publishes a new version as the automation account `smoke-ci`, which
the App View holds until a person approves it, checks that it is held,
and withdraws it, so that no run leaves a release behind. `smoke.sh
setup` makes the canary and the account once, as you, and keeps the
account's token in Secret Manager. `zena pkg owner add` and the other
commands it runs need you signed in with `zena pkg login`.

`deploy:alerts` watches an environment once both names answer. It makes
an uptime check of `/xrpc/_health` on each name, every 5 minutes from
three regions, and two alerts emailed to `ZENA_ALERT_EMAIL`: one when two
regions fail a check, and one when a service answers more than 4
requests in 5 minutes with a 5xx. With `ZENA_MONTHLY_BUDGET`, in US
dollars, it also sets a monthly budget on the project that warns at 50%,
90% and 100%. Running it again adds only what is missing.

### Rotation keys

Every account the App View creates lists, highest ranked first: any recovery
keys its owners gave, the operator's offline key, and the App View's online
key, which signs its operations (docs/design/package-manager.md, "Keys").

- **The online key** is in Cloud KMS for production
  (`APP_VIEW_ROTATION_KMS_KEY`): an HSM-protected secp256k1 key that
  `deploy:setup` makes and the service account may only sign with. It
  cannot be read or backed up. Staging keeps the secret
  `zena-pkg-staging-rotation-key` (`APP_VIEW_ROTATION_KEY`), which its accounts
  were made with; `ZENA_ROTATION_KMS=1` moves it to Cloud KMS, which
  leaves the App View unable to sign for the accounts it already has, so do
  that only for a staging whose data was reset.
- **The offline key** is the operator's, made on a machine you trust, and
  never on the server:

  ```sh
  zena-cli run packages/registry/zena/main.zena -- generate-key
  ```

  It prints the private key, to keep offline (on paper, or in a password
  manager you trust), and its `did:key`, which deploys as
  `APP_VIEW_OFFLINE_ROTATION_KEY` from `ZENA_OFFLINE_ROTATION_KEY`. `deploy`
  refuses production without it. Only accounts created after it is set
  list it.

**If the online key is stolen or misused**, the offline key undoes what it
signed, within 72 hours of the first operation to undo. Find the last
good operation's CID in the account's log
(`https://plc.directory/<did>/log/audit`), then, on the machine with the
offline key:

```sh
zena-cli run packages/registry/zena/main.zena -- plc-restore <did> <cid> < offline-key.txt         # shows the operation
zena-cli run packages/registry/zena/main.zena -- plc-restore <did> <cid> --yes < offline-key.txt   # sends it
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
and on the emulator. Run `deploy:setup` before the first `deploy` that
sets it: until the service account may use the key, creating an account
fails.

The App View's own signing key, which signs its tokens to padstone and
which its DID document lists, is `signing` in the same key ring
(`APP_VIEW_SIGNING_KMS_KEY`): an HSM-protected secp256k1 key in both
environments. Replacing it changes only the App View's DID document,
which padstone reads again when a token does not check.

## Layout

- `zena/`: the Zena package `registry`, imported as `registry:<library>`:
  - `app-view`: the App View's methods, and what it keeps beside the
    accounts: scopes, names in them, and private membership entries;
  - `firestore`: the App View's stores in Firestore, beside the PDS's or
    under a tenant of their own;
  - `handles`: the DNS records that make the App View's handles resolve, in
    memory, and a DNS-over-HTTPS resolver that answers from them;
  - `plc-directory`: the PLC directory a staging App View is, which records
    the DIDs it makes and reads the rest from the public directory;
  - `egress`: what the App View may reach when it reads another server
    for someone;
  - `web-sessions`: the site's sessions and the signatures of the URLs its
    pages make, under the App View's own secret;
  - `server`: the HTTP application: the PDS's routes (`pds:server`) when the
    PDS is in the same process, the registry methods (`xrpc/`), and the
    site (`web/`);
  - `service`: the configuration, read from the environment, and the
    server it describes; `main` is the two together.
- `zena/test/`: its tests.
- `deploy/`: the image and the Cloud Run scripts.
- `dev/demo.zena`: the demo; `dev/smoke.zena`: the smoke test.
