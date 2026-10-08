# WIT Parser Test Status

**Last Updated**: 2026-10-08
**Summary**: green

- 138/138 error cases (`parse-fail/*`, which must fail to parse or resolve)
- 78/78 ported success cases (resolve + `.wit.json` compare), one of which is a
  component the check decodes with `wasm-tools` rather than WIT text
- 34 lexer and parser tests, including the constructs the ported corpus missed
- 6 component-encoder fixtures, validated and round-tripped through `wasm-tools`

Run with `npm test -w @zena-lang/wit-parser`. The tests are Zena tests under
`zena/test/`, run by `zena-cli test`; `zena test --single <file>` prints one
file's output, which is how to see the per-case counts.

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
   own copy of the version parser which accepted the version only _before_ the
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
(`test:real-wit` → `dev/parse-real-wit.zena --check`), with exact counts so
they cannot regress silently. See the README for how the corpus is fetched; the
check fails rather than skips when it is missing.

That check earned its keep immediately: it had pinned the p3 _failure_, so the
moment p3 started resolving it said so and named what to update.

Detail and impact: [component-model.md](../../docs/design/component-model.md),
Part 9.

Regression tests for these should be added to `tests/` as they are fixed, so the
corpus stops under-representing real WIT.
