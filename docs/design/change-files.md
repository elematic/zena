# Change files, changelogs and release notes

## Status

Partly built, in `packages/changes`:

- Built: the configuration and the change files' format, `check` for
  what is wrong in them, `status`, and `version` for manifests,
  changelogs and change files, with `--preview` and `--as`.
- Not built: `add`; release notes, so `version` leaves a change file's
  `## Release notes` in place; dependents' ranges and `Requires:`, which
  is read and not acted on; the lockfiles and `versions.zena`, which
  `version` asks the person to refresh; the check that a pull request
  adds a change file.

No change file exists yet. Changelogs are still edited by hand under
`## [Unreleased]`, as [Background](#background) describes, and `version`
refuses to release a unit whose changelog has entries there.

## Overview

A change that users can see needs three things by the time it is
released: a line in a changelog, a new version number for each package it
touched, and sometimes a paragraph in the release notes. The person who
knows what to write is the author of the change, on the day they make
it. The versions and the documents are only needed later, when a release
is cut.

This design has each pull request add a small Markdown file, a _change
file_, that says which packages changed and how. A release reads every
change file written since the last release, works out each package's next
version, writes the changelogs and the release notes, and deletes the
change files.

The workflow follows [changesets](https://github.com/changesets/changesets).
It differs in four ways:

- Changelogs keep the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  format: Added, Changed, Deprecated, Removed, Fixed and Security sections
  under each version.
- Release notes are a second document, in the style of Node's: prose about
  the notable changes first, then the list of changes.
- One tool covers Zena packages, npm packages and Rust crates.
- A dependent package is released again only when it has to be, so that
  installs see fewer versions of it.

## Terms

- **Unit**: a directory under `packages/` that is versioned and has a
  changelog. `packages/zena-cli` is one unit, though it has a
  `zena-package.json`, a `package.json` and a `Cargo.toml`. A unit need
  not be published: `zena-cli` is a program, released as the `zena`
  binary, and its version is what `zena --version` prints.
- **Change file**: a Markdown file in `.changes/`, added by a pull
  request, that holds the changelog entries for that pull request.
- **Entry**: one bullet in a change file or a changelog.
- **Group**: a set of units that always have one version and are released
  together.
- **Independent unit**: a unit in no group. It has its own version and is
  released when it has changes.
- **Held unit**: a unit in a group that the group's releases leave out
  for now.
- **Preview release**: a release at `<next version>-preview.N`, made to
  test a release before it is final.
- **Changelog**: a unit's `CHANGELOG.md`, a list of entries under each
  version.
- **Release notes**: one document per toolchain release, with prose
  about notable changes above the entries of every unit.

## Background

The repository holds three kinds of package. A Zena package has a
`zena-package.json`, an npm package a `package.json`, and a Rust crate a
`Cargo.toml`. A manifest does not always mean a published package. Most
directories have a private `package.json` that only holds the Wireit
scripts, and `packages/zena-cli` has all three manifests while being
published as none of the three: it is a program, built and released as
the `zena` binary.

Twenty-one packages have a `CHANGELOG.md` in the Keep a Changelog format.
A pull request adds its entries under `## [Unreleased]` by hand. Two pull
requests that add an entry to one changelog conflict, and the second has
to rebase.

Versions are also written by hand. The Zena packages, the Rust crates
and the toolchain are at `0.0.1-preview.1`, in every manifest of their
directories. The only package published anywhere is
`@zena-lang/compiler` (`packages/compiler-js`), which is on npm as
`0.0.1`. That package and the other four npm packages meant for
publishing (`runtime`, `playground`, `codemirror`, `wasm-web-ui`) are at
`0.0.2-preview.1` in the repository.

The one release that exists is the toolchain's
(`.github/workflows/release.yml`). It takes its version from
`packages/zena-cli/zena-package.json`, checks it
(`packages/zena-cli/dev/release-version.zena`), and copies that version's
section of `packages/zena-cli/CHANGELOG.md` into the GitHub Release.

Language changes are recorded in the compiler's changelog, and a planned
check asks for an entry when a language change lands
([language-versions.md](language-versions.md), "When the version changes").

## Units

A unit is named by its directory: `zena-cli`, `semver`, `terminal`. These
are the names commit titles already use (`[zena-cli][terminal] ...`).

The three ecosystems name packages differently. `packages/semver` is
`semver` in the `zena-lang` scope to Zena and `@zena-lang/semver` to npm.
Naming a unit by its directory avoids choosing among them, and the tool
needs no table of names.

A unit has one version and one changelog. A release writes the version to
every manifest in the directory: `version` in `zena-package.json` and
`package.json`, and `version` under `[package]` in `Cargo.toml`. The
private `package.json` files get it too, so that a directory never states
two versions. It then
refreshes `package-lock.json` and `Cargo.lock`, and regenerates
`packages/zena-cli/zena/versions.zena`.

A configuration file, `.changes/config.json`, lists the units:

```json
{
  "groups": {
    "toolchain": {
      "versions": "patch",
      "units": ["zena-cli", "compiler", "zena-runtime", "..."],
      "held": ["compiler-js", "runtime", "playground"]
    }
  },
  "units": {
    "compiler": {
      "paths": [
        "packages/stdlib",
        "docs/language-reference.md",
        "tests/language"
      ]
    },
    "semver": {},
    "terminal": {}
  }
}
```

`paths` names files outside a unit's directory whose changes belong in
its changelog. The standard library has no changelog of its own. Its
changes are language changes, and they go in the compiler's.

A directory that the file does not list is not a unit. `website`,
`website-client`, `pds-web` and `workspace-hack` have no changelog today
and stay out.

## Change files

A change file is a piece of changelog. Its name is any short slug, such
as `.changes/raw-mode-keys.md`. It has a `##` heading for each unit and,
under that, the Keep a Changelog sections that have entries:

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

An author writes what they write today, in a new file. Each pull request
has its own file, so two pull requests do not conflict.

Each entry has a size, which [Versions](#versions) turns into a version
number:

| Entry                                       | Size     |
| ------------------------------------------- | -------- |
| Starts with `**Breaking:**`, in any section | breaking |
| In Added or Deprecated                      | feature  |
| In Changed, Removed, Fixed or Security      | fix      |

An entry in Removed almost always breaks something, and the tool refuses
one that is not marked `**Breaking:**`. The marker stays in the changelog,
where a reader looking for breaks can search for it.

A change file can also hold prose for the release notes, under the
reserved heading `## Release notes`, and a statement that a unit needs a
newer version of a dependency, as `Requires:`. [Release notes](#release-notes)
and [Dependents](#dependents) describe them.

## Changelogs

A release moves the entries into each unit's `CHANGELOG.md`, under a new
`## [<version>] - <date>` heading, with the sections in Keep a Changelog's
order. Entries from different pull requests for one section are joined,
oldest first.

The `## [Unreleased]` heading leaves the checked-in changelogs. The
`status` command prints what it would hold.

A changelog has entries only. It has no commit hashes, no pull request
links and no prose.

## Groups

Some units cannot be mixed across versions. The `zena` binary bundles the
compiler, the standard library and the tools built on the compiler's
syntax tree, and the runtime crate has to match the code the compiler
emits. These form the `toolchain` group: one version, written to all of
them, released together. Its version is the `v*` tag and the language
version (language-versions.md).

The group holds the units with a strong dependency on the compiler or on
its output:

- `compiler`, with the standard library
- `zena-cli`
- `zena-runtime`, and the hosts built on it: `zena-run`, `zenafx`
- `zena-formatter`, `zena-lint`, `zenadoc`, `language-service`, which
  read the compiler's syntax tree
- the npm packages `compiler-js` and `runtime`, which are the compiler and
  the runtime for its JavaScript target, and `playground`, which bundles
  both

When any unit in the group has an entry, the whole group gets the next
version. A unit in the group with no entries of its own gets a version
section that says so:

```md
## [0.0.3] - 2026-12-01

No changes.
```

When the unit's dependencies changed, the section reads "Updated
dependencies." in place of "No changes."

A group can hold units back. A held unit is in the group, and a release
of the group leaves it alone: its manifests keep their version, it is not
published, and its entries stay in the change files, which the release
rewrites to hold only those. When the unit is taken off the `held` list,
the next release gives it the group's version, and its changelog section
for that version has every entry since its own last release.
[First releases](#first-releases) uses this for the npm packages.

Every other unit is independent: `semver`, `terminal`, `markdown`,
`atproto`, `protobuf`, `google-cloud`, `workflow`, `wit-parser`, `zebra`,
`package-manager`, `codemirror`, `wasm-web-ui`, `vscode-zena`. An
independent unit is released when it has entries, at the version its own
entries give.

`pds` and `registry` are deployed and never published, so they have no
version (`"versioned": false` in the configuration). Each keeps its
changelog. A toolchain release moves their entries under a heading with
the date, `## 2026-12-01`.

## Versions

Every unit starts at `0.0.x` and will stay below `1.0.0` for some time.
The rules differ for the group and for independent units, because of who
depends on them.

**The toolchain group.** Every release is the next patch: `0.0.2`, then
`0.0.3`. This is `"versions": "patch"` in the configuration. The size of
the entries does not change the number. Whether a published package
works with a `zena` version is the subject of language-versions.md, which
does not use version ranges, so nothing reads the toolchain's version for
compatibility. Moving the group to `0.1.0` or `1.0.0` is a decision about
the project, and a person makes it with `version --as 0.1.0`.

**Independent units at `0.0.x`.** Every release is the next patch here
too, breaking or not. A `0.0.x` version promises its dependents nothing,
and most releases will break something. A unit leaves `0.0.x` when a
person decides it is ready, with `version --as 0.1.0`.

A dependent's range on a `0.0.x` version is written with a tilde: `~0.0.3`
matches `0.0.3` and every later `0.0.x`. The usual caret, `^0.0.3`,
matches `0.0.3` alone, so every release of the dependency would need a
release of each dependent. The tilde range admits releases that break the
dependent, which is the risk `0.0.x` states.

**Independent units from `0.1.0`.** Other packages depend on these by
range, so the version says whether a release breaks its dependents.
Below `1.0.0` that is the minor number:

| Largest entry | From `0.2.1` | From `1.4.2` |
| ------------- | ------------ | ------------ |
| breaking      | `0.3.0`      | `2.0.0`      |
| feature       | `0.2.2`      | `1.5.0`      |
| fix           | `0.2.2`      | `1.4.3`      |

Ranges are carets: `^0.2.1` matches every later `0.2.x`. A unit reaches
`1.0.0` with `version --as 1.0.0`.

### Preview releases

A release can be tried before it is final. `version --preview` works out
the next version, `0.0.3` say, and writes `0.0.3-preview.1` to the
manifests, or the next `preview.N` when the manifests already have one.
It writes the release notes file, so the release workflow has notes to
publish. It leaves the change files and the changelogs alone. The final
`version` then releases `0.0.3` with every entry, and the changelogs have
no sections for the previews.

The VS Code marketplace does not accept versions with a pre-release tag,
so `vscode-zena` has no preview releases.

### First releases

The toolchain has been released once, as `0.0.1-preview.1`, and
`@zena-lang/compiler` is on npm as `0.0.1` from before that. The plan:

1. `0.0.1`, after as many preview releases as testing needs: the
   toolchain group with its npm units (`compiler-js`, `runtime`,
   `playground`) held, and the independent Zena packages. The held units
   stay at `0.0.2-preview.1`.
2. `0.0.2`: the npm units come off the `held` list. The group's version
   is then the highest among its units, `0.0.2-preview.1`, and the
   version that follows a preview is the one it previews, so the whole
   group is released as `0.0.2`.

`vscode-zena` does not wait for the second step. It bundles the npm
packages it depends on until they are released. `wasm-web-ui` depends on
the npm `runtime`, so its first release under this design follows
`0.0.2`.

The existing `## [0.0.1-preview.1]` sections in the changelogs become
part of `## [0.0.1]`.

## Dependents

Suppose `terminal` depends on `semver`, and `semver` is released. One
option is to release `terminal` again with its dependency raised to the
new `semver`. changesets does this. After a few releases, the packages a
project installs ask for `semver` at several different minimum versions.
The more of those minimums there are, the more often an install has to
hold two copies of `semver`, or cannot be solved.

This design releases a dependent for a dependency's sake in one case
only: the dependency's release has a breaking entry. The dependent's
range is rewritten to start at the new version, and its changelog gets
"Updated dependencies.". Inside the workspace the dependent is always
built against the dependency's source, so by the time of the release it
already works with the new version.

From `0.1.0` on, a breaking release is exactly a release outside the
dependent's range ([Versions](#versions)), so the dependent could not use
it otherwise. At `0.0.x` the dependent's tilde range admits the breaking
release, and the new release of the dependent is there so that its latest
version works with the latest dependency. Its older releases may be
installed with a dependency that breaks them.

A dependency's release with no breaking entry changes nothing in the
dependent.

npm needs the same rule for a different reason. npm links a workspace
package in place of the registry's copy only when the local version
satisfies the dependent's range, so the range in a dependent's
`package.json` has to follow a release that leaves it.

### The published range

For this to work, the range a dependent publishes has to be kept
somewhere. Today a workspace dependency is `{"path": "../semver"}`, and
`zena pkg publish` writes the range `^<the dependency's current version>`
(`dependenciesOf` in `packages/zena-cli/zena/pkg/publish.zena`). Every
release of a dependent therefore raises its minimum to the newest
dependency.

The manifest gains a range beside the path:

```json
"zena-lang:semver": {"path": "../semver", "version": "~0.0.1"}
```

Builds in the workspace use the path. Publishing writes the range. A
release changes the range only as this section describes.

### Raising the minimum on purpose

A dependent sometimes starts to use something new in a dependency. Then
its minimum has to rise, and only the author knows. The version it has to
rise to does not exist yet, so the author states the need in the change
file:

```md
## terminal

Requires: semver

### Added

- Version ranges in prompts.
```

At the release, `terminal`'s range on `semver` starts at the version
`semver` is released at. The tool refuses the line when `semver` has no
entries to release and `terminal`'s range already admits its current
version.

Nothing checks that a dependent still builds against the minimum it
states. A later check could build each dependent against the oldest
version its ranges admit.

### Inside a group

Units in a group depend on each other at the group's version, and each
release rewrites those ranges. They are released together in any case, so
this adds no releases.

## Release notes

Release notes are one document per toolchain release, kept in
`docs/releases/<version>.md`. The release workflow uses the file as the
body of the GitHub Release, where it now copies a section of the CLI's
changelog. The notes look like this:

```md
# Zena 0.0.3

2026-12-01

## Notable changes

### Prompts in the terminal

A program can now ask a question and read the answer key by key. ...

### Field renaming in patterns uses `as`

`{x: y}` in a pattern no longer renames a field. ...

## Toolchain

### compiler

#### Removed

- **Breaking:** `{x: y}` field renaming in destructuring patterns; use
  `{x as y}` instead. (#1201)

### zena-cli

...

## Packages

### terminal 0.0.2

#### Added

- Prompts: `confirm`, `select` and `text`. (#1239)
```

**Notable changes** is prose, written by people. It can come from two
places. A pull request can write it when it makes the change, under
`## Release notes` in its change file:

```md
## Release notes

### Prompts in the terminal

A program can now ask a question and read the answer key by key. ...
```

The release collects those sections into the notes file. The release is
itself a pull request, and its author edits the file there: orders the
items, joins two that tell one story, and adds what no one wrote at the
time. To help, `status` lists the breaking entries that no prose mentions.

**Toolchain** has the entries of each unit in the group that has any.
**Packages** has each independent unit released since the last toolchain
release, with its version.

Each entry in the notes ends with a link to its pull request. The tool
finds the commit that added the entry's change file and reads the number
from its title.

An independent unit released between toolchain releases gets its
changelog and no notes of its own. Its entries appear under Packages in
the next toolchain release's notes.

## Commands

The tool is a Zena package in the workspace, `packages/changes`, run as
`npm run changes -- <command>`. It uses `semver` for versions and
`terminal` for prompts. It reads a change file line by line: the format
is a small subset of Markdown, and a release copies each entry's source
text into a changelog, which a syntax tree does not keep.

- `add` asks which units changed, the section and the text of each entry,
  and writes a change file. Writing the file by hand is as good.
- `status` prints each unit's pending entries and the version they would
  give, the dependents that would be released, and breaking entries with
  no release notes prose.
- `check` is for the pre-push check (`scripts/check.js`) and CI. It
  refuses a malformed change file. It fails a commit range that changes
  files in a unit's directory or `paths` and adds no entry for that unit,
  unless a commit message has a `Changelog: none` trailer. This replaces
  the planned check for language changes, with `Changelog: none` in place
  of `Language-Version: unchanged`.
- `version [<group or unit>...]` makes the release: versions in the
  manifests, ranges in dependents, changelogs, the release notes file,
  lockfiles and `versions.zena`. It deletes the change files it used. Its
  output is one commit, reviewed as a pull request. With no arguments it
  releases everything that has entries. `--preview` makes a
  [preview release](#preview-releases), and `--as <version>` names the
  version in place of the one the entries give.

The tool does not publish. `release.yml` keeps building and publishing the
toolchain, and reads the version and the notes file that `version` wrote.
Publishing the independent Zena packages is `zena pkg publish`, and the
npm packages `npm publish`, for each unit whose version is not yet
published.

## Alternatives considered

### changesets itself

changesets handles npm packages only, writes its own changelog format
with commit hashes and one flat list per version, and releases every
dependent of a released package. Each of the three would need a plugin
or a fork.

### Front matter with the change size

changesets states the size of a change in front matter (`'pkg': minor`)
and has one summary for all the packages named. Here the entries for
different units are worded differently, and the section an entry is in
already says most of what the size would. Stating both lets them
disagree.

### A marker on entries for notable changes

An entry could be marked `**Notable:**` and copied to the top of the
notes. Node's notable changes are paragraphs that explain a change and
what to do about it, which a changelog bullet does not do.

### Release notes for each independent unit

Every unit could have its own notes. The independent packages are small,
and their changelogs say enough. A unit that grows can get its own notes
later.

### Releasing dependents with every dependency release

Described under [Dependents](#dependents). It raises minimum versions
with no need, and installs hold more copies of a package.

### A breaking release at `0.0.x` moves to `0.1.0`

An independent unit's first breaking release could take it to `0.1.0`,
so that carets work from the start. Nearly every early release breaks
something, and the minor number would climb while meaning little. Units
stay on `0.0.x` until a person moves them.

## Work

1. The range beside a path dependency in `zena-package.json`, and
   `zena pkg publish` writing it.
2. `packages/changes`: reading change files and the configuration,
   `status` and `check`.
3. `add`.
4. `version`, for changelogs and manifests. Move the current
   `## [Unreleased]` entries into change files, and write one version to
   the manifests in each directory.
5. Dependents' ranges and `Requires:`.
6. Release notes, and `release.yml` reading them.
7. `check` in `scripts/check.js` and CI, and the agents' instructions.
