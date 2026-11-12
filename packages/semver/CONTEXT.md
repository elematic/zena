# Semantic Versions and Ranges (For AI Agents)

`packages/semver` is the package `zena-lang:semver`: semantic versions and
npm's version ranges. The package manager selects versions with it
(docs/design/package-manager.md, "Version ranges").

## Layout

- `src/version.zena`: `Version` (parsing, printing, precedence,
  `compatibleLine`, the major version or before 1.0 the first number
  that is not zero) and `VersionError`. Build metadata is kept but does not count in
  `compareTo`. The package manager refuses build metadata in a
  package's version itself, since a release's version is its record key.
- `src/range.zena`: `Range`, read into comparator sets as node-semver
  reads them (`^1.4.2` is `>=1.4.2 <2.0.0-0`), `includes` with npm's
  pre-release rule, `highest` and `lowest` of a list, and `intervals`,
  each set as a pair of bounds.
- `src/main.zena`: the main library, which re-exports both.

## Matching node-semver

The desugaring of `~`, `^`, x-ranges, hyphen ranges and comparators with
partial versions follows node-semver's `range.js`, with
`includePrerelease` off: an upper bound gets `-0`, so `^1.2.3` excludes
`2.0.0-rc.1`. When behaviour differs from node-semver, it is a bug here.
`test/range_test.zena` holds cases from node-semver's tests; add a case
there before changing a rule.

Not supported: node-semver's loose mode, and dist-tags or URLs, which
are not ranges in Zena manifests.
