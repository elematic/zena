# The App View's web assets (For AI Agents)

`packages/pds-web` builds the stylesheet, script, and static documentation
(`/docs/`) of the App View's pages. The dynamic pages are rendered on
the server, in Zena, in `packages/registry/zena/web/`; the static documentation
pages are rendered by Eleventy from `site/docs/` into `out/docs/` and
served at `/docs/` by `registry/service`. Read this package's README first.

- Each page is a module of its own under `packages/registry/zena/web/pages/`
  (`registry/web/pages/package`, `.../scope`, ...), which exports a function
  that adds its routes; `registry/web/routes` adds them all. A page renders in
  the shell of `registry/web/layout`, from pieces pages share under
  `web/partials/`: `common` (`chip`, `count`, `each`, `when`), `person`,
  `packages` and `members`. A piece a second page needs moves to a
  partial. Templates use `zena:http`'s `html` tag, which escapes every
  value. Quote attribute values (`href="${x}"`). A value must be a
  `String`, an `html` result, `unsafeHTML`, null, or an iterable of those:
  format numbers yourself, and use `each` and `when`. An array of `html`
  results must be typed `Array<TemplateValue>`: arrays are invariant.
- Pages read the App View in-process (`AppView`), never through its XRPC
  routes. Data a page needs that the App View does not give yet is a method on
  `AppView`, tested in `app-view_test.zena`, which also renders the pages.
- Who is signed in is `PageContext.who` (`registry/web/session`), from a cookie
  the App View sets in `createWebSession`; pages never see OAuth. The browser
  half is `src/auth.ts`, which `src/main.ts` imports dynamically, so the
  OAuth library loads only to sign in, sign out or renew. The OAuth
  library's README does not match its types in places; read
  `node_modules/@atproto/oauth-client*` declarations. A real sign-in needs
  a real atproto account, so no test covers the OAuth half: try it in the
  demo (README, "Signing in").
- What a page shows of private members goes through
  `AppView.getEntries` as the person signed in (`visibleEntries` in
  `registry/web/partials/members`), never around it, so the App View's rules decide. The
  App View's admins (`APP_VIEW_ADMIN_DIDS`, `PageContext.isAdmin`) are ordinary
  signed-in accounts the App View answers more for.
- Show a person with `personLink` or `avatar` (`registry/web/partials/person`), from the
  `Person`s `PageContext.people` reads (`registry/web/people`); read the DIDs a
  page names together, with `People.each`. Never put a URL from someone's
  DID document or profile in a page: avatars go through the signed
  `/people/<did>/avatar`. A link someone chose, such as a package's
  homepage, goes through `externalLink` (`registry/web/partials/common`), which
  renders only `http:` and `https:` URLs: escaping keeps a value in its
  attribute, but a `javascript:` URL would still run on the App View's origin.
- Every page is served with a content security policy
  (`registry/service`'s `PAGE_POLICY`) that runs scripts only from
  `/assets/`: no inline `<script>` and no `on…` attributes. Script goes in
  `src/` and loads from `/assets/`, as `src/theme.js` does.
- Prefer plain links and GET forms to script. Use a Radica element only for
  what must happen in the browser, and import it in `src/main.ts`; its
  looks come with it. Server-rendered markup is styled in `src/app.css`,
  over Radica's tokens through the aliases at its top, so it follows the
  dark theme.
- Radica's consumer API reference is `docs/radica-skill.md` in its
  repository (https://github.com/elematic/radica).
- Check a change in the browser: `npm run demo -w @zena-lang/registry`, publish
  a package to it as it prints, and open the page.
