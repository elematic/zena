## package-manager

### Changed

- A manifest's `name` gives the package's scope before its name, `"name": "acme:router"`, and `Manifest.scope` reads it from there. The `scope` field is still read for a name without one, and a manifest that gives both is refused.
- `writeDid` writes a scope it is given into `name`, and removes the `scope` field.

## compiler

### Changed

- A workspace package's `name` may give its scope, `"name": "zena-lang:markdown"`, which names it as the `scope` field did. A manifest that gives both is refused.

## zena-cli

### Changed

- `zena pkg init --scope acme` writes `"name": "acme:<name>"`, and `zena pkg publish --scope` writes the scope into the name, where both wrote a `scope` field.
