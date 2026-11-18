# Change files

A pull request that changes what a package's users see adds a Markdown
file here, with any short name, that holds its changelog entries. A
release moves the entries into each package's `CHANGELOG.md` and deletes
the file. The design is in
[docs/design/change-files.md](../docs/design/change-files.md).

A change file has a `##` heading for each package, named by its directory
under `packages/`, and under it the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections that
have entries: Added, Changed, Deprecated, Removed, Fixed, Security.

```md
## compiler

### Removed

- **Breaking:** `{x: y}` field renaming in destructuring patterns; use
  `{x as y}` instead.

## zena-cli

### Added

- Programs that `zena run` starts can put the terminal in raw mode and
  read keys as they are pressed.
```

An entry that breaks code or habits that worked before starts with
`**Breaking:**`. Every entry under Removed does.

Prose for the release notes goes under a `## Release notes` heading, with
a `###` heading for each topic.

`config.json` lists the packages that have changelogs and which of them
share a version. `npm run changes -- check` reads every file here and
reports what is wrong, and `npm run changes -- status` prints the entries
waiting and the versions they would give.
