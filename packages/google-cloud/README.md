# Google Cloud for Zena

Clients for Google Cloud APIs, for servers on Cloud Run and other Google
compute. The modules make requests through `wasi:http`, so they compile
for component targets.

- `google-cloud:firestore`: a Firestore client.
- `google-cloud:auth`: access tokens and the project id, from the
  metadata server or the environment.
- `google-cloud:firestore-v1`: the protobuf generator's output for
  `google.firestore.v1`, which the client is built on. It is generated,
  not edited; see [Regenerating](#regenerating).

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
- Reads: `get()` answers a `DocumentSnapshot`, whose `exists` is false
  for a missing document. `getString`, `getInteger`, `getDouble` and
  `getBoolean` take a field path such as `author.name` and answer
  `(true, value)`, or `(false, _)` when the field is absent or of
  another type. `get(path)` answers the raw `Value`.
- Queries: `where`, `orderBy`, `limit` and `offset` each return a new
  query. `get()` collects the results; `stream()` hands out each one as
  it arrives, for `for await`.
- `db.batch()` collects writes and commits them in one call.
- `db.runTransaction(body)` runs `body` with a `Transaction`, whose
  reads happen in the transaction and whose writes commit when `body`
  returns. A commit aborted by contention is retried, up to five
  attempts; when `body` throws, the transaction is rolled back.

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

The test fails when `firestore-v1.zena` differs from the generator's
output.

## Testing

```sh
npm test -w @zena-lang/google-cloud
```

The Firestore tests run the client against an in-memory Firestore
transport; the credential tests run a local server that answers like
the metadata server.

```sh
npm run test:emulator -w @zena-lang/google-cloud
```

runs the client against the Firestore emulator over gRPC
(`zena/emulator/`). It is not part of `npm test`, since it needs Java
and the emulator: `scripts/with-firestore-emulator.sh` takes Java from
`PATH` or nixpkgs, and the emulator's jar from `FIRESTORE_EMULATOR_JAR`
or firebase-tools' download cache, downloading it when it is missing.
Each test uses a project of its own, which the emulator keeps apart.
