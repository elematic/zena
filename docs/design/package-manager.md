# Package Manager

Status: **Proposed**, and partly built: the AT Protocol libraries
(`packages/atproto`), the package records, source archives and fetching
(`packages/package-manager`), the compiler's reading of pinned packages,
and `zena fetch`.

This document designs Zena's package manager. Packages are published on the
AT Protocol (atproto), the protocol behind Bluesky. A package is an atproto
account. Its DID is the package's identity, its releases are records in
the account's repository, and its artifacts (source archives and prebuilt
Wasm) are blobs. Packages can be hosted on any atproto PDS.

It builds on [package-manifest.md](package-manifest.md), which defines
packages, workspaces, the manifest every package has
(`zena-package.json`), and the lockfile that pins a workspace's published
dependencies (`zena-lock.json`).

## Overview

- **Identity.** Every package has its own DID, `did:plc` or `did:web`.
  Nothing is registered in a global namespace of names. A package can
  change hosts, handles and maintainers and keep its DID. Handles, which
  are for finding packages, always have a scope:
  `router.acme.pkg.zena-lang.dev`, or a domain the package's maintainers
  control.
- **Local names.** A package gives each dependency a name of its own,
  used in imports (`import {Router} from 'router:server'`). A package
  suggests a name, and the importer is free to pick another.
  `zena-package.json` maps local names to DIDs and minimum versions.
- **Releases.** One record per version, keyed by the version string. A
  release lists its artifacts by content hash (a CID) and its dependencies
  by DID.
- **Artifacts.** Zena source, Wasm components and core modules. An artifact
  too large for one blob is split over several.
- **Version selection.** Minimal version selection, as in Go modules: the
  version used is the highest minimum anyone asks for. The lockfile
  records the result, with the CID of every release and artifact.
- **Immutability.** A publisher can edit their own repository, so the
  package manager makes edits ineffective. Lockfiles pin CIDs, and a
  public checksum log records the first content seen for each version.
  Clients refuse a release that disagrees with the log.
- **Verification.** Records come with signed proofs from the package's
  repository, and artifacts are addressed by hash. A client checks both,
  so a cache or proxy needs no trust.
- **Hosting and maintainers.** A package host, a PDS with an extension that
  creates package accounts on request, lets maintainers publish by signing in with their
  own atproto accounts, so no one holds a password for a package. Each
  release is attested by the package's maintainers, M of N if the package
  asks for it, and the checksum log checks the attestations. Teams and
  organizations have roles, and who belongs to them stays private until
  they act.
- **Supply-chain security.** A workspace builds the bytes it pinned, a
  release counts only with its maintainers' approval, and no new release
  reaches a workspace until someone asks for it. Packages can require a person to
  approve releases that CI publishes, and a passkey or security key for
  each approval. See [Security and supply-chain attacks](#security-and-supply-chain-attacks).
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
- **XRPC** is how atproto services are called: an HTTP `GET` (a query) or
  `POST` (a procedure) to `https://<server>/xrpc/<NSID>`. A method's
  lexicon declares its input and output. The NSID says who defines the
  method, and any server may implement it. A PDS serves the
  `com.atproto.*` methods for its own accounts. Other services are found
  through the `services` entries of their DID documents. A client can also
  send a call for another service through its own PDS, with an
  `atproto-proxy` header naming that service; the PDS forwards it with a
  service-auth token for the client's account (see
  [Creating a package](#creating-a-package)).
- **Creating an account** is `com.atproto.server.createAccount` on a PDS.
  PDSes that accept accounts from the public usually require an invite
  code or a verified email address, and apply other limits against
  spammers creating accounts in bulk.
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
identity. Manifests and lockfiles name packages by DID, and imports by a
name each depending package chooses.

How a package's account is created, where it is hosted, who holds its
keys and who may publish to it is in
[Hosting, keys and maintainers](#hosting-keys-and-maintainers).

### Names and scopes

A package has three kinds of name:

- **Its DID** is its identity. Manifests and lockfiles record it. A `did:plc` is a hash and a `did:web` belongs to a
  domain, so DIDs cannot collide, and there is no short one to take.
- **A local name** is what a package's imports use
  (`import {Router} from 'router:server'`). Each package chooses its own,
  starting from the name the package's profile suggests, so two packages
  that both suggest `router` can be used side by side.
- **A handle** is for finding a package. `zena add` resolves it to a DID
  once and records the DID, so a handle that later points elsewhere
  changes nothing that depends on the package. The index shows handles.

Only handles are scarce, and the compiler and the lockfile never see
them, so the rules below are about finding packages.

**Scopes on a package host.** A package's handle on a package host always
has a scope: `<package>.<scope>.<host domain>`, such as
`router.acme.pkg.zena-lang.dev`. A name one label below the host's
domain, `acme.pkg.zena-lang.dev`, is the handle of a scope, which is an
organization account (see
[Maintainers, teams and organizations](#maintainers-teams-and-organizations)).
A person's scope is an organization with them as its only owner. No
package has a name directly under the host's domain, so no one can take a
short name for a package. A package is created in a scope by the scope's
admins, or by a team they allow. Scope names on a host are first come,
first served, so names can be taken only as scopes, and only on that
host's domain.

**Domains as scopes.** A handle is a domain name, so any domain a
package's maintainers control can hold its handle: `router.pkg.acme.com`,
or `router.acme.com`. The maintainers publish the `_atproto` DNS records,
or delegate a subdomain to the host. No one else can take those names,
and they stay with the package when it moves to another host. An
organization with a domain should use it; a host's scopes are for those
without one.

**The `@scope/name` shorthand.** `zena add @acme/router` means
`router.acme.pkg.zena-lang.dev`: the name in the scope on the default
domain, which a user or a workspace can change. A scope on another domain
is mapped to it by name, in `zena-package.json` or the user's
configuration:

```json
{"scopes": {"@widgets": "widgets.alt-pkg.org"}}
```

`@widgets/foo` then means `foo.widgets.alt-pkg.org`, and never anything
on another domain. A full handle, as in `zena add router.acme.com`, needs
no scope. `zena add` prints the DID, handle and maintainers it resolved
before it writes anything.

The shorthand does not try several domains in turn. If it did, someone
who registered `widgets` on a domain tried before the scope's own would
take over every new `zena add @widgets/foo`, and nothing would fail to
show it. This is the dependency confusion that pip's `--extra-index-url`
allows. If several default domains are ever needed, `zena add` should
resolve a scoped name on all of them and stop with an error when more
than one answers. A scope that appears on a second domain then turns
working adds into errors, and not into adds of another package.

**Serving handles.** atproto checks a handle with a DNS TXT record at
`_atproto.<handle>` or with `https://<handle>/.well-known/atproto-did`,
and prefers DNS when the two disagree. A host's package handles are two
labels below its domain, and a wildcard TLS certificate covers one label,
so answering over HTTPS would need a certificate per scope. Let's Encrypt
issues 50 per registered domain per week. The host answers DNS instead:
its domain's zone is delegated to it, and it answers TXT queries from its
scopes' records. A scope's admins decide which DID each of its names
points to, and a handle is valid only when that DID's document names the
handle back. So a scope's names need not belong to packages hosted there,
and a package that moves to another host can keep its handle.

Renaming a package changes its handle, in the scope's records and with a
PLC operation, and not its DID, so nothing that depends on it notices. A
name freed by a rename can be given to another package by the scope's
admins. Manifests that name the first package's DID keep it.

**Names are DNS labels.** A package name, whether a local name, a
profile's suggested name or the first label of a handle, is one DNS
label: lowercase ASCII letters, digits and `-`, starting with a letter,
not ending with `-`, without `--` as its third and fourth characters,
which internationalized domain names reserve, and at most 63 characters.
`zena` names the standard library and no package. Scope names follow the
same rules, and a host reserves some, such as `www`.

## Records

The record schemas are named under `dev.zena-lang.package`, after the
Zena project's domain, `zena-lang.dev`. They are published as lexicons at
that domain. The profile, releases and yanks are below. The maintainers
record, attestations, and an organization's records are in
[Hosting, keys and maintainers](#hosting-keys-and-maintainers).

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

A package's `zena-package.json` maps each local name to a published
package's DID and the lowest version it needs, or to a package on disk by
its directory ([package-manifest.md](package-manifest.md#dependencies)):

```json
{
  "dependencies": {
    "router": {"did": "did:plc:routerrouterrouterrouter", "version": "1.4.2"},
    "json": {"did": "did:web:json.example.com", "version": "2.0.1"}
  },
  "exports": {"server": {}}
}
```

`zena add` takes a DID, a handle or `@scope/name` (see
[Names and scopes](#names-and-scopes)) and adds an entry to the manifest of
the package in the current directory, with the name the added package's
profile suggests unless one is given.

### Version selection

The package manager uses minimal version selection: for each package, it
selects the highest of the minimum versions that the workspace's
packages and their dependencies require. Suppose a workspace package
needs `router` 1.4.2 and `json` 2.0.1, and `router` 1.4.2 needs `json`
2.1.0. Then `json` 2.1.0 is
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

### The lockfile

The workspace's lockfile, `zena-lock.json`, records the selection and
every CID needed to reproduce it. `zena add` and `zena update` write it:

```json
{
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

It holds one entry per package and major version: the selected version,
the CID of its release record and of its source artifact, and how the
release's own local names resolve. The workspace's own names are in its
manifests, so the lockfile holds only pins. The compiler reads the
manifests and the pins, and finds each published package in the cache by
its source artifact's CID ([package-manifest.md](package-manifest.md#how-the-compiler-finds-packages)).

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

The lockfile pins the CID of each release record and artifact. A build
from an existing lockfile gets those bytes or fails.

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
- **Attestations.** The log records a release only when as many of the
  package's publishers and owners as its threshold have attested it, and
  records who did. It reads the maintainers from the latest maintainers
  record it has recorded for the package, and a team member's role from
  the membership entry their attestation includes. It records a change to
  a maintainers record, an organization's members or a team the same way:
  once the roles and threshold of the record before it have attested the
  change. See [Who signs what](#who-signs-what) and
  [Roles](#roles).
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
cache can be shared between workspaces and copied between machines, as CI
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
release deleted from its PDS stays buildable for the packages that
depend on it.

## Hosting, keys and maintainers

A package is an atproto account, so it lives on a PDS and someone holds
its keys. Creating each package with `com.atproto.server.createAccount`
on whatever PDS its publisher uses would give every package a password
of its own to keep and share, and most PDSes would ask for an invite code
or an email address per package. On bsky.social every package would also
be a Bluesky user.

A **package host** is a PDS with an extension: methods named
`dev.zena-lang.host.*` that create package accounts on request and let
their maintainers publish to them as themselves. Maintainers sign in with
their own atproto account, the one they use for Bluesky or any other app,
and no one has a password for a package account. The extension's methods
are XRPC methods like any other. The host serves them at its own
endpoint, and its service DID document lists them as a service,
`#zena_package_host`, so that a client can also call them through its own
PDS with `atproto-proxy`. To relays, AppViews and other PDSes, a package
host is an ordinary PDS: they read its repositories with
`com.atproto.sync.*` and never call the extension.

The Zena project runs a package host, a PDS written in Zena, at a name
still to be chosen (`pkg.zena-lang.dev` below). Anyone can run another by
implementing the extension's lexicons.

The `zena` command reads packages from any PDS, since reading needs only
`com.atproto.sync.*` and the checks in
[Fetching and verification](#fetching-and-verification). A package can
also move from a package host to any PDS that accepts it (see
[Moving to another host](#moving-to-another-host)), keeping its DID, its
releases and its dependents. Publishing to a package on an ordinary PDS,
with that account's own credentials and the maintainers' attestations,
uses the same records, but the `zena` command does not implement it. That
is left to whoever wants it. What the design guarantees is that no
package depends on the Zena project's host to stay readable or to leave.

### Keys

| Key or credential                                            | Created by                                           | Held by                                                                                                             | Controls                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A maintainer's account keys                                  | the maintainer's PDS                                 | the maintainer's PDS                                                                                                | the maintainer's repository, where their attestations are      |
| A maintainer's OAuth session: a refresh token and a DPoP key | `zena login`                                         | the `zena` command, in `$XDG_CONFIG_HOME/zena/session.json`, mode 0600, or the management interface, in the browser | acting as the maintainer toward their PDS                      |
| The package's signing key                                    | the host, when it creates the package                | the host, encrypted at rest                                                                                         | commits to the package's repository                            |
| The host's rotation key                                      | the host, once                                       | the host, in a key store apart from its database                                                                    | PLC operations for every package it hosts, ranked last         |
| Recovery keys                                                | `zena`, for the creator, or an organization's owners | up to four maintainers, in `$XDG_CONFIG_HOME/zena/recovery-key`, mode 0600, backed up                               | PLC operations, ranked above the host's rotation key           |
| Approval keys, if a maintainer adds them                     | the maintainer, as passkeys or security keys         | the maintainer's devices                                                                                            | nothing alone: they countersign that maintainer's attestations |
| CI credentials                                               | a maintainer                                         | the CI system, as a secret                                                                                          | publishing as a bot maintainer                                 |

Keys are secp256k1, the curve the reference PDS uses. A maintainer uses
the same recovery key for every package they hold one for.

There is no maintainer's own key for signing releases. In atproto an
account's signing key is held by its PDS, not by the person, and this
design does not add one.

### Creating a package

The first `zena publish` of a package creates its account, after asking.
`zena package create` does only that, for scripts.

1. **Sign in.** Once per machine, `zena login` signs the maintainer in to
   their own PDS with atproto OAuth, through the browser and a redirect to
   a port on localhost. It asks for one permission set,
   `dev.zena-lang.authPublish`, which allows writing attestation records
   and calling the package host's methods. The host's methods are `rpc`
   permissions, which cover `com.atproto.server.getServiceAuth`.
2. **A recovery key.** If the maintainer has none, `zena` generates one
   and asks them to back it up.
3. **A token for the host.** `zena` asks the maintainer's PDS for a
   service-auth token with `com.atproto.server.getServiceAuth`, addressed
   to the host's DID, for the method `dev.zena-lang.host.createPackage`.
   The token is a short-lived JWT signed with the maintainer's account
   key. The host checks it against the maintainer's DID document, so it
   knows which account the request is from without a password of its own.
   Every later call to the host is made the same way.
4. **The DID.** `zena` calls `dev.zena-lang.host.createPackage` with the
   scope's organization, the recovery key's public key, the profile and
   the maintainers record. A maintainer with no scope on the host yet
   creates one first, with `dev.zena-lang.host.createOrganization`: an
   organization with them as its only owner, under a scope name they
   choose. The host generates the
   package's signing key, writes the genesis operation, signs it with its
   rotation key and submits it to the PLC directory:

   ```json
   {
     "type": "plc_operation",
     "rotationKeys": [
       "did:key:zQ3sh...(the maintainer's recovery key)",
       "did:key:zQ3sh...(the host's rotation key)"
     ],
     "verificationMethods": {
       "atproto": "did:key:zQ3sh...(the package's signing key)"
     },
     "alsoKnownAs": ["at://router.acme.pkg.zena-lang.dev"],
     "services": {
       "atproto_pds": {
         "type": "AtprotoPersonalDataServer",
         "endpoint": "https://pkg.zena-lang.dev"
       }
     },
     "prev": null,
     "sig": "..."
   }
   ```

   The DID is the first 24 characters of the base32 SHA-256 hash of this
   signed operation. A new package's DID document therefore names the
   host as its PDS and the host's key as its signing key, and lists the
   maintainer's recovery key ahead of the host's rotation key.

5. **The repository.** The host creates the account's repository with the
   profile, from `zena-package.json`, and a maintainers record listing the
   maintainer, which `zena` attests. The log takes a package's first
   maintainers record once as many of the maintainers it lists as its
   threshold have attested it.
6. **The manifest.** `zena` writes the DID into `zena-package.json` as
   `"did"`, so that later publishes go to the same package, and goes on to
   publish the release.

The handle, `router.acme.pkg.zena-lang.dev`, is the name in the scope the
maintainer asked for. See [Names and scopes](#names-and-scopes).

### Publishing a release

1. `zena publish` builds the artifacts and the release record. The
   release's dependencies are those in the package's manifest, with each
   path dependency replaced by the depended-on package's DID and the
   version the workspace uses
   ([package-manifest.md](package-manifest.md#publishing-a-workspace-package)).
   The record's CID is known before it is written, since it is the
   record's hash.
2. It calls `dev.zena-lang.host.publish` with the record and the
   artifacts, with a service-auth token as above. The host checks that the
   caller is a maintainer, stores the artifacts as blobs of the package's
   account, and writes the release record. It refuses a version that
   exists.
3. It writes an attestation of the release to the maintainer's own
   repository.
4. It looks the version up in the checksum log, which records it.

`zena yank <version>` writes a yank record the same way.

Publishing changes the package's repository and not its DID document. The
DID document changes only when the package moves to another host, its
handle changes, its signing key is replaced, or recovery keys are added or
removed. Each of these is a PLC operation, signed with a rotation key.

CI publishes as an automation account: a maintainer marked `automation`,
which an organization's host creates on request, from `zena ci create` or
the management interface, and whose app password is a CI secret. The host
holds that account, so its attestation is one the host could make itself.
The log therefore counts an automation account on the package's own host
only together with at least one person's attestation; an automation
account on another PDS counts like any maintainer. Publishing from CI
with no stored secret, as npm and PyPI allow with GitHub's OIDC tokens,
is an open question.

### Who signs what

- The **release record** is signed as part of a commit to the package's
  repository, with the package's signing key. The host holds that key, so
  this signature shows that the host wrote the release, and not who asked
  it to.
- An **attestation** is a record in the publishing maintainer's own
  repository. It is signed with their account's key, held by their own
  PDS:

  ```json
  {
    "$type": "dev.zena-lang.package.attestation",
    "subject": {
      "uri": "at://did:plc:routerrouterrouterrouter/dev.zena-lang.package.release/1.4.2",
      "cid": "bafyrei..."
    },
    "createdAt": "2026-10-21T00:00:00.000Z"
  }
  ```

  Its record key is the SHA-256 hash of the subject's AT-URI, a space and
  the subject's CID, in lowercase base32 without padding. So the
  attestation of a given record by a given maintainer can be fetched
  without listing their records. Successive maintainers records share an
  AT-URI, and the CID keeps their attestations apart.

The checksum log fetches the attestations when it records a release, and
records the release only when the package's threshold of maintainers have
attested it. Clients already check releases against the log, so they
rely on attestations without fetching them, and anyone can fetch them to
audit the log. A release in the log was approved by the package's
maintainers, each through a PDS they chose, and the host cannot make one
alone. A host that also holds the maintainers' own accounts could, which
is why the Zena project's host holds package and organization accounts,
and automation accounts that cannot publish without a person (see
[Publishing a release](#publishing-a-release)), and no one's own account.

### Maintainers, teams and organizations

A package's repository has a maintainers record at record key `self`:

```json
{
  "$type": "dev.zena-lang.package.maintainers",
  "maintainers": [
    {"did": "did:plc:alicealicealicealicealic", "role": "owner"},
    {
      "org": "did:plc:acmeacmeacmeacmeacmeacme",
      "team": "core",
      "role": "publisher"
    }
  ],
  "threshold": 1,
  "ownerThreshold": 1
}
```

- **An individual** is the only maintainer, an owner, with thresholds of 1.
- **A team** without an organization is several DIDs. `threshold` says how
  many attestations each release needs, and `ownerThreshold` how many
  owners must attest a change to the maintainers record.
- **An organization** is an account of its own on a package host, with
  two kinds of record:
  - `dev.zena-lang.org.members`, at `self`: who belongs to the
    organization and in which role, and the thresholds for changing its
    members and its teams;
  - `dev.zena-lang.org.team`, one per team, keyed by the team's name:
    who is on the team and in which role.

  Both list their members privately, as
  [Private membership](#private-membership) describes. An organization's
  handle on its host is a scope, and its packages' handles are in it. A
  package maintained by a team names the organization, the team and the
  team's role on the package, and every member of the team has that role.
  Changing who is on a team changes it for every package the team
  maintains. The packages an organization creates list the
  organization's recovery keys, held by its owners, rather than one
  person's.

#### Roles

| Record                    | Role       | Can                                                                                              |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| a package's maintainers   | publisher  | attest releases, and yank them                                                                   |
|                           | owner      | also attest changes to the maintainers record, and edit the profile, rename and move the package |
| an organization's members | member     | be put on teams                                                                                  |
|                           | admin      | also create packages in the organization's scope, create teams, and attest changes to them       |
|                           | owner      | also attest changes to the members record, and hold the organization's recovery keys             |
| a team                    | member     | act on each of the team's packages in the role the package gives the team                        |
|                           | maintainer | also attest changes to the team                                                                  |

The log checks roles for everything that decides which releases count:
releases, and changes to maintainers, members and teams. The host checks
the same records for the rest: profile edits, renames, moves, yanks,
creating packages in a scope, and its own settings.

#### Private membership

Who approved each release is public. An attestation is a record in the
approver's own repository, and the log names the approvers of every
release. That is what a package's dependents need when an account turns
out to have been taken: the list of releases it approved. A package a team maintains
is shown as published by the team, with its approvers one step away.

Who belongs to an organization or a team is not public. Membership tells
an attacker whom to go after, and tells dependents nothing they can use. The
accounts most worth hiding are owners and admins who never publish, since
they decide who is on each team. npm lists every package's maintainers,
and the maintainers of popular npm packages were phished in
September 2025. GitHub keeps organization membership private by default.

Members and team records therefore list commitments rather than DIDs:

```json
{
  "$type": "dev.zena-lang.org.team",
  "members": ["bafyreib2rxk3rh6kzwq...", "bafyreidfcm5xvkhxs4o..."]
}
```

Each commitment is the CID of one member's entry: the entry encoded as
DAG-CBOR and hashed with SHA-256. The entry stays private:

```json
{
  "did": "did:plc:alicealicealicealicealic",
  "role": "maintainer",
  "approvalKeys": ["did:key:zDnae..."],
  "salt": {"$bytes": "q83vEjRWeJA..."}
}
```

- **The salt** is 32 random bytes, so no one can find a commitment by
  trying DIDs.
- **The host keeps the entries.** It gives each member their own entry,
  an organization's owners and admins every entry, and a team's
  maintainers their team's.
- **Acting reveals the entry.** An attestation that relies on a
  membership includes the entry, and the log checks it against the
  commitment. A member becomes known in a role when they first act in
  it, and not before.
- **The host cannot add members unseen.** A new members or team record
  counts only with the attestations its owners' or admins' threshold
  requires. They approve it in the management interface, which shows the
  entry behind each commitment, so an account they do not know is
  visible to them before they approve.

A package's maintainers record can list individuals by commitment too,
in place of a DID.

What still shows:

- Acting reveals the role for good: an admin who approves a change to a
  team is publicly an admin of that organization from then on.
- The number of commitments shows how large a team is, unless the team
  pads it with entries for no one.
- Who has approved releases suggests who can.
- The index cannot list memberships it cannot see. The management
  interface asks the hosts instead.

**Separate maintainer accounts.** A maintainer need not use the atproto
account they use elsewhere. Someone who wants their maintenance kept
apart from their public identity can make an account just for it, on any
PDS but the package's host, so that its record of approvals points to no
one in particular.

#### Adding and removing people

`zena owner add <package> <handle or DID>` and `zena owner remove` write a
new maintainers record through the host. `zena org add` and
`zena org remove` do the same to an organization's members, and
`zena team add` and `zena team remove` to a team. A change counts once
the roles and threshold of the record before it have attested it: the
owners for a maintainers or members record, and the admins, owners or the
team's maintainers for a team. So one owner of a package whose
`ownerThreshold` is 2 cannot replace the others. The log records each
change that counts. A release counts under the maintainers record the log
held when it recorded the release, so someone who leaves cannot attest
new releases, and the releases they attested stay valid.

Someone who leaves and holds a recovery key must also lose the key: the
remaining holders remove it from the DID's rotation keys with a PLC
operation. A higher-ranked rotation key can undo an operation signed by a
lower-ranked one within 72 hours, so the removal is signed with a recovery
key ranked above the departing one, not with the host's key, which ranks
last. The first rotation key should be the one trusted most, such as an
organization's offline key.

### Thresholds

- **Releases and changes of maintainers** can require M of N
  maintainers, through attestations. A release with fewer attestations
  than its threshold waits. `zena approve <package>@<version>` adds one,
  and the log records the release once it has enough.
- **Control of the DID** cannot. PLC accepts an operation signed by any
  one rotation key, with rank deciding conflicts for 72 hours, and has no
  thresholds. The host signs with its own rotation key only for changes
  the maintainers' threshold has attested, but a recovery key can act
  alone. A package should have few recovery keys, kept offline.

Threshold signatures, where several holders together act as one key, are
not planned.

### The management interface

People sign in as themselves, never as an organization or a package:
those have no passwords, and are managed through someone's role in them.
The management interface is a browser app on the index's site, and has no
privileges of its own:

- **Signing in.** It signs in with atproto OAuth, as a browser client.
  The session's DPoP key is a non-extractable WebCrypto key, and signing
  out revokes the session.
- **Reading.** It reads public data from the index: packages, their
  maintainers records, releases waiting for approvals, pending recovery
  resets and PLC operations. It asks each host the person uses for the
  memberships the index cannot see: the person's own, and for an
  organization's owners and admins, the whole list.
- **Writing.** It writes attestations to the person's own repository.
  Everything else goes to the package's or organization's host, through
  the person's PDS, which proxies the call with a service-auth token
  (`atproto-proxy`, which the `rpc` permission covers).

Neither the index nor the site's server holds anything that can publish,
attest or change a record, so a compromised index can show wrong data,
and do no more.

The interface lists a person's packages, organizations and teams with
their roles, the releases waiting for their approval, with the changes to
the source fetched by CID and shown in the browser, pending recovery
resets, each package's PLC history and which recovery keys rank where,
and the settings of each record: thresholds, `humans`, and approval keys.

How it handles keys:

- **Approval keys** are registered and used here, since passkeys are a
  browser feature, and `zena approve` opens the same page. The page's
  domain is the passkeys' relying party, and must never change: a passkey
  made for one domain cannot sign for another.
- **Recovery keys** never enter the browser. WebAuthn signs only its own
  data, not a PLC operation, and a key held by a page is exposed to every
  script on it. The interface prepares PLC operations, and `zena` signs
  them, with a key from a file or a hardware key such as a YubiKey's PIV
  applet.
- **The host's keys** never appear. The interface calls the host's
  methods.
- **CI credentials.** Creating a CI token has the host create an
  automation account in the organization, and shows its app password
  once.

People approve what the interface shows them, so its code is what they
trust. It is served as static, versioned files built from open source,
with Subresource Integrity on its scripts, and `zena approve` remains a
way to inspect and approve releases without it. A package host can also
have pages of its own for settings only it holds, such as claims on scope
names.

### The host's methods

Each method of the extension is a lexicon in
`packages/package-manager/lexicons/dev/zena-lang/host/`. Every call
carries a service-auth token from the caller's PDS, addressed to the
host's DID with the method's NSID as its `lxm`, and the host checks the
caller's role in the records it already holds. A write that changes
which releases count, such as a new maintainers record, takes effect
once the attestations the previous record requires reach the log.

| Method                    | Caller                                                          | What it does                                                         |
| ------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `createOrganization`      | anyone the host's limits allow                                  | creates a scope, with the caller as its only owner                   |
| `createPackage`           | an organization's admins, or a team they allow                  | creates a package with its profile and maintainers record            |
| `createAutomationAccount` | an organization's admins                                        | creates an account for CI and returns its app password once          |
| `uploadArtifact`          | a package's maintainers                                         | stores an artifact, or one part of it, as a blob of the package      |
| `publish`                 | a package's maintainers                                         | writes a release record, refusing a version that exists              |
| `yank`                    | a package's maintainers                                         | writes a yank record                                                 |
| `putProfile`              | a package's owners                                              | replaces the profile                                                 |
| `renamePackage`           | a package's owners                                              | changes the handle, with a PLC operation, and the profile's name     |
| `putMaintainers`          | a package's owners                                              | writes a maintainers record, with the entries behind its commitments |
| `putMembers`              | an organization's owners                                        | writes the members record, with its entries                          |
| `putTeam`, `deleteTeam`   | an organization's admins, or a team's maintainers for `putTeam` | creates, replaces or deletes a team                                  |
| `getEntries`              | members, owners, admins and team maintainers                    | returns the private entries the caller may see                       |

The `put` methods take the CID the record must have now, as
`com.atproto.repo.putRecord` does, so two owners editing at once do not
overwrite each other unseen.

Moving a package to another host, and the recovery of
[Recovery](#recovery), have no methods yet. Both need PLC operations that
the host signs only with the maintainers' attestations, and the rules for
that are a later revision of this design.

### Moving to another host

Keys do not move. The new host generates a signing key of its own, and
the DID document is changed to name it:

1. The new host creates an account for the existing DID, with
   `com.atproto.server.createAccount` and the DID, as atproto account
   migration does.
2. The repository and its blobs are copied from the old host, with
   `com.atproto.sync.getRepo` and `com.atproto.sync.getBlob`. A record's
   CID is a hash of its content, so every pinned release keeps its CID.
3. A PLC operation names the new host's endpoint and signing key, and
   replaces the old host's rotation key with the new host's. The old host
   signs it if it cooperates, and a recovery key holder if it does not.

`zena package move --to <host>` does all three. If the old host is gone,
the records and blobs can be rebuilt from caches and proxies, which hold
every release anyone has fetched, and checked against the log.

### Holding keys elsewhere

- **Recovery keys** are held by maintainers already. A key on a laptop
  can be lost, which leaves moving the package to the host's cooperation,
  or stolen, and a thief with the first-ranked key can take the DID.
  Keeping recovery keys in hardware keys or the OS keychain is an open
  question.
- **The signing key** is held by whatever serves the repository, since a
  commit is signed when records are written and served from there. A
  package that trusts no host runs its own: the Zena project's host
  software, with `zena package create --host <url>`, or an ordinary PDS,
  which the `zena` command can read from but not publish to. A key on a
  laptop that is usually offline cannot serve the repository, so this is
  not supported.
  A self-hosted package's risks are its host's: when the server is down,
  the package can be fetched only from caches, and if its signing key
  leaks, anyone can write releases, which still go unattested and so are
  never recorded by the log.
- **A `did:web` package** has no rotation keys. Whoever controls the
  domain's `/.well-known/did.json` controls the package, and moving host
  means editing that file. It cannot move to another domain.

### Trusting a host

A host can write anything to the repositories it holds, refuse to serve
them, and sign PLC operations with its rotation key. What limits it:

- Lockfiles pin the CID of every release, so a workspace that has
  resolved a release gets those bytes or fails.
- The log records a release only with its maintainers' attestations, so
  a release the host wrote alone is never recorded. A release changed
  after the log recorded it is labeled `release-mutated`.
- PLC operations are public: the directory's export stream lists every
  operation on every DID, so a change a host makes to a package's DID
  document can be seen.
- Recovery keys rank above the host's rotation key, so for 72 hours
  maintainers can undo any PLC operation the host signs.

A package's dependents rely on its maintainers, through their
attestations, and on the log. They do not choose the package's host, and
do not need to trust it.

### The PLC directory

Creating a package's DID is one request. The host posts the signed
genesis operation, the directory validates and stores it, and the DID
resolves as soon as the request returns. Later operations work the same
way. Resolvers that cache DID documents can serve an old one for a while
after an update, which matters when a package moves, not when it is
created.

The directory holds the DID of every Bluesky account, tens of millions of
them, and an operation is limited to 7,500 bytes. npm holds about three
million packages after fifteen years, so packages would add few DIDs by
comparison, and slowly. The directory limits requests per client at its
load balancer, with limits its specification calls generous, and has no
limit per DID yet. A host that creates accounts in volume should agree it
with the directory's operators, which are becoming an independent
association. Every operation stays in the directory's log for good, so an
abandoned package keeps costing its few operations. Packages made for
testing should use `did:web`.

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

## Security and supply-chain attacks

Three properties do most of the work against attacks on a package's
dependencies:

1. **A workspace gets the bytes it pinned.** The lockfile pins the CID of
   every release record and artifact, so nothing anyone does later changes
   what a resolved workspace builds.
2. **A release counts only when its maintainers approved it.** The
   checksum log records a release only with attestations from the
   package's threshold of maintainers, each made through the maintainer's
   own PDS, and clients refuse releases the log does not have. Whoever
   holds the package's repository cannot publish alone.
3. **Nothing new arrives unasked.** Minimal version selection uses the
   lowest version anyone in the graph asks for, so a new release,
   malicious or not, reaches a workspace only when someone raises a
   minimum, usually with `zena update`. Nothing in a package runs when it
   is added, fetched or compiled: Zena packages have no install or build
   scripts. The macros Zena may add ([macros.md](macros.md)) would run at
   compile time, in the compiler's Wasm sandbox and without its access to
   files or the network.

The design does not stop a maintainer from publishing malicious code on
purpose, or approving it unaware. See [Malicious releases](#malicious-releases)
for what limits that.

### Unauthorized publishing

Who might publish without the maintainers' consent, and what stops them:

- **The host**, or whoever controls it, holds the package's signing key
  and can write any record. It cannot write attestations in the
  maintainers' repositories, so the log records none of it.
- **Someone with a maintainer's session**, taken from their machine, can
  do what the maintainer can, attesting included. A threshold of 2 or
  more needs a second maintainer, and a maintainer with approval keys
  (below) needs one of those too. The maintainer revokes the session at
  their PDS.
- **Someone who takes over a maintainer's account**, by phishing its
  password, say, is held back by the same things. How an account signs in
  is up to its PDS, including whether it asks for a second factor
  (bsky.social can send one by email). Approval keys are a second factor
  that does not depend on the PDS.
- **Someone with a CI secret** can attest as the bot account. A package
  that publishes from CI should require a person's attestation as well.
- **The log's operator** could add an entry without its attestations, or
  change one. The log is a transparency log with witnesses (see
  [The checksum log](#the-checksum-log)), so either can be shown.

The index sees every publish, every change of maintainers and every PLC
operation for a package, and tells the package's maintainers, so a
publish one of them did not expect is noticed by the others.

### Human approval and second factors

Three fields of the maintainers record control this:

```json
{
  "$type": "dev.zena-lang.package.maintainers",
  "maintainers": [
    {
      "did": "did:plc:alicealicealicealicealic",
      "role": "owner",
      "approvalKeys": ["did:key:zDnae..."]
    },
    {
      "did": "did:plc:bobbobbobbobbobbobbobbob",
      "role": "publisher",
      "approvalKeys": ["did:key:zDnaf..."]
    },
    {
      "did": "did:plc:acmebotacmebotacmebotacm",
      "role": "publisher",
      "automation": true
    }
  ],
  "threshold": 2,
  "ownerThreshold": 1,
  "humans": 1,
  "approvalKeysRequired": true
}
```

- **`automation`** marks a maintainer as a bot, such as the account CI
  publishes as. Team members' entries can carry it, and approval keys,
  the same way.
- **`humans`** is how many of a release's attestations must come from
  maintainers that are not automation. With CI attesting and `humans` at
  1, a release CI publishes waits until a person runs `zena approve`,
  which shows what they are approving: the version, the artifacts' CIDs,
  and the changes to the source since the previous release. A release
  made with a stolen CI secret reaches the log only if a person approves
  it.
- **`approvalKeys`** are a maintainer's passkeys or security keys. When a
  maintainer has some, their attestations count only with a signature
  from one: `zena approve` asks for a WebAuthn assertion over the
  release's CID, through a page at `zena-lang.dev` opened in the browser,
  and includes it in the attestation, where the log checks it against the
  key. With `approvalKeysRequired`, every person's attestation needs one.
  Someone with the maintainer's session or account, and not their key,
  cannot attest.

A maintainer should register two approval keys, as with any second
factor. Adding or removing one is a change of maintainers, attested like
any other.

### Recovery

Two cases need a way back that does not go through the maintainers'
attestations: an only maintainer who has lost their account or approval
keys, and a team that can no longer reach its threshold. A new
maintainers record signed with one of the package's recovery keys, in
place of attestations, counts once the log has shown it for seven days,
unless the current maintainers attest a different record in that time.
The index tells the maintainers when such a change is pending. A recovery
key is kept offline and rarely used, so it is harder to take than a
session, and the seven days give the maintainers time to answer if it is
taken.

### Compromised keys

| If this is taken                  | The attacker can                                                       | What stops them                                                                                                              | Recovery                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A maintainer's session or account | attest as the maintainer, and ask the host for what the maintainer can | the threshold, `humans` and approval keys; the other maintainers are told                                                    | revoke the session or recover the account; the other maintainers remove the person if needed, and yank what was published     |
| A CI secret                       | attest as the bot                                                      | `humans`; an automation account on the package's host counts only with a person's attestation                                | replace the app password                                                                                                      |
| An approval key                   | nothing alone                                                          | it signs only together with the maintainer's account                                                                         | remove it from the maintainers record                                                                                         |
| The package's signing key         | write records to the repository                                        | the log, which records nothing unattested                                                                                    | the host replaces the key with a PLC operation                                                                                |
| The host's rotation key           | change the DID document of every package on the host                   | recovery keys, which rank above it, undo its operations for 72 hours; the index watches PLC operations and tells maintainers | maintainers undo the operations with their recovery keys                                                                      |
| A recovery key                    | change the DID document at that key's rank, and start a recovery reset | higher-ranked keys, for 72 hours; the seven days of a reset; new releases still need the maintainers' attestations           | undo with a higher-ranked key; if the first-ranked key was taken, the DID is lost, and the package moves to a new DID (below) |
| The log's signing key             | sign a log head that drops or changes entries                          | witnesses, and clients, which refuse a head that does not extend the last one they saw                                       | the log rotates its key                                                                                                       |

A package whose DID is taken cannot be published by its attacker, as
long as its maintainers answer any recovery reset the attacker starts:
the log keeps the package's maintainers record, and a release still needs
those maintainers' attestations. The maintainers cannot publish to it
either, since they no longer control its repository. They publish under
a new DID, and a labeler marks the old one `compromised`, naming the new
DID, so dependents can move.

### Squatting

- **DIDs** cannot be squatted: a `did:plc` is a hash, and a `did:web`
  belongs to its domain.
- **Local names** cannot be squatted: each package chooses its own.
- **Handles** can be taken only as scope names on a host's domain, first
  come, first served. A host can reserve scopes for people who show they
  own a matching domain or GitHub organization, and settle disputes, as
  package registries do. An organization that uses its own domain as its
  scope is out of reach. A handle that a scope gives to another package
  moves no dependent, since manifests and lockfiles record DIDs.

### Confusion

- **Typosquatting**, as in `@acme/routr` beside `@acme/router`. Handles
  are ASCII, which rules out look-alike Unicode. `zena add` shows the DID,
  handle, maintainers, and how many packages depend on the package before
  it writes anything, and the index can label handles that look like
  those of popular packages. After `zena add`, the depending package
  refers to the package by DID and by its own local name, so a typo can do harm only at
  that moment.
- **Dependency confusion**, where a public package shadows a private one
  of the same name, needs names that resolve by search. Packages are
  named by DID, and `@scope/name` maps to one domain per scope (see
  [Names and scopes](#names-and-scopes)).
- **Expired domains.** Whoever registers a domain a package's handle was
  on can point the handle at their own DID, which affects only new
  `zena add`s by that handle. For a `did:web` package the DID itself
  becomes theirs, but the log still holds the old maintainers record, so
  it records no release they make.
- **Manifest confusion**, where what a registry shows about a package
  differs from what the package contains. A release lists its
  dependencies, and its source archive holds `zena-package.json`, which
  lists them too. The log and `zena fetch` check that the two agree.
- **Lockfile injection**, where a pull request changes `zena-lock.json`
  to pin another DID or CID. `zena fetch --check` recomputes the selection
  from the `zena-package.json` files and checks each pin against the log,
  and fails when the lockfile differs,
  so CI can refuse such a change.
- **Source that differs from its repository.** Source archives are packed
  deterministically, so anyone can pack the repository at a release's tag
  and compare the CID with the release's, with `zena verify-source`.

### Malicious releases

When a maintainer publishes malicious code, or approves it without
noticing:

- Minimal version selection takes a new release only when someone raises
  a minimum, so a malicious release reaches the workspaces that update,
  not every build. A release found out in that time can be yanked and
  labeled before most workspaces take it.
- Labelers mark malicious releases `malware`, and clients that follow
  them refuse those releases, pinned ones included.
- A workspace can follow a labeler that reviews releases, and require
  `reviewed` for some or all of its dependencies.
- A library's source is compiled into the program that uses it, and runs
  with that program's capabilities. A prebuilt component can reach only
  what its world imports and the program gives it.

### Availability

A package whose host deletes it, or disappears, can still be fetched from
caches and proxies, since every artifact is addressed by its CID, and its
maintainers can move it to another host with a recovery key. The PLC
directory and the log are needed to resolve new releases. A build from an
existing lockfile needs neither, given a cache or proxy that holds
its artifacts.

## Abuse and moderation

A package host's operator answers for what the host stores and serves, as
any registry's or PDS's does. The Zena project's host will receive legal
takedown notices and reports of spam, malware and impersonation, and
people will try to use it for things other than packages. This section
says what the host allows, how it limits creating accounts, and how its
operator handles reports.

### What a package account can do

A package account exists to hold package records, and the host lets it do
nothing else. The same goes for organization accounts.

- The host has no way to sign in as one of these accounts: no
  `com.atproto.server.createSession`, no app passwords and no OAuth
  authorization. It does not serve `com.atproto.repo.createRecord`,
  `putRecord`, `deleteRecord`, `applyWrites` or `uploadBlob` for them.
  They are written only through the extension's methods.
- An automation account signs in with its app password, since that is
  how CI publishes. It can write attestations
  (`dev.zena-lang.package.attestation`) to its own repository and call
  the extension's methods, and nothing else.
- The host's repository code refuses a write to any collection outside
  `dev.zena-lang.*` in all of these accounts, whichever method makes it,
  so a bug in one method cannot open an account up.
- Blobs are stored only as the artifacts a release declares, within the
  limits below.

So an account created by publishing a package cannot post to Bluesky
(`app.bsky.feed.post`) or Leaflet, follow anyone, or hold a profile for
any other application.

A package that moves to another PDS leaves these limits behind, along
with the host's domain: its handle under the host's domain resolves only
while the host's DNS answers for it, and the host stops answering for a
package it has taken down. What leaves with it is its DID, and anyone can
create a `did:plc` at the PLC directory without a host.

### Limits on creating accounts

Each account a host creates costs others something: an operation at the
PLC directory, and an account that relays carry, with its events on the
host's firehose. Relays can limit how many accounts they carry from one
PDS, so a host flooded with accounts risks having all of its packages
throttled. The host therefore limits who creates accounts and how many:

- **Scopes.** Creating a scope is the step the host checks. It needs the
  operator's approval, or a claim on a matching domain or GitHub
  organization (see [Squatting](#squatting)), and the host can reserve
  names (see [Confusion](#confusion)).
- **Packages.** Within a scope, packages are created without review, up
  to a number per day and a number in all, which the operator can raise.
- **Maintainers.** Every request carries the maintainer's DID, through
  its service-auth token, so the host can limit requests per maintainer.
  Accounts on permissive PDSes cost little to create, so the host also
  considers how old the maintainer's account is, which PDS holds it, and
  the labels that labelers the operator follows put on it.
- **Storage.** Each artifact, each release and each scope has a size
  limit, and a release can store only the artifact kinds the release
  schema defines. Without limits a host is free file hosting.

### Reports and takedowns

- **Reports.** The host takes reports through
  `com.atproto.moderation.createReport`, which atproto clients already
  use, and through an address on its site. The index links every package
  page to it.
- **Takedowns.** The operator can take down a release, a package or an
  organization. The host then stops serving the records and blobs
  involved, stops answering for a taken-down account's handle, and marks
  the account as taken down on its firehose, as atproto's account status
  events do. The operator's labeler labels what was taken down and why
  (`legal`, `malware`, `spam`, `impersonation`), so a client whose fetch
  fails can say why.
- **Legal notices.** The operator names an agent for notices such as DMCA
  takedowns, takes down what a valid notice names, and restores it on a
  valid counter-notice, as the law requires. A notice usually names a
  release or an artifact, which can be taken down without the rest of
  the package.
- **Dependents.** Workspaces that pinned a taken-down release still have
  it in their caches. The Zena project's proxy follows the host's
  takedowns for malware and legal notices and stops serving those blobs.
  The checksum log keeps the release's CIDs, which are hashes and not the
  content, so a release can be taken down without changing the log.

### Proactive measures

- The index looks at every new release before most workspaces could have
  taken it: binary files in source archives, archives much larger than
  the package's earlier releases, and handles close to those of popular
  packages. It labels what it finds for review.
- The first releases of a new scope are reviewed first.
- The host rate-limits `createPackage` and `publish`, and the operator
  watches for bursts of accounts or releases.
- The host follows labels from labelers that mark spam and abusive
  accounts, Bluesky's own moderation among them, and refuses requests
  from maintainers they label.

## What this needs

- **`packages/atproto`**: identifier syntax, base encodings, CIDs,
  DAG-CBOR, CAR, MST proofs, commit verification, P-256 and secp256k1
  signature verification, DID and handle resolution, and an XRPC client.
  Creating a `did:plc` package also needs signing.
- **Outgoing HTTP** with methods and headers on the `zena-cli` target,
  which `wasi:http` provides directly.
- **The `zena` command**: `login`, `add`, `update`, `fetch`, `publish`,
  `approve`, `yank`, `owner`, `team`, `package create` and
  `package move`, and the `@scope/name` shorthand with its `scopes`
  mapping. Signing in needs OAuth with a loopback redirect, a
  client metadata document at `zena-lang.dev`, and the
  `dev.zena-lang.authPublish` permission set.
- **A package host**: a PDS written in Zena, with the
  `dev.zena-lang.host.*` extension: methods for creating packages, scopes
  and automation accounts without an email address, publishing, changing
  maintainers, members and teams, and moving packages. It checks
  service-auth tokens against roles, keeps membership entries and gives
  them to those allowed to see them, and serves its domain's DNS zone to
  answer for its scopes' handles. It confines package, organization and
  automation accounts to `dev.zena-lang.*` records, enforces the limits on
  creating accounts and on storage, takes reports, and has the
  operator's tools for reviewing scopes and taking content down.
- **The management interface**: a browser app on the index's site, with
  no privileges of its own.
- **Lexicons** for the records, the host's methods and the
  `dev.zena-lang.authPublish` permission set, in
  `packages/package-manager/lexicons`. Moving a package and recovering
  one have no methods yet.
- **Services**: the checksum log, the index and its proxy, and a labeler,
  all Zena servers. The log also checks attestations, approval-key
  signatures and recovery resets. The index watches PLC operations,
  publishes and changes of maintainers, and tells maintainers about them.
- **Approvals**: `zena approve`, and the management interface's page that
  asks a passkey or security key for a WebAuthn assertion. `zena fetch --check`
  and `zena verify-source`.

## Alternatives considered

### A package as a record in its publisher's repository

A package could be identified by its publisher's DID and a record key,
`at://did:plc:alice/dev.zena-lang.package.profile/router`. Any atproto
account could publish today, with no new accounts. A package could then
never change hands, and it would share its fate with one person's
account. A DID per package keeps the package's identity separate from
anyone who maintains it.

### Package accounts on any PDS, with a password each

The first version of this design created each package with
`com.atproto.server.createAccount` on whatever PDS its publisher chose,
and published with that account's app password, which a team shared as a
secret. It needs no package host. It gives each package a password to
keep, makes everyone who publishes share it, records nothing about who
published, and has no default PDS: bsky.social would need an email
address per package and make each one a Bluesky user. The `zena` command
still reads packages from any PDS, and a package can move to one, but it
does not publish to one.

### A publishing gateway in front of an ordinary PDS

A separate service could create package accounts on a reference PDS with
its administrator's invite codes, keep each account's password, and write
releases with `com.atproto.repo.*` after checking the maintainer's
service-auth token. It controls package accounts as fully as a package
host does, and needs no PDS of our own. It also keeps a password per
package, needs an email address for each account where the PDS requires
one, and is a second service to run beside the PDS. Clients would call
the same `dev.zena-lang.host.*` methods, so a gateway could replace a
package host, or the reverse, without changing them.

### Releases signed with maintainers' own keys

Each maintainer could hold a key, on their machine or a hardware key, and
sign releases with it alone, as Sigstore and PGP-signed packages do. Their
public keys would have to be published and replaced somewhere, and a lost
key would need a recovery story of its own. Attestations get a signature
for each maintainer from the key their PDS already holds, with the
account's recovery behind it. Approval keys add the maintainer's own key
as an optional second factor: they are published in the maintainers
record, replaced like any change of maintainers, and recovered with a
recovery reset.

### A threshold of rotation keys

PLC has no threshold of rotation keys, and a threshold signature scheme
would make several holders act as one rotation key without PLC knowing.
Both are out of reach or complex, and releases, which are what clients
use, get M of N through attestations instead.

### Public membership

Members and team records could list DIDs, as the maintainers record does
for individuals. Anyone could then see who can change a team or publish
for it, which is what an attacker wants to know, while dependents need only
who approved each release. Commitments keep the log's checks, and reveal
a member only when they act.

### Anonymous approvals

Group signatures or zero-knowledge proofs could show that some member of
a team approved a release without saying which. They would also hide
which releases an account approved, which dependents need to know when
the account turns out to have been taken.

### Enforcing immutability at the PDS

A PDS that refuses to change release records is easy to build and covers
packages hosted there. The package's owner can move it to another PDS,
and its DID and every dependency on it follow. A check that
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
- **The Zena package host's domain, and its policy on scope names**: for
  example, reserving scopes for verified domains or GitHub organizations,
  and settling disputes.
- **The Zena package host's moderation**: who reviews new scopes and
  reports, the quotas on packages and storage, the legal entity that
  receives notices, and which labelers the host follows for maintainers.
- **Publishing from CI with no stored secret**, through the CI system's
  OIDC tokens, as npm and PyPI allow.
- **Recovery keys in hardware**, such as security keys or the OS
  keychain.
- **How the index reaches maintainers** with what it notices: a Bluesky
  direct message, an email address they register, or a feed.
- **Approval keys without a browser**, with `zena` talking to a security
  key directly.
- **Private packages.** A package in an atproto space, the proposed
  permissioned-data extension, could be readable by an organization only.
  Spaces are an alpha with an unstable wire format.
- **Compression** of source archives, once Zena has a compression
  library.
- **Toolchain requirements.** A release may need to state the oldest Zena
  compiler that builds it.
