# Language versions

## Overview

Zena changes often, and some changes break code that compiled before: a
feature is removed, a rule is tightened, a standard library function is
renamed. Once people publish packages, a change like that breaks their
packages too. A new feature breaks the other way: a package that uses it
does not compile with an older `zena`.

Whether a given release works with a given language version is yes, no,
or unknown, and it is almost always unknown: no one has compiled that
release with that compiler. Semver ranges claim to know, and they guess
wrong in both directions. A maintainer whose `zena` is a patch ahead of a
user's would hide a release that works, and a breaking change usually
breaks one thing that most packages do not use.

So this design treats unknown as yes. It records the one fact publishing
knows, the language version a release was published with, and uses it
for hints and notes, never to choose versions. The only thing that
changes which releases are chosen is a list of known breaks that the
toolchain itself carries, so the judgement about a break ships in the
same release of `zena` and the App View as the break.

## Background

- The compiler has a version, the `version` in
  `packages/zena-compiler/zena-package.json` (`0.0.1-preview.1` now).
  `npm run versions` copies it into `packages/zena-cli/zena/versions.zena`,
  `zena --version` prints it, and every call to a registry names it in its
  `user-agent` (`zena/0.0.1-preview.1 (linux-x86_64) zena-compiler/…`).
- The packages' versions change together when the toolchain is released
  (`.github/workflows/release.yml`, `packages/zena-cli/dev/release-version.zena`),
  and each package's `CHANGELOG.md` collects changes under
  `## [Unreleased]` until then.
- A release record (`dev.zena-lang.package.release`) holds the version, the
  artifacts, the dependencies and when it was made. Listing a package's
  versions reads every release record (`listVersions`). The lockfile pins
  each selected release's record and archive CIDs, and the compiler reads
  it to find each dependency's source in the package cache.
- Version selection installs, for each package, the fewest versions its
  ranges allow, and each range uses the highest selected version in it
  (package-manager.md, "Version selection").

## The language version

The language version is the compiler's version. It covers everything a
package's source depends on that ships with `zena`: syntax, what programs
mean, the type checker's rules, and the standard library's public API,
since the standard library is built into the compiler. A separate number
for the language would differ from the compiler's only by the compiler's
bug fixes, and nothing needs the two apart while they ship together.

Readers use only the order of language versions, never their numbers'
semver meaning: a release published with 0.3.1 predates 0.4.0, and that
is all a reader concludes.

## When the version changes

The version changes when the toolchain is released, with every
package's. A language change is recorded where the release will find it:
an entry under `## [Unreleased]` in `packages/zena-compiler/CHANGELOG.md`,
in `### Removed` or `### Changed` for one that breaks code that compiled
before, and `### Added` for a new feature. A release then carries every
language change since the last one, and a breaking entry is where the
release decides whether the break goes on the list of known breaks.

The version does not follow reseeds. A reseed replaces the checked-in
compiler the build starts from (bootstrapping.md), and it happens when
the compiler's own source needs something the old compiler lacks: a fact
about the compiler's source alone. A language change usually lands before
the reseed that lets the compiler use it, and many reseeds change nothing
a user can write.

To keep a language change from landing without its entry, the pre-push
check (`scripts/check.js`) asks for one, and CI runs the same rule on each
pull request, since CI does not run the rest of the pre-push check.
AGENTS.md already has every language change update
`docs/language-reference.md`, so a commit range that changes that file or
a file under `tests/language/`, or adds or removes an `export` in
`packages/stdlib/zena/`, and adds nothing under `## [Unreleased]` in the
compiler's changelog, fails the check. A change to those files that is
not a language change, such as a fixed typo in the reference, says so with
a `Language-Version: unchanged` trailer in its commit message.

A build from `main` between releases reports the last release's version,
though its language may have changed since. A package published from such
a build records that version. Users and maintainers on released builds
are the common case, so this is accepted.

## What a release records

The release record's `zena` field, which is required, holds the language
version the release was published with: the version of the compiler that
published it, `0.3.1`. It is a fact about how the release was published,
and not a claim about which versions the release works with. It may be above any compiler a reader knows of,
since its publisher may have built a newer `zena`.

`zena pkg publish` type-checks the package, every library it would
publish, with its dependencies as the lockfile pins them, before it
uploads anything, and refuses on an error, so the version it records is
one the release is known to compile with. Publish does not run the
package's tests, which are the maintainer's CI's to run. The manifest has
no field for it.

The App View already keeps metadata about each release outside its
record, such as the clients that published and completed it
(`Publication`), and keeps more there as the need comes. The language
version goes in the record because readers who never ask the App View,
`zena pkg add` among them, need it. The App View refuses a release whose
`zena` is not a version.

## Installing

Version selection uses the packages' ranges alone. A release is chosen
whatever `zena` it was published with, so a user one patch behind its
maintainer still gets the latest release.

When `zena pkg add` or `zena pkg update` chooses a release published with
a newer language version than the running `zena`, it says so, and
installs it:

```
router 1.5.0 was published with zena 0.3.5, and this is zena 0.3.1. If it
does not compile, upgrade zena.
```

`zena pkg fetch` says the same for a pinned release.

## Known breaks

A break that breaks enough code to matter goes on a list the toolchain
carries, in code that both `zena` and the App View use: the version that
made it, what it changed, and how firmly to act on it. A made-up entry:

```zena
let KNOWN_BREAKS = [
  new KnownBreak('0.5.0', 'zena:json renamed parseJson to parse', BreakAction.Prefer),
];
```

A release predates a break when it was published with a version below the
break's, and the running compiler is at or above it. For such a release:

- With `Prefer`, selection takes the highest release in range published
  at or after the break when one exists, and otherwise the one it would
  have taken, with a warning:

  ```
  router 1.4.2 was published with zena 0.3.1, before zena 0.5.0, in which
  zena:json renamed parseJson to parse. It may not compile.
  ```

- With `Exclude`, for a break severe enough, selection skips the release
  as it skips a retracted one, and stops with that message when no
  release in range is left.

A break goes on the list in the release that makes it, so the CLI and
the App View learn of it together, and the list can change in any later
release as people find out how much the break broke.

## Compiling

`zena pkg fetch` and the commands that write the lockfile copy each pinned
release's language version from its record into its lockfile entry,
beside the CIDs it pins (`"zena": "0.3.1"`), and the compiler reads the
lockfile. When a library in a dependency has errors, the first of them
gets a note when the dependency was published with another language
version than the running compiler's, in either direction:

```
router was published with zena 0.3.5; this is zena 0.3.1.
router was published with zena 0.3.1; this is zena 0.5.0.
```

The first tells the user to upgrade `zena`, and the second where to file
an issue. A dependency published with the running version gets no note.

## Telling maintainers

When a package's latest release predates a known break, by the App
View's own compiler, its page says so to everyone:

```
router 1.4.2 was published with zena 0.3.1, before zena 0.5.0, in which
zena:json renamed parseJson to parse.
```

`zena pkg publish`, `zena pkg approve` and `zena pkg scope info` print the
same line for each package of the signed-in maintainer that is behind,
since those are the commands a maintainer runs. Otherwise, breaks are
handled as they are found: a user files an issue, and the maintainer
republishes. The App View has no way to reach a maintainer who runs none
of these commands; email, or atproto notifications, would be a channel
of its own.

## A workspace's own version

A workspace's root manifest can say which language version the workspace
is written for, `"zena": "0.3.1"`. When a known break lies between that
version and the running compiler's, every command that compiles says so
once, before anything else, and `zena` can offer to update the field once
the workspace compiles. It is the known-breaks rule applied to the code
the user owns.

## Alternatives considered

### Ranges in the record

The first version of this design recorded a semver range, `^0.3.1`, and
chose versions by it: a release needing a newer `zena` was skipped, and
one published for an older line came only with a warning. A range claims
an answer that is almost always unknown. Its lower bound is the
publisher's compiler, which maintainers do not keep at the oldest version
that works, so a user one patch behind would lose working releases. Its
upper bound breaks at every 0.x line, where most packages keep working.
Treating unknown as yes, and listing the breaks that matter in the
toolchain, gives the same protection where it is needed.

### Confirming packages for a major version

A large break, such as a Zena 2.0, could make releases count as working
only once their maintainers confirm them, as Dart did for null safety.
Republishing with the new version confirms a package already. If
maintainers should be able to vouch for an existing release, the App
View can keep that as metadata about the release, beside `Publication`,
when the need comes; the record format does not have to plan for it.

### Editions

Rust lets one compiler build code written for several editions, and each
crate names its edition. That keeps old code compiling across breaking
changes, at the cost of every change being written twice, once per
edition. Before 1.0 Zena changes too often for that: the cost would fall
on the changes the preview exists to make.

### Language versions per library

Dart gives each library a language version, from its package's SDK
constraint, and enables features by it. It has the cost of editions, at a
finer grain.

### A version at each reseed

Raising the version at each reseed needs no judgement about which changes
are breaking. But reseeds follow the compiler's own needs: a breaking
change can land weeks before one, and a reseed can change nothing users
see. The version would then say little about the language.

## Work

Each is its own change, in this order:

1. The release record's required `zena` field, the version publish ran
   with, with the App View's check, before the preview opens.
2. `zena pkg publish` type-checks the package before it uploads.
3. The hint from `zena pkg add`, `update` and `fetch` about a release
   published with a newer `zena`, and the lockfile's copy of each pin's
   version.
4. The compiler's note on a dependency published with another language
   version.
5. Known breaks: the list, selection's `Prefer` and `Exclude`, the App
   View's notice on a package's page, and the maintainer commands' list of
   packages behind.
6. The check that a language change adds a changelog entry.
7. A workspace's own version.
