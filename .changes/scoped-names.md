## package-manager

### Changed

- A manifest's `name` gives the package's scope before its name, `"name": "acme:router"`, and `Manifest.scope` reads it from there.
- `writeDid` writes a scope it is given into `name`.

### Removed

- **Breaking:** the `scope` field of `zena-package.json`, and a workspace root's scope for its packages. Give each package's scope in its own name.

## compiler

### Changed

- A workspace package's `name` gives its scope, `"name": "zena-lang:markdown"`, and its key in the workspace is that name.

### Removed

- **Breaking:** the `scope` field of `zena-package.json`, and a workspace root's scope for its packages.

## cli

### Changed

- `zena pkg init --scope acme` writes `"name": "acme:<name>"`, and `zena pkg publish --scope` writes the scope into the name, where both wrote a `scope` field.

### Removed

- **Breaking:** `zena pkg publish` and the other `zena pkg` commands no longer take a package's scope from the workspace root's manifest.
