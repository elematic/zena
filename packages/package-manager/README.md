# package-manager

Client libraries for Zena packages published on AT Protocol: package manifests (`zena-package.json`), lockfiles (`zena-lock.json`), deterministic CAR source archives, dependency resolution, and registry queries. Versions and ranges are the package `zena-lang:semver` (`packages/semver`).

## Usage

```zena
import {readManifest} from 'package-manager/manifest';
import {Range} from 'zena-lang:semver';

let manifest = readManifest('{"name": "hello", "version": "1.0.0"}');
let version = manifest.version;
let matches = version != null && Range.parse('^1.0.0').includes(version);
```

## Libraries

- `package-manager/manifest`: reading a package's `zena-package.json`, and rewriting its dependencies while keeping the rest of the file.
- `package-manager/workspace`: a workspace's packages, read from disk: the root's manifest, the packages it lists, and the ones they depend on by path.
- `package-manager/files`: which files a package publishes: its manifest's `files` patterns, or by default every file but tests, and always the manifest, README, and license, never hidden files, `node_modules`, or the lockfile.
- `package-manager/archive`: source archives, the CAR files that hold a release's source. Packing is deterministic, so the same files always have the same CID, and unpacking accepts only what packing writes.
- `package-manager/records`: the profile, release, retraction, and maintainers records, an organization's members record, and the private membership entries it commits to, read from the atproto data model with the checks their lexicons describe, and written back. Also the rules for package names.
- `package-manager/registry-methods`: the NSIDs of the App View's XRPC methods.
- `package-manager/registry`: finding packages: resolving a DID, a handle, or `scope:name` to a DID, a package's versions and retractions, its profile, and its releases with their proofs.
- `package-manager/resolve`: minimal version selection, from the requirements in all of a workspace's manifests to what its lockfile pins.
- `package-manager/resolution`: the packages a workspace's lockfile, `zena-lock.json`, pins, writing it, and what writing it changes in the pins already there (`diffPins`), including releases changed in place.
- `package-manager/cache`: the package cache, where each source archive is unpacked into `sources/<CID>` for the compiler to read.
- `package-manager/fetch`: fetching pinned packages into the cache. The release record's proof is checked against the account's signing key, the record and the source archive against the CIDs the lockfile pins, and the release's dependencies against the names it maps.
- `package-manager/validate`: checking a package directory and its manifest before publishing.
- `package-manager/testing/fake-pds`: an in-process PLC directory, DNS-over-HTTPS resolver, and PDS for package accounts, for testing code that finds and fetches packages.
