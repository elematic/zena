# Third-party sources

## `wasmtime/`

The `wasmtime` 50.0.1 crate as published on crates.io, with one change,
`wasmtime-nop-hasher.patch`. The root `Cargo.toml` builds it in place of
the published crate through `[patch.crates-io]`; `wasmtime-wasi` and the
other crates that depend on `wasmtime` 50.0.1 use it too.

The change is to `NopHasher`, the hasher of two of wasmtime's maps: the
store's cache of subtype checks (`ref.cast` and `ref.test` against a type
with subtypes) and the collector's trace info per type. It returned the
key as the hash. hashbrown takes a key's bucket from the hash's low bits
and a 7-bit tag from its top bits, and a type index's top bits are zero,
so every entry had the same tag. The subtype cache's key is
`(sub << 32) | sup`, so every pair with the same supertype also started
probing at the same bucket, and the length of a lookup depended on the
exact type indices the engine assigned.

Those indices change with any change to a module the engine loads, so
the compiler's speed did too. Compiling the compiler at `-O1` took 17.0 s
with one build of the CLI module and 24.4 s with another that does less
work, all of the difference in reachability, where most of the subtype
checks are. With the patch the two take 15.6 s and 14.9 s, and the
emitted module is the same bytes. `docs/design/compiler-memory.md` has the
first measurement of this, at 2 s.

The patch runs the key through Murmur3's 64-bit finalizer, which spreads
every bit of the key into both the bucket and the tag.

The problem is reported to wasmtime. Delete this copy, the patch file and
the `[patch.crates-io]` entry once a wasmtime release fixes it.

### Updating wasmtime

`[patch.crates-io]` applies only to the exact version it replaces, so a
wasmtime update needs a new copy:

```bash
rm -rf third_party/wasmtime
cp -r ~/.cargo/registry/src/*/wasmtime-<version> third_party/wasmtime
rm third_party/wasmtime/.cargo-ok
patch -d third_party/wasmtime -p1 < third_party/wasmtime-nop-hasher.patch
```

Run `cargo fetch` first so the registry has the new version. Check that
`Cargo.lock` lists `wasmtime` without a `source` line, which means the
copy is the one in use.
