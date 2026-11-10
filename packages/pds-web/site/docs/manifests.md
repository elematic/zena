---
title: Defining a Package
---

A package is defined by the `zena-package.json` manifest at its root: its name, the metadata a registry shows, the libraries it exports, and its dependencies. To publish one, see [Publishing Packages](/docs/publishing/).

## Example `zena-package.json`

```json [zena-package.json]
{
  "name": "router",
  "did": "did:plc:routerrouterrouterrouter",
  "scope": "acme",
  "version": "1.4.2",
  "description": "HTTP router for WebAssembly services",
  "license": "MIT",
  "exports": {
    "server": {},
    "middleware": {"path": "middleware/index.zena"},
    "transport": {
      "virtual": {
        "component": "transport/wasi.zena",
        "js": "transport/fetch.zena"
      }
    }
  },
  "dependencies": {
    "url": {"did": "did:plc:urlurlurlurlurlurlurlurl", "version": "1.1.0"},
    "internal-utils": {"path": "../internal-utils"}
  }
}
```

## Field reference

| Field          | Type                         | Where          | Description                                                                                          |
| -------------- | ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `name`         | `string`                     | Any package    | The package's name (a single lowercase DNS label), suggested as the default local name to dependents |
| `did`          | `string`                     | Any package    | The package's AT Protocol DID, written by `zena pkg publish` or `zena pkg create`                    |
| `scope`        | `string`                     | Any package    | The scope on the registry where the package is created (e.g., `acme`)                                |
| `version`      | `string`                     | Any package    | Semantic version (`1.4.2`, `2.0.0-rc.1`) published by the next `zena pkg publish`                    |
| `description`  | `string`                     | Any package    | One-sentence summary of the package; required to publish                                             |
| `license`      | `string`                     | Any package    | SPDX license expression (`MIT`, `Apache-2.0`, `(MIT OR Apache-2.0)`); required to publish            |
| `source`       | `string`                     | Any package    | The directory the package's libraries are in; `src` by default                                       |
| `exports`      | `Record<string, Export>`     | Any package    | Libraries other packages may import as `<local-name>:<library>`                                      |
| `dependencies` | `Record<string, Dependency>` | Any package    | Packages imported by this package's libraries, keyed by local name                                   |
| `workspace`    | `{packages: string[]}`       | Workspace root | Directories or `/*` globs of workspace member packages                                               |
| `scopes`       | `Record<string, string>`     | Workspace root | Custom handle domains for `@scope/name` lookups                                                      |

All file and directory paths in `zena-package.json` are relative to the directory containing that manifest.

## Package names (`name`)

A package `name` must be a valid lowercase DNS label:

- Lowercase ASCII letters (`a-z`), digits (`0-9`), and hyphens (`-`).
- Must start with a letter and must not end with `-`.
- Must not have `--` as its third and fourth characters (reserved for punycode prefixes).
- At most 63 characters.
- `zena` is reserved for the Zena standard library.

## Where the libraries are (`source`)

A package's libraries are in its `src` directory, and the manifest, README and license sit at its root:

```
router/
  zena-package.json
  README.md
  src/
    server.zena          # router:server
    middleware/
      index.zena         # router:middleware/index
  test/
    server_test.zena
```

A library's name is its path from `src`, without `.zena`. Set `source` to keep them elsewhere, such as `"source": "."` for libraries at the package's root.

## Exporting libraries (`exports`)

Each key under `exports` declares a library that dependents can import as `<package>:<library>`. Entry files are relative to the `source` directory.

```json
{
  "exports": {
    "array": {},
    "url": {"path": "url/index.zena"},
    "console": {
      "virtual": {
        "js": "console/host.zena",
        "component": "console/component.zena",
        "zena-cli": "console/cli.zena"
      }
    }
  }
}
```

- **`{}` (empty object)**: Resolves to `<source>/<library-name>.zena`, such as `src/array.zena`.
- **`{"path": "..."}`**: Resolves to the specified entry file relative to the `source` directory. Other files in the package reached via relative imports (`import {helper} from './internal.zena'`) remain private and cannot be imported directly by dependents.
- **`{"virtual": {...}}`**: Maps compilation targets (`js`, `component`, `zena-cli`, `freestanding`) to target-specific entry files. When compiling with `--target component`, an import of `pkg:console` resolves to `console/component.zena`.

### Open vs. closed packages

- **With `exports` (closed)**: Only the libraries listed in `exports` can be imported by other packages.
- **Without `exports` (open)**: Every `.zena` file under the `source` directory can be imported by its path from there (without `.zena`). Open packages are convenient for small internal workspace packages; published packages should declare `exports`.

## Dependencies (`dependencies`)

Each key in `dependencies` is the **local name** used by imports inside this package. A dependency entry takes one of three forms:

### 1. Published package (`did` + `version`)

```json
"router": {
  "did": "did:plc:routerrouterrouterrouter",
  "version": "1.4.2"
}
```

Written automatically by `zena pkg add`. Names a published package by its DID and the minimum version this package requires.

### 2. Path dependency (`path`)

```json
"shared": {
  "path": "../shared"
}
```

Points to another package directory on disk containing a `zena-package.json`. Used for sibling packages in a workspace or local checkout testing. When a workspace package is published with `zena pkg publish`, its path dependencies are automatically converted into `{did, version}` entries in the published release record.

### 3. WIT dependency (`wit`)

```json
"wasi-http": {
  "wit": "./wit/http"
}
```

Synthesizes Zena interface declarations from a `.wit` file or directory for WebAssembly Component Model bindings. Because WIT paths refer to local disk, a published package cannot have a raw `wit` dependency; publish the WIT bindings as a Zena package instead.

## Custom scope domains (`scopes`)

By default, `zena pkg add @scope/name` resolves `<name>.<scope>.pkg.zena-lang.dev` (or the registry in `ZENA_REGISTRY`). If an organization hosts packages under its own domain, map the scope in the workspace root's `zena-package.json`:

```json
{
  "scopes": {
    "@widgets": "pkg.widgets.example.com"
  }
}
```

With that mapping, `zena pkg add @widgets/button` resolves `button.pkg.widgets.example.com`.
