# Development

`packages/registry` is the Zena project's App View, the package manager's
service ([docs/design/package-manager.md](../../docs/design/package-manager.md)).
It keeps its accounts on [`packages/pds`](../pds) (padstone) and serves
the web assets built by [`packages/pds-web`](../pds-web).

## Layout

- `zena-package.json`: Package manifest.
- `src/`: the Zena package `registry`, imported as `registry/<library>`:
  - `app-view`: the App View's methods, and what it keeps beside the
    accounts: scopes, names in them, and private membership entries;
  - `firestore`: the App View's stores in Firestore, beside the PDS's or
    under a tenant of their own;
  - `handles`: the DNS records that make the App View's handles resolve,
    in memory, and a DNS-over-HTTPS resolver that answers from them;
  - `plc-directory`: the PLC directory a staging App View is, which
    records the DIDs it makes and reads the rest from the public
    directory;
  - `egress`: what the App View may reach when it reads another server
    for someone;
  - `web-sessions`: the site's sessions and the signatures of the URLs
    its pages make, under the App View's own secret;
  - `server`: the HTTP application: the PDS's routes (`pds/server`) when
    the PDS is in the same process, the registry methods (`xrpc/`), and
    the site (`web/`);
  - `service`: the configuration, read from the environment, and the
    server it describes; `main` is the two together.
- `test/`: its tests.
- `deploy/`: the image and the Cloud Run scripts.
- `dev/demo.zena`: the demo; `dev/smoke.zena`: the smoke test.

## Commands

From the repository root:

```sh
npm test -w @zena-lang/registry                  # its tests, through wireit
npm run test:emulator -w @zena-lang/registry     # the store tests against the Firestore emulator
npm run demo -w @zena-lang/registry              # an App View to try zena against, on this machine
npm run demo:publish -w @zena-lang/registry      # or: the same, with the repository's packages published in it
./target/release/zena-cli test "packages/registry/test/*_test.zena"
APP_VIEW_DOMAIN=pkg.test ./target/release/zena-cli run packages/registry/src/main.zena   # serve on $PORT, default 2583
```

## The demo

`npm run demo -w @zena-lang/registry`, from the repository root, starts
everything a first publish needs on this machine, in one process
(`dev/demo.zena`):

- The App View for the domain `pkg.test`, with the PDS its accounts are
  on in the same process, at `http://127.0.0.1:2583` (`PORT` changes the
  port). The web pages are there too. Deployments run the App View and
  padstone as two services; the demo runs them as one, as `main.zena`
  does without `APP_VIEW_PDS_URL`.
- A stand-in PLC directory, which records the demo's DIDs and reads every
  other DID from `plc.directory`, and a PDS with one maintainer,
  `did:plc:maintainermaintainermain`, whose app password is
  `demo-app-password`, at `http://127.0.0.1:2584`, the port after the
  App View's.
- A DNS-over-HTTPS resolver that answers for the handles under
  `pkg.test` and asks Cloudflare about every other name, at
  `http://127.0.0.1:2585`.

Nothing reaches the public PLC directory or real DNS, and everything is
in memory: Ctrl-C forgets it all. The limits on actions and creations
apply (docs/design/package-manager.md, "Limits on creating accounts"), so
the maintainer can create two scopes before the demo is restarted.

### The variables

Each start writes the variables `zena` needs to use the demo to
`.zena/demo/env.sh`. Source it in each shell that runs `zena pkg`, from
the repository's root: without `ZENA_REGISTRY`, `zena` calls the Zena
project's registry, `https://pkg.zena-lang.dev`.

```sh
source .zena/demo/env.sh
```

It sets `ZENA_REGISTRY`, `ZENA_PLC_DIRECTORY`, `ZENA_DNS_OVER_HTTPS` and
`ZENA_CONFIG_DIR`, which keeps the demo's sign-in in `.zena/demo/config`,
apart from yours. It also unsets `ZENA_REGISTRY_TOKEN`, and makes `zena`
an alias for this checkout's `target/release/zena-cli`. With the same
`PORT`, the file is the same from one start to the next, though what the
demo held is gone: a session made against its maintainer needs
`zena pkg login` again.

### Publishing a package

Make a package outside the repository, sign in as the demo's maintainer,
create a scope, and publish. A package's manifest needs a name, a
version, a description and a license; its libraries are in `src/`, and
`main` names the one an import of the package's name alone gets.

```sh
mkdir -p ~/demo/hello/src && cd ~/demo/hello
echo '{"name": "hello", "version": "1.0.0", "description": "Says hello", "license": "MIT", "main": "hello"}' > zena-package.json
echo 'export let greeting = "hello";' > src/hello.zena
echo demo-app-password | zena pkg login did:plc:maintainermaintainermain --password-stdin
zena pkg scope create acme --yes
zena pkg publish --scope acme --yes
```

`publish` creates the package `hello.acme.pkg.test`, writes its DID into
`zena-package.json`, and publishes 1.0.0. With one maintainer, nothing
waits for approval. Publish as the demo's maintainer rather than as
yourself: `publish` writes an attestation to the publisher's repository,
which for you is on your real PDS.

In another workspace, with the same variables, add the package as
`scope:name` and import it: its main library as `'<scope>:<name>'`, and
any of its libraries as `'<scope>:<name>/<library>'`.

```sh
mkdir -p ~/demo/app && cd ~/demo/app
echo '{"name": "app"}' > zena-package.json
zena pkg add acme:hello
cat > main.zena <<'EOF'
import {greeting} from 'acme:hello';

export function main(): i32 {
  console.log(greeting);
  return 0;
}
EOF
zena run main.zena
```

### The repository's packages

`npm run demo:publish -w @zena-lang/registry` runs in place of
`npm run demo`, not after it: it starts a demo of its own, on the same
ports, so stop one that is running first. Its demo has the scope
`zena-lang` and the repository's packages published in it, as their
maintainers will publish them on a registry:

- `DEMO_SCOPES` creates `zena-lang`, owned by the demo's maintainer. The
  App View reserves the name, so only the operator can create it
  ("Reserved scopes", below).
- The demo signs in as its maintainer with `zena pkg login`, and runs
  `zena pkg publish --yes` for each directory `DEMO_PUBLISH` names,
  separated by spaces, in order: by default `packages/wit-parser`,
  `packages/markdown`, `packages/workflow` and `packages/zebra`. It
  publishes each from a fresh copy in `.zena/demo/packages`, since
  `publish` writes the new package's DID into the manifest, and the
  repository's manifest must not name a DID that is gone when the demo
  stops.

It prints what each `zena` command prints, and keeps serving if a
publish fails. A package can be published when its manifest has a scope,
a version, a description and a license. A `path` dependency is published
as the DID and version in the other package's manifest, so that package
goes first: zebra depends on workflow, and the copies sit side by side,
so `../workflow` is workflow's copy, with its DID.

```sh
npm run demo:publish -w @zena-lang/registry
# and the scope zena, owned by you
DEMO_SCOPES="zena-lang=did:plc:maintainermaintainermain zena=alice.bsky.social" npm run demo:publish -w @zena-lang/registry
```

The maintainer stays signed in, so in another shell:

```sh
source .zena/demo/env.sh
mkdir -p ~/demo/try-wit && cd ~/demo/try-wit
echo '{"name": "try-wit"}' > zena-package.json
zena pkg add zena-lang:wit-parser
cat > main.zena <<'EOF'
import {parse} from 'zena-lang:wit-parser';
import {serializeAstToJson} from 'zena-lang:wit-parser/ast-json';

export function main(): i32 {
  let ast = parse('package demo:greeter;\n\ninterface greet {\n  hello: func(name: string) -> string;\n}\n');
  console.log(serializeAstToJson(ast));
  return 0;
}
EOF
zena run main.zena
zena pkg add zena-lang:markdown
cat > render.zena <<'EOF'
import {gfmExtensions, markdownToHtml} from 'zena-lang:markdown';

export function main(): i32 {
  console.log(markdownToHtml('# Hello\n\nSome ~~old~~ **new** text.', {extensions: gfmExtensions(), safe: true}));
  return 0;
}
EOF
zena run render.zena
```

### What to try

Before deploying a change to staging, try what it touches here:

- **Adding.** `zena pkg add zena-lang:wit-parser`, then `zena run` a
  program that imports its main library and another of its libraries, as
  above. In another workspace, add it by its handle under a name of your
  own, `zena pkg add wit-parser.zena-lang.pkg.test --name wit`, and
  import it as `'wit'` and `'wit/ast-json'`.
- **Dependencies.** `zena pkg add zena-lang:zebra` pins workflow too, and
  a program importing `zena-lang:zebra/runner` compiles against both.
- **Another version.** In `.zena/demo/packages/wit-parser`, raise
  `version` in `zena-package.json` and run `zena pkg publish`; then
  `zena pkg update` in the workspace that added it.
- **Who belongs.** `zena pkg scope info zena-lang`,
  `zena pkg scope members zena-lang`, and `zena pkg owner list` in
  `.zena/demo/packages/wit-parser`.
- **The pages.** At `http://127.0.0.1:2583`: the home page's listing,
  `/scopes/zena-lang`, `/packages/wit-parser.zena-lang.pkg.test` with its
  README and its Files tab, a Markdown file and a source file there, and
  `/people/did:plc:maintainermaintainermain`. Then sign in with your own
  account, as below, and open `/me`.

### The pages

Open `http://127.0.0.1:2583` to browse the demo's scopes and packages,
and sign in there with your own atproto account: the stand-in PLC
directory reads real DIDs from `plc.directory`. Start the demo with
`APP_VIEW_ADMIN_DIDS=<your DID>` to see `/admin` as well. Open the pages
at `127.0.0.1`, not `localhost`: signing in sends the browser back to
`127.0.0.1`.

### Reserved scopes

`zena pkg scope create` refuses the names the App View reserves, `zena`
and `zena-lang` among them; the operator creates those with
`create-scope`, which acts on a server's store. The demo's store is in
its own process, so the demo creates them itself, as the operator, from
`DEMO_SCOPES`: scope and owner pairs, the owner by DID or handle,
separated by spaces.

```sh
DEMO_SCOPES="zena=alice.bsky.social" npm run demo -w @zena-lang/registry
```

The owner can then add packages to the scope, and people to it, as with
any other.

The demo builds its App View from the environment as `registry/main`
does, apart from the PLC directories and handle records it provides, so
the variables of the README's configuration reference change it too.

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
`deploy/env.sh` names what the two share: a Firestore database, under
one tenant, a bucket, a service account with roles on those alone, a
rotation key, a signing key, a session secret, and a Cloud DNS zone
delegated from `zena-lang.dev`'s for its handle records. Each
environment's settings are checked in to the operator's private deploy
repository, as `staging.sh` and `production.sh`, shaped as
`deploy/environments/example.sh` is: the project, the domains, where the
rotation key is, the offline key's `did:key` and the admins. This
repository names neither the project nor the admins. `ZENA_DEPLOY_SETTINGS`
is the directory of a checkout of it. Nothing else comes from your shell,
so changing production is a pull request there; a `ZENA_GCP_PROJECT` or
another variable the settings once came from stops the scripts when it
disagrees with the file. Below, `<project>` is the settings' `PROJECT`.
With `gcloud` signed in to the project:

```sh
export ZENA_DEPLOY_SETTINGS=~/zena-team/deploy PDS_ENV=staging
npm run deploy:setup -w @zena-lang/registry    # once: the resources, the key and the zone
npm run deploy -w @zena-lang/registry          # builds the image with Cloud Build, and deploys both services
npm run deploy:domain -w @zena-lang/registry   # once: maps both names, with gcloud's beta component
ZENA_ALERT_EMAIL=you@example.com npm run deploy:alerts -w @zena-lang/registry   # once both names answer
packages/registry/deploy/smoke.sh setup        # once, signed in to zena as an owner of the scope zena-lang
npm run deploy:smoke -w @zena-lang/registry    # after every deploy
```

`deploy:setup` is idempotent, and makes the keys and the session secret
only when there are none; run it again after pulling a change that adds
a resource, such as the App View's signing key, before `deploy`. When
`zena-lang.dev`'s DNS is not a Cloud DNS zone in the project, or in the
settings' `DNS_PARENT_PROJECT`, it prints the `NS` records that delegate the
environment's domain, to add where that DNS is kept.
`deploy` gives padstone the `did:key` of the App View's rotation key
(`PDS_TRUSTED_APP_VIEWS`), which the App View's module reads
(`registry/main`'s `did-key`), and checks that padstone answers
`describeServer` and the App View `describeRegistry`. `deploy:domain`
writes the App View's records into the environment's zone, and
padstone's `CNAME` into `zena-lang.dev`'s, or prints it when that zone is
not in Cloud DNS. It maps a name again when it is mapped to the other
service. The certificates for the names can take a while after it.

`deploy/operator.sh` runs the App View's operator commands,
`create-scope`, `sync-handles`, `sync-indexes` and `set-limit` (the
README's "Configuration"), on your machine against a deployed
environment, with its service's configuration: the variables `deploy`
gives it, its secrets from Secret Manager, and an access token for its
service account, which `deploy:setup` lets the gcloud account that ran it
act as:

```sh
PDS_ENV=staging packages/registry/deploy/operator.sh create-scope zena-lang --owner did:plc:...
```

Both environments let only their admins and the accounts they list
create scopes (the settings' `SCOPE_CREATORS=listed`). To let someone
create one, signed in with `zena pkg login` as an admin:

```sh
zena pkg admin allow <their handle or DID>   # with ZENA_REGISTRY naming the environment
zena pkg admin list                          # who is listed, by whom, and when
zena pkg admin deny <their handle or DID>    # their scopes stay
```

The change applies at once, with no deploy. Inside a scope, its owners
add whoever they like, so the list only decides who brings new scopes.

The App View limits the storage releases take: 4 MiB for one release, 64
MiB for a package's releases, those waiting for approval included, and
256 MiB for the releases of a scope's packages. It also counts each day's
actions on each package and scope and by each caller, and the scopes and
packages created (docs/design/package-manager.md, "Limits on creating
accounts"). `set-limit` raises one for a package, a scope's organization
and its packages, or a caller.

`zena` uses staging with two variables, which `deploy/try-staging.sh` sets;
it also clears `ZENA_DNS_OVER_HTTPS`, which a shell that ran the demo
still points at the demo's own resolver:

```sh
source packages/registry/deploy/try-staging.sh   # ZENA_REGISTRY and ZENA_PLC_DIRECTORY
export ZENA_CONFIG_DIR=$(mktemp -d)           # optional: a staging sign-in apart from your usual one
```

Every shell that runs `zena` against staging needs them, `zena pkg add`
and `zena pkg fetch` included: without `ZENA_PLC_DIRECTORY`, a staging
package's DID is looked up in `plc.directory`, which has never heard of
it. In a shell that sourced the demo's `.zena/demo/env.sh`,
`ZENA_CONFIG_DIR` still names the demo's sign-in: set it, or use a new
shell.

### A new staging

To deploy what is on `main` to staging, and publish the repository's
packages there:

1. Bring the checkout up to date, and build the `zena` command:

   ```sh
   git switch main && git pull
   npm ci
   npm run build -w @zena-lang/zena-cli
   ```

2. Try it on this machine first: `npm test -w @zena-lang/registry`, and
   `npm run test:emulator -w @zena-lang/registry` after a change to
   `registry/firestore` or `registry/service`. Then
   `npm run demo:publish -w @zena-lang/registry`, and what "What to try"
   lists.

3. Deploy, with `gcloud` signed in to the project:

   ```sh
   export ZENA_DEPLOY_SETTINGS=~/zena-team/deploy PDS_ENV=staging
   npm run deploy:setup -w @zena-lang/registry   # when a change adds a resource; it changes nothing otherwise
   npm run deploy -w @zena-lang/registry
   npm run deploy:smoke -w @zena-lang/registry
   ```

   `deploy` builds the image with Cloud Build, deploys padstone and then
   the App View, and checks that each answers. `deploy:smoke` checks both
   names as their clients see them, and publishes and withdraws a
   version of the canary `zena-lang:smoke`.

4. Publish the repository's packages to staging, signed in as yourself.
   Publish each from a copy, as the demo does: the DID `publish` writes
   is staging's, and the repository's manifests keep their `did` for the
   production registry. Copy them side by side and publish them in
   order, so that zebra's `../workflow` is workflow's copy, with its DID:

   ```sh
   source packages/registry/deploy/try-staging.sh
   export ZENA_CONFIG_DIR=~/.config/zena-staging
   alias zena="$PWD/target/release/zena-cli"
   zena pkg login <your handle>
   zena pkg scope info zena-lang
   mkdir ~/zena-staging   # a new one: cp -R into an earlier copy would nest it
   for p in wit-parser markdown workflow zebra; do
     cp -R packages/$p ~/zena-staging/ && (cd ~/zena-staging/$p && zena pkg publish --yes)
   done
   ```

   `zena-lang` is a reserved scope. When `scope info` finds none, create
   it as the operator, with you as its owner, before publishing:

   ```sh
   packages/registry/deploy/operator.sh create-scope zena-lang --owner <your DID>
   ```

   Keep the copies, since their manifests have staging's DIDs. For a
   later version, copy the package again and add its DID to the copy's
   manifest; `publish` names the DID when a copy without it tries to
   create the package again. Publishing as yourself writes each
   release's attestation to your own repository, on your PDS.

5. Try it there, as on this machine: the pages at
   `https://pkg-staging.zena-lang.dev`, and, in a new workspace with the
   same variables, `zena pkg add zena-lang:wit-parser` and a program
   that imports it, as in "The repository's packages".

### Resetting staging

Staging's data can be thrown away; production's cannot. A reset deletes
every account, with staging's own PLC directory, which is in the same
database:

```sh
export ZENA_DEPLOY_SETTINGS=~/zena-team/deploy PDS_ENV=staging
gcloud firestore bulk-delete --database=zena-pkg-staging --project <project>
gcloud storage rm "gs://<project>-zena-pkg-staging/**"
gcloud dns record-sets list --zone zena-pkg-staging --filter 'type=TXT' --project <project>
# for each _atproto. record:
gcloud dns record-sets delete <name> --type TXT --zone zena-pkg-staging --project <project>
gcloud secrets delete zena-pkg-staging-smoke-token --project <project>
npm run deploy:setup -w @zena-lang/registry   # makes a KMS rotation key the settings ask for
npm run deploy -w @zena-lang/registry
packages/registry/deploy/smoke.sh setup       # the canary and its token, again
```

A handle record left behind no longer blocks its name, but points at a
DID that is gone. The smoke token's secret goes with the account it
was for, and `smoke.sh setup` refuses to run while it exists. Then
create the scope `zena-lang` again (step 4 of "A new staging"). A reset
is also the only way to change where staging's online rotation key is
(`ROTATION_KMS`), since the App View cannot sign for accounts made with
another key.

### Requiring a newer zena

`zena` names its version to every registry call, in its `user-agent`
(`zena/0.1.0 (linux-x86_64) zena-compiler/0.1.0 package-manager/0.1.0`).
Its version is the `version` in `packages/zena-cli/zena-package.json`,
and the compiler's and the package manager's are in theirs. Raise the
command's with each release, then run `npm run versions`, which copies
them into `packages/zena-cli/zena/versions.zena`; a test fails while that
file is out of date. The App View logs each call to its methods as a JSON line, with
the method, the caller, that client and the answer's status, which Cloud
Logging keeps. It also keeps, for each release it completes, who
published and completed it, with which clients and when
(`publications/` in Firestore), and its admins see those clients in a
"Published with" column on the package's page. Releases completed before
it kept them show a dash.

Which versions the App View takes is in code, in `registry/clients`, and
changes in the pull request that changes how `zena` and the App View
talk, not in a deploy setting:

1. The change that a newer `zena` needs raises zena-cli's version, and
   `RECOMMENDED_CLIENT_VERSION` to match. Older clients still work, and
   `zena` warns their users that their version is deprecated and to
   upgrade.
2. Once they have had time to, a later change raises
   `MINIMUM_CLIENT_VERSION` and removes what only the older clients
   needed. `describeRegistry` names the minimum, `zena` below it stops
   before it calls and says to upgrade, and the App View refuses its calls
   with `UpgradeRequired`.

A client that names no `zena` version, such as the site's script, is not
judged. Commands that only read packages, `zena pkg add` and
`zena pkg fetch`, do not call the App View and are not stopped.

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
gcloud firestore databases clone --source-database projects/<project>/databases/zena-pkg \
  --snapshot-time 2026-11-08T10:20:00Z --destination-database zena-pkg-restored
gcloud storage restore gs://<project>-zena-pkg/pkg/<did>/<cid>
```

To serve from a restored database, set `DATABASE` in `deploy/env.sh` to
it, then run `deploy:setup`, which gives the service account its role on
it, and `deploy`.

`deploy:smoke` checks an environment as its clients see it, with no
browser and no personal account (`dev/smoke.zena`): both names' health,
DID documents and descriptions, the site's home page, assets and OAuth
client, and the canary package `zena-lang:smoke` (the settings' `SMOKE_SCOPE`
names its scope): its DID document, its repository on padstone, its
page, and a new workspace that adds it and runs a program importing it.
Then it publishes a new version as the automation account `smoke-ci`,
which the App View holds until a person approves it, checks that it is
held, and withdraws it, so that no run leaves a release behind.
`smoke.sh setup` makes the canary and the account once, as you, and
keeps the account's token in Secret Manager. `zena pkg owner add` and
the other commands it runs need you signed in with `zena pkg login`.

`deploy:alerts` watches an environment once both names answer. It makes
an uptime check of `/xrpc/_health` on each name, every 5 minutes from
three regions, and two alerts emailed to `ZENA_ALERT_EMAIL`: one when two
regions fail a check, and one when a service answers more than 4
requests in 5 minutes with a 5xx. With `ZENA_MONTHLY_BUDGET`, in US
dollars, it also sets a monthly budget on the project that warns at 50%,
90% and 100%. Running it again adds only what is missing.

### Rotation keys

Every account the App View creates lists, highest ranked first: any
recovery keys its owners gave, the operator's offline key, and the App
View's online key, which signs its operations
(docs/design/package-manager.md, "Keys").

- **The online key** is in Cloud KMS (`APP_VIEW_ROTATION_KMS_KEY`), in
  both environments (the settings' `ROTATION_KMS=1`): an HSM-protected
  secp256k1 key that `deploy:setup` makes and the service account may
  only sign with. It cannot be read or backed up. With `ROTATION_KMS=0`,
  staging uses the secret `zena-pkg-staging-rotation-key`
  (`APP_VIEW_ROTATION_KEY`) instead. Changing where the key is leaves the
  App View unable to sign for the accounts it already has, so change it
  only together with a reset of staging, then run `deploy:setup` to make
  the new key, and `deploy`.
- **The offline key** is the operator's, made on a machine you trust,
  and never on the server:

  ```sh
  zena-cli run packages/registry/src/main.zena -- generate-key
  ```

  It prints the private key, to keep offline (on paper, or in a password
  manager you trust), and its `did:key`, which deploys as
  `APP_VIEW_OFFLINE_ROTATION_KEY` from the settings'
  `OFFLINE_ROTATION_KEY`.
  `deploy` refuses production without it, and so does the App View
  itself, however it is started: with Firestore and the public PLC
  directory it stops at start without the key, unless
  `APP_VIEW_ALLOW_NO_OFFLINE_KEY=1` says so on purpose. Only accounts
  created after it is set list it.

**If the online key is stolen or misused**, the offline key undoes what
it signed, within 72 hours of the first operation to undo. Find the last
good operation's CID in the account's log
(`https://plc.directory/<did>/log/audit`), then, on the machine with the
offline key:

```sh
zena-cli run packages/registry/src/main.zena -- plc-restore <did> <cid> < offline-key.txt         # shows the operation
zena-cli run packages/registry/src/main.zena -- plc-restore <did> <cid> --yes < offline-key.txt   # sends it
```

It sends a copy of that operation, signed by the offline key, which the
directory takes in place of every operation after it. Then disable the
KMS key version, make a new one, and deploy with it; the accounts' DID
documents still list the old public key until each is updated with an
operation the offline key signs. Staging's own PLC directory does not
take an operation that replaces others, so the procedure cannot be
rehearsed there.

### Signing keys

Each account's repository signing key, which signs its commits and the
service-auth tokens it asks for, is in its Firestore document. With
`PDS_KEY_ENCRYPTION_KMS_KEY`, a Cloud KMS symmetric key that
`deploy:setup` makes for each environment (`signing-keys` in the
environment's key ring), it is kept encrypted, bound to the account's
DID, so that a backup or an export of the database holds no key that
signs. The server decrypts a key the first time it signs with it, and
keeps it in memory. The service account may encrypt and decrypt with
that key, and the key never leaves Cloud KMS: destroying it loses every
signing key it encrypted. Without the variable, keys are kept in the
clear, as in tests and on the emulator. Run `deploy:setup` before the
first `deploy` that sets it: until the service account may use the key,
creating an account fails.

The App View's own signing key, which signs its tokens to padstone and
which its DID document lists, is `signing` in the same key ring
(`APP_VIEW_SIGNING_KMS_KEY`): an HSM-protected secp256k1 key in both
environments. Replacing it changes only the App View's DID document,
which padstone reads again when a token does not check.
