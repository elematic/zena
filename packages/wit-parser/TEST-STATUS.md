# WIT Parser Test Status

**Last Updated**: 2026-08-04
**Summary**: 211/211 ported wasm-tools UI tests passing (100%)

- ✅ 130/130 error tests (`parse-fail/*`)
- ✅ 81/81 success tests (resolve + `.wit.json` compare)
- ⏭️ 0 skipped

Run with `npm test -w @zena-lang/wit-parser` (~11s).

Per-test tables are not maintained here — the suite is green, so the runner's
own output is the source of truth. This file exists mainly to record the caveat
below, which the pass rate hides.

## The corpus is not representative

Passing 211/211 does **not** mean we can parse real WIT. The ported wasm-tools
UI corpus is synthetic and misses three combinations that every shipping WASI
package uses. As of 2026-08-04, neither `wasi:http@0.2.8` nor
`wasi:http@0.3.0-rc-2025-09-16` parses:

1. **Prerelease/build semver in a `use`/`import` path** — `use
   foo:bar/baz@1.0.0-alpha.{a}` fails, though `@1.0.0` works and prereleases
   parse fine in `package` declarations and in `@since(...)`. Blocks all of
   WASI p3, whose every package is `@0.3.0-rc-2025-09-16`.
2. **Versioned interface path in a world `import`/`export`** — `import
   wasi:clocks/monotonic-clock@0.2.8;` fails, though `include` of the same
   versioned path works. Blocks the p2 `proxy` and p3 `service`/`middleware`
   worlds.
3. **Doc comment inside a function parameter list** — a `///` line between
   `func(` and the first parameter fails, though `//` in that position and
   `///` inside records/variants/resource bodies all work. Blocks
   `wasi:io/streams`, `wasi:filesystem/types`, `wasi:sockets/*`.

Reproduce: `node dev/parse-real-wit.mjs --probe`.
Detail and impact: [component-model.md](../../docs/design/component-model.md),
Part 9.

Regression tests for these should be added to `tests/` as they are fixed, so the
corpus stops under-representing real WIT.
