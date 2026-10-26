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
loads, which implement interfaces the PDS defines. A deployment that is
not a package host would leave the package extension out. Someone else
could write an extension for their own record types, with the same
interfaces.

This document lists what the package host adds to the PDS, the extension
point each piece needs, and how extensions could be loaded. It proposes
an order of work that starts inside the current source tree, before any
Wasm is involved.

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
- configuration, and the server.

The core holds every secret: the rotation key, storage credentials, DNS
credentials. An extension asks the core to act with them and never sees
them.

## Extension points

An extension point is an interface the core defines. An extension
implements some of it, and imports what the core offers in return. Each
point below says what the core calls, what the extension can call, and
which part of the package host uses it.

### Methods and routes

The core routes a request to the extension that declared its path or
XRPC method. For a method that requires service auth, the core checks
the token first, against the method's NSID, and passes the caller's DID
to the extension with the request. The extension answers with a status,
headers and a body.

The package host declares the `dev.zena-lang.host.*` methods. An
extension that serves pages, such as an admin page (#582), declares
paths.

### Record write policy

Before a commit, the core asks each extension that registered for write
policy whether a write may happen: the account, the collection, the
record key and the record, or a deletion. The extension answers yes, or
no with an XRPC error name and a message. A refused write refuses the
whole commit, as `Repository.applyWrites` does today.

The package host uses this for its account kinds: a package account may
hold only `dev.zena-lang.*` records, and an automation account only
attestations. The kind of an account is the extension's own data, kept in
its storage (below), keyed by DID.

### Record validation with access to the account

Some checks need more than the record. Checking a release reads the
account's profile record and the blob the release names. So the write
policy hook can read the account it is asked about: its records by
collection and key, and its blobs by CID, through an interface the core
provides. It cannot write through that interface; writes go through the
core's commit, so every write passes every extension's policy.

### Accounts and identity

The core creates accounts. An extension asks it to create one with a
handle and a kind, and gets back the DID. For a `did:plc`, the extension
can add rotation keys ranked above the host's, which is how the package
host puts the maintainers' recovery keys first. The core makes the
signing key, signs the genesis operation with the rotation key, and sends
it to the configured PLC directory, which is the staging directory on a
staging host.

The core writes the new handle's DNS record, so the package host does
not need its own `pds:handles` calls. Taking a name in a scope stays the
package host's: it claims the name in its storage before asking for the
account, and releases it if the core fails to create one, as
`PackageHost.createOrganization` does today.

### Extension storage

Each extension has a namespace in the PDS's storage, which no other
extension can read: documents by key, a create-if-absent operation for
claims, and transactions that read and write several documents. The core
implements it on each of its storages: in memory, and in Firestore under
`tenants/{tenant}/extensions/{extension}/`.

The package host keeps its scope and name claims, its membership entries
and its account kinds there. Today these are `pds:host`'s `HostStore` and
its Firestore implementation, which this namespace replaces.

### Jobs

An extension can export named jobs that the operator runs: from the
command line with the server's configuration, from the admin page, or on
a schedule. The package host has none of its own once handle records are
in the core: `sync-handles` becomes a core job.

## Loading extensions

There are three ways to put an extension into a PDS. They differ in when
the extension is chosen and in what Zena has to support first.

**Composition at build time.** The core is a component whose world
imports one interface per extension point, as named import slots
([component-model.md](./component-model.md), "Named import slots" and
Part 4). Each extension is a component that exports those interfaces. A
composition tool such as wac links them into one component, which runs
on `zena-run` as the server does today. Adding or removing an extension means composing
and deploying again, without compiling the core again. Calls between the
core and an extension are ordinary component calls inside one process.

**Loading at run time.** The core loads extension components when it
starts, from paths in its configuration, and calls them through the
host. The `zena:wasm` module runs whole programs and has no way to
instantiate a component and call its exports with typed arguments, so
this needs a new host interface in `zena-runtime`, and support for
calling a component's exports in the code the compiler generates.

**Separate services.** An extension runs as its own server, and the core
calls it over HTTP with signed requests, as atproto services call each
other. This needs nothing new from Zena, but every hook becomes a network
call. A write policy check on every commit would add the latency of one
round trip, and an extension that is down would stop writes.

Composition at build time is the one to start with. It gives the package
host its own component with the interfaces above, and it uses what Zena
already has: components that declare named import slots, emitted by the
compiler, and composed by tools outside it. Loading at run time can follow
once the host can instantiate components, with the same interfaces.

Each interface has to stay within the types Zena's components can carry
across a call. Scalars, strings, `list<u8>` and records cross today; a
variant whose cases carry payloads of different core types does not yet,
and the general canonical ABI for rich types is still to come
([component-model.md](./component-model.md), "What exists today"). The
WIT for the extension points is written to that, and grows with it.

## Trust and limits

An extension runs inside the PDS's process, so the interfaces are its
only reach. It sees its own storage namespace, the records and blobs of
the account it is asked about, and the requests routed to it. It cannot
read secrets: it asks the core to sign or to send. The host can bound an
extension's execution time with wasmtime's fuel or epochs, and a trap in
an extension fails that one request or write.

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
3. **Build the package host as a component** that exports the extension
   interfaces, and compose it with the core at build time. The deploy
   scripts (`packages/pds/deploy`) build the composed component.
4. **Load extensions at run time**, once `zena-runtime` can instantiate a
   component from a path and the compiler can call its exports.

## Open questions

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
