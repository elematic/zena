# `zena:url`

URL parsing, serialization, building, and matching for Zena.

**Status: 📐 Design phase.** Nothing is implemented yet. See [DESIGN.md](./DESIGN.md)
for the full design and implementation plan.

## Overview

`zena:url` provides a `URL` class that follows the
[WHATWG URL Standard](https://url.spec.whatwg.org/) — the same standard behind
the `URL` class in browsers, Node.js (`node:url`), Deno, Bun, and Cloudflare
Workers. Following the WHATWG standard (rather than RFC 3986) means:

- Zena programs parse URLs the same way browsers and servers do.
- We can mechanically port the [Web Platform Tests](https://github.com/web-platform-tests/wpt/tree/master/url)
  for URL parsing instead of writing thousands of edge-case tests by hand.

Everything is one library — `import {...} from 'zena:url'` — implemented as
multiple files in this directory, with dead-code elimination keeping unused
pieces out of compiled binaries:

| Export                  | Description                             | Status  |
| ----------------------- | --------------------------------------- | ------- |
| `URL`, `URLSearchParams`| WHATWG URL parsing and serialization    | Design  |
| `url` tag, `UrlString`  | Safe URL building, typed URL strings    | Design  |
| `URLPattern`            | Route/pattern matching                  | Planned |
| `URLPatternList`        | Fast multi-pattern matching (prefix trie) | Planned |

## Planned API at a glance

```zena
import {URL, URLSearchParams, url} from 'zena:url';

// Parsing — throws URLParseError on invalid input
let u = new URL('https://example.com:8080/docs/api?q=zena#intro');
u.protocol;  // 'https:'
u.hostname;  // 'example.com'
u.port;      // '8080'
u.pathname;  // '/docs/api'
u.search;    // '?q=zena'
u.hash;      // '#intro'
u.href;      // the canonical serialization

// Non-throwing parse
let maybe = URL.parse('not a url');  // URL | null

// Relative URL resolution against a base
let page = new URL('/guide/intro', 'https://zena.dev/docs/');

// URLs are immutable; derive modified copies with `with*` methods
let secure = u.withProtocol('http:').withPort('');

// Query parameters
let params = u.searchParams();
params.get('q');  // 'zena' (String | null)

// Safe URL building with a template tag: interpolated values are
// percent-encoded for the component they appear in
let team = 'a/b team';
let link = url`https://example.com/teams/${team}/dashboard`;
// → https://example.com/teams/a%2Fb%20team/dashboard
```

Deviations from the web API (and why) are covered in
[DESIGN.md](./DESIGN.md#api-design) — the headline one is that Zena's `URL` is
**immutable** with `with*` methods instead of the web's mutable setters, since
Zena has no getter/setter accessors and favors immutability by default.

## Specs and references

- [WHATWG URL Standard](https://url.spec.whatwg.org/) — the spec we implement.
- [URLPattern Standard](https://urlpattern.spec.whatwg.org/) — for the `URLPattern` phase.
- [WPT `url/` tests](https://github.com/web-platform-tests/wpt/tree/master/url) —
  machine-readable conformance test data we port.
- [Node.js `node:url`](https://nodejs.org/api/url.html) — WHATWG `URL` plus a
  legacy `url.parse()` API that we do **not** replicate.
- [Ada](https://github.com/ada-url/ada) (C++, used by Node) and
  [rust-url](https://github.com/servo/rust-url) (Rust, used by Servo) —
  from-scratch implementations we reference for structure and performance ideas.
- [url-pattern-list](https://github.com/justinfagnani/url-pattern-list) — prefix-trie
  matching over many `URLPattern`s (2–30× faster than a linear scan depending
  on pattern count).

## Testing

Conformance tests are mechanically generated from the WPT JSON test data
(`urltestdata.json`, `setters_tests.json`) into `zena:test` suites — the same
approach as the Go regexp tests ported into `zena:regex`. See
[DESIGN.md](./DESIGN.md#testing-strategy).
