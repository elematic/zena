# WIT Parser Test Status

**Last Updated**: 2026-08-05
**Summary**: 213/213 passing (100%)

- 130/130 error tests (`parse-fail/*`)
- 81/81 ported success tests (resolve + `.wit.json` compare)
- 2/2 tests of our own, covering gaps the ported corpus missed

Run with `npm test -w @zena-lang/wit-parser` (~11s). Run it through npm, not
`node scripts/run-tests.js` — the compiled runner goes stale against
`src/scripts/run-tests.ts`, and a stale one fails every test on a stdlib path
that no longer exists.

Per-test tables are not maintained here — the suite is green, so the runner's
own output is the source of truth.

## The corpus under-represented real WIT

The ported wasm-tools UI corpus is synthetic and missed three combinations that
every shipping WASI package uses. Until they were fixed, neither
`wasi:http@0.2.8` nor `wasi:http@0.3.0-rc-2025-09-16` would parse:

1. **Pre-release/build semver in a `use`/`import` path** — the version parser
   consumed the `.` separating `@1.0.0-alpha` from `.{a}`. Covered by
   `versioned-paths/`.
2. **Versioned interface path in a world `import`/`export`** — that path had its
   own copy of the version parser which accepted the version only *before* the
   slash, while WIT puts it after. Covered by `versioned-paths/`.
3. **Doc comment inside a function parameter list** — covered by
   `param-doc-comments.wit`.

Real WASI still fails *after* parsing, in name resolution. Check with
`node dev/parse-real-wit.mjs <wit-dir>`.


Detail and impact: [component-model.md](../../docs/design/component-model.md),
Part 9.

Regression tests for these should be added to `tests/` as they are fixed, so the
corpus stops under-representing real WIT.
