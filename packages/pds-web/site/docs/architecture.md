---
title: AT Protocol Architecture
lead: How the Zena package manager uses AT Protocol identities, signed Merkle repositories, lexicons, and content-addressed blobs.
---

Zena's package manager is built directly on the [AT Protocol](https://atproto.com) (`packages/atproto`, `packages/package-manager`, and `packages/pds`). Rather than inventing a bespoke registry database and authentication protocol, packages use standard atproto primitives: DIDs, handles, signed Merkle Search Tree (MST) repositories, DAG-CBOR records, and content-addressed blobs.

For the complete specification, see [`docs/design/package-manager.md`](https://github.com/elematic/zena/blob/main/docs/design/package-manager.md) in the Zena repository.

## Packages and scopes as accounts

Every package and every organization scope is an atproto account:

- **Identity (`did:plc` or `did:web`)**: A package's permanent identifier is its DID. Its DID document specifies its public signing key and the URL of the Personal Data Server (PDS) that hosts its repository.
- **Portability**: Because `zena-package.json` and `zena-lock.json` reference packages by DID, a package can change its handle, transfer to a new organization, or migrate to another PDS without breaking existing dependents.
- **Handles**: A package hosted on `pkg.zena-lang.dev` under scope `@acme` receives the handle `<name>.acme.pkg.zena-lang.dev`, verified bidirectionally via DNS (`_atproto.<handle>` TXT record) and the account's DID document. Maintainers can also assign a domain they control as the package's handle.

## Repository records and lexicons

A package's metadata and releases are stored as DAG-CBOR records in its atproto repository, signed by the account's key. The schemas are defined by the `dev.zena-lang.*` lexicons in `packages/package-manager/lexicons/`:

### Package records (in a package's repository)

| Collection NSID | Record key | Contents |
| --- | --- | --- |
| `dev.zena-lang.package.profile` | `self` | Package name, description, SPDX license, homepage, and source repository URL |
| `dev.zena-lang.package.release` | `<version>` | Semantic version, timestamp, artifact CIDs (`source` CAR archive), and dependency `{did, version, name}` list |
| `dev.zena-lang.package.retraction` | `<version>` | Reason and timestamp marking a release as retracted |
| `dev.zena-lang.package.maintainers` | `self` | Maintainer entries (by DID, commitment, or team reference), release `threshold`, and `ownerThreshold` |

### Organization records (in a scope's repository)

| Collection NSID | Record key | Contents |
| --- | --- | --- |
| `dev.zena-lang.org.profile` | `self` | Scope display name, description, and website |
| `dev.zena-lang.org.members` | `self` | Member commitments/DIDs (`owner`, `admin`, `member`) and `ownerThreshold` |
| `dev.zena-lang.org.team` | `<team-name>` | Team member commitments/DIDs (`maintainer`, `member`) and approval `threshold` |
| `dev.zena-lang.org.policy` | `self` | Scope-wide minimum and default thresholds (`minReleaseThreshold`, `minOwnerThreshold`, `packageCreators`) |

### Maintainer records (in a maintainer's own repository)

| Collection NSID | Record key | Contents |
| --- | --- | --- |
| `dev.zena-lang.maintainer.attestation` | Base32 hash of `uri` + `cid` | AT-URI and CID of a release or membership record approved by the maintainer |

## Source archives and verification

When `zena publish` publishes a version, it packs the package's `.zena` files and `zena-package.json` into a deterministic IPLD CAR archive (`application/vnd.ipld.car`) and uploads it as a blob to the package's repository.

When `zena fetch` downloads a pinned dependency:

1. It resolves the package's DID document to locate its PDS and public signing key.
2. It fetches the `dev.zena-lang.package.release` record via `com.atproto.sync.getRecord`, which returns the signed repository commit and the Merkle proof path to the record, and verifies that the record's CID matches `zena-lock.json`.
3. It downloads the source archive blob via `com.atproto.sync.getBlob` and verifies its SHA-256 hash against the `source` CID pinned in `zena-lock.json`.

Because both the record proof and the blob hash are verified by the client, mirrors, caches, and CDNs require no trust.

## The package host (`packages/pds`)

`pkg.zena-lang.dev` runs `packages/pds`, an AT Protocol PDS written in Zena and compiled to WebAssembly. In addition to standard `com.atproto.sync.*`, `com.atproto.repo.*`, and `com.atproto.server.*` endpoints, it implements the `dev.zena-lang.host.*` XRPC methods:

- Authenticates callers using atproto service-auth tokens (`Bearer` JWTs signed by the caller's own PDS signing key for a specific `lxm` method).
- Creates organization accounts, package accounts, and CI automation accounts, registering their `did:plc` identities and DNS handle records.
- Validates uploaded source archives against the release record and verifies that all declared dependencies exist.
- Holds releases and membership updates until the required number of maintainers have published `dev.zena-lang.maintainer.attestation` records in their own repositories, then commits the record to the target repository.

## Immutability and transparency

In atproto, an account holder can technically rewrite their own repository. The Zena package manager prevents retroactive tampering in two ways:

1. **Lockfile CID pins**: `zena-lock.json` pins the exact CID of every release record and source archive. Any modification produces a different CID and is rejected by `zena fetch`.
2. **Checksum and attestation verification**: The host refuses to overwrite an existing release key (`VersionExists`), checks maintainer attestations from each maintainer's independent PDS, and pairs with an append-only checksum log that records the first CID seen for each `<did>@<version>` alongside its maintainer attestations.
