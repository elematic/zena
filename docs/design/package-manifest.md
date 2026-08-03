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

> **Current status**: Only the resolution file and stdlib's `zena-package.json`
> are implemented. Dependency declaration in `zena-package.json` and scoped
> resolution are future work.

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
      "virtual": {"host": "console/host.zena", "wasi": "console/wasi.zena"}
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
compilation target (e.g., `host` for browser/Node.js, `wasi` for standalone
WASM).

| Field     | Type                     | Required | Description                                                  |
| --------- | ------------------------ | -------- | ------------------------------------------------------------ |
| `virtual` | `Record<string, string>` | yes      | Map of target name → entry file path (package-root-relative) |

```json
"console": { "virtual": { "host": "console/host.zena", "wasi": "console/wasi.zena" } }
```

When compiling with `--target wasi`, `import { log } from 'pkg:console'`
resolves to `<root>/console/wasi.zena`. With `--target host`, it resolves to
`<root>/console/host.zena`.

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
file's job. This is not yet implemented.

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

| Field      | Type                     | Required | Description                        |
| ---------- | ------------------------ | -------- | ---------------------------------- |
| `packages` | `Record<string, string>` | yes      | Map of package name → path to root |

Each value is a path to the package's root directory, relative to this file.
The target directory is expected to contain `.zena` source files and optionally
a `zena-package.json`.

### Future: Scopes

For transitive dependencies, the resolution file will need scoped mappings
(similar to import map scopes) so that different packages can resolve the same
dependency name to different locations:

```json
{
  "packages": {
    "my-lib": "./packages/my-lib/zena"
  },
  "scopes": {
    "./packages/my-lib/zena/": {
      "utils": "./packages/utils-v2/zena"
    }
  }
}
```

This is not yet implemented.

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
          host.zena               # private (virtual target)
          wasi.zena               # private (virtual target)
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
      "virtual": {"host": "console/host.zena", "wasi": "console/wasi.zena"}
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
