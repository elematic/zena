# `zena:url` Design & Implementation Plan

## Overview

`zena:url` brings URL parsing, serialization, building, and matching to Zena's
standard library. This document covers the design of the initial `URL` /
`URLSearchParams` core and the plan for the follow-on `URLPattern` and
`URLPatternList` features.

## Goals

1. **WHATWG conformance**: Implement the [WHATWG URL Standard](https://url.spec.whatwg.org/),
   not RFC 3986. This is what browsers, Node.js, Deno, Bun, and Cloudflare
   Workers implement, and it comes with a large machine-readable conformance
   test suite we can port mechanically.
2. **Zena-native API**: Familiar to web developers, but adapted to Zena's
   idioms — immutability by default, no getter/setter accessors, `distinct`
   types, and tagged template literals.
3. **Pay-to-play**: Like the rest of the stdlib, unused parts (especially the
   eventual IDNA tables and `URLPattern`) must be eliminable by DCE.
4. **Foundation for routing**: `URL` → `URLPattern` → `URLPatternList` builds
   up to a router-grade matching stack.

## Specs and references

| Reference | Use |
| --- | --- |
| [WHATWG URL Standard](https://url.spec.whatwg.org/) | The spec we implement: URL record, basic URL parser state machine, percent-encode sets, host parsing, `application/x-www-form-urlencoded`, API section (getter/setter algorithms). |
| [URLPattern Standard](https://urlpattern.spec.whatwg.org/) | WHATWG living standard (graduated from WICG). Shipped in Chrome 95+, Deno, Node 23.8+ (via Ada), Cloudflare Workers, Firefox 142+, Safari 26+. |
| [WPT url/resources](https://github.com/web-platform-tests/wpt/tree/master/url/resources) | Machine-readable conformance data: `urltestdata.json`, `setters_tests.json`, `toascii.json`, `percent-encoding.json`, `IdnaTestV2.json`. Format documented in [url/README.md](https://github.com/web-platform-tests/wpt/blob/master/url/README.md). |
| [WPT urlpattern/resources](https://github.com/web-platform-tests/wpt/tree/master/urlpattern/resources) | `urlpatterntestdata.json` for the `URLPattern` phase. |
| [jsdom/whatwg-url](https://github.com/jsdom/whatwg-url) | Reference-quality JS implementation; the cleanest mapping from spec prose to code (`basicURLParse`, state-override parsing for setters). |
| [Ada](https://github.com/ada-url/ada) | C++ parser used by Node. Study for performance: `url_aggregator` stores one normalized buffer + component offsets. Also ships the URLPattern implementation Node uses. |
| [servo/rust-url](https://github.com/servo/rust-url) | Rust implementation. Study for project structure: separate `percent-encoding`, `form_urlencoded`, `idna` layers; vendors WPT JSON and keeps an `expected_failures.txt` while incomplete. |
| [Node `node:url`](https://nodejs.org/api/url.html) | WHATWG `URL` + legacy `url.parse()`. We implement only the WHATWG part; the legacy API is a non-goal. |
| [url-pattern-list](https://github.com/justinfagnani/url-pattern-list) | Prefix-trie multi-pattern matcher to port in the final phase. |

## Scope

**v1 (`zena:url`)**: `URL` (parse, serialize, resolve against base, derive
modified copies), `URLSearchParams`, percent-encoding utilities.

**Later phases** (still exported from `zena:url`): IDNA/UTS 46 host
processing, `UrlString` distinct type, `url` template tag, `URLPattern`,
`URLPatternList`.

**Non-goals**: Node's legacy `url.parse()`/`format()` API; the spec's
`encoding override` (we always use UTF-8); relative-reference resolution per
RFC 3986 semantics where they differ from WHATWG.

## Module layout

There is **one public library, `zena:url`**, implemented as multiple files in
this directory. Everything — `URL`, `URLSearchParams`, and later `URLPattern`
and `URLPatternList` — is imported from `zena:url`; DCE (not module
granularity) is what keeps unused pieces out of binaries, consistent with the
stdlib's pay-to-play principle.

```
packages/stdlib/zena/url/
  README.md, DESIGN.md   # these docs
  index.zena             # public entry for 'zena:url' — re-exports only
  url.zena               # URL
  search-params.zena     # URLSearchParams
  encoding.zena          # percent-encode sets, form-urlencoded codec
  template.zena          # url template tag, UrlString (later)
  idna.zena              # UTS 46 + punycode (later)
  pattern.zena           # URLPattern (later)
  pattern-list.zena      # URLPatternList (later)
```

```zena
// index.zena
export {URL} from './url.zena';
export {URLSearchParams} from './search-params.zena';
export {url, UrlString} from './template.zena';
export {URLPattern} from './pattern.zena';
export {URLPatternList} from './pattern-list.zena';
```

Implementation files import each other with relative specifiers and are not
reachable via `zena:` specifiers at all — stronger encapsulation than the
manifest's current `internal` list gives.

### Required stdlib loader changes

Today the loaders resolve `zena:<name>` only to a flat `zena/<name>.zena`.
**Decision: the loader/manifest changes below land as their own PR, before any
URL implementation work**, since they also pay off immediately for `console`.

1. **Manifest entries name their entry file**: each module entry gets an
   optional `path`, relative to `zena/`, defaulting to `<name>.zena`:

   ```json
   "url": {"path": "url/index.zena"}
   ```

   An explicit path (rather than probing for `<name>.zena` then
   `<name>/index.zena`) keeps the self-hosted `ModuleResolver` pure — it does
   no I/O by design, so resolution must stay a dictionary lookup + path join.
   - Bootstrap: `packages/stdlib/src/lib/module-loader.ts`
     (`loadStdlibModule`) plus wherever the compiler host resolves stdlib
     specifiers.
   - Self-hosted: `packages/zena-compiler/zena/lib/module-resolver.zena`
     (`resolvePackage` / the stdlib file-path branch).
2. **Virtual modules map to files, not module names** (the `console` fix):

   ```json
   "console": {"virtual": {"host": "console/host.zena", "wasi": "console/wasi.zena"}}
   ```

   `console-host.zena`/`console-wasi.zena`/`console-interface.zena` move into
   `zena/console/`, stop being nameable modules entirely, and the `internal`
   list — plus the "is the referrer a stdlib file?" checks in both resolvers —
   is deleted. "Not in the manifest" becomes the only privacy mechanism.
3. **Relative imports between stdlib files** work in both compilers, resolved
   in the space of stdlib-root-relative file paths. Canonical ids come in two
   shapes: name ids (`zena:string`) for manifest modules whose entry file is
   the default `<name>.zena`, and path ids (`zena:url/encoding.zena` — always
   containing the file path) for everything else, including all `path` and
   `virtual` entry files. Each file has exactly one canonical id, so module
   dedup and caching stay consistent, and hosts map ids to files without
   consulting the manifest (append `.zena` unless the id already ends with
   it).
4. **Manifest stays the public registry**: `"url"` is the only new entry.
   Files under `zena/url/` are unlisted and therefore private.
5. **No build changes**: the wireit inputs already glob `zena/**/*.zena`.

One cost to note: importing `zena:url` parses/checks every file the index
re-exports, even if you only use `URL`. That's compile-time only (DCE trims
the output), and the index can stage its re-exports as phases land, but if it
ever matters the fix is lazy export resolution in the checker, not more
modules.

## API design

### Zena constraints that shape the API

The web's `URL` is a mutable object whose surface is entirely getter/setter
pairs (`url.pathname = '/x'` re-parses and renormalizes). Zena has:

- **No computed accessors** — only fields, `var(#name)` public-read/private-write
  fields, and methods. We cannot intercept `url.pathname = ...`.
- **Immutability by default** — `let` fields, records, case classes.
- **`distinct` types and tagged template literals** — both already in the
  language, enabling the `UrlString`/`url`-tag ideas below.

So Zena's `URL` is **immutable**: components are plain public fields (parsed
and normalized once, at construction), and mutation is expressed as `with*`
methods that return new `URL`s. Each `with*` method runs the spec's setter
algorithm (the basic URL parser with a *state override*), so behavior — and the
WPT setter tests — map 1:1: `url.protocol = v` in JS ⇒ `url.withProtocol(v)`
in Zena. Like the spec's setters, `with*` methods do not throw; invalid input
leaves the component unchanged (returning an equal `URL`).

Rejected alternatives: mutating `setPathname()` methods (loses value semantics
and doesn't fit Zena's ethos; no less of a departure from JS syntax than
`with*`), and a separate `UrlBuilder` class (heavier API for little gain —
`with*` chains cover building).

### `URL`

```zena
import {URL} from 'zena:url';

export final class URL {
  // Components, parsed and canonicalized. Same names and same string shapes
  // as the web API (protocol includes ':', search includes '?', hash includes
  // '#', all empty-string when absent).
  protocol: String;   // 'https:'
  username: String;
  password: String;
  hostname: String;   // 'example.com', '127.0.0.1', '[::1]', or ''
  port: String;       // '' when default for the scheme
  pathname: String;   // '/a/b' or opaque path
  search: String;     // '?q=1' or ''
  hash: String;       // '#frag' or ''
  href: String;       // full canonical serialization

  /**
   * Parses `input`, optionally against `base`; null when either fails.
   * There is no public constructor — see "Failure is a value" below.
   */
  static parse(input: String, base: String | null = null): URL | null;
  static canParse(input: String, base: String | null = null): boolean;

  // Derived components (computed, so methods rather than fields).
  host(): String;     // 'hostname:port' ('' port omitted)
  origin(): String;   // 'https://example.com:8080', or 'null' for opaque origins
  toString(): String; // same as href

  /** Snapshot of the query as URLSearchParams (see divergence note). */
  searchParams(): URLSearchParams;

  // Copy-with methods implementing the spec's setter algorithms.
  withProtocol(value: String): URL;
  withUsername(value: String): URL;
  withPassword(value: String): URL;
  withHost(value: String): URL;
  withHostname(value: String): URL;
  withPort(value: String): URL;
  withPathname(value: String): URL;
  withSearch(value: String): URL;
  withSearchParams(params: URLSearchParams): URL;
  withHash(value: String): URL;
  withHref(value: String): URL | null;  // full re-parse, so it can fail

  operator ==(other: URL): boolean;  // href equality
  hashCode(): i32;                   // so URLs work as HashMap/HashSet keys
}
```

Notes:

- **Internals**: parsing produces the spec's *URL record* (scheme, host as a
  variant domain/IPv4/IPv6/opaque/null, port as `i32 | null`, path as segment
  list or opaque string). The public fields are serialized from the record at
  construction. Whether the record itself is retained on the instance (making
  `with*` cheaper) or re-derived on demand is an implementation detail; start
  by retaining it.
- **Storage**: separate component `String` fields to start. Zena strings are
  slices over a shared `ByteArray`, so we can later adopt Ada's
  `url_aggregator` layout (one normalized `href` buffer + component offsets,
  fields become slices) without changing the API.
- **Equality/hash on `href`** makes `URL` a well-behaved value type; two URLs
  are equal iff they serialize identically (which the parser canonicalizes).
- `IsWellKnownSymbol`-style live coupling does not exist: JS's `url.searchParams`
  is a *live* object bound to the URL; since our `URL` is immutable,
  `searchParams()` returns a snapshot and `withSearchParams`/`withSearch`
  write changes back. This is the one deliberate behavioral divergence from
  the web API.

### `URLSearchParams`

An ordered, mutable multimap of `(name, value)` pairs — mutable is fine here;
it is a collection/builder, like `Array` or `StringBuilder`. Backed by a
growable array of pairs (order-preserving, duplicate keys allowed), following
the spec's `application/x-www-form-urlencoded` parser/serializer.

```zena
export final class URLSearchParams {
  new();                                  // empty
  new(init: String);                      // parses 'a=1&b=2' (leading '?' ok)

  size(): i32;
  has(name: String, value: String | null = null): boolean;
  get(name: String): String | null;
  getAll(name: String): Array<String>;
  append(name: String, value: String): void;
  set(name: String, value: String): void;
  delete(name: String, value: String | null = null): void;
  sort(): void;                           // stable sort by name
  toString(): String;                     // form-urlencoded serialization
  // Iterable<(String, String)> for for-in loops
}
```

### `UrlString` distinct type and the `url` template tag

Justin asked whether existing JS/TS projects use template tags or branded
string types for URLs. They do, in two distinct niches:

1. **Security sink typing** (branded *values* minted by tags):
   [Google safevalues](https://github.com/google/safevalues) has a
   ``trustedResourceUrl`...` `` tag returning a branded `TrustedResourceUrl`;
   the tag trusts the literal parts (developer-authored) and restricts/encodes
   interpolations. The [Trusted Types spec](https://w3c.github.io/trusted-types/dist/spec/)
   defines the runtime-enforced `TrustedScriptURL` for script-src sinks. TC39's
   [`Reflect.isTemplateObject`](https://github.com/tc39/proposal-array-is-template-object)
   exists specifically to let such tags verify literal provenance, and the
   [`String.cooked`](https://github.com/tc39/proposal-string-cooked) proposal
   uses a percent-encoding URL tag as its motivating example.
2. **Route/DX typing** (branded string *types*): Next.js typed routes'
   `Route<T>` brand validates literal `href`s against the route table; Hono and
   tRPC parse path params out of route strings with template literal types.

   (Encode-safe URL *builders* without branding also exist: `urlcat`, RFC 6570
   `url-template` — evidence that safe interpolation is the recurring need.)

No mainstream library brands general-purpose URL strings outside those niches,
but Zena is in an unusual position: `distinct type` and template tags are
language features, so we can offer the union of both patterns nearly for free:

```zena
/** A string known to be a valid, canonicalized URL serialization. */
export distinct type UrlString = String;

/**
 * Template tag that parses the URL at construction and percent-encodes each
 * interpolated value for the component it lands in (path segment, query
 * value, etc.), determined by incrementally parsing the literal parts.
 */
export let url: TemplateTag<URL> = (strings, values) => { ... };

let team = 'a/b team';
let link = url`https://example.com/teams/${team}?from=${ref}`;
// link.pathname == '/teams/a%2Fb%20team'
```

- `href` is typed `UrlString` (zero-cost — distinct types are erased), so any
  future sink API (`fetch(input: UrlString | URL)`) can require *parsed or
  provably-well-formed* input while accepting plain field access. Casting
  `as UrlString` remains the explicit escape hatch, exactly like `as Route` in
  Next.js.
- The tag gives safe *construction* (the `String.cooked` example done
  properly): literals are trusted, interpolations are contextually encoded.
  A future compiler optimization can constant-fold fully-static tagged URLs
  (same idea as the static-pattern optimization in the regex design doc).
- Both are cheap adornments on top of the parser, so they're scheduled after
  the core is conformant, and are trivially DCE'd when unused.

### Failure is a value, not an exception

A string that does not parse is a normal, recoverable outcome — not an
exceptional one — so `zena:url` never throws. `URL.parse` returns `URL | null`
and there is no public constructor; `UrlRecord` (which the private constructor
takes) is not re-exported from `index.zena`, so `parse` is the only way in.

This is a deliberate divergence from the web API, where `new URL(x)` throws and
`URL.parse` is the newer non-throwing addition. We keep only the latter.

Returning null rather than an error object loses nothing here: the spec's own
failure mode is the bare word "failure", with no code, position, or reason to
report. An earlier draft had a `URLParseError` carrying `input` and a fixed
message — i.e. the argument the caller had just passed, and no information.

The spec's non-fatal *validation errors* (warnings that don't fail parsing) are
ignored in v1; if wanted later they can surface as an optional callback, not as
state on `URL`.

If a future component does need to explain *why* it failed, that is the point
to revisit a shared `Result`-style return — see BUGS.md for the two compiler
issues that currently block a zero-allocation `Result<V, E>`.

## Testing strategy

### Mechanical porting from WPT — yes, and it's the whole point

The WPT URL suite is JSON data, not JS test code, and porting it is standard
practice: Node vendors the files in
[`test/fixtures/wpt/url/resources`](https://github.com/nodejs/node/tree/main/test/fixtures/wpt/url/resources)
and rust-url vendors them with a `wpt.rs` harness plus `expected_failures.txt`.
We follow the same model, and it mirrors the existing precedent in this repo of
porting Go's regexp tests into `packages/stdlib/tests/regex/go_*_test.zena`.

The data files and their schemas:

- **`urltestdata.json`** (~1000 cases): a JSON array mixing bare strings
  (section comments — skip) with test objects
  `{input, base: String | null, ...}` where the rest is either `failure: true`
  (optionally `relativeTo`) or the expected component strings
  (`href`, `protocol`, `username`, `password`, `host`, `hostname`, `port`,
  `pathname`, `search`, `hash`, optional `origin`). Maps to:
  `isTrue(URL.parse(input, base) == null)` or one `equal()` per component.
- **`setters_tests.json`**: keyed by property name; each entry
  `{href, new_value, expected: {href, ...components}}`. Maps to:
  `let u2 = (URL.parse(href) as URL).withProtocol(new_value);
  equal(u2.href, expected.href); ...`.
- **`percent-encoding.json`**: encode-set cases for `encoding.zena`.
- **`toascii.json`**: `{input, output: String | null}` host/IDNA cases — for
  the IDNA phase.
- We skip `urltestdata-javascript-only.json` (lone-surrogate cases specific to
  UTF-16 JS strings; Zena strings are well-formed UTF-8).

### Harness: generate `.zena` tests, don't read JSON at runtime

Two options considered:

1. **Codegen (chosen)**: a Node script
   (`packages/stdlib/scripts/generate-wpt-url-tests.js`) reads the vendored
   JSON and emits `zena:test` suites (e.g. `wpt_urltestdata_test.zena` +
   `__runner__` files) into `packages/stdlib/tests/url/`. Generated files are
   checked in and diffable; tests run identically under the Node and wasmtime
   harnesses with no filesystem preopens; failures point at readable test
   names.
2. Runtime data-driven: parse the JSON in-test with `zena:fs` + `zena:json`.
   Rejected for the conformance suite (couples URL tests to fs/json, needs
   wasmtime preopens, worse failure output) — though it's a nice dogfooding
   exercise we can revisit.

Mechanics:

- Vendor the JSON under `packages/stdlib/tests/url/wpt/` with WPT's BSD
  3-clause license header and the upstream commit hash recorded, so refreshes
  are a re-download + regenerate.
- An **expected-failures list** (a skip-list in the generator's config, à la
  rust-url's `expected_failures.txt`) marks cases we don't pass yet —
  initially all IDNA/non-ASCII-host cases — emitted as `testSkip` so the count
  stays visible in test output rather than silently dropped. Burning this list
  down is the conformance metric for each phase.
- Hand-written suites cover what WPT can't: the Zena-specific API surface
  (`with*` returning new instances, `==`/`hashCode`, `searchParams()` snapshot
  semantics, `URL.parse` null returns, the `url` tag's contextual encoding).

For the later phases, `urlpatterntestdata.json`
(`{pattern, inputs, expected_obj | "error", expected_match, exactly_empty_components}`)
ports the same way, and `URLPatternList` is tested as upstream does: against a
linear first-match-wins scan as the oracle.

## Implementation phases

Each phase lands with its tests green and the expected-failures list updated.

1. **Encoding foundation** (`encoding.zena`) — **DONE**: percent-encode sets
   from the spec (C0/fragment/query/special-query/path/userinfo/component/
   form-urlencoded), percent encode/decode over UTF-8 bytes (natural fit for
   Zena's UTF-8 strings), form-urlencoded parse/serialize.
   *Tests*: hand-written unit tests (`tests/url/encoding_test.zena`). The
   generated `percent-encoding.json` cases are still TODO — note that the
   hand-written set assertions initially missed U+005E (^) in the path set,
   which only the phase-2 WPT suite caught.
2. **Parser core** (`zena:url`) — **DONE** (`url.zena`): the basic URL parser
   state machine (scheme → authority → host → port → path → query → fragment
   states, file-URL states, opaque paths), ASCII domains + IPv4
   (octal/hex/shorthand forms) + IPv6 host parsing, path normalization
   (`.`/`..`), serializer, `URL` constructor/`parse`/`canParse`/component
   fields/`href`/`toString`/`host()`/`origin()` (including `blob:`).
   Adds the `url` manifest entry.
   *Tests*: generated `urltestdata.json` suite — **871/871 passing, 12
   skipped**, every skip an IDNA case listed in
   `tests/url/wpt/expected-failures.txt`; plus hand-written
   `tests/url/url_test.zena` for the Zena-specific API surface.

   Implementation notes worth keeping: components are exposed as getters over
   a retained `UrlRecord` (the "retain it" option below); the parser walks
   BYTES rather than code points, which is safe because every state-machine
   decision is on an ASCII character and UTF-8 continuation bytes are all
   >= 0x80; and a non-ASCII domain is a hard parse failure rather than a
   guess, so phase 6 is a strict improvement rather than a behavior change.
3. **Copy-with setters**: state-override parsing; all `with*` methods.
   *Tests*: generated `setters_tests.json` suite + hand-written immutability
   tests.
4. **`URLSearchParams`**: the class, `searchParams()`, `withSearchParams`.
   *Tests*: hand-written (WPT's URLSearchParams tests are JS files, not JSON,
   so we port the interesting cases manually).
5. **Value-type & builder ergonomics**: `==`/`hashCode`, `UrlString`,
   the `url` template tag with contextual encoding.
6. **IDNA / UTS 46** (`idna.zena`): punycode encode/decode first,
   then the UTS 46 mapping tables (size-conscious; see Open Questions).
   *Tests*: generated `toascii.json` (+ `IdnaTestV2.json` if we go for full
   compliance); burn down the phase-2 skip list.
7. **`URLPattern`** (`pattern.zena`): constructor-string and init-record forms,
   path-to-regexp pattern compilation, `test`/`exec`. Depends on `zena:regex`
   maturity (needs capture groups — present — and named-group bookkeeping we
   can layer on top).
   *Tests*: generated `urlpatterntestdata.json` suite.
8. **`URLPatternList`** (`pattern-list.zena`): port of
   [url-pattern-list](https://github.com/justinfagnani/url-pattern-list)'s
   prefix trie (`addPattern(pattern, value)` / `match(url)`, first-match-wins).
   *Tests*: ported upstream tests + oracle comparison against linear scan.

Phases 1–4 are the meat of "a URL object in `zena:url`"; 5 is cheap polish;
6–8 are each independently schedulable.

## Open questions

- **IDNA vs. DCE**: the parser must call domain-to-ASCII for any special-scheme
  host, so once implemented, the UTS 46 tables are reachable and DCE can't drop
  them. Options: accept the size (Ada does); a compile-time flag/virtual module
  choosing an ASCII-only host parser; or keep v1's behavior (non-ASCII hosts
  fail to parse, which is at least never silently wrong)
  available permanently as the lite variant. Decide when phase 6 starts.
- **Record-based `with()`**: a single `url.with({pathname: '/x', hash: ''})`
  reads better than chained `with*` calls; depends on optional-field record
  ergonomics. Could be added alongside, not instead.
- **Retained URL record vs. re-parse in `with*`**: SETTLED for now — phase 2
  retains the record and derives every component with a getter, so nothing is
  cached and `href` is re-serialized per access. Revisit (cache the serialized
  components) once the benchmark suite covers URLs.
- **`searchParams()` naming**: as a snapshot-returning method it arguably wants
  a more honest name (`parseSearchParams()`?) — or `URLSearchParams` could stay
  couple-free and take `new URLSearchParams(url.search)` as the only path.
- ~~**Origin for blob URLs**~~: RESOLVED in phase 2 — WPT covers it, and it is
  six lines (parse the path as a URL, return its origin when the inner scheme
  is http/https/file), so it landed rather than being punted.
