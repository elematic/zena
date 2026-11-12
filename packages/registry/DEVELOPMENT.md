# Development

`packages/registry` is the Zena project's App View, the package manager's service ([docs/design/package-manager.md](../../docs/design/package-manager.md)). It keeps its accounts on [`packages/pds`](../pds) (padstone) and serves the web assets built by [`packages/pds-web`](../pds-web).

## Layout

- `zena-package.json`: Package manifest.
- `src/`: the Zena package `registry`, imported as `registry/<library>`:
  - `app-view`: the App View's methods, and what it keeps beside the accounts: scopes, names in them, and private membership entries;
  - `firestore`: the App View's stores in Firestore, beside the PDS's or under a tenant of their own;
  - `handles`: the DNS records that make the App View's handles resolve, in memory, and a DNS-over-HTTPS resolver that answers from them;
  - `plc-directory`: the PLC directory a staging App View is, which records the DIDs it makes and reads the rest from the public directory;
  - `egress`: what the App View may reach when it reads another server for someone;
  - `web-sessions`: the site's sessions and the signatures of the URLs its pages make, under the App View's own secret;
  - `server`: the HTTP application: the PDS's routes (`pds/server`) when the PDS is in the same process, the registry methods (`xrpc/`), and the site (`web/`);
  - `service`: the configuration, read from the environment, and the server it describes; `main` is the two together.
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

`npm run demo -w @zena-lang/registry`, from the repository root, starts everything a first publish needs on this machine, in one process (`dev/demo.zena`):

- The App View for the domain `pkg.test`, with the PDS its accounts are on in the same process, at `http://127.0.0.1:2583` (`PORT` changes the port). The web pages are there too. Deployments run the App View and padstone as two services; the demo runs them as one, as `main.zena` does without `APP_VIEW_PDS_URL`.
- A stand-in PLC directory, which records the demo's DIDs and reads every other DID from `plc.directory`, and a PDS with one maintainer, `did:plc:maintainermaintainermain`, whose app password is `demo-app-password`, at `http://127.0.0.1:2584`, the port after the App View's.
- A DNS-over-HTTPS resolver that answers for the handles under `pkg.test` and asks Cloudflare about every other name, at `http://127.0.0.1:2585`.

Nothing reaches the public PLC directory or real DNS, and everything is in memory: Ctrl-C forgets it all.

Each start writes the variables `zena` needs to use the demo to `.zena/demo/env.sh`. Source it in each shell that runs `zena pkg`, from the repository's root:

```sh
source .zena/demo/env.sh
```

### The repository's packages

`npm run demo:publish -w @zena-lang/registry` runs in place of `npm run demo`, not after it: it starts a demo of its own, on the same ports, so stop one that is running first. Its demo has the scope `zena-lang` and the repository's packages published in it, as their maintainers will publish them on a registry:

- `DEMO_SCOPES` creates `zena-lang`, owned by the demo's maintainer. The App View reserves the name, so only the operator can create it.
- The demo signs in as its maintainer with `zena pkg login`, and runs `zena pkg publish --yes` for each directory `DEMO_PUBLISH` names, separated by spaces, in order: by default `packages/wit-parser`, `packages/markdown`, `packages/workflow`, and `packages/zebra`. It publishes each from a fresh copy in `.zena/demo/packages`, since `publish` writes the new package's DID into the manifest, and the repository's manifest must not name a DID that is gone when the demo stops.

It prints what each `zena` command prints, and keeps serving if a publish fails. A package can be published when its manifest has a scope, a version, a description, and a license. A `path` dependency is published as the DID and version in the other package's manifest, so that package goes first: zebra depends on workflow, and the copies sit side by side, so `../workflow` is workflow's copy, with its DID.

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

## Deploying

The App View and padstone run on Cloud Run, in two environments that `PDS_ENV` picks: `staging` (the default) and `production`. With `gcloud` signed in to the project:

```sh
export ZENA_GCP_PROJECT=meta-garage-420114 PDS_ENV=staging
npm run deploy:setup -w @zena-lang/registry    # once: the resources, the key and the zone
npm run deploy -w @zena-lang/registry          # builds the image with Cloud Build, and deploys both services
npm run deploy:domain -w @zena-lang/registry   # once: maps both names, with gcloud's beta component
ZENA_ALERT_EMAIL=you@example.com npm run deploy:alerts -w @zena-lang/registry   # once both names answer
packages/registry/deploy/smoke.sh setup        # once, signed in to zena as an owner of the scope zena-lang
npm run deploy:smoke -w @zena-lang/registry    # after every deploy
```

`deploy/operator.sh` runs `create-scope`, `sync-handles`, `sync-indexes`, and `set-limit` on your machine against a deployed environment:

```sh
PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 packages/registry/deploy/operator.sh create-scope zena --owner did:plc:...
```

### Offline rotation key

To generate the operator's offline rotation key on a trusted machine:

```sh
zena-cli run packages/registry/src/main.zena -- generate-key
```

To restore an account's PLC log to `<cid>` using the offline key within 72 hours of a bad operation:

```sh
zena-cli run packages/registry/src/main.zena -- plc-restore <did> <cid> < offline-key.txt         # shows the operation
zena-cli run packages/registry/src/main.zena -- plc-restore <did> <cid> --yes < offline-key.txt   # sends it
```
