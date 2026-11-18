# changes

Reads the change files in `.changes/` and works out the next release of
each package in this repository. The design is
[docs/design/change-files.md](../../docs/design/change-files.md), and
[.changes/README.md](../../.changes/README.md) says how to write a change
file.

Run it from the repository root, after `npm run build -w @zena-lang/cli`:

```sh
npm run changes -- status   # the entries waiting, and the versions they would give
npm run changes -- check    # what is wrong with .changes/, exit 1 when anything is
```

`status` prints each group and independent package that has entries:

```
toolchain 0.0.2 -> 0.0.3
  cli
    Added
      - Raw mode.
  no changes: compiler, runtime-wasmtime

terminal 0.3.1 -> 0.3.2
  Added
    - Prompts.
```

`version` makes a release, as edits to the working tree for a pull
request:

```sh
npm run changes -- version                       # everything that has entries
npm run changes -- version toolchain semver      # the named groups and independent packages
npm run changes -- version toolchain --preview   # 0.0.3-preview.1, to test the release
npm run changes -- version terminal --as 0.1.0   # a version the entries would not give
```

It writes the version to each manifest in the released directories
(`zena-package.json`, `package.json`, `Cargo.toml`), adds a section to
each `CHANGELOG.md`, and takes the released entries out of the change
files, deleting a file with nothing left. `--date 2026-12-01` sets the
date in the changelog headings and the notes, which is otherwise today's.

A release of the toolchain also writes its release notes,
`docs/releases/<version>.md`: the prose under `## Release notes` in the
change files, then every package released, each under the name people
install it by and its version (`### zena-lang:semver 0.0.3`). Edit that
file in the release's pull request. The release workflow publishes it as
the GitHub Release's text.

A preview release writes the manifests and the release notes, and leaves
the changelogs and the change files alone. Its number follows the last
preview of that version that has a Git tag (`v0.0.3-preview.1`), so
making a preview again before it is released gives its version again,
with the notes written afresh. The command runs `git tag --list` for
this.

`--as` names the version exactly, preview or not:
`version toolchain --as 0.0.3-preview.4`.

`notes` writes the release notes `version` would write with the same
arguments, and nothing else:

```sh
npm run changes -- notes             # the next release's
npm run changes -- notes --preview   # the next preview's
```

`version` also keeps the ranges right that packages here publish their
dependencies on each other with (`"version"` beside `"path"` in
`zena-package.json`), and prints each one it changes:

- Between two packages of the toolchain, the range is the new version
  exactly.
- A release with a `**Breaking:**` entry starts its dependents' ranges
  again at the new version, and releases those dependents too, with
  `Updated dependencies.` in their changelogs.
- `Requires: <package>` in a change file starts the range at the version
  that package is released at.
- Any other release leaves its dependents alone.

`version` does not yet refresh `package-lock.json`, `Cargo.lock` or
`packages/cli/zena/versions.zena`, and the notes have no links to pull
requests. The command that writes a change file (`add`) is not built yet.
