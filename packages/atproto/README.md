# atproto for Zena

Libraries for the [AT Protocol](https://atproto.com): its data model,
encodings, cryptography and repositories. The package manager
([docs/design/package-manager.md](../../docs/design/package-manager.md))
publishes and verifies packages with them.

Import them as `atproto:<library>`. In this repository's workspace any
file outside a package can; a package lists
`"atproto": {"path": "<path to packages/atproto/zena>"}` in its
`zena-package.json` dependencies.

## Libraries

- `atproto:varint`: multiformats unsigned varints.
- `atproto:multibase`: multibase strings, and base58btc. The other base
  encodings are in `zena:encoding`.
- `atproto:cid`: CIDs, their binary and string forms, and the CIDs atproto
  gives records and blobs.
- `atproto:data`: the data model (`Value` and its cases), its JSON form, and
  blob references (`BlobRef`).
- `atproto:cbor`: DAG-CBOR encoding and strict decoding, `cidForValue`, and
  `sortedKeys`, the order DAG-CBOR writes map keys in.
- `atproto:syntax`: DIDs, handles, NSIDs, record keys, TIDs, datetimes and
  CID strings.
- `atproto:car`: CAR files and `BlockMap`, checking every block against its
  CID.
- `atproto:mst`: the Merkle search tree: key heights, nodes, building a
  tree, and looking a key up through the nodes of a proof.
- `atproto:repo`: commits, and verifying `com.atproto.sync.getRecord`
  proofs.
- `atproto:didkey`: public keys as multikeys, `did:key`s and DID document
  verification methods, and checking atproto signatures with them.
- `atproto:did`: what atproto reads from a DID document: the signing key,
  the PDS and the claimed handle.
- `atproto:service-auth`: service-auth JWTs, which an account's PDS signs
  so the account can call another service: creating them, checking them
  against the issuer's key, the audience, the method and the time, and
  refusing a token presented twice (`ReplayGuard`).
- `atproto:xrpc`: HTTP requests and an XRPC client.
- `atproto:identity`: resolving DIDs (`did:plc`, `did:web`) and handles
  (DNS over HTTPS, then HTTPS), checking handles in both directions.
- `atproto:sync`: fetching a record and checking its proof against the DID
  document's key, fetching a blob and checking it against its CID, and
  listing a collection's records, which comes with no proof.

`atproto:xrpc`, `atproto:identity` and `atproto:sync` send requests with
`wasi:http`, so they compile for the `zena-cli` and `component` targets
only. The other libraries have no imports from the host.

## Tests

From the repository root:

```sh
npm test -w @zena-lang/atproto
```

The known-answer vectors under `zena/test/fixtures/interop` are copied from
[bluesky-social/atproto-interop-tests](https://github.com/bluesky-social/atproto-interop-tests)
(CC0); `zena/test/fixtures/interop/README.md` records the commit.
