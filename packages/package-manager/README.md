# The Zena package manager

The client side of Zena packages published on atproto, as designed in
[docs/design/package-manager.md](../../docs/design/package-manager.md). The
`zena` commands that fetch and publish packages are built on it.

Import its libraries as `package-manager:<library>`, from a file outside a
package in this repository's workspace or from a package that lists it in its
`zena-package.json` dependencies.

## Libraries

- `package-manager:version`: semantic versions without build metadata, and
  their precedence.
- `package-manager:records`: the profile, release, retraction and maintainers
  records, an organization's members record and the private membership
  entries it commits to, read from the atproto data model with the checks
  their lexicons describe, and written back. Also the rules for package
  names.
- `package-manager:host-methods`: the NSIDs of the package host's XRPC
  methods, which the host serves and `zena` calls. A test checks them
  against the host's lexicons.
- `package-manager:archive`: source archives, the CAR files that hold a
  release's source. Packing is deterministic, so the same files always have
  the same CID, and unpacking accepts only what packing writes.
- `package-manager:resolution`: the packages a workspace's lockfile,
  `zena-lock.json`, pins, and writing it.
- `package-manager:cache`: the package cache, where each source archive is
  unpacked into `sources/<CID>` for the compiler to read.
- `package-manager:fetch`: fetching pinned packages into the cache, which
  `zena fetch` does. The release record's proof is checked against the
  account's signing key, the record and the source archive against the
  CIDs the lockfile pins, and the release's dependencies against
  the names it maps.
- `package-manager:resolve`: minimal version selection, from the
  requirements in all of a workspace's manifests to what its lockfile pins.
- `package-manager:workspace`: a workspace's packages, read from disk: the
  root's manifest, the packages it lists, and the ones they depend on by
  path.
- `package-manager:manifest`: reading a package's `zena-package.json`, and
  rewriting its dependencies while keeping the rest of the file.
- `package-manager:registry`: finding packages: a DID, a handle or
  `@scope/name` to a DID, a package's versions and retractions, its profile, and
  its releases with their proofs.
- `package-manager:testing/fake-pds`: a PLC directory, DNS-over-HTTPS
  resolver and PDS for package accounts, served in the same program, for
  testing what finds and fetches packages. It signs what it serves, so the
  proofs clients check are real. Accounts with a password can sign in and
  get service-auth tokens.

## Lexicons

`lexicons/dev/zena-lang/` holds the lexicons, to be published at
`zena-lang.dev`:

- `package/`: a package's records: profile, releases, retractions, the
  maintainers record, and attestations, which maintainers write to their
  own repositories. `package-manager:records` reads and checks the first
  three, and their lexicons state only constraints it checks.
- `org/`: an organization's members and team records, and the private
  entries their commitments stand for.
- `host/`: the package host's methods
  ([docs/design/package-manager.md](../../docs/design/package-manager.md),
  "The host's methods").
- `authPublish.json`: the OAuth permission set `zena login` asks for:
  writing attestations and calling the host's methods.

`zena/test/lexicons_test.zena` checks that each file is named by its NSID,
that its references resolve, and that the permission set covers every host
method.

## Tests

```sh
npm test -w @zena-lang/package-manager
```
