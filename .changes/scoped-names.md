## package-manager

### Added

- A manifest's `name` gives the package's scope before its name, `"name": "acme:router"`, and `Manifest.scope` reads it from there.
- `writeDid` writes a scope it is given into `name`.

## compiler

### Added

- A workspace package's `name` gives its scope, `"name": "zena-lang:markdown"`, and its key in the workspace is that name.

## cli

### Added

- `zena pkg init --scope acme` writes `"name": "acme:<name>"`, and `zena pkg publish --scope` writes the scope into the name.
