# Change Files and Releases (For AI Agents)

`packages/changes` is the tool that reads the change files in `.changes/`
and works out releases from them. The design, with the terms used here
(unit, group, held unit, entry), is `docs/design/change-files.md`. Read
its "Status" section for what is built.

The package is not a unit and is not published. Its `bin/changes.zena` is
run from the repository root as `npm run changes -- <command>`.

## Layout

- `src/config.zena`: `Config.parse` reads `.changes/config.json` into
  `Unit`s and `Group`s. A unit's name is its directory under `packages/`.
  Nothing else in the package names a directory, so renaming a package is
  a change to the configuration file.
- `src/change-file.zena`: `parseChangeFile` reads one change file into
  `UnitChanges` and `Entry`s, and collects `Problem`s with line numbers.
  `checkChangeFile` adds the problems that need the configuration. An
  entry keeps its Markdown as written.
- `src/versions.zena`: `nextVersion`, the rule for the version after a
  release.
- `src/manifests.zena`: the version a unit's `zena-package.json`,
  `package.json` or `Cargo.toml` states.
- `src/plan.zena`: `planReleases` joins the three into `ReleasePlan`s,
  one for each group and independent unit with entries, and
  `formatStatus` prints them.
- `src/changelog.zena`: a release's section of a `CHANGELOG.md`, and
  where it goes in the file.
- `src/release.zena`: the rest of what `version` writes: the version
  line of each kind of manifest, the version of a preview release, and a
  change file without the units that were released.
- `bin/changes.zena`: the command. It does the reading of files; the
  libraries take text.

## Conventions

- A change file is read line by line and not with `zena-lang:markdown`.
  The format is a small subset of Markdown, and a release copies each
  entry's source text into a changelog, which a syntax tree does not
  keep.
- A problem in a change file is a `Problem` in a list, so that `check`
  reports all of them. A problem in the configuration is a thrown
  `ConfigError`, since nothing can be checked without it.
- Tests give the libraries text and never read the repository's own
  `.changes/`, whose contents change with every pull request.
