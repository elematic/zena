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
  no changes: compiler, zena-runtime

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
change files, then the entries of the toolchain's packages, then those of
the other packages released with it. Edit that file in the release's
pull request. The release workflow publishes it as the GitHub Release's
text.

A preview release writes the manifests and the release notes, and leaves
the changelogs and the change files alone.

`notes` writes the release notes alone, for a release at a version the
manifests already state:

```sh
npm run changes -- notes toolchain --as 0.0.1-preview.1
```

`version` does not yet refresh `package-lock.json`, `Cargo.lock` or
`packages/cli/zena/versions.zena`, or change dependents' ranges, and
the notes have no links to pull requests. The command that writes a
change file (`add`) is not built yet.
