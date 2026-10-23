# Google Cloud for Zena

Clients for Google Cloud APIs, for servers on Cloud Run and other Google
compute. The modules make requests through `wasi:http`, so they compile
for component targets.

- `google-cloud:firestore`: a Firestore client.
- `google-cloud:storage`: a Cloud Storage client, for writing, reading
  and deleting objects.
- `google-cloud:auth`: access tokens and the project id, from the
  metadata server or the environment.
- `google-cloud:firestore-v1` and `google-cloud:storage-v2`: the protobuf
  generator's output for `google.firestore.v1` and `google.storage.v2`,
  which the clients are built on. They are generated, not edited; see
  [Regenerating](#regenerating).

The design is in [docs/design/protobuf.md](../../docs/design/protobuf.md).
The package map needs `"google-cloud": "./packages/google-cloud/zena"`
and `"protobuf": "./packages/protobuf/zena"`.

## Firestore

```zena
import { Direction, Fields, Firestore, Operator, integerValue } from 'google-cloud:firestore';

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

`Firestore.connect()` finds the project and credentials as described
under [Credentials](#credentials), and talks gRPC to the API.
`new Firestore({projectId, databaseId?, transport})` names them instead.

- References: `db.collection(path)`, `db.doc(path)`,
  `collection.doc(id)`, `doc.collection(id)`. `collection.add(fields)`
  creates a document with a random id.
- Writes: `set` replaces a document, `create` fails with ALREADY_EXISTS
  when it exists, `update` sets the named top-level fields and fails with
  NOT_FOUND when it does not exist, and `delete` removes it. Errors are
  `RpcError`s carrying the `google.rpc.Code`.
- Transforms, which the server applies when the write commits:
  `Fields.serverTimestamp`, `increment`, `incrementDouble`, `maximum`,
  `minimum`, `arrayUnion` and `arrayRemove`. In an `update`,
  `deleteField` removes a field. They apply to top-level fields, and work
  in batches and transactions too:
  `post.update(new Fields().increment('views', 1).serverTimestamp('seen'))`.
  A transform or deletion replaces an earlier value of the same field; a
  value set after a transform leaves both, which the server rejects.
- Reads: `get()` answers a `DocumentSnapshot`, whose `exists` is false
  for a missing document. `getString`, `getInteger`, `getDouble` and
  `getBoolean` take a field path such as `author.name` and answer
  `(true, value)`, or `(false, _)` when the field is absent or of
  another type. `get(path)` answers the raw `Value`. `db.getAll(refs)`
  reads several documents in one call, in the order given.
- Queries: `where`, `orderBy`, `limit`, `offset` and `select` each
  return a new query. `get()` collects the results; `stream()` hands out
  each one as it arrives, for `for await`; `count()` counts them on the
  server.
- Cursors: `startAt`, `startAfter`, `endAt` and `endBefore` take values
  for the orderings, or a snapshot. To page, order the query and pass
  the last snapshot of a page to `startAfter`; documents tied on every
  ordering are ordered by name, so none is skipped or repeated.
- `db.batch()` collects writes and commits them in one call.
- `db.runTransaction(body)` runs `body` with a `Transaction`, whose
  reads (`get`, `getAll`, `query`) happen in the transaction and whose
  writes commit when `body` returns. A transaction aborted by contention
  is retried, up to five attempts; when `body` throws, the transaction is
  rolled back.
- `Firestore.connect({timeout: milliseconds(10000)})` gives each call a deadline;
  a call still running then fails with DEADLINE_EXCEEDED.

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

### Transports

- `Firestore.connect()` uses gRPC (`protobuf:grpc`). gRPC needs HTTP/2,
  which `zena-cli` and `zena-run` provide, with pooled connections.
- `Firestore.connectFallback()` uses Google's gRPC fallback protocol
  (`protobuf:fallback`), which works on any `wasi:http` host, stock
  `wasmtime serve` among them.
- `new Firestore({projectId, transport})` takes any `ProtoTransport`:
  `new GrpcTransport(FIRESTORE_ORIGIN, credentials)`,
  `new FallbackTransport(FIRESTORE_ORIGIN, credentials)`, or a test's
  own.

A program carries only the transports it names: about 29 KB at `-O2`
for gRPC beside the fallback transport.

### The emulator

When `FIRESTORE_EMULATOR_HOST` is set to the Firestore emulator's
`host:port`, `Firestore.connect()` talks gRPC to it, as Google's client
libraries do, with the token `owner`, which bypasses security rules. The
project id is `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT`, or `demo-zena`.
The emulator speaks gRPC and REST but not the fallback protocol, so this
needs `zena-cli` or `zena-run`.

A program can use the emulator in development and the real API in
production with no change: a development script sets
`FIRESTORE_EMULATOR_HOST` and depends on the repository's
`emulators:start` service, as `test:emulator` does, and production
leaves it unset.

## Cloud Storage

```zena
import { Storage } from 'google-cloud:storage';

let bucket = Storage.connect().bucket('my-bucket');
await bucket.write('notes/hello.txt', bytes, 'text/plain');
let read = await bucket.read('notes/hello.txt'); // null when there is none
let object = await bucket.stat('notes/hello.txt'); // its metadata, or null
await bucket.delete('notes/hello.txt'); // whether there was one
```

`Storage.connect()` uses the default credentials (see
[Credentials](#credentials)) and talks gRPC to the API, so it needs
`zena-cli` or `zena-run`. An upload is a client-streaming call, which
Google's fallback protocol cannot carry. `write` sends the data in
chunks of at most 2 MiB, in one call, and replaces any object of the
same name. Writes send no CRC32C checksums, and reads do not check the
ones the server sends. `new Storage(transport)` takes any
`ProtoTransport`, and `storage.client` is the generated `StorageClient`,
for the calls the client does not wrap.

There is no emulator for Cloud Storage's gRPC API here, so the tests run
the client against an in-memory transport only.

## Credentials

`defaultCredentials()`:

- `GOOGLE_OAUTH_ACCESS_TOKEN`, when set, is sent as is. For local runs:
  `GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)`.
- Otherwise the metadata server, at `GCE_METADATA_HOST` when set,
  supplies tokens for the service account. A token is kept until a
  minute before it expires.

`defaultProjectId()` is `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT` when
set, and the metadata server's answer otherwise.

## Regenerating

```sh
npm run generate -w @zena-lang/google-cloud
```

The test fails when `firestore-v1.zena` or `storage-v2.zena` differs
from the generator's output.

## Testing

```sh
npm test -w @zena-lang/google-cloud
```

The Firestore and Cloud Storage tests run the clients against in-memory
transports; the credential tests run a local server that answers like
the metadata server.

```sh
npm run test:emulator -w @zena-lang/google-cloud
```

runs the client against the Firestore emulator over gRPC
(`zena/emulator/`). It depends on the repository's `emulators:start`
script, a wireit service that starts the emulator on `127.0.0.1:8180`
(`firebase.json`) before the tests and stops it after. The service
enters the flake's `emulators` shell for firebase-tools and Java, which
are about 2 GB and so not in the default shell; firebase-tools downloads
the emulator itself on first use. That is also why this suite is not
part of `npm test`. Each test uses a project of its own, which the
emulator keeps apart.
