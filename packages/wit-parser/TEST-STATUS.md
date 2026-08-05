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

Name resolution then had a gap of its own, for the same reason — the corpus
never puts two things with one name in scope at once:

4. **An interface name shadowed by a type bound from an earlier `use`** — a
   `use` path was resolved with a general symbol lookup that walks every
   enclosing scope, so a same-named type won. `wasi:sockets` depends on the
   distinction: `interface network` declares `resource network`, so
   `use network.{network}` binds a type whose name equals the interface's, and
   the next `use` in that interface can no longer find the interface. Covered
   by `interface-shadowed-by-use.wit`.

5. **The same interface name in two packages** — an unqualified `use types.{…}`
   inside `wasi:clocks/monotonic-clock` was answered from the scope stack, which
   during a cross-package `use` yields `wasi:sockets`' `types` instead. The two
   then looked mutually dependent. The owning package is now threaded through
   `#validateUseNames` / `#findItemInInterface` / `#getUseNameKind`, which also
   closed an unguarded mutual recursion between the last two. Covered by
   `cross-package-name-collision/`.

With those fixed, every real WASI tree we pin resolves: WASI 0.2
(`wasi:http@0.2.8` + 6 deps, 7/31/9), the `0.3.0-rc-2025-09-16` draft (6/25/8),
and **released WASI 0.3.0** from `WebAssembly/WASI` (6/25/8). The last of those
has no vendored deps and one `wit/` per proposal, so it exercises the
topological package ordering rather than a `deps/` directory.

Both are asserted by `npm test`, against a pinned copy of the real WIT
(`test:real-wit` → `node dev/parse-real-wit.js --check`), with exact counts so
they cannot regress silently. See the README for how the corpus is fetched; the
check fails rather than skips when it is missing.

That check earned its keep immediately: it had pinned the p3 *failure*, so the
moment p3 started resolving it said so and named what to update.


Detail and impact: [component-model.md](../../docs/design/component-model.md),
Part 9.

Regression tests for these should be added to `tests/` as they are fixed, so the
corpus stops under-representing real WIT.
