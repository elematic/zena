# The Zena package manager

The client side of Zena packages published on atproto, as designed in
[docs/design/package-manager.md](../../docs/design/package-manager.md). The
`zena` commands that fetch and publish packages are built on it.

Import its modules as `package-manager:<module>`, with a
`"package-manager": "./packages/package-manager/zena"` entry in
`zena-packages.json`.

## Modules

- `package-manager:version`: semantic versions without build metadata, and
  their precedence.
- `package-manager:records`: the profile, release and yank records, read
  from the atproto data model with the checks their lexicons describe, and
  written back. Also the rules for package names.
- `package-manager:archive`: source archives, the CAR files that hold a
  release's source. Packing is deterministic, so the same files always have
  the same CID, and unpacking accepts only what packing writes.
- `package-manager:resolution`: the packages a resolution file pins, in its
  `resolved` section.
- `package-manager:cache`: the package cache, where each source archive is
  unpacked into `sources/<CID>` for the compiler to read.
- `package-manager:fetch`: fetching a pinned package into the cache. The
  release record's proof is checked against the account's signing key, the
  record and the source archive against the CIDs the resolution file pins,
  and the release's dependencies against the names it maps.

## Lexicons

`lexicons/dev/zena-lang/package/` holds the lexicons for
`dev.zena-lang.package.profile`, `dev.zena-lang.package.release` and
`dev.zena-lang.package.yank`. They are to be published at
`zena-lang.dev`. They state only constraints that `package-manager:records`
checks.

## Tests

```sh
npm test -w @zena-lang/package-manager
```
