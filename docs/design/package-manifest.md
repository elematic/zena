# Package Manifests

Zena has two manifest files that serve distinct purposes:

1. **`zena-package.json`** — self-describes a single package: its exports and
   (eventually) its dependencies by name. All paths are relative to the
   package's own root and point to its own files. A package does not know
   where its dependencies are physically located.

2. **Resolution file** (currently `zena-packages.json`, name TBD) — maps
   package names to physical locations for a compilation unit. Lives at the
   project root. Analogous to a combination of npm's `package-lock.json` and
   an import map: it pins all packages for a compilation and maps names to
   locations. Will eventually need scopes (like import maps) to handle
   transitive dependencies that may resolve differently for different packages.

The key distinction: `zena-package.json` is about **identity** (what a package
is and what it exposes), while the resolution file is about **location** (where
packages live on disk, the network, or in memory).

> **Current status**: The resolution file, including published packages
> pinned in it, and stdlib's `zena-package.json` are implemented. Declaring
> dependencies in `zena-package.json` is future work.

---

## `zena-package.json` (Package Manifest)

Lives inside a package's root directory. Describes the package's public API and
internal structure. All paths are relative to the package root.

### Format

```json
{
  "exports": {
    "array": {},
    "string": {},
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

### Schema

| Field     | Type                           | Required | Description                             |
| --------- | ------------------------------ | -------- | --------------------------------------- |
| `exports` | `Record<string, ModuleExport>` | no       | Modules importable by external packages |

If no `zena-package.json` exists (or `exports` is absent), the package is
**open** — all `.zena` files under the root are importable. If `exports` is
present, the package is **closed** — only listed modules are importable.
Files not listed in `exports` are private to the package: they are reachable
only via relative imports from the package's own files. There is no separate
`internal` mechanism.

### Module Export

Each key under `exports` is a module name (without `.zena` extension). The
value is an empty object (regular module) or an object with a `path` or
`virtual` field.

#### Regular Module

An empty object `{}` means the module is a normal source file at
`<root>/<name>.zena`.

```json
"utils": {}
```

#### Explicit Entry File

A `path` field names the module's entry file, relative to the package root.
This is how a directory-based library exposes one public module implemented
as multiple files:

```json
"url": { "path": "url/index.zena" }
```

The entry file re-exports the public API and reaches its sibling
implementation files via relative imports (`./encoding.zena`). Those files
are not importable by name.

#### Virtual Module

A virtual module resolves to different entry files depending on the
compilation target (`js` for browser/Node.js, `component` for a WASI
component, `zena-cli` for the zena command's host, `freestanding` for a
core module with no imports).

| Field     | Type                     | Required | Description                                                  |
| --------- | ------------------------ | -------- | ------------------------------------------------------------ |
| `virtual` | `Record<string, string>` | yes      | Map of target name → entry file path (package-root-relative) |

```json
"console": { "virtual": { "js": "console/js.zena", "component": "console/component.zena" } }
```

When compiling with `--target component`, `import { log } from 'pkg:console'`
resolves to `<root>/console/component.zena`. With `--target js`, it resolves
to `<root>/console/js.zena`. The keys are target names (`js`, `zena-cli`,
`freestanding`, `component`), and a module with no entry for the current
target does not resolve.

### Package-Private Files

There is no `internal` list. Files not named in `exports` (directly or via a
`path`/`virtual` entry file) are private to the package: they can only be
reached through relative imports from the package's own files. In the stdlib,
such files get path-shaped canonical ids (`zena:console/interface.zena`)
while manifest modules keep name ids (`zena:string`).

### Future: Dependencies

Eventually, `zena-package.json` will declare dependencies by name (not path):

```json
{
  "dependencies": {
    "zena": "^1.0.0"
  },
  "exports": { ... }
}
```

A package never knows where its dependencies are located — that's the resolution
file's job. This is not yet implemented. [package-manager.md](package-manager.md)
proposes declaring each dependency by DID and minimum version.

---

## Resolution File (currently `zena-packages.json`)

Lives at the project root. Maps package names to physical locations for a
specific compilation unit. The compiler uses this to resolve `pkg:module` import
specifiers to file paths.

> **Naming**: `zena-packages.json` is confusingly close to `zena-package.json`.
> A future rename is likely (e.g., `zena-lock.json`, `zena-resolve.json`).

### Format

```json
{
  "packages": {
    "my-lib": "./packages/my-lib/zena/lib",
    "utils": "./packages/utils/zena"
  }
}
```

### Schema

| Field          | Type                            | Required | Description                                                                     |
| -------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `packages`     | `Record<string, string>`        | no       | Map of package name → path to root                                              |
| `dependencies` | `Record<string, string>`        | no       | Map of local name → published package key (`did:plc:...@1`)                     |
| `resolved`     | `Record<string, ResolvedEntry>` | no       | Published packages pinned by key; see [Published packages](#published-packages) |

Each value is a path to the package's root directory, relative to this file,
or absolute. The target directory is expected to contain `.zena` source files
and optionally a `zena-package.json`.

A relative path may leave the project: a project beside a Zena checkout can
map `"google-cloud": "../zena/packages/google-cloud/zena"`. The compiler reads
the resolution file from its working directory, the project root, and
`zena-cli` gives it the root's absolute path (`CompileFileOptions.projectRoot`),
so such an entry is read by its absolute path. Entries inside the project stay
relative, which keeps module paths and diagnostics short.

### Published packages

A project that uses packages published on atproto
([package-manager.md](package-manager.md)) names them in `dependencies` and
pins each in `resolved`, keyed by DID and major version:

```json
{
  "packages": {"app": "./src"},
  "dependencies": {"router": "did:plc:routerrouterrouterrouter@1"},
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

The compiler reads a pinned package from the package cache, where
`zena fetch` unpacks each source archive into `sources/<source CID>`. The
cache is `packages` under the user's cache directory (`$ZENA_CACHE_DIR`,
`$XDG_CACHE_HOME/zena` or `~/.cache/zena`), or `.zena/packages` in the
project when `ZENA_PROJECT_CACHE` is set. A pinned package that is not in
the cache is an error that says to run `zena fetch`.

Names resolve per package, in place of import-map scopes:

- The project's own files, and the packages listed by path, see the
  `packages` names and the `dependencies` names.
- A pinned package's files see the names in its own entry's
  `dependencies`, the standard library, and WIT-backed packages. They do
  not see the project's names, so `router` above cannot import `app`, and
  the project cannot import `json`, which only `router` names.

The compiler checks that every name maps to a pinned package, that no
`dependencies` name is also a `packages` name, and that each `source` is a
CID string, since it becomes a directory name. Two pinned packages with
the same source archive are an error, because the compiler tells packages
apart by their directories.

Tools without a package cache, such as the browser language service, see
only the packages listed by path.

---

## The `zena` Package (stdlib)

The standard library uses the package name `zena`. The compiler loads it
automatically — user code does not need to list it in the resolution file. When
loading a resolution file, entries named `"zena"` are skipped; the compiler
builds the stdlib config internally via `buildStdlibConfig()`.

The stdlib has its own `zena-package.json` (currently `stdlib-manifest.json`)
that declares its exports and internal modules.

Stdlib modules are imported with the `zena:` prefix:
`import { HashMap } from 'zena:map'`.

---

## Example

```
project/
  zena-packages.json              # resolution file
  packages/
    stdlib/
      zena/
        zena-package.json         # exports
        array.zena
        console/
          interface.zena          # private (unlisted)
          host.zena               # private (virtual target: js)
          component.zena          # private (virtual target: component)
    my-app/
      zena/
        main.zena
```

`packages/stdlib/zena/zena-package.json`:

```json
{
  "exports": {
    "array": {},
    "console": {
      "virtual": {
        "js": "console/host.zena",
        "component": "console/component.zena"
      }
    }
  }
}
```

`zena-packages.json`:

```json
{
  "packages": {
    "my-lib": "./packages/my-lib/zena"
  }
}
```
