# Package Manager

Status: **Proposed.** Nothing is built. The AT Protocol libraries it needs
are being added as `packages/atproto`.

This document designs Zena's package manager. Packages are published on the
AT Protocol (atproto), the protocol behind Bluesky. A package is an atproto
account. Its DID is the package's identity, its releases are records in
the account's repository, and its artifacts (source archives and prebuilt
Wasm) are blobs. Packages can be hosted on any atproto PDS.

It builds on [package-manifest.md](package-manifest.md), which defines
`zena-package.json` (what a package is) and the resolution file,
`zena-packages.json` (where each package a compilation uses is found).

## Overview

- **Identity.** Every package has its own DID, `did:plc` or `did:web`.
  Nothing is registered in a global namespace of names. A package can
  change hosts, handles and maintainers and keep its DID.
- **Local names.** A project gives each dependency a name of its own,
  used in imports (`import {Router} from 'router:server'`). A package
  suggests a name, and the importer is free to pick another.
  `zena-package.json` maps local names to DIDs and minimum versions.
- **Releases.** One record per version, keyed by the version string. A
  release lists its artifacts by content hash (a CID) and its dependencies
  by DID.
- **Artifacts.** Zena source, Wasm components and core modules. An artifact
  too large for one blob is split over several.
- **Version selection.** Minimal version selection, as in Go modules: the
  version used is the highest minimum anyone asks for. The resolution file
  records the result, with the CID of every release and artifact.
- **Immutability.** A publisher can edit their own repository, so the
  package manager makes edits ineffective. Lockfiles pin CIDs, and a
  public checksum log records the first content seen for each version.
  Clients refuse a release that disagrees with the log.
- **Verification.** Records come with signed proofs from the package's
  repository, and artifacts are addressed by hash. A client checks both,
  so a cache or proxy needs no trust.
- **Discovery and trust.** An index (an atproto AppView) collects packages
  across PDSes and serves search. atproto labelers mark packages as
  malicious, deprecated, reviewed and so on, and clients choose which
  labelers they follow.

## Background

### atproto in brief

- A **DID** names an account. `did:plc` identifiers are resolved through
  the PLC directory, and changes to them are signed by the account's
  rotation keys. `did:web` identifiers are resolved by fetching
  `https://<host>/.well-known/did.json`; atproto allows a host name only,
  no path. Either kind of DID document names the account's signing key and
  its PDS.
- A **PDS** (personal data server) hosts accounts. Each account has a
  repository: a Merkle search tree (MST) of records, keyed by collection
  and record key, with a commit signed by the account's signing key.
- A **record** is a DAG-CBOR object whose schema is named by an NSID
  (`app.bsky.feed.post`). Any PDS stores records of any collection; the
  schemas are called lexicons.
- A **blob** is a file uploaded to the account and referenced from a
  record by its CID. A CID here is a SHA-256 hash with a short prefix. A
  PDS deletes blobs that no record references.
- `com.atproto.sync.getRecord` returns a record together with the commit
  and the MST nodes on the path to it. With the account's public signing
  key, from its DID document, anyone can check that the record is in the
  signed repository.
- A **handle** is a domain name an account claims (`alice.example.com`),
  verified both ways between DNS or HTTPS and the DID document. Handles
  can change. DIDs do not.
- An account can **migrate** to another PDS and keep its DID.
- **Relays** collect repository changes from many PDSes. An **AppView**
  indexes them for an application. A **labeler** publishes signed labels
  on accounts and records, and clients choose which labelers to apply.

### Prior art

- **Go modules.** A module proxy protocol whose responses clients verify
  against `sum.golang.org`, a transparency log of module hashes. That
  log's lookup adds a version it has not seen, so the first fetch fixes
  the content. Go also has minimal version selection, and the
  `GOPRIVATE`/`GONOSUMDB` opt-outs.
- **FAIR** (Federated And Independent Repositories), the WordPress package
  manager of the Linux Foundation. It gives every package a `did:plc`, and
  it has aggregators for discovery and labelers adapted from Bluesky's
  moderation. Packages are served by FAIR's own repository protocol, not
  by atproto. [Andrew Nesbitt's March 2026 review][nesbitt] makes two
  points that matter here: FAIR had to run central discovery and trust
  services before anyone could use it, and `did:plc` made the PLC
  directory a single point of failure for identity.
- **warg**, the Bytecode Alliance's registry protocol for Wasm, kept a
  transparency log per package. Its repository is archived, with its last
  commit in July 2025. `wasm-pkg-tools` publishes components to OCI
  registries.
- **pds.js** hosts npm packages in a PDS (`packages/npm` in
  <https://tangled.org/chadtmiller.com/pds.js>): one record per package and
  tarballs as blobs. A package moves with its account.

[nesbitt]: https://nesbitt.io/2026/03/14/whats-going-on-with-fair-package-manager

## Package identity

A package is an atproto account, and the account's DID is the package's
identity. Imports, dependency lists and resolution files all name
packages by DID.

### Creating a package

`zena package create` creates an account on a PDS with
`com.atproto.server.createAccount`. For a `did:plc` package it passes a
rotation key the maintainers hold as `recoveryKey`. The PDS puts that key
in the DID's rotation keys, ahead of its own, so the maintainers can move
the package to another PDS without the first one's help. PLC allows up to
five rotation keys, so several maintainers can each hold one.

A `did:web` package is controlled by whoever controls the domain's
`/.well-known/did.json`. It cannot move to another domain, but it can
change PDS by editing that file.

### Handles

A package may have a handle, such as `router.pkg.example.com`. Handles
are for people: the index shows them, and `zena add router.pkg.example.com`
resolves the handle to a DID once and records the DID. A handle that later
points elsewhere does not change any project.

### Maintainers

atproto has no way for several accounts to write to one repository.
Publishing therefore uses the package account's own credentials, an app
password or an OAuth session. A team shares those credentials as a CI
secret. A PDS could also let an organization's members act as the
organization's package accounts; nothing in the package format depends on
that.

## Records

The record schemas are named under `dev.zena-lang.package`, after the
project's domain, `zena-lang.dev`. They are published as lexicons at
that domain.

### Profile

One per package, at record key `self`:

```json
{
  "$type": "dev.zena-lang.package.profile",
  "name": "router",
  "description": "Routing for zena:http servers",
  "license": "MIT",
  "homepage": "https://example.com/router",
  "source": "https://github.com/example/router"
}
```

`name` is the local name the package suggests.

### Release

One per version, at record key equal to the version:

```json
{
  "$type": "dev.zena-lang.package.release",
  "version": "1.4.2",
  "createdAt": "2026-10-21T00:00:00.000Z",
  "artifacts": [
    {
      "kind": "source",
      "blob": {
        "$type": "blob",
        "ref": {"$link": "bafkrei..."},
        "mimeType": "application/vnd.ipld.car",
        "size": 48211
      }
    },
    {
      "kind": "component",
      "world": "wasi:http/proxy@0.3.0",
      "blob": {
        "$type": "blob",
        "ref": {"$link": "bafkrei..."},
        "mimeType": "application/wasm",
        "size": 1840233
      },
      "wit": {
        "$type": "blob",
        "ref": {"$link": "bafkrei..."},
        "mimeType": "text/plain",
        "size": 2210
      }
    }
  ],
  "dependencies": [
    {
      "did": "did:web:json.example.com",
      "version": "2.1.0",
      "name": "json"
    }
  ]
}
```

A version is a semantic version without build metadata, because `+` is not
allowed in a record key. Pre-release versions (`2.0.0-rc.1`) are allowed.
The `version` field repeats the record key, and a client rejects a release
where the two differ. The reference PDS refuses `com.atproto.repo.createRecord` at a key that
already holds a record, so publishing a version twice fails instead of
overwriting it. Each dependency names a DID, the minimum version the
release needs, and the local name it uses for that package in its own
imports.

### Yank

A yanked version stays available. `zena add` and `zena update` skip it
when they pick the newest version, and a build whose dependencies require
it still uses it, with a warning. Yanking writes a record:

```json
{
  "$type": "dev.zena-lang.package.yank",
  "version": "1.4.1",
  "reason": "Routes with a trailing slash matched the wrong handler"
}
```

at record key `1.4.1`. Deleting the release record instead would leave
existing lockfiles depending on caches (see
[Immutability](#immutability)).

## Artifacts

A release has one or more artifacts, each with a `kind`:

- **`source`**: Zena source, compiled with the program that uses it. This
  is what libraries publish. Zena compiles a whole program at once, so a
  library is distributed as source.
- **`component`**: a Wasm component, with the WIT world it targets and its
  WIT text as a separate small blob. Tools can read a component's
  interface without downloading the binary.
- **`core-module`**: a core Wasm module.

Prebuilt components are for programs, extensions and tools that are run
as they are. Over time, the registry is meant to become a better way to
distribute Wasm components than OCI registries.

### Source archives

A source artifact is a CAR file, the archive format atproto uses for
repositories. Its root block is a DAG-CBOR map from file path to the CID
of the file's contents, and each file is a raw block:

```json
{
  "$type": "dev.zena-lang.package.tree",
  "files": {
    "zena-package.json": {"$link": "bafkrei..."},
    "server.zena": {"$link": "bafkrei..."},
    "router/match.zena": {"$link": "bafkrei..."}
  }
}
```

The format uses only what Zena's atproto support needs anyway, CAR and
DAG-CBOR. It needs no compression library, which Zena does not have yet.
Each file has its own CID, so the cache stores a file shared by two
versions once.

### Large artifacts

The reference PDS accepts blobs up to 5 MB unless configured otherwise. An
artifact larger than a PDS accepts is uploaded in parts. Its entry lists
the parts in order, with the size and CID of the whole:

```json
{
  "kind": "component",
  "world": "wasi:http/proxy@0.3.0",
  "parts": [
    {
      "$type": "blob",
      "ref": {"$link": "bafkrei..."},
      "mimeType": "application/octet-stream",
      "size": 4194304
    },
    {
      "$type": "blob",
      "ref": {"$link": "bafkrei..."},
      "mimeType": "application/octet-stream",
      "size": 1022117
    }
  ],
  "size": 5216421,
  "cid": "bafkrei..."
}
```

The client checks each part and then the whole. Listing the parts in the
record keeps the PDS from deleting them as unreferenced.

## Dependencies and resolution

### Declaring dependencies

`zena-package.json` gains a `dependencies` map from local name to DID and
minimum version:

```json
{
  "dependencies": {
    "router": {"did": "did:plc:routerrouterrouterrouter", "version": "1.4.2"},
    "json": {"did": "did:web:json.example.com", "version": "2.0.1"}
  },
  "exports": {"server": {}}
}
```

`zena add <did-or-handle>` adds an entry, with the name the package's
profile suggests unless one is given.

### Version selection

The package manager uses minimal version selection: for each package, it
selects the highest of the minimum versions that the project and its
dependencies require. Suppose the project needs `router` 1.4.2 and `json`
2.0.1, and `router` 1.4.2 needs `json` 2.1.0. Then `json` 2.1.0 is
selected, even if 2.3.0 exists. Nothing newer than someone asked for is
used until someone asks, by running `zena update`.

A program contains at most one version of a package per major version.
Zena compiles a whole program, so two versions of one package would be two
copies of every type in it, and a value from one would not be accepted
where the other's type is expected. Different major versions of a package
are selected separately and coexist as two packages, because a new major
version is the publisher's statement that it is incompatible with the old
one.

Minimal version selection needs no constraint solver. It gives the same
answer on any machine without a lockfile, because it depends only on the
releases the dependency graph names.

### The resolution file

The resolution file records the selection, and every CID needed to
reproduce it:

```json
{
  "packages": {
    "app": "./src"
  },
  "dependencies": {
    "router": "did:plc:routerrouterrouterrouter@1"
  },
  "resolved": {
    "did:plc:routerrouterrouterrouter@1": {
      "version": "1.4.2",
      "release": "bafyrei...",
      "source": "bafkrei...",
      "dependencies": {"json": "did:web:json.example.com@2"}
    },
    "did:web:json.example.com@2": {
      "version": "2.1.0",
      "release": "bafyrei...",
      "source": "bafkrei..."
    }
  }
}
```

- `packages` keeps today's form: local packages by path.
- `dependencies` maps the project's local names to a package and major
  version.
- `resolved` holds one entry per package and major version: the selected
  version, the CID of its release record and of its source artifact, and
  how its own local names resolve. This takes the place of the scopes
  that [package-manifest.md](package-manifest.md#future-scopes) left for
  later.

The compiler reads the entries and finds each package's files in the
cache by its source artifact's CID.

## Fetching and verification

To fetch a release, the client:

1. Resolves the DID to its document. A `did:plc` document comes from the
   PLC directory, and the client can check it against the directory's
   signed log of operations. A `did:web` document comes over HTTPS. The
   document gives the PDS's URL and the repository's signing key.
2. Calls `com.atproto.sync.getRecord` for the release on the PDS. The
   response is a CAR file with the commit, the MST nodes on the path to the
   record, and the record. The client checks the commit's signature
   against the signing key and the path from the commit to the record.
3. Checks the release against the checksum log (see below).
4. Downloads each artifact it needs with `com.atproto.sync.getBlob` and
   checks it against its CID.
5. Stores everything in the local cache.

## Immutability

A publisher controls their repository and can edit or delete a release
record, or move the package to a PDS that permits anything. The package
manager cannot prevent such an edit. It makes the edit visible, and keeps
it from reaching anyone who has used the release or checked it against the
log. There are four layers.

### Lockfiles

The resolution file pins the CID of each release record and artifact. A
build from an existing resolution file gets those bytes or fails.

### The checksum log

A new resolution has no pins to check against. For that, the Zena project
runs a checksum log: a public, append-only record of each release's
content, entries of the form

```
did:plc:routerrouterrouterrouter 1.4.2 release=bafyrei... source=bafkrei... component=bafkrei...
```

- **Recording a release.** Asked about a version it has not recorded, the
  log fetches and verifies the release from the package's PDS and appends
  it. Whatever the release held at that first lookup is what the log
  keeps. `zena publish` looks up the new version, so the log records the
  content its publisher just uploaded.
- **Checking a release.** For every release not already pinned, the client
  looks it up and compares the CIDs with the ones it fetched. A
  difference is an error that names the logged and the fetched CIDs.
- **Checking the log.** The log could otherwise be rewritten by whoever
  runs it. It is a transparency log, a Merkle tree over all entries with a signed head, in the [C2SP
  tlog-tiles](https://c2sp.org/tlog-tiles) format, which descends from
  Go's checksum database. A client keeps the latest head it has seen and
  checks that each newer one extends it. Independent witnesses can
  cosign heads later ([C2SP tlog-witness](https://c2sp.org/tlog-witness)).
  Tiles are static files, so any web server or CDN can mirror the log.
- **Private packages.** A configured list of DIDs is never looked up, because the log's server cannot reach them and the lookup itself
  would reveal that they exist.

### Labels

The index watches release records. When one changes after the log
recorded it, the index's labeler labels the release's AT-URI and new CID
`release-mutated`. The index shows that label, and clients that follow the
labeler see it.

### The PDS

A PDS that knows the release schema can refuse updates and deletes of
release records. A package can move to a PDS that does not, so this only
prevents mistakes.

## Caching and proxies

The local cache lives in `$ZENA_CACHE_DIR/packages` (by default
`~/.cache/zena/packages`):

- `blobs/<cid>`: artifacts and archive parts.
- `trees/<cid>/`: unpacked source artifacts, which the compiler reads.
- `releases/<did>/<version>`: verified `getRecord` responses.
- `log/`: the latest checksum log head and the tiles fetched so far.
- DID documents, kept for a configurable time.

Every entry is either content-addressed or carries its own proof, so the
cache can be shared between projects and copied between machines, as CI
caches are.

A proxy serves the same requests as the PDS (`com.atproto.sync.getRecord`
and `com.atproto.sync.getBlob`) but for any DID, together with DID
documents and the checksum log's tiles. A client checks a proxy's
responses the same way it checks a PDS's, so a proxy is trusted for
availability and freshness and nothing else. The client takes a list of
proxies to try in order, with `direct` meaning the package's own PDS, as
Go's `GOPROXY` does:

```
ZENA_PACKAGE_PROXY=https://packages.example.com,direct
```

Self-hosted caches and mirrors are this same proxy. Most of it follows
from atproto and content addressing. What a proxy adds is answering for
every DID at one URL, where a PDS serves only its own accounts. The
Zena project's index runs a proxy that keeps every logged artifact, so a
release deleted from its PDS stays buildable for the projects that
depend on it.

## Publishing

- `zena package create` creates the account and writes the profile (see
  [Creating a package](#creating-a-package)).
- `zena publish` builds the release's artifacts and uploads them with
  `com.atproto.repo.uploadBlob`. It then writes the release record with
  `com.atproto.repo.createRecord` and looks the version up in the checksum
  log.
- `zena yank <version>` writes a yank record.

The client signs in with `com.atproto.server.createSession` and an app
password at first, and with an atproto OAuth session later.

## Discovery and trust

### The index

The index is an AppView that collects package records across PDSes. It
lists the packages with `com.atproto.sync.listReposByCollection` on a
relay, which returns every DID that has records of a collection (relays
pass this request to a separate directory service). It reads the
packages' profiles and releases from their PDSes. Later it follows the
relay's stream of changes. It serves search, version lists, reverse
dependencies and a web interface, and it feeds the checksum log. It runs
as a Zena server next to the website.

### Labelers

Labels are standard atproto labels on a package's DID or on a release's
AT-URI. Clients list the labelers they follow and what each label does,
for example blocking `malware`, warning on `deprecated`, or requiring
`reviewed`. The Zena project runs one labeler from the start, for
`release-mutated` and reports of malicious packages, and others can run
their own.

## What this needs

- **`packages/atproto`**: identifier syntax, base encodings, CIDs,
  DAG-CBOR, CAR, MST proofs, commit verification, P-256 and secp256k1
  signature verification, DID and handle resolution, and an XRPC client.
  Creating a `did:plc` package also needs signing.
- **Outgoing HTTP** with methods and headers on the `zena-cli` target,
  which `wasi:http` provides directly.
- **Package roots outside the project.** The compiler joins every
  resolution-file path onto the project root, so it cannot read packages
  from the cache directory yet.
- **The `zena` command**: `add`, `update`, `fetch`, `publish`, `yank` and
  `package create`.
- **Services**: the checksum log, the index and its proxy, and a labeler,
  all Zena servers.

## Alternatives considered

### A package as a record in its publisher's repository

A package could be identified by its publisher's DID and a record key,
`at://did:plc:alice/dev.zena-lang.package.profile/router`. Any atproto
account could publish today, with no new accounts. A package could then
never change hands, and it would share its fate with one person's
account. A DID per package keeps the package's identity separate from
anyone who maintains it.

### Enforcing immutability at the PDS

A PDS that refuses to change release records is easy to build and covers
packages hosted there. The package's owner can move it to another PDS,
and its DID and every project's dependency on it follow. A check that
holds wherever the package goes has to be made by clients.

### OCI registries

Components are published to OCI registries today. Names there belong to a
registry, and a package that moves registries gets a new name. A tag can
be moved to other content, and the registry protocol has no request for
where a tag pointed before, so detecting a moved tag is left to each
client.

### Version ranges and a solver

npm, Cargo and others accept version ranges and pick versions with a
solver, and record the result in a lockfile so builds repeat. Minimal
version selection gives repeatable answers without the solver. It also
never selects a release that nobody in the graph has asked for.

### Tar archives

A tar archive is the familiar format for source. It needs a separate
hash for integrity, and it stores every file again in every version. The
CAR format comes with Zena's atproto support, hashes each file, and lets
the cache share files across versions.

## Open questions

- **Who runs the checksum log and its witnesses.**
- **Private packages.** A package in an atproto space, the proposed
  permissioned-data extension, could be readable by an organization only.
  Spaces are an alpha with an unstable wire format.
- **Compression** of source archives, once Zena has a compression
  library.
- **Toolchain requirements.** A release may need to state the oldest Zena
  compiler that builds it.
- **The resolution file's name.** [package-manifest.md](package-manifest.md)
  notes that `zena-packages.json` is easily confused with
  `zena-package.json`.
