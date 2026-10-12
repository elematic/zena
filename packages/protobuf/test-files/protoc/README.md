# Messages encoded by protoc

Each `.binpb` is the `.txtpb` beside it, encoded by `protoc` against
`zena/test/v1/everything.proto`. `generated_test.zena` decodes them with
the generated code, and encodes the same values and compares the bytes,
so the runtime is checked against protoc's encoder without needing
protoc to run the tests.

Regenerate from `packages/protobuf` (protoc 36.2 made the checked-in
files):

```sh
for m in node:Node scalars:Scalars; do
  protoc -I test-files/protos -I protos \
    --encode=zena.test.v1.${m##*:} zena/test/v1/everything.proto \
    < test-files/protoc/${m%%:*}.txtpb > test-files/protoc/${m%%:*}.binpb
done
```
