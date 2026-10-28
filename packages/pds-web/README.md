# The PDS's web assets

The stylesheet and script of the package host's web pages. The pages
themselves are rendered on the server, by the PDS written in Zena
(`packages/pds/zena/web`), as `zena:http` routes using its `html` tag:

- `/`: every package, with a search form (`?q=`), and every scope;
- `/scopes/<name>`: a scope's packages;
- `/packages/<handle>`: a package's profile, the command that adds it, its
  versions with their dependencies and retractions, and its maintainers.

Each is a plain page: links and forms, no client-side routing. This
package builds what they load from `/assets/`:

- `app.css`: [Radica](https://github.com/elematic/radica)'s design tokens
  (`@radica/base`: palette, colors, surfaces, type, sizes and the dark
  theme) and the pages' own styles over them. Radica's components keep
  their looks in their shadow roots, so server-rendered markup is styled
  here, from the same tokens.
- `app.js`: the Radica elements the pages use for what must happen in the
  browser, which today is only the theme select. A page applies the saved
  theme from an inline script in its `<head>`, before it paints.

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
