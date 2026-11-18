## registry

### Added

- `zena`'s OAuth client metadata at `/oauth/cli-client-metadata.json`, and the page `zena pkg login`'s sign-in comes back to, `/oauth/cli-callback`, which hands the answer to the `zena` that asked or shows it to paste.
- `describeRegistry` names the registry's site (`site`).

## package-manager

### Added

- `package-manager/cli-client`: `zena`'s OAuth client at a registry, its scope, its metadata, and the `state` that names the port the callback page hands the answer to.
