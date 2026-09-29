# @zena-lang/website

The Zena documentation site: [Eleventy](https://www.11ty.dev/) for the build,
[Lit](https://lit.dev/) for the interactive parts, and a port of the
[VitePress](https://vitepress.dev/) default theme for the design.

```bash
npm run serve -w @zena-lang/website   # dev server with live reload
npm run build -w @zena-lang/website   # production build into _site/
npm run start -w @zena-lang/website   # serve _site/ with the production server
```

## Running with Docker Locally

To build and run the production container locally:

```bash
# 1. Build the Docker image (Wireit runs `build` first to ensure _site/ is fresh)
npm run docker:build -w @zena-lang/website

# 2. Run the container locally at http://localhost:8080
npm run docker:run -w @zena-lang/website
```

Or with direct Docker commands:

```bash
npm run build -w @zena-lang/website
docker build -t zena-website packages/website
docker run --rm --init -p 8080:8080 zena-website
```

Press `Ctrl-C` to stop (or run `docker stop zena-website`).

## Deploying

The site runs on Google Cloud Run, built from [`Dockerfile`](Dockerfile) in this
package. Every command is a wireit script here, so there is nothing to remember
beyond `npm run <script> -w @zena-lang/website`.

Set the project once — everything reads it, and every script fails with a
message before calling gcloud if it is missing:

```bash
export ZENA_GCP_PROJECT=<project-id>   # required
export ZENA_GCP_REGION=us-central1     # optional, this is the default
export ZENA_GCP_REPO=cloud-run-images  # optional, this is the default
```

| Script           | What it does                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy:setup`   | One time. Enables the APIs, creates the Artifact Registry repository, and grants Cloud Build push access to it. Idempotent, and replaces any clicking in the Cloud console. |
| `docker:run`     | Builds the image and serves it on `:8080`, for testing locally.                                                                                                             |
| `deploy`         | Builds in Cloud Build, then deploys and sends traffic to the new revision.                                                                                                  |
| `deploy:preview` | Same build, but the revision goes up with no traffic and a `next---` URL to check first.                                                                                    |
| `deploy:promote` | Sends traffic to the newest revision.                                                                                                                                       |

### Preview & Promote Workflow (Deploy Without Moving Live Traffic)

To deploy a new image to Cloud Run without directing live traffic to it:

```bash
npm run deploy:preview -w @zena-lang/website
```

This:

1. Builds `_site/` on the host via Wireit and packages/pushes the image via Cloud Build.
2. Deploys the revision to Cloud Run with `--no-traffic --tag next`.
3. Outputs a preview URL dedicated to the new revision:
   ```
   Preview URL (no live traffic):
   https://next---zena-website-<hash>-<region>.a.run.app
   ```
4. Live traffic to `https://zena-website-<hash>-<region>.a.run.app` continues serving the previous revision uninterrupted.

#### Promoting the New Image

Once you have verified the preview URL, route 100% of live traffic to the new revision:

```bash
npm run deploy:promote -w @zena-lang/website
```

#### Equivalent Direct `gcloud` Commands

If you prefer running raw `gcloud` CLI commands instead of npm scripts:

```bash
# 1. Build and push image:
npm run deploy:image -w @zena-lang/website

# 2. Deploy preview revision (no live traffic):
gcloud run deploy zena-website \
  --project "$ZENA_GCP_PROJECT" \
  --region "${ZENA_GCP_REGION:-us-central1}" \
  --image "${ZENA_GCP_REGION:-us-central1}-docker.pkg.dev/${ZENA_GCP_PROJECT}/${ZENA_GCP_REPO:-cloud-run-images}/zena-website" \
  --no-traffic \
  --tag next \
  --quiet

# 3. Promote revision to 100% live traffic:
gcloud run services update-traffic zena-website \
  --project "$ZENA_GCP_PROJECT" \
  --region "${ZENA_GCP_REGION:-us-central1}" \
  --to-latest \
  --quiet
```

_(Note: Cloud Run requires at least one initial deploy to the service before `--no-traffic` can be used. If the service does not exist yet, the very first deploy must be `npm run deploy`.)_

The service is deployed public (`--allow-unauthenticated`), which is what a docs
site for testers needs — the alternative requires every reader to hold a Google
account and an IAM grant. Set `ZENA_GCP_ALLOW_UNAUTH` to anything other than
`true` to keep it private.

Nothing prompts. `gcloud` is passed `--quiet` and every prompt is answered by a
flag, because these run under wireit, which pipes the child's stdio: a prompt
still prints, but keystrokes never reach gcloud, so the terminal echoes the
answer and the command waits forever.

If a deploy fails at the push step with
`Permission 'artifactregistry.repositories.uploadArtifacts' denied`, re-run
`deploy:setup`. `gcloud builds submit` pushes as Cloud Build's service account
rather than as you, so being able to push from your own machine says nothing
about whether a build can. [`scripts/gcp-setup.sh`](scripts/gcp-setup.sh) grants
that account `roles/artifactregistry.writer` on the repository — scoped to the
one repository, not the project. Which account a build uses depends on the age
of the project and on org policy (Cloud Build used to default to its own
service account and now defaults to the Compute Engine one), so the script
grants whichever of the two exist rather than guessing.

### How deployment works

The site is built on the host first via Wireit (`npm run build -w @zena-lang/website`),
which leverages your local Wireit and Cargo caches so incremental builds take
only seconds. The output (`_site/`) contains static HTML, CSS, client JavaScript
bundles, and `lsp.wasm`. Because WebAssembly bytecode and web assets are
architecture-neutral, `_site/` is completely portable.

The Docker container packages only `_site/` and [`serve-static.js`](serve-static.js)
into `node:26-slim`. Because there are no `RUN` commands in [`Dockerfile`](Dockerfile),
Docker only creates filesystem layers without executing any code. Packaging and
pushing the ~4MB context takes ~15–20s in Cloud Build (or 1–2s locally).

[`cloudbuild.yaml`](cloudbuild.yaml) only packages and pushes the image; the Cloud Run
deploy is a separate step under your own credentials. That way the Cloud Build
service account needs no `run.admin` or `iam.serviceAccountUser`.

`docker:build` also packages `_site/` directly and runs fast locally for testing.

### Notes

Ctrl-C stops `docker:run`. If a container is ever orphaned, the escape hatch is
`docker stop zena-website` — that's what `--name` is for.

[`serve-static.js`](serve-static.js) handles SIGTERM and SIGINT explicitly. It
has to: it is PID 1 in the container, and Linux delivers a signal to PID 1 only
when a handler is installed, so relying on Node's default disposition means both
are ignored. Without it, Ctrl-C does nothing and Cloud Run SIGKILLs the instance
after its grace period rather than shutting it down. `docker:run` also passes
`--init` so tini handles signals even if that regresses.

The build context for `Dockerfile` and `cloudbuild.yaml` is this package directory
(`packages/website`), with `.dockerignore` and `.gcloudignore` excluding everything
except `_site/` and `serve-static.js`. This keeps the upload size to ~4MB compressed.

Both `docker:build` and `deploy:image` declare Wireit dependencies on `build`,
so running either one automatically ensures `_site/` is fresh before packaging.

Two servers, deliberately:

- [`server.js`](server.js) is the dev server (`npm run serve`). It rewrites
  bare module specifiers via `@zipadee/javascript`.
- [`serve-static.js`](serve-static.js) is what runs in the container
  (`npm run start`). The built site has no bare specifiers — esbuild bundles
  the client into `/js/zena.js` — so it needs no rewriting, and no
  dependencies at all. That keeps the runtime image to Node plus the site.

Run `npm run start` to exercise the production server without Docker.

## Layout

```
lib/                     Build-time modules used by eleventy.config.js
  highlight.js             Shiki, incl. Zena's TextMate grammar
  markdown.js              markdown-it: anchors, custom containers, code groups
  search-index.js          Builds _site/search-index.json from rendered pages
  sidebar.js               Sidebar lookup, flattening, prev/next
  toc.js                   Outline extraction from rendered HTML
scripts/
  scaffold-docs.js         Creates placeholder pages from the sidebar plan
  print-outline.js         Regenerates CONTENT.md from the sidebar plan
src/
  _data/                   site, nav, sidebar, eleventyComputed
  _includes/               nav bar, sidebar, outline, doc footer
  _layouts/                base, home, doc, page
  css/                     Stylesheet (see below)
  public/                  Copied verbatim to the site root
  guide/  reference/       Content
```

## Content

[`src/_data/sidebar.js`](src/_data/sidebar.js) is the source of truth for site
structure. Each leaf carries an `outline` — the sections that page is meant to
cover — which makes the sidebar the content plan as well as the navigation.

To add a page:

1. Add it to the sidebar with an `outline`.
2. `npm run scaffold -w @zena-lang/website` — creates the stub and updates
   [`CONTENT.md`](CONTENT.md). Existing files are never modified.
3. Write it, and drop the `status: Draft` front matter when it's real.

Prev/next links, the search index, and the outline rail are all derived, so
none of them need touching.

### Markdown extras

Beyond CommonMark, pages can use:

- `::: tip` / `note` / `info` / `important` / `warning` / `danger` — callouts
- `::: details Summary` — a collapsed block
- ` ```zena ` — highlighted with the same grammar the VS Code extension uses
- ` ```zena [main.zena] ` — the label shows in the corner of the block

Tabbed code groups have no syntax of their own; write the markup, with ordinary
fences inside. Add `vertical` to put the tabs down the left rather than across
the top. The blank lines are load-bearing — they end each HTML block so
markdown-it parses the fence between them:

````md
<zena-code-group class="code-group">

<figure>
<figcaption>host</figcaption>

```bash
zena build main.zena --target host
```

</figure>

</zena-code-group>
````

## Styling

`src/css/theme/` began as the VitePress 1.6.4 default theme and is now ours.
Class names are unprefixed and kebab-case (`button`, `sidebar-item`, `prose`,
`icon-chevron-right`); only the design tokens still carry the upstream `--vp-`
prefix. Zena's own decisions live in `src/css/brand.css` and
`src/css/zena-components.css`.

See [`src/css/theme/README.md`](src/css/theme/README.md) for the file-by-file
provenance, the five renames that needed more than a mechanical strip, and two
caveats worth knowing before editing: base rules must precede their media
queries, and several selectors are deliberate `>` chains so they don't capture a
nested component's `.container` or `.content`.

## Interactivity

Everything interactive is a Lit element in
[`@zena-lang/website-client`](../website-client), bundled by esbuild from an
Eleventy `before` hook so the dev server rebuilds it on change.

All of them render into **light DOM**, so the global stylesheet applies to them
exactly as it does to server-rendered markup. Most only enhance HTML Eleventy
already produced — the sidebar, outline, and nav all work without JavaScript.

The playground is the exception: it is a published package,
[`@zena-lang/playground`](../playground), with its own shadow DOM, imported by
the client bundle. It loads `lsp.wasm` relative to its own module URL, so the
Eleventy passthrough copies that binary to `js/lsp.wasm`, next to the bundle,
and its worker gets a second esbuild entry point at `js/worker/`.
