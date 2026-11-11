# google-cloud

Google Cloud client libraries for Zena, built on `wasi:http` and `@zena/protobuf` so they compile for WebAssembly component targets as well as the `zena` CLI host.

## Installation

```sh
zena pkg add @zena/google-cloud
```

## Libraries

- `google-cloud/firestore` — Firestore document, collection, query, batch, and transaction client.
- `google-cloud/storage` — Cloud Storage client for reading, writing, stating, and deleting objects.
- `google-cloud/dns` — Cloud DNS client for managing record sets in a managed zone.
- `google-cloud/kms` — Cloud KMS client for asymmetric signing and symmetric encryption/decryption.
- `google-cloud/auth` — Default credentials and project ID discovery from the GCE metadata server or environment variables.
- `google-cloud/firestore-v1` and `google-cloud/storage-v2` — Generated protobuf messages and low-level service clients for `google.firestore.v1` and `google.storage.v2`.
- `google-cloud/testing/fake-kms` and `google-cloud/testing/firestore-emulator` — Test helpers for in-process fake Cloud KMS and the Firestore emulator.

## Firestore

```zena
import { Direction, Fields, Firestore, Operator, integerValue } from 'google-cloud/firestore';

let db = await Firestore.connect();

let post = db.collection('posts').doc('hello');
await post.set(new Fields().string('title', 'Hello').integer('views', 0));

let snapshot = await post.get();
if (let (true, views) = snapshot.getInteger('views')) {
  await post.update(new Fields().integer('views', views + 1));
}

let popular = await db.collection('posts')
  .where('views', Operator.GreaterThan, integerValue(100))
  .orderBy('views', Direction.Descending)
  .limit(10)
  .get();
for (let p in popular) {
  console.log(p.id);
}
```

`Firestore.connect()` discovers the project and credentials as described under [Credentials](#credentials) and talks gRPC to the API. `new Firestore({projectId, databaseId?, transport})` accepts explicit configuration instead.

- **References**: `db.collection(path)`, `db.doc(path)`, `collection.doc(id)`, `doc.collection(id)`. `collection.add(fields)` creates a document with a random ID.
- **Writes**: `set` replaces a document, `create` fails with `ALREADY_EXISTS` when it exists, `update` sets the named top-level fields and fails with `NOT_FOUND` when it does not exist, and `delete` removes it. Errors are `RpcError`s carrying the `google.rpc.Code`.
- **Transforms** (applied by the server when the write commits): `Fields.serverTimestamp`, `increment`, `incrementDouble`, `maximum`, `minimum`, `arrayUnion`, and `arrayRemove`. In an `update`, `deleteField` removes a field. They apply to top-level fields and work in batches and transactions as well:
  `post.update(new Fields().increment('views', 1).serverTimestamp('seen'))`.
- **Reads**: `get()` returns a `DocumentSnapshot`, whose `exists` is `false` for a missing document. `getString`, `getInteger`, `getDouble`, and `getBoolean` take a field path such as `author.name` and return `(true, value)` or `(false, _)` when the field is absent or of another type. `get(path)` returns the raw `Value`. `db.getAll(refs)` reads several documents in one call in the order given.
- **Queries**: `where`, `orderBy`, `limit`, `offset`, and `select` each return a new query. `get()` collects the results; `stream()` yields each document as it arrives (`for await`); `count()` counts them on the server.
- **Cursors**: `startAt`, `startAfter`, `endAt`, and `endBefore` take values for the orderings or a `DocumentSnapshot`.
- **Batches & Transactions**: `db.batch()` collects writes and commits them in one call. `db.runTransaction(body)` runs `body` with a `Transaction`, retrying up to five times on contention and rolling back if `body` throws.
- **Deadlines**: `Firestore.connect({timeout: milliseconds(10000)})` gives each call a deadline, failing with `DEADLINE_EXCEEDED` if exceeded.

```zena
let total = await db.runTransaction<i64>(async (tx: Transaction): Future<i64> => {
  let counter = db.doc('counters/visits');
  let snapshot = await tx.get(counter);
  var n: i64 = 0;
  if (let (true, stored) = snapshot.getInteger('n')) {
    n = stored;
  }
  tx.set(counter, new Fields().integer('n', n + 1));
  return n + 1;
});
```

### Transports & Emulator

- `Firestore.connect()` uses gRPC (`protobuf/grpc`) over HTTP/2. When `FIRESTORE_EMULATOR_HOST` is set to `host:port`, `Firestore.connect()` connects to the Firestore emulator over cleartext HTTP/2 with the `owner` token.
- `Firestore.connectFallback()` uses Google's gRPC fallback protocol (`protobuf/fallback`), which works on HTTP/1.1-only `wasi:http` hosts such as stock `wasmtime serve`.
- `new Firestore({projectId, transport})` accepts any `ProtoTransport`.

## Cloud Storage

```zena
import { Storage } from 'google-cloud/storage';

let bucket = Storage.connect().bucket('my-bucket');
await bucket.write('notes/hello.txt', bytes, 'text/plain');
let read = await bucket.read('notes/hello.txt'); // null when absent
let object = await bucket.stat('notes/hello.txt'); // metadata, or null
await bucket.delete('notes/hello.txt'); // true if deleted
```

`Storage.connect()` uses the default credentials and talks gRPC to the Cloud Storage API (`write` streams data in chunks of at most 2 MiB). `new Storage(transport)` accepts any `ProtoTransport`, and `storage.client` exposes the generated `StorageClient`.

## Cloud DNS

```zena
import { CloudDns, RecordSet } from 'google-cloud/dns';

let zone = CloudDns.connect('my-project', 'my-zone');
await zone.put(new RecordSet('_atproto.alice.example.com.', 'TXT', 300, ['"did=did:plc:..."']));
let set = await zone.get('_atproto.alice.example.com.', 'TXT'); // null when absent
await zone.delete('_atproto.alice.example.com.', 'TXT'); // true if deleted
```

`CloudDns` uses the Cloud DNS REST API (`https://dns.googleapis.com/dns/v1`) with default credentials. Names are fully qualified (ending in a `.`), and `put` creates or replaces the record set of that name and type.

## Cloud KMS

```zena
import { sha256 } from 'zena:crypto';
import { CloudKms, ecPointFromPem } from 'google-cloud/kms';

// Asymmetric signing
let signingKey = CloudKms.connect(
  'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1'
);
let derSignature = await signingKey.asymmetricSign(sha256(message));
let pubKey = await signingKey.publicKey();
let uncompressedPoint = ecPointFromPem(pubKey.pem);

// Symmetric encryption (AEAD)
let symmetricKey = CloudKms.connect('projects/p/locations/l/keyRings/r/cryptoKeys/s');
let ciphertext = await symmetricKey.encrypt(plaintext, additionalData);
let decrypted = await symmetricKey.decrypt(ciphertext, additionalData);
```

## Credentials

`defaultCredentials()` (`google-cloud/auth`):

- `GOOGLE_OAUTH_ACCESS_TOKEN`, when set in the environment, is used directly (for local runs: `GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)`).
- Otherwise, the GCE metadata server (at `GCE_METADATA_HOST` when set, or `metadata.google.internal`) supplies tokens for the default service account, caching each token until a minute before it expires.

`defaultProjectId()` reads `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT` when set, falling back to the metadata server.

## License

MIT
