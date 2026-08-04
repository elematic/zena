# @zena-lang/website

The Zena documentation site: [Eleventy](https://www.11ty.dev/) for the build,
[Lit](https://lit.dev/) for the interactive parts, and a port of the
[VitePress](https://vitepress.dev/) default theme for the design.

```bash
npm run serve -w @zena-lang/website   # dev server with live reload
npm run build -w @zena-lang/website   # production build into _site/
npm run start -w @zena-lang/website   # serve _site/ with the production server
```

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

So the first deploy is `deploy:setup` then `deploy`, and after that
`deploy:preview` → check the URL → `deploy:promote`. Cloud Run rejects
`--no-traffic` on a service that does not exist yet, which is why the first one
has to be `deploy`.

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

### Why the build happens in Cloud Build

Cloud Run is amd64. Cross-building with `--platform linux/amd64` on an Apple
Silicon Mac runs `npm ci`, `tsc` and the Zena→wasm compile under qemu
emulation, which is several times slower than the ~30s native build. Cloud
Build runs on amd64 natively.

[`cloudbuild.yaml`](cloudbuild.yaml) only builds and pushes; the Cloud Run
deploy is a separate step under your own credentials. That way the Cloud Build
service account needs no `run.admin` or `iam.serviceAccountUser`.

`docker:build` stays for local testing and builds for the host architecture.

### Notes

Ctrl-C stops `docker:run`. If a container is ever orphaned, the escape hatch is
`docker stop zena-website` — that's what `--name` is for.

[`serve-static.js`](serve-static.js) handles SIGTERM and SIGINT explicitly. It
has to: it is PID 1 in the container, and Linux delivers a signal to PID 1 only
when a handler is installed, so relying on Node's default disposition means both
are ignored. Without it, Ctrl-C does nothing and Cloud Run SIGKILLs the instance
after its grace period rather than shutting it down. `docker:run` also passes
`--init` so tini handles signals even if that regresses.

The build context is the repo root, not this package, so `docker build` passes
`--file Dockerfile ../..` and every path inside the Dockerfile and
[`.dockerignore`](../../.dockerignore) is root-relative. The site build needs
the compiler, stdlib, cli, runtime and language-service packages.

`.dockerignore` is generated: edit
[`.dockerignore-sync`](../../.dockerignore-sync) and run `npm run ignore-sync`.
Most of it comes from the `.gitignore` files. The `[inline]` section carries
what those cannot: `**/` forms of the copied entries, since Docker matches a
slash-less pattern only at the context root where git matches it at any depth,
and `lsp.wat`, which is tracked and is the largest file in the repo at 9.2MB.
Excluding the wrong things here is expensive — without the `**/` entries the
context goes from ~320KB to 1.8GB.

`docker:build` declares no `files` or `output`, so wireit always runs it and
Docker's layer cache decides what to redo. An image is not a file, so there is
nothing for wireit to track: `--iidfile` would give it a filename, but wireit
would then call the script fresh after a `docker rmi` deleted the image that
file names.

Nothing here depends on `build`. The image runs the site build itself, and
`.dockerignore` excludes `**/_site/`, so building on the host first would
produce output the image never sees.

Only Node is needed in the image: `stdlib` and `cli` build with `tsc`, and
`lsp.wasm` is produced by running the Zena CLI under Node. wasmtime, wasm-tools
and Rust are used by tests, not by this build.

It is a multi-stage build, so the pruning a monorepo usually needs is not
necessary. The builder stage uses nearly every workspace package and is then
thrown away; the runtime stage copies only `_site/` and
[`serve-static.js`](serve-static.js).

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
- `::: code-group` — consecutive fences become tabs; label them with
  ` ```zena [main.zena] `
- ` ```zena ` — highlighted with the same grammar the VS Code extension uses

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
