# Development

## Layout

```
zena-package.json      Package manifest
src/                   Zena library sources
test/                  Unit and interop tests (*_test.zena)
  fixtures/            Known-answer test vectors
```

The known-answer vectors under `test/fixtures/interop` are copied from [bluesky-social/atproto-interop-tests](https://github.com/bluesky-social/atproto-interop-tests) (CC0); `test/fixtures/interop/README.md` records the commit.

## Running Tests

From the repository root:

```sh
npm test -w @zena-lang/atproto
```

Or run a test file directly with `zena-cli`:

```sh
./target/release/zena-cli test packages/atproto/test/cbor_test.zena
```
