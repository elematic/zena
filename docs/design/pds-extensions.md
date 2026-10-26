# PDS Extensions

## Status

- **Status**: Proposed
- **Date**: 2026-10-26
- **Issue**: #584

## Overview

`packages/pds` is an atproto PDS written in Zena (see [pds.md](./pds.md)).
It is also the Zena package host: it creates package and organization
accounts, takes scope and package names, checks the callers of its
`dev.zena-lang.host.*` methods, writes handle records to DNS, and checks
releases before recording them
([package-manager.md](./package-manager.md), "Hosting, keys and
maintainers"). All of that is compiled into the server today. `pds:host`
holds most of it, and `pds:server`, `pds:storage`, `pds:repository` and
`pds:service` reach into it.

The goal is a PDS whose core does what any PDS does, with everything
specific to Zena packages in extensions: WebAssembly components the PDS
loads at run time, which implement interfaces the PDS defines. The
operator installs some for the whole host, as the package host would be.
An organization or a person with an account on the PDS installs others
for their own accounts, without the operator building or deploying
anything. A deployment that is not a package host leaves the package
extension out.

This document lists what the package host adds to the PDS, the extension
point each piece needs, who may install an extension and what it can
reach, and what the runtime needs to load one. It proposes an order of
work that starts inside the current source tree, before any Wasm is
involved.

## What the package host adds

Each row is something the package host does today, where it lives, and
whether it is specific to Zena packages or something many PDSes could
use.

| What                                                                                                                                 | Where today                                                                               | Specific to packages                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The `dev.zena-lang.host.*` methods: `createOrganization`, `createPackage`, `uploadArtifact`, `publish`                               | `host.zena` (`PackageHost`), routes in `server.zena` (`hostRoutes`)                       | yes                                                                                               |
| `com.atproto.server.describeServer` with the host's DID and handle domain                                                            | `server.zena`                                                                             | no: the core PDS answers it, with values from configuration                                       |
| The host's own DID document at `/.well-known/did.json`                                                                               | `server.zena`                                                                             | no                                                                                                |
| Checking service-auth tokens addressed to the host, with replay protection                                                           | `PackageHost.authenticate`, using `atproto:service-auth`                                  | no: any extension with methods of its own needs it                                                |
| Account kinds (package, organization, automation), each allowed only some collections                                                | `AccountKind` and `Account.allows` in `storage.zena`, checked in `Repository.applyWrites` | the kinds are; refusing writes by a policy is not                                                 |
| Creating an account with a new `did:plc`, whose genesis operation ranks the maintainers' recovery keys above the host's rotation key | `PackageHost.#prepareAccount`, `#createAccount`                                           | partly: creating accounts with `did:plc`s is core; the recovery-key ranking is the package host's |
| Scope and package names, claimed once each                                                                                           | `HostStore.claimScope`, `claimName` and their Firestore implementation                    | yes                                                                                               |
| Private membership entries behind the commitments in members and maintainers records, and the role checks that read them             | `HostStore.entries`, `PackageHost.#hasRole`, `#maintainedPackage`                         | yes                                                                                               |
| Checking a release against its source archive and dependencies before recording it                                                   | `package-manager:validate`, called from `PackageHost.publish` (#574)                      | yes                                                                                               |
| Writing each handle's `_atproto` TXT record to a DNS zone, and rewriting them all (`sync-handles`)                                   | `pds:handles`, `PackageHost.syncHandles`, `main.zena`                                     | no: any PDS that gives out handles under its own domain needs it                                  |
| A PLC directory of its own for staging, reading other DIDs from the public one                                                       | `pds:plc-directory`, mounted in `pds:service`                                             | no                                                                                                |
| Configuration: the domain, service DID, public URL, rotation key, reserved scopes, largest artifact, handle records                  | `pds:service` (`configFromEnv`)                                                           | partly                                                                                            |

Several rows are not specific to packages. Handle records, the staging
PLC directory, the host's DID document, `describeServer` and service-auth
checking are things a general PDS can use. They move into the core, and
the package extension uses them.

## The core

The core is what `packages/pds` would be with the package host taken out,
plus the general pieces from the table above:

- accounts, their repositories and commits, blobs, and `com.atproto.sync`
  and `com.atproto.repo` reads;
- storage (`pds:storage`, `pds:firestore`);
- identity: resolving DIDs and handles, creating `did:plc`s and sending
  their operations, and the staging PLC directory;
- handle records in a DNS zone;
- checking service-auth tokens;
- installing, loading and calling extensions;
- configuration, and the server.

The core holds every secret: the rotation key, storage credentials, DNS
credentials. An extension asks the core to act with them and never sees
them.

## Who installs an extension

An extension is installed at one of two levels, and the level decides
what it can reach.

- **Host extensions** are installed by the operator, in the server's
  configuration. They see every account, and can ask the core to create
  accounts. The package host is one.
- **Account extensions** are installed by an account, for itself: a
  person, or an organization, which installs one for its own account. An
  account extension sees only the account that installed it: that
  account's writes, the requests addressed to it, and a storage area of
  its own. It cannot create accounts.

Each installation is an extension at a version, installed by one account
or by the operator. The same extension installed by two accounts is two
installations, with separate storage, and neither sees the other's data.

An extension is a published Zena package whose release carries a Wasm
component as an artifact ([package-manager.md](./package-manager.md),
"Artifacts"). Installing one names its DID and version. The core fetches
and checks the release as `zena fetch` does, and compiles the component
once, caching the result.

## Extension points

An extension point is an interface the core defines. An extension
implements some of it, and imports what the core offers in return. Each
point below says what the core calls, what the extension can call, and
which part of the package host uses it.

### Methods and routes

The core routes a request to the installation that declared its path or
XRPC method. For a method that requires service auth, the core checks
the token first, against the method's NSID, and passes the caller's DID
to the extension with the request. The extension answers with a status,
headers and a body.

The package host declares the `dev.zena-lang.host.*` methods, as a host
extension. An admin page (#582) declares paths. An account extension's
methods are served only for requests about its account; how a request
names that account is an open question.

### Record write policy

Before a commit, the core asks each installation that registered for
write policy, and that can see the account, whether a write may happen:
the account, the collection, the record key and the record, or a
deletion. The extension answers yes, or no with an XRPC error name and a
message. A refused write refuses the whole commit, as
`Repository.applyWrites` does today.

The package host uses this for its account kinds: a package account may
hold only `dev.zena-lang.*` records, and an automation account only
attestations. The kind of an account is the extension's own data, kept in
its storage (below), keyed by DID. An account extension can enforce rules
on its own account, such as a schema for a collection it defines.

### Record validation with access to the account

Some checks need more than the record. Checking a release reads the
account's profile record and the blob the release names. So the write
policy hook can read the account it is asked about: its records by
collection and key, and its blobs by CID, through an interface the core
provides. It cannot write through that interface; writes go through the
core's commit, so every write passes every policy that applies to it.

### Accounts and identity

Host extensions only. The core creates accounts. An extension asks it to
create one with a handle and a kind, and gets back the DID. For a
`did:plc`, the extension can add rotation keys ranked above the host's,
which is how the package host puts the maintainers' recovery keys first.
The core makes the signing key, signs the genesis operation with the
rotation key, and sends it to the configured PLC directory, which is the
staging directory on a staging host.

The core writes the new handle's DNS record, so the package host does
not need its own `pds:handles` calls. Taking a name in a scope stays the
package host's: it claims the name in its storage before asking for the
account, and releases it if the core fails to create one, as
`PackageHost.createOrganization` does today.

### Extension storage

Each installation has a storage area that no other installation can
read: documents by key, a create-if-absent operation for claims, and
transactions that read and write several documents. The core implements
it on each of its storages: in memory, and in Firestore under the
deployment's `tenants/{tenant}/` with one collection per installation.
Account extensions have a quota.

The package host keeps its scope and name claims, its membership entries
and its account kinds there. Today these are `pds:host`'s `HostStore` and
its Firestore implementation, which this storage replaces.

### Jobs

A host extension can export named jobs that the operator runs: from the
command line with the server's configuration, from the admin page, or on
a schedule. The package host has none of its own once handle records are
in the core: `sync-handles` becomes a core job.

## Loading extensions

The core loads each installation's component at run time, and calls it
through the runtime that hosts the PDS, `zena-run` in a deployment.
`zena-runtime` can already start a component (`zena:wasm`'s `run`), but
only as a program: it calls one export with no arguments, returns its
result as text, and drops the instance, and the child's imports are a
fixed set. #593 adds what extensions need:

- **Long-lived instances**: a component loaded and type-checked once, and
  called many times, per request or per write.
- **Typed calls, forwarded by the runtime.** The PDS's own world declares
  both sides in WIT: it imports each extension interface, with an
  installation handle added, and exports each interface extensions
  import, with the handle added. To the compiler these are ordinary WIT
  imports and exports, so the core calls
  `policy.checkWrite(installation, ...)` with typed arguments. At load,
  the runtime checks that the extension's exports match the PDS's
  imports, and forwards each call to that installation's instance,
  holding the values as wasmtime values, and never encoding them.
- **Imports the core chooses**: each installation's linker is built from
  an allow list: host interfaces such as outgoing HTTP, and the
  interfaces the PDS exports. A component that imports anything else
  fails to load.
- **Imports the core serves**: an extension's storage and its reads of
  the account are implemented by the core, in Zena, and are called while
  the core waits on the extension's call. A synchronous call back into
  the PDS would re-enter a component instance already in a call, which
  the component model forbids. With p3 async, the PDS's call is
  async-lowered, so the call back starts a new task in the PDS's
  instance, as a concurrent request does. #593 starts by proving this.
- **Limits**: memory and time per call, so that a trap or an overrun
  fails that call and nothing else.
- **A grant of its own**, apart from process spawning, so that the PDS
  can load extensions without being allowed to spawn processes.

Records and request bodies cross as bytes: a record as its DAG-CBOR
encoding, which the core already has, since a record's CID is its hash,
and an XRPC request or response as its method, headers and body. The
extension decodes them with `atproto`'s libraries. Lexicons never become
WIT types, so the extension WIT stays small and fixed: strings, DIDs,
`list<u8>`, and a few records and results. Zena's components carry all of
those today ([component-model.md](./component-model.md), "What exists
today"). Resources, streams and futures between the PDS and an extension
would need the runtime to map them, so the extension WIT leaves them out.

Two other ways were considered:

- **Composition at build time.** The core imports one interface per
  extension point, as named import slots
  ([component-model.md](./component-model.md), "Named import slots" and
  Part 4), and a tool such as wac links the extensions in before
  deployment. It needs nothing new from the runtime, but every install
  would be a build and a deployment by the operator, so accounts could
  not install extensions. It could still serve host extensions, if
  calling across the runtime turns out to be slow.
- **Separate services.** An extension runs as its own server, and the
  core calls it over HTTP with signed requests, as atproto services call
  each other. Every hook becomes a network round trip, a write policy
  that is down stops writes, and an account would have to run a server
  to install one.

## Trust and limits

An account extension is code the operator has not reviewed, run inside
the PDS's process. What it can reach is what the core gives it:

- **Its imports**, from the allow list. No file system, no process
  spawning, no secrets and no loading of components.
- **Its own data**: its installation's storage, and the records and blobs
  of the account that installed it.
- **No secrets.** The core holds the rotation key and every credential,
  and an extension asks the core to act.
- **Bounded time and memory**, per call, with a cap on how many instances
  one account's installations hold.

A trap or an overrun fails that call. For a write policy, that refuses
the write, and the error names the installation, so an extension that
breaks hurts only the accounts that installed it.

## Order of work

1. **Separate the package host inside the tree.** Move the general pieces
   into the core: handle records on account creation and rename, the
   staging PLC directory, `describeServer` and the host's DID document
   from configuration, and service-auth checking for routes. Then put the
   package host behind Zena interfaces shaped like the extension points:
   routes, write policy, account requests, extension storage. No Wasm is
   involved, and the existing tests keep passing.
2. **Write the WIT.** Turn those Zena interfaces into a WIT package for
   the extension points, and check that each type crosses a component
   boundary with the compiler of the day.
3. **The runtime (#593).** Long-lived instances, typed calls forwarded
   in both directions, chosen imports, limits and the grant, starting
   with a spike of the calls back into the PDS, which decide the rest.
4. **The package host as a host extension**, built as a component,
   published as a package, and loaded by the core from configuration.
5. **Account extensions**: installing and removing one, the storage
   quota and instance cap, and the routing of requests to an account's
   installations.

## Open questions

- How a request names the account whose extension should answer it: a
  parameter, the service-auth token's audience, or a path under the
  account.
- Where an account's installations are kept: in the core's storage, or
  as a public record in the account's repository, which would let other
  services see what an account runs.
- Whether an installation moves to a newer release of its extension on
  its own, and how it is told about the new release.
- Where compiled components are cached on Cloud Run, where the local
  disk does not outlive an instance: compiling on every cold start, or a
  cache in the bucket keyed by the engine's version.
- Whether an extension may register more than one write policy, for
  instance per collection, or one hook that sees every write.
- How an extension declares the configuration it reads, so the core can
  check it at start the way `configFromEnv` checks its own.
- Whether jobs run in the server's process or as separate runs of the
  same component, which matters on Cloud Run, where a request-driven
  service does not run background work.
- How extensions are versioned against the core's WIT package, and what a
  core with an older interface does with a newer extension.

## Related

- [pds.md](./pds.md): the PDS, its storage and its milestones.
- [package-manager.md](./package-manager.md): the package host's protocol.
- [component-model.md](./component-model.md): components and WIT in Zena.
