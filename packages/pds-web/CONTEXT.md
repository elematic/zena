# The PDS's web assets (For AI Agents)

`packages/pds-web` builds the stylesheet and script of the package host's
pages. The pages are rendered on the server, in Zena, in
`packages/pds/zena/web/`; read this package's README first.

- A page is a `zena:http` route (`pds:web/pages`) in the shell of
  `pds:web/layout`, built with `zena:http`'s `html` tag, which escapes every
  value. Quote attribute values (`href="${x}"`). A value must be a
  `String`, an `html` result, `unsafeHTML`, null, or an iterable of those:
  format numbers yourself, and use `layout`'s `each` and `when`.
- Pages read the host in-process (`PackageHost`), never through its XRPC
  routes. Data a page needs that the host does not give yet is a method on
  `PackageHost`, tested in `host_test.zena`, which also renders the pages.
- Who is signed in is `PageContext.who` (`pds:web/session`), from a cookie
  the host sets in `createWebSession`; pages never see OAuth. The browser
  half is `src/auth.ts`, which `src/main.ts` imports dynamically, so the
  OAuth library loads only to sign in, sign out or renew. The OAuth
  library's README does not match its types in places; read
  `node_modules/@atproto/oauth-client*` declarations. A real sign-in needs
  a real atproto account, so no test covers the OAuth half: try it in the
  demo (README, "Signing in").
- Prefer plain links and GET forms to script. Use a Radica element only for
  what must happen in the browser, and import it in `src/main.ts`; its
  looks come with it. Server-rendered markup is styled in `src/app.css`,
  over Radica's tokens through the aliases at its top, so it follows the
  dark theme.
- Radica's consumer API reference is `docs/radica-skill.md` in its
  repository (https://github.com/elematic/radica).
- Check a change in the browser: `npm run demo -w @zena-lang/pds`, publish
  a package to it as it prints, and open the page.
