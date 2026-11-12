# Language versions

## Overview

Zena changes often, and some changes break code that compiled before: a
feature is removed, a rule is tightened, a standard library function is
renamed. Once people publish packages, a change like that breaks their
packages too, and a new feature breaks the other way: a package that uses
it does not compile with an older `zena`.

This document gives the language a version, has each package say which
versions it works with, and uses that in three places:

- `zena pkg add` and `zena pkg update` choose releases that work with the
  `zena` running them, and say to upgrade `zena` when a package needs a
  newer one.
- The compiler says, when a package fails to compile, that it was
  published for another language version.
- The App View tells a package's maintainers when their latest release was
  published for a language version that `zena` has moved past.

While Zena is before 1.0 the language is expected to break at most
releases, so the design leans on semver's pre-1.0 rule, and its main job
is to keep users and maintainers moving to the current version.

## Background

- The compiler has a version, the `version` in
  `packages/zena-compiler/zena-package.json` (0.1.0 now).
  `npm run versions` copies it into `packages/zena-cli/zena/versions.zena`,
  `zena --version` prints it, and every call to a registry names it in its
  `user-agent` (`zena/0.1.0 (linux-x86_64) zena-compiler/0.1.0 …`).
- Version ranges follow npm. Before 1.0 the first number that is not zero
  is the one a breaking change raises: `^0.3.1` is `>=0.3.1 <0.4.0`, and
  `^0.0.3` is only 0.0.3. Each such line counts as a dependency of its own
  (`Version.compatibleLine`, package-manager.md, "Version ranges").
- A release record (`dev.zena-lang.package.release`) holds the version, the
  artifacts, the dependencies and when it was made. Listing a package's
  versions reads every release record (`listVersions`). The lockfile pins
  each selected release's record and archive CIDs, and the compiler reads
  it to find each dependency's source in the package cache.
- `zena pkg publish` packs and uploads a package without compiling it.

## The language version

The language version is the compiler's version. It covers everything a
package's source depends on that ships with `zena`: syntax, what programs
mean, the type checker's rules, and the standard library's public API,
since the standard library is built into the compiler. A separate number
for the language would differ from the compiler's only by the compiler's
bug fixes, and nothing needs the two apart while they ship together.

Before 1.0 the version changes as semver's pre-1.0 rule reads it, so that a
package's compatible versions are a `^` range:

| Change                                                           | Example                             | Version       |
| ---------------------------------------------------------------- | ----------------------------------- | ------------- |
| Something that compiled stops compiling, or means something else | a standard library function renamed | 0.3.x → 0.4.0 |
| Something new compiles, and everything that compiled still does  | a new operator                      | 0.3.1 → 0.3.2 |
| A compiler fix that changes no program's meaning                 | a faster pass                       | 0.3.1 → 0.3.2 |

A package written for 0.3.1, using a feature added in 0.3.1, works with
`^0.3.1`: 0.3.1 and every 0.3.x after it, and not 0.4.0.

From 1.0 the usual rule applies: the major version for a breaking change,
the minor for an addition, the patch for a fix.

## When the version changes

The version changes in the pull request that changes the language, since
that is the change users see.

It does not change at a reseed. A reseed replaces the checked-in compiler
the build starts from (bootstrapping.md), and it happens when the
compiler's own source needs something the old compiler lacks: a fact
about the compiler's source alone. A language change usually lands before
the reseed that lets the compiler use it, and many reseeds change nothing
a user can write.

To keep a change from landing without its version, the pre-push check
(`scripts/check.js`) asks for one, and CI runs the same rule on each pull
request, since CI does not run the rest of the pre-push check. AGENTS.md
already has every language change update `docs/language-reference.md`, so
a commit range that changes that file or a file under `tests/language/`,
or adds or removes an `export` in `packages/stdlib/zena/`, and leaves the
compiler's version as it was, fails the check with what to raise. A change
to those files that is not a language change, such as a fixed typo in the
reference, says so with a `Language-Version: unchanged` trailer in its
commit message.

## What a release records

Which language versions a release works with is a fact about how it was
published, so `zena pkg publish` records it, in the release record, and
the package's manifest does not need to say it. Publish type-checks the
package, every library it would publish, with its dependencies as the
lockfile pins them, before it uploads anything, and refuses on an error.
It then writes the range in a new field of the release record, `zena`:
`^` and the language version of the compiler that checked it, `^0.3.1`
for 0.3.1. Publish does not run the package's tests, which are the
maintainer's CI's to run.

A manifest may still give a range, for an author who knows the package
works with less, or across a breaking change:

```json
{"name": "router", "version": "1.4.2", "zena": "^0.3.0"}
```

Publish then records that range in place of its own, and warns when the
range does not include the language version it checked the package with,
since that range claims something no compiler has shown:
`zena-package.json says zena ^0.2.0, and this zena is 0.3.1, which is not in it`.

The App View already keeps metadata about each release outside its
record, such as the client that published it (`Publication`), and it
can keep more there as the need comes, such as the compiler version a
publisher's `user-agent` names. The `zena` range goes in the record
because readers who never ask the App View, `zena pkg add` among them,
need it.

The App View refuses a release whose `zena` is not a range, or is one no
version is in. It accepts a range that starts above its own compiler's
version, since people build `zena` from source and may be ahead of the
deployed App View.

The field is in the record format, which every release keeps, so it is
best added before the preview opens. Adding it later breaks nothing, but
releases published before it have no range, and every reader has to
treat them as unknown.

## Installing

`zena pkg add`, `zena pkg update` and `zena pkg fetch` compare each
release's range with the language version of the `zena` running them,
`v`. There are two ways a release can fail to fit.

**The release needs a newer `zena`.** Its range's lowest version is above
`v`, so it uses something `v` does not have. Selection skips it, as it
skips a retracted release, and takes the highest release in range that
fits. When none fits, the command stops:

```
router 1.5.0 needs zena ^0.4.1, and this is zena 0.4.0. Upgrade zena:
in a checkout of Zena, git pull and npm run build.
```

`zena pkg fetch`, which installs what the lockfile pins, stops the same
way for a pinned release that needs a newer `zena`, and warns for one
published for an older line, as below.

**The release was published for an older line.** `v` is above its range,
as for `^0.3.1` when `v` is 0.4.0. It may still compile, if it used
nothing the breaking change removed. Selection prefers a release that
fits; when none does, it takes the release and warns:

```
router 1.4.2 was published for zena ^0.3.1, and this is zena 0.4.0: it
may not compile. Its maintainers are told on its page.
```

A release with no range, published before ranges were recorded, counts
as fitting.

## Compiling

`zena pkg fetch` and the commands that write the lockfile copy each pinned
release's range from its record into its lockfile entry, beside the CIDs
it already pins (`"zena": "^0.3.1"`), and the compiler reads the lockfile,
so it knows each dependency's range without the release record. When a
library in a package whose range excludes the running compiler has
errors, the first of them gets a note: `router was published for zena ^0.3.1; this is zena 0.4.0`. A
package whose range fits gets no note, so the note points at the cause
only when it is a likely one.

## Telling maintainers

The App View knows each release's range, and the language version it was
built with, which is its own compiler's: the same constant `zena` reports.
When a package's latest release has a range that excludes that version,
the package's page says so to everyone:

```
router 1.4.2 was published for zena ^0.3.1, and zena is now 0.4.0.
```

`zena pkg publish`, `zena pkg approve` and `zena pkg scope info` print the
same line for each package of the signed-in maintainer that is behind,
since those are the commands a maintainer runs. The App View has no way
to reach a maintainer who runs none of them; email, or atproto
notifications, would be a channel of its own.

## A workspace's own range

A workspace's root manifest can give a `zena` range too, and so can each
of its packages, as a publishing package's can. When the running `zena`
is outside it, every command that compiles says so once, before anything
else:
`this workspace is written for zena ^0.3.1, and this is zena 0.4.0`. This
is the same check as for dependencies, applied to the code the user owns,
and is the last of the work below.

## Alternatives considered

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

### A version only at reseed

Raising the version at each reseed needs no judgement about which changes
are breaking. But reseeds follow the compiler's own needs: a breaking
change can land weeks before one, and a reseed can change nothing users
see. The version would then say little about the language.

### A range in the manifest alone

Each package's manifest could carry its range, written by its author, as
Dart's `environment.sdk` is. Then a range says what its author believed
when they last edited it, and nothing ties it to a compiler that checked
the package; on a language that breaks every few weeks it would fall
behind. Publish knows the compiler that checked the package, so it
records that, and the manifest's range is only an override, with a
warning when it leaves that compiler out.

### Refusing an older line

Selection could refuse a release published for an older line, as it does
one that needs a newer `zena`. Many such releases still compile, since a
breaking change removes one thing and most packages do not use it, and
refusing them would leave a user with nothing to install until every
maintainer republishes. The warning and the compiler's note cover the
packages that do break.

## Work

Each is its own change, in this order:

1. The release record's `zena` field, with the App View's check, before
   the preview opens.
2. `zena pkg publish` type-checks the package and records the range, or
   the manifest's, with the warning when it leaves out the publishing
   compiler.
3. Selection, `zena pkg add`, `update` and `fetch` use the range, and the
   lockfile keeps it.
4. The compiler's note on a package published for another language
   version.
5. The App View's notice on the package's page, and the maintainer
   commands' list of packages behind.
6. The pre-push check for a language change without a version change.
7. A workspace's own range.
