# The PDS's web assets

The stylesheet and script of the package host's web pages. The pages
themselves are rendered on the server, by the PDS written in Zena
(`packages/pds/zena/web`), as `zena:http` routes using its `html` tag:

- `/`: every package, with a search form (`?q=`), and every scope;
- `/scopes/<name>`: a scope's packages;
- `/packages/<handle>`: a package's profile and scope, the command that
  adds it, its versions with their dependencies and the versions they
  accept, its retractions, and its maintainers;
- `/people/<handle or DID>`: a person's profile, and the packages that
  name them as a maintainer publicly;
- `/me`: once signed in, the scopes, teams and packages you have a role in,
  with the role;
- `/admin`: for the host's admins, every scope, with its packages and
  automation accounts.

A scope's page lists its members and teams, and a package's its
maintainers. Each member is a commitment to a private entry, so a page
names a member only to someone who may see their entry: the member
themselves, an organization's owners and admins, a team's maintainers, a
package's owners, and the host's admins. Everyone else sees "a private
member".

## People

A page shows a person by their avatar and name, linked to their page. The
name and avatar come from their own profile record, `app.bsky.actor.profile`,
which this host reads from their PDS and caches, and never keeps a copy
of: a person changes them in the app that writes that record
(`pds:web/people`). Reading someone else's PDS while a page renders, and
serving their avatar, are limited so the host is no tool for anyone else:

- Each read runs under `zena:task`'s `timeout`, and answers are cached,
  failures for a shorter time.
- Only public HTTPS hosts are read: no addresses, `localhost`, or private
  names. A public name that resolves to a private address is #643.
- Avatars are served through this host, at URLs the pages sign, so a
  visitor's browser asks no third party, and the host serves only
  avatars its pages linked to. Only images up to 1 MB are served, with
  `nosniff` and a content security policy that allows nothing.

## Pages

Each is a plain page: links and forms, no client-side routing. This
package builds what they load from `/assets/`:

- `app.css`: [Radica](https://github.com/elematic/radica)'s design tokens
  (`@radica/base`: palette, colors, surfaces, type, sizes and the dark
  theme) and the pages' own styles over them. Radica's components keep
  their looks in their shadow roots, so server-rendered markup is styled
  here, from the same tokens.
- `app.js`: what must happen in the browser: the Radica theme select, and
  signing in and out. A page applies the saved theme from an inline script
  in its `<head>`, before it paints.
- `chunks/`: what `app.js` loads only when it needs it: the atproto OAuth
  client, for signing in and out.

## Signing in

A person signs in as their own atproto account, such as their Bluesky one,
with atproto OAuth (`@atproto/oauth-client-browser`): their own PDS asks
for their password, and this site never sees it. The OAuth session stays
in the browser. Then:

1. The page asks the person's PDS for a service-auth token for
   `dev.zena-lang.host.createWebSession`, addressed to the host, and calls
   that method with it.
2. The host checks the token as it checks every call to its methods, and
   answers with a cookie: an HS256 token naming the person's DID and
   handle, signed with `PDS_JWT_SECRET`, HttpOnly, SameSite=Lax, and
   Secure over HTTPS (`pds:web/session`).
3. Every page reads the cookie, so the pages are rendered for the person
   on the server. Signing out posts a form to `/signout`, which drops the
   cookie, after the page revokes the OAuth session.

The server never holds anything that can write to the person's
repository. A cookie cannot be revoked, so it lasts a day; a page with no
cookie, when the browser still has an OAuth session, makes a new one.

- Deployed, the client's `client_id` is the metadata document the host
  serves at `/oauth/client-metadata.json`, from `PDS_PUBLIC_URL`, with
  `/oauth/callback` as its redirect.
- On `127.0.0.1`, as in `npm run demo`, it is atproto's loopback client,
  which needs no metadata document, so signing in works on this machine
  with no tunnel. Use `http://127.0.0.1:<port>`, not `localhost`.
- Handles are resolved by the host (`com.atproto.identity.resolveHandle`),
  not sent to a third party.

## Admins

The host's admins are the DIDs in `PDS_ADMIN_DIDS` (`ZENA_ADMIN_DIDS` for
`deploy`). An admin signs in as their own account, as anyone does, and the
header links them to `/admin`; there is no separate admin password. The
host shows them every account it made (`PackageHost.listAccounts`) and
every private entry (`getEntries`), as its operator could read them from
the store anyway.

To see your memberships in the demo, sign in with a real account. The
demo keeps what it makes to itself, but reads real identities through:
its PLC directory reads DIDs it does not hold from `plc.directory`, and
its DNS resolver asks Cloudflare's about names it does not hold. You have
no role in anything there until you make one: sign `zena` in as the same
account (`zena login <handle or DID>`, with an app password), then
`zena scope create <name> --yes`, and reload `/me`. That writes nothing to
your repository; `zena publish` does, since it writes your attestation of
the release there. To see `/admin`, start the demo with your DID as an admin:
`PDS_ADMIN_DIDS=did:plc:… npm run demo -w @zena-lang/pds`.

## Commands

From the repository root:

```sh
npm run build -w @zena-lang/pds-web    # typecheck, and bundle into out/
npm run demo -w @zena-lang/pds         # a package host on this machine, serving the pages
```

The demo serves the pages at `http://127.0.0.1:2583`; it starts empty, and
prints the `zena` commands that publish a package to it. The deployed host
serves the assets from its image (`packages/pds/deploy`).

## How the PDS serves them

`PDS_WEB_DIR` names `out/`, and the PDS serves its files at `/assets/`
(`pds:service`). A program run by `zena run` or `zena-run` sees only the
directories it is given, so the directory is given with `--dir`:
`npm run demo` passes `--dir packages/pds-web/out::/web` with
`PDS_WEB_DIR=/web`, and the image passes `--dir /app/web::/web`. Without
it, the pages still render, unstyled.
