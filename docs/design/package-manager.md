# Package Manager

Status: **Proposed**, and partly built: the AT Protocol libraries
(`packages/atproto`), the package records, source archives and fetching
(`packages/package-manager`), the compiler's reading of pinned packages,
`zena pkg add`, `zena pkg update` and `zena pkg fetch`, `zena pkg login` with app
passwords, `zena pkg publish`, `zena pkg create` and `zena pkg scope`, and an
App View with the methods for publishing and for changing members,
teams and maintainers, each held until its threshold has attested it. The
App View (`packages/registry`) is a service of its own, which keeps its
accounts on the PDS written in Zena (`packages/pds`), and could keep them
on other PDSes ([Hosting, keys and maintainers](#hosting-keys-and-maintainers)).
The checksum log is not built yet, so for now the App View's check of the
attestations is the only one.

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
  change its PDS, its handle and its maintainers and keep its DID.
  Handles, which are for finding packages, always have a scope:
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
- **Hosting and maintainers.** The App View, the Zena service that `zena`
  and the site call, creates package accounts on request on a PDS and
  keeps the authority over them. Maintainers publish by signing in with
  their own atproto accounts, so no one holds a password for a package. Each
  release is attested by the package's maintainers: each approves it with
  a record in their own repository, signed by their own PDS. A release
  needs M of N if the package asks for it, and the App View holds it back
  until it has them; the checksum log checks the attestations again. Teams
  and organizations have roles, and who belongs to them stays private
  until they act. [Terms](#terms) defines these words, and
  [What the records guarantee](#what-the-records-guarantee) why approvals
  and roles are public records.
- **Supply-chain security.** A workspace builds the bytes it pinned, a
  release counts only with its maintainers' approval, and no new release
  reaches a workspace until someone asks for it. Packages can require a person to
  approve releases that CI publishes, and a passkey or security key for
  each approval. See [Security and supply-chain attacks](#security-and-supply-chain-attacks).
- **Discovery and trust.** The App View's index collects packages across
  PDSes and serves search. atproto labelers mark packages as
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

### Terms

These are the package manager's own terms. Each is described in full in
the section it links to.

- The **App View** is the Zena service that `zena` and the site call, at
  `pkg.zena-lang.dev`. It creates the accounts of packages, organizations
  and CI on a PDS, holds their rotation keys, and is the only one that
  writes to them
  ([Hosting, keys and maintainers](#hosting-keys-and-maintainers)). It is
  also the index: it collects package records across PDSes, from
  the firehose ([The index](#the-index)). Its methods are the package
  registry's, `dev.zena-lang.registry.*`.
- A **managed account** is an account a PDS creates for an App View
  it trusts, with no email address, password or invite code, and that
  only that App View writes to ([Managed accounts](#managed-accounts)).
- An **organization** is an account on an App View that owns a
  **scope**, the label its packages' handles share (`acme` in
  `router.acme.pkg.zena-lang.dev`). Its **members** have roles, and its
  **teams** are groups of members that maintain packages together
  ([Scopes](#scopes), [Roles](#roles)).
- A package's **maintainers** are the people, and teams, who may publish
  it, in the role of **publisher** or **owner**. The **maintainers
  record**, in the package's repository, lists them. An organization's
  **members record** and its **team records** do the same for its
  members and teams.
- An **attestation** is a record that one person writes to their own
  repository, saying that they approve another record: a release, or a
  new maintainers, members or team record. It names that record by
  AT-URI and CID, so it approves those exact bytes. Their PDS signs it
  with their key, which the App View does not hold
  ([Who signs what](#who-signs-what)).
- A **threshold** is how many attestations something needs, and from
  whom: a release, `threshold` of the package's maintainers, `humans` of
  them people; a change to a maintainers or members record, its
  `ownerThreshold` of owners; a change to a team, its `threshold` of the
  team's maintainers or the organization's `adminThreshold` of admins. A
  change counts under the thresholds of the record it replaces, and a
  scope's **policy** record can raise the release thresholds of every
  package in it ([Thresholds](#thresholds)).
- A **membership entry** is one person's line in a members or team
  record, or a maintainers record: their DID, their role, and a
  **salt** of 32 random bytes. The entry is private. The record lists
  only its **commitment**: the CID of the entry, which is a SHA-256 hash
  of it. Given the entry, anyone can check that it is the one the record
  lists. Given only the commitment, the salt keeps anyone from finding
  out whose it is by trying DIDs ([Private membership](#private-membership)).
- **Pending**: a release, or a change to a maintainers, members or team
  record, that the App View holds outside the repository until its threshold
  has attested it. Nothing reads it but its approvers.
- An **automation account** is an account the App View makes for CI to
  publish as. Its attestations count only together with a person's.
- The **checksum log** is a public, append-only log, run by the Zena
  project, of every release's content and of who approved it. Clients
  check releases against it ([The checksum log](#the-checksum-log)).

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
- **A handle** is for finding a package. `zena pkg add` resolves it to a DID
  once and records the DID, so a handle that later points elsewhere
  changes nothing that depends on the package. The index shows handles.

Only handles are scarce, and the compiler and the lockfile never see
them, so the rules below are about finding packages.

**Scopes on an App View.** A package's handle on an App View always has a
scope: `<package>.<scope>.<domain>`, such as
`router.acme.pkg.zena-lang.dev`. A name one label below the App View's
domain, `acme.pkg.zena-lang.dev`, is the handle of a scope, which is an
organization account (see
[Maintainers, teams and organizations](#maintainers-teams-and-organizations)).
A person's scope is an organization with them as its only owner. No
package has a name directly under the App View's domain, so no one can
take a short name for a package. A package is created in a scope by the
scope's admins, or by a team they allow. Scope names on an App View are
first come, first served, so names can be taken only as scopes, and only
on that App View's domain.

**Domains as scopes.** A handle is a domain name, so any domain a
package's maintainers control can hold its handle: `router.pkg.acme.com`,
or `router.acme.com`. The maintainers publish the `_atproto` DNS records,
or delegate a subdomain to the App View. No one else can take those names,
and they stay with the package when it moves to another App View. An
organization with a domain should use it; an App View's scopes are for those
without one.

**The `@scope/name` shorthand.** `zena pkg add @acme/router` means
`router.acme.pkg.zena-lang.dev`: the name in the scope on the default
domain, which a user or a workspace can change. A scope on another domain
is mapped to it by name, in `zena-package.json` or the user's
configuration:

```json
{"scopes": {"@widgets": "widgets.alt-pkg.org"}}
```

`@widgets/foo` then means `foo.widgets.alt-pkg.org`, and never anything
on another domain. A full handle, as in `zena pkg add router.acme.com`, needs
no scope. `zena pkg add` prints the DID, handle and maintainers it resolved
before it writes anything.

The shorthand does not try several domains in turn. If it did, someone
who registered `widgets` on a domain tried before the scope's own would
take over every new `zena pkg add @widgets/foo`, and nothing would fail to
show it. This is the dependency confusion that pip's `--extra-index-url`
allows. If several default domains are ever needed, `zena pkg add` should
resolve a scoped name on all of them and stop with an error when more
than one answers. A scope that appears on a second domain then turns
working adds into errors, and not into adds of another package.

**Serving handles.** atproto checks a handle with a DNS TXT record at
`_atproto.<handle>` or with `https://<handle>/.well-known/atproto-did`,
and prefers DNS when the two disagree. An App View's package handles are
two labels below its domain, and a wildcard TLS certificate covers one
label, so answering over HTTPS would need a certificate per scope. Let's
Encrypt issues 50 per registered domain per week. The App View answers
with DNS instead, from a managed DNS service: its domain's zone is kept
there, Cloud DNS for the Zena project's App View, and the App View writes
a TXT record for a name when it gives the name to an account, and removes
it when the name goes. A DNS server of the App View's own would need
machines that answer UDP, which Cloud Run cannot, in at least two places,
and would make the App View's uptime every handle's. The scopes and names
the App View keeps are the records' source, and it can write them again
from those. A scope's admins decide which DID each of its names points to,
and a handle is valid only when that DID's document names the handle back.
So a scope's names need not belong to packages hosted there, and a package
that moves to another App View can keep its handle.

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
same rules, and an App View reserves some, such as `www` (see
[Scopes](#scopes)).

## Records

The record schemas are named under `dev.zena-lang.package`, after the
Zena project's domain, `zena-lang.dev`. They are published as lexicons at
that domain. The profile, releases and retractions are below. The maintainers
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

### Retraction

A retracted version stays available. `zena pkg add` and `zena pkg update` skip it
when they pick the newest version, and a build whose dependencies require
it still uses it, with a warning. Retracting writes a record:

```json
{
  "$type": "dev.zena-lang.package.retraction",
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

An archive holds the files the manifest's `files` list publishes, or
without one every file under the package's directory but its tests
([package-manifest.md](package-manifest.md#files)). It never holds
hidden files (a name starting with `.`), `node_modules`, the workspace's
`zena-lock.json`, or the directories of packages nested in it, which have
their own `zena-package.json` and are published on their own. The App View
refuses an archive that holds any other file, or lacks a library's entry
file that the manifest exports.

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

`zena pkg add` takes a DID, a handle or `@scope/name` (see
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
used until someone asks, by running `zena pkg update`.

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
every CID needed to reproduce it. `zena pkg add` and `zena pkg update` write it:

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
Writing it again checks the old pins against the new
([Lockfiles](#lockfiles)).

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
5. Checks the release against its source archive (see below).
6. Stores everything in the local cache.

### Validating releases

A release is checked in three places, by one set of rules
(`package-manager:validate`). `zena pkg publish` checks before it uploads
anything. The App View checks before it records a release, since it
trusts no client. A fetch checks too, since a package can be kept on any
PDS, where nothing checked what was written. The rules:

- **The archive is the artifact.** It is the size and CID the release's
  source artifact gives, with the MIME type `application/vnd.ipld.car`,
  and it unpacks under the archive rules (see Source archives).
- **Its manifest agrees with the release.** It has a `zena-package.json`
  with the release's version, no `wit` dependencies, and the same
  dependencies by local name as the release; a path dependency is in the
  release as the DID and version its package has. A `did`, when the
  manifest has one, is the package's.
- **When publishing, the manifest has the profile's name.** A fetch does
  not check this, since a package renamed later keeps its older releases.
- **When publishing, every dependency is a release that exists and is not
  retracted.** A fetch does not repeat it: resolving the release's
  dependencies already fails on one that does not.
- **When publishing, the manifest has a description and a license**, an
  SPDX expression such as `MIT` or `(MIT OR Apache-2.0)`, as crates.io
  requires: every package states what it is for and on what terms it may
  be used. `zena pkg publish` checks this before it creates a package, whose
  profile then carries both. A fetch does not, so releases published
  before the rule stay usable.

The App View answers a release that breaks one with `InvalidRelease`,
listing every problem.

## Immutability

A publisher controls their repository and can edit or delete a release
record, or move the package to a PDS that permits anything. The package
manager cannot prevent such an edit. It makes the edit visible, and keeps
it from reaching anyone who has used the release or checked it against the
log. There are four layers.

### Lockfiles

The lockfile pins the CID of each release record and artifact. A build
from an existing lockfile gets those bytes or fails.

`zena pkg add` and `zena pkg update` select versions again, from the network, so
they compare the new pins with the old. A package pinned at the version
it was before, with another release or source CID, was changed in place,
and the command refuses, writing nothing and naming the old and the new
CIDs, unless it is given `--allow-changed`. Each command also prints what
it changes in the lockfile: packages added and removed, versions raised
and lowered, and releases changed in place. This guards only what the
lockfile already pins; the checksum log below guards the rest.

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
  keeps. `zena pkg publish` looks up the new version, so the log records the
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

The **App View** is a service that does this for maintainers. Its
methods, named `dev.zena-lang.registry.*`, create package, organization and
automation accounts on request, and let their maintainers publish to them
as themselves. Maintainers sign in with their own atproto account, the
one they use for Bluesky or any other app, and no one has a password for
a package account. The App View:

- mints each account's DID, and holds its rotation key ([Keys](#keys));
- creates the account on a PDS, which stores the account's repository
  and holds its signing key ([Managed accounts](#managed-accounts));
- writes the account's records, after checking the caller's role and the
  thresholds, and is the only one that writes to the account;
- keeps what is private: the entries behind commitments, and the releases
  and changes waiting for their attestations;
- moves an account from one PDS to another
  ([Moving to another PDS](#moving-to-another-pds));
- indexes package records across PDSes, from the firehose, for search,
  dependents and the site's pages ([The index](#the-index)).

The PDS stores the account and knows nothing about packages, beyond the
limits it sets on what a managed account holds. To relays, other
AppViews and other PDSes, a package account is an ordinary account: they
read its repository from its PDS with `com.atproto.sync.*`, and never
call the App View. The App View's methods are XRPC methods like any
other. It serves them at its own endpoint, and its service DID document
lists them as a service, `#zena_registry`, so that a client can also
call them through its own PDS with `atproto-proxy`.

The Zena project runs its App View, which also serves the site, at
`pkg.zena-lang.dev`, and a PDS for its accounts, written in Zena, at
`padstone.zena-lang.dev` ([Names and addresses](#names-and-addresses)).
Anyone can run another App View with the same lexicons, and keep its
accounts on padstone, on a PDS of their own, or on any PDS that will
create accounts for it.

The `zena` command reads packages from any PDS, since reading needs only
`com.atproto.sync.*` and the checks in
[Fetching and verification](#fetching-and-verification). A package can
also leave its App View for an ordinary account on any PDS that accepts it
([Moving to another PDS](#moving-to-another-pds)), keeping its DID, its
releases and its dependents. Publishing to a package on an ordinary PDS,
with that account's own credentials and the maintainers' attestations,
uses the same records, but the `zena` command does not implement it. That
is left to whoever wants it. What the design guarantees is that no
package depends on the Zena project's App View to stay readable or to leave.

### Managed accounts

The App View keeps its accounts on PDSes. Padstone offers **managed
accounts**: accounts it creates for an App View its operator trusts,
with no email address, password or invite code, and which only that App
View writes to.

- **Creating one.** The App View holds the DID's rotation keys and the PDS
  holds its signing key, so creating an account takes two calls to the
  PDS around one PLC operation. The App View first calls
  `com.atproto.server.reserveSigningKey` with a service-auth token of its
  own, and the PDS makes a signing key and keeps it for that App View for
  a few minutes. The App View mints the DID with a PLC genesis operation,
  signed with its rotation key, that names the reserved key, the PDS as
  the account's PDS, and itself as `zena_registry`. It then calls
  `com.atproto.server.createAccount` with that DID and another token of
  its own. The PDS creates the account when the DID's genesis operation
  was signed by the rotation key of the App View the token is from, which
  its operator trusts, the DID document names the PDS, and the signing
  key it names is one the PDS reserved for that App View. A reserved key
  makes one account. The genesis operation is the DID's only operation.
- **Writing.** The PDS takes a write to a managed account, through
  `com.atproto.repo.applyWrites`, `putRecord`, `deleteRecord` and
  `uploadBlob`, only with a service-auth token from the account's App
  View, for that method and addressed to the PDS. No secret for the
  account is stored anywhere, and there is no email address that could
  reset a password.
- **What it holds.** The PDS limits what a managed account holds,
  whoever writes it, so that an account it created on an App View's word
  holds packages and nothing else: records only in `dev.zena-lang.*`
  collections, and blobs only of the types a release artifact can be, up
  to a size its operator sets. The App View checks the same, and more,
  before it writes
  ([What a package account can do](#what-a-package-account-can-do)).

Any PDS can offer managed accounts to an App View its operator trusts,
and the limits on them are that operator's.

On a PDS without managed accounts, such as the reference PDS a person or
an organization runs, the App View creates an ordinary account. It needs
an invite code from the PDS's operator, an email address unique to the
account on a domain the App View controls, and a password, which the App
View keeps encrypted. Whoever reads that address can reset the password,
so the App View guards the mailbox as it guards a key. The account works
the same way otherwise. bsky.social asks for a phone number for every
account, and would make every package a Bluesky user, so packages do not
go there.

The App View is the only writer to its accounts, so on padstone, and on a
PDS whose operator the App View trusts, holding a release or a change
until it is attested is enforced where the records are written. The
operator of a PDS holds the signing keys of the accounts on it, and can
write to them without the App View. For a package on a PDS someone else
runs, the guarantee that a release counts only with its maintainers'
attestations comes from the clients and the log, which check the
attestations ([What the records guarantee](#what-the-records-guarantee)),
as they do for every package.

### Keys

| Key or credential                                            | Created by                                               | Held by                                                                                                             | Controls                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A maintainer's account keys                                  | the maintainer's PDS                                     | the maintainer's PDS                                                                                                | the maintainer's repository, where their attestations are           |
| A maintainer's OAuth session: a refresh token and a DPoP key | `zena pkg login`                                         | the `zena` command, in `$XDG_CONFIG_HOME/zena/session.json`, mode 0600, or the management interface, in the browser | acting as the maintainer toward their PDS                           |
| The package's signing key                                    | the package's PDS, when the App View creates the account | the PDS; padstone keeps it encrypted at rest by a key in its key management service                                 | commits to the package's repository                                 |
| The App View's online rotation key                           | the App View, once                                       | the App View, in a key management service apart from its database                                                   | PLC operations for every account it creates, ranked last            |
| The App View's own signing key, which its DID document lists | the App View, once                                       | the App View, in its key management service                                                                         | its service-auth tokens to the PDSes of its managed accounts        |
| An account's password, on a PDS without managed accounts     | the App View                                             | the App View, encrypted, with the account's email address on a domain the App View controls                         | writing to that account                                             |
| The App View's offline rotation key                          | the operator, once                                       | the operator, offline                                                                                               | PLC operations, ranked above the online key, to undo what it signed |
| Recovery keys, if the owners add them                        | a maintainer                                             | up to three maintainers, in a hardware key, the OS keychain, or `$XDG_CONFIG_HOME/zena/recovery-key`, mode 0600     | PLC operations, ranked above the App View's keys                    |
| Approval keys, if a maintainer adds them                     | the maintainer, as passkeys or security keys             | the maintainer's devices                                                                                            | nothing alone: they countersign that maintainer's attestations      |
| CI credentials: an automation account's token                | the App View, when a maintainer asks                     | the CI system, as a secret                                                                                          | publishing as a bot maintainer                                      |

Keys are secp256k1, the curve the reference PDS uses. A maintainer uses
the same recovery key for every package they hold one for.

The App View and the account's PDS are together the custodian of the
accounts the App View creates, as Bluesky's PDS is of the accounts on it:
the PDS holds the signing key, the App View holds the rotation keys that
control the DID and decides every write, and no maintainer has to keep a
key. The two kinds of key are separate because they are used differently.
A signing key signs every commit, so it is in use all the time. A rotation
key signs only the rare change to a DID document, so it can be kept where
using it is slow and stealing it is hard, and it is what replaces a
signing key that leaks.

Padstone's database holds each signing key encrypted by a symmetric key
in the key management service, with the account's DID bound to the
ciphertext so that it decrypts as no other account's key. The PDS
decrypts a key when it first signs with it, and keeps it in memory. A
copy of the database, such as a backup or an export, then holds no key
that signs: decrypting one needs the key service as well, where only the
PDS's own service account may use that key. A leaked signing key would
let its holder write releases, but not attestations, so none of them
would count ([What the records guarantee](#what-the-records-guarantee));
the encryption is defence in depth.

Releases do not depend on who holds the rotation keys. A release counts
only with its maintainers' attestations, which the log checks (see
[Who signs what](#who-signs-what)), so whoever controls a DID still cannot
publish a release that counts. The rotation keys decide the DID document:
which PDS stores the package, its signing key, its handle, and which App
View manages it. Recovery keys let a package's owners decide those without
the App View: undo what the App View signs, and leave an App View that
will not move them or has gone. They suit organizations and widely used
packages, kept in a hardware key or the OS keychain. A key in a file on a
laptop is what malware looks for, and a thief with the first-ranked key
takes the DID beyond anyone's reach, so `zena` does not make one unasked.

There is no maintainer's own key for signing releases. In atproto an
account's signing key is held by its PDS, not by the person, and this
design does not add one.

### Scopes

`zena pkg scope create`, `zena pkg scope info`, the manifest's `scope` and the
operator's `create-scope` are built (#575), and so are the membership
commands below (#576).

A scope is an organization account on an App View, whose handle is one
label below the App View's domain (see
[Names and scopes](#names-and-scopes)). A person's packages go in a scope
with them as its only owner, and an organization's packages in a scope its
owners share.

**Creating a scope.** `zena pkg scope create acme` asks the App View for the
organization, with `dev.zena-lang.registry.createOrganization`, with the
caller as its only owner. Like `zena pkg publish`, it names the handle it
would create, `acme.pkg.zena-lang.dev`, and stops, and `--yes` creates
it. It prints the scope's DID and handle.

Publishing does not create scopes. A publish that names a scope the App View
does not have stops, and says to create it with `zena pkg scope create`. If
publishing created it, a mistyped `--scope` would make a scope no one
meant to have, and take its name.

**Which scope a package is in.** The manifest's `scope` names it:

```json
{"name": "router", "scope": "acme", "version": "1.4.2"}
```

The first publish creates the package in that scope, and `--scope` gives
one for a manifest without it. A workspace root's `scope` is the default
for its workspace packages (see
[package-manifest.md](package-manifest.md#scope)). The manifest's `name`
stays the package's own name, without the scope, since it is also the
name dependents import it by, and a DNS label. `@acme/router` is only
`zena pkg add`'s shorthand for a handle.

Once the package exists, its DID decides where it is, and `scope` is a
check. `zena pkg publish` resolves the DID's handle, and refuses when it is
not `<name>.<scope>.<domain>`, naming both. That catches a manifest
copied from another package, and a package renamed or moved without its
manifest following. A package whose handle is on a domain its maintainers
control has no `scope`.

**Seeing a scope.** `zena pkg scope info <scope>` takes the scope's name,
handle or DID, and prints its DID, its handle, the thresholds of its
members record, and the caller's role in it. `zena pkg scope members` prints
the members the caller may see (see
[Adding and removing people](#adding-and-removing-people)). The index
lists the packages in a scope, by their handles.

**Reserved scopes.** An App View keeps some scope names from everyone:
`www`, `api`, `admin`, `zena`, `pkg` and `mail`, and those its operator
adds. The operator creates a scope with one of those names, for the
project that runs the App View, with a command run with the App View's own
configuration, as `sync-handles` is:

```sh
zena run packages/registry/zena/main.zena -- create-scope zena \
  --owner did:plc:... --recovery-key did:key:...
```

The command is not an XRPC method, so nothing a caller can send takes a
reserved name, and it needs no credentials the server does not already
have. The scope's owner then manages it as any other. Which reserved
scopes the Zena project's App View creates, and which packages go in `zena`,
is still open.

### Creating a package

The first `zena pkg publish` of a package creates its account, after asking:
it names the handle it would create and stops, and `--yes` creates it.
The package is created in the scope the manifest's `scope` or `--scope`
names, which must exist (see [Scopes](#scopes)). `zena pkg create`
does only this, for scripts.

The App View is `--registry`, else `ZENA_REGISTRY`, else the Zena
project's, `https://pkg.zena-lang.dev`. `zena` reads its service DID and
the domain its handles are under from its
`dev.zena-lang.registry.describeRegistry`, and checks that the DID is the App
View's own before asking for any token addressed to it. A `did:web` must
name the App View's origin, which only that domain can hold. A `did:plc`'s
document must name the origin as its `#zena_registry`. Otherwise a
server at any origin could answer with the real App View's DID, and replay
the tokens it was given to the real App View.

1. **Sign in.** Once per machine, `zena pkg login` signs the maintainer in to
   their own PDS with atproto OAuth, through the browser and a redirect to
   a port on localhost. It asks for one permission set,
   `dev.zena-lang.authPublish`, which allows writing attestation records
   and calling the App View's methods. The App View's methods are `rpc`
   permissions, which cover `com.atproto.server.getServiceAuth`. Until
   the command implements OAuth, `zena pkg login` signs in with an app
   password instead, which allows the same calls and can be revoked on
   its own.
2. **Recovery keys, if any.** When the maintainer keeps a recovery key,
   `zena` passes its public key. It does not make one: without it, the
   App View's keys are the package's only rotation keys (see [Keys](#keys)).
3. **A token for the App View.** `zena` asks the maintainer's PDS for a
   service-auth token with `com.atproto.server.getServiceAuth`, addressed
   to the App View's DID, for the method `dev.zena-lang.registry.createPackage`.
   The token is a short-lived JWT signed with the maintainer's account
   key. The App View checks it against the maintainer's DID document, so it
   knows which account the request is from without a password of its own.
   Every later call to the App View is made the same way.
4. **The DID.** `zena` calls `dev.zena-lang.registry.createPackage` with the
   scope's organization, any recovery keys, the profile and the
   maintainers record. The App View has its PDS reserve the account's
   signing key, writes the genesis operation, signs it with its online
   rotation key, submits it to the PLC directory, and creates the account
   on its PDS ([Managed accounts](#managed-accounts)). The genesis
   operation is:

   ```json
   {
     "type": "plc_operation",
     "rotationKeys": [
       "did:key:zQ3sh...(the maintainer's recovery key, if they keep one)",
       "did:key:zQ3sh...(the App View's offline rotation key)",
       "did:key:zQ3sh...(the App View's online rotation key)"
     ],
     "verificationMethods": {
       "atproto": "did:key:zQ3sh...(the package's signing key, which the PDS holds)"
     },
     "alsoKnownAs": ["at://router.acme.pkg.zena-lang.dev"],
     "services": {
       "atproto_pds": {
         "type": "AtprotoPersonalDataServer",
         "endpoint": "https://padstone.zena-lang.dev"
       },
       "zena_registry": {
         "type": "ZenaRegistry",
         "endpoint": "https://pkg.zena-lang.dev"
       }
     },
     "prev": null,
     "sig": "..."
   }
   ```

   The DID is the first 24 characters of the base32 SHA-256 hash of the
   signed genesis operation. A new package's DID document therefore names
   padstone as its PDS, the key padstone holds as its signing key, and its
   App View as `zena_registry`, and lists the maintainer's recovery
   key, if any, ahead of the App View's two rotation keys.

5. **The repository.** The App View writes the account's first records
   through its PDS: the profile, from `zena-package.json`, and a
   maintainers record listing the maintainer, which `zena` attests. The log takes a package's first
   maintainers record once as many of the maintainers it lists as its
   threshold have attested it.
6. **The manifest.** `zena` writes the DID into `zena-package.json` as
   `"did"`, so that later publishes go to the same package, and goes on to
   publish the release.

The handle, `router.acme.pkg.zena-lang.dev`, is the name in the scope the
maintainer asked for. See [Names and scopes](#names-and-scopes).

### Publishing a release

1. `zena pkg publish` builds the artifacts and the release record. The
   release's dependencies are those in the package's manifest, with each
   path dependency replaced by the depended-on package's DID and the
   version the workspace uses
   ([package-manifest.md](package-manifest.md#publishing-a-workspace-package)).
   The record's CID is known before it is written, since it is the
   record's hash.
2. It uploads the artifacts (`dev.zena-lang.registry.uploadArtifact`), and
   calls `dev.zena-lang.registry.publish` with the record, each with a
   service-auth token as above. The App View checks everything a fetch will:
   that the caller is a maintainer, the archive against the record and
   its manifest, the dependencies, and that the version is free. The
   client's own checks only save a round trip. The App View then holds the
   release as **pending**, outside the package's repository, which
   reserves the version, and answers with the AT-URI and CID its record
   will have.
3. `zena pkg publish` writes an attestation of that AT-URI and CID to the
   maintainer's own repository. An attestation names a record by its hash,
   so it can be made before the record exists.
4. It calls `dev.zena-lang.registry.completeRelease`. The App View reads the
   attestation of each of the package's maintainers from their own
   repositories, checks each against the signing key in the maintainer's
   DID document, and counts them against the maintainers record (see
   [Thresholds](#thresholds)). Once they are enough, it writes the release
   record through the package's PDS, and only then is the release in the
   package's repository, its PDS's firehose, the index, and what
   `zena pkg add` and `zena pkg update` choose from.
5. Otherwise the release waits. The other maintainers see it on the
   package's page and their `/me` page, and with
   `zena pkg approve <package>@<version>`, which shows the release
   (`dev.zena-lang.registry.getPendingReleases`), writes the maintainer's
   attestation, and calls `completeRelease` again. A pending release
   expires after seven days, which frees its version, and its publisher
   or an owner can withdraw it sooner
   (`dev.zena-lang.registry.withdrawRelease`).
6. `zena pkg publish` looks the version up in the checksum log, which records
   it.

With the usual single maintainer and a threshold of 1, steps 2 to 4
happen within one `zena pkg publish`. Holding a release back, rather than
writing a record that says it is pending and changing it later, keeps
release records unchanged once written, so nothing that reads them needs
to know a release can be pending, and the checksum log's
`release-mutated` label keeps its meaning.

`zena pkg retract <version>` writes a retraction record, by any one
maintainer, without waiting: a retraction stops new builds from choosing
a release and changes no one's existing builds.

Publishing changes the package's repository and not its DID document. The
DID document changes only when the package moves to another PDS or another
App View, its handle changes, its signing key is replaced, or recovery
keys are added or removed. Each of these is a PLC operation, signed with a
rotation key.

CI publishes as an automation account: a maintainer marked `automation`,
which an organization's App View creates on request, from `zena pkg ci create`
or the management interface. It is a managed account like the package's,
so no one signs in to it at its PDS. Its credential is a token the App
View issues once, which the CI system keeps as a secret, and with which
`zena` calls the App View's methods as the automation account. The App
View writes the automation account's attestations itself, so an
attestation from it is one the App View could make alone. The App View
therefore counts an automation account it holds only together with at
least one person's attestation, and so does the log; an automation account
on another PDS, whose owner writes its attestations, counts like any
maintainer. A package's owners add it with
`zena pkg owner add <handle> --automation`, as a publisher: the App View
refuses an automation account that is not marked as one, or that is an
owner, since an owner chooses the maintainers. Since the App View verifies
the token itself, it could also take a CI system's own identity token in
its place, as npm and PyPI take GitHub's OIDC tokens; that is an open
question.

### Who signs what

- The **release record** is signed as part of a commit to the package's
  repository, with the package's signing key. The package's PDS holds that
  key, and writes to the account only for its App View, so this signature
  shows that the App View wrote the release, or the PDS's operator did, and
  not who asked it to.
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

The App View writes a release record only once its maintainers have attested
it (see [Publishing a release](#publishing-a-release)). The checksum log
checks again, independently: it fetches the attestations when it records
a release, and records the release only when the package's threshold of
maintainers have attested it. So an App View that wrote a release record
without them, compromised or misconfigured, writes one the log refuses.
Clients already check releases against the log, so they rely on
attestations without fetching them, and anyone can fetch them to audit
the log. A release in the log was approved by the package's maintainers,
each through a PDS they chose, and the App View cannot make one alone.
An App View that also holds the maintainers' own accounts could, which
is why the Zena project's App View holds package and organization accounts,
and automation accounts that cannot publish without a person (see
[Publishing a release](#publishing-a-release)), and no one's own account.

### What the records guarantee

The App View decides every write to the package, organization and automation
accounts it creates, and their PDS signs what it writes, so a signature by
one of those accounts shows only that the App View, or the PDS's operator,
wrote the record. The design is meant to work without trusting either of
them to approve releases or choose who may approve them. Three kinds of
public records make that possible:

- **Attestations**, in each approver's own repository, signed by their
  own PDS. The App View cannot write one for a person whose account it does
  not hold.
- **The policy**: the maintainers record of each package, and the
  members, team and policy records of each organization. They say who may approve
  what, and how many approvals each thing needs. They are public records
  in the account's repository, because whoever checks an approval has to
  read them: an approval is enough or not only against a threshold, and
  an attester counts only in a role. If the App View kept them in its own
  storage, a checker would have to take its word for both.
- **A chain of changes to the policy.** A new maintainers, members or team
  record counts only when the roles and thresholds of the record before it
  have attested it. So the App View cannot lower a threshold, add an
  owner, or put an account on a team without the attestations of those who
  could already decide that. Teams make this matter for releases: a
  package a team maintains accepts attestations from whoever is on the
  team, so a team record the App View could change alone would let the App
  View choose who approves the package's releases.

Membership is in the policy too, but only as commitments (see
[Terms](#terms) and [Private membership](#private-membership)). The
records show how many people are in each role and what each threshold
is, and not who they are. A person is revealed only when they attest
something, and their attestation then has to carry their entry.

Two parties check the same rules:

- **The App View**, first. It holds a release or a change outside the
  repository until its threshold has attested it, and writes it only then
  (see [Publishing a release](#publishing-a-release) and
  [Adding and removing people](#adding-and-removing-people)). Until then
  the record before it decides every role on the App View. So the
  repository, its PDS's firehose and the index only ever hold approved
  records, and nothing that reads them needs to know that records can be
  pending. The checks of a misconfigured or compromised App View could be
  wrong or missing, and the operator of a PDS the App View does not trust
  can write around them ([Managed accounts](#managed-accounts)).
- **The checksum log**, again and independently. It reads the
  attestations from the approvers' own repositories and the policy from
  the records it has recorded, and records a release, or a change to the
  policy, only when the rules allow it. Clients check every release
  against the log. Anyone can repeat the log's checks from the same
  public records to audit it.

What this guarantees, with the log running:

- A release a client accepts was attested by the package's threshold of
  maintainers, `humans` of them people, each through a PDS they chose,
  under the maintainers record the log held when it recorded the
  release.
- Every maintainers, members and team record behind that was approved by
  the record before it, back to the records the package and its
  organization were created with.
- Neither the App View nor the package's PDS alone can make a release count,
  or make an account count as a maintainer, owner, admin or team member.
- A pending release or change is in no repository, so it cannot reach a
  client.

What it does not guarantee:

- **Before the log exists**, the App View's check is the only one. The
  records make that check possible to audit, and nothing audits it yet.
- **Availability.** The PDS can refuse to serve a package, and the App View
  can refuse to write an approved change. Pins in lockfiles, and moving
  the package to another PDS or another App View, are the answers
  ([Trusting an App View](#trusting-an-app-view)).
- **The DID.** PLC has no thresholds. A recovery key, or the App View's own
  rotation key for a package without recovery keys, can act alone
  ([Thresholds](#thresholds)).
- **Privacy from the App View.** It keeps every entry, and its admins can
  read them. The entries are private from the public, not from the
  App View.
- **An approver's own account.** Someone who takes over a maintainer's
  account can attest as them. That is what approval keys and the
  `humans` threshold are for
  ([Human approval and second factors](#human-approval-and-second-factors)).

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
- **An organization** is an account of its own on an App View, with
  four kinds of record:
  - `dev.zena-lang.org.members`, at `self`: who belongs to the
    organization and in which role, and the thresholds for changing its
    members and its teams;
  - `dev.zena-lang.org.team`, one per team, keyed by the team's name:
    who is on the team and in which role;
  - `dev.zena-lang.org.policy`, at `self`: the scope's policy for its
    packages. Its minimums apply to every release in the scope at once: a
    release needs the larger of its maintainers record's `threshold` and
    the policy's `minimumThreshold`, and of `humans` and `minimumHumans`.
    The App View refuses a maintainers record that could not meet them. Its
    defaults, the teams and thresholds a new package's maintainers record
    starts with, are what `zena` uses when it creates one. Its `creators`
    are the teams whose members may create packages in the scope, besides
    its admins;
  - `dev.zena-lang.org.profile`, at `self`: how the scope presents
    itself, with a display name, a description and a website. It decides
    no one's role, so its admins write it at once, with
    `zena pkg scope profile`.

  The members and team records list their members privately, as
  [Private membership](#private-membership) describes. An organization's
  handle on its App View is a scope, and its packages' handles are in it. A
  package maintained by a team names the organization, the team and the
  team's role on the package, and every member of the team has that role.
  Changing who is on a team changes it for every package the team
  maintains. The packages an organization creates list the recovery
  keys its owners keep, if they keep any, rather than one person's.

#### Roles

| Record                    | Role       | Can                                                                                              |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| a package's maintainers   | publisher  | attest releases, and retract them                                                                |
|                           | owner      | also attest changes to the maintainers record, and edit the profile, rename and move the package |
| an organization's members | member     | be put on teams                                                                                  |
|                           | admin      | also create packages in the organization's scope, create teams, and attest changes to them       |
|                           | owner      | also attest changes to the members record, and hold its recovery keys, if it has any             |
| a team                    | member     | act on each of the team's packages in the role the package gives the team                        |
|                           | maintainer | also attest changes to the team                                                                  |

The log checks roles for everything that decides which releases count:
releases, and changes to maintainers, members and teams. The App View checks
the same records for the rest: profile edits, renames, moves, retractions,
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
- **The App View keeps the entries.** It gives each member their own entry,
  an organization's owners and admins every entry, and a team's
  maintainers their team's. The App View's own admins, whom its operator
  names, see every entry, as the operator could read them from the store
  anyway; the entries are private from the public, not from the App View.
- **Acting reveals the entry.** An attestation that relies on a
  membership includes the entry, and the log checks it against the
  commitment. A member becomes known in a role when they first act in
  it, and not before.
- **The App View cannot add members unseen.** A new members or team record
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
  interface asks the App Views instead.

**Separate maintainer accounts.** A maintainer need not use the atproto
account they use elsewhere. Someone who wants their maintenance kept
apart from their public identity can make an account just for it, on any
PDS but the package's, so that its record of approvals points to no one
in particular.

#### Adding and removing people

Each command names a person by handle or DID, and changes one record
through the App View:

| Command                                                                       | Record                    | App View method  |
| ----------------------------------------------------------------------------- | ------------------------- | ---------------- |
| `zena pkg scope add <scope> <person> --role <role>`                           | the scope's members       | `putMembers`     |
| `zena pkg scope remove <scope> <person>`                                      | the scope's members       | `putMembers`     |
| `zena pkg team create <scope>/<team>`                                         | a new team                | `putTeam`        |
| `zena pkg team add <scope>/<team> <person> --role <role>`                     | the team                  | `putTeam`        |
| `zena pkg team remove <scope>/<team> <person>`                                | the team                  | `putTeam`        |
| `zena pkg team delete <scope>/<team>`                                         | the team                  | `deleteTeam`     |
| `zena pkg owner add <person> --role <role>`                                   | the package's maintainers | `putMaintainers` |
| `zena pkg owner add --team <scope>/<team> --role publisher`                   | the package's maintainers | `putMaintainers` |
| `zena pkg owner remove <person>`                                              | the package's maintainers | `putMaintainers` |
| `zena pkg scope settings <scope> --owner-threshold <n> --admin-threshold <n>` | the scope's members       | `putMembers`     |
| `zena pkg team settings <scope>/<team> --threshold <n>`                       | the team                  | `putTeam`        |
| `zena pkg scope policy <scope> --minimum-threshold <n> ...`                   | the scope's policy        | `putPolicy`      |
| `zena pkg owner settings --threshold <n> --owner-threshold <n> --humans <n>`  | the package's maintainers | `putMaintainers` |

The roles are those of [Roles](#roles), and `member` or `publisher` when
`--role` is left out. The `settings` commands change a record's
[thresholds](#thresholds) and keep its people; each flag left out keeps
its value, and with none they print the thresholds. A change to a
threshold is approved under the thresholds it replaces, so raising
`ownerThreshold` from 1 to 2 needs one owner, and lowering it back needs
two. The `owner` commands act on the package in the
current directory, or on the one `--package` names by DID, handle or
`@scope/name`. `zena pkg scope members <scope>`, `zena pkg team members` and
`zena pkg owner list` print the entries the caller may see.

Each change takes the same steps:

1. `zena` reads the record and its CID from the account's repository, and
   the entries behind its commitments from `getEntries`.
2. It makes the new person's entry, with a new salt and no approval keys,
   or leaves out the one being removed, and builds the new record from
   the entries' commitments.
3. It calls the App View's method with the new record, the entries, and the
   CID it read. The App View refuses when the record has changed since, so
   two owners editing at once do not overwrite each other unseen. It
   checks the new record as it will be read, and holds it as pending,
   outside the repository, answering with the AT-URI and CID it will
   have.
4. It writes an attestation of that AT-URI and CID to the caller's own
   repository.
5. It calls `dev.zena-lang.registry.completeChange`. The App View counts the
   attestations against the record before it (see below). Once they are
   enough, it writes the new record, and only then does the change take
   effect, on the App View and in the repository. With thresholds of 1, the
   caller's own attestation is enough, and steps 3 to 5 happen within one
   command.

A new member adds their own approval keys later, in the management
interface.

A change counts once the roles and thresholds of the record before it
have attested it. Only people count; automation chooses no one's roles.

| Change to                 | Attested by                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| an organization's members | its `ownerThreshold` of owners                                                                          |
| an organization's policy  | the members record's `ownerThreshold` of owners                                                         |
| a team                    | the team's `threshold` of its maintainers, or the organization's `adminThreshold` of admins and owners  |
| a new team                | the organization's `adminThreshold` of admins and owners                                                |
| a package's maintainers   | its `ownerThreshold` of owners, listed by DID, by commitment, or as members of a team in the owner role |

So one owner of a package whose `ownerThreshold` is 2 cannot replace the
others, and until the others approve, the record before the change
decides every role: the owner being removed is still an owner. The
others see a waiting change with `zena pkg approve @acme` or
`zena pkg approve <package>` (`dev.zena-lang.registry.getPendingChanges`), which
shows the entries added and removed and the thresholds changed first,
and with `--yes` writes their attestations and calls `completeChange`.

- **One change waits per record.** Asking for another change to the same
  record replaces the one waiting, and the attestations of the first
  count for nothing toward it, since they name its CID.
- **A change made from a record that has changed since is dropped**, as
  when its team was deleted. The roles that were to approve it may have
  changed, so it is asked for again.
- **A change waits seven days**, and the one who asked for it, or anyone
  who sees every entry behind the record, can withdraw it sooner
  (`dev.zena-lang.registry.withdrawChange`).
- **Creating** an organization or a package writes its first members or
  maintainers record at once, with its creator as its only owner. There
  is no record before it to approve it. **Deleting** a team is done by an
  admin at once, and takes the team's part in its packages away; it adds
  no one.

The log records each change that counts. A release counts under the
maintainers record the log held when it recorded the release, so someone
who leaves cannot attest new releases, and the releases they attested
stay valid.

Someone who leaves and holds a recovery key must also lose the key: the
remaining holders remove it from the DID's rotation keys with a PLC
operation. A higher-ranked rotation key can undo an operation signed by a
lower-ranked one within 72 hours, so the removal is signed with a recovery
key ranked above the departing one, not with the App View's key, which ranks
last. The first rotation key should be the one trusted most, such as an
organization's offline key.

Nothing records which rotation key is whose, so `zena pkg scope remove` and
`zena pkg owner remove` cannot yet tell whether the person removed holds one.
Recording the holder's recovery key in their private entry would let the
command find it, and prepare the PLC operation for each DID it is on, for
a holder ranked above it to sign. `zena` signs it with that holder's key
and submits it to the PLC directory itself, since the App View never holds a
recovery key.

### Thresholds

- **Releases and changes of maintainers** can require M of N
  maintainers, through attestations. The maintainers record says how
  many, per package: `threshold` attestations for a release, of which
  `humans` must come from people rather than automation accounts, and
  `ownerThreshold` owners for a change to the record. A scope's policy
  can ask more of every release in it, with minimums that apply at
  once. A new package starts with the policy's defaults, which are 1 and
  1 unless the scope sets others, so the publisher's own attestation
  meets them. A
  release with fewer attestations waits, pending on the App View and outside
  the package's repository, until `zena pkg approve <package>@<version>` adds
  enough; then the App View writes its record, and the log records it.
- **Control of the DID** cannot. PLC accepts an operation signed by any
  one rotation key, with rank deciding conflicts for 72 hours, and has no
  thresholds. The App View signs with its own rotation key only for changes
  the maintainers' threshold has attested, and for the recovery resets
  of [Recovery](#recovery), but a recovery key can act alone. A package
  should have few recovery keys, kept offline.

Threshold signatures, where several holders together act as one key, are
not planned.

### The management interface

People sign in as themselves, never as an organization or a package:
those have no passwords, and are managed through someone's role in them.
The management interface is pages on the site, `pkg.zena-lang.dev`,
rendered on the server ([Names and addresses](#names-and-addresses)). It
has no privileges of its own:

- **Signing in.** The page signs in with atproto OAuth, as a browser
  client, and the OAuth session stays in the browser. The session's DPoP
  key is a non-extractable WebCrypto key, and signing out revokes the
  session. The server learns who is signed in from a web session: the page
  asks the person's PDS for a service-auth token for
  `dev.zena-lang.registry.createWebSession`, addressed to the App View's DID,
  and trades it for an HttpOnly cookie, which stands for the person to the
  site's pages and to nothing else. It lasts a day, and the page renews it
  from the OAuth session.
- **Reading.** It reads public data from the index, or from the App View
  until there is one, or straight from a package's PDS: packages, their
  maintainers records, releases waiting for approvals, pending recovery
  resets and PLC operations. It asks each App View the person uses for the
  memberships the index cannot see: the person's own, and for an
  organization's owners and admins, the whole list.
- **Writing.** It writes attestations to the person's own repository.
  Everything else goes to the package's or organization's App View, through
  the person's PDS, which proxies the call with a service-auth token
  (`atproto-proxy`, which the `rpc` permission covers).

The pages hold nothing that can publish, attest or change a record: every
write goes through the person's PDS. While the site and the PDS run as one
service, the server that renders the pages also holds the packages'
signing keys as their custodian ([Keys](#keys)), so a compromise of that
server is a compromise of the App View. Once the site runs apart, its
server holds no keys, so a compromised site can show wrong data, and do no
more.

The interface lists a person's packages, organizations and teams with
their roles, the releases waiting for their approval, with the changes to
the source fetched by CID and shown in the browser, pending recovery
resets, each package's PLC history and which recovery keys rank where,
and the settings of each record: thresholds, `humans`, and approval keys.

How it handles keys:

- **Approval keys** are registered and used here, since passkeys are a
  browser feature, and `zena pkg approve` opens the same page. The page's
  domain is the passkeys' relying party, and must never change: a passkey
  made for one domain cannot sign for another.
- **Recovery keys** never enter the browser. WebAuthn signs only its own
  data, not a PLC operation, and a key held by a page is exposed to every
  script on it. The interface prepares PLC operations, and `zena` signs
  them, with a key from a file or a hardware key such as a YubiKey's PIV
  applet.
- **The App View's keys** never appear. The interface calls the App View's
  methods.
- **CI credentials.** Creating a CI token has the App View create an
  automation account in the organization, and shows its token once.

People approve what the interface shows them, so its code is what they
trust. It is served as static, versioned files built from open source,
with Subresource Integrity on its scripts, and `zena pkg approve` remains a
way to inspect and approve releases without it. Settings only an App View
holds, such as claims on scope names, are its operators' to review, on
the App View's `/admin` ([Finding an App View](#finding-an-app-view)).

### The App View's methods

Each of the App View's methods is a lexicon in
`packages/package-manager/lexicons/dev/zena-lang/registry/`. Every call
carries a service-auth token from the caller's PDS, addressed to the
App View's DID with the method's NSID as its `lxm`, or, from CI, an
automation account's token, and the App View checks the caller's role in the
records it already holds. A write that changes
which releases count, such as a new maintainers record, takes effect
once the attestations the previous record requires reach the log.

| Method                    | Caller                                                        | What it does                                                        |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `createOrganization`      | anyone the App View's limits allow                            | creates a scope, with the caller as its only owner                  |
| `createPackage`           | an organization's admins, or a team they allow                | creates a package with its profile and maintainers record           |
| `createAutomationAccount` | an organization's admins                                      | creates an account for CI and returns its token once                |
| `uploadArtifact`          | a package's maintainers                                       | stores an artifact, or one part of it, as a blob of the package     |
| `publish`                 | a package's maintainers                                       | checks a release and holds it, refusing a version that is taken     |
| `completeRelease`         | a package's maintainers                                       | writes a held release once its attestations are enough              |
| `getPendingReleases`      | a package's maintainers                                       | returns the held releases, with who has attested each               |
| `withdrawRelease`         | a held release's publisher, or a package's owners             | stops holding a release, which frees its version                    |
| `retract`                 | a package's maintainers                                       | writes a retraction record                                          |
| `putProfile`              | a package's owners                                            | replaces the profile                                                |
| `renamePackage`           | a package's owners                                            | changes the handle, with a PLC operation, and the profile's name    |
| `putMaintainers`          | a package's owners                                            | holds a maintainers record, with the entries behind its commitments |
| `putMembers`              | an organization's owners                                      | holds a members record, with its entries                            |
| `putTeam`                 | an organization's admins, or a team's maintainers             | holds a new or replaced team                                        |
| `putPolicy`               | an organization's owners                                      | holds a new policy for the scope's packages                         |
| `putScopeProfile`         | an organization's admins                                      | writes the scope's profile                                          |
| `deleteTeam`              | an organization's admins                                      | deletes a team                                                      |
| `completeChange`          | anyone with a role in the account                             | writes a held record once the record before it allows it            |
| `getPendingChanges`       | anyone with a role in the account                             | returns the held records, with who has attested each                |
| `withdrawChange`          | its proposer, and those who see every entry behind the record | stops holding a record                                              |
| `getEntries`              | members, owners, admins and team maintainers                  | returns the private entries the caller may see                      |

The `put` methods take the CID the record must have now, as
`com.atproto.repo.putRecord` does, so two owners editing at once do not
overwrite each other unseen.

[app-view-operations.md](app-view-operations.md) lists every
operation the App View offers or will offer, these methods among them: who
may do it, and where it is done, on the App View's pages, with `zena`, or
through a method.

Moving a package to another App View, and the recovery of
[Recovery](#recovery), have no methods yet. Both need PLC operations that
the App View signs only with the maintainers' attestations, and the rules
for that are a later revision of this design.

### Names and addresses

The Zena project's App View and PDS use three names:

- **`pkg.zena-lang.dev`** is the domain handles are under. A scope's
  organization is `acme.pkg.zena-lang.dev`, and its packages are names
  below that, such as `router.acme.pkg.zena-lang.dev`. DNS TXT records
  verify the handles, wherever the PDS runs. The same name is the address
  of **the App View**: its methods, which `zena` calls by default, its
  index, and **the site**, its web pages and management interface. Its
  DID is `did:web:pkg.zena-lang.dev`, the audience of every service-auth
  token for its methods. Its DID document lists the methods as
  `#zena_registry`, and the App View's own signing key ([Keys](#keys)).
- **`padstone.zena-lang.dev`** is the PDS, which stores the App View's
  accounts. Every package and organization account's DID document names
  it as the account's PDS, and `zena` reads packages from it. Its DID,
  `did:web:padstone.zena-lang.dev`, is the audience of the App View's
  tokens for writes to its managed accounts. A padstone is the block that
  spreads a beam's weight onto the wall below it. The name is not under
  `pkg.zena-lang.dev`, where every name is a scope's. If the project runs
  more PDSes, they take the names of other stones that carry weight in a
  building, such as corbel or lintel.
- **Staging** has the same pair: `pkg-staging.zena-lang.dev` and
  `padstone-staging.zena-lang.dev`.

The PDS has a name of its own for two reasons. Anyone with an account can
upload the blobs it serves, and on an origin other than the site's, a
blob that a browser ran as a page cannot reach the site's session cookie.
And the PDS and the App View can each move to a service of its own by
changing where a name points, with no need to route one name's paths to
two services.

| Name                     | Paths                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `padstone.zena-lang.dev` | `/xrpc/*`, for `com.atproto.*`; `/.well-known/did.json`; `/`, a page that names the PDS; later, `/oauth/*` for its authorization server, and account pages for the people whose atproto accounts it holds                                                         |
| `pkg.zena-lang.dev`      | `/`, `/packages/:handle`, `/scopes/:name` and `/people/:id`; `/me`; `/admin`, for the App View's operators; `/sign-in/*`, the site's OAuth client; `/xrpc/*`, for the App View's methods; `/.well-known/did.json`; `/assets/*` and `/docs/*`; `/plc/*` on staging |

A path asked for under the other name answers 404, so that no address
works by accident and gets shared.

Each name is a service of its own, and the two share one store, under
one tenant. Two boundaries stay in the code:

- **The App View reaches the PDS only through `com.atproto.*`**, as it
  would reach any PDS: `createAccount`, `applyWrites`, `uploadBlob` and
  the sync reads, with its own tokens for its managed accounts
  ([Managed accounts](#managed-accounts)). Each such call is one it
  could make over the network, so the two can move to services of their
  own by changing where a name points. It keeps its index of the
  accounts it holds as it writes their records.
- **The site's pages reach the App View's data only through its
  methods**, or atproto's public reads such as
  `com.atproto.repo.getRecord`, so that the methods are the one place
  that checks who may see and change what. Every change goes through a
  method as the signed-in person, with a token addressed to the App View
  ([Finding an App View](#finding-an-app-view)). The pages read a
  person's private memberships for the person the site's session names.

The site's sign-in trades a service-auth token for
`dev.zena-lang.registry.createWebSession`, addressed to the App View's DID, for
the site's session cookie ([The management interface](#the-management-interface)).

### Finding an App View

A client that manages an account finds the account's App View, and what the
App View offers, from the account's DID:

1. The account's DID document names its App View, as `#zena_registry`,
   of type `ZenaRegistry`, at the App View's endpoint. The App View
   writes that entry when it creates the account, with its rotation key.
   An account whose DID document has none is one no App View manages, and
   the site shows it without the means to manage it.
2. `dev.zena-lang.registry.describeRegistry`, at that endpoint, answers with the
   App View's DID, which must name the endpoint's origin, as `zena` checks
   ([Creating a package](#creating-a-package)); the App View's handle
   domain, its reserved scopes and its limits; whether a new scope waits
   for the operator's approval; and which of the optional methods it
   serves. An App View answers a method it does not serve with XRPC's
   `MethodNotImplemented`, and the site leaves out what needs it.

The site calls the App View's methods as the signed-in person, through the
person's own PDS, with
`atproto-proxy: did:web:pkg.zena-lang.dev#zena_registry`. The person's
PDS adds the service-auth token, which the `rpc` permissions of
`dev.zena-lang.authPublish` allow. The site writes attestations to the
person's own repository. Its session cookie tells the site's pages who is
signed in, which is enough to show the person their own memberships, and
allows no change at the App View.

A PDS's own pages are only those any PDS has: its operators' pages, and
pages for the people whose atproto accounts it holds. Everything about
packages and organizations is on the site, for every App View it finds this
way, and so is the App View's `/admin`, where its operators review accounts,
reports and claims on scope names. The site can also show a package
straight from its PDS, without the index, as `zena` reads it.

### Moving to another PDS

The App View moves an account from one PDS to another with atproto's account
migration. Signing keys do not move: the new PDS generates one of its own.

1. The App View creates an account for the existing DID on the new PDS, as a
   managed account or, where the PDS has none, an ordinary one
   ([Managed accounts](#managed-accounts)).
2. It copies the repository and its blobs from the old PDS, with
   `com.atproto.sync.getRepo` and `com.atproto.sync.getBlob`. A record's
   CID is a hash of its content, so every pinned release keeps its CID.
3. It signs a PLC operation, with its rotation key, that names the new
   PDS's endpoint and signing key.

The Zena project's App View moves a package once its owners' threshold has
attested the move, with `zena pkg move --to <pds>`. So an
organization can keep its packages on a PDS it runs, and still have the
Zena project's App View manage them.

**Moving to another App View** changes which App View manages an account.
A PLC operation replaces the old App View's rotation key with the new App
View's, and names the new App View as `#zena_registry`. The old App
View signs it if it cooperates, and a recovery key holder if it does not,
so a package without recovery keys moves to another App View only with its
App View's cooperation. The Zena project's App View signs such a move once
the package's owners' threshold has attested it. The new App View then
writes to the account through a PDS that trusts it, so the account moves
to such a PDS too, unless its PDS already trusts the new App View.

**Leaving every App View** turns a package into an ordinary account, on a
PDS of its owners' choice, that they publish to with its own credentials:
a PLC operation names the new PDS, and drops `#zena_registry` and the
App View's rotation key. `zena` still reads the package, and the log still
takes releases that its maintainers attest, but `zena` does not publish to
it.

If the old PDS is gone, the records and blobs can be rebuilt from caches
and proxies, which hold every release anyone has fetched, and checked
against the log.

### Holding keys elsewhere

- **Recovery keys** are optional, and held by the maintainers who add
  them. A key on a laptop can be lost, which leaves moving the package to
  the App View's cooperation, or stolen, and a thief with the first-ranked
  key takes the DID. Keeping them in hardware keys or the OS keychain is
  an open question.
- **The signing key** is held by whatever serves the repository, since a
  commit is signed when records are written and served from there: the
  package's PDS. A package that trusts no PDS but its owners' keeps its
  account on a PDS they run, with the Zena project's App View or another
  managing it. A package that trusts no App View runs its own, with
  `zena pkg create --registry <url>`, or leaves every App View for an
  ordinary account ([Moving to another PDS](#moving-to-another-pds)). A
  key on a laptop that is usually offline cannot serve the repository, so
  this is not supported.
  A self-hosted package's risks are its PDS's: when the server is down,
  the package can be fetched only from caches, and if its signing key
  leaks, anyone can write releases, which still go unattested and so are
  never recorded by the log.
- **A `did:web` package** has no rotation keys. Whoever controls the
  domain's `/.well-known/did.json` controls the package, and moving to
  another PDS means editing that file. It cannot move to another domain.

### Trusting an App View

An App View can write anything to the repositories of the accounts it
manages, refuse to write what their maintainers approved, and sign PLC
operations with its rotation key. A PDS can do the first through the
signing keys it holds, and refuse to serve the repositories. What limits
both:

- Lockfiles pin the CID of every release, so a workspace that has
  resolved a release gets those bytes or fails.
- The log records a release only with its maintainers' attestations, so
  a release the App View or the PDS wrote alone is never recorded. A release
  changed after the log recorded it is labeled `release-mutated`.
- PLC operations are public: the directory's export stream lists every
  operation on every DID, so a change an App View makes to a package's DID
  document can be seen.
- The App View's offline rotation key ranks above its online one, so for 72
  hours the operator can undo what a stolen online key signs.
- Recovery keys, where the owners add them, rank above both, so for 72
  hours those owners can undo any PLC operation the App View signs.

A package without recovery keys trusts its App View with its DID: the App
View can move it, rename it, or refuse to move it, though it cannot
publish a release that counts.

A package's dependents rely on its maintainers, through their
attestations, and on the log. They do not choose the package's App View or
its PDS, and do not need to trust either.

### The PLC directory

Creating a package's DID is one request. The App View posts the signed
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
limit per DID yet. An App View that creates accounts in volume should
agree it with the directory's operators, which are becoming an independent
association. Every operation stays in the directory's log for good, so an
abandoned package keeps costing its few operations. Packages made for
testing should use `did:web`.

## Discovery and trust

### The index

The App View indexes package records across PDSes. Its index serves the
site's pages, search, version lists and reverse dependencies, and it
feeds the checksum log. It runs no relay of its own: Bluesky's relays
crawl PDSes, padstone among them once it serves its firehose
(`com.atproto.sync.subscribeRepos`).

The index is filled through one ingest interface, from events in the
firehose's form: the records a commit created, updated or deleted, and
changes of handle. Three sources feed it, in the order they are built:

- **The App View's own writes.** It is the only writer to its accounts,
  so it indexes each of their commits as it makes it. While it is the
  only place packages are published, these are every package there is.
  The operator's `sync-indexes` writes them again from the repositories.
- **A stream of changes**: the relay's stream, filtered to the
  `dev.zena-lang.*` collections, from a relay or from a service that
  filters it, for packages on PDSes and App Views of their own.
  Jetstream, Bluesky's JSON form of the stream, sends the changed records
  without their commits' signatures, so the index reads each such record
  again from its PDS, with its proof. Tap, Bluesky's tool that verifies a
  filtered stream, can send each event to the index as an HTTP request,
  so the index needs no WebSocket client.
- **Backfill**: `com.atproto.sync.listReposByCollection` on a relay
  returns every DID that has records of a collection (relays pass this
  request to a separate directory service), and the index reads each of
  those repositories from its PDS, as the same events.

The index keeps:

- **A catalog** of packages: each one's name and scope, its profile's
  description and license, its latest release that is not retracted, and
  how many releases it has. The home and scope pages, and
  `dev.zena-lang.registry.listPackages` and `listScopes`, read it.
- **Mentions**: for each person, the accounts whose records or
  membership entries name them, and for each team, the packages whose
  maintainers records name it. `getMemberships` and the people pages
  start from it, and read the records of only those accounts.

The memberships behind commitments are visible only to the App View,
which keeps their entries ([Private membership](#private-membership)).
Anyone can index the same records from the firehose, and sees the public
roles only.

| What                                                        | Who answers                                     |
| ----------------------------------------------------------- | ----------------------------------------------- |
| A package's records, releases and attestations              | the PDS that holds the package                  |
| Packages and their latest releases, search, and dependents  | the App View's index                            |
| A person's memberships, private ones included               | the App View, from its mentions and its entries |
| Who maintains a package by DID, and what a person maintains | the App View's index                            |

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
   minimum, usually with `zena pkg update`. Nothing in a package runs when it
   is added, fetched or compiled: Zena packages have no install or build
   scripts. The macros Zena may add ([macros.md](macros.md)) would run at
   compile time, in the compiler's Wasm sandbox and without its access to
   files or the network.

The design does not stop a maintainer from publishing malicious code on
purpose, or approving it unaware. See [Malicious releases](#malicious-releases)
for what limits that.

### Unauthorized publishing

Who might publish without the maintainers' consent, and what stops them:

- **The App View or the package's PDS**, or whoever controls either, can
  write any record to the package's repository: the App View because the PDS
  writes for it, the PDS because it holds the package's signing key.
  Neither can write attestations in the maintainers' repositories, so the
  log records none of it.
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
  1, a release CI publishes waits until a person runs `zena pkg approve`,
  which shows what they are approving: the version, the artifacts' CIDs,
  and the changes to the source since the previous release. A release
  made with a stolen CI secret reaches the log only if a person approves
  it.
- **`approvalKeys`** are a maintainer's passkeys or security keys. When a
  maintainer has some, their attestations count only with a signature
  from one: `zena pkg approve` asks for a WebAuthn assertion over the
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
maintainers record signed with one of the package's rotation keys, in
place of attestations, counts once the log has shown it for seven days,
unless the current maintainers attest a different record in that time.
The index tells the maintainers when such a change is pending.

A package with recovery keys is reset with one of them. For one without,
the App View signs the new record with its rotation key, once its operator
has checked who is asking, as package registries' support does. Either
key is used rarely, so it is harder to take than a session, and the
seven days give the maintainers time to answer if it is misused.

### Compromised keys

| If this is taken                    | The attacker can                                                                    | What stops them                                                                                                                                                                 | Recovery                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A maintainer's session or account   | attest as the maintainer, and ask the App View for what the maintainer can          | the threshold, `humans` and approval keys; the other maintainers are told                                                                                                       | revoke the session or recover the account; the other maintainers remove the person if needed, and retract what was published  |
| A CI secret                         | attest as the bot                                                                   | `humans`; an automation account the App View holds counts only with a person's attestation                                                                                      | the App View revokes the token and issues another                                                                             |
| An approval key                     | nothing alone                                                                       | it signs only together with the maintainer's account                                                                                                                            | remove it from the maintainers record                                                                                         |
| The package's signing key           | write records to the repository                                                     | the log, which records nothing unattested                                                                                                                                       | the PDS makes a new key, and the App View names it with a PLC operation                                                       |
| The App View's own signing key      | write to every account the App View manages, through their PDSes                    | the log, which records nothing unattested                                                                                                                                       | the operator replaces the key in the App View's DID document                                                                  |
| The App View's online rotation key  | change the DID document of every package on the App View, and start recovery resets | the offline key and any recovery keys, which rank above it, undo its operations for 72 hours; the seven days of a reset; the index watches PLC operations and tells maintainers | the operator undoes the operations with the offline key, and replaces the online key                                          |
| The App View's offline rotation key | the same, ranked above the online key                                               | recovery keys, where packages have them; the seven days of a reset                                                                                                              | packages with recovery keys undo the operations; packages without them move to new DIDs (below)                               |
| A recovery key                      | change the DID document at that key's rank, and start a recovery reset              | higher-ranked keys, for 72 hours; the seven days of a reset; new releases still need the maintainers' attestations                                                              | undo with a higher-ranked key; if the first-ranked key was taken, the DID is lost, and the package moves to a new DID (below) |
| The log's signing key               | sign a log head that drops or changes entries                                       | witnesses, and clients, which refuse a head that does not extend the last one they saw                                                                                          | the log rotates its key                                                                                                       |

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
- **Handles** can be taken only as scope names on an App View's domain,
  first come, first served. An App View can reserve scopes for people who
  show they own a matching domain or GitHub organization, and settle
  disputes, as package registries do. An organization that uses its own
  domain as its scope is out of reach. A handle that a scope gives to
  another package moves no dependent, since manifests and lockfiles record
  DIDs.

### Confusion

- **Typosquatting**, as in `@acme/routr` beside `@acme/router`. Handles
  are ASCII, which rules out look-alike Unicode. `zena pkg add` shows the DID,
  handle, maintainers, and how many packages depend on the package before
  it writes anything, and the index can label handles that look like
  those of popular packages. After `zena pkg add`, the depending package
  refers to the package by DID and by its own local name, so a typo can do harm only at
  that moment.
- **Dependency confusion**, where a public package shadows a private one
  of the same name, needs names that resolve by search. Packages are
  named by DID, and `@scope/name` maps to one domain per scope (see
  [Names and scopes](#names-and-scopes)).
- **Expired domains.** Whoever registers a domain a package's handle was
  on can point the handle at their own DID, which affects only new
  `zena pkg add`s by that handle. For a `did:web` package the DID itself
  becomes theirs, but the log still holds the old maintainers record, so
  it records no release they make.
- **Manifest confusion**, where what a registry shows about a package
  differs from what the package contains. A release lists its
  dependencies, and its source archive holds `zena-package.json`, which
  lists them too. The log and `zena pkg fetch` check that the two agree.
- **Lockfile injection**, where a pull request changes `zena-lock.json`
  to pin another DID or CID. `zena pkg fetch --check` recomputes the selection
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
  not every build. A release found out in that time can be retracted and
  labeled before most workspaces take it.
- Labelers mark malicious releases `malware`, and clients that follow
  them refuse those releases, pinned ones included.
- A workspace can follow a labeler that reviews releases, and require
  `reviewed` for some or all of its dependencies.
- A library's source is compiled into the program that uses it, and runs
  with that program's capabilities. A prebuilt component can reach only
  what its world imports and the program gives it.

### Availability

A package whose App View deletes it, or disappears, can still be fetched
from caches and proxies, since every artifact is addressed by its CID, and
its maintainers can move it to another App View if they hold a recovery
key. A package without one is published again under a new DID, which a
labeler names as the old one's successor. The PLC directory and the log
are needed to resolve new releases. A build from an existing lockfile
needs neither, given a cache or proxy that holds its artifacts.

## Abuse and moderation

An App View's operator answers for what the App View stores and serves, as
any registry's or PDS's does. The Zena project's App View will receive legal
takedown notices and reports of spam, malware and impersonation, and
people will try to use it for things other than packages. This section
says what the App View allows, how it limits creating accounts, and how its
operator handles reports.

### What a package account can do

A package account exists to hold package records, and the App View lets it
do nothing else. The same goes for organization accounts.

- No one can sign in as one of these accounts. As managed accounts they
  have no password, no app passwords and no OAuth authorization, and
  their PDS takes writes to them only from their App View
  ([Managed accounts](#managed-accounts)). The App View writes them only
  through its own methods.
- An automation account is used through the token its App View issues, since
  that is how CI publishes. With it, `zena` can call the App View's methods,
  and the App View writes the account's attestations
  (`dev.zena-lang.package.attestation`), and nothing else.
- The App View refuses a write to any collection outside `dev.zena-lang.*`
  in all of these accounts, whichever method makes it, so a bug in one
  method cannot open an account up.
- Blobs are stored only as the artifacts a release declares, within the
  limits below.

So an account created by publishing a package cannot post to Bluesky
(`app.bsky.feed.post`) or Leaflet, follow anyone, or hold a profile for
any other application.

A package that leaves every App View leaves these limits behind, along
with the App View's domain: its handle under that domain resolves only
while the App View's DNS answers for it, and the App View stops answering
for a package it has taken down. What leaves with it is its DID, and
anyone can create a `did:plc` at the PLC directory without an App View.

### Limits on creating accounts

Each account an App View creates costs others something: an operation at the
PLC directory, and an account that relays carry, with its events on its
PDS's firehose. Relays can limit how many accounts they carry from one
PDS, so a PDS flooded with accounts risks having all of its packages
throttled. The App View therefore limits who creates accounts and how many:

- **Scopes.** Creating a scope is the step the App View checks. It needs the
  operator's approval, or a claim on a matching domain or GitHub
  organization (see [Squatting](#squatting)), and the App View can reserve
  names (see [Confusion](#confusion)).
- **Packages.** Within a scope, packages are created without review, up
  to a number per day and a number in all, which the operator can raise.
- **Maintainers.** Every request carries the maintainer's DID, through
  its service-auth token, so the App View can limit requests per maintainer.
  Accounts on permissive PDSes cost little to create, so the App View also
  considers how old the maintainer's account is, which PDS holds it, and
  the labels that labelers the operator follows put on it.
- **Storage.** Each artifact, each release and each scope has a size
  limit, and a release can store only the artifact kinds the release
  schema defines. Without limits an App View is free file hosting.

### Reports and takedowns

- **Reports.** The App View takes reports through
  `com.atproto.moderation.createReport`, which atproto clients already
  use, and through an address on its site. The index links every package
  page to it.
- **Takedowns.** The operator can take down a release, a package or an
  organization. The App View then stops answering for a taken-down
  account's handle, and asks the account's PDS to take down the records
  and blobs involved: on padstone, through the operator's admin methods,
  after which it stops serving them and marks the account as taken down on
  its firehose, as atproto's account status events do. On a PDS the
  operator does not run, the App View can only stop writing to the
  account, and leaves serving it to that PDS's operator. The operator's
  labeler labels what was taken down and why (`legal`, `malware`, `spam`,
  `impersonation`), so a client whose fetch fails can say why.
- **Legal notices.** The operator names an agent for notices such as DMCA
  takedowns, takes down what a valid notice names, and restores it on a
  valid counter-notice, as the law requires. A notice usually names a
  release or an artifact, which can be taken down without the rest of
  the package.
- **Dependents.** Workspaces that pinned a taken-down release still have
  it in their caches. The Zena project's proxy follows the App View's
  takedowns for malware and legal notices and stops serving those blobs.
  The checksum log keeps the release's CIDs, which are hashes and not the
  content, so a release can be taken down without changing the log.

### Proactive measures

- The index looks at every new release before most workspaces could have
  taken it: binary files in source archives, archives much larger than
  the package's earlier releases, and handles close to those of popular
  packages. It labels what it finds for review.
- The first releases of a new scope are reviewed first.
- The App View rate-limits `createPackage` and `publish`, and the operator
  watches for bursts of accounts or releases.
- The App View follows labels from labelers that mark spam and abusive
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
  `approve`, `retract`, `scope`, `owner`, `team`, `package create` and
  `package move`, and the `@scope/name` shorthand with its `scopes`
  mapping. Signing in needs OAuth with a loopback redirect, a
  client metadata document at `zena-lang.dev`, and the
  `dev.zena-lang.authPublish` permission set.
- **The App View**: a Zena service with the `dev.zena-lang.registry.*`
  methods, for creating packages, scopes and automation accounts,
  publishing, changing maintainers, members and teams, and moving
  packages between PDSes. It mints their DIDs and holds their rotation
  keys, creates their accounts on PDSes and writes their records through
  `com.atproto.*`, checks service-auth tokens against roles, keeps
  membership entries and gives them to those allowed to see them, and
  writes its handles' records to its domain's DNS zone. It confines
  package, organization and automation accounts to `dev.zena-lang.*`
  records, enforces the limits on creating accounts and on storage, takes
  reports, and has the operator's tools for reviewing scopes and taking
  content down. It is also the index, and serves the site.
- **A PDS with managed accounts**: padstone, the PDS written in Zena,
  which creates accounts for an App View its operator trusts, takes their
  writes only from that App View, limits them to package records and
  artifacts, and is otherwise an ordinary PDS.
- **The management interface**: pages on the App View's site,
  `pkg.zena-lang.dev`, which call its methods as the person signed in, and
  find each account's App View from its DID.
- **Lexicons** for the records, the App View's methods and the
  `dev.zena-lang.authPublish` permission set, in
  `packages/package-manager/lexicons`. Moving a package and recovering
  one have no methods yet.
- **Services**: the checksum log, the proxy, and a labeler, all Zena
  servers. The log also checks attestations, approval-key signatures and
  recovery resets. The App View's index watches PLC operations, publishes
  and changes of maintainers, and tells maintainers about them.
- **Approvals**: `zena pkg approve`, and the management interface's page that
  asks a passkey or security key for a WebAuthn assertion. `zena pkg fetch --check`
  and `zena verify-source`.

## Alternatives considered

### A package as a record in its publisher's repository

A package could be identified by its publisher's DID and a record key,
`at://did:plc:alice/dev.zena-lang.package.profile/router`. Any atproto
account could publish today, with no new accounts. A package could then
never change hands, and it would share its fate with one person's
account. A DID per package keeps the package's identity separate from
anyone who maintains it.

### Package records in maintainers' repositories, with a minted DID

An App View could mint a DID for each package that is an identifier only,
with no repository, and maintainers could write the package's records into
their own repositories, each naming the package's DID; the index would
know which records belong to which package. No package would need an
account, and anyone could publish from bsky.social with an OAuth session
alone. It gives up what an account per package guarantees:

- **Which records count.** Anyone can write a record naming a package's
  DID. Readers need a rule for whose records count, so the maintainers
  list needs an authoritative place: a record in some person's
  repository, which moves when ownership changes; the package's DID
  document, which would take a PLC operation for every change of
  maintainers; or the App View's database, which only the App View can
  vouch for.
- **One release per version.** In the package's own repository a version
  is a record key, so there is one `release/1.0.0`. Two maintainers could
  each write a different 1.0.0 in their own repositories, and something
  would have to choose.
- **Finding releases.** `zena` would have to ask the index which
  repositories hold a package's releases, which makes the index part of
  what a client trusts.
- **A maintainer who leaves.** Releases and their artifacts would live in
  the account of whoever published them, and go when that account is
  deleted or suspended. The DID keeps the package's identity separate
  from its maintainers, and not its records.
- **Tools.** Relays, the firehose and record browsers would not see a
  package as an account; only the index would.

A repository per package, which any atproto client can verify, is worth
an account for each.

### Delegation with UCANs

UCANs are signed tokens that delegate a capability from one key to
another, in chains: an organization to a team, a team to a person. A
publish could carry such a chain, for the App View or the log to check.
atproto used them early on and moved to service-auth tokens and OAuth
scopes, so no PDS or client speaks them. A chain needs every organization
and team to have a private key that someone holds, which is the custody of
keys this design keeps away from maintainers. The records already
delegate: the maintainers, members and team records say who holds which
role, and an attestation in a person's own repository is their signed
approval, which anyone can check with atproto alone.

### Package accounts on any PDS, with a password each

The first version of this design created each package with
`com.atproto.server.createAccount` on whatever PDS its publisher chose,
and published with that account's app password, which a team shared as a
secret. It needs no App View. It gives each package a password to
keep, makes everyone who publishes share it, records nothing about who
published, and has no default PDS: bsky.social would need an email
address per package and make each one a Bluesky user. The `zena` command
still reads packages from any PDS, and a package can move to one, but it
does not publish to one.

### An App View that is a PDS

An earlier design made the App View a PDS with an extension: its
methods were served by the PDS that stored the accounts and held their
signing keys, and it wrote to their repositories directly. That is one
service, with no managed accounts and no tokens between the App View and
the PDS. It also ties every package to that PDS software. An
organization could not keep its packages on a PDS it runs while the Zena
project's App View managed them, and a package that moved to another PDS
left its App View behind. Separating the App View, which holds the
authority, from the PDS, which stores the account, lets accounts move
between PDSes with atproto's own migration while the same App View
manages them. Clients call the same `dev.zena-lang.registry.*` methods
either way.

### A package host apart from the index

The App View could be two services: a package host, which mints DIDs,
holds their keys and writes to their accounts, and an index, an AppView
that only reads the firehose and holds nothing it could not rebuild from
it. That keeps the authority and its secrets out of the service that
takes in public data from the whole network, lets the index watch the
host's PLC operations from outside, and allows any number of hosts, each
managing its own accounts, under one index.

One service is simpler to run and to explain, and while the Zena
project's App View is the only one, it gives up little:

- The App View keeps its rotation key and signing key in a key
  management service, and the part of it that reads the firehose has no
  access to them or to the membership entries.
- The operator's offline key and the owners' recovery keys, which rank
  above the App View's key, undo its PLC operations for 72 hours, and the
  checksum log is a service of its own.
- Anyone can index the same records from the firehose, and watch the
  App View from outside.
- Another App View can manage accounts of its own, and each indexes what
  the firehose shows it.

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
- **The Zena App View's policy on scope names**: for example,
  reserving scopes for verified domains or GitHub organizations, and
  settling disputes.
- **The Zena App View's moderation**: who reviews new scopes and
  reports, the quotas on packages and storage, the legal entity that
  receives notices, and which labelers the App View follows for maintainers.
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
