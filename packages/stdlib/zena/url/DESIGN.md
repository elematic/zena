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

| Reference                                                                                              | Use                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WHATWG URL Standard](https://url.spec.whatwg.org/)                                                    | The spec we implement: URL record, basic URL parser state machine, percent-encode sets, host parsing, `application/x-www-form-urlencoded`, API section (getter/setter algorithms).                                                                  |
| [URLPattern Standard](https://urlpattern.spec.whatwg.org/)                                             | WHATWG living standard (graduated from WICG). Shipped in Chrome 95+, Deno, Node 23.8+ (via Ada), Cloudflare Workers, Firefox 142+, Safari 26+.                                                                                                      |
| [WPT url/resources](https://github.com/web-platform-tests/wpt/tree/master/url/resources)               | Machine-readable conformance data: `urltestdata.json`, `setters_tests.json`, `toascii.json`, `percent-encoding.json`, `IdnaTestV2.json`. Format documented in [url/README.md](https://github.com/web-platform-tests/wpt/blob/master/url/README.md). |
| [WPT urlpattern/resources](https://github.com/web-platform-tests/wpt/tree/master/urlpattern/resources) | `urlpatterntestdata.json` for the `URLPattern` phase.                                                                                                                                                                                               |
| [jsdom/whatwg-url](https://github.com/jsdom/whatwg-url)                                                | Reference-quality JS implementation; the cleanest mapping from spec prose to code (`basicURLParse`, state-override parsing for setters).                                                                                                            |
| [Ada](https://github.com/ada-url/ada)                                                                  | C++ parser used by Node. Study for performance: `url_aggregator` stores one normalized buffer + component offsets. Also ships the URLPattern implementation Node uses.                                                                              |
| [servo/rust-url](https://github.com/servo/rust-url)                                                    | Rust implementation. Study for project structure: separate `percent-encoding`, `form_urlencoded`, `idna` layers; vendors WPT JSON and keeps an `expected_failures.txt` while incomplete.                                                            |
| [Node `node:url`](https://nodejs.org/api/url.html)                                                     | WHATWG `URL` + legacy `url.parse()`. We implement only the WHATWG part; the legacy API is a non-goal.                                                                                                                                               |
| [url-pattern-list](https://github.com/justinfagnani/url-pattern-list)                                  | Prefix-trie multi-pattern matcher to port in the final phase.                                                                                                                                                                                       |

## Scope

**v1 (`zena:url`)**: `URL` (parse, serialize, resolve against base, derive
modified copies), `URLSearchParams`, percent-encoding utilities, the `url`
template tag.

**Later phases** (still exported from `zena:url`): IDNA/UTS 46 host
processing, `UrlString` distinct type, `URLPattern`, `URLPatternList`.

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
  UNICODE.md             # how idna-table.zena is generated and what it costs
  index.zena             # public entry for 'zena:url' — re-exports only
  url.zena               # URL
  search-params.zena     # URLSearchParams
  encoding.zena          # percent-encode sets, form-urlencoded codec
  tag.zena               # the url template tag
  punycode.zena          # RFC 3492 codec
  idna.zena              # UTS 46 host processing
  idna-table.zena        # GENERATED mapping table
  pattern-parts.zena     # pattern-string parser, shared by the two below
  pattern.zena           # URLPattern (construction; exec/test later)
  pattern-list.zena      # URLPatternList (later)
```

Implementation files import each other with relative specifiers and are not
reachable via `zena:` specifiers at all — stronger encapsulation than the
manifest's current `internal` list gives.

### A JS-host variant (planned)

On a JS host the platform already has a conformant `URL` and
`URLSearchParams`, and reusing them would drop the parser, the IDNA tables,
and their supporting code from the binary. The manifest's `virtual` mechanism
already swaps a module by target, and the seam fits it without extension:

```jsonc
"url": {"virtual": {"js": "url/index-js.zena", "component": "url/index.zena"}}
```

`index-js.zena` is a second entry point, not a second library. It re-exports
the parts JS has no equivalent for — the punycode codec, the percent-encode
sets, the form-urlencoded codec, the `url` tag — verbatim from the same files,
and replaces only `URL` and `URLSearchParams` with thin Zena shims over the
host objects. Nothing forks: there is one implementation of everything except
the two classes the platform supplies.

The tables come out of the JS build because nothing imports them, not because
the entry point hides them. That relies on DCE being precise about which
module-level values a program actually reaches, which the measurements below
confirm it now is: a program using only the percent-encode helpers carries
neither the table nor the parser.

Three things have to be true before this is worth building:

1. **String interop.** There is none today — no `js-string` builtins, no
   stringref. Every component read crosses a UTF-16/UTF-8 boundary. The glue
   is small, but it is a compiler feature with a much wider blast radius than
   this library, and should be justified on its own terms.
2. **The two behavioural divergences have to go.** `URLSearchParams` iteration
   is fail-fast here and silently lossy in JS, and `sort()` orders by code
   point where JS orders by UTF-16 code unit. `console`'s two implementations
   differ only in where output goes, which no program can observe; these would
   make the same program behave differently per target, which is a materially
   higher bar. Reconcile them — most likely by conforming to JS — before
   splitting.
3. **A size win worth the coupling.** The measurements below now say what the
   split would save: about 82.6 KB for a program that parses URLs, over half
   of it the IDNA table. That is a real number rather than the upper bound of
   unknown tightness it used to be, so this precondition is met — what remains
   is whether 82.6 KB is worth a per-target behavioural seam.

Note also that WPT stops being a signal for the JS build, since it would be
testing the host's own URL. The Zena implementation stays the conformance
target regardless, so this saves binary size, not maintenance.

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
   "console": {"virtual": {"js": "console/host.zena", "component": "console/component.zena"}}
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
algorithm (the basic URL parser with a _state override_), so behavior — and the
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

- **Internals**: parsing produces the spec's _URL record_ (scheme, host as a
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
  is a _live_ object bound to the URL; since our `URL` is immutable,
  `searchParams()` returns a snapshot and `withSearchParams`/`withSearch`
  write changes back. This is the one deliberate behavioral divergence from
  the web API.

### `URLSearchParams`

An ordered, mutable multimap of `(name, value)` pairs — mutable is fine here;
it is a collection/builder, like `Array` or `StringBuilder`. Backed by a
growable array of pairs (order-preserving, duplicate keys allowed), following
the spec's `application/x-www-form-urlencoded` parser/serializer.

As implemented, the two constructors are one with a default (`new(init:
String = '')`), and `size` is a property getter rather than the `size()`
method sketched below — `Array.length` and `HashMap.size` are getters, and
matching the surrounding stdlib matters more than matching this sketch.

```zena
export final class URLSearchParams {
  new(init: String = '');                 // parses 'a=1&b=2' (leading '?' ok)

  size: i32;                              // getter
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

1. **Security sink typing** (branded _values_ minted by tags):
   [Google safevalues](https://github.com/google/safevalues) has a
   ``trustedResourceUrl`...` `` tag returning a branded `TrustedResourceUrl`;
   the tag trusts the literal parts (developer-authored) and restricts/encodes
   interpolations. The [Trusted Types spec](https://w3c.github.io/trusted-types/dist/spec/)
   defines the runtime-enforced `TrustedScriptURL` for script-src sinks. TC39's
   [`Reflect.isTemplateObject`](https://github.com/tc39/proposal-array-is-template-object)
   exists specifically to let such tags verify literal provenance, and the
   [`String.cooked`](https://github.com/tc39/proposal-string-cooked) proposal
   uses a percent-encoding URL tag as its motivating example.
2. **Route/DX typing** (branded string _types_): Next.js typed routes'
   `Route<T>` brand validates literal `href`s against the route table; Hono and
   tRPC parse path params out of route strings with template literal types.

   (Encode-safe URL _builders_ without branding also exist: `urlcat`, RFC 6570
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
  future sink API (`fetch(input: UrlString | URL)`) can require _parsed or
  provably-well-formed_ input while accepting plain field access. Casting
  `as UrlString` remains the explicit escape hatch, exactly like `as Route` in
  Next.js.
- The tag gives safe _construction_ (the `String.cooked` example done
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

The spec's non-fatal _validation errors_ (warnings that don't fail parsing) are
ignored in v1; if wanted later they can surface as an optional callback, not as
state on `URL`.

If a future component does need to explain _why_ it failed, that is the point
to revisit a shared `Result`-style return. Two compiler issues currently block
a zero-allocation `Result<V, E>`: an inline-tuple union with mismatched slot
representations is accepted and then bails
([#114](https://github.com/elematic/zena/issues/114)), and match arms over an
inline-tuple union do not narrow
([#115](https://github.com/elematic/zena/issues/115)).

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
   _Tests_: hand-written unit tests (`tests/url/encoding_test.zena`) plus the
   generated `percent-encoding.json` suite (`tests/url/
wpt_percent_encoding_test.zena`, 7 cases). Only each fixture's `utf-8`
   output is asserted — encoding override is a non-goal (see Scope), and the
   generator reports how many legacy-encoding outputs it ignored rather than
   dropping them silently. The fixture drives its inputs through the query of
   an `https` URL, so the assertions use the special-query set. Note the
   hand-written set assertions initially missed U+005E (^) in the path set,
   which only the phase-2 WPT suite caught.
2. **Parser core** (`zena:url`) — **DONE** (`url.zena`): the basic URL parser
   state machine (scheme → authority → host → port → path → query → fragment
   states, file-URL states, opaque paths), ASCII domains + IPv4
   (octal/hex/shorthand forms) + IPv6 host parsing, path normalization
   (`.`/`..`), serializer, `URL` constructor/`parse`/`canParse`/component
   fields/`href`/`toString`/`host()`/`origin()` (including `blob:`).
   Adds the `url` manifest entry.
   _Tests_: generated `urltestdata.json` suite — **871/871 passing, 12
   skipped**, every skip an IDNA case listed in
   `tests/url/wpt/expected-failures.txt`; plus hand-written
   `tests/url/url_test.zena` for the Zena-specific API surface.

   Implementation notes worth keeping: components are exposed as getters over
   a retained `UrlRecord` (the "retain it" option below); the parser walks
   BYTES rather than code points, which is safe because every state-machine
   decision is on an ASCII character and UTF-8 continuation bytes are all

   > = 0x80; and a non-ASCII domain is a hard parse failure rather than a
   > guess, so phase 6 is a strict improvement rather than a behavior change.

3. **Copy-with setters** — **DONE**: the parser takes an optional state
   override, entering mid-machine to parse a single component, plus the
   override-only "hostname" state and the override-only early exits the spec
   calls for. On top of that: `withProtocol`, `withUsername`, `withPassword`,
   `withHost`, `withHostname`, `withPort`, `withPathname`, `withSearch`,
   `withSearchParams`, `withHash`, and `withHref`.
   _Tests_: generated `setters_tests.json` suite — **274/274 passing, 3
   skipped**, all three IDNA cases in `tests/url/wpt/expected-failures.txt`;
   plus hand-written `with*` tests in `tests/url/url_test.zena`.

   Two things the WPT data forced, both worth remembering:
   - Under a state override the port parser treats ANY non-digit as the end of
     the port rather than a syntax error, so `withPort('4wpt')` yields 4 and
     `withHost('example.com:invalid')` leaves the port alone.
   - A failed setter is not a rollback. The spec parses into the URL in place
     and keeps whatever it applied before failing, so
     `withHost('example.com:65536')` changes the host and then rejects the
     port. `#withParsed` therefore returns its working copy unconditionally —
     a parse that fails before touching anything leaves that copy identical to
     the original anyway.

   `withHref` is the one exception to the "failure returns an unchanged URL"
   rule: it replaces every component, so there is nothing to fall back to and
   it returns `URL | null`, matching `URL.parse`.

4. **`URLSearchParams`** ✅ **done**: the class and `URL.searchParams()`.
   _Tests_: hand-written in `tests/url/search-params_test.zena` (WPT's
   URLSearchParams tests are JS files, not JSON, so the interesting cases are
   ported by hand).
   Three deviations worth knowing:
   - `sort()` orders by UTF-8 bytes, which is code POINT order, where the
     spec sorts by UTF-16 code unit — they differ only for a
     supplementary-plane name compared against U+E000..U+FFFF.
   - Names and values are stored DECODED, so a value containing `&` or `=`
     round-trips through `toString()`.
   - **Mutating during iteration throws `ConcurrentModificationError`**
     rather than iterating live. The web API's iterator indexes into the
     current list and re-reads it every step (WebIDL's default pair
     iterator), so in JS `delete`-ing a pair mid-loop silently SKIPS the
     next one and `append`-ing never terminates — verified against Node:
     iterating `a=1&b=2&c=3` and deleting `b` on the first step yields
     `a, c`. Both are wrong answers with no signal, so this follows Java's
     fail-fast collections instead. The check is best-effort, as Java's is:
     it catches mistakes, it does not make concurrent mutation safe.
5. **Value-type & builder ergonomics** — `==`/`hashCode` and the `url`
   template tag **done**; `UrlString` still open (see Open Questions).
   `URL` implements `Hashable`, so it can be a `HashMap`/`HashSet` key.
   Equality compares `href`, which is not a shortcut: the parser
   canonicalizes as it goes, so `https://EXAMPLE.com:443/a/../b` and
   `https://example.com/b` already share a serialization and compare equal.
   This is the spec's URL equality
   (https://url.spec.whatwg.org/#concept-url-equals) minus its optional
   "exclude fragments" flag; a caller wanting that can compare
   `withHash('')` copies.
   `href` is now serialized once and cached — it is read on every hash probe
   and every comparison, and a `URL` never mutates (`with*` returns new
   instances), so recomputing it each time was pure waste.

   The `url` tag (`tag.zena`) landed as designed, with one rule the sketch
   above did not anticipate: **interpolation is confined to the path, query,
   and fragment.** A hole in the scheme, credentials, host, or port returns
   null. Those parts are not percent-decoded when parsed — a host goes through
   IDNA and IP parsing on its raw text — so no encoding makes an untrusted
   value safe there, and encoding it anyway would produce something that looks
   sanitized but is not. This is the same line safevalues draws when it
   requires the origin of a `TrustedResourceUrl` to be developer-authored.

   Deciding which component a hole lands in needs only a crude scanner over
   the literal parts (scheme → `//` → authority → path → query → fragment),
   not the real parser, because an interpolated value can never move a
   component boundary: the component encode set covers every delimiter that
   could. Two boundary cases fall out of that same fact and are pinned by
   tests:
   - ``url`mailto:${who}` `` is allowed. The scanner is sitting on the `:`
     with no idea whether `//` follows, but since the hole cannot supply a
     slash, no authority can open — it is an opaque path.
   - ``url`https:/${host}/a` `` is refused. A special scheme reaches its host
     through a single slash too, so that hole would be the host despite
     looking like a path.

   The tag returns `URL | null` rather than the `TemplateTag<URL>` sketched
   above, for the same reason `URL.parse` does: this library does not throw.

6. **IDNA / UTS 46** — **DONE**: the punycode codec (`punycode.zena`) and the
   UTS 46 mapping tables (`idna.zena`, plus the generated `idna-table.zena`).

   `punycodeEncode`/`punycodeDecode` are the RFC 3492 Bootstring codec for a
   single label, with no `xn--` prefix handling and none of the UTS 46
   mapping that surrounds them in a real domain-to-ASCII conversion — that
   split keeps the part with published test vectors separately verifiable
   from the part that needs tables.
   _Tests_: `tests/url/punycode_test.zena`, whose expectations are RFC 3492's
   own section 7.1 sample strings — all nine round-trip — plus the overflow
   and invalid-digit rejections.

   Two things shaped the implementation:
   - Zena's `/` always yields a float, so the arithmetic goes through a
     truncating `divide()` that widens to f64 first. f32 cannot represent
     every i32, and the RFC's overflow guards compare against values near
     `MAX_I32`, where an f32 quotient would be wrong.
   - The spec's rule that the delimiter is consumed only if something
     preceded it is load-bearing: a leading `-` is a digit, not a separator,
     so `"-"` alone must be rejected rather than decoding to the empty
     string. This is pinned by a test.

   How the table is generated, and what it costs, is in UNICODE.md.
   **The urltestdata skip list is now empty**: all 871
   parser cases, 277 setter cases, and 7 percent-encoding cases pass with
   nothing skipped, where 15 entries were skipped before.

   The size question the Open Questions raised is answered: **42.5 KB**, from
   787 KB of source, and the arithmetic is in UNICODE.md. That was cheap
   enough to just carry, so the compile-time flag and the permanent
   ASCII-only variant are both off the table.

   _Tests_: generated `toascii.json` suite — **72/87 passing, 15 skipped**.
   Those 15 are the rules still missing, and they are a fair statement of
   where this stops:
   - **NFC normalization** (UTS 46 step 2) — 9 cases. Its own Unicode tables
     plus canonical ordering, so it is the large remaining piece.
   - **CheckBidi** — 2 cases. **CheckJoiners** — 1 case.
   - **The validity criteria applied to a decoded ACE label** — 3 cases.
     This one is a deliberate choice, not an omission: applying them costs 7
     urltestdata cases, because `http://a.b.c.xn--pokxncvks` decodes to
     circled digits the table would map, and the pinned WPT parser data wants
     that host kept. The two fixtures disagree, and the 871-case one wins.

   Every gap is in the same direction — a host we accept that a fully
   conformant implementation would reject — so nothing here is silently
   wrong in the way a wrong host would be.

7. **`URLPattern`** — **construction DONE** (`pattern-parts.zena` for the
   pattern parser, `pattern.zena` for the rest); `test`/`exec` and the
   constructor-STRING form still open.

   What landed: init-object construction, the component defaulting and
   base-URL inheritance the spec calls `applyInit`, per-component
   canonicalization, and the eight component pattern strings.
   _Tests_: generated `urlpatterntestdata.json` suite — **160/160 emitted
   cases passing, 22 skipped**. A further 71 cases give the pattern as a
   string and 6 cannot be spelled in Zena at all (lone surrogates; an init
   object passed alongside a base URL, which is a JavaScript overload). Those
   are never emitted and are reported as counts with reasons at the end of a
   generation run — they are not expected failures, because there is no test
   for an entry to silence. The 22 skips are 21 non-ASCII group names and one
   regex-validity case, both described in `expected-failures.txt`.

   The shape worth remembering: **a component pattern is canonicalized by
   round-tripping it.** Parse to `Part`s, percent-encode the literal text,
   serialize back. That is why the constructor reports `/foo/*` for
   `/foo/(.*)` and `/caf%C3%A9` for `/café`. Two rules make it work:
   - Encoding applies to literal text ONLY — fixed values, prefixes, suffixes
     — never to a regex source or a group name. Running an encoder over the
     whole pattern string would encode the syntax that makes it a pattern.
   - The pending run is encoded BEFORE it is split into per-segment parts. A
     path encoder resolves `.` and `..` against the rest of the path, so
     `/foo/../bar` collapses to `/bar` only while it is still one string.
     Encoding segment by segment leaves all three, which is exactly what the
     conformance data caught.

   Three places where the reference polyfill is simply wrong, and WPT says so:
   - Its hostname check rejects `#`, `/`, `\` and tab/LF/CR. Those are not
     invalid, they are terminators — the host parser stops at the first three
     and strips the last three, so `bad#hostname` is the host `bad` and
     `bad\nhostname` is `badhostname`. Nine cases.
   - Its port check rejects `"80 "`, where a URL strips surrounding C0
     controls and spaces and reads the port 80.
   - `bad?hostname` must still fail, but for a syntax reason rather than an
     encoding one: an unescaped `?` is a modifier with nothing to modify.
     Rejecting that in the parser is what lets `\?` through as the literal
     the host parser truncates at.

   zena:regex shaped two details: it reads `[^]` as an unterminated character
   class, so the segment wildcard is emitted as `[\s\S]` (same set, portable);
   and URLPattern always compiles in strict mode with no `endsWith`
   characters, which is what keeps the emitted regex free of the lookahead
   zena:regex does not have.

   Only the PROTOCOL pattern is compiled to a regex so far, because choosing a
   pathname canonicalization means asking whether the protocol pattern admits
   a special scheme — a question only a matcher can answer, since a protocol
   alternation is special whenever any one of its alternatives is.
   `partsToRegexp` is written in full so that `exec` is a use of it rather
   than a rewrite. There is deliberately no `ignoreCase` option yet: it would
   only flag matchers that do not exist, and an option accepted but ignored
   is worse than one not offered.

8. **`URLPatternList`** (`pattern-list.zena`): port of
   [url-pattern-list](https://github.com/justinfagnani/url-pattern-list)'s
   prefix trie (`addPattern(pattern, value)` / `match(url)`, first-match-wins).
   _Tests_: ported upstream tests + oracle comparison against linear scan.

Phases 1–4 are the meat of "a URL object in `zena:url`"; 5 is cheap polish;
6–8 are each independently schedulable.

## Binary size

Measured with the self-hosted compiler, Unicode 17.0, against a baseline that
prints one line and reaches nothing else:

| program                     | total   | data    | code    | funcs |
| --------------------------- | ------- | ------- | ------- | ----- |
| baseline (`console` only)   | 633 B   | 6 B     | 358 B   | 7     |
| `percentEncode` only        | 5.4 KB  | 26 B    | 4.1 KB  | 74    |
| `punycodeEncode` only       | 11.2 KB | 30 B    | 8.5 KB  | 166   |
| `URL.parse`, ASCII host     | 83.2 KB | 42.6 KB | 34.2 KB | 397   |
| `URL.parse`, non-ASCII host | 83.2 KB | 42.6 KB | 34.2 KB | 397   |

**DCE cuts at the right granularity.** A program that uses only
`percentEncode`, or only `punycodeEncode`, carries neither the parser nor the
IDNA table: 74 and 166 functions against 397, and no table bytes in the data
segment at all. An earlier revision of this section recorded the opposite —
both narrow programs dragged in the whole library and came out _larger_ than
the one that actually parses a URL. The DCE work on main closed that, so the
JS-host variant above can no longer claim it as part of its case.

For a program that does parse URLs, `zena:url` costs about 82.6 KB over the
baseline, and rather more than half of that is the table: 42.6 KB of data
against 34.2 KB of code. The table still lands about 1:1 — 43,484 bytes of
payload inside a 43,607-byte data segment, the remainder being that program's
own string literals — which is what the printable-ASCII, no-decode-pass
encoding bought.

Reaching a non-ASCII host costs nothing extra. The two `URL.parse` rows differ
by a single byte, and that byte is the length of the literal in the test
program rather than anything the library adds: the table is reachable from any
special-scheme host, ASCII or not.

The baseline is deliberately bare, but that no longer makes the deltas an
overstatement the way it did when DCE was retaining unreachable code. What a
program pays for `zena:url` here is `zena:url`.

## Open questions

- ~~**IDNA vs. DCE**~~: RESOLVED — accept the size. The table is 42.5 KB
  (see UNICODE.md for how that falls out of 787 KB), which did not justify a
  compile-time flag or a permanent ASCII-only variant. It is still true that
  the parser calls domain-to-ASCII for every special-scheme host, so the table
  is always reachable and DCE cannot drop it; revisit only if someone has a
  binary-size budget that 42.5 KB breaks.
- **`UrlString`**: OPEN, and deliberately not landed with the `url` tag. The
  brand is only worth anything once something _demands_ it — a sink like
  `fetch(input: UrlString | URL)` — and there is no such sink yet. Typing
  `href` as `UrlString` today would buy nothing and cost an `as String` at
  every site that compares or concatenates an `href`, since Zena requires an
  explicit cast in both directions (`let m: Meters = 10 as Meters`). Revisit
  when the first sink API arrives; the brand can be added then without
  changing any behavior.
- **Record-based `with()`**: a single `url.with({pathname: '/x', hash: ''})`
  reads better than chained `with*` calls; depends on optional-field record
  ergonomics. Could be added alongside, not instead.
- **Retained URL record vs. re-parse in `with*`**: SETTLED — the record is
  retained and every component is derived with a getter, and `with*` clones
  the record and re-enters the parser mid-machine rather than re-parsing an
  `href`. Only `href` itself is cached. Revisit (cache the serialized
  components) once the benchmark suite covers URLs.
- **`searchParams()` naming**: as a snapshot-returning method it arguably wants
  a more honest name (`parseSearchParams()`?) — or `URLSearchParams` could stay
  couple-free and take `new URLSearchParams(url.search)` as the only path.
- ~~**Origin for blob URLs**~~: RESOLVED in phase 2 — WPT covers it, and it is
  six lines (parse the path as a URL, return its origin when the inner scheme
  is http/https/file), so it landed rather than being punted.
