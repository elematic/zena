# atproto

Libraries for the [AT Protocol](https://atproto.com) in Zena: its data model, encodings, cryptography, identity resolution, and repositories.

## Usage

```zena
import {cidForValue, decodeCbor, encodeCbor} from 'atproto/cbor';
import {StringValue, newMap, stringField} from 'atproto/data';

let record = newMap([
  ('$type', new StringValue('app.bsky.feed.post')),
  ('text', new StringValue('Hello from Zena!')),
]);

let bytes = encodeCbor(record);
let cid = cidForValue(record);
let decoded = decodeCbor(bytes);
```

## Libraries

- `atproto/varint`: multiformats unsigned varints.
- `atproto/multibase`: multibase strings, and base58btc. The other base encodings are in `zena:encoding`.
- `atproto/cid`: CIDs, their binary and string forms, and the CIDs atproto gives records and blobs.
- `atproto/data`: the data model (`Value` and its cases), its JSON form, and blob references (`BlobRef`).
- `atproto/cbor`: DAG-CBOR encoding and strict decoding, `cidForValue`, and `sortedKeys`, the order DAG-CBOR writes map keys in.
- `atproto/syntax`: DIDs, handles, NSIDs, record keys, TIDs, datetimes, and CID strings.
- `atproto/car`: CAR files and `BlockMap`, checking every block against its CID.
- `atproto/mst`: the Merkle search tree: key heights, nodes, building a tree, and looking a key up through the nodes of a proof.
- `atproto/repo`: commits, signing them, and verifying `com.atproto.sync.getRecord` proofs.
- `atproto/tid`: timestamp identifiers, and a clock that hands out increasing ones.
- `atproto/didkey`: public keys as multikeys, `did:key`s, and DID document verification methods, and checking atproto signatures with them.
- `atproto/did`: what atproto reads from a DID document: the signing key, the PDS, and the claimed handle.
- `atproto/service-auth`: service-auth JWTs, which an account's PDS signs so the account can call another service: creating them, checking them against the issuer's key, the audience, the method, and the time, and refusing a token presented twice (`ReplayGuard`).
- `atproto/session`: signing in to an account's PDS with a password, refreshing and ending the session, and asking the PDS for service-auth tokens.
- `atproto/xrpc`: an XRPC client.
- `atproto/methods`: the NSIDs of standard `com.atproto` methods, and `xrpcPath`, a method's path on a server.
- `atproto/plc`: `did:plc` operations: building and signing them, the DID a genesis operation makes, and sending an operation to a PLC directory.
- `atproto/identity`: resolving DIDs (`did:plc`, `did:web`) and handles (DNS over HTTPS, then HTTPS), checking handles in both directions.
- `atproto/sync`: fetching a record and checking its proof against the DID document's key, fetching a blob and checking it against its CID, and listing a collection's records, which comes with no proof.

`atproto/xrpc`, `atproto/identity`, `atproto/sync`, `atproto/session`, and `atproto/plc` send requests with `zena:fetch`. The other libraries have no imports from the host.
