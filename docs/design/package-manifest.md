# Packages, Workspaces and Manifests

This document defines how Zena source is organized into packages, how a
package describes itself in `zena-package.json`, how packages developed
together form a workspace, and how the lockfile pins the published
packages a workspace uses. [package-manager.md](package-manager.md)
designs publishing and fetching packages.

> **Current status**: The compiler reads `zena-packages.json`, an older,
> hand-written file that maps package names to paths and holds the pins
> of published packages ([Current implementation](#current-implementation)).
> The manifests and lockfile described here replace it.

## Terms

- A **library** is a `.zena` file. Its imports name other libraries.
  ("Module" means a Wasm module, which the compiler produces.)
- A **package** is a directory of libraries with a `zena-package.json`
  that gives the package's name, the libraries other packages may import,
  and the packages its own libraries import. A package is what is
  published, and a published package is always exactly one package.
- A **workspace** is the directory a developer works in: one package, or
  several developed together, with one lockfile. A workspace exists only
  during development: nothing about it is published, and a
  `zena-lock.json` inside a published package has no effect.
- A **workspace package** is one of the packages in a workspace.

A single package is a workspace of one, which is the common case. Growing
it into a workspace of several means adding a `workspace` key to its
manifest and a manifest in each new package's directory, with nothing
else moved.

## `zena-package.json`

```json
{
  "name": "app",
  "did": "did:plc:appappappappappappappapp",
  "exports": {"server": {}},
  "dependencies": {
    "router": {"did": "did:plc:routerrouterrouterrouter", "version": "1.4.2"},
    "lib": {"path": "./packages/lib"}
  },
  "workspace": {"packages": ["packages/*"]},
  "scopes": {"@widgets": "widgets.alt-pkg.org"}
}
```

| Field          | Type                            | Where          | Description                                                            |
| -------------- | ------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `name`         | `string`                        | any package    | The package's own name, and the name it suggests to its dependents     |
| `did`          | `string`                        | any package    | The package's DID, once it has been created on a package host          |
| `exports`      | `Record<string, LibraryExport>` | any package    | The libraries other packages may import                                |
| `dependencies` | `Record<string, Dependency>`    | any package    | The packages this package's libraries import, by local name            |
| `workspace`    | `{packages: string[]}`          | workspace root | The directories of the workspace's other packages                      |
| `scopes`       | `Record<string, string>`        | workspace root | Domains for `@scope/name` (see package-manager.md, "Names and scopes") |

All paths are relative to the directory the manifest is in.

### `name`

A package name is one DNS label: lowercase ASCII letters, digits and `-`,
starting with a letter, not ending with `-`, without `--` as its third and
fourth characters, and at most 63 characters. `zena` is the standard
library's. The name is what a published package's profile suggests to
the packages that add it, and what a workspace's other packages call it
unless they choose another name.

### `did`

`zena publish` writes the DID when it creates the package's account (see
package-manager.md, "Creating a package"), so that later releases are
published to the same package.

### `exports`

Each key under `exports` names a library other packages may import, as
`<package>:<library>`. The value is an empty object, for the library
`<name>.zena`, or an object with a `path` or `virtual` field.

```json
{
  "exports": {
    "array": {},
    "url": {"path": "url/index.zena"},
    "console": {
      "virtual": {
        "js": "console/host.zena",
        "component": "console/component.zena"
      }
    }
  }
}
```

- **`{}`**: the library is `<root>/<name>.zena`.
- **`path`**: the library's entry file, relative to the package root. A
  library implemented in several files exposes one entry file, which
  re-exports its public API and reaches the other files with relative
  imports (`./encoding.zena`). Those files cannot be imported by name.
- **`virtual`**: a different entry file for each compilation target (`js`
  for browsers and Node.js, `component` for a WASI component, `zena-cli`
  for the `zena` command's host, `freestanding` for a core module with no
  imports). Compiling with `--target component`,
  `import { log } from 'pkg:console'` resolves to
  `<root>/console/component.zena`. A library with no entry for the target
  does not resolve there.

| Field     | Type                     | Description              |
| --------- | ------------------------ | ------------------------ |
| `path`    | `string`                 | The library's entry file |
| `virtual` | `Record<string, string>` | Target name → entry file |

Without `exports`, the package is **open**: every `.zena` file under its
root can be imported. With `exports`, it is **closed**: only the listed
libraries can. A file a closed package does not list is private to it,
reachable only through relative imports from the package's own files.

### `dependencies`

Each key is a **local name**: what this package's libraries call the
dependency in their imports (`import {Router} from 'router:server'`). A
dependency is one of two kinds:

- **A published package**, by DID and the lowest version this package
  needs: `{"did": "did:plc:...", "version": "1.4.2"}`. `zena add` writes
  these.
- **A package on disk**, by its directory: `{"path": "./packages/lib"}`.
  This is how workspace packages depend on each other, and it can also
  point outside the workspace, as to a package in a sibling checkout
  (`{"path": "../zena/packages/atproto/zena"}`), for developing against
  a package before it is published. The directory must hold a
  `zena-package.json`.
- **A WIT-backed package**, by the `.wit` file or directory that declares
  its interfaces: `{"wit": "./wit"}`. Its libraries are WIT interfaces,
  imported as `<name>:<interface>`, and the compiler synthesizes their
  declarations from the WIT (component-model.md, Part 2). A published
  package cannot depend on one, since the path is on the developer's
  disk; it would publish the WIT as a package of its own.

Local names belong to the package that chooses them. Two packages can give
the same dependency different names, or the same name to different
packages. A package sees its own dependencies' names, its own name, so
that its tests can import its libraries as a dependent would, the
standard library (`zena`), and the WIT packages the standard library
carries (`wasi`).

### `workspace`

Only the manifest at a workspace's root has `workspace`. Its `packages`
lists the directories of the workspace's other packages, as paths or as
patterns ending in `/*`, which match each directory that holds a
`zena-package.json`. The root's own directory is a workspace package too
when its manifest has a `name`. A root with only `workspace` and `scopes`
is a workspace whose packages are all in subdirectories.

Files in the workspace that belong to no package, such as scripts and
benchmarks, can import the workspace packages by their names, and
nothing else besides the standard library.

### `scopes`

Only the manifest at a workspace's root has `scopes`. It maps a scope in
`@scope/name` to the domain its handles are under, for `zena add`. See
package-manager.md, "Names and scopes".

## `zena-lock.json`

The lockfile sits beside the workspace root's manifest. `zena add` and
`zena update` write it, and no one edits it. It pins every published
package any workspace package needs, directly or through other packages,
with the versions minimal version selection chose across the whole
workspace (package-manager.md, "Version selection"):

```json
{
  "resolved": {
    "did:plc:routerrouterrouterrouter@1": {
      "version": "1.4.2",
      "release": "bafyrei...",
      "source": "bafkrei...",
      "dependencies": {"json": "did:web:json.example.com@2"}
    },
    "did:web:json.example.com@2": {
      "version": "2.1.0",
      "release": "bafyrei...",
      "source": "bafkrei..."
    }
  }
}
```

Each entry is keyed by a package's DID and major version, since a
workspace can use two major versions of one package. It records the
selected version, the CID of its release record and of its source
archive, and the names the release gives its own dependencies.

The lockfile holds no names of the workspace's own: those are in the
manifests, and a published dependency `{"did", "version"}` names the
entry `<did>@<major>`.

## How the compiler finds packages

1. It reads the `zena-package.json` in its working directory, the
   workspace root, expands `workspace.packages`, and reads each workspace
   package's manifest.
2. It reads the pins from `zena-lock.json`.
3. For an import `<name>:<library>` in a library of package P, it looks
   `<name>` up among P's dependencies:
   - a path dependency is the package in that directory, whose manifest
     the compiler reads too;
   - a published dependency is the pinned package `<did>@<major>`, found
     in the package cache, where `zena fetch` unpacks each source archive
     into `sources/<source CID>`.
4. A published package's libraries resolve names through the
   `dependencies` of its lockfile entry, which come from its release, and
   its `exports` come from the `zena-package.json` in its source archive.

The package cache is `packages` under the user's cache directory
(`$ZENA_CACHE_DIR`, `$XDG_CACHE_HOME/zena` or `~/.cache/zena`), or
`.zena/packages` in the workspace when `ZENA_PROJECT_CACHE` is set.

The compiler reports:

- a published dependency the lockfile does not pin, which `zena add` or
  `zena update` fixes;
- a pinned package that is not in the cache, which `zena fetch` fixes;
- a `source` that is not a CID string, since it becomes a directory name;
- two pinned packages with the same source archive, since the compiler
  tells packages apart by their directories;
- a path dependency to a directory with no `zena-package.json`.

Tools without a package cache, such as the browser language service, see
only the workspace's own packages.

## Publishing a workspace package

`zena publish` publishes one workspace package at a time. Its release
lists the dependencies in its manifest, with each path dependency
replaced by the depended-on package's DID and the version of it the
workspace uses, so a workspace package that others depend on is published
first. A package without a `did`, such as one only on disk, cannot be a
published package's dependency.

## The `zena` package (the standard library)

The standard library's package name is `zena`, and every package can
import it without listing it. Its manifest is built into the compiler,
generated from `packages/stdlib/stdlib-manifest.json`. Its libraries are
imported as `zena:<library>`, as in `import { HashMap } from 'zena:map'`.

## Example

```
my-app/
  zena-package.json        # name "app", workspace {packages: ["packages/*"]}
  zena-lock.json           # pins, written by zena add
  main.zena
  packages/
    lib/
      zena-package.json    # name "lib", exports, dependencies
      lib.zena
      internal/
        helpers.zena       # private: lib's exports do not list it
```

`my-app/zena-package.json`:

```json
{
  "name": "app",
  "dependencies": {
    "router": {"did": "did:plc:routerrouterrouterrouter", "version": "1.4.2"},
    "lib": {"path": "./packages/lib"}
  },
  "workspace": {"packages": ["packages/*"]}
}
```

`my-app/packages/lib/zena-package.json`:

```json
{
  "name": "lib",
  "exports": {"lib": {}},
  "dependencies": {
    "json": {"did": "did:web:json.example.com", "version": "2.0.1"}
  }
}
```

`main.zena` imports `router:server` and `lib:lib`; `lib.zena` imports
`json:parse`. Neither sees the other's names.

## Current implementation

Until the compiler reads manifests, it reads `zena-packages.json` from its
working directory:

```json
{
  "packages": {"zena-compiler": "./packages/zena-compiler/zena/lib"},
  "dependencies": {"router": "did:plc:routerrouterrouterrouter@1"},
  "resolved": {"...": "as in zena-lock.json"}
}
```

- `packages` maps a name to a package's directory, or to an object with a
  `root` and `exports`, or `{"wit": path}` for a WIT-backed package. Every
  file outside a pinned package sees all of these names.
- `dependencies` maps names to pinned packages, for the same files.
- A relative path may leave the workspace, as for a sibling checkout:
  `"google-cloud": "../zena/packages/google-cloud/zena"`. `zena-cli` gives
  the compiler the workspace's absolute path
  (`CompileFileOptions.projectRoot`), so such a path is read by its
  absolute path. Path dependencies keep this.

Moving to manifests means giving every package in this repository a
`zena-package.json` with its name and its path dependencies, and adding
a root `zena-package.json` whose `workspace` lists them.
