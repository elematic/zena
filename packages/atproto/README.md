# atproto for Zena

Libraries for the [AT Protocol](https://atproto.com): its data model,
encodings, cryptography and repositories. The package manager
([docs/design/package-manager.md](../../docs/design/package-manager.md))
publishes and verifies packages with them.

Import them as `atproto:<module>`, with an
`"atproto": "./packages/atproto/zena"` entry in `zena-packages.json`.

## Modules

- `atproto:bytes`: hex encoding, comparison and slicing of byte arrays.
- `atproto:varint`: multiformats unsigned varints.

## Tests

From the repository root:

```sh
npm test -w @zena-lang/atproto
```

The known-answer vectors under `zena/test/fixtures/interop` are copied from
[bluesky-social/atproto-interop-tests](https://github.com/bluesky-social/atproto-interop-tests)
(CC0); `zena/test/fixtures/interop/README.md` records the commit.
